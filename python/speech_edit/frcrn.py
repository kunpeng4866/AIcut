# -*- coding: utf-8 -*-
r"""FRCRN_SE_16K 高质量降噪（ONNX 推理，波形进波形出）。

## 采用模型（调研选型结论）
  - 模型：FRCRN_SE_16K 的 ONNX 导出，来自 ClearerVoice-Studio（阿里巴巴 DAMO 研究院）
  - 权重仓库：TigreGotico/audiosronnx-frcrn
  - 来源 URL：https://huggingface.co/TigreGotico/audiosronnx-frcrn
              其上游为 https://github.com/alibaba-damo-academy/ClearerVoice-Studio
  - 许可：Apache-2.0（继承自 ClearerVoice-Studio，商用安全）
  - 本地产物：python/models/denoise/frcrn_se16k.onnx（约 57.5 MB，由 HF 镜像下载，不入库）
  - 业界定位：FRCRN（Frequency Recurrent CRN）在 2022 DNS Challenge 获第 2 名，
              VoiceBank+DEMAND 上报 PESQ 3.23 / STOI 0.95 / SI-SDR 19.22，质量高于
              轻量谱减与 DFN3 单图基线，作为「高质量档」接入。

## ONNX 接口（实测确认）
  - 输入：noisy[1, T] float32，16 kHz，[-1,1]（与下游 analyze 的 16k 单声道一致）
  - 输出：enhanced[1, T] float32（同采样率）
  - STFT/ISTFT 已烘焙进图（ConvSTFT / ConviSTFT 为 Conv1d Fourier 核），
    无需外部频谱前后处理，整段作为静态图导出，onnxruntime 直接推理。

## 样本级零平移（下游词级时间戳硬要求）
  - 实测：注入单位脉冲，输出脉冲峰值与输入位置 lag=0（5000/11000/14000/30000 等
    多位置验证通过）；纯正弦被模型当作「非语音」压低导致互相关偏移属正常抑制现象，
    不作为对齐判据。
  - 对齐约束：当 T 为 160 的倍数时输出与输入严格等长；否则输出截断到 160 的倍数。
    本模块通过「末尾补零到 160 的倍数 → 推理 → 裁回原长」对任意输入都返回与输入
    **样本级等长**的波形（与 dfn3 的零平移思路一致，由本函数末尾的裁剪/补零兜底）。

## 接口约定（对齐 speech_edit/dfn3.py 的 enhance）
  - session_factory: (model_path) -> (session, ep)，由 core._onnx_session 注入，
    复用同一条 CUDA→DML→CPU provider 兜底链（见 core.py:261）。
"""

from __future__ import annotations

import os
import sys

import numpy as np

__all__ = ["enhance", "_has_frcrn_weights"]

SR_MODEL = 16000          # FRCRN_SE_16K 固定 16 kHz
ALIGN = 160               # 输出长度需为 160 的倍数（帧/跳距对齐）
DEFAULT_ONNX = "frcrn_se16k.onnx"

# 会话缓存：model_path -> (session, ep)，避免每次降噪重复建图
_SESS_CACHE = {}

# core 的 provider 兜底链（先相对后绝对兜底，因 core 以顶层模块被 import）
try:
    from core import (_onnx_session as _core_onnx_session,
                      _prepend_cuda_dll_path as _core_prepend)
except ImportError:
    try:
        from .core import (_onnx_session as _core_onnx_session,
                           _prepend_cuda_dll_path as _core_prepend)
    except ImportError:
        _core_onnx_session = None
        _core_prepend = None


def _has_frcrn_weights(model_dir: str) -> bool:
    """DENOISE_MODEL_DIR 下是否存在 FRCRN 权重（frcrn_se16k.onnx）。"""
    if not model_dir or not os.path.isdir(model_dir):
        return False
    p = os.path.join(model_dir, DEFAULT_ONNX)
    return os.path.isfile(p) and os.path.getsize(p) > 0


def _cpu_session(model_path):
    """FRCRN 图的 ConvSTFT(stride 320) 在 CUDA EP 上触发 cuDNN frontend 失败，
    CPU EP 稳定可用（离线高质量批处理，CPU 可接受）。直接建 CPU session。

    注意：onnxruntime-gpu 即使只建 CPU session，也需在 PATH 上能找到 nvidia
    CUDA DLL（cublas/cudnn 等），否则连 CPU session 都建不出来。实测**保留**
    nvidia 目录时 `InferenceSession(providers=["CPUExecutionProvider"])` 可用，
    故这里**不**隔离 PATH，仅显式只请求 CPU EP，避免误触 CUDA 建图失败。
    """
    try:
        import onnxruntime as ort
        ort.set_default_logger_severity(3)
        s = ort.InferenceSession(model_path, ort.SessionOptions(),
                                  providers=["CPUExecutionProvider"])
        return s, "CPUExecutionProvider"
    except Exception as e:
        sys.stderr.write(f"[frcrn] CPU session 创建失败({e})\n")
        return None, None


