# -*- coding: utf-8 -*-
"""美颜·瘦脸/大眼形变（P2 几何形变）。

核心：根据 106 点人脸关键点，计算「源坐标位移场」，生成两张形变图（warp map）：
    - xmap[y][x] = 输出像素 (x,y) 应采样的**源帧 x 坐标**
    - ymap[y][x] = 输出像素 (x,y) 应采样的**源帧 y 坐标**
经 ffmpeg `remap` 滤镜施加：out[y][x] = src[ ymap[y][x] ][ xmap[y][x] ]。

ffmpeg `remap` 坐标约定（按契约实现，对照 contract）：
    - xmap/ymap 为「源像素坐标」（uint16），经 ffmpeg `remap`（**不使用** `format=float`）直接索引源帧；值 = 采样点的 (x,y)。
    - 单位像素，坐标钳制到 [0,W-1] / [0,H-1]；越界区域由 remap 填边，故位移必须温和。
    - 形变图以 **gray16le rawvideo**（.gray 文件，已知 WxH）存储，uint16 绝对像素坐标；
      ffmpeg 读取时 `-f rawvideo -pix_fmt gray16le -s {W}x{H}`，remap 直接以 16-bit 值作坐标。
    - 恒等不变性（硬校验）：thin_face==0 且 big_eye==0 时 xmap==xs、ymap==ys，remap
      输出逐像素等于原图（不可对形变图做 scale，否则插值破坏绝对坐标）。
    - ⚠ 实测：本机引擎 ffmpeg（N-125258-gdf94900c98）**不支持** `format=float`/grayf32le（报
      "Unable to parse format value float"），**仅 gray16le（uint16 坐标）可用**，且 16-bit 值
      被 remap 直接当作源坐标（identity 图逐像素还原原图，diff=0）。故本模块以 gray16le 写出，
      整数 1px 精度；未来若 ffmpeg 支持 format=float 可升级 grayf32le 获得亚像素平滑。

坐标约定（验证结论）：
    - 恒等：xmap=x, ymap=y → 输出原图；
    - 右移 5px：xmap=x-5 → 输出像素 (x,y) 采样源 (x-5,y)，画面整体右移 5px；
    - 即「map 值 = 输出坐标 + 位移」，位移 = map - coord。

形变数学（供 GLSL/WebGL 移植）：
────────────────────────────────────────────────────────
记输出像素坐标为 (X,Y)，landmarks 为 106 点像素坐标 P[i]=(px,py)。
所有位移都用「以某中心为原点、按高斯/余弦权重衰减」的方式构造，保证：
    - 形变集中在人脸区域，背景（权重→0）几乎不动；
    - 中心点位移为 0（脸轴 / 眼心固定），过渡平滑。

(1) 瘦脸（thin_face ∈ [0,1]，越大越瘦）：水平压缩脸宽，向「脸中轴」收拢。
    脸中轴 x 坐标 cx = P[鼻尖=91].x
    纵向中心 cy = mean(P[左下颌角=0].y, P[右下颌角=32].y, P[下巴=16].y)
    脸宽 face_w = |P[32].x - P[0].x|；水平高斯带宽 sx = max(20, face_w/2)
    垂直带宽 sy 取脸高比例；高斯权重：
        w_t(X,Y) = exp( -((X-cx)²/(2·sx²) + (Y-cy)²/(2·sy²)) )
    水平位移（向中轴收拢 → 采样更靠外 → 视觉变窄）：
        Dx_t(X,Y) = +gain_t · (X - cx) · w_t     gain_t = thin_face · 0.5
        Dy_t = 0   （瘦脸只做水平压缩，不动垂直）
    验证：X>cx 时 Dx_t>0 → xmap = X + Dx_t > X → 采样更靠外 → 该处内容被「拉向中轴」，
          脸宽视觉收窄；X=cx 时 Dx_t=0（中轴不动）。✔  （注意：符号必须为 +，负向会反而变宽）

(2) 大眼（big_eye ∈ [0,1]，越大越放大）：以每个眼心为原点做径向放大。
    左眼心 E_L = P[左眼中心=60]，右眼心 E_R = P[右眼中心=72]
    每只眼的影响半径 r = 该眼环点（左眼 55..66 / 右眼 67..78）到眼心距离的均值。
    仅 r 半径内生效，raised-cosine 衰减避免硬边：
        d = ‖(X,Y) - E‖； t = clamp(d/r, 0, 1)； decay = 0.5·(1 + cos(π·t))
        k = big_eye · decay
    径向位移（向眼心收拢采样 → 视觉放大）：
        Dx_e = -k · (X - ex) ； Dy_e = -k · (Y - ey)
    验证：X>ex 时 Dx_e<0 → xmap = X + Dx_e < X → 采样更靠内（靠近眼心）→ 该处内容被
          「推离眼心放大」，眼睛视觉变大；眼心本身 D=0 不动。✔ （注意：符号必须为 -，正向会反而变小）

(3) 合成：总位移 D = D_t + Σ D_e（左右眼叠加）；
        xmap = clamp(X + Dx, 0, W-1)
        ymap = clamp(Y + Dy, 0, H-1)
    最终 warp map 以 uint16（gray16le）写出，值即上述钳制后的源坐标（整数 1px 精度，由
    remap 直接以 16-bit 值作坐标读取；本机 ffmpeg 不支持 format=float/grayf32le）。
────────────────────────────────────────────────────────
注意：瘦脸/大眼可同时开启；权重衰减保证两形变互不破坏背景。

锚点索引（严格镜像 models/landmark_net.py::LANDMARK_INDEX，不可自行臆造）：
    jaw_left=0, jaw_right=32, chin=16, cheek_left=4, cheek_right=28,
    left_eye_center=60, right_eye_center=72, nose_tip=91,
    mouth_left=92, mouth_right=105；左眼环 55..66，右眼环 67..78。
"""
import os
import sys
import json
import math
import time
import subprocess

