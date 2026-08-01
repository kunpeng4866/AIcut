# -*- coding: utf-8 -*-
"""美颜·皮肤管理核心：自研皮肤区域检测 + 连通域选取 + 时序平滑 → 灰度 mask mp4 写出。

数据流：
    ffmpeg 解码输入视频 → rawvideo(rgb24) 管道 → 逐帧自研皮肤检测
    → 形态学开闭清理 → 连通域选取（最大皮肤区 + 邻近次区，贴合真实脸/脖子/耳朵）
    → 边缘羽化 → 帧间滑动窗口中值滤波时序平滑（抑制抖动）→ 灰度(rawvideo gray) 管道
    → ffmpeg 编码为灰度 mp4（与输入同尺寸/帧率/时长）。

合规硬约束（本项目既定、不可违反）：
    - 禁止任何第三方人脸检测 / 人脸关键点模型或 SDK（MediaPipe Face Mesh、dlib、
      OpenCV 人脸模块、任何预训练 face model 等）；
    - 皮肤定位完全自研：公开肤色统计阈值（YCbCr / HSV 色度范围，纯数学统计，非训练模型）
      + 连通域形态学（numpy / scipy.ndimage，非模型）+ 帧间 EMA 时序平滑（纯数值）。

mask 灰度约定：luma = mask * 255，0=不作用（非皮肤），255=全作用（皮肤）。前端/导出
契约与此统一对齐。

M1 范围：单人主脸皮肤区（连通域取最大块 + 邻近大块以覆盖脸+脖子+耳朵），多人脸延后。
"""
import os
import sys
import json
import math
import time
import subprocess
from collections import deque

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage


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
    mask = (cmax == r) & (delta > 0)
    h[mask] = 60.0 * (((g[mask] - b[mask]) / delta[mask]) % 6.0)
    mask = (cmax == g) & (delta > 0)
    h[mask] = 60.0 * ((b[mask] - r[mask]) / delta[mask] + 2.0)
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

    hsv_ok = (
        ((h >= 0.0) & (h <= 50.0)) |
        ((h >= 340.0) & (h <= 360.0)) |
        ((s >= 0.15) & (s <= 0.9))
    )

    return ycbcr_ok & hsv_ok


def _morph_close(region: np.ndarray) -> np.ndarray:
    """形态学闭运算：膨胀→腐蚀，弥合脸、耳朵、脖子之间的细小间隙并填补皮肤块内小孔。

    半径 3，纯 PIL 形态学滤镜（非模型）。返回 bool 图。
    """
    img = Image.fromarray((region * 255).astype(np.uint8))
    img = img.filter(ImageFilter.MaxFilter(3))   # 膨胀（闭·1）
    img = img.filter(ImageFilter.MinFilter(3))   # 腐蚀（闭·2）
    return np.asarray(img, dtype=np.uint8) > 127


def _keep_largest(mask: np.ndarray) -> np.ndarray:
    """保留二值图中最大连通块，丢弃小碎片。"""
    if not mask.any():
        return mask
    labels, n = ndimage.label(mask)
    if n <= 1:
        return mask
    sizes = np.bincount(labels.ravel())[1:]
    main = int(sizes.argmax()) + 1
    return labels == main


