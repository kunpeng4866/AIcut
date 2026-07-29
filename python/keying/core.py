# -*- coding: utf-8 -*-
"""智能抠像核心：MODNet (Apache-2.0) ONNX CPU 推理 + ffmpeg 帧管道。

数据流：
    ffmpeg 解码输入视频 → rawvideo(rgb24) 管道 → onnxruntime 推理得到 matte
    → 灰度(rawvideo gray) 管道 → ffmpeg 编码为灰度 mp4（与输入同尺寸/帧率/时长）。

模型获取优先级：
    1. 环境变量 AICUT_MODNET_MODEL 指定本地路径（最高优先级）；
    2. HuggingFace 镜像（HF_ENDPOINT=https://hf-mirror.com, 关闭 XET）；
    3. GitHub Release（ZHKKKe/MODNet 官方 ONNX）；
    若网络被拦截 / 依赖不可用 → 回退「numpy 占位 matte」（中心偏置软椭圆），
    保证整条 IPC/引擎链路在没有模型权重时仍可端到端跑通。

matte 灰度约定：luma = matte * 255，0=背景，255=前景（与前端/导出统一契约对齐）。
"""
import os
import sys
import json
import math
import time
import shutil
import subprocess
import urllib.request

# 强制走 HuggingFace 镜像并关闭 XET（避免 hf_xet 传输插件拉取失败）。
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "aicut", "models")
GITHUB_RELEASE_URL = "https://github.com/ZHKKKe/MODNet/releases/download/ONNX/modnet.onnx"
# 占位/镜像是同一权重；此处仅为可读标识。
MODEL_FILENAME = "modnet.onnx"


# ───────────────────────── 媒体探测 ─────────────────────────

def _ffprobe(input_path: str) -> dict:
    """返回 {width,height,fps,duration}；失败时抛异常。"""
    cmd = [
        "ffprobe", "-v", "error",
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


def _ffmpeg_exe() -> str:
    return os.environ.get("AICUT_FFMPEG") or "ffmpeg"


# ─────────────────────���─── 模型获取 ─────────────────────────

def _model_cache_path() -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, MODEL_FILENAME)