import numpy as np


# ffmpeg / ffprobe 路径（与 core.py 保持一致，self-contained 避免与 core 循环 import）
def _ffmpeg_exe() -> str:
    return os.environ.get("AICUT_FFMPEG") or "E:/codex/codex-tools/bin/ffmpeg.exe"


def _ffprobe_exe() -> str:
    return os.environ.get("AICUT_FFPROBE") or "E:/codex/codex-tools/bin/ffprobe.exe"


def _ffprobe(input_path: str) -> dict:
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


# ── 锚点索引（严格镜像 landmark_net.LANDMARK_INDEX）──
IDX_JAW_LEFT = 0
IDX_JAW_RIGHT = 32
IDX_CHIN = 16
IDX_CHEEK_LEFT = 4
IDX_CHEEK_RIGHT = 28
IDX_LEFT_EYE_CENTER = 60
IDX_RIGHT_EYE_CENTER = 72
IDX_NOSE_TIP = 91
IDX_MOUTH_LEFT = 92
IDX_MOUTH_RIGHT = 105
LEFT_EYE_RING = range(55, 67)     # 左眼轮廓环 55..66
RIGHT_EYE_RING = range(67, 79)    # 右眼轮廓环 67..78


def _require_landmarks(lm: np.ndarray) -> np.ndarray:
    """landmarks 形状可为 (106,2) 或 (N,106,2)；后者取逐点均值得到代表帧。"""
    lm = np.asarray(lm, dtype=np.float32)
    if lm.ndim == 3:
        lm = lm.mean(axis=0)
    if lm.shape != (106, 2):
        raise ValueError("landmarks 形状应为 (106,2) 或 (N,106,2)，实际: {}".format(lm.shape))
    return lm


