# -*- coding: utf-8 -*-
"""视频超清增强（Super Resolution）推理引擎。

数据流：
    ffmpeg 解码输入视频 → rawvideo(rgb24) 管道 → 3 帧滑动窗口 → ONNX 分块推理
    （Gaussian Blending 拼接）→ rawvideo(rgb24) 管道 → ffmpeg 编码（h264_nvenc
    优先，回退 libx264），原视频音轨直通复用。

模型契约（Phase 0）：
    输入  : float32 (1, 9, H, W)，通道序 = concat([prev, curr, next]) 的 RGB，值域 [0,1]
    输出  : float32 (1, 3, H*scale, W*scale)，值域 [0,1]
    要求  : H/W 维度动态（分块尺寸在图像边缘会小于 tile_size）

合规：模型权重自行训练，不引入任何第三方预训练权重 / 商业 SDK。
"""
import os
import shutil
import sys
import json
import math
import time
import subprocess


# ───────────────────────── CUDA DLL 路径注入 ─────────────────────────
# onnxruntime-gpu 依赖 nvidia-* pip 包提供的 CUDA/cuDNN DLL（cublasLt64_*.dll /
# cudnn64_*.dll 等），但 ORT 不会自动把它们加入 PATH，缺失时 CUDA EP 报
# "... which is missing" 并静默回退 CPU。必须在 import onnxruntime 之前注入。
def _prepend_cuda_dll_path() -> None:
    # 用 glob 匹配 nvidia/*/bin 与 nvidia/*/bin/x86_64，兼容 cu13→cu14 等未来升级，
    # 避免硬编码版本号在 nvidia pip 包升版本后路径断裂。
    import glob as _glob

    sp = os.path.join(sys.prefix, "Lib", "site-packages")
    nvidia_root = os.path.join(sp, "nvidia")
    add = []
    if os.path.isdir(nvidia_root):
        for pat in (os.path.join(nvidia_root, "*", "bin"),
                    os.path.join(nvidia_root, "*", "bin", "x86_64")):
            for d in _glob.glob(pat):
                if os.path.isdir(d):
                    add.append(d)
    if add:
        os.environ["PATH"] = os.pathsep.join(add + [os.environ.get("PATH", "")])


_prepend_cuda_dll_path()

import numpy as np  # noqa: E402


DEFAULT_MODEL_PATH = "E:/AIcut/python/models/sr_v0_test.onnx"


def default_model_path() -> str:
    """模型路径：环境变量 AICUT_SR_MODEL 优先，否则用仓库内默认路径。"""
    return os.environ.get("AICUT_SR_MODEL") or DEFAULT_MODEL_PATH


# ───────────────────────── ffmpeg / ffprobe ─────────────────────────

def _ffmpeg_exe() -> str:
    return (os.environ.get("AICUT_FFMPEG")
            or shutil.which("ffmpeg")
            or "E:/codex/codex-tools/bin/ffmpeg.exe")


def _ffprobe_exe() -> str:
    return (os.environ.get("AICUT_FFPROBE")
            or shutil.which("ffprobe")
            or "E:/codex/codex-tools/bin/ffprobe.exe")