def _ensure_model(log) -> str | None:
    """返回可用模型路径；不可用则 None（调用方回退占位 matte）。"""
    # 1) 显式指定
    env_path = os.environ.get("AICUT_MODNET_MODEL")
    if env_path and os.path.isfile(env_path):
        log("使用环境变量指定的模型: " + env_path)
        return env_path

    cache = _model_cache_path()
    if os.path.isfile(cache) and os.path.getsize(cache) > 1024:
        log("命中本地缓存模型: " + cache)
        return cache

    # 2) 尝试下载（优先 HF 镜像，再 GitHub Release；hf_hub_download 不保证安装）
    urls = [
        # Xenova/modnet ONNX 权重（Apache-2.0），经 hf-mirror.com 国内镜像加速
        "https://hf-mirror.com/Xenova/modnet/resolve/main/onnx/model.onnx",
        # 官方 GitHub Release（中国大陆可能超时）
        GITHUB_RELEASE_URL,
    ]

    for url in urls:
        try:
            log("尝试下载模型: " + url)
            tmp = cache + ".part"
            req = urllib.request.Request(url, headers={"User-Agent": "aicut-keying"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
                shutil.copyfileobj(resp, f)
            if os.path.getsize(tmp) > 1024:
                os.replace(tmp, cache)
                log("模型下载成功: " + cache)
                return cache
            os.remove(tmp)
        except Exception as e:  # noqa: BLE001
            log("下载失败({})：{}".format(url, e))
    log("模型不可用，回退 numpy 占位 matte")
    return None


# ───────────────────────── 推理器 ─────────────────────────

class _Predictor:
    """封装「真实 MODNet 模型」或「numpy 占位」两种预测路径。"""

    def __init__(self, model_path: str | None, log):
        self.log = log
        self.use_real = False
        self.session = None
        self.input_name = None
        self.mean = [0.485, 0.456, 0.406]
        self.std = [0.229, 0.224, 0.225]
        if model_path:
            try:
                import onnxruntime as ort  # type: ignore
                import numpy as np  # type: ignore
                self.np = np
                so = ort.SessionOptions()
                so.intra_op_num_threads = 1
                so.inter_op_num_threads = 1
                self.session = ort.InferenceSession(
                    model_path, so, providers=["CPUExecutionProvider"]
                )
                self.input_name = self.session.get_inputs()[0].name
                self.use_real = True
                log("MODNet ONNX 加载成功，使用真实模型推理")
            except Exception as e:  # noqa: BLE001
                self.log("ONNX 推理不可用({})，回退占位 matte".format(e))
                self.use_real = False
        if not self.use_real:
            import numpy as np  # type: ignore
            self.np = np
            self.log("使用 numpy 占位 matte（中心偏置软椭圆）")

    def predict_frame(self, rgb: "np.ndarray") -> "np.ndarray":
        """rgb: HxWx3 uint8 → 返回 HxW float32 matte 归一化到 [0,1]。"""
        np = self.np
        h, w = rgb.shape[:2]
        if self.use_real:
            from PIL import Image  # type: ignore
            img = Image.fromarray(rgb).convert("RGB")
            iw, ih = img.size
            scale = 512.0 / max(iw, ih)
            nw, nh = max(1, int(round(iw * scale))), max(1, int(round(ih * scale)))
            # MODNet 编码器含 5 级下采样，要求送入模型的 H/W 均为 32 的整数倍，
            # 否则上采样回对齐时 Concat 节点维度不匹配（报 Axis N 80 vs 73）。
            nw = max(32, int(round(nw / 32.0)) * 32)
            nh = max(32, int(round(nh / 32.0)) * 32)
            img_r = img.resize((nw, nh), Image.BILINEAR)
            arr = np.asarray(img_r, dtype=np.float32) / 255.0
            arr = arr.transpose(2, 0, 1)
            arr = (arr - np.array(self.mean).reshape(3, 1, 1)) / np.array(self.std).reshape(3, 1, 1)
            blob = np.expand_dims(arr, 0).astype(np.float32)
            out = self.session.run(None, {self.input_name: blob})[0]
            m = out[0, 0]
            # Xenova/modnet ONNX 已输出归一化 matte（0..1），直接截断即可。
            m = np.clip(m, 0.0, 1.0)
            # 上采样回原帧尺寸
            m_img = Image.fromarray((m * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
            return np.asarray(m_img, dtype=np.float32) / 255.0
        else:
            # 占位：中心偏置软椭圆（归一化半径 → 软衰减），偏向前景点亮。
            yy, xx = np.mgrid[0:h, 0:w]
            cx, cy = w / 2.0, h / 2.0
            nx = (xx - cx) / max(w / 2.0, 1.0)
            ny = (yy - cy) / max(h / 2.0, 1.0)
            d = np.sqrt(nx * nx + ny * ny)
            m = np.clip(1.0 - d, 0.0, 1.0)
            m = np.power(m, 0.6)  # 偏向前景点亮，模拟抠出中心主体
            return m.astype(np.float32)


# ───────────────────────── 主入口 ─────────────────────────

def generate_matte(input_path: str, opts: dict) -> dict:
    t0 = time.time()
    log_lines = []

    def log(msg: str):
        log_lines.append(msg)
        sys.stderr.write("[core] " + msg + "\n")

    if not os.path.isfile(input_path):
        raise FileNotFoundError("输入视频不存在: " + input_path)

    probe = _ffprobe(input_path)
    w, h = probe["width"], probe["height"]
    fps = probe["fps"]
    if fps <= 0 or not math.isfinite(fps):
        fps = 30.0
    if w <= 0 or h <= 0:
        raise RuntimeError("无效视频尺寸 {}x{}".format(w, h))

    # 输出路径：opts.output 优先，否则同目录 <stem>_matte.mp4
    output_path = opts.get("output") or ""
    if not output_path:
        stem, ext = os.path.splitext(input_path)
        output_path = stem + "_matte.mp4"
    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)

    model_path = _ensure_model(log)
    predictor = _Predictor(model_path, log)

    ff = _ffmpeg_exe()
    reader = subprocess.Popen(
        [ff, "-v", "error", "-i", input_path,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    writer = subprocess.Popen(
        [ff, "-v", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", "{}x{}".format(w, h), "-r", "{:.4f}".format(fps), "-i", "pipe:0",
         "-an", "-c:v", "libx264", "-pix_fmt", "gray", output_path],
        stdin=subprocess.PIPE,
    )

    np = predictor.np
    frame_bytes = w * h * 3
    frame_count = 0
    try:
        while True:
            raw = reader.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            matte = predictor.predict_frame(rgb)  # HxW float32 [0,1]
            gray = (np.clip(matte, 0.0, 1.0) * 255.0).astype(np.uint8)
            writer.stdin.write(gray.tobytes())
            frame_count += 1
    finally:
        reader.stdout.close()
        reader.wait()
        if writer.stdin:
            writer.stdin.close()
        writer.wait()

    duration = frame_count / fps if fps > 0 else probe["duration"]
    elapsed = time.time() - t0

    if writer.returncode != 0:
        raise RuntimeError("ffmpeg 编码 matte 失败（退出码 {}）".format(writer.returncode))

    log("完成：{} 帧，用时 {:.2f}s，使用{}".format(
        frame_count, elapsed, "真实模型" if predictor.use_real else "占位 matte"))

    return {
        "mattePath": os.path.abspath(output_path),
        "duration": round(duration, 3),
        "width": w,
        "height": h,
        "fps": fps,
        "frames": frame_count,
        "model": "modnet" if predictor.use_real else "placeholder",
        "mode": "matte",
    }


# ───────────────────────── 手动抠像（manual）─────────────────────────
# 新增依赖（不与上方智能抠像共用，避免改动 generate_matte 及其以上内容）。
import base64  # noqa: E402
import io  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageFilter  # noqa: E402


def generate_manual_matte(input_path: str, opts: dict) -> dict:
    """手动抠像：依前端涂抹引导图（guide）生成灰度 matte 视频。

    opts 约定：
      - guide: data URL 字符串 ``data:image/png;base64,<b64>``，RGBA 画布：
            前景涂抹 = 不透明白 (255,255,255,255)；背景涂抹 = 不透明黑 (0,0,0,255)；
            未涂抹 = A=0（透明）。
      - smartMattePath（可选）: 已存在灰度 matte mp4 绝对路径；读取其首帧作 base。
      - softness（可选）: 羽化强度，默认 0.1。
      - output（可选）: 输出路径，否则 <stem>_matte.mp4。

    返回 dict 字段与 generate_matte 一致（model/mode 为 "manual"）。
    """
    t0 = time.time()

    def log(msg: str):
        sys.stderr.write("[core] " + msg + "\n")

    if not os.path.isfile(input_path):
        raise FileNotFoundError("输入视频不存在: " + input_path)

    probe = _ffprobe(input_path)
    w, h = probe["width"], probe["height"]
    fps = probe["fps"]
    if fps <= 0 or not math.isfinite(fps):
        fps = 30.0
    if w <= 0 or h <= 0:
        raise RuntimeError("无效视频尺寸 {}x{}".format(w, h))

    # ── 解析 guide data URL → RGBA np array（gh x gw x 4）──
    guide = opts.get("guide")
    if not isinstance(guide, str) or not guide.startswith("data:"):
        raise ValueError("opts['guide'] 必须是 data URL 字符串（data:image/png;base64,...）")
    try:
        header, b64 = guide.split(",", 1)
    except ValueError:
        raise ValueError("guide data URL 缺少 ',' 分隔符")
    if ";base64" not in header:
        raise ValueError("guide data URL 必须为 base64 编码")
    raw = base64.b64decode(b64)
    ga = np.array(Image.open(io.BytesIO(raw)).convert("RGBA"))
    gh, gw = ga.shape[:2]

    A = ga[:, :, 3].astype(np.float32)
    R = ga[:, :, 0].astype(np.float32)
    fg_mask = (A > 32) & (R > 127)
    bg_mask = (A > 32) & (R <= 127)

    # ── base alpha：读取 smart matte 首帧（缩放到 guide 分辨率）或全 0 ──
    smart_path = opts.get("smartMattePath")
    if smart_path and os.path.isfile(smart_path) and os.path.getsize(smart_path) > 0:
        try:
            sp = _ffprobe(smart_path)
            sw, sh = sp["width"], sp["height"]
            ff = _ffmpeg_exe()
            p = subprocess.run(
                [ff, "-v", "error", "-i", smart_path,
                 "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            need = sw * sh
            if p.returncode == 0 and len(p.stdout) >= need:
                frame = np.frombuffer(p.stdout, dtype=np.uint8)[:need].reshape(sh, sw).astype(np.float32) / 255.0
                if (sw, sh) != (gw, gh):
                    frame = np.asarray(
                        Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8)).resize((gw, gh), Image.BILINEAR),
                        dtype=np.float32,
                    ) / 255.0
                base = frame
                log("已读取 smart matte 首帧作为 base（{}x{}）".format(gw, gh))
            else:
                log("smart matte 首帧读取失败，回退全 0 base")
                base = np.zeros((gh, gw), dtype=np.float32)
        except Exception as e:  # noqa: BLE001
            log("smart matte 读取异常({})，回退全 0 base".format(e))
            base = np.zeros((gh, gw), dtype=np.float32)
    else:
        base = np.zeros((gh, gw), dtype=np.float32)

    # ── 合成 alpha（guide 分辨率）──
    softness = float(opts.get("softness", 0.1))
    radius = max(0.5, softness * min(gw, gh) * 0.05)

    def _feather(mask_bool: np.ndarray) -> np.ndarray:
        m = mask_bool.astype(np.float32)
        return np.asarray(
            Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)),
            dtype=np.float32,
        ) / 255.0

    fg_f = _feather(fg_mask)
    bg_f = _feather(bg_mask)

    alpha = base * (1.0 - fg_f - bg_f) + fg_f * 1.0
    alpha = np.clip(alpha, 0.0, 1.0)
    # 若 fg/bg 都未涂抹，alpha == base（纯智能 matte，等价于不修正），不会出错。

    # ── 输出路径 ──
    output_path = opts.get("output") or ""
    if not output_path:
        stem, ext = os.path.splitext(input_path)
        output_path = stem + "_matte.mp4"
    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)

    # 缩回源尺寸 (w,h) → alpha_full（float32 0..1）
    alpha_full = np.asarray(
        Image.fromarray((np.clip(alpha, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR),
        dtype=np.float32,
    ) / 255.0

    # ── 用 ffmpeg rawvideo 管道写 N 帧相同灰度帧（与 generate_matte 一致）──
    N = max(1, int(round(probe["duration"] * fps)))
    ff = _ffmpeg_exe()
    writer = subprocess.Popen(
        [ff, "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", "{}x{}".format(w, h), "-r", "{:.4f}".format(fps), "-i", "pipe:0",
         "-an", "-c:v", "libx264", "-pix_fmt", "gray", output_path],
        stdin=subprocess.PIPE,
    )
    gray = (np.clip(alpha_full, 0, 1) * 255).astype(np.uint8)
    try:
        for _ in range(N):
            writer.stdin.write(gray.tobytes())
    finally:
        if writer.stdin:
            writer.stdin.close()
        writer.wait()

    if writer.returncode != 0:
        raise RuntimeError("ffmpeg 编码 manual matte 失败(退出码 {})".format(writer.returncode))

    elapsed = time.time() - t0
    log("完成 manual matte：{}x{} {} 帧，用时 {:.2f}s".format(w, h, N, elapsed))

    return {
        "mattePath": os.path.abspath(output_path),
        "duration": round(probe["duration"], 3),
        "width": w,
        "height": h,
        "fps": fps,
        "frames": N,
        "model": "manual",
        "mode": "manual",
    }