def generate_warp_maps(
    landmarks_106_frame_xy: np.ndarray,
    W: int,
    H: int,
    thin_face: float = 0.0,
    big_eye: float = 0.0,
) -> tuple:
    """根据单帧 106 点关键点生成形变图（float32 源坐标，绝对像素）。

    参数：
        landmarks_106_frame_xy: (106,2) 或 (N,106,2) 像素坐标（float）。
        W, H: 输出帧尺寸（与 landmarks 坐标系一致）。
        thin_face, big_eye: ∈ [0,1]（0 = 不施加）。
    返回：
        (xmap, ymap): 均为 float32 (H, W)，值 = 源像素坐标（绝对像素，已 clip 到 [0,W-1]/[0,H-1]）。
        调用方直接以 gray16le rawvideo 写出（remap 直接以 16-bit 值作坐标读取）。
    """
    lm = _require_landmarks(landmarks_106_frame_xy)
    thin_face = float(np.clip(thin_face, 0.0, 1.0))
    big_eye = float(np.clip(big_eye, 0.0, 1.0))

    ys, xs = np.mgrid[0:H, 0:W]  # xs[y][x]=x, ys[y][x]=y
    xmap = xs.astype(np.float32).copy()
    ymap = ys.astype(np.float32).copy()

    # ── 瘦脸：水平方向把像素拉向人脸中轴（nose_tip.x）──
    if thin_face > 0.0:
        axis_x = float(lm[IDX_NOSE_TIP][0])
        jaw_y = float(
            (lm[IDX_JAW_LEFT][1] + lm[IDX_JAW_RIGHT][1] + lm[IDX_CHIN][1]) / 3.0
        )
        face_w = abs(float(lm[IDX_JAW_RIGHT][0] - lm[IDX_JAW_LEFT][0])) + 1e-3
        sx = max(20.0, face_w / 2.0)
        eye_y = float((lm[IDX_LEFT_EYE_CENTER][1] + lm[IDX_RIGHT_EYE_CENTER][1]) / 2.0)
        sy = max(20.0, abs(jaw_y - eye_y) / 1.5)
        # 二维高斯：以中轴×下颌线为中心，远离则权重衰减
        gx = ((xs - axis_x) ** 2) / (2.0 * sx * sx)
        gy = ((ys - jaw_y) ** 2) / (2.0 * sy * sy)
        w_h = np.exp(-(gx + gy)).astype(np.float32)
        # Dx = +(X - axis_x) · w_h · thin_face（正号 → 向中轴收拢 → 视觉变窄）
        dx_axis = (xs - axis_x).astype(np.float32)
        Dx = (dx_axis * w_h * thin_face).astype(np.float32)
        xmap = (xmap + Dx).astype(np.float32)

    # ── 大眼：以两眼中心做径向向外推（eye 半径内，raised-cosine 衰减）──
    if big_eye > 0.0:
        for center_idx, ring in ((IDX_LEFT_EYE_CENTER, LEFT_EYE_RING),
                                 (IDX_RIGHT_EYE_CENTER, RIGHT_EYE_RING)):
            cx = float(lm[center_idx][0])
            cy = float(lm[center_idx][1])
            # 眼半径 = 眼环点到眼心距离的均值（自适应不同脸型/分辨率）。
            # 注意：眼心索引本身也在环范围内（如左眼环 55..66 含 60），其到自身距离为 0，
            # 会低估半径；故剔除距离 ~0 的点再取均值。
            ring_pts = lm[list(ring)]
            dists = np.linalg.norm(ring_pts - np.array([cx, cy], np.float32), axis=1)
            dists = dists[dists > 1e-3]
            r_eye = float(np.mean(dists)) if dists.size > 0 else 0.0
            r_eye = max(10.0, r_eye)
            ddx = (xs - cx).astype(np.float32)
            ddy = (ys - cy).astype(np.float32)
            dist = np.sqrt(ddx * ddx + ddy * ddy)
            t = np.clip(dist / r_eye, 0.0, 1.0)
            decay = (0.5 * (1.0 + np.cos(np.pi * t))).astype(np.float32)
            k = (big_eye * decay).astype(np.float32)
            # Dx = -ddx · k（负号 → 向眼心收拢采样 → 视觉放大）
            Dx = (-ddx * k).astype(np.float32)
            Dy = (-ddy * k).astype(np.float32)
            mask = dist < r_eye
            xmap[mask] = (xmap[mask] + Dx[mask]).astype(np.float32)
            ymap[mask] = (ymap[mask] + Dy[mask]).astype(np.float32)

    xmap = np.clip(xmap, 0.0, float(W - 1)).astype(np.float32)
    ymap = np.clip(ymap, 0.0, float(H - 1)).astype(np.float32)
    return xmap, ymap


