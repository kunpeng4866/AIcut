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

# 仅当安装了 onnxruntime-gpu（开发者本地调试用）时，CUDA EP 才依赖 nvidia-* pip 包提供的
# CUDA/cuDNN DLL（cublasLt64_13.dll / cudnn64_9.dll 等）；ORT 不会自动把它们加入 PATH，
# 缺失时 CUDA EP 会报 "cublasLt64_13.dll which is missing" 而静默回退。这里在导入
# onnxruntime 前把对应 bin 目录注入 PATH。发布态装的是 onnxruntime-directml（无 nvidia 目录），
# 此函数找不到目录、自动 no-op，语句无害。
def _prepend_cuda_dll_path() -> None:
    # 用 glob 匹配 nvidia/*/bin 与 nvidia/*/bin/x86_64，兼容 cu13→cu14 等未来升级，
    # 避免硬编码 cu13 在 nvidia pip 包升版本后路径断裂、CUDA EP 静默回退 CPU。
    import glob as _glob

    sp = os.path.join(sys.prefix, "Lib", "site-packages")
    nvidia_root = os.path.join(sp, "nvidia")
    add: list = []
    if os.path.isdir(nvidia_root):
        for pat in (os.path.join(nvidia_root, "*", "bin"),
                    os.path.join(nvidia_root, "*", "bin", "x86_64")):
            for d in _glob.glob(pat):
                if os.path.isdir(d):
                    add.append(d)
    if add:
        os.environ["PATH"] = os.pathsep.join(add + [os.environ.get("PATH", "")])

_prepend_cuda_dll_path()

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "aicut", "models")
GITHUB_RELEASE_URL = "https://github.com/ZHKKKe/MODNet/releases/download/ONNX/modnet.onnx"
# 占位/镜像是同一权重；此处仅为可读标识。
MODEL_FILENAME = "modnet.onnx"

# P4：rmbg2 = BRIA RMBG-2.0（Apache-2.0，BiRefNet 架构，通用去背景）。
# hf-mirror.com 不代理 briaai/*（会 308 跳转到被沙箱 egress 拦截的 huggingface.co），
# 故 rmbg2 ONNX 经 ModelScope 国内镜像拉取（返回原始文件字节）。
# 使用 FP32 权重（rmbg2.onnx，约 976MB / BiRefNet ~230M 参数）：经实测本机
# onnxruntime CPU 对 BiRefNet 的 deformable conv 无 INT8 内核，动态 INT8 量化后
# 单帧 1024² 推理反而慢 ~11 倍（24s vs 2.2s），故默认 FP32 + 多线程
#（keying.rs 对 rmbg2 放开 OMP_NUM_THREADS）。推理峰值 ~12GB 内存，本机 32GB 充足。
RMBG2_MODEL_FILENAME = "rmbg2.onnx"
MODELSCOPE_RMBG2_URL = "https://modelscope.cn/api/v1/models/briaai/RMBG-2.0/repo?Revision=master&FilePath=onnx/model.onnx"


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


def _ensure_rmbg2_model(log) -> str | None:
    """返回 rmbg2 (BRIA RMBG-2.0) ONNX 路径；不可用则 None（调用方回退占位 matte）。

    使用 FP32 权重（rmbg2.onnx）：经实测，本机 onnxruntime CPU 对 BiRefNet 的
    deformable conv 无 INT8 内核，动态 INT8 量化后单帧 1024² 推理反而慢 ~11 倍
    （24s vs 2.2s），故默认用 FP32 + 多线程（keying.rs 对 rmbg2 放开 OMP_NUM_THREADS）。
    FP32 约 976MB、推理峰值 ~12GB 内存，本机 32GB 充足。

    优先级：
      1. 环境变量 AICUT_RMBG2_MODEL 指定本地路径（原样使用）；
      2. 本地 FP32（rmbg2.onnx）；
      3. ModelScope 镜像拉取 FP32（hf-mirror.com 不代理 briaai/*）。
    """
    env_path = os.environ.get("AICUT_RMBG2_MODEL")
    if env_path and os.path.isfile(env_path):
        log("使用环境变量指定的 rmbg2 模型: " + env_path)
        return env_path

    fp32_cache = os.path.join(CACHE_DIR, RMBG2_MODEL_FILENAME)
    if not (os.path.isfile(fp32_cache) and os.path.getsize(fp32_cache) > 1024):
        for url in [MODELSCOPE_RMBG2_URL]:
            try:
                log("尝试下载 rmbg2 模型: " + url)
                tmp = fp32_cache + ".part"
                req = urllib.request.Request(url, headers={"User-Agent": "aicut-keying"})
                with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
                    shutil.copyfileobj(resp, f)
                if os.path.getsize(tmp) > 1024:
                    os.replace(tmp, fp32_cache)
                    log("rmbg2 模型下载成功: " + fp32_cache)
                    break
                os.remove(tmp)
            except Exception as e:  # noqa: BLE001
                log("rmbg2 下载失败({})：{}".format(url, e))

    if os.path.isfile(fp32_cache) and os.path.getsize(fp32_cache) > 1024:
        log("使用 rmbg2 FP32 模型: " + fp32_cache)
        return fp32_cache

    log("rmbg2 模型不可用，回退 numpy 占位 matte")
    return None