def _ffprobe(input_path: str) -> dict:
    """返回 {width, height, fps, duration, has_audio, nb_frames}；失败抛异常。"""
    cmd = [
        _ffprobe_exe(), "-v", "error",
        "-show_entries",
        "stream=index,codec_type,width,height,r_frame_rate,duration,nb_frames"
        ":format=duration",
        "-of", "json", input_path,
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("ffprobe 失败: " + p.stderr.decode("utf-8", "ignore")[:400])
    info = json.loads(p.stdout.decode("utf-8", "ignore"))
    streams = info.get("streams") or []

    vs = None
    has_audio = False
    for s in streams:
        ct = s.get("codec_type")
        if ct == "video" and vs is None:
            vs = s
        elif ct == "audio":
            has_audio = True
    if vs is None:
        raise RuntimeError("ffprobe 未找到视频流")

    w = int(vs.get("width") or 0)
    h = int(vs.get("height") or 0)

    fps = 0.0
    rfr = vs.get("r_frame_rate") or "0/0"
    if "/" in rfr:
        try:
            a, b = rfr.split("/")
            if float(b) > 0:
                fps = float(a) / float(b)
        except ValueError:
            fps = 0.0
    if fps <= 0 or not math.isfinite(fps):
        fps = 30.0

    dur = 0.0
    try:
        dur = float(vs.get("duration") or (info.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        dur = 0.0

    nb = 0
    try:
        nb = int(vs.get("nb_frames") or 0)
    except (TypeError, ValueError):
        nb = 0
    if nb <= 0 and dur > 0:
        nb = int(round(dur * fps))

    return {
        "width": w, "height": h, "fps": fps, "duration": dur,
        "has_audio": has_audio, "nb_frames": nb,
    }


_NVENC_CACHE = None


def _nvenc_available(log=None) -> bool:
    """预检 h264_nvenc 是否真的可用（列表里有 ≠ 能跑，驱动/会话数都可能失败）。"""
    global _NVENC_CACHE
    if _NVENC_CACHE is not None:
        return _NVENC_CACHE
    ok = False
    try:
        p = subprocess.run(
            [_ffmpeg_exe(), "-hide_banner", "-v", "error",
             # 尺寸不能太小：NVENC 有最小帧尺寸限制（<128 会报 invalid param）,
             # 用 256x256 预检避免把可用的 nvenc 误判为不可用。
             "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
             "-c:v", "h264_nvenc", "-f", "null", "-"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30,
        )
        ok = p.returncode == 0
        if not ok and log:
            log("h264_nvenc 预检失败，回退 libx264: "
                + p.stderr.decode("utf-8", "ignore").strip()[:200])
    except Exception as e:  # noqa: BLE001
        ok = False
        if log:
            log("h264_nvenc 预检异常({})，回退 libx264".format(e))
    _NVENC_CACHE = ok
    return ok


# ───────────────────────── Gaussian Blending ─────────────────────────

def _gaussian_weights(tile_size: int, sigma: float = None) -> np.ndarray:
    """生成 2D 高斯权重矩阵，中心≈1、边缘→0，用于分块拼接的软过渡。"""
    if sigma is None:
        sigma = tile_size / 4.0
    ax = np.arange(tile_size, dtype=np.float32) - tile_size / 2.0
    gauss = np.exp(-ax ** 2 / (2.0 * sigma ** 2))
    weights = np.outer(gauss, gauss)
    # 下限兜底：边缘块被裁剪后权重可能整体趋 0，除以 weight_sum 会放大噪声/除零。
    weights = np.maximum(weights, 1e-3)
    return weights.astype(np.float32)


def _tile_starts(length: int, tile: int, step: int):
    """在 [0, length) 上按 step 生成块起点；最后一块用实际剩余尺寸（不越界）。"""
    if length <= tile:
        return [0]
    starts = list(range(0, length - tile + 1, step))
    if starts[-1] + tile < length:
        starts.append(length - tile)
    return starts


def _upscale_bicubic(img_u8: np.ndarray, scale: int) -> np.ndarray:
    """HxWx3 uint8 → (H*s)x(W*s)x3 uint8。PIL 不可用时退化为最近邻。"""
    h, w = img_u8.shape[:2]
    try:
        from PIL import Image  # type: ignore
        return np.asarray(
            Image.fromarray(img_u8).resize((w * scale, h * scale), Image.BICUBIC),
            dtype=np.uint8,
        )
    except Exception:  # noqa: BLE001
        return np.repeat(np.repeat(img_u8, scale, axis=0), scale, axis=1)


# ───────────────────────── 推理引擎 ─────────────────────────

class SuperResolver:
    """ONNX 超分推理器：3 帧时序输入 + LR 空间分块 + Gaussian Blending 合并。"""

    def __init__(self, model_path: str = None, scale: int = 2, tile_size: int = 256,
                 tile_overlap: int = 32, provider: str = "cuda", log=None):
        self.log = log or (lambda m: (sys.stderr.write("[sr] " + str(m) + "\n"),
                                      sys.stderr.flush()))
        self.scale = int(scale)
        self.tile_size = int(tile_size)
        self.tile_overlap = int(tile_overlap)
        if self.tile_overlap >= self.tile_size:
            raise ValueError("tile_overlap({}) 必须小于 tile_size({})".format(
                self.tile_overlap, self.tile_size))

        self.model_path = model_path or default_model_path()
        if not os.path.isfile(self.model_path):
            raise FileNotFoundError(
                "超分 ONNX 模型不存在: {}\n"
                "请先训练并导出模型（python/sr/export_onnx.py），或用环境变量 "
                "AICUT_SR_MODEL 指定已有模型路径。".format(self.model_path))

        # CUDA DLL 路径已在模块导入时注入，此处才 import onnxruntime。
        import onnxruntime as ort  # type: ignore

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        # provider 兜底链：CUDA → CPU（本机无 onnxruntime-directml，不挂 DML）。
        if str(provider).lower() in ("cpu",):
            chain = ["CPUExecutionProvider"]
        else:
            chain = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        avail = ort.get_available_providers()

        self.session = None
        self.provider = None
        for ep in chain:
            if ep not in avail:
                continue
            try:
                sess = ort.InferenceSession(self.model_path, so, providers=[ep])
                if ep in sess.get_providers():
                    self.session = sess
                    self.provider = ep
                    break
            except Exception as e:  # noqa: BLE001
                self.log("EP[{}] 初始化失败({})，尝试下一个".format(ep, e))
        if self.session is None:
            raise RuntimeError("所有可用 EP 均初始化失败（available={}）".format(avail))

        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self._weight_cache = {}
        self.log("模型加载成功: {} (EP={}, scale={}x, tile={}/{})".format(
            os.path.basename(self.model_path), self.provider,
            self.scale, self.tile_size, self.tile_overlap))

    # ── 单帧推理 ──

    def _weights(self, size: int) -> np.ndarray:
        w = self._weight_cache.get(size)
        if w is None:
            w = _gaussian_weights(size)
            self._weight_cache[size] = w
        return w

    def _run_tile(self, tile_chw: np.ndarray) -> np.ndarray:
        """tile_chw: (9, th, tw) float32 [0,1] → (3, th*s, tw*s) float32。"""
        blob = np.expand_dims(tile_chw, 0).astype(np.float32)
        out = self.session.run([self.output_name], {self.input_name: blob})[0]
        return np.asarray(out[0], dtype=np.float32)

    def process_frame(self, prev_frame: np.ndarray, curr_frame: np.ndarray,
                      next_frame: np.ndarray, strength: float = 1.0) -> np.ndarray:
        """3 帧 HxWx3 uint8 → (H*scale)x(W*scale)x3 uint8。"""
        h, w = curr_frame.shape[:2]
        for name, f in (("prev", prev_frame), ("next", next_frame)):
            if f.shape[:2] != (h, w):
                raise ValueError("{} 帧尺寸 {} 与当前帧 {} 不一致".format(
                    name, f.shape[:2], (h, w)))

        s = self.scale
        # concat 3 帧 → (H, W, 9) → (9, H, W)，归一化到 [0,1]
        stack = np.concatenate([prev_frame, curr_frame, next_frame], axis=2)
        inp = stack.transpose(2, 0, 1).astype(np.float32) / 255.0

        tile = self.tile_size
        step = max(1, tile - self.tile_overlap)
        ys = _tile_starts(h, tile, step)
        xs = _tile_starts(w, tile, step)

        out_h, out_w = h * s, w * s
        acc = np.zeros((3, out_h, out_w), dtype=np.float32)
        wsum = np.zeros((1, out_h, out_w), dtype=np.float32)

        for y in ys:
            th = min(tile, h - y)
            for x in xs:
                tw = min(tile, w - x)
                sr = self._run_tile(inp[:, y:y + th, x:x + tw])  # (3, th*s, tw*s)
                # HR 空间高斯权重：按满块尺寸生成后裁到该块实际输出尺寸。
                gw = self._weights(tile * s)[:th * s, :tw * s]
                oy, ox = y * s, x * s
                acc[:, oy:oy + th * s, ox:ox + tw * s] += sr * gw
                wsum[:, oy:oy + th * s, ox:ox + tw * s] += gw

        out = acc / np.maximum(wsum, 1e-8)
        out = np.clip(out, 0.0, 1.0).transpose(1, 2, 0)  # → HxWx3
        out_u8 = (out * 255.0 + 0.5).astype(np.uint8)

        # 效果强度：0=纯 bicubic 原始放大，1=完全超分，中间值线性混合。
        st = float(strength)
        if st < 0.999:
            st = max(0.0, st)
            base = _upscale_bicubic(curr_frame, s)
            out_u8 = np.clip(
                base.astype(np.float32) * (1.0 - st) + out_u8.astype(np.float32) * st,
                0.0, 255.0).astype(np.uint8)
        return out_u8

    # ── 整段视频 ──

    def process_video(self, input_path: str, output_path: str, opts: dict = None,
                      progress_callback=None) -> dict:
        opts = opts or {}
        log = self.log
        t0 = time.time()

        if not os.path.isfile(input_path):
            raise FileNotFoundError("输入视频不存在: " + input_path)

        # opts 可覆盖分块参数（scale 由模型决定，仅在 opts 显式给出时同步）
        if opts.get("scale"):
            self.scale = int(opts["scale"])
        if opts.get("tile_size"):
            self.tile_size = int(opts["tile_size"])
        if opts.get("tile_overlap") is not None:
            self.tile_overlap = int(opts["tile_overlap"])
        if self.tile_overlap >= self.tile_size:
            raise ValueError("tile_overlap 必须小于 tile_size")
        self._weight_cache.clear()
        strength = float(opts.get("strength", 1.0))

        probe = _ffprobe(input_path)
        w, h, fps = probe["width"], probe["height"], probe["fps"]
        if w <= 0 or h <= 0:
            raise RuntimeError("无效视频尺寸 {}x{}".format(w, h))
        total = probe["nb_frames"]
        out_w, out_h = w * self.scale, h * self.scale

        out_dir = os.path.dirname(os.path.abspath(output_path))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)

        # 编码器选择：nvenc 优先（预检真实可用性），失败回退 x264。
        want = str(opts.get("encoder", "nvenc")).lower()
        use_nvenc = want in ("nvenc", "h264_nvenc") and _nvenc_available(log)
        if use_nvenc:
            venc = ["-c:v", "h264_nvenc",
                    "-preset", str(opts.get("preset", "p6")),
                    "-rc", "vbr",
                    "-b:v", str(opts.get("bitrate", "25M")),
                    "-maxrate", str(opts.get("bitrate", "25M")),
                    "-bufsize", "50M"]
            enc_tag = "h264_nvenc"
        else:
            venc = ["-c:v", "libx264",
                    "-preset", "medium",
                    "-crf", str(int(opts.get("crf", 20)))]
            enc_tag = "libx264"

        ff = _ffmpeg_exe()
        reader = subprocess.Popen(
            [ff, "-v", "error", "-i", input_path,
             "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
            stdout=subprocess.PIPE,
        )

        # 音轨：不落临时文件，编码进程二次打开源文件只取音频流直通复用。
        wcmd = [ff, "-v", "error", "-y",
                "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", "{}x{}".format(out_w, out_h),
                "-r", "{:.6f}".format(fps), "-i", "pipe:0"]
        if probe["has_audio"]:
            wcmd += ["-i", input_path,
                     "-map", "0:v:0", "-map", "1:a:0",
                     "-c:a", "aac", "-b:a", "192k", "-shortest"]
        else:
            wcmd += ["-an"]
        wcmd += venc + ["-pix_fmt", "yuv420p", "-movflags", "+faststart", output_path]
        writer = subprocess.Popen(wcmd, stdin=subprocess.PIPE)

        log("开始处理：{}x{} → {}x{} @{:.3f}fps，共 {} 帧，编码器 {}".format(
            w, h, out_w, out_h, fps, total or "?", enc_tag))

        frame_bytes = w * h * 3
        done = 0

        def _read_frame():
            raw = reader.stdout.read(frame_bytes)
            if raw is None or len(raw) < frame_bytes:
                return None
            return np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)

        def _emit(prev_f, curr_f, next_f):
            nonlocal done
            sr = self.process_frame(prev_f, curr_f, next_f, strength)
            writer.stdin.write(sr.tobytes())
            done += 1
            el = time.time() - t0
            speed = done / el if el > 0 else 0.0
            if progress_callback is not None:
                progress_callback(done, total, speed)
            # 每 10 帧（及首帧）向 stderr 输出一行进度 JSON，供上层解析。
            if done == 1 or done % 10 == 0:
                eta = (total - done) / speed if (total and speed > 0) else 0.0
                sys.stderr.write(json.dumps({
                    "frame": done, "total": total,
                    "fps": round(speed, 3), "eta_sec": round(eta, 1),
                }) + "\n")
                sys.stderr.flush()

        try:
            curr = _read_frame()
            if curr is None:
                raise RuntimeError("未能从输入视频读取到任何帧")
            prev = curr  # 首帧：prev = curr
            while True:
                nxt = _read_frame()
                if nxt is None:
                    _emit(prev, curr, curr)  # 末帧：next = curr
                    break
                _emit(prev, curr, nxt)
                prev, curr = curr, nxt
        finally:
            try:
                if reader.stdout:
                    reader.stdout.close()
            except Exception:  # noqa: BLE001
                pass
            reader.wait()
            try:
                if writer.stdin:
                    writer.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            writer.wait()

        if writer.returncode != 0:
            raise RuntimeError("ffmpeg 编码失败（退出码 {}）".format(writer.returncode))

        elapsed = time.time() - t0
        log("完成：{} 帧，用时 {:.2f}s（{:.2f} fps）".format(
            done, elapsed, done / elapsed if elapsed > 0 else 0.0))

        return {
            "output_path": os.path.abspath(output_path),
            "frames": done,
            "width": out_w,
            "height": out_h,
            "src_width": w,
            "src_height": h,
            "fps": fps,
            "duration": round(done / fps, 3) if fps > 0 else probe["duration"],
            "scale": self.scale,
            "provider": self.provider,
            "encoder": enc_tag,
            "has_audio": probe["has_audio"],
            "elapsed_sec": round(elapsed, 3),
        }
