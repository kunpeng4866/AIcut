# -*- coding: utf-8 -*-
"""美颜·皮肤管理核心：自研皮肤区域检测 + 矩心椭圆拟合 + 灰度 mask mp4 写出。

数据流：
    ffmpeg 解码输入视频 → rawvideo(rgb24) 管道 → 逐帧自研皮肤检测
    → 矩心椭圆拟合（纯 numpy 二阶矩）→ 形态学平滑/羽化 → 灰度(rawvideo gray) 管道
    → ffmpeg 编码为灰度 mp4（与输入同尺寸/帧率/时长）。

合规硬约束（本项目既定、不可违反）：
    - 禁止任何第三方人脸检测 / 人脸关键点模型或 SDK（MediaPipe Face Mesh、dlib、
      OpenCV 人脸模块、任何预训练 face model 等）；
    - 皮肤定位完全自研：公开肤色统计阈值（YCbCr / HSV 色度范围，纯数学统计，非训练模型）
      + 矩心椭圆拟合（numpy 二阶矩，非模型）。

mask 灰度约定：luma = mask * 255，0=不作用（非皮肤），255=全作用（皮肤）。前端/导出
契约与此统一对齐。

M1 范围：单椭圆（覆盖主脸/主要皮肤区），多人脸延后。
"""
import os
import sys
import json
import math
import time
import subprocess

import numpy as np
from PIL import Image, ImageFilter


# ───────────────────────── 媒体工具 ─────────────────────────

def _ffmpeg_exe() -> str:
    """ffmpeg 路径：环境变量 AICUT_FFMPEG 优先，否则用 codex-tools 内置二进制。"""
    return os.environ.get("AICUT_FFMPEG") or "E:/codex/codex-tools/bin/ffmpeg.exe"


def _ffprobe_exe() -> str:
    return os.environ.get("AICUT_FFPROBE") or "E:/codex/codex-tools/bin/ffprobe.exe"