def _select_skin_region(cand: np.ndarray, w: int, h: int, min_frac: float) -> np.ndarray:
    """连通域选取：保留与画面中央 ROI 重叠最大的皮肤连通块（人脸主体）。

    talking-head 视频里，人脸通常位于画面上半部中央；右侧/左侧/上侧的墙面等同色背景
    虽然面积可能很大，但不会与中央 ROI 重叠，因此能被直接排除。
    若中央 ROI 未命中任何块（如人脸严重偏离中心），则回退到面积最大块。

    返回 bool 图；纯 scipy.ndimage 连通域分析，无模型。
    """
    if not cand.any():
        return np.zeros((h, w), dtype=bool)
    labels, n = ndimage.label(cand)
    if n == 0:
        return np.zeros((h, w), dtype=bool)

    # 中央 ROI：水平 35%~65%，垂直 15%~55%。覆盖典型人脸/额头/鼻子/脸颊。
    x0, x1 = int(w * 0.35), int(w * 0.65)
    y0, y1 = int(h * 0.15), int(h * 0.55)
    roi = np.zeros((h, w), dtype=bool)
    roi[y0:y1, x0:x1] = True

    overlap = np.bincount(labels.ravel(), weights=roi.ravel(), minlength=n + 1)
    best_label = int(np.argmax(overlap[1:])) + 1
    best_overlap = int(overlap[best_label])

    if best_overlap < 100:
        sizes = np.bincount(labels.ravel())[1:]
        best_label = int(sizes.argmax()) + 1

    return labels == best_label


def _ellipse_prior(component: np.ndarray, scale: float = 3.0, edge_width: float = 0.8) -> np.ndarray:
    """根据连通块像素的二阶矩，生成一个软边椭圆空间先验（0~1 浮点）。

    该椭圆只作为“人脸大概位置”的裁剪/加权，不直接作为遮罩；
    内部 skin candidate 仍保留真实皮肤轮廓（眼睛/嘴/头发等空洞），因此不会变成实心椭圆。
    纯 numpy 二阶矩，无模型。
    """
    h, w = component.shape
    coords = np.argwhere(component)
    if coords.shape[0] < 10:
        return np.ones((h, w), dtype=np.float32)
    cy, cx = coords.mean(axis=0)
    cov = np.cov(coords, rowvar=False)
    cov = cov + np.eye(2) * 1e-3
    try:
        inv_cov = np.linalg.inv(cov)
    except np.linalg.LinAlgError:
        return np.ones((h, w), dtype=np.float32)

    yy, xx = np.mgrid[0:h, 0:w]
    diff = np.stack([yy - cy, xx - cx], axis=0)
    mahal = np.einsum("ihw,jhw,ij->hw", diff, diff, inv_cov)

    inner = max(0.0, scale - edge_width) ** 2
    outer = scale ** 2
    weight = (outer - mahal) / (outer - inner)
    return np.clip(weight, 0.0, 1.0).astype(np.float32)


def _apply_spatial_prior(cand: np.ndarray, main: np.ndarray,
                         y: np.ndarray, cb: np.ndarray, cr: np.ndarray,
                         hh: np.ndarray, ss: np.ndarray, vv: np.ndarray,
                         w: int, h: int) -> np.ndarray:
    """用脸核的椭圆先验加权候选皮肤区，抑制画面边缘同色背景泄漏。

    步骤：
      1) 在中央 ROI 内用更严格的肤色阈值取“脸核”，把墙面等同色背景排除在统计外；
      2) 用脸核二阶矩生成软边椭圆先验；
      3) 候选皮肤区与该先验相乘，远处背景被衰减；
      4) 二值化后取最大连通块，得到最终脸/脖子皮肤区。
    纯 scipy.ndimage / numpy，无模型。
    """
    if not main.any():
        return main

    # 中央 ROI：覆盖脸 + 上颈部，右侧收窄以避开墙面泄漏。
    x0, x1 = int(w * 0.30), int(w * 0.56)
    y0, y1 = int(h * 0.12), int(h * 0.62)
    face_roi = np.zeros((h, w), dtype=bool)
    face_roi[y0:y1, x0:x1] = True

    # 用严格阈值（tol=0）在中央 ROI 内取脸核，避免右侧墙面混入统计。
    strict = _skin_candidate(y, cb, cr, hh, ss, 0.0)
    core = strict & face_roi
    core = _keep_largest(core)
    if not core.any():
        # 回退：用默认候选在 ROI 内的最大块
        core = (cand & face_roi)
        core = _keep_largest(core)
    if not core.any():
        core = main

    ell = _ellipse_prior(core, scale=5.0, edge_width=1.2)
    weighted = cand.astype(np.float32) * ell
    # 阈值：保留先验权重较高处（>0.35）的皮肤候选
    region = weighted > 0.35

    # 形态学闭运算弥合小缝隙，并只保留最大块（脸/脖子）。
    closed = _morph_close(region)
    return _keep_largest(closed)