def _report_progress(d: dict) -> None:
    """把进度字典以**纯 JSON 行**写入 stderr，供上层（Rust/Electron）解析并推送前端。

    注意：必须是无前缀的纯 JSON 行，区别于 `[core]` 前缀的普通日志行；
    Rust 侧（keying.rs）据此把进度行以 `KEYPROG:` 前缀转发。
    字段约定：stage(load/infer/done) / frame / total / fps / eta_sec / model。
    """
    try:
        sys.stderr.write(json.dumps(d, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


# ───────────────────────── 推理器 ─────────────────────────

class _Predictor:
    """封装「真实模型（MODNet / RMBG-2.0）」或「numpy 占位」预测路径。

    model_kind:
      - 'modnet'：最长边缩到 512 再对齐 32 倍数（5 级编码器要求），输出已归一化；
      - 'rmbg2' (BRIA RMBG-2.0, BiRefNet)：方图 1024x1024 推理，ImageNet 归一化，
        官方 ONNX 已含 sigmoid，输出已归一化到 [0,1]。
    两者均输出 HxW float32 matte ∈ [0,1]（0=背景, 255=前景 约定见文件头）。
    """

    def __init__(self, model_path: str | None, log, model_kind: str = "modnet", infer_size: int = 0):
        self.log = log
        self.model_kind = model_kind if model_kind in ("modnet", "rmbg2") else "modnet"
        self.use_real = False
        self.session = None
        self.input_name = None
        self.mean = [0.485, 0.456, 0.406]
        self.std = [0.229, 0.224, 0.225]
        # 推理输入尺寸：rmbg2 固定 1024 方图（BiRefNet 设计为 1024，512 下 deformable
        # conv/ASPP 对齐会崩；1024 经多线程 CPU 推理 45 帧≈2min，实用；modnet 动态）。
        # modnet 默认提到 768（更长边），保留更多发丝/边缘细节；infer_size 可被 opts 覆盖。
        if infer_size and infer_size >= 64:
            self.infer_size = infer_size
        else:
            self.infer_size = 1024 if self.model_kind == "rmbg2" else 768
        if model_path:
            try:
                import onnxruntime as ort  # type: ignore
                import numpy as np  # type: ignore
                # 抑制 onnxruntime 内部告警（如动态 shape 的 buffer 复用 shape-mismatch 告警）：
                # 这些告警刷屏 stderr，会淹没进度 JSON 行、干扰上层（Rust/Electron）的进度解析。
                ort.set_default_logger_severity(3)
                self.np = np
                so = ort.SessionOptions()
                # MODNet 轻量，单线程避免与其他进程争核；BiRefNet(RMBG-2.0) 极重，
                # 必须放开多线程，否则单帧推理数十秒、整条 matte 生成十几分钟不可用。
                if self.model_kind != "rmbg2":
                    so.intra_op_num_threads = 1
                    so.inter_op_num_threads = 1
                # 推理 provider 兜底链 CUDA → DML → CPU，逐个 EP 独立尝试，任一初始化失败不影响其他。
                # 发布态默认装 onnxruntime-directml：DML 走系统 DX12，对 NVIDIA/AMD/Intel 全显卡加速
                #（本机 RTX 5060 Ti 实测 DML ~0.58s/帧 vs CPU 5.9s/帧 ≈ 10×）。开发者本地若另装
                # onnxruntime-gpu，则 CUDA EP 优先（最快）；二者实际可用 EP 取决于装的是哪个包。最后 CPU 兜底。
                # 注：onnxruntime-gpu 不含 DmlExecutionProvider，onnxruntime-directml 不含
                # CUDAExecutionProvider，故本兜底链自动只挑当前安装包支持的 EP。
                _avail = ort.get_available_providers()
                self.session = None
                ep_tag = None
                for ep in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"):
                    if ep not in _avail:
                        continue
                    try:
                        _sess = ort.InferenceSession(model_path, so, providers=[ep])
                        if ep in _sess.get_providers():
                            self.session = _sess
                            ep_tag = ep
                            break
                    except Exception as _e:  # noqa: BLE001
                        log("  EP[{}] 初始化失败({})，尝试下一个".format(ep, _e))
                        continue
                if self.session is not None:
                    self.input_name = self.session.get_inputs()[0].name
                    self.use_real = True
                    log("{} ONNX 加载成功，使用真实模型推理（EP: {}）".format(self.model_kind, ep_tag))
                else:
                    raise RuntimeError("所有可用 EP 均初始化失败")
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
            if self.model_kind == "rmbg2":
                # RMBG-2.0 / BiRefNet 设计为 1024 方图（拉伸）推理，输出再缩回原尺寸。
                img_r = img.resize((self.infer_size, self.infer_size), Image.BILINEAR)
            else:
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
            m = out[0, 0].astype(np.float32)
            # BRIA RMBG-2.0 官方 ONNX 已含 sigmoid，输出已归一化到 [0,1]；
            # 个别导出可能为 logits，这里自适应：超出 [0,1] 范围则施加 sigmoid。
            if m.max() > 1.0 + 1e-3 or m.min() < -1e-3:
                m = 1.0 / (1.0 + np.exp(-np.clip(m, -20.0, 20.0)))
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


# ───────────────────────── 软 matte 精修 ─────────────────────────
# 目标：把 MODNet / RMBG-2.0 输出的「已有软 alpha」进一步做成剪映级别的
#       软边 / 发丝 / 半透明过渡——而不是被下游窄带阈值压成硬切。
#
# 1) 导向滤波(guided filter)：以「原帧亮度」为引导、matte 为待滤波信号，
#    在保持物体边界（贴合原图高频结构、不发虚）的同时，把半透明过渡区的
#    alpha 做成空间平滑的渐变（而非噪声/阶梯）。这是软边 + 色彩正确发丝
#    的关键——过渡像素的 alpha 介于 0~1，合成时自然透出背景，形成半透明 fringe。
# 2) 时序高斯平滑：MODNet/RMBG-2.0 为逐帧独立推理，半透明区易逐帧抖动（闪烁）。
#    用居中高斯窗跨帧平均，消除闪烁、保证视频时序一致（剪映智能抠像亦有此步）。

def _guided_filter(I, p, r, eps):
    """单通道导向滤波：I 引导(0..1)，p 待滤波(0..1)，返回 q(0..1)。

    用 scipy.ndimage.uniform_filter 实现 O(N) box filter（等价均值滤波），
    避免手写积分图。r 为半径（窗口 2r+1）；eps 为正则（防止平坦区除零/过冲）。
    """
    from scipy.ndimage import uniform_filter  # type: ignore

    win = 2 * r + 1
    mean_I = uniform_filter(I, size=win)
    mean_p = uniform_filter(p, size=win)
    mean_Ip = uniform_filter(I * p, size=win)
    mean_II = uniform_filter(I * I, size=win)
    var_I = mean_II - mean_I * mean_I
    cov_Ip = mean_Ip - mean_I * mean_p
    a = cov_Ip / (var_I + eps)
    b = mean_p - a * mean_I
    mean_a = uniform_filter(a, size=win)
    mean_b = uniform_filter(b, size=win)
    q = mean_a * I + mean_b
    return q


def _refine_alpha(rgb, matte, min_side):
    """对软 matte 做导向滤波精修，返回精修后 matte(0..1)。

    r 随分辨率自适应（约 1.2% 短边，限 [6, 40]）；eps 取 1e-3（弱正则，保留细节）。
    """
    np = _np_for_refine
    I = (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]).astype(np.float32) / 255.0
    r = int(max(6, min(40, round(min_side * 0.012))))
    q = _guided_filter(I, matte.astype(np.float32), r, 1e-3)
    return np.clip(q, 0.0, 1.0)


_np_for_refine = None  # 在 generate_matte 内赋值，避免在模块顶层强制 import numpy


def _gauss_weights(window, center):
    import math
    sigma = max(1e-3, window / 3.0)  # 窗宽约覆盖 ±3σ
    w = []
    s = 0.0
    for k in range(window):
        d = k - center
        val = math.exp(-(d * d) / (2.0 * sigma * sigma))
        w.append(val)
        s += val
    return [x / s for x in w]


# ───────────────────────── 主入口 ─────────────────────────

def generate_matte(input_path: str, opts: dict) -> dict:
    t0 = time.time()
    log_lines = []

    def log(msg: str):
        log_lines.append(msg)
        sys.stderr.write("[core] " + msg + "\n")
        sys.stderr.flush()

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

    # P4：按 opts['model'] 选择智能模型（modnet 默认 / rmbg2 = BRIA RMBG-2.0）。
    model_kind = opts.get("model") or "modnet"
    if model_kind not in ("modnet", "rmbg2"):
        model_kind = "modnet"
    if model_kind == "rmbg2":
        model_path = _ensure_rmbg2_model(log)
    else:
        model_path = _ensure_model(log)
    # 软 matte 精修开关（默认开）：导向滤波保留软边/发丝；时序平滑消闪烁。
    refine = bool(opts.get("refine", True))
    temporal = bool(opts.get("temporal", True))
    infer_size = int(opts.get("infer_size", 0) or 0)
    # 总帧数（duration 缺失时为 0，前端据此显示「不确定进度」）
    total_frames = int(round(probe["duration"] * fps)) if probe["duration"] > 0 else 0
    _report_progress({"stage": "load", "model": model_kind, "total": total_frames,
                      "use_real": bool(model_path)})
    predictor = _Predictor(model_path, log, model_kind, infer_size)

    ff = _ffmpeg_exe()
    reader = subprocess.Popen(
        [ff, "-v", "error", "-i", input_path,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    # 无损编码(-crf 0)：matte 是 alpha 遮罩，8-bit 有损 x264(crf≈23) 会量化出 banding、
    # 抹平软过渡梯度。改无损后保留完整软 alpha 梯度（下游导出/预览才能呈现半透明边缘）。
    writer = subprocess.Popen(
        [ff, "-v", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", "{}x{}".format(w, h), "-r", "{:.4f}".format(fps), "-i", "pipe:0",
         "-an", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "gray", output_path],
        stdin=subprocess.PIPE,
    )

    np = predictor.np
    global _np_for_refine
    _np_for_refine = np
    frame_bytes = w * h * 3
    min_side = min(w, h)

    # 时序平滑：居中高斯窗跨帧平均（窗口 5、延迟 2），消除逐帧抖动；
    # 流式处理用定长 ring buffer，结尾补齐尾帧，避免方向性拖影。
    from collections import deque  # noqa: E402
    W = 5 if temporal else 1
    delay = W // 2
    ring = deque(maxlen=W)

    def _emit_at(cpos: int, L: int):
        # 在长度为 L 的 ring 上，以 cpos 为中心的高斯加权（居中时序平滑）。
        if L <= 0:
            return None
        cpos = max(0, min(L - 1, cpos))
        wse = _gauss_weights(L, cpos)
        acc = None
        for k in range(L):
            f = ring[k]
            acc = f * wse[k] if acc is None else acc + f * wse[k]
        return np.clip(acc, 0.0, 1.0)

    read_n = 0
    written = 0
    infer_t0 = time.time()
    try:
        while True:
            raw = reader.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            matte = predictor.predict_frame(rgb)  # HxW float32 [0,1]，已是软 alpha
            if refine:
                matte = _refine_alpha(rgb, matte, min_side)
            ring.append(matte)
            read_n += 1
            # 进度上报：每 5 帧（或首帧）写一行纯 JSON 进度到 stderr
            if read_n == 1 or read_n % 5 == 0:
                el = time.time() - infer_t0
                fps_i = read_n / el if el > 0 else 0.0
                remain = max(0, total_frames - read_n) if total_frames > 0 else 0
                eta = remain / fps_i if fps_i > 0 else 0.0
                _report_progress({"stage": "infer", "frame": read_n, "total": total_frames,
                                  "fps": round(fps_i, 2), "eta_sec": round(eta, 1)})
            L = len(ring)
            if L >= 1 and read_n > delay:
                # 输出「延迟 delay 帧之前」的那一帧（居中窗中心）
                out = _emit_at(L - 1 - delay, L)
                if out is not None:
                    gray = (np.clip(out, 0.0, 1.0) * 255.0).astype(np.uint8)
                    writer.stdin.write(gray.tobytes())
                    written += 1
    finally:
        # 补齐尾帧：输出尚未 emit 的最后 delay 帧（ring 末尾 delay 个位置居中窗）。
        L = len(ring)
        for extra in range(delay):
            out = _emit_at(L - delay + extra, L)
            if out is not None:
                gray = (np.clip(out, 0.0, 1.0) * 255.0).astype(np.uint8)
                writer.stdin.write(gray.tobytes())
                written += 1
        reader.stdout.close()
        reader.wait()
        if writer.stdin:
            writer.stdin.close()
        writer.wait()

    frame_count = written

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
        "model": model_kind if predictor.use_real else "placeholder",
        "mode": "matte",
    }


# ───────────────────────── 手动抠像（manual）─────────────────────────
# 新增依赖（不与上方智能抠像共用，避免改动 generate_matte 及其以上内容）。
import base64  # noqa: E402
import io  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageFilter  # noqa: E402


def generate_manual_matte(input_path: str, opts: dict) -> dict:
    """手动抠像（逐帧 refine）：依前端涂抹引导图数组（guides）逐帧烘焙灰度 matte 视频。

    opts 约定：
      - guides: 引导图数组，元素为 ``{"frame": <int 0-based 源帧号>, "dataUrl": "data:..."}``。
            每个 dataUrl 解析为 RGBA 画布：前景涂抹 = 不透明白 (255,255,255,255)；
            背景涂抹 = 不透明黑 (0,0,0,255)；未涂抹 = A=0（透明）。
      - guide（向后兼容）: 若未提供 guides（或为空），则把单张 guide 视为
            ``guides=[{frame:0, dataUrl: guide}]``，即整段使用同一张引导图（旧行为）。
      - smartMattePath（可选）: 已存在灰度 matte mp4 绝对路径；读取其**全部**帧作逐帧 base。
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

    N = max(1, int(round(probe["duration"] * fps)))

    # ── 解析 guides（逐帧引导图数组）──
    def _parse_guide_dataurl(du: str) -> np.ndarray:
        if not isinstance(du, str) or not du.startswith("data:"):
            raise ValueError("guide data URL 必须是 data:image/png;base64,... 形式")
        try:
            header, b64 = du.split(",", 1)
        except ValueError:
            raise ValueError("guide data URL 缺少 ',' 分隔符")
        if ";base64" not in header:
            raise ValueError("guide data URL 必须为 base64 编码")
        raw = base64.b64decode(b64)
        return np.array(Image.open(io.BytesIO(raw)).convert("RGBA"))

    guides_raw = opts.get("guides")
    guide_list = []  # list of (frame_idx, rgba_np)，按 frame 升序
    if isinstance(guides_raw, list) and len(guides_raw) > 0:
        for item in guides_raw:
            if not isinstance(item, dict):
                continue
            fr = int(item.get("frame", 0))
            du = item.get("dataUrl") or item.get("guide") or item.get("data_url")
            if not isinstance(du, str) or not du.startswith("data:"):
                continue
            ga = _parse_guide_dataurl(du)
            guide_list.append((fr, ga))
    else:
        # 向后兼容：单 guide（整段同一张引导图，frame=0）
        guide = opts.get("guide")
        if isinstance(guide, str) and guide.startswith("data:"):
            ga = _parse_guide_dataurl(guide)
            guide_list.append((0, ga))

    if not guide_list:
        raise ValueError("缺少 guide：manual 模式需要至少一张引导图")

    guide_list.sort(key=lambda x: x[0])

    # 约定所有 guide 同尺寸（画布），取首张分辨率作为 guide 分辨率。
    _, first_ga = guide_list[0]
    gh, gw = first_ga.shape[:2]

    # ── 羽化参数（依赖 guide 分辨率，逐 guide 预算 fg_f/bg_f）──
    softness = float(opts.get("softness", 0.1))
    radius = max(0.5, softness * min(gw, gh) * 0.05)

    def _feather(mask_bool: np.ndarray) -> np.ndarray:
        m = mask_bool.astype(np.float32)
        return np.asarray(
            Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)),
            dtype=np.float32,
        ) / 255.0

    guide_fg = []
    guide_bg = []
    for _, ga in guide_list:
        A = ga[:, :, 3].astype(np.float32)
        R = ga[:, :, 0].astype(np.float32)
        fg_mask = (A > 32) & (R > 127)
        bg_mask = (A > 32) & (R <= 127)
        guide_fg.append(_feather(fg_mask))
        guide_bg.append(_feather(bg_mask))

    # ── 逐帧 base：读取 smart matte 全部帧（缩放到 guide 分辨率）或全 0 ──
    sw = sh = 0
    smart_frames = None  # (Nframes, sh, sw) float32/255
    smart_path = opts.get("smartMattePath")
    ff = _ffmpeg_exe()
    if smart_path and os.path.isfile(smart_path) and os.path.getsize(smart_path) > 0:
        try:
            sp = _ffprobe(smart_path)
            sw, sh = sp["width"], sp["height"]
            if sw > 0 and sh > 0:
                p = subprocess.run(
                    [ff, "-v", "error", "-i", smart_path,
                     "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                need_frame = sw * sh
                if p.returncode == 0 and len(p.stdout) >= need_frame:
                    all_bytes = np.frombuffer(p.stdout, dtype=np.uint8)
                    n_frames = len(all_bytes) // need_frame
                    smart_frames = all_bytes[: n_frames * need_frame].reshape(n_frames, sh, sw).astype(np.float32) / 255.0
                    log("已读取 smart matte 全 {} 帧作为逐帧 base（{}x{}）".format(n_frames, sw, sh))
                else:
                    log("smart matte 读取失败，回退全 0 base")
            else:
                log("smart matte 尺寸无效，回退全 0 base")
        except Exception as e:  # noqa: BLE001
            log("smart matte 读取异常({})，回退全 0 base".format(e))

    def _base_for_frame(i: int) -> np.ndarray:
        if smart_frames is None:
            return np.zeros((gh, gw), dtype=np.float32)
        idx = i if i < smart_frames.shape[0] else smart_frames.shape[0] - 1
        frame = smart_frames[idx]
        if (sw, sh) != (gw, gh):
            frame = np.asarray(
                Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8)).resize((gw, gh), Image.BILINEAR),
                dtype=np.float32,
            ) / 255.0
        return frame

    # ── 选 guide：最近邻（|frame - i| 最小；并列取较小 frame）──
    def _select_guide_idx(i: int) -> int:
        best = 0
        best_dist = None
        for k, (fr, _) in enumerate(guide_list):
            d = abs(fr - i)
            if best_dist is None or d < best_dist or (d == best_dist and fr < guide_list[best][0]):
                best_dist = d
                best = k
        return best

    # ── 输出路径 ──
    output_path = opts.get("output") or ""
    if not output_path:
        stem, ext = os.path.splitext(input_path)
        output_path = stem + "_matte.mp4"
    out_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(out_dir, exist_ok=True)

    # ── 用 ffmpeg rawvideo 管道逐帧写 N 张「各不相同」的灰度帧 ──
    writer = subprocess.Popen(
        [ff, "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", "{}x{}".format(w, h), "-r", "{:.4f}".format(fps), "-i", "pipe:0",
         "-an", "-c:v", "libx264", "-pix_fmt", "gray", output_path],
        stdin=subprocess.PIPE,
    )
    _report_progress({"stage": "load", "model": "manual", "total": N})
    manual_t0 = time.time()
    try:
        for i in range(N):
            base_i = _base_for_frame(i)
            gi = _select_guide_idx(i)
            fg_f = guide_fg[gi]
            bg_f = guide_bg[gi]
            alpha = base_i * (1.0 - fg_f - bg_f) + fg_f
            alpha = np.clip(alpha, 0.0, 1.0)
            # 缩回源尺寸 (w,h) → alpha_full（float32 0..1）
            alpha_full = np.asarray(
                Image.fromarray((np.clip(alpha, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR),
                dtype=np.float32,
            ) / 255.0
            gray = (np.clip(alpha_full, 0, 1) * 255).astype(np.uint8)
            writer.stdin.write(gray.tobytes())
            if (i + 1) == 1 or (i + 1) % 5 == 0:
                el = time.time() - manual_t0
                fps_i = (i + 1) / el if el > 0 else 0.0
                remain = max(0, N - (i + 1))
                eta = remain / fps_i if fps_i > 0 else 0.0
                _report_progress({"stage": "infer", "frame": i + 1, "total": N,
                                  "fps": round(fps_i, 2), "eta_sec": round(eta, 1)})
    finally:
        if writer.stdin:
            writer.stdin.close()
        writer.wait()

    if writer.returncode != 0:
        raise RuntimeError("ffmpeg 编码 manual matte 失败(退出码 {})".format(writer.returncode))

    elapsed = time.time() - t0
    log("完成 manual matte（逐帧）：{}x{} {} 帧，用时 {:.2f}s".format(w, h, N, elapsed))

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