def _load_session(model_dir, session_factory):
    """取得 (session, ep)。FRCRN 图 CUDA 不兼容 → **优先 CPU EP**（稳定路径）；
    其次注入的 session_factory / 内部兜底链作为冗余兜底。返回 None 表示不可用。"""
    path = os.path.join(model_dir, DEFAULT_ONNX)
    if path in _SESS_CACHE:
        return _SESS_CACHE[path]
    sess, ep = None, None
    # 1) 优先 CPU EP（FRCRN 图在 CUDA 上 cuDNN frontend 失败，CPU 稳定）
    sess, ep = _cpu_session(path)
    # 2) 冗余兜底：调用方注入的 factory（= core._onnx_session）
    if sess is None and session_factory is not None:
        try:
            sess, ep = session_factory(path)
        except Exception as e:
            sys.stderr.write(f"[frcrn] session_factory 失败({e})，走兜底\n")
            sess, ep = None, None
    # 3) core 顶层模块自带工厂
    if sess is None and _core_onnx_session is not None:
        try:
            sess, ep = _core_onnx_session(path)
        except Exception:
            sess, ep = None, None
    # 4) frcrn 内部等价兜底（CUDA→DML→CPU 逐 EP 独立尝试）
    if sess is None:
        sess, ep = _fallback_session(path)
    if sess is None:
        return None
    _SESS_CACHE[path] = (sess, ep)
    return sess, ep


def _fallback_session(model_path):
    """等价于 core._onnx_session 的 CUDA→DML→CPU 兜底链（避免只依赖 core 注入）。"""
    try:
        if _core_prepend is not None:
            try:
                _core_prepend()
            except Exception:
                pass
        else:
            _prepend_cuda_dll_path_local()
        import onnxruntime as ort
        ort.set_default_logger_severity(3)
        so = ort.SessionOptions()
        avail = ort.get_available_providers()
        for ep in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"):
            if ep not in avail:
                continue
            try:
                s = ort.InferenceSession(model_path, so, providers=[ep])
                if ep in s.get_providers():
                    return s, ep
            except Exception as e:
                sys.stderr.write(f"[frcrn] EP[{ep}] 初始化失败({e})，尝试下一个\n")
                continue
    except Exception as e:
        sys.stderr.write(f"[frcrn] onnxruntime 不可用({e})\n")
    return None, None


def _prepend_cuda_dll_path_local() -> None:
    """nvidia/*/bin 注入 PATH（与 core._prepend_cuda_dll_path 同款），
    仅当无法复用 core 时启用，保证 onnxruntime-gpu 能加载 CUDA DLL。"""
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


def _resample_to(x: np.ndarray, n_out: int) -> np.ndarray:
    """把波形重采样到**精确** n_out 个样本（优先 scipy FFT 重采样，否则线性插值兜底）。"""
    n_out = int(round(n_out))
    if n_out == x.size:
        return x.astype(np.float32)
    try:
        from scipy.signal import resample as _resample
        y = _resample(x.astype(np.float64), n_out)
        return np.asarray(y, dtype=np.float32)
    except Exception:
        t_in = np.arange(x.size) / max(x.size, 1)
        t_out = np.linspace(0.0, 1.0, n_out, endpoint=False)
        return np.interp(t_out, t_in, x.astype(np.float64)).astype(np.float32)


def enhance(au: np.ndarray, sr: int, model_dir: str, session_factory=None,
            **_kwargs) -> np.ndarray | None:
    """对单声道波形做 FRCRN_SE_16K 高质量降噪。

    返回与输入样本级等长的 float32（[-1,1]），或 None（权重缺失/推理失败 → 调用方降级）。

    参数
      au              : float32 [-1,1] 单声道波形
      sr              : 输入采样率（非 16k 自动重采样到 16k 后推理，再重采样回原率）
      model_dir       : 含 frcrn_se16k.onnx 的目录
      session_factory : (model_path) -> (session, ep)，由 core._onnx_session 注入
    """
    x = np.asarray(au, dtype=np.float32).reshape(-1)
    n_in = int(x.size)
    if n_in == 0:
        return None
    if not _has_frcrn_weights(model_dir):
        return None

    loaded = _load_session(model_dir, session_factory)
    if loaded is None:
        return None
    sess, ep = loaded
    iname = sess.get_inputs()[0].name

    # ── 重采样到 16k（analyze 路径通常已是 16k，此步 no-op）──
    if sr == SR_MODEL:
        x16 = x
        n16 = n_in
    else:
        n16 = int(round(n_in * SR_MODEL / float(sr)))
        if n16 == 0:
            return None
        x16 = _resample_to(x, n16)

    # ── 末尾补零到 160 的倍数，保证输出与输入样本级等长（零平移）──
    pad = (-n16) % ALIGN
    xp = np.concatenate([x16, np.zeros(pad, dtype=np.float32)]) if pad else x16

    try:
        out = sess.run(None, {iname: xp[None, :]})[0]
    except Exception as e:
        sys.stderr.write(f"[frcrn] 推理失败({e})，回退\n")
        return None

    # 取回与 16k 输入等长的前缀（去除补零段）
    y16 = np.asarray(out, dtype=np.float32).reshape(-1)[:n16]

    # ── 重采样回原始采样率，并保证与原始样本数严格相等 ──
    if sr == SR_MODEL:
        y = y16
    else:
        y = _resample_to(y16, n_in)
    if y.size != n_in:
        if y.size > n_in:
            y = y[:n_in]
        else:
            y = np.concatenate([y, np.zeros(n_in - y.size, dtype=np.float32)])

    if not np.isfinite(y).all():
        sys.stderr.write("[frcrn] 输出含 NaN/Inf，回退\n")
        return None

    sys.stderr.write(f"[frcrn] FRCRN 降噪完成（{n16} 样本 @ {ep}）\n")
    return np.clip(y, -1.0, 1.0).astype(np.float32)