def landmarks_from_video(input_path: str, opts: dict) -> np.ndarray:
    """对输入视频逐帧跑 106 点关键点检测，返回 (N,106,2) float（像素坐标）。

    模型：opts["landmarkModel"] 或环境变量 AICUT_BEAUTY_LANDMARK_MODEL，缺省
    python/beauty/models/landmark.onnx。模型缺失 → 抛 FileNotFoundError（调用方回退）。
    """
    from landmark_service import LandmarkInferenceService

    model_path = (opts.get("landmarkModel")
                  or os.environ.get("AICUT_BEAUTY_LANDMARK_MODEL")
                  or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "models", "landmark.onnx"))
    svc = LandmarkInferenceService(model_path)

    probe = _ffprobe(input_path)
    w = int(opts.get("width") or probe["width"])
    h = int(opts.get("height") or probe["height"])
    fps = float(opts.get("fps") or probe["fps"])
    if fps <= 0 or not math.isfinite(fps):
        fps = 30.0
    duration = float(opts.get("duration") or probe["duration"])
    if duration <= 0:
        duration = 5.0
    N = max(1, int(round(duration * fps)))

    ff = _ffmpeg_exe()
    reader = subprocess.Popen(
        [ff, "-v", "error", "-i", input_path,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    frame_bytes = w * h * 3
    seq = []
    written = 0
    try:
        while written < N:
            raw = reader.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            pts = svc.infer(rgb)  # (106,2) 像素坐标
            seq.append(pts.astype(np.float32))
            written += 1
    finally:
        reader.stdout.close()
        reader.wait()
    if not seq:
        raise RuntimeError("未解码到任何帧，无法检测关键点")
    return np.stack(seq, axis=0)  # (N,106,2)


def _write_gray16le_raw(xmap: np.ndarray, ymap: np.ndarray,
                        x_path: str, y_path: str) -> None:
    """把单帧形变图 (H,W) 绝对像素坐标写成 gray16le rawvideo（.gray 文件，已知 WxH）。

    本机引擎 ffmpeg（N-125258-gdf94900c98）**不支持** remap=format=float / grayf32le
    （实测报 "Unable to parse format value float"），仅 gray16le（uint16 绝对像素坐标）
    可用，且 16-bit 值被 remap 直接当作源坐标（已验证 identity 图逐像素还原原图，diff=0）。
    故以 uint16（row-major, little-endian）原样写出，不经由 ffmpeg 编码；ffmpeg 读取时：
        -f rawvideo -pix_fmt gray16le -s {W}x{H} -i <file>
    xmap[y][x] = 输出像素 (x,y) 应采样的源帧 x 坐标（uint16 像素索引），ymap 同理。
    注意：坐标已钳制到 [0,W-1]/[0,H-1]，uint16 上限 65535 覆盖本软件最大 4K(3840) 分辨率；
    整数 1px 精度（未来若 ffmpeg 支持 format=float 可升级 grayf32le 获得亚像素平滑）。
    """
    xmap = np.clip(np.ascontiguousarray(xmap, dtype=np.float32), 0.0, 65535.0).round().astype(np.uint16)
    ymap = np.clip(np.ascontiguousarray(ymap, dtype=np.float32), 0.0, 65535.0).round().astype(np.uint16)
    if xmap.ndim != 2 or ymap.ndim != 2 or xmap.shape != ymap.shape:
        raise ValueError("形变图应为同形 (H,W) uint16，实际: {} / {}".format(xmap.shape, ymap.shape))
    parent = os.path.dirname(os.path.abspath(x_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(x_path, "wb") as fx:
        fx.write(xmap.tobytes())
    with open(y_path, "wb") as fy:
        fy.write(ymap.tobytes())


def generate_warp_video(input_path: str, opts: dict) -> dict:
    """生成瘦脸/大眼形变图（两张 gray16le rawvideo，单帧代表帧），返回契约 dict。

    流程：关键点（优先复用 opts["landmarksPath"] 预存 .npy，否则内部 generate_landmarks）
    → 取代表帧（逐点均值）→ 单次 generate_warp_maps → 写出 x/y warp map（.gray，gray16le）。

    返回：
        {warpXPath, warpYPath, width, height, frames, mode: "warp"}
        frames = 1（单张代表帧形变图，供整段 clip 的 remap 复用）。
    """
    t0 = time.time()
    probe = _ffprobe(input_path)
    w = int(opts.get("width") or probe["width"])
    h = int(opts.get("height") or probe["height"])
    fps = float(opts.get("fps") or probe["fps"])
    if fps <= 0 or not math.isfinite(fps):
        fps = 30.0
    duration = float(opts.get("duration") or probe["duration"])
    if duration <= 0:
        duration = 5.0
    N = max(1, int(round(duration * fps)))

    thin_face = float(np.clip(float(opts.get("thinFace", 0.0) or 0.0), 0.0, 1.0))
    big_eye = float(np.clip(float(opts.get("bigEye", 0.0) or 0.0), 0.0, 1.0))

    # 1) 关键点序列：优先复用预存 landmarks 文件（.npy），否则实时检测
    landmarks_path = opts.get("landmarksPath")
    if landmarks_path and os.path.isfile(landmarks_path):
        seq = np.load(landmarks_path).astype(np.float32)  # (N,106,2)
    else:
        from core import generate_landmarks  # 延迟导入，避免循环依赖
        res = generate_landmarks(input_path, opts)
        seq = np.load(res["landmarkPath"]).astype(np.float32)
    if seq.shape[0] > N:
        seq = seq[:N]

    # 2) 代表帧：逐点均值得到 (106,2)，稳定且避免单帧抖动
    lm = _require_landmarks(seq)
    xmap, ymap = generate_warp_maps(lm, w, h, thin_face, big_eye)

    # 3) 写出 gray16le rawvideo（.gray，已知 WxH），remap 直接以 uint16 值作坐标读取
    out_dir = os.path.dirname(os.path.abspath(input_path))
    stem, _ext = os.path.splitext(input_path)
    base = opts.get("outputBase") or stem
    warp_x_path = opts.get("warpXOutput") or (base + "_warp_x.gray")
    warp_y_path = opts.get("warpYOutput") or (base + "_warp_y.gray")
    _write_gray16le_raw(xmap, ymap, warp_x_path, warp_y_path)

    elapsed = time.time() - t0
    sys.stderr.write("[warp] 完成形变图：{}x{} 代表帧，thin={:.2f} big={:.2f}，用时 {:.2f}s\n".format(
        w, h, thin_face, big_eye, elapsed))
    return {
        "warpXPath": os.path.abspath(warp_x_path),
        "warpYPath": os.path.abspath(warp_y_path),
        "width": w,
        "height": h,
        "frames": 1,
        "mode": "warp",
    }