def _ffprobe(input_path: str) -> dict:
    """返回 {width,height,fps,duration}；失败时抛异常。"""
    cmd = [
        _ffprobe_exe(), "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width:stream=height:stream=r_frame_rate:stream=duration",
        "-of", "json", input_path,
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("ffprobe 失败: " + p.stderr.decode("utf-8", "ignore")[:400])
    info = json.loads(p.stdout.decode("utf-8", "ignore"))
    streams = info.get("streams") or []
    if not streams:
        raise RuntimeError("ffprobe 未找到视频流")
    s = streams[0]
    w = int(s.get("width", 0))
    h = int(s.get("height", 0))
    fps = 0.0
    rfr = s.get("r_frame_rate", "0/0")
    if "/" in rfr:
        try:
            a, b = rfr.split("/")
            if float(b) > 0:
                fps = float(a) / float(b)
        except ValueError:
            fps = 0.0
    dur = float(s.get("duration") or 0.0)
    return {"width": w, "height": h, "fps": fps, "duration": dur}


# ───────────────────────── 颜色空间工具（自研，纯 numpy）─────────────────────────

def rgb_to_ycbcr(rgb: np.ndarray) -> tuple:
    """rgb: HxWx3 uint8 → (Y, Cb, Cr) 各为 HxW float，公式见文件头（公开标准定义）。"""
    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = -0.169 * r - 0.331 * g + 0.5 * b + 128.0
    cr = 0.5 * r - 0.419 * g - 0.081 * b + 128.0
    return y, cb, cr


def rgb_to_hsv(rgb: np.ndarray) -> tuple:
    """rgb: HxWx3 uint8 → (H[0,360], S[0,1], V[0,1]) 各为 HxW float。"""
    r = rgb[:, :, 0].astype(np.float32) / 255.0
    g = rgb[:, :, 1].astype(np.float32) / 255.0
    b = rgb[:, :, 2].astype(np.float32) / 255.0
    cmax = np.maximum(np.maximum(r, g), b)
    cmin = np.minimum(np.minimum(r, g), b)
    delta = cmax - cmin
    h = np.zeros_like(cmax, dtype=np.float32)
    # R 最大
    mask = (cmax == r) & (delta > 0)
    h[mask] = 60.0 * (((g[mask] - b[mask]) / delta[mask]) % 6.0)
    # G 最大
    mask = (cmax == g) & (delta > 0)
    h[mask] = 60.0 * ((b[mask] - r[mask]) / delta[mask] + 2.0)
    # B 最大
    mask = (cmax == b) & (delta > 0)
    h[mask] = 60.0 * ((r[mask] - g[mask]) / delta[mask] + 4.0)
    s = np.zeros_like(cmax, dtype=np.float32)
    nz = cmax > 0
    s[nz] = delta[nz] / cmax[nz]
    v = cmax
    return h, s, v


# ───────────────────────── 自研皮肤检测 ─────────────────────────

def _skin_candidate(y: np.ndarray, cb: np.ndarray, cr: np.ndarray,
                     h: np.ndarray, s: np.ndarray, tol: float) -> np.ndarray:
    """返回候选皮肤二值图（bool）。

    主判据：YCbCr 肤色统计阈值（公开范围，非模型），随 tol 内外扩；
    二次保险：HSV（肤色偏红 H∈[0,50]∪[340,360] 或 中饱和 S∈[0.15,0.9]）；
    两者 AND 得候选皮肤区。
    """
    # YCbCr 范围随 tolerance 线性外扩：lo -= tol*width，hi += tol*width
    cb_lo = 77.0 - tol * (127.0 - 77.0)
    cb_hi = 127.0 + tol * (127.0 - 77.0)
    cr_lo = 133.0 - tol * (173.0 - 133.0)
    cr_hi = 173.0 + tol * (173.0 - 133.0)
    y_lo = max(0.0, 40.0 - tol * 40.0)

    ycbcr_ok = (
        (y > y_lo) &
        (cb >= cb_lo) & (cb <= cb_hi) &
        (cr >= cr_lo) & (cr <= cr_hi)
    )

    # HSV 二次保险：肤色偏红（H 近 0/360）或中低饱和
    hsv_ok = (
        ((h >= 0.0) & (h <= 50.0)) |
        ((h >= 340.0) & (h <= 360.0)) |
        ((s >= 0.15) & (s <= 0.9))
    )

    return ycbcr_ok & hsv_ok


def _fit_centroid_ellipse(mask: np.ndarray, scale: float) -> np.ndarray:
    """对候选皮肤二值图做矩心椭圆拟合（纯 numpy 二阶矩），输出椭圆 mask（uint8, 内部 255）。

    步骤：取候选正像素坐标 → 均值(centroid) 与 2x2 协方差矩阵 → eigh 得特征值/特征向量
    → 构造参数椭圆 (p-c)^T Σ^{-1} (p-c) ≤ scale² → meshgrid 栅格化。
    候选像素过少或协方差退化时返回全 0。
    """
    h, w = mask.shape
    coords = np.argwhere(mask)  # (N,2) 行= y, 列= x
    if coords.shape[0] < 10:
        return np.zeros((h, w), dtype=np.uint8)

    cy, cx = coords.mean(axis=0)  # 注意顺序：(y, x)
    # 2x2 协方差（含正则化防止退化/奇异）
    cov = np.cov(coords, rowvar=False)
    cov = cov + np.eye(2) * 1e-3
    inv_cov = np.linalg.inv(cov)

    # 特征分解：半轴长 a/b = 特征值平方根 × 2（≈ ±2σ 覆盖主皮肤区）
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = eigvals.argsort()[::-1]
    eigvals = eigvals[order]
    eigvecs = eigvecs[:, order]
    a = 2.0 * math.sqrt(float(eigvals[0]))
    b = 2.0 * math.sqrt(float(eigvals[1]))
    # 主轴方向（仅用于可解释/调试，栅格化直接用 inv_cov）
    major = eigvecs[:, 0]
    angle = math.degrees(math.atan2(major[0], major[1]))  # (Δy, Δx)

    # 全帧栅格化：mahal = (p-c)^T inv_cov (p-c)，内部 ≤ scale²
    yy, xx = np.mgrid[0:h, 0:w]
    diff = np.stack([yy - cy, xx - cx], axis=0)  # (2, h, w)
    mahal = np.einsum("ihw,jhw,ij->hw", diff, diff, inv_cov)
    inside = mahal <= (scale * scale)

    if False:  # 调试钩子（默认关闭）
        sys.stderr.write(
            "[ellipse] cx={:.1f} cy={:.1f} a={:.1f} b={:.1f} angle={:.1f} pixels={}\n".format(
                cx, cy, a, b, angle, int(inside.sum())))

    return (inside * 255).astype(np.uint8)


def _smooth_mask(gray: np.ndarray) -> np.ndarray:
    """形态学平滑 + 高斯羽化：dilate(MaxFilter5) → erode(MinFilter3) → GaussianBlur(radius=10)。"""
    img = Image.fromarray(gray)
    img = img.filter(ImageFilter.MaxFilter(5))   # 膨胀，弥合候选空洞
    img = img.filter(ImageFilter.MinFilter(3))   # 腐蚀，回收溢出边界
    img = img.filter(ImageFilter.GaussianBlur(radius=10))  # 8~15px 羽化
    return np.asarray(img, dtype=np.uint8)


# ───────────────────────── 主入口 ─────────────────────────

def generate_skin_mask(input_path: str, opts: dict) -> dict:
    t0 = time.time()

    def log(msg: str):
        sys.stderr.write("[beauty] " + msg + "\n")
        sys.stderr.flush()

    if not os.path.isfile(input_path):
        raise FileNotFoundError("输入视频不存在: " + input_path)

    probe = _ffprobe(input_path)
    w = int(opts.get("width") or probe["width"])
    h = int(opts.get("height") or probe["height"])
    fps = float(opts.get("fps") or probe["fps"])
    if fps <= 0 or not math.isfinite(fps):
        fps = 30.0
    if w <= 0 or h <= 0:
        raise RuntimeError("无效视频尺寸 {}x{}".format(w, h))

    # duration：opts 优先，否则用 probe
    duration = float(opts.get("duration") or probe["duration"])
    if duration <= 0 or not math.isfinite(duration):
        raise RuntimeError("无法确定视频时长（请通过 opts.duration 提供）")
    N = max(1, int(round(duration * fps)))

    skin_tolerance = float(opts.get("skin_tolerance", 0.25))
    skin_tolerance = min(1.0, max(0.0, skin_tolerance))
    ellipse_scale = float(opts.get("ellipse_scale", 1.15))
    ellipse_scale = max(0.5, ellipse_scale)

    output_path = opts.get("output") or ""
    if not output_path:
        stem, ext = os.path.splitext(input_path)
        output_path = stem + "_skin_mask.mp4"
    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)

    ff = _ffmpeg_exe()
    reader = subprocess.Popen(
        [ff, "-v", "error", "-i", input_path,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    writer = subprocess.Popen(
        [ff, "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", "{}x{}".format(w, h), "-r", "{:.4f}".format(fps), "-i", "pipe:0",
         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", output_path],
        stdin=subprocess.PIPE,
    )

    frame_bytes = w * h * 3
    written = 0
    total_skin = 0
    try:
        while written < N:
            raw = reader.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            y, cb, cr = rgb_to_ycbcr(rgb)
            hh, ss, vv = rgb_to_hsv(rgb)
            cand = _skin_candidate(y, cb, cr, hh, ss, skin_tolerance)
            ellipse = _fit_centroid_ellipse(cand, ellipse_scale)
            gray = _smooth_mask(ellipse)
            total_skin += int((gray > 10).sum())
            writer.stdin.write(gray.tobytes())
            written += 1
    finally:
        reader.stdout.close()
        reader.wait()
        if writer.stdin:
            writer.stdin.close()
        writer.wait()

    if writer.returncode != 0:
        raise RuntimeError("ffmpeg 编码 skin mask 失败（退出码 {}）".format(writer.returncode))

    elapsed = time.time() - t0
    log("完成皮肤 mask：{}x{} {} 帧，用时 {:.2f}s（tol={:.2f}, scale={:.2f}）".format(
        w, h, written, elapsed, skin_tolerance, ellipse_scale))

    skin_coverage = (total_skin / (w * h * max(1, written))) if written > 0 else 0.0

    return {
        "maskPath": os.path.abspath(output_path),
        "width": w,
        "height": h,
        "fps": fps,
        "frames": written,
        "skinCoverage": skin_coverage,
        "model": "beauty_mask",
        "mode": "mask",
    }