def _feather(region: np.ndarray, radius: float) -> np.ndarray:
    """对二值区域做高斯羽化，得到 0~255 软边灰度遮罩（边缘平滑过渡）。"""
    img = Image.fromarray((region * 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(radius=radius))
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

    duration = float(opts.get("duration") or probe["duration"])
    if duration <= 0 or not math.isfinite(duration):
        raise RuntimeError("无法确定视频时长（请通过 opts.duration 提供）")
    N = max(1, int(round(duration * fps)))

    # 算法参数（前端未传时走稳健默认）
    skin_tolerance = float(opts.get("skin_tolerance", 0.25))
    skin_tolerance = min(1.0, max(0.0, skin_tolerance))
    min_frac = float(opts.get("min_frac", 0.08))
    min_frac = min(0.5, max(0.02, min_frac))
    temporal_window = int(opts.get("temporal_window", 7))
    temporal_window = min(15, max(1, temporal_window))
    feather_radius = float(opts.get("feather_radius", 0.0)) or max(1.5, min(w, h) / 90.0)

    output_path = opts.get("output") or ""
    if not output_path:
        stem, ext = os.path.splitext(input_path)
        output_path = stem + "_skin_mask.mp4"
    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)

    # ── P1 解析模型加载 ──
    # 优先使用调用方显式指定的 ONNX model_path；命中则走多区域（face/neck/arm）解析路径。
    # 加载失败（缺失/损坏）→ 回退到旧阈值法（连通域+时序中值滤波），不回归、不静默丢效果。
    model_path = opts.get("model") or None
    service = None
    if model_path:
        try:
            from inference_service import BeautyInferenceService
            service = BeautyInferenceService(model_path)
            log("已加载美颜解析模型: {}".format(model_path))
        except Exception as e:  # noqa: BLE001
            log("美颜解析模型加载失败，回退阈值法: {}".format(e))
            service = None

    ff = _ffmpeg_exe()
    # 解码管道始终打开（两种路径共用）
    reader = subprocess.Popen(
        [ff, "-v", "error", "-i", input_path,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE,
    )

    frame_bytes = w * h * 3
    written = 0
    total_skin = 0

    # ── 分支 A：多区域解析（face/neck/arm 独立灰度 mask）──
    if service is not None:
        base, _ext = os.path.splitext(output_path)
        face_out = opts.get("faceMaskOutput") or (base + "_face_mask.mp4")
        neck_out = opts.get("neckMaskOutput") or (base + "_neck_mask.mp4")
        arm_out = opts.get("armMaskOutput") or (base + "_arm_mask.mp4")
        writers = {}
        for key, outp in (("face", face_out), ("neck", neck_out), ("arm", arm_out)):
            writers[key] = subprocess.Popen(
                [ff, "-y", "-v", "error",
                 "-f", "rawvideo", "-pix_fmt", "gray",
                 "-s", "{}x{}".format(w, h), "-r", "{:.4f}".format(fps), "-i", "pipe:0",
                 "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", outp],
                stdin=subprocess.PIPE,
            )
        try:
            while written < N:
                raw = reader.stdout.read(frame_bytes)
                if len(raw) < frame_bytes:
                    break
                rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
                masks = service.infer(rgb)  # face/neck/arm: float32 HxW ∈[0,1]
                union = np.zeros((h, w), dtype=np.float32)
                for key in ("face", "neck", "arm"):
                    m = masks[key]
                    union = np.maximum(union, m)
                    gray = (np.clip(m, 0.0, 1.0) * 255.0).astype(np.uint8)
                    writers[key].stdin.write(gray.tobytes())
                total_skin += int((union > 0.5).sum())
                written += 1
        finally:
            reader.stdout.close()
            reader.wait()
            for wr in writers.values():
                if wr.stdin:
                    wr.stdin.close()
                wr.wait()
        for key, wr in writers.items():
            if wr.returncode != 0:
                raise RuntimeError("ffmpeg 编码 {} mask 失败（退出码 {}）".format(key, wr.returncode))

        elapsed = time.time() - t0
        log("完成多区域 mask(ONNX face/neck/arm)：{}x{} {} 帧，用时 {:.2f}s".format(w, h, written, elapsed))
        skin_coverage = (total_skin / (w * h * max(1, written))) if written > 0 else 0.0
        return {
            "faceMaskPath": os.path.abspath(face_out),
            "neckMaskPath": os.path.abspath(neck_out),
            "armMaskPath": os.path.abspath(arm_out),
            "width": w,
            "height": h,
            "fps": fps,
            "frames": written,
            "skinCoverage": skin_coverage,
            "model": "beauty_parse_onnx",
            "mode": "parse",
        }

    # ── 分支 B：旧阈值法（连通域 + 时序中值滤波，单区域 skin mask）──
    writer = subprocess.Popen(
        [ff, "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", "{}x{}".format(w, h), "-r", "{:.4f}".format(fps), "-i", "pipe:0",
         "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", output_path],
        stdin=subprocess.PIPE,
    )
    hist = deque(maxlen=temporal_window)  # 帧间滑动窗口（存二值皮肤区），用于时序中值滤波
    try:
        while written < N:
            raw = reader.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            y, cb, cr = rgb_to_ycbcr(rgb)
            hh, ss, vv = rgb_to_hsv(rgb)
            cand = _skin_candidate(y, cb, cr, hh, ss, skin_tolerance)
            main = _select_skin_region(cand, w, h, min_frac)
            cleaned = _apply_spatial_prior(cand, main, y, cb, cr, hh, ss, vv, w, h)
            # 时序平滑：对二值皮肤区做滑动窗口“中值滤波”（窗口内过半帧为皮肤才保留）。
            # 相比灰度 EMA 或对二值做 2 帧 EMA，中值滤波能同时：(a) 抹掉单帧边界毛刺
            # （消除“摆动”），(b) 完整保留持续存在的真实皮肤边缘，因此覆盖率接近逐帧真值，
            # 不会像 2 帧 AND 那样把合法薄边也压掉。边界原本落在椭圆先验浅梯度上，
            # 单帧候选起伏会让边界抖动，中值滤波是更稳健的解法。
            hist.append(cleaned.astype(np.uint8))
            stack = np.stack(list(hist), axis=0)
            region = (stack.sum(axis=0) >= (len(hist) + 1) // 2).astype(np.uint8)
            gray = _feather(region > 0, feather_radius)
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
    log("完成皮肤 mask(连通域+时序中值滤波)：{}x{} {} 帧，用时 {:.2f}s（tol={:.2f}, min_frac={:.2f}, twindow={}, feather={:.1f}）".format(
        w, h, written, elapsed, skin_tolerance, min_frac, temporal_window, feather_radius))

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


# ───────────────────────── 人脸关键点（landmark）────────────────────────

def _default_landmark_model() -> str:
    """默认 106 点关键点 ONNX 路径（与训练管线产出约定一致）。"""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "landmark.onnx")


def generate_landmarks(input_path: str, opts: dict) -> dict:
    """逐帧推理 106 点人脸关键点，输出 (N,106,2) 原帧像素坐标。

    返回 {"landmarkPath": <json 路径>, "frames": N}；landmarkPath 指向一个 JSON 文件，
    内容为 [[[x,y],...], ...]（N 帧 × 106 点 × 2）。坐标与源帧同分辨率。
    """
    t0 = time.time()

    def log(msg: str):
        sys.stderr.write("[landmark] " + msg + "\n")
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

    duration = float(opts.get("duration") or probe["duration"])
    if duration <= 0 or not math.isfinite(duration):
        raise RuntimeError("无法确定视频时长（请通过 opts.duration 提供）")
    N = max(1, int(round(duration * fps)))

    model_path = opts.get("model") or _default_landmark_model()
    if not os.path.isfile(model_path):
        raise FileNotFoundError("人脸关键点模型不存在: {}".format(model_path))

    from landmark_service import LandmarkInferenceService
    service = LandmarkInferenceService(model_path)
    log("已加载人脸关键点模型: {}".format(model_path))

    ff = _ffmpeg_exe()
    reader = subprocess.Popen(
        [ff, "-v", "error", "-i", input_path,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    frame_bytes = w * h * 3
    written = 0
    landmarks: list = []
    try:
        while written < N:
            raw = reader.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            lm = service.infer(rgb)  # (106,2) float32 原帧像素坐标
            landmarks.append(lm.astype(np.float32).tolist())
            written += 1
    finally:
        reader.stdout.close()
        reader.wait()

    output_path = opts.get("landmarkOutput") or ""
    if not output_path:
        stem, ext = os.path.splitext(input_path)
        output_path = stem + "_landmarks.npy"
    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)
    # 存为 .npy（(N,106,2) float32），供 warp 模式复用，避免巨大 JSON。
    np.save(output_path, np.asarray(landmarks, dtype=np.float32))

    elapsed = time.time() - t0
    log("完成人脸关键点推理：{}x{} {} 帧，用时 {:.2f}s".format(w, h, written, elapsed))
    return {
        "landmarkPath": os.path.abspath(output_path),
        "width": w,
        "height": h,
        "frames": written,
        "model": "landmark_onnx",
        "mode": "landmark",
    }


# ───────────────────────── 形变网格（瘦脸/大眼）────────────────────────

def generate_warp_maps(input_path: str, opts: dict) -> dict:
    """由关键点生成瘦脸/大眼形变位移图（gray16le rawvideo，uint16 绝对像素坐标）。

    opts:
        - thinFace / bigEye: 0..1 强度（默认 0）。
        - landmarkPath: 可选，已生成的关键点 JSON 路径；缺省则内部调用 generate_landmarks。
        - width / height / fps / duration / model: 同 generate_landmarks。
    返回 {"warpXPath", "warpYPath", "width", "height"}。
    """
    t0 = time.time()

    def log(msg: str):
        sys.stderr.write("[warp] " + msg + "\n")
        sys.stderr.flush()

    if not os.path.isfile(input_path):
        raise FileNotFoundError("输入视频不存在: " + input_path)

    probe = _ffprobe(input_path)
    w = int(opts.get("width") or probe["width"])
    h = int(opts.get("height") or probe["height"])
    if w <= 0 or h <= 0:
        raise RuntimeError("无效视频尺寸 {}x{}".format(w, h))
    fps = float(opts.get("fps") or probe["fps"])
    if fps <= 0 or not math.isfinite(fps):
        fps = 30.0
    duration = float(opts.get("duration") or probe["duration"])
    if duration <= 0 or not math.isfinite(duration):
        raise RuntimeError("无法确定视频时长（请通过 opts.duration 提供）")

    thin_face = float(np.clip(float(opts.get("thinFace", 0.0) or 0.0), 0.0, 1.0))
    big_eye = float(np.clip(float(opts.get("bigEye", 0.0) or 0.0), 0.0, 1.0))

    # 委托给 warp.generate_warp_video：内部检测关键点（或复用 landmarksPath 的 .npy）
    # → 代表帧 generate_warp_maps → 写出 gray16le rawvideo（.gray，remap 直接以 16-bit 值作坐标读取）。
    from warp import generate_warp_video
    return generate_warp_video(input_path, opts)
