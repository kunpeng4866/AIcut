# -*- coding: utf-8 -*-
r"""
Vendor-adapted from E:\demand-miner\poc\w1_clean.py (demand-miner W1 口播剪辑).
Original (c) demand-miner. Adapted for AIcut: analysis-only, returns edit plan as
JSON; media generation handled by Rust/ffmpeg.

This module vendors the pure "decision layer" of the W1 speech auto-editing
prototype. Given a media file + options it returns an EDIT PLAN describing which
time segments to KEEP (and the per-region deletion details). It does NOT render,
produce, or write any output media file — all audio/video file generation is the
responsibility of the Rust/ffmpeg engine that consumes this plan.

The audio DSP helpers (deess / normalize_lufs / smart_assemble / _crossfade / ...)
are retained in this file for completeness and reference, but `analyze()` never
calls them.
"""
from __future__ import annotations

import os
import sys
import json
import shutil
import tempfile
import subprocess
import wave
import argparse
import itertools

import numpy as np

# ② 副语言事件检测（PANNs 帧级 SED + Respiro 呼吸专项）。
# 权重缺失/依赖未装 → 优雅降级为 no-op（_PANNS_OK=False），不阻断分析。
try:
    from panns_sed import panns_sed as _panns_sed, panns_available as _panns_available
    from respiro import detect_respiro_breath as _detect_respiro
    from stutter import detect_stutter as _detect_stutter
    _PANNS_OK = True
except Exception:  # pragma: no cover
    _PANNS_OK = False
    _panns_sed = None
    _detect_respiro = None
    _detect_stutter = None


# ── 常量 ──────────────────────────────────────────────
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

FILLERS = {
    "嗯", "嗯嗯", "啊", "啊啊", "呃", "呃呃", "那个", "那个那个", "这个", "这这",
    "然后", "然后呢", "就是", "就是说", "其实", "可能", "对吧", "对不对", "的话",
    "怎么说", "那种", "这种", "一样", "之类的", "那么", "这样子", "是吧",
    "你知道吧", "怎么说呢", "恩", "额", "哎", "哟", "哇", "嘛",
    "um", "uh", "er", "like", "you know", "so", "basically", "right", "okay", "i mean",
}
_SINGLE_FILLER = {
    "嗯", "啊", "呃", "恩", "额", "哎", "哟", "哇", "诶", "噢", "喔",
    "嘶", "咦", "啧", "呸", "嗐", "呦", "嘅", "唔", "咝",
    "um", "uh", "er", "ah", "mm",
}
_PUNCT = "，。！？、；：\"'（）()【】[]{}…—·,.;:!?\"' \n\t"


# ══════════════════════════════════════════════════════
# 工具函数
# ══════════════════════════════════════════════════════

def _run_ffmpeg(args: list) -> None:
    """ffmpeg 调用。Windows 下避免 GBK 编码问题，stderr 用 replace 容错。"""
    p = subprocess.run([FFMPEG, "-y", *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0:
        msg = p.stderr[-600:] if p.stderr else "(no stderr)"
        raise RuntimeError(f"ffmpeg failed({p.returncode}): {msg}")


def _union(ivs: list) -> list:
    if not ivs:
        return []
    s = sorted((float(a), float(b)) for a, b in ivs)
    m = [list(s[0])]
    for a, b in s[1:]:
        if a <= m[-1][1]:
            m[-1][1] = max(m[-1][1], b)
        else:
            m.append([a, b])
    return [(a, b) for a, b in m]


def _subtract(s: float, e: float, ivs: list) -> list:
    """从单个区间 [s,e] 中减去 ivs（已 union 的保护区），返回剩余子区间列表。"""
    out = []
    cur = float(s)
    for ps, pe in ivs:
        if pe <= cur or ps >= e:
            continue
        if ps - cur > 1e-6:
            out.append((cur, ps))
        cur = max(cur, pe)
        if cur >= e:
            break
    if e - cur > 1e-6:
        out.append((cur, e))
    return out


def _overlap_len(s: float, e: float, ivs: list) -> float:
    """[s,e] 与 ivs（已 union）的总重叠时长。"""
    tot = 0.0
    for ps, pe in ivs:
        lo, hi = max(s, ps), min(e, pe)
        if hi > lo:
            tot += hi - lo
    return tot


def _apply_word_safety(events: list, word_ivs: list,
                       keep_ratio: float = 0.5, min_piece: float = 0.03) -> list:
    """声音事件安全阀（P0-C 放宽版）。

    旧逻辑（方案 A 保守回退）：事件只要与词区间(含 word_pad)有**任何**重叠就
    **整段丢弃不删** → 句中咳嗽/提示音被 whisper 词区间覆盖到一点点即永不删除，
    用户感知「完全没反应」。

    新逻辑：
      - 重叠比例 >= keep_ratio（默认 0.5）：认定事件主体就是朗读语音（连续元音），
        **整段不删**——保留旧行为的回归保护，避免切碎连续朗读；
      - 重叠比例 < keep_ratio：只保留被词区间覆盖的中心段，**词区间之外的部分仍可删**，
        即允许把删除边界推到词边界（min_piece 以下的碎屑不切，避免产生咔哒）。
    """
    out = []
    for s, e in events:
        dur = e - s
        if dur <= 0:
            continue
        ov = _overlap_len(s, e, word_ivs)
        if dur > 0 and (ov / dur) >= keep_ratio:
            continue  # 回归保护：主体是词 → 整段不删
        for ps, pe in _subtract(s, e, word_ivs):
            if pe - ps >= min_piece:
                out.append((ps, pe))
    return _union(out)


def _complement(remove: list, dur: float, min_keep: float = 0.15) -> list:
    """返回 [0, dur] 中未被 remove 覆盖的保留区间（已合并、升序、非重叠）。"""
    keep = []
    cur = 0.0
    for s, e in _union(remove):
        if e <= cur:
            continue
        if s - cur >= min_keep:
            keep.append((cur, s))
        cur = max(cur, e)
    if dur - cur >= min_keep:
        keep.append((cur, dur))
    return keep


def _read_wav(path: str) -> tuple:
    wf = wave.open(path, "rb")
    sr = wf.getframerate()
    n = wf.getnframes()
    au = np.frombuffer(wf.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    wf.close()
    return au, sr


def _write_wav(path: str, audio: np.ndarray, sr: int) -> None:
    """写 16bit PCM 单声道 wav（与 _read_wav 对称）。"""
    a = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    pcm = (a * 32767.0).astype(np.int16)
    wf = wave.open(path, "wb")
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(int(sr))
    wf.writeframes(pcm.tobytes())
    wf.close()


def _has_video(path: str) -> bool:
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type",
                            "-of", "csv=p=0", path], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        return "video" in (r.stdout or "")
    except Exception:
        return False


def _audio_channels(path: str) -> int:
    """探测首条音频流的通道数（失败按 1 处理）。"""
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a:0",
                            "-show_entries", "stream=channels",
                            "-of", "csv=p=0", path], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        v = int(float((r.stdout or "1").strip().splitlines()[0]))
        return max(1, min(8, v))
    except Exception:
        return 1


def _read_wav_any(path: str) -> tuple:
    """读 16bit PCM wav（mono/interleaved 多声道）→ (float32 [frames, ch], sr)。"""
    wf = wave.open(path, "rb")
    sr = wf.getframerate()
    ch = wf.getnchannels()
    frames = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    wf.close()
    shape = (-1, ch) if ch > 1 else (-1, 1)
    return frames.reshape(shape), sr


def _write_wav_any(path: str, audio: np.ndarray, sr: int) -> None:
    """写 16bit PCM wav，支持 mono [n] / 多声道 [n, ch]。"""
    a = np.asarray(audio, dtype=np.float32)
    if a.ndim == 1:
        a = a[:, None]
    a = np.clip(a, -1.0, 1.0)
    pcm = (a * 32767.0).astype(np.int16)
    wf = wave.open(path, "wb")
    wf.setnchannels(a.shape[1])
    wf.setsampwidth(2)
    wf.setframerate(int(sr))
    wf.writeframes(pcm.tobytes())
    wf.close()


def _persist_enhanced_audio(input_path: str, dn16k_path: str, method: str,
                            mask_soften: bool, mask_soften_floor: float) -> tuple:
    """「干净人声直接入片」：把降噪波形持久化为源文件旁 <stem>_denoised.wav。

    - method='dfn3'（标准档）：权重为**全带宽 48k 模型**——从源媒体直接提取 48k 音频
      （保留原通道数，>2 声道降混为立体声），逐通道过一遍 DFN3（含软化阈值），得到
      齿音/气声/泛音完整的全带宽增强人声。dfn3.enhance 零平移不变，与源时间轴严格对齐。
    - 其它方法（frcrn 高质量档 / lightweight）：仅支持 16k —— 直接持久化 16k 波形，
      FRCRN 链路行为完全不变。
    全带宽任一环节失败都回退为拷贝 16k 版本并告警；彻底失败返回空路径（成片用原声）。
    返回 (path_or_"", warning_or_"")。
    """
    out_path = os.path.splitext(input_path)[0] + "_denoised.wav"
    if method != "dfn3":
        try:
            shutil.copyfile(dn16k_path, out_path)
            return out_path, ""
        except Exception as e:
            return "", f"enhanced_audio_copy_failed: {e}"

    # ── DFN3 全带宽通道 ──
    tmp48 = out_path + ".fb48k.tmp.wav"
    fallback_warn = ""
    try:
        ch = min(2, max(1, _audio_channels(input_path)))
        _run_ffmpeg(["-i", input_path, "-vn", "-ac", str(ch),
                     "-ar", "48000", "-f", "wav", tmp48])
        au48, sr48 = _read_wav_any(tmp48)
        if au48.shape[0] == 0:
            raise RuntimeError("empty_audio")
        import dfn3  # noqa: E402  (同目录模块；模型 SR=48000，sr==SR_MODEL 走原生全带宽)
        outs = np.zeros_like(au48)
        for c in range(au48.shape[1]):
            y = dfn3.enhance(np.ascontiguousarray(au48[:, c], dtype=np.float32), sr48,
                             DENOISE_MODEL_DIR, _onnx_session,
                             mask_soften=mask_soften, mask_soften_floor=mask_soften_floor)
            if y is None or y.shape[0] != au48.shape[0]:
                raise RuntimeError("dfn3_fullband_unavailable")
            outs[:, c] = y
        _write_wav_any(out_path, outs if outs.shape[1] > 1 else outs[:, 0], sr48)
        return out_path, ""
    except Exception as e:
        fallback_warn = f"enhanced_audio_fullband_fallback_16k: {e}"
        sys.stderr.write(f"[denoise] 全带宽增强失败({e})，回退 16k 波形\n")
    finally:
        try:
            if os.path.exists(tmp48):
                os.remove(tmp48)
        except OSError:
            pass
    # 回退：16k 结果直接落盘
    try:
        shutil.copyfile(dn16k_path, out_path)
        return out_path, fallback_warn
    except Exception as e:
        return "", fallback_warn or f"enhanced_audio_copy_failed: {e}"


# ══════════════════════════════════════════════════════
# [1] Demucs 声源分离（分析辅助；失败回退原始音频）
# ══════════════════════════════════════════════════════

def neural_separate(wav16_path: str, out_dir: str, cache_dir: str):
    """用 Demucs 分离人声(vocals)与伴奏(no_vocals)。

    成功返回 (vocals_path, accomp_path)，失败返回 (None, None)。

    Demucs 原生输出 44.1k 的 `htdemucs/src/vocals.wav` 与 `htdemucs/src/no_vocals.wav`，
    二者被 COPY 到 cache_dir（持久目录）并命名为 `<base>_vocals.wav` / `<base>_no_vocals.wav`，
    **保持 Demucs 原生采样率（不做 16k resample）**。16k 人声仅由 analyze 在分析前现做 resample。
    """
    try:
        import importlib.util as u
        if not u.find_spec("demucs"):
            return None, None
        py = sys.executable
        work = os.path.join(out_dir, "_demucs")
        os.makedirs(work, exist_ok=True)
        src = os.path.join(work, "src.wav")
        _run_ffmpeg(["-i", wav16_path, "-ac", "1", "-ar", "16000", src])
        env = dict(os.environ, HF_ENDPOINT="https://hf-mirror.com", HF_HUB_DISABLE_XET="1")
        cp = subprocess.run([py, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs",
                             "-o", work, src],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            encoding="utf-8", errors="replace", env=env)
        if cp.returncode != 0:
            raise RuntimeError(f"demucs exit={cp.returncode}")
        base = os.path.splitext(os.path.basename(wav16_path))[0]
        got_v = os.path.join(work, "htdemucs", "src", "vocals.wav")
        got_a = os.path.join(work, "htdemucs", "src", "no_vocals.wav")
        if os.path.exists(got_v) and os.path.exists(got_a):
            vdst = os.path.join(cache_dir, f"{base}_vocals.wav")
            adst = os.path.join(cache_dir, f"{base}_no_vocals.wav")
            shutil.copyfile(got_v, vdst)
            shutil.copyfile(got_a, adst)
            print("  [OK] Demucs 声源分离完成（vocals + no_vocals @44.1k 已缓存）", flush=True)
            return vdst, adst
    except Exception as e:
        print(f"  [SKIP] Demucs 不可用({e})，跳过声源分离", flush=True)
    return None, None


# ══════════════════════════════════════════════════════
# [1b] 降噪（P0-B）：opts['denoise'] 真正生效
# ══════════════════════════════════════════════════════

# 权重目录（P0-E 负责下载放置）。DeepFilterNet3 官方权重为 **48k** 模型
# (enc/erb_dec/df_dec 三段 ONNX)，16k 输入在 dfn3.py 内部 16k→48k 升采样再降回。
# 三段图流水线已实现于 speech_edit/dfn3.py（ERB/DF 特征 + Deep Filtering + 零平移对齐）。
# 期望放置路径：E:/AIcut/python/models/denoise/{enc,erb_dec,df_dec}.onnx (+ config.ini)
DENOISE_MODEL_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "denoise")


def _prepend_cuda_dll_path() -> None:
    """与 python/keying/core.py:35 同款：把 nvidia/*/bin 注入 PATH，
    否则 onnxruntime-gpu 找不到 cublasLt/cudnn DLL 而静默回退 CPU。"""
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


def _onnx_session(model_path: str):
    """ONNX Runtime 会话 + provider 兜底链 CUDA → DML → CPU
    （与 python/keying/core.py:262 一致的逐 EP 独立尝试写法）。返回 (session, ep) 或 (None, None)。"""
    try:
        _prepend_cuda_dll_path()
        import onnxruntime as ort
        ort.set_default_logger_severity(3)
        so = ort.SessionOptions()
        avail = ort.get_available_providers()
        for ep in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"):
            if ep not in avail:
                continue
            try:
                sess = ort.InferenceSession(model_path, so, providers=[ep])
                if ep in sess.get_providers():
                    return sess, ep
            except Exception as e:
                sys.stderr.write(f"[denoise] EP[{ep}] 初始化失败({e})，尝试下一个\n")
                continue
    except Exception as e:
        sys.stderr.write(f"[denoise] onnxruntime 不可用({e})\n")
    return None, None


# _denoise_onnx 实际生效的后端名（"dfn3" | "onnx"），供 denoise_wav 回报给前端
_LAST_ONNX_BACKEND = "onnx"


def _has_dfn3_weights() -> bool:
    """DENOISE_MODEL_DIR 下是否齐备 DeepFilterNet3 三段图。"""
    if not os.path.isdir(DENOISE_MODEL_DIR):
        return False
    return all(os.path.isfile(os.path.join(DENOISE_MODEL_DIR, f"{n}.onnx"))
               for n in ("enc", "erb_dec", "df_dec"))


def _denoise_dfn3(au: np.ndarray, sr: int, mask_soften: bool = True,
                  mask_soften_floor: float = 0.5):
    """DeepFilterNet3（enc/erb_dec/df_dec 三段图）降噪。

    实现在 speech_edit/dfn3.py：ERB/DF 特征 → 两阶段增强 → 与输入**样本级零平移**
    的等长输出（下游词级时间戳依赖此性质）。返回 ndarray 或 None（不可用 → 降级）。
    """
    if not _has_dfn3_weights():
        return None
    try:
        _here = os.path.dirname(os.path.abspath(__file__))
        if _here not in sys.path:
            sys.path.insert(0, _here)
        import dfn3  # noqa: E402  (同目录模块)
        y = dfn3.enhance(au, sr, DENOISE_MODEL_DIR, _onnx_session,
                         mask_soften=mask_soften, mask_soften_floor=mask_soften_floor)
        if y is None:
            return None
        y = np.asarray(y, dtype=np.float32).reshape(-1)
        if y.size != au.size:
            sys.stderr.write(
                f"[denoise] DFN3 输出长度异常({y.size}!={au.size})，回退\n")
            return None
        return np.clip(y, -1.0, 1.0)
    except Exception as e:
        sys.stderr.write(f"[denoise] DFN3 降噪失败({e})，回退下一级方案\n")
        return None


def _denoise_frcrn(au: np.ndarray, sr: int):
    """FRCRN_SE_16K 高质量降噪（frcrn.py）。

    权重缺失/推理失败返回 None → 由调用方降级到 DFN3/轻量方案。
    输出与输入样本级等长（frcrn.enhance 内部已做零平移补偿）。
    """
    try:
        _here = os.path.dirname(os.path.abspath(__file__))
        if _here not in sys.path:
            sys.path.insert(0, _here)
        import frcrn  # noqa: E402  (同目录模块；frcrn 内部 from core import _onnx_session)
        y = frcrn.enhance(au, sr, DENOISE_MODEL_DIR, _onnx_session)
        if y is None:
            return None
        y = np.asarray(y, dtype=np.float32).reshape(-1)
        if y.size != au.size:
            sys.stderr.write(
                f"[denoise] FRCRN 输出长度异常({y.size}!={au.size})，回退\n")
            return None
        return np.clip(y, -1.0, 1.0)
    except Exception as e:
        sys.stderr.write(f"[denoise] FRCRN 降噪失败({e})，回退下一级方案\n")
        return None


def _denoise_onnx(au: np.ndarray, sr: int, quality="standard",
                  mask_soften: bool = True, mask_soften_floor: float = 0.5):
    """ONNX 降噪接入点。返回降噪后的音频，或 None（不可用）。

    优先级：DeepFilterNet3 三段图（_denoise_dfn3）→ 单图「波形进/波形出」模型
    （输入 [1,T] float32）→ None（由轻量方案兜底）。
    """
    try:
        if not os.path.isdir(DENOISE_MODEL_DIR):
            return None
        global _LAST_ONNX_BACKEND
        if quality == "high":
            y = _denoise_frcrn(au, sr)
            if y is not None:
                _LAST_ONNX_BACKEND = "frcrn"
                return y
        y = _denoise_dfn3(au, sr, mask_soften=mask_soften, mask_soften_floor=mask_soften_floor)
        if y is not None:
            _LAST_ONNX_BACKEND = "dfn3"
            return y
        _LAST_ONNX_BACKEND = "onnx"
        import glob as _glob
        cands = sorted(_glob.glob(os.path.join(DENOISE_MODEL_DIR, "*.onnx")))
        if not cands:
            return None
        # 三段图的分片不能当单图跑，排除掉
        single = [p for p in cands
                  if not any(k in os.path.basename(p).lower()
                             for k in ("enc", "erb_dec", "df_dec"))]
        if not single:
            return None
        model_path = single[0]
        sess, ep = _onnx_session(model_path)
        if sess is None:
            return None
        iname = sess.get_inputs()[0].name
        x = np.asarray(au, dtype=np.float32)[None, :]
        out = sess.run(None, {iname: x})[0]
        y = np.asarray(out, dtype=np.float32).reshape(-1)
        if y.size == 0:
            return None
        if y.size != au.size:
            # 长度不一致（模型帧对齐差异）→ 裁剪/补零到原长
            if y.size > au.size:
                y = y[:au.size]
            else:
                y = np.concatenate([y, np.zeros(au.size - y.size, dtype=np.float32)])
        sys.stderr.write(f"[denoise] ONNX 降噪成功（{os.path.basename(model_path)} @ {ep}）\n")
        return np.clip(y, -1.0, 1.0)
    except Exception as e:
        sys.stderr.write(f"[denoise] ONNX 降噪失败({e})，回退轻量方案\n")
        return None


def _denoise_lightweight(au: np.ndarray, sr: int, hp_hz: float = 80.0,
                         alpha: float = 1.5, floor_db: float = -14.0) -> np.ndarray:
    """轻量降噪（无外部权重）：高通 + 谱减式噪声门。

    - 噪声底：先排除近静音帧（避免静音间隙把底估成 0），再取剩余帧中
      能量最低 20% 的频谱均值；对「带停顿的口播」稳健；
    - 增益：max(floor, (|X| - alpha*noise)/|X|)，floor 默认 -14dB（温和，
      避免破坏后续检测所依赖的能量/浊音/平坦度特征）；
    - hp_hz 以下频点直接置零（去除空调/电流低频轰鸣）；
    - 反射填充 n_fft 以消除 STFT 重叠相加在首尾的归一化放大伪影。
    """
    x = np.asarray(au, dtype=np.float32)
    n = x.size
    n_fft, hop = 512, 256
    if n < n_fft * 2:
        return x
    win = np.hanning(n_fft).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    # 反射填充，消除 STFT 重叠相加在首尾的归一化放大伪影
    pad = n_fft
    xp = np.concatenate([x[:pad][::-1], x, x[-pad:][::-1]]).astype(np.float32)
    nframes = 1 + (xp.size - n_fft) // hop

    # ── 稳健噪声底估计（抽样最多 3000 帧）──
    step = max(1, nframes // 3000)
    sidx = np.arange(0, nframes, step)
    fr = xp[(np.arange(n_fft)[None, :] + hop * sidx[:, None])] * win
    mag_s = np.abs(np.fft.rfft(fr, axis=1)).astype(np.float32)
    # 排除近静音帧，取剩余帧中能量最低 20% 的频谱均值作为噪声底
    fenergy = mag_s.sum(axis=1)
    nonzero = fenergy > (fenergy.max() * 1e-3 + 1e-9)
    if int(nonzero.sum()) < 3:
        nonzero = np.ones_like(nonzero)  # 全静音兜底：不降噪
    fe_sorted = np.argsort(fenergy[nonzero])
    k = max(1, int(0.2 * int(nonzero.sum())))
    noise = mag_s[nonzero][fe_sorted[:k]].mean(axis=0).astype(np.float32)
    del fr, mag_s

    floor_gain = float(10.0 ** (floor_db / 20.0))
    out = np.zeros(xp.size + n_fft, dtype=np.float32)
    norm = np.zeros(xp.size + n_fft, dtype=np.float32)
    win2 = (win ** 2).astype(np.float32)
    batch = 2048
    for b0 in range(0, nframes, batch):
        b1 = min(nframes, b0 + batch)
        starts = np.arange(b0, b1) * hop
        seg = xp[(np.arange(n_fft)[None, :] + starts[:, None])] * win
        spec = np.fft.rfft(seg, axis=1)
        mag = np.abs(spec).astype(np.float32) + 1e-12
        gain = (mag - alpha * noise[None, :]) / mag
        np.clip(gain, floor_gain, 1.0, out=gain)
        gain[:, freqs < hp_hz] = 0.0
        rec = np.fft.irfft(spec * gain, n=n_fft, axis=1).astype(np.float32) * win
        for kk, st in enumerate(starts):
            out[st:st + n_fft] += rec[kk]
            norm[st:st + n_fft] += win2
    yp = np.zeros(xp.size, dtype=np.float32)
    valid = norm[:xp.size] > 1e-6
    yp[valid] = out[:xp.size][valid] / norm[:xp.size][valid]
    yp = np.clip(yp, -1.0, 1.0)
    y = yp[pad:pad + n]  # 取回原始长度
    return y.astype(np.float32)


def denoise_wav(wav_in: str, wav_out: str, quality="standard",
                mask_soften: bool = True, mask_soften_floor: float = 0.5) -> tuple:
    """对 16k 单声道 wav 做降噪，写到 wav_out。

    返回 (ok, method, warning)：
      ok=False 时调用方继续用原音频（no-op 降级，绝不抛错阻断分析）。
    """
    try:
        au, sr = _read_wav(wav_in)
    except Exception as e:
        return False, "none", f"denoise_read_failed:{e}"
    if au.size == 0:
        return False, "none", "denoise_empty_audio"

    y = _denoise_onnx(au, sr, quality=quality,
                      mask_soften=mask_soften, mask_soften_floor=mask_soften_floor)
    if y is not None:
        try:
            _write_wav(wav_out, y, sr)
            return True, _LAST_ONNX_BACKEND, ""
        except Exception as e:
            return False, "none", f"denoise_write_failed:{e}"

    # 权重不存在 / ONNX 不可用 → 轻量方案（并回告 warning，便于前端提示）
    try:
        y = _denoise_lightweight(au, sr)
        _write_wav(wav_out, y, sr)
        return True, "lightweight", "denoise_weights_missing_fallback_lightweight"
    except Exception as e:
        sys.stderr.write(f"[denoise] 轻量降噪失败({e})，按 no-op 处理\n")
        return False, "none", f"denoise_failed:{e}"


# ══════════════════════════════════════════════════════
# [2] Whisper 词级转写
# ══════════════════════════════════════════════════════

def _whisper_device(prefer: str = None) -> tuple:
    """选择 faster-whisper(ctranslate2) 的 (device, compute_type)。

    P0-A：默认优先 CUDA（float16，词级时间戳明显更稳），探测失败/无 GPU 时回退
    CPU int8（与旧行为一致）。prefer 可显式指定 'cuda' / 'cpu'。
    """
    want = (prefer or os.environ.get("AICUT_SPEECH_DEVICE") or "auto").strip().lower()
    if want == "cpu":
        return "cpu", "int8"
    try:
        import ctranslate2
        if int(ctranslate2.get_cuda_device_count()) > 0:
            types = set()
            try:
                types = set(ctranslate2.get_supported_compute_types("cuda"))
            except Exception:
                pass
            for ct in ("float16", "int8_float16", "float32"):
                if not types or ct in types:
                    return "cuda", ct
    except Exception as e:
        sys.stderr.write(f"[transcribe] CUDA 探测失败({e})，回退 CPU\n")
    return "cpu", "int8"


def _asr_bridge_module():
    """按文件路径加载 python/asr/bridge.py（不能直接 `import bridge`：
    speech_edit/bridge.py 已占用同名模块且在 sys.path[0]）。失败返回 None。"""
    try:
        import importlib.util as iu
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(os.path.dirname(here), "asr", "bridge.py")
        if not os.path.exists(path):
            return None
        spec = iu.spec_from_file_location("aicut_asr_bridge", path)
        mod = iu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception as e:
        sys.stderr.write(f"[transcribe] 加载 asr/bridge.py 失败({e})\n")
        return None


def paraformer_words(wav_path: str, language: str = None) -> list:
    """可选云端词级时间通道（DashScope / Paraformer 实时识别）。

    返回 [{word,start,end}]；无 key / SDK 缺失 / 网络失败时返回 []（静默跳过，
    调用方回退 whisper 的 word_timestamps）。Key 一律从环境变量读取，绝不硬编码。
    """
    key = (os.environ.get("DASHSCOPE_API_KEY")
           or os.environ.get("AICUT_ASR_API_KEY") or "").strip()
    if not key:
        return []
    mod = _asr_bridge_module()
    if mod is None:
        return []
    try:
        import dashscope
        dashscope.api_key = key
        os.environ["DASHSCOPE_API_KEY"] = key
        lang = language or "auto"
        model = os.environ.get("AICUT_SPEECH_CLOUD_MODEL", "paraformer-realtime-v2")

        def _norm(r):
            """asr/bridge 的两个入口在部分失败分支只返回 list（非 (segs, flag) 元组），
            这里统一成 (segs, word_level)。"""
            if isinstance(r, tuple) and len(r) == 2:
                return (r[0] or []), bool(r[1])
            return (r or []), False

        segs, word_level = _norm(mod._recognize(wav_path, lang, model))
        if not segs:
            segs, word_level = _norm(mod._recognize_file_fallback(wav_path, lang, model))
        if not segs or not word_level:
            return []
        out = []
        for s in segs:
            t = (s.get("text") or "").strip()
            if not t:
                continue
            ws, we = float(s["start"]), float(s["end"])
            if we < ws:
                we = ws
            out.append({"word": t, "start": ws, "end": we})
        out.sort(key=lambda w: w["start"])
        return out
    except Exception as e:
        sys.stderr.write(f"[transcribe] Paraformer 词级通道不可用({e})，跳过\n")
        return []


def _fuse_cloud_word_times(wh_words: list, cloud_words: list) -> list:
    """用 Paraformer 词级时间覆盖 whisper 词的时间戳（文本以 whisper 为准）。

    对齐方式：两侧文本去标点后拼成字符串，difflib 求匹配块 → whisper 每个词落在
    哪些云端词上，用云端词的 start/end 取 min/max 覆盖。未匹配上的 whisper 词保留
    自身时间（不猜）。云端词级比 whisper CPU 解码的时间戳更贴合真实边界。
    """
    if not wh_words or not cloud_words:
        return wh_words
    import difflib

    def _plain(text):
        return "".join(ch for ch in text if ch not in _PUNCT)

    a_chars, a_owner = [], []
    for i, w in enumerate(wh_words):
        for ch in _plain(w["word"]):
            a_chars.append(ch)
            a_owner.append(i)
    b_chars, b_owner = [], []
    for j, w in enumerate(cloud_words):
        for ch in _plain(w["word"]):
            b_chars.append(ch)
            b_owner.append(j)
    if not a_chars or not b_chars:
        return wh_words
    a, b = "".join(a_chars), "".join(b_chars)
    # 两路转写字数差异过大 → 融合无意义（与 asr/bridge._merge_clauses 同款护栏）
    if abs(len(a) - len(b)) > max(len(a), len(b)) * 0.4 + 16:
        sys.stderr.write("[transcribe] 云端/本地转写字数差异过大，跳过词级融合\n")
        return wh_words

    hit = {}  # whisper 词索引 → 命中的云端词索引集合
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for ai, bj, size in sm.get_matching_blocks():
        for k in range(size):
            hit.setdefault(a_owner[ai + k], set()).add(b_owner[bj + k])

    fused = []
    n_over = 0
    for i, w in enumerate(wh_words):
        js = hit.get(i)
        if js:
            s = min(cloud_words[j]["start"] for j in js)
            e = max(cloud_words[j]["end"] for j in js)
            if e > s:
                fused.append({"word": w["word"], "start": float(s), "end": float(e)})
                n_over += 1
                continue
        fused.append(dict(w))
    fused.sort(key=lambda x: x["start"])
    sys.stderr.write(f"[transcribe] 云端词级融合：{n_over}/{len(wh_words)} 个词时间被覆盖\n")
    return fused


def transcribe(wav_path: str, model_size: str = "small", language: str = None,
               device: str = None, cloud_words: bool = True) -> tuple:
    """返回 (words, duration, asr_model, status)。words: [{word,start,end}]

    status: 'ok'（有词）/ 'empty'（模型跑通但 0 词，真的无语音/纯音乐）/
            'failed'（转写抛异常，词不可用 → 主流程需显式 VAD 兜底并告警）。

    language=None 时交给 faster-whisper 自动检测（泛化：支持英文 / 中英混说 / 方言样本，
    不再硬编码中文导致非中文样本词缺失 → 级联误删）。

    P0-A 精度提升：
      - device 默认探测 CUDA（float16），不可用回退 CPU int8（旧行为）；
      - model_size 默认 'small'（旧 'base'），仍可被 opts 覆盖；
      - 保留 word_timestamps=True；
      - 若存在 DASHSCOPE_API_KEY，用 Paraformer 词级时间覆盖 whisper 时间戳。
    """
    # 先估算时长（即便转写失败也能让后续 VAD 兜底走通）
    dur = 0.0
    try:
        au, sr = _read_wav(wav_path)
        dur = len(au) / sr
    except Exception:
        dur = 0.0
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    # ── 本地主路径：FunASR Paraformer 字级 + Qwen3-FA 强制对齐（零出域，±0.02s）──
    # 权重缺失 / 模块不可用 / 显式禁用(AICUT_ASR_LOCAL=0) 时 local_transcribe 返回空列表，
    # 静默回退下方 whisper→cloud→VAD 链（与旧行为零回归）。权重齐备时本路径为默认主用。
    try:
        _here = os.path.dirname(os.path.abspath(__file__))
        if _here not in sys.path:
            sys.path.insert(0, _here)
        from local_asr import local_transcribe as _local_tr
        lw, lstatus, lmodel = _local_tr(wav_path, language)
        if lw:
            sys.stderr.write(f"[transcribe] 本地 ASR({lmodel}) 命中，跳过 whisper/cloud\n")
            return lw, dur, lmodel, "ok"
    except Exception as e:
        sys.stderr.write(f"[transcribe] 本地 ASR 失败({e})，回退 whisper/cloud\n")

    dev, ctype = _whisper_device(device)
    words = []
    model = None
    status = "failed"
    try:
        try:
            from faster_whisper import WhisperModel
            model = WhisperModel(model_size, device=dev, compute_type=ctype)
        except Exception as e:
            if dev != "cpu":
                sys.stderr.write(f"[transcribe] {dev}/{ctype} 初始化失败({e})，回退 cpu/int8\n")
                dev, ctype = "cpu", "int8"
                model = WhisperModel(model_size, device=dev, compute_type=ctype)
            else:
                raise
        sys.stderr.write(f"[transcribe] whisper {model_size} @ {dev}/{ctype}\n")
        segs, info = model.transcribe(wav_path, beam_size=5, language=language, word_timestamps=True)
        for seg in segs:
            for w in (seg.words or []):
                words.append({"word": w.word, "start": float(w.start), "end": float(w.end)})
        dur = float(getattr(info, "duration", 0) or 0) or dur
        status = "ok" if words else "empty"
    except Exception as e:
        sys.stderr.write(f"[transcribe] 转写失败({e})，标记 asr 失败（主流程走 VAD 兜底）\n")
        words, model, status = [], None, "failed"

    # 云端词级通道（可选）：Paraformer 词级时间比 whisper 更贴合真实词边界。
    if cloud_words:
        cw = paraformer_words(wav_path, language)
        if cw:
            if words:
                words = _fuse_cloud_word_times(words, cw)
            else:
                # whisper 无词（失败或空）但云端有词 → 直接采用云端词，救回该次分析
                words = cw
                status = "ok"
    return words, dur, model, status



# ══════════════════════════════════════════════════════
# [3] Silero VAD
# ══════════════════════════════════════════════════════

def vad_speech_regions(wav_path: str, threshold: float = 0.25,
                       min_speech_ms: int = 80, min_silence_ms: int = 80,
                       speech_pad_ms: int = 40, neg_threshold: float = None) -> list:
    """帧级 VAD，返回候选语音区间 [(s,e)]。

    neg_threshold=None 时用 silero 默认（=threshold）；显式传入可拉大升/降阈迟滞，
    稳定渐入渐出人声的段边界（泛化钩子，默认行为不变）。
    """
    from silero_vad import load_silero_vad, get_speech_timestamps
    au, sr = _read_wav(wav_path)
    model = load_silero_vad()
    kwargs = dict(
        sampling_rate=sr, threshold=threshold,
        min_speech_duration_ms=min_speech_ms,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=speech_pad_ms,
    )
    if neg_threshold is not None:
        kwargs["neg_threshold"] = neg_threshold
    ts = get_speech_timestamps(au, model, **kwargs)
    return [(float(t["start"]) / sr, float(t["end"]) / sr) for t in ts]


# ══════════════════════════════════════════════════════
# 声学特征函数
# ══════════════════════════════════════════════════════

def _region_breath(audio: np.ndarray, s: float, e: float, sr: int,
                   fmin_hz: int = 2000) -> tuple:
    """返回 (高频能量比, 过零率)。气声=双高，元音=双低。"""
    a, b = int(s * sr), int(e * sr)
    seg = audio[a:b]
    if seg.size < int(0.03 * sr):
        return (0.0, 0.0)
    win = seg * np.hanning(seg.size)
    nfft = 1 << int(np.ceil(np.log2(max(seg.size, 256))))
    mag = np.abs(np.fft.rfft(win, n=nfft))
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    hf = float(mag[freqs >= fmin_hz].sum())
    tot = float(mag.sum()) + 1e-12
    zcr = float(np.mean(np.diff(np.sign(seg)) != 0))
    return (hf / tot, zcr)


def _sustained_voiced(audio: np.ndarray, s: float, e: float, sr: int,
                      fmin: int = 70, fmax: int = 400, frame_ms: int = 20,
                      thr: float = 0.3) -> float:
    """最长连续浊音段秒数。真语音>0.08s，咳嗽<0.04s。"""
    a, b = int(s * sr), int(e * sr)
    seg = audio[a:b]
    if seg.size < int(0.05 * sr):
        return 0.0
    frame = max(1, int(sr * frame_ms / 1000))
    nframes = len(seg) // frame
    if nframes == 0:
        return 0.0
    voiced = np.zeros(nframes, dtype=bool)
    for i in range(nframes):
        w = seg[i * frame:(i + 1) * frame]
        if w.size < frame:
            break
        m = w - np.mean(w)
        var = float(np.var(m))
        if var < 1e-7:
            continue
        m = m / np.sqrt(var * len(w))
        f = np.fft.rfft(m, n=2 * len(w))
        acf = np.fft.irfft(f * np.conj(f))[:len(w)]
        lg_min = max(1, int(sr / fmax))
        lg_max = min(len(w) - 1, int(sr / fmin))
        voiced[i] = float(np.max(acf[lg_min:lg_max + 1])) > thr
    best = cur = 0
    for v in voiced:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best * frame / sr


def _spectral_flatness(audio: np.ndarray, s: float, e: float, sr: int) -> float:
    """幅度谱的几何均值/算术均值（频谱平坦度）。

    低 → 音色/谐波明显（音乐、歌唱、持续音）；高 → 类似白噪声（呼吸、咳嗽、瞬态）。
    """
    a, b = int(s * sr), int(e * sr)
    seg = audio[a:b]
    if seg.size < 256:
        return 1.0
    win = seg * np.hanning(seg.size)
    nfft = 1 << int(np.ceil(np.log2(max(seg.size, 256))))
    mag = np.abs(np.fft.rfft(win, n=nfft)) + 1e-12
    geo = float(np.exp(np.mean(np.log(mag))))
    ari = float(np.mean(mag))
    return geo / ari


# ══════════════════════════════════════════════════════
# [4a] 文本填充词匹配
# ══════════════════════════════════════════════════════

def detect_fillers(words: list, pad: float = 0.04) -> list:
    """Whisper 转写文本中匹配到的填充词 → 删除区间。"""
    out = []
    for w in words:
        t = w["word"].strip(_PUNCT).lower()
        if not t:
            continue
        hit = t in FILLERS or t in _SINGLE_FILLER
        if not hit and len(t) <= 2:
            hit = t in FILLERS
        if hit:
            out.append((max(0.0, w["start"] - pad), w["end"] + pad))
    return out


# ══════════════════════════════════════════════════════
# [4b] 孤立段填充词/噪声检测
# ══════════════════════════════════════════════════════

def detect_isolated_fillers(wav_path: str, words: list, vad_regs: list,
                            voiced_min: float = 0.07, energy_ratio: float = 2.5) -> list:
    """
    找到所有 VAD 检测到但 Whisper 没转写出词的孤立语音段，
    用声学特征判定是填充词(嗯/啊)还是噪声，统一标记删除。
    """
    au, sr = _read_wav(wav_path)
    if not words:
        return []

    win = int(0.02 * sr)
    hop = win // 2
    rms_arr = np.array([float(np.sqrt(np.mean(au[i:i + win] ** 2)))
                        for i in range(0, len(au) - win, hop)])
    noise_floor = float(np.percentile(rms_arr[rms_arr > 1e-8], 10)) if rms_arr.any() else 1e-4

    word_ivs = _union([(max(0.0, w["start"] - 0.04), w["end"] + 0.04) for w in words])

    fillers = []
    for vs, ve in vad_regs:
        has_word = any(not (ve <= ws or vs >= we) for ws, we in word_ivs)
        if has_word:
            continue

        dur = ve - vs
        if dur < 0.06:
            continue

        seg_rms = float(np.sqrt(np.mean(au[int(vs * sr):int(ve * sr)] ** 2))) + 1e-10
        voiced = _sustained_voiced(au, vs, ve, sr)

        if voiced > voiced_min:
            fillers.append((vs, ve))
        elif seg_rms > noise_floor * energy_ratio:
            fillers.append((vs, ve))

    return _union(fillers)


# ══════════════════════════════════════════════════════
# [4c] 间隙气声/咳嗽检测
# ══════════════════════════════════════════════════════

def detect_gap_breath(wav_path: str, gaps: list, words: list,
                      hf_thr: float = 0.28, zcr_thr: float = 0.08,
                      min_dur: float = 0.04, word_pad: float = 0.08) -> list:
    """在词间隙中检测气声(咳嗽/呼吸/清嗓)。词保护区内不检测。"""
    au, sr = _read_wav(wav_path)
    prot = _union([(max(0.0, w["start"] - word_pad), w["end"] + word_pad) for w in words])
    effective = []
    for gs, ge in gaps:
        cur = gs
        for ps, pe in prot:
            if pe <= cur or ps >= ge:
                continue
            if ps - cur > 1e-3:
                effective.append((cur, ps))
            cur = max(cur, pe)
        if ge - cur > 1e-3:
            effective.append((cur, ge))

    breath = []
    for gs, ge in effective:
        if ge - gs < min_dur:
            continue
        # 音乐感知门：跳过明显是音乐/环境音而非呼吸/咳嗽的间隙
        if ge - gs > 0.5:
            continue
        if _spectral_flatness(au, gs, ge, sr) < 0.2:
            continue
        if _sustained_voiced(au, gs, ge, sr) > 0.06:
            continue
        hf, zcr = _region_breath(au, gs, ge, sr)
        vo = _sustained_voiced(au, gs, ge, sr)
        if hf > hf_thr and zcr > zcr_thr and vo < 0.06:
            breath.append((gs, ge))
    return _union(breath)


# ══════════════════════════════════════════════════════
# [4d] 瞬态/咂嘴检测
# ══════════════════════════════════════════════════════

def detect_transients(wav_path: str, gaps: list, words: list,
                      word_pad: float = 0.06, crest_thr: float = 4.0,
                      flat_thr: float = 0.4, min_dur: float = 0.008,
                      max_dur: float = 0.12) -> list:
    """
    在词间隙中用 5ms 精细窗口检测宽带瞬态（咂嘴/口齿音/mic磕碰/咔哒声）。
    crest factor(峰值/RMS) 高 + 频谱平坦度高 = 瞬态噪声。

    音乐门（修复 #1 漏抓根因）：旧逻辑对「整段间隙」先算一次频谱平坦度，若
    <0.25 就整段 continue 跳过——导致音乐感长间隙里的咔哒被整段漏掉。现改为
    **逐 5ms 窗口**判断：仅当该窗口平坦度 < 0.2（确为音乐/音色）才跳过该窗口，
    非音乐窗口里 crest 高的瞬态照样抓到。
    """
    au, sr = _read_wav(wav_path)
    prot = _union([(max(0.0, w["start"] - word_pad), w["end"] + word_pad) for w in words])
    effective = []
    for gs, ge in gaps:
        cur = gs
        for ps, pe in prot:
            if pe <= cur or ps >= ge:
                continue
            if ps - cur > 1e-3:
                effective.append((cur, ps))
            cur = max(cur, pe)
        if ge - cur > 1e-3:
            effective.append((cur, ge))

    win = int(0.005 * sr)
    hop = max(1, win // 2)
    flat_nfft = 64
    transients = []
    for gs, ge in effective:
        if ge - gs < min_dur:
            continue
        a, b = int(gs * sr), int(ge * sr)
        for i in range(a, b - win, hop):
            seg = au[i:i + win]
            if seg.size < win // 2:
                continue
            # 逐窗口频谱平坦度（音乐门）
            flatness = 1.0
            if seg.size >= flat_nfft:
                win_hann = seg[:flat_nfft] * np.hanning(flat_nfft)
                mag = np.abs(np.fft.rfft(win_hann)) + 1e-12
                geo = float(np.exp(np.mean(np.log(mag))))
                ari = float(np.mean(mag))
                flatness = geo / ari
            # 该窗口是音乐/音色（平坦度低）→ 其瞬态属音乐，跳过本窗口
            if flatness < 0.2:
                continue
            peak = float(np.abs(seg).max()) + 1e-10
            rms = float(np.sqrt(np.mean(seg ** 2))) + 1e-10
            crest = peak / rms
            if crest < crest_thr:
                continue
            if flatness > flat_thr:
                transients.append((i / sr, (i + win) / sr))

    merged = _union(transients)
    return [(s, e) for s, e in merged if min_dur <= e - s <= max_dur]


# ══════════════════════════════════════════════════════
# [4e] 非语音声音事件检测（独立于 VAD，扫全音频）
# ══════════════════════════════════════════════════════

def _has_silence_border(au: np.ndarray, sr: int, s: float, e: float,
                        margin: float = 0.05, floor_ratio: float = 0.4) -> bool:
    """事件某一侧 margin 内是否存在静音（能量低于事件峰值*floor_ratio）。

    用于安全阀：只有**紧邻静音**的声音事件才是独立非语音（咳嗽/提示音/
    咂嘴），可以放心推过词边界删除；而嵌在连续语音里的元音两侧都是语音、
    无静音边，必须保留（避免切碎朗读）。
    """
    i0, i1 = int(s * sr), int(e * sr)
    if i1 <= i0:
        return False
    peak = float(np.abs(au[i0:i1]).max()) + 1e-9
    floor = peak * floor_ratio
    a0 = max(0, int((s - margin) * sr)); a1 = max(0, int(s * sr))
    if a1 > a0 and float(np.abs(au[a0:a1]).max()) < floor:
        return True
    b0 = min(len(au), i1); b1 = min(len(au), int((e + margin) * sr))
    if b1 > b0 and float(np.abs(au[b0:b1]).max()) < floor:
        return True
    return False






def detect_cough(wav_path: str, words: list, win_ms: int = 10, hop_ms: int = 5,
                 onset_factor: float = 4.5, min_dur: float = 0.10,
                 max_dur: float = 0.7, min_voiced: float = 0.08,
                 word_pad: float = 0.12, vad_regs: list = None,
                 overlap_keep_ratio: float = 0.5) -> list:
    """全音频扫描短促浊音爆发（咳嗽 / 清嗓 / 咳痰）。

    独立于 VAD 间隙：即便 silero VAD 把咳嗽判成语音并并入相邻朗读段，
    本函数直接在全音频能量包络上做 onset 检测，仍能抓到被吸收的咳嗽。
    核心安全阀：**无任何 Whisper 词对齐**的段才标记删除——咳嗽 / 清嗓
    不会被转写成词，而正常朗读的元音段总有词时间戳覆盖，从而可靠区分，
    避免把朗读元音误删。
    """
    au, sr = _read_wav(wav_path)
    win = max(1, int(win_ms / 1000 * sr))
    hop = max(1, int(hop_ms / 1000 * sr))
    n = len(au)
    if n < win:
        return []
    rms = np.array([float(np.sqrt(np.mean(au[i:i + win] ** 2)))
                    for i in range(0, n - win + 1, hop)])
    if rms.size == 0 or not rms.any():
        return []
    # 静音基线 = 低位分位数；咳嗽爆发相对它陡升
    baseline = float(np.percentile(rms[rms > 1e-8], 10)) if np.any(rms > 1e-8) else 1e-4
    thr = max(baseline * onset_factor, 1e-4)
    above = rms > thr
    events = []
    i = 0
    N = len(above)
    while i < N:
        if above[i]:
            j = i
            while j < N and above[j]:
                j += 1
            s = i * hop / sr
            e = j * hop / sr
            if min_dur <= (e - s) <= max_dur:
                # 浊音判定（咳嗽是浊音爆发；清音瞬态走 detect_transients）
                if _sustained_voiced(au, s, e, sr) >= min_voiced:
                    events.append((s, e))
            i = j
        else:
            i += 1
    if not events:
        return []
    # 安全阀 = 词区间(含 word_pad)。
    # 【原逻辑，已被 P0-C 取代，保留说明避免误删】方案 A 保守回退：任何与词对齐
    # 重叠的声音事件**整段丢弃**(不删)，只删完全不碰词、落在词间静音间隙的独立
    # 非语音事件 —— 副作用是句中咳嗽被词区间碰到一点即永不删除。
    #   out = [(s, e) for s, e in events
    #          if not any(not (e <= ws or s >= we) for ws, we in word_ivs)]
    # 【P0-C 放宽】重叠比例 >= overlap_keep_ratio 才整段不删（保护连续朗读元音），
    # 否则仅裁掉词区间之外的部分（句中咳嗽的词外部分可删）。
    word_ivs = _union([(max(0.0, w["start"] - word_pad), w["end"] + word_pad)
                       for w in words])
    return _apply_word_safety(events, word_ivs, keep_ratio=overlap_keep_ratio)


def detect_tonal_sfx(wav_path: str, words: list, win_ms: int = 30, hop_ms: int = 15,
                     flat_thr: float = 0.12, min_rel_energy: float = 1.5,
                     min_dur: float = 0.05, max_dur: float = 0.6,
                     word_pad: float = 0.08, vad_regs: list = None,
                     overlap_keep_ratio: float = 0.5) -> list:
    """全音频扫描短时强纯音事件（系统提示音 / 蜂鸣 / 按键音 / 门铃）。

    独立于 VAD：提示音常被 VAD 连同相邻朗读一起判为语音并入 keep，且现有
    音乐门(flat<0.2 跳过)也会把它当音乐保护；本函数在全音频上直接找
    「强 tonal(极低谱平坦度) + 高相对能量 + 短时 + 无词对齐」的孤立纯音。
    时长上限(max_dur)是关键防火墙：真实背景音乐乐句通常 >0.6s，不会被误删。
    """
    au, sr = _read_wav(wav_path)
    win = max(1, int(win_ms / 1000 * sr))
    hop = max(1, int(hop_ms / 1000 * sr))
    n = len(au)
    if n < win:
        return []
    rms = np.array([float(np.sqrt(np.mean(au[i:i + win] ** 2)))
                    for i in range(0, n - win + 1, hop)])
    if rms.size == 0 or not rms.any():
        return []
    baseline = float(np.percentile(rms[rms > 1e-8], 30)) if np.any(rms > 1e-8) else 1e-4
    nwin = (n - win) // hop + 1
    tonal = []
    for i in range(nwin):
        seg = au[i * hop:i * hop + win]
        if seg.size < win // 2:
            continue
        flat = _spectral_flatness(au, i * hop / sr, (i * hop + win) / sr, sr)
        if flat < flat_thr and rms[i] > baseline * min_rel_energy:
            tonal.append(i)
    if not tonal:
        return []
    # 合并相邻 tonal 窗口为事件
    events = []
    i = 0
    m = len(tonal)
    while i < m:
        j = i
        while j + 1 < m and tonal[j + 1] - tonal[j] <= 1:
            j += 1
        s = tonal[i] * hop / sr
        e = (tonal[j] + 1) * hop / sr + win / sr
        if min_dur <= (e - s) <= max_dur:
            events.append((s, e))
        i = j + 1
    if not events:
        return []
    # 安全阀：同 detect_cough。
    # 【原逻辑，已被 P0-C 取代，保留说明】方案 A 保守回退——词区间(含 word_pad)
    # 有任何重叠即整段丢弃，只删词间静音间隙的独立纯音事件：
    #   out = [(s, e) for s, e in events
    #          if not any(not (e <= ws or s >= we) for ws, we in word_ivs)]
    # 【P0-C 放宽】改为重叠比例阈值 + 词外部分裁剪。
    word_ivs = _union([(max(0.0, w["start"] - word_pad), w["end"] + word_pad)
                       for w in words])
    return _apply_word_safety(events, word_ivs, keep_ratio=overlap_keep_ratio)



# ══════════════════════════════════════════════════════
# [4f-4i] 保留段内部精细化（仅保留被 analyze 实际调用的子检测器）
# ══════════════════════════════════════════════════════
def detect_intra_keep(wav_path: str, keep: list, words: list,
                      pad_head: float = 0.03, pad_tail: float = 0.15,
                      min_gap: float = 0.04, voiced_min: float = 0.06) -> list:
    """
    在保留段内部，找出词保护范围之外的子段中有填充词/噪声特征的部分。
    非对称策略: 词前紧(pad_head)抓填充词，词后松(pad_tail)保尾音。
    """
    # 守卫：Whisper 返回 0 词（语言错配 / 纯音乐 / 转写失败）时，不应把整段保留区
    # 送进 _gap_is_filler 判定（否则 voiced>voiced_min 即整段判删 → 灾难性误删）。
    # 与 detect_isolated_fillers 对齐。
    if not words:
        return []
    au, sr = _read_wav(wav_path)
    word_ivs = _union([(max(0.0, w["start"] - pad_head), w["end"] + pad_tail) for w in words])

    win = int(0.02 * sr)
    hop = win // 2
    rms_arr = np.array([float(np.sqrt(np.mean(au[i:i + win] ** 2)))
                        for i in range(0, len(au) - win, hop)])
    noise_floor = float(np.percentile(rms_arr[rms_arr > 1e-8], 10)) if rms_arr.any() else 1e-4

    fillers = []
    for ks, ke in keep:
        cur = ks
        for ws, we in word_ivs:
            if we <= cur or ws >= ke:
                continue
            gap_s = max(cur, ks)
            gap_e = min(ws, ke)
            if gap_e - gap_s >= min_gap:
                if _gap_is_filler(au, gap_s, gap_e, sr, noise_floor, voiced_min):
                    fillers.append((gap_s, gap_e))
            cur = max(cur, we)

        if ke - cur >= min_gap:
            if _gap_is_filler(au, cur, ke, sr, noise_floor, voiced_min):
                fillers.append((cur, ke))

    return _union(fillers)


def _gap_is_filler(au: np.ndarray, s: float, e: float, sr: int,
                   noise_floor: float, voiced_min: float) -> bool:
    """判定一个未保护子段是否是填充词或噪声（应该删除）。"""
    seg_rms = float(np.sqrt(np.mean(au[int(s * sr):int(e * sr)] ** 2))) + 1e-10
    if seg_rms < noise_floor * 2.5:
        return False
    voiced = _sustained_voiced(au, s, e, sr)
    hf, zcr = _region_breath(au, s, e, sr)
    if voiced > voiced_min:
        return True
    if seg_rms > noise_floor * 3 and (hf > 0.25 or zcr > 0.08):
        return True
    return False
# ══════════════════════════════════════════════════════
# 主分析入口（决策层，仅返回 JSON 计划，不生成任何媒体文件）
# ══════════════════════════════════════════════════════

# 方案 §5.5 契约字段：每个删除事件除 type/start/end 外还需带
#   flag_disfluency (bool)  是否口头不流畅（填充词/重复/结巴）
#   gap_type        (str)   间隙/事件语义类型（供 P1 间隙分类器细化）
#   conf            (float) 置信度 0..1（规则检测器给经验值，P1 模型给真实分数）
#   src             (str)   来源标识（rule / rule_text / rule_acoustic / manual / 模型名）
# 这里给出各 detector 的初始填充值；P1 检测器接入后覆盖对应字段即可。
_DETAIL_META = {
    "text_filler":    {"flag_disfluency": True,  "gap_type": "filler",   "conf": 0.80, "src": "rule_text"},
    "isolated_noise": {"flag_disfluency": False, "gap_type": "isolated",  "conf": 0.60, "src": "rule_acoustic"},
    "gap_breath":     {"flag_disfluency": False, "gap_type": "breath",    "conf": 0.60, "src": "rule_acoustic"},
    "transient":      {"flag_disfluency": False, "gap_type": "transient", "conf": 0.55, "src": "rule_acoustic"},
    "intra_keep":     {"flag_disfluency": True,  "gap_type": "intra",     "conf": 0.50, "src": "rule_acoustic"},
    "cough":          {"flag_disfluency": False, "gap_type": "cough",     "conf": 0.65, "src": "rule_acoustic"},
    "tonal_sfx":      {"flag_disfluency": False, "gap_type": "tonal",     "conf": 0.65, "src": "rule_acoustic"},
    "vad_silence":    {"flag_disfluency": False, "gap_type": "silence",   "conf": 0.70, "src": "rule_vad"},
    "manual_exclude": {"flag_disfluency": False, "gap_type": "manual",    "conf": 1.00, "src": "manual"},
    # ② 副语言事件（PANNs 帧级 SED 检测的非语音/副语言事件，如笑声/叹息/吸气）
    "sed_event":      {"flag_disfluency": False, "gap_type": "sed",      "conf": 0.55, "src": "panns_sed"},
    # ② 呼吸专项（Respiro-en 风格；软停顿，不属 hard_remove）
    "resp_breath":    {"flag_disfluency": False, "gap_type": "breath",    "conf": 0.50, "src": "respiro"},
    # ③ 口吃/重复/拖音（改进 CTC + gap 分类思路；打断语句，属 hard_remove）
    "stutter":        {"flag_disfluency": True,  "gap_type": "stutter",  "conf": 0.6,  "src": "stutter"},
    "stutter_suggest":{"flag_disfluency": True,  "gap_type": "suggest", "conf": 0.45, "src": "stutter"},
    "seam_suggest":   {"flag_disfluency": True,  "gap_type": "suggest", "conf": 0.45, "src": "edl"},
    # P1 暂停压缩优先：把长停顿压到 targetPause 而非硬删（软停顿，非声音事件）
    "pause_compressed": {"flag_disfluency": False, "gap_type": "pause", "conf": 0.0, "src": "rule"},
}


def _vad_only_silence(wav_path: str, speech_regs: list, dur: float,
                      min_sil: float = 0.35, sil_ratio: float = 2.0) -> list:
    """P0-D 兜底用：只删「VAD 语音段之外、且能量确实处于静音底噪」的长间隙。

    不依赖任何词信息，故 ASR 失败时可安全使用：
      - 候选 = VAD 语音段的补集里长度 >= min_sil 的间隙；
      - 再要求该间隙 RMS < 底噪 * sil_ratio（排除音乐/环境音，避免删掉背景音乐）。
    """
    try:
        au, sr = _read_wav(wav_path)
    except Exception:
        return []
    if au.size == 0:
        return []
    win = max(1, int(0.02 * sr))
    hop = max(1, win // 2)
    rms_arr = np.array([float(np.sqrt(np.mean(au[i:i + win] ** 2)))
                        for i in range(0, max(1, len(au) - win), hop)])
    if rms_arr.size == 0:
        return []
    pos = rms_arr[rms_arr > 1e-8]
    noise_floor = float(np.percentile(pos, 10)) if pos.size else 1e-4
    out = []
    for gs, ge in _complement(speech_regs, dur, min_keep=0.0):
        if ge - gs < min_sil:
            continue
        a, b = int(gs * sr), int(ge * sr)
        if b <= a:
            continue
        seg_rms = float(np.sqrt(np.mean(au[a:b] ** 2)))
        if seg_rms < noise_floor * sil_ratio:
            out.append((gs, ge))
    return _union(out)


def _mk_detail(typ: str, s: float, e: float, **over) -> dict:
    """构造带 §5.5 契约字段的 detail 项；over 可由检测器覆盖任意字段。"""
    meta = _DETAIL_META.get(typ, {"flag_disfluency": None, "gap_type": "", "conf": None, "src": "rule"})
    d = {"type": typ, "start": float(s), "end": float(e),
         "flag_disfluency": meta["flag_disfluency"], "gap_type": meta["gap_type"],
         "conf": meta["conf"], "src": meta["src"]}
    d.update(over)
    return d


def _apply_min_gap(remove_list: list, min_gap: float) -> list:
    """丢弃短于 min_gap 的声学检测删除区间（太短的静音不值得切）。"""
    if min_gap <= 0:
        return list(remove_list)
    return [(s, e) for s, e in remove_list if (e - s) >= min_gap]


def speaking_rate_stats(words: list, dur: float, window: float = 3.0, step: float = 1.0) -> dict:
    """语速/节奏统计（P1，纯逻辑，无外部权重）。

    用词级时间戳估计中文「字/秒」：每个词字数 = len(word.strip(_PUNCT))；
    以 [window]s 为窗、[step]s 为步长滑窗，窗内字数 / 窗长 → 该窗中心语速。
    返回 overall_cps（全片总字数/dur）、median_cps（各窗中位数，抗离群）、
    windows([(center_t, cps)] 供可视化)、anomalies([{start,end,cps}] 显著偏离
    中位数的窗)、char_count(总字数)。用于 §5.5 节奏失调检测与前端提示。
    """
    chars = [(float(w["start"]), float(w["end"]),
              max(1, len(w["word"].strip(_PUNCT)))) for w in words]
    if not chars or dur <= 0:
        return {"overall_cps": 0.0, "median_cps": 0.0, "windows": [],
                "anomalies": [], "char_count": 0}
    windows = []
    half = window / 2.0
    t = half
    while t <= dur - half + 1e-9:
        ws, we = t - half, t + half
        cnt = 0.0
        for s, e, c in chars:
            ov = min(e, we) - max(s, ws)
            if ov > 0:
                cnt += c * (ov / (e - s))
        windows.append((round(t, 3), round(cnt / window, 3)))
        t += step
    cps_vals = [c for _, c in windows] or [0.0]
    median_cps = float(np.median(cps_vals))
    overall_cps = sum(c for _, _, c in chars) / dur
    anomalies = []
    if median_cps > 1e-6:
        for tc, c in windows:
            if c > median_cps * 1.5 or c < median_cps * 0.6:
                anomalies.append({"start": round(tc - half, 3),
                                  "end": round(tc + half, 3), "cps": c})
    return {"overall_cps": round(float(overall_cps), 3),
            "median_cps": round(float(median_cps), 3),
            "windows": windows, "anomalies": anomalies,
            "char_count": int(sum(c for _, _, c in chars))}


def compress_keep_timeline(keep: list, hard_remove: list, dur: float,
                           target_pause: float = 0.35) -> tuple:
    """暂停压缩优先策略（P1，纯逻辑，设计要求「优先压缩停顿而非删除」）。

    把源时间轴的保留段重映射到输出时间轴：相邻保留段之间的「间隙」分两类——
      · 硬删除间隙：与 hard_remove（填充词/咳嗽/瞬态/段内/手动等必须去掉的声音）
        任一区间重叠 → 硬删，输出中不插入停顿；
      · 软停顿间隙：纯静音 / 思考停顿（gap_breath、vad_silence 等）→ 压缩为
        min(间隙, target_pause) 插入输出，并记录 compressed 标记供 UI 显示。
    间隙 <= target_pause 的软停顿保持原长（不拉长）。
    返回 (keep_out, output_dur, compressed)：
      keep_out      : 输出时间轴保留段 [(s,e)]（非重叠、升序、从 0 起）
      output_dur    : 输出总时长（<= dur，停顿被压缩）
      compressed    : 被压缩的软停顿 [(out_s, out_e)]（输出时间轴）
    注意：源空间 keepSegments 不变（Rust assemble 默认仍按源硬删），本函数为
    增量输出，待前端/assemble 消费 keepSegmentsOut 时生效。
    """
    keep = _union([(float(s), float(e)) for s, e in keep])
    if not keep:
        return [], 0.0, []
    hard = _union([(float(s), float(e)) for s, e in hard_remove])
    out, compressed, cursor = [], [], 0.0
    n = len(keep)
    for i, (s, e) in enumerate(keep):
        seg_len = e - s
        out.append((cursor, cursor + seg_len))
        cursor += seg_len
        if i + 1 < n:
            nxt_s = keep[i + 1][0]
            gap = nxt_s - e
            if gap <= 0:
                continue
            is_hard = any(not (ge <= e or gs >= nxt_s) for gs, ge in hard)
            if is_hard:
                continue  # 硬删：不插入停顿
            add = min(gap, target_pause)  # 软停顿压缩
            if add > 1e-4 and (gap - add) > 1e-4:
                # 仅当停顿被实际缩短时才记为「压缩」（短停顿保持原长不标记）
                compressed.append((cursor, cursor + add))
            cursor += add
    return out, round(cursor, 6), compressed


def _head_tail_trim(wav16_path: str, silence_thr: float = 0.008, pad: float = 0.05,
                    max_tail: float = 3.0) -> tuple:
    """用 16k 原始音频包络估计首尾静音裁剪点。

    返回 (head_trim, tail_trim)：
      head_trim = 首个 RMS 超过静音阈值的点 - pad（clamp >= 0）；
      tail_trim  = dur - (最后 RMS 超过阈值的点 + pad)，并钳制 <= max_tail（避免误删长音乐尾）。
    全程无声则返回 (0.0, 0.0)。
    """
    try:
        au, sr = _read_wav(wav16_path)
    except Exception:
        return 0.0, 0.0
    dur = len(au) / sr
    if au.size == 0:
        return 0.0, 0.0
    win = max(1, int(0.01 * sr))
    hop = max(1, win // 2)
    n = (len(au) - win) // hop + 1
    if n <= 0:
        return 0.0, 0.0
    rms = np.array([float(np.sqrt(np.mean(au[i:i + win] ** 2)))
                    for i in range(0, len(au) - win, hop)])
    t = np.arange(n) * hop / sr

    above = np.where(rms > silence_thr)[0]
    if above.size == 0:
        return 0.0, 0.0

    head_trim = max(0.0, t[above[0]] - pad)
    tail_keep = min(dur, t[above[-1]] + pad)
    tail_trim = max(0.0, dur - tail_keep)
    tail_trim = min(tail_trim, max_tail)
    return head_trim, tail_trim


# ───────────────────────────────────────────────────────────
# ② 副语言事件检测器（PANNs 帧级 SED + Respiro 呼吸专项）
#   统一包装成 analyze 用的 detect_* 范式：第1参 wav_path，返回 [(s,e)] 秒，
#   权重缺失/异常 → [] no-op（对齐 cough/tonal 等既有检测器）。
# ───────────────────────────────────────────────────────────
def detect_panns_sed(wav_path: str, words: list, word_pad: float = 0.04,
                     threshold: float = 0.5, min_dur: float = 0.08,
                     max_dur: float = 2.0) -> list:
    """PANNs(Cnn14_DecisionLevelMax) 帧级声音事件检测（副语言/非语音事件）。

    仅取与既有检测器不重复的副语言类（Laughter/Sigh/Sniffing/Wheeze/Burping/
    Sneeze/Shuffling/Clapping），过滤掉 Cough/Throat clearing 以免与 detect_cough 双标。
    注：呼吸类(Breathing/Respiration)交由 detect_respiro 作软停顿（resp_breath）处理，
    严禁进 sed_event→hard_remove（否则会复现“机关枪式拼接”bug）。模型权重 MIT，放置 python/models/panns/。
    """
    if not _PANNS_OK or not _panns_available():
        return []
    try:
        au, sr = _read_wav(wav_path)
    except Exception:
        return []
    classes = {
        "Laughter": threshold,
        "Sigh": threshold,
        "Sniffing": threshold,
        "Wheeze": threshold,
        "Burping, eructation": threshold,
        "Sneeze": threshold,
        "Shuffling": threshold,
        "Clapping": threshold,
    }
    try:
        evs = _panns_sed(audio=au, sr=sr, classes=classes,
                         min_dur=min_dur, max_dur=max_dur)
    except Exception:
        return []
    ivs = [(s, e) for (s, e, _name, _sc) in evs]
    # 词保护：副语言事件常压在词尾/词间，套 word safety 避免切碎连续朗读
    word_ivs = ([(max(0.0, w["start"] - word_pad), w["end"] + word_pad)
                 for w in words] if words else [])
    return _apply_word_safety(ivs, word_ivs)


def detect_respiro(wav_path: str, words: list, word_pad: float = 0.08,
                   thr: float = 0.35, min_dur: float = 0.05,
                   max_dur: float = 3.0) -> list:
    """Respiro-en 风格呼吸专项检测。返回 [(s,e)]。权重缺失/异常 → []。

    呼吸属软停顿，调用方须保证其结果**不进 hard_remove**（否则会复现机关枪 bug）。
    """
    if not _PANNS_OK:
        return []
    try:
        evs = _detect_respiro(wav_path, words, word_pad=word_pad, thr=thr,
                             min_dur=min_dur, max_dur=max_dur)
    except Exception:
        return []
    return [(s, e) for (s, e, _sc) in evs]


def detect_stutter(wav_path: str, words: list, word_pad: float = 0.08,
                   threshold: float = 0.5, min_dur: float = 0.10,
                   max_dur: float = 3.0) -> list:
    """③ 改进 CTC + gap 分类(arXiv:2409.10177 思路)的口吃/重复/拖音检测 P0 落地。

    返回 [(s,e)]；权重缺失/异常 → []。口吃删除打断语句边界，类比咳嗽计入 hard_remove。
    """
    if _detect_stutter is None:
        return []
    try:
        return _detect_stutter(wav_path, words, word_pad=word_pad,
                               threshold=threshold, min_dur=min_dur, max_dur=max_dur)
    except Exception:
        return []


# ───────────────────────── 编辑决策层（EDL） ─────────────────────────
# 第一性原理：每挖一个洞 = 制造两个新接缝；接缝质量决定听感。检测器输出的事件
# 不能直接当剪切指令用，必须经过本层策略过滤/合并/吸附，防止把连续语流切成瑞士奶酪。
EDL_ABSORB_FRAG_DEFAULT = 0.42   # 保留段短于该值 → 并入相邻洞整块删除（不可懂碎片无保留价值）
EDL_MICRO_HOLE_DEFAULT  = 0.06   # 洞短于该值   → 撤销剪切（为几毫秒杂音开两刀得不偿失）
EDL_SNAP_MAX_SHIFT      = 0.12   # 剪点能量谷吸附最大位移（秒）


def _env_rms_grid(au, sr, fsec: float = 0.005):
    """均匀 RMS 能量网格（fsec 秒/帧），供剪点吸附使用。"""
    import numpy as _np
    hop = max(1, int(sr * fsec))
    nf = len(au) // hop
    if nf < 4:
        return None, fsec
    a = au[:nf * hop]
    return _np.sqrt(_np.mean(a.reshape(nf, hop) ** 2, axis=1)), fsec


def _edl_interior_holes(ks, env, fsec, thr_ratio: float = 0.05):
    """「语流内洞」筛选：两侧 60ms 内均有发声（能量 > 全局峰值 × thr_ratio）。
    句间停顿造成的洞不计入碎片化指标——那是有意的节奏留白。"""
    import numpy as _np
    if env is None or len(env) == 0 or len(ks) < 2:
        return [(ks[i][1], ks[i + 1][0]) for i in range(len(ks) - 1)]
    peak = float(_np.max(env)) + 1e-12
    nf = len(env)
    w = max(1, int(0.06 / fsec))
    out = []
    for i in range(len(ks) - 1):
        a, b = ks[i][1], ks[i + 1][0]
        ia, ib = max(0, int(a / fsec) - w), min(nf, int(a / fsec) + 1)
        ja, jb = max(0, int(b / fsec)), min(nf, int(b / fsec) + w)
        left = float(_np.max(env[ia:ib])) if ib > ia else 0.0
        right = float(_np.max(env[ja:jb])) if jb > ja else 0.0
        if left > thr_ratio * peak and right > thr_ratio * peak:
            out.append((a, b))
    return out


def _edl_union(ks):
    return _union([(float(s), float(e)) for s, e in ks])


def _edl_retract_to_word_edges(ks, words, keep_min: float = 0.06):
    """结构性剪点若落在某转写词内部、且该词主体在保留侧 → 边界退到词边缘，
    避免吃掉起音辅音产生幻听残头（whisper 表现为『哦哦哦』类插入）。"""
    ks = [[float(a), float(b)] for a, b in ks]
    for i in range(len(ks) - 1):
        a, b = ks[i][1], ks[i + 1][0]
        for w in words:
            try:
                ws, we = float(w.get("start") or 0), float(w.get("end") or 0)
            except Exception:
                continue
            wl = we - ws
            if wl <= 0.05 or we <= a or ws >= b:
                continue
            # 右剪点进入词头（词主体在右侧保留段）：退到词起点前
            if ws < b < we and (we - b) >= 0.6 * wl and b - ws < 0.25 \
                    and ws - a > keep_min:
                ks[i + 1][0] = ws - 0.012
    return [(a, b) for a, b in ks]


def _edl_absorb_short_keeps(ks, min_frag: float, protect=None):
    """过短保留段并入相邻洞（＝删除该碎片），直到全部 ≥min_frag 或只剩一段。
    protect(s,e) 为 True 的短段不吸收——例如包含真实转写词的片段
    （停顿后的短词被误删会在接缝处产生幻听残音）。"""
    ks = list(ks)
    changed = True
    while changed and len(ks) > 1:
        changed = False
        for i, (s, e) in enumerate(ks):
            if e - s < min_frag:
                if protect and protect(s, e):
                    continue          # 含真实语音内容：保留该短段
                del ks[i]
                changed = True
                break
    return ks


def _edl_drop_micro_holes(ks, min_hole: float):
    """过窄的洞撤销：两侧保留段直接拼接，省两个接缝。"""
    ks = list(ks)
    i = 0
    while i < len(ks) - 1:
        gap = ks[i + 1][0] - ks[i][1]
        if 0.0 < gap <= min_hole:
            ks[i] = (ks[i][0], ks[i + 1][1])
            ks.pop(i + 1)
            continue          # 不递增：新位置可能又与后段形成微洞
        i += 1
    return ks


def _edl_snap_edges(ks, env, fsec: float, max_shift: float = EDL_SNAP_MAX_SHIFT,
                    edge_guard: float = 0.20):
    """每个洞的左右剪点吸附到窗口内能量最低帧。

    窗口不对称：外侧（扩大洞方向）允许 max_shift，内侧（缩小洞方向）只允许
    40ms —— 删字宜多删一点边缘，但绝不能吃掉后面的音素。同时保证相邻保留段
    吸附后仍 ≥edge_guard。
    """
    import numpy as _np
    if env is None or len(ks) < 2:
        return ks
    nf = len(env)
    out = [[float(s), float(e)] for s, e in ks]

    def frame_lo(t):
        return max(0, int(t / fsec))

    def frame_hi(t):
        return min(nf, int(t / fsec) + 1)

    for j in range(len(out) - 1):
        a, b = out[j][1], out[j + 1][0]           # 洞 (a,b)
        prev_len = a - out[j][0]
        next_len = out[j + 1][1] - b
        la = max(out[j][0] + edge_guard, a - max_shift)   # 左边界可探索区间
        ra = min(b - 0.01, a + 0.04)
        lb = max(a + 0.01, b - 0.04)
        rb = min(out[j + 1][1] - edge_guard, b + max_shift)
        if la >= ra or lb >= rb or prev_len - max_shift < edge_guard \
                or next_len - max_shift < edge_guard:
            continue
        ia0, ia1 = frame_lo(la), frame_hi(ra)
        ib0, ib1 = frame_lo(lb), frame_hi(rb)
        if ia1 <= ia0 or ib1 <= ib0:
            continue
        ka = ia0 + int(_np.argmin(env[ia0:ia1]))
        kb = ib0 + int(_np.argmin(env[ib0:ib1]))
        na, nb = ka * fsec, kb * fsec
        # 吸附后洞不得塌缩；塌缩则整个撤洞
        if nb - na < 0.02:
            out[j][1], out[j + 1][0] = b, a       # 还原（等效拼回）
            continue
        if abs(na - a) > 1e-6:
            out[j][1] = na
        if abs(nb - b) > 1e-6:
            out[j + 1][0] = nb
    return [(max(0.0, s), e) for s, e in out]


def _norm_text_zh(t: str) -> str:
    """编辑校验用的文本归一化：仅保留 CJK 与字母数字。"""
    return "".join(ch for ch in (t or "") if "\u4e00" <= ch <= "\u9fff"
                   or (ch.isascii() and ch.isalnum())).lower()


def _edl_whole_word_edges(ks, words, max_ext: float = 0.35, min_keep_after: float = 0.12):
    """整词化边界：剪点若落在词中间且该词主体在洞内，则把边界推到整词边缘，
    清掉「半个字」残音。扩展幅度受 max_ext 限制；产生过短保留段的扩展被拒绝。"""
    ks = [[float(a), float(b)] for a, b in ks]
    ok = lambda: all((ks[i + 1][0] - ks[i][0] == 0)
                     or (ks[i + 1][0] - ks[i][0] >= min_keep_after)
                     for i in range(len(ks) - 1))
    for _pass in range(3):
        changed = False
        for i in range(len(ks) - 1):
            a, b = ks[i][1], ks[i + 1][0]
            if b - a < 0.05:
                continue
            for w in words:
                ws, we = w.get("start"), w.get("end")
                if ws is None or we is None:
                    continue
                ws, we = float(ws), float(we)
                wl = we - ws
                if wl <= 0.06 or wl > 1.6:
                    continue
                cov = min(b, we) - max(a, ws)
                if cov <= 0:
                    continue
                old0, old1 = ks[i][1], ks[i + 1][0]
                # A: 词主体在洞内、词尾伸入右侧保留段 → 右剪点推到词尾
                if ws >= a - 0.02 and we > b + 0.01 and cov / wl >= 0.6 and we - b <= max_ext:
                    ks[i + 1][0] = we
                # B: 词主体在洞内、词头伸入左侧保留段 → 左剪点退到词头
                elif we <= b + 0.02 and ws < a - 0.01 and cov / wl >= 0.6 and a - ws <= max_ext:
                    ks[i][1] = ws
                if not ok():
                    ks[i][1], ks[i + 1][0] = old0, old1
                else:
                    changed = True
        if not changed:
            break
    return [(a, b) for a, b in ks]


def _edl_fluency_guard(au, sr, ks, words, tmpdir, model_size: str = "small",
                       language=None, thr_ok: float = 0.93, thr_floor: float = 0.80,
                       max_rounds: int = 3):
    """流畅度守卫：按候选保留段重建音频 → 重转写 → 与期望文本比对。

    期望文本 = 源转写减去「中点落在洞内的词」。相似度低于 thr_ok 时，优先回退
    「半字切割」嫌疑最大的洞（重试取最优）；低于 thr_floor 则保持已找到的最优解并告警。
    返回 (最终 ks, 相似度, 说明)。任何异常由调用方兜底（不影响主流程）。"""
    from difflib import SequenceMatcher
    wav_path = os.path.join(tmpdir, "_edl_check.wav")

    def norm(words_list, skip_holes=()):
        out = []
        for w in words_list:
            s, e = float(w.get("start", -1)), float(w.get("end", -1))
            if s < 0:
                continue
            mid = (s + e) / 2.0
            if any(h0 <= mid <= h1 for h0, h1 in skip_holes):
                continue
            out.append(str(w.get("word", w.get("text", ""))))
        return _norm_text_zh("".join(out))

    def build_and_transcribe(kk):
        parts = []
        for s, e in kk:
            i0, i1 = int(max(0.0, s) * sr), int(min(len(au) / sr, e) * sr)
            if i1 > i0:
                parts.append(au[i0:i1])
        if not parts:
            return -1.0
        ed = np.concatenate(parts)
        _write_wav(wav_path, ed, sr)
        w2, _d2, _m, st = transcribe(wav_path, model_size=model_size,
                                     language=language, cloud_words=False)
        if st != "ok":
            return -1.0
        t2 = _norm_text_zh("".join(str(x.get("word", x.get("text", ""))) for x in w2))
        e1 = norm(words, [(kk[i][1], kk[i + 1][0]) for i in range(len(kk) - 1)])
        if not e1:
            return 1.0
        return SequenceMatcher(None, e1, t2).ratio()

    holes_of = lambda kk: [(kk[i][1], kk[i + 1][0]) for i in range(len(kk) - 1)]

    r = build_and_transcribe(ks)
    if r < 0 or r >= thr_ok:
        return ks, r, ""
    best_r, best_ks = r, list(ks)
    for _rd in range(max_rounds):
        cand_scores = []
        for h in holes_of(best_ks):
            sc = 0.0
            for w in words:
                ws, we = float(w.get("start") or 0), float(w.get("end") or 0)
                wl = we - ws
                if wl <= 0.06:
                    continue
                frac = (min(h[1], we) - max(h[0], ws)) / wl
                if 0.10 < frac < 0.92:
                    sc = max(sc, 0.4 + abs(frac - 0.5))
            if sc > 0:
                cand_scores.append((sc, h))
        cand_scores.sort(key=lambda x: -x[0])
        improved = False
        for sc, h in cand_scores[:3]:
            trial = []
            done = False
            for i in range(len(best_ks)):
                s0, e0 = best_ks[i]
                if not done and i + 1 < len(best_ks)                         and abs(e0 - h[0]) < 0.03 and abs(best_ks[i + 1][0] - h[1]) < 0.03:
                    trial.append((s0, best_ks[i + 1][1]))
                    done = True
                    continue
                if done and False:
                    continue
                trial.append((s0, e0))
            if not done:
                continue
            trial = _edl_union(trial)
            r_t = build_and_transcribe(trial)
            if r_t > best_r + 1e-4:
                best_r, best_ks = r_t, trial
                improved = True
                break
        if best_r >= thr_ok or not improved:
            break
    note = ""
    if best_r < thr_ok:
        note = f"edl_fluency_low(r={best_r:.2f})"
    return best_ks, best_r, note


def _strip_tok(t: str) -> str:
    return "".join(ch for ch in (t or "") if "\u4e00" <= ch <= "\u9fff"
                   or (ch.isascii() and ch.isalnum()))


def _tokens_of(words):
    """[(strip后的token文本, start, end)]，过滤空 token。"""
    out = []
    for w in words:
        t = _strip_tok(str(w.get("word", w.get("text", ""))))
        try:
            s, e = float(w.get("start") or 0), float(w.get("end") or 0)
        except Exception:
            continue
        if t and e > s:
            out.append((t, s, e))
    return out


def _repeat_evidence(words, a: float, b: float) -> bool:
    """文本重复证据（任一命中即可佐证声学口吃自动剪切）：
    ①窗口内相邻同文 token；
    ②窗口内出现「n-gram 镜像」（AB AB / ABC ABC，n≤4）；
    ③前 token 是后 token 的单字前缀（[我,] + [我觉得] —— Whisper 流利化的残迹）。"""
    tk = [(t, s, e) for (t, s, e) in _tokens_of(words) if e > a - 0.45 and s < b + 0.45]
    toks = [t for t, _, _ in tk]
    for i in range(len(toks) - 1):
        if toks[i] == toks[i + 1]:
            return True
        if len(toks[i]) == 1 and toks[i + 1].startswith(toks[i]):
            return True
    for L in (2, 3, 4):
        for i in range(len(toks) - 2 * L + 1):
            if toks[i:i + L] == toks[i + L:i + 2 * L]:
                return True
    return False


def _inside_overlong_token(words, a: float, b: float) -> bool:
    """剪点主要落在一个「超长单字 token」内 —— Whisper 把重复音节合并流利化时
    常产生这种异常宽的 token（如三连『先』被并入 [把]，0.86s）。此为隐藏型口吃证据。"""
    best, best_ov = None, 0.0
    for (t, s, e) in _tokens_of(words):
        ov = min(b, e) - max(a, s)
        if ov > best_ov:
            best, best_ov = (t, s, e), ov
    if best is None or best_ov <= 0:
        return False
    t, s, e = best
    return len(t) <= 2 and (e - s) >= 0.55


def _detect_token_repeats(words, max_span_tokens: int = 10,
                          min_gap_between: float = 1.2):
    """词/短语级重复检测（在 ASR 词表上工作）：
    对 n ∈ {1..4} 的连续 token 组，若其后紧跟完全相同的组（间隔 ≤ min_gap_between），
    则删除前一组的整段时间、保留后一组。返回 [(s,e)]。"""
    tk = _tokens_of(words)
    ivs = []
    i = 0
    n = len(tk)
    while i < n:
        hit = None
        for L in (1, 2, 3, 4):
            j = i + L
            if j + L > n or L * 2 > max_span_tokens:
                continue
            gap = tk[j][1] - tk[j - 1][2]
            if gap < -0.05 or gap > min_gap_between:
                continue
            if [x[0] for x in tk[i:j]] == [x[0] for x in tk[j:j + L]]:
                hit = (tk[i][1], tk[j - 1][2])
                break
        if hit:
            s, e = hit
            if e - s >= 0.12:
                ivs.append((round(s, 4), round(e, 4)))
            # 命中：删除前一组、跳过它；重复组成为新的起点继续扫（支持 链式×3）
            i += L
        else:
            i += 1
    return _union(ivs)


def analyze(input_path: str, opts: dict) -> dict:
    """
    口播剪辑决策层：分析媒体文件，返回编辑计划（JSON 友好 dict）。

    参数
    ----
    input_path : str
        输入音频/视频文件路径。
    opts : dict
        选项（均可选，含默认值）：
          modelSize   (str,  默认 'small') whisper 模型大小（P0-A：由 'base' 提升）
          useDemucs   (bool, 默认 False)   是否用 Demucs 做人声分离（分析辅助）
          vadThreshold(float, 默认 0.25)    Silero VAD 阈值
          minGap      (float, 默认 0.18)    最短可切除静音间隙（s）
          wordPad     (float, 默认 0.04)    词保护边距（s）
          fillers     (bool, 默认 True)     是否删除填充词
          keepNonspeech(bool, 默认 True)    保留非语音内容：True=保留背景音乐/环境音，
                                            仅删语音内填充/呼吸；False=仅保留 VAD 语音段（紧凑旁白）
          trimSilence(bool, 默认 True)      裁剪首尾低能量静音段（基于原始 16k 包络）
          exclude     (list, 默认 [])       人工排除区 [[s,e], ...]（并入删除集）
          denoise     (bool, 默认 False)    P0-B：True 时在检测前对 16k 音频做真实降噪
                                            （优先 ONNX 权重，缺失则轻量高通+噪声门），
                                            并把标志透传给 Rust 生成阶段（declick）
          pauseCompress(bool, 默认 True)    P1：暂停压缩优先——长停顿压到 targetPause
                                            而非硬删（源空间 keepSegments 不变，
                                            压缩结果经 keepSegmentsOut 输出）
          targetPause (float, 默认 0.35)    软停顿压缩目标长度（s）
          rateWindow  (float, 默认 3.0)     语速统计滑窗长度（s）
          deess/normalize : 仅被 Rust 生成阶段使用，analyze 忽略

    返回（契约，必须包含以下键）
    ----------------------------------------------
      duration        : float   媒体时长（秒）
      sampleRate      : int     16000
      words           : [{word,start,end}, ...]
      keepSegments    : [[s,e], ...]  升序、非重叠、在 [0,duration] 内
      detail          : [{type,start,end,flag_disfluency,gap_type,conf,src}, ...]
                        每段删除区的类型化描述（后 4 个为 §5.5 契约字段，P1 检测器填充）
      totalRemovedSec : float
      ratio           : float   0..1
      separated       : bool    是否成功做了 Demucs 声源分离
      warnings        : [str]   非致命告警列表（可能为空）
      warning         : str     首个告警（仅当有告警时存在）；
                                'asr_failed_fallback_to_vad' = ASR 失败已走 VAD 兜底
      asr             : dict    {status, words, cloudWords, modelSize}
      denoise         : bool    本次是否请求降噪（透传给 Rust assemble 决定 declick）
      pauseCompress   : bool    是否启用暂停压缩优先
      keepSegmentsOut : [[s,e], ...]  输出时间轴保留段（暂停压缩后；pauseCompress=False
                                     时等于 keepSegments）。待前端/assemble 消费以生效
      outputDuration  : float   输出总时长（<= duration，停顿被压缩）
      speakingRate    : dict   {overall_cps, median_cps, windows, anomalies, char_count}
    分离成功时额外返回（可选键）：
      vocalPath       : str    人声 stem 路径（44.1k，已缓存到 .aicut_speech）
      accompPath      : str    伴奏 stem 路径（no_vocals，44.1k）
      musicSegments   : [[s,e], ...]  非语音但含音乐/环境音的区间（纯伴奏桥接段，gap 音乐保留）
    """
    opts = opts or {}

    # P0-A：默认模型由 'base' → 'small'（词边界更准），仍可被前端 opts 覆盖
    model_size = opts.get("modelSize", "small")
    use_demucs = bool(opts.get("useDemucs", False))
    vad_threshold = float(opts.get("vadThreshold", 0.25))
    min_gap = float(opts.get("minGap", 0.18))
    word_pad = float(opts.get("wordPad", 0.04))
    do_fillers = bool(opts.get("fillers", True))
    keep_nonspeech = bool(opts.get("keepNonspeech", True))
    trim_silence = bool(opts.get("trimSilence", True))
    exclude = opts.get("exclude", []) or []

    # ── 泛化增强：可选参数（均带合理默认，不改变默认行为）──
    # language=None → faster-whisper 自动检测（支持英文 / 中英混说 / 方言样本）
    language = opts.get("language", None)
    vad_min_speech_ms = int(opts.get("vadMinSpeechMs", 80))
    vad_min_silence_ms = int(opts.get("vadMinSilenceMs", 80))
    vad_speech_pad_ms = int(opts.get("vadSpeechPadMs", 40))
    # neg_threshold=None → 用 silero 默认（=vadThreshold）
    vad_neg_threshold = opts.get("vadNegThreshold", None)
    if vad_neg_threshold is not None:
        vad_neg_threshold = float(vad_neg_threshold)
    transient_crest_thr = float(opts.get("transientCrestThr", 4.0))
    transient_max_dur = float(opts.get("transientMaxDur", 0.12))
    # 声音事件检测器（独立于 VAD）的可调钩子，均带合理默认，不改变默认行为
    cough_onset_factor = float(opts.get("coughOnsetFactor", 4.5))
    cough_min_voiced = float(opts.get("coughMinVoiced", 0.08))
    tonal_flat_thr = float(opts.get("tonalFlatThr", 0.12))
    tonal_max_dur = float(opts.get("tonalMaxDur", 0.6))
    # P0-C：声音事件安全阀的「整段不删」重叠比例阈值（越大越敢删词外部分）
    event_overlap_keep = float(opts.get("eventOverlapKeepRatio", 0.5))
    # P0-A：ASR 设备 / 云端词级通道开关（无 key 时自动跳过）
    asr_device = opts.get("asrDevice", None)
    use_cloud_words = bool(opts.get("cloudWordAlign", True))

    # P1：暂停压缩优先 + 语速统计（纯逻辑，默认开启）。
    # 源空间 keepSegments 不变（Rust assemble 默认仍按源硬删），
    # 压缩结果经 keepSegmentsOut 增量输出，待 assemble 消费。
    pause_compress = bool(opts.get("pauseCompress", True))
    target_pause = float(opts.get("targetPause", 0.35))
    rate_window = float(opts.get("rateWindow", 3.0))

    # ② 副语言事件检测开关（PANNs 帧级 SED + Respiro 呼吸专项）。
    # 默认开启；权重缺失时对应检测器自动 no-op 降级。
    do_sed = bool(opts.get("sedEvents", True))
    sed_threshold = float(opts.get("sedThreshold", 0.5))
    do_respiro = bool(opts.get("respiroBreath", True))
    respiro_thr = float(opts.get("respiroThreshold", 0.35))
    do_stutter = bool(opts.get("stutterDetect", True))
    stutter_threshold = float(opts.get("stutterThreshold", 0.5))

    # P0-B：denoise 真正生效（在检测前对 16k 音频降噪）；
    # deess/normalize 仍仅由 Rust 生成阶段使用，analyze 忽略。
    do_denoise = bool(opts.get("denoise", False))
    denoise_quality = opts.get("denoiseQuality", "standard")
    # #7 DFN3 mask 软化（高 SNR 保留干净语音）；阈值经 UI 微调听感
    mask_soften = bool(opts.get("maskSoften", True))
    mask_soften_floor = float(opts.get("maskSoftenFloor", 0.5))
    warnings_out = []

    # 临时工作目录（用完即清）
    tmp = tempfile.mkdtemp(prefix="aicut_se_")
    try:
        base = os.path.splitext(os.path.basename(input_path))[0]

        # ── 准备: 提取 16k 单声道 WAV ──
        wav16 = os.path.join(tmp, f"_work_{base}.wav")
        _run_ffmpeg(["-i", input_path, "-vn", "-ac", "1", "-ar", "16000", wav16])
        au, sr = _read_wav(wav16)
        dur = len(au) / sr
        if dur <= 0:
            raise RuntimeError("无法获取媒体时长（音频为空或解码失败）")
        print(f"[准备] {dur:.1f}s, 16kHz mono", flush=True)

        # ── [1] Demucs 声源分离（可选，失败回退原音频）──
        # cache_dir：持久目录（analyze 负责创建），跨运行缓存 44.1k stem
        cache_dir = os.path.join(os.path.dirname(input_path), ".aicut_speech")
        os.makedirs(cache_dir, exist_ok=True)

        work_wav = wav16
        voice = accomp = None
        separated = False
        if use_demucs:
            print("[1/6] Demucs 声源分离…", flush=True)
            voice, accomp = neural_separate(wav16, tmp, cache_dir)
            if voice and accomp:
                # 把 44.1k 人声 resample 成 16k 单声道供后续分析（音乐不进检测）
                work16 = os.path.join(tmp, "_work_vocals.wav")
                _run_ffmpeg(["-i", voice, "-ac", "1", "-ar", "16000", work16])
                work_wav = work16
                separated = True
                print("  [OK] 分离成功：分析在 16k 人声上做，音乐作为独立 stem 保留", flush=True)
            else:
                print("  跳过（Demucs 不可用），使用原始音频", flush=True)
        else:
            print("[1/6] 跳过 Demucs", flush=True)

        # ── [1b] 降噪（P0-B）：opts.denoise=True 时在检测前对 16k 音频降噪 ──
        # 降噪后的音频既进 ASR 也进各声学检测器（噪声底更低 → 事件 onset 更干净）；
        # 失败一律 no-op 降级 + warning，绝不阻断分析。
        denoise_method = "none"
        enhanced_audio_path = ""
        if do_denoise:
            print("[1b] 降噪…", flush=True)
            dn_path = os.path.join(tmp, "_work_denoised.wav")
            ok_dn, denoise_method, dn_warn = denoise_wav(
                work_wav, dn_path, quality=denoise_quality,
                mask_soften=mask_soften, mask_soften_floor=mask_soften_floor)
            if ok_dn:
                work_wav = dn_path
                # 「干净人声直接入片」：把降噪波形持久化到源文件旁并随结果返回；
                # Rust 组装端检测到 enhancedAudioPath 时用它重建成片音轨（波形与源
                # 时间轴零平移对齐）。标准档(DFN3)走全带宽 48k 通道（保留齿音/气声/
                # 泛音），高质量档(FRCRN)仅 16k 维持原样；失败回退、不阻断分析。
                enhanced_audio_path, fb_warn = _persist_enhanced_audio(
                    input_path, dn_path, denoise_method,
                    mask_soften=mask_soften, mask_soften_floor=mask_soften_floor)
                if fb_warn:
                    warnings_out.append(fb_warn)
                    print(f"  [WARN] {fb_warn}", flush=True)
                print(f"  [OK] 降噪完成（{denoise_method}）", flush=True)
            else:
                print(f"  [SKIP] 降噪未生效（{dn_warn}），使用原音频", flush=True)
            if dn_warn:
                warnings_out.append(dn_warn)

        # ── [2] Whisper 转写 ──
        print("[2/6] Whisper 转写…", flush=True)
        words, _, _, asr_status = transcribe(work_wav, model_size, language,
                                             device=asr_device,
                                             cloud_words=use_cloud_words)
        print(f"  {len(words)} 个词 (asr={asr_status})", flush=True)
        # P0-D：区分「ASR 失败」与「真的无语音」。
        #   failed → 词不可信，必须显式走 VAD-only 兜底并回告前端；
        #   empty  → 模型跑通但确实没词（纯音乐/静音），保持原行为，仅信息性告警。
        asr_failed = (asr_status == "failed")
        if asr_failed:
            warnings_out.append("asr_failed_fallback_to_vad")
            print("  [WARN] ASR 失败 → 走 VAD-only 保守兜底（不做词级删除）", flush=True)
        elif asr_status == "empty":
            warnings_out.append("asr_no_words")

        # ── [3] VAD ──
        print("[3/6] VAD 语音检测…", flush=True)
        try:
            speech_regs = vad_speech_regions(
                work_wav, vad_threshold,
                min_speech_ms=vad_min_speech_ms,
                min_silence_ms=vad_min_silence_ms,
                speech_pad_ms=vad_speech_pad_ms,
                neg_threshold=vad_neg_threshold,
            )
            print(f"  {len(speech_regs)} 个语音段", flush=True)
        except Exception as e:  # ImportError / 缺权重等 → 整段视为语音
            print(f"  silero-vad 不可用({e})，退化为整段", flush=True)
            speech_regs = [(0.0, dur)]

        # ── [4] 多层噪声检测 ──
        if asr_failed:
            # P0-D：ASR 失败 → 词不可信，任何依赖词的检测都可能级联误删，
            # 这里显式退化为 VAD-only 保守路径：只用 人工排除 + 首尾裁剪
            # （keepNonspeech=False 时再叠加「仅保留 VAD 语音段」），
            # 并已在上面写入 warning='asr_failed_fallback_to_vad' 告知前端。
            print("[4/6] 跳过噪声检测（ASR 失败 → VAD-only 兜底）", flush=True)
            _token_reps, _suggests = [], []
            text_fillers = []
            gap_breath = []
            transients = []
            cough_events = []
            tonal_events = []
            sound_events = []
            intra_fillers = []
            isolated = []
            sed_events = []
            respiro_events = []
            stutter_events = []
            # 唯一保留的删除来源：VAD 语音段之外、能量确为底噪的长静音间隙
            # （不依赖词，删了也不可能切到语音；音乐/环境音被能量门挡住）。
            vad_sil = _vad_only_silence(work_wav, speech_regs, dur,
                                        min_sil=max(min_gap, 0.35))
            print(f"  VAD-only 静音间隙: {len(vad_sil)} 段", flush=True)
        else:
            print("[4/6] 多层噪声检测…", flush=True)
            vad_sil = []

            # 4a. 文本填充词
            text_fillers = detect_fillers(words, word_pad) if do_fillers else []
            print(f"  4a. 文本填充词: {len(text_fillers)} 段", flush=True)

            # 4b. 孤立段填充词/噪声
            isolated = detect_isolated_fillers(work_wav, words, speech_regs)
            print(f"  4b. 孤立段填充/噪声: {len(isolated)} 段", flush=True)

            # 4c/4d. 基于 VAD 间隙的呼吸/瞬态检测
            gaps = _complement(speech_regs, dur, min_keep=0.0)
            gap_breath = detect_gap_breath(work_wav, gaps, words, word_pad=word_pad)
            print(f"  4c. 间隙气声/咳嗽: {len(gap_breath)} 段", flush=True)
            transients = detect_transients(
                work_wav, gaps, words, word_pad=word_pad,
                crest_thr=transient_crest_thr, max_dur=transient_max_dur,
            )
            print(f"  4d. 瞬态/咂嘴: {len(transients)} 段", flush=True)

            # 4e/4f. 非语音声音事件（独立于 VAD，扫全音频，补抓被 VAD 吸收的咳嗽
            #         / 语音段内的纯音提示音）。这些事件可能短于 minGap 但确实该删，
            #         因此不套 _apply_min_gap。
            cough_events = detect_cough(work_wav, words, word_pad=word_pad,
                                        onset_factor=cough_onset_factor,
                                        min_voiced=cough_min_voiced,
                                        vad_regs=speech_regs,
                                        overlap_keep_ratio=event_overlap_keep)
            print(f"  4e. 咳嗽/清嗓(浊音爆发): {len(cough_events)} 段", flush=True)
            tonal_events = detect_tonal_sfx(work_wav, words, word_pad=word_pad,
                                            flat_thr=tonal_flat_thr, max_dur=tonal_max_dur,
                                            vad_regs=speech_regs,
                                            overlap_keep_ratio=event_overlap_keep)
            print(f"  4f. 提示音/纯音事件: {len(tonal_events)} 段", flush=True)
            sound_events = _union(cough_events + tonal_events)

            # 对声学类删除区应用 minGap 下限（太短不切）；声音事件不套（见上）
            isolated = _apply_min_gap(isolated, min_gap)
            gap_breath = _apply_min_gap(gap_breath, min_gap)
            transients = _apply_min_gap(transients, min_gap)

            # 4g/4h. ② 副语言事件（独立于 VAD，扫全音频，补抓笑声/叹息/吸气等
            #        与呼吸专项）。副语言事件可能短于 minGap 但确实该删，不套 min_gap。
            sed_events = detect_panns_sed(work_wav, words, word_pad=word_pad,
                                         threshold=sed_threshold) if do_sed else []
            print(f"  4g. 副语言事件(笑声/叹息/…): {len(sed_events)} 段", flush=True)
            respiro_events = detect_respiro(work_wav, words, word_pad=word_pad,
                                            thr=respiro_thr) if do_respiro else []
            print(f"  4h. 呼吸专项(Respiro): {len(respiro_events)} 段", flush=True)
            stutter_events = detect_stutter(work_wav, words, word_pad=word_pad,
                                            threshold=stutter_threshold) if do_stutter else []
            # [EDL-e] 宁缺毋滥硬原则：口吃/卡顿类一律【不自动剪切】。
            # 剪断连续语流必然在接缝处破坏韵律——当前技术（剪贴式编辑）无法保证
            # 接缝自然，因此全部降级为「建议」事件：仅标记供人工确认，
            # 用户可逐个点「改为保留/改为删除」。技术突破前 autoCutStutter 默认 False。
            _auto_cut_stutter = bool(opts.get("autoCutStutter", False))
            _token_reps = []
            _suggests = list(stutter_events)
            _kept_reps = []
            if _auto_cut_stutter and words:
                _token_reps = _detect_token_repeats(words)
                for _iv in stutter_events:
                    _ev = _repeat_evidence(words, *_iv) \
                          or _inside_overlong_token(words, *_iv)
                    (_kept_reps if _ev else _suggests).append(_iv)
                _suggests = [iv for iv in _suggests
                             if not any(a <= s and e <= b + 0.05
                                        for (a, b) in _kept_reps)]
                stutter_events = _union(_kept_reps + _token_reps)
            else:
                stutter_events = []
            print(f"  4i. 口吃/重复: {'自动 ' + str(len(stutter_events)) + ' 段' if _auto_cut_stutter else '全部转建议（宁缺毋滥）'}"
                  f"｜建议 {len(_suggests)} 段", flush=True)

            # 初始删除集 → 初始保留段
            init_remove = _union(text_fillers + isolated + gap_breath + transients
                                 + sound_events + sed_events + respiro_events
                                 + stutter_events)
            init_keep = _complement(init_remove, dur, min_keep=0.0)

            # 4f. 保留段内部未保护区域（词前紧、词后松）
            pad_head = word_pad
            pad_tail = 0.25
            intra_fillers = detect_intra_keep(work_wav, init_keep, words,
                                              pad_head=pad_head, pad_tail=pad_tail)
            intra_fillers = _apply_min_gap(intra_fillers, min_gap)
            if intra_fillers:
                print(f"  4f. 段内未保护区填充/噪声: {len(intra_fillers)} 段", flush=True)

        # 人工排除区（并入删除集，类型 manual_exclude）
        manual = []
        for iv in exclude:
            try:
                s, e = float(iv[0]), float(iv[1])
            except Exception:
                continue
            s = max(0.0, min(s, dur))
            e = max(0.0, min(e, dur))
            if e > s:
                manual.append((s, e))
        manual = _union(manual)

        _seam_spans = []
        # ── [EDL-a] 碎片预算：语流内「洞」数超过预算时，按证据最弱类逐步整体回退
        # （宁留瑕疵不碎韵律）。语义驱动类——文本填充词 / 口吃 / 手动排除 /
        # 段内填充——永不回退；maxHolesPerMin<=0 可整体禁用。──
        _env_g, _fs_g = _env_rms_grid(au, sr)

        def _edl_hole_count():
            _u = _union(list(text_fillers) + list(gap_breath) + list(stutter_events)
                        + list(manual) + list(vad_sil) + list(intra_fillers)
                        + list(sound_events) + list(sed_events) + list(respiro_events)
                        + list(transients) + list(isolated))
            _kk = _complement(_u, dur, min_keep=0.0)
            # 只统计「语流内洞」（两侧均为发声）——句间停顿不触发预算回退
            return len(_edl_interior_holes([(a, b) for a, b in _kk], _env_g, _fs_g))

        _mpm = float(opts.get("maxHolesPerMin", 10))
        _budget = max(5, int(round(dur / 60.0 * _mpm))) if _mpm > 0 else None
        if _budget is not None:
            _dropped = []
            while True:
                if _edl_hole_count() <= _budget:
                    break
                try:
                    if locals().get("tonal_events"):
                        tonal_events = []
                        sound_events = _union(list(cough_events))
                        _dropped.append("tonal")
                    elif transients:
                        transients = []
                        _dropped.append("transient")
                    elif respiro_events:
                        respiro_events = []
                        _dropped.append("respiro")
                    elif isolated:
                        isolated = []
                        _dropped.append("isolated")
                    else:
                        break
                except NameError:
                    break
            if _dropped:
                print(f"  [EDL] 碎片预算触发，回退类别: {_dropped} → 洞数={_edl_hole_count()}", flush=True)

        # ── 合并所有删除区 → 最终保留段 ──
        # keepNonspeech=True（默认）：删除集的补集 = 保留背景音乐/环境音，仅删语音内噪声
        # keepNonspeech=False（紧凑）：仅保留 VAD 语音段，段内再挖除各类填充/噪声，
        #   非语音间隙（静音+音乐）整体丢弃。
        # vad_sil 仅在 ASR 失败兜底路径非空（VAD-only 静音间隙）。
        if keep_nonspeech:
            all_remove = _union(text_fillers + isolated + gap_breath +
                                transients + intra_fillers + sound_events +
                                sed_events + respiro_events +
                                stutter_events +
                                vad_sil + manual)
            if os.environ.get("AICUT_KEEP_DEBUG"):
                import sys as _s
                _hit = [(round(s,2), round(e,2)) for s,e in _union(all_remove) if e > 12.4 and s < 14.6]
                print(f"[keep-debug] all_remove@12.4-14.6: {_hit}", file=_s.stderr)
            keep = _complement(all_remove, dur, min_keep=0.0)
        else:
            keep = []
            for (vs, ve) in speech_regs:
                rm = [(s, e) for (s, e) in
                       (text_fillers + isolated + gap_breath + transients +
                       intra_fillers + sound_events + sed_events + respiro_events +
                       stutter_events +
                       manual)
                      if e > vs and s < ve]
                if os.environ.get("AICUT_KEEP_DEBUG"):
                    _near = [(round(s2,2), round(e2,2)) for s2,e2 in rm if e2>12.4 and s2<14.6]
                    _hit = [x for x,_n in zip([1],_near)] and any(e2>13.21 and s2<13.43 for s2,e2 in _near)
                    import sys as _s
                    print(f"[keep-debug] reg {round(vs,2)}-{round(ve,2)} rm@12.4-14.6={_near} 目标在rm={bool(_near) and any(1 for _a,_b in _near if _b>13.21 and _a<13.43)}", file=_s.stderr)
                if not rm:
                    keep.append((vs, ve))
                    continue
                # ⚠️ 坐标修正：rm 为绝对时间，_complement 需相对本区间的时长坐标；
                # 直接混用会算出 vs+绝对值 的鬼影跨度，把区域内本应删除的洞全部封死。
                rm_rel = []
                for es, ee in rm:
                    rs_, re_ = max(es, vs) - vs, min(ee, ve) - vs
                    if re_ - rs_ > 1e-4:
                        rm_rel.append((rs_, re_))
                seg = _complement(_union(rm_rel), ve - vs, min_keep=0.0)
                keep.extend((vs + ss, vs + ee) for (ss, ee) in seg)
            keep = _union(keep)

        # 兜底：若全部被删，则保留整段（避免空输出）
        if not keep:
            keep = [(0.0, dur)]

        # ── [D] 首尾静音裁剪(trimSilence) ──
        # 用原始 16k 音频(wav16)包络估计首尾静音边界；无论是否分离都用原始音频。
        head_trim, tail_trim = _head_tail_trim(wav16, silence_thr=0.008, pad=0.05)
        if trim_silence:
            trimmed = []
            for s, e in keep:
                ns = max(float(s), head_trim)
                ne = min(float(e), dur - tail_trim)
                if ne - ns > 1e-3:
                    trimmed.append((ns, ne))
            if trimmed:
                keep = _union(trimmed)

        # 钳制到 [0, dur] 并丢弃零长段
        keep_clamped = []
        for s, e in keep:
            s = max(0.0, min(float(s), dur))
            e = max(0.0, min(float(e), dur))
            if e - s > 1e-4:
                keep_clamped.append((s, e))
        keep = _union(keep_clamped)
        if not keep:
            keep = [(0.0, dur)]

        # ── [EDL-b] 碎片保护 + 微洞撤销 + 剪点能量谷吸附 ──
        # 洞太多太碎会摧毁韵律（听感＝句子被切碎）；过短保留段无语义价值并入洞、
        # 过窄的洞不值得开两刀直接撤销、剪点吸附能量谷让接缝落在自然边界上。
        if not os.environ.get("AICUT_EDL_OFF"):
            try:
                _src_words0 = locals().get("words") or []
                def _prot_word(s, e, _w=_src_words0):
                    for w in _w:
                        ws, we = float(w.get("start") or 0), float(w.get("end") or 0)
                        wl = we - ws
                        if wl <= 0.06:
                            continue
                        ov = min(e, we) - max(s, ws)
                        if ov >= 0.5 * wl:
                            return True
                    return False
                _min_frag = float(opts.get("minKeepFragment", EDL_ABSORB_FRAG_DEFAULT))
                _shift = float(opts.get("valleySnapMs", EDL_SNAP_MAX_SHIFT * 1000.0)) / 1000.0
                _ks = [(float(s), float(e)) for s, e in _union(keep)]
                _n0 = len(_ks)
                _ks = _edl_absorb_short_keeps(_ks, _min_frag, protect=_prot_word)
                _ks = _edl_drop_micro_holes(_ks, float(opts.get("microHoleSec", EDL_MICRO_HOLE_DEFAULT)))
                _ks = _edl_snap_edges([(s, e) for s, e in _ks], _env_g, _fs_g, max_shift=_shift)
                _ks = _edl_union(_ks)
                if _ks:
                    keep = _ks
                print(f"  [EDL] 保留段 {_n0}→{len(keep)}（吸收碎片/撤微洞/谷吸附）", flush=True)
            except Exception as _e:  # EDL 失败不影响主流程
                warnings_out.append(f"edl_failed:{_e}")

        # ── [EDL-c] 整词化边界：清掉落在词中间的「半个字」残音 ──
        _src_words = locals().get("_src_words0") or []
        if os.environ.get("AICUT_EDL_DEBUG"):
            try:
                print(f"[EDL-dbg] type(words)={type(words)} len={len(words) if hasattr(words,'__len__') else '-'}", flush=True)
            except Exception as _de:
                print(f"[EDL-dbg] words probe err {_de}", flush=True)
        if _src_words and not os.environ.get("AICUT_EDL_OFF"):
            try:
                _ks2 = [(float(s), float(e)) for s, e in _union(keep)]
                _n2 = len(_ks2)
                _ks2 = _edl_whole_word_edges(_ks2, _src_words)
                _ks2 = _edl_union(_ks2)
                if _ks2:
                    keep = _ks2
                print(f"  [EDL] 整词化边界 {_n2}→{len(keep)}", flush=True)
            except Exception as _e:
                if os.environ.get("AICUT_EDL_DEBUG"):
                    import traceback as _tb
                    _tb.print_exc()
                warnings_out.append(f"edl_words_failed:{_e}")

        # 候选事件总集（语义/声学检测产物）：这些位置的洞一律视为「动过语流」
        _cand_ivs = _union(text_fillers + isolated + gap_breath + transients
                           + intra_fillers + sound_events + sed_events
                           + respiro_events + stutter_events)
        gap_breath_kept = list(gap_breath)   # 结构性呼吸间隙不算语义剪切

        # ── [EDL-g] 接缝安全阀（宁缺毋滥硬原则的最终执行者）──
        # 任何「两侧均为发声」的洞一律回填＝连续语流内部不做任何自动剪切。
        # 理由：剪断连续浊音必然在接缝处破坏韵律（pitch/共振峰/节奏跳变），
        # 这已被多轮用户验收证伪。被回填区间以 seam_suggest 建议事件呈现，
        # 用户在时间轴上试听后可人工决定删除；句间停顿与贴静音的事件不受影响。
        if not bool(opts.get("allowInteriorCuts", False)) \
                and not os.environ.get("AICUT_EDL_OFF"):
            try:
                _ksf = [(float(a), float(b)) for a, b in _union(keep)]
                # 严格判定：只有当洞的左右剪点外侧都落在安静处（120ms 窗内
                # 发声帧占比 <10%）时才允许保留自动剪切；任何一侧接语音都回填。
                _peak = float(np.max(_env_g)) + 1e-12 if _env_g is not None else 0.0
                _w = max(1, int(0.12 / _fs_g))
                _nf = len(_env_g) if _env_g is not None else 0

                def _unsafe(ha, hb):
                    """洞与任何「语义/声学检测事件」重叠 → 视为动过语流，
                    回填并转建议。纯停顿/静音结构洞（无事件覆盖）安全放行。"""
                    return any(min(hb, ce) - max(ha, cs) > 0.02
                               for cs, ce in _cand_ivs)


                _interior = [(a, b) for a, b in
                             [(_ksf[i][1], _ksf[i + 1][0]) for i in range(len(_ksf) - 1)]
                             if b - a > 1e-3 and _unsafe(a, b)]
                if _interior:
                    for (ha, hb) in _interior:
                        for i in range(len(_ksf) - 1):
                            if abs(_ksf[i][1] - ha) < 0.05 \
                                    and abs(_ksf[i + 1][0] - hb) < 0.05:
                                _ksf[i] = (_ksf[i][0], _ksf[i + 1][1])
                                _ksf.pop(i + 1)
                                break
                    keep = _edl_union(_ksf)
                    _seam_spans.extend([(round(ha, 4), round(hb, 4))
                                        for ha, hb in _interior])
                    print(f"  [EDL] 接缝安全阀：回填 {len(_interior)} 个语流内洞"
                          f"（连续语流内不自动剪切，转建议）", flush=True)
            except Exception as _e:
                warnings_out.append(f"edl_seam_failed:{_e}")

        # 词界避让：防止结构性剪点切入词起音
        _sw = locals().get("_src_words0") or []
        if _sw and not os.environ.get("AICUT_EDL_OFF"):
            try:
                keep = _edl_union(_edl_retract_to_word_edges(
                    [(float(s), float(e)) for s, e in _union(keep)], _sw))
            except Exception as _e:
                warnings_out.append(f"edl_retract_failed:{_e}")

        # ── [EDL-d] 流畅度守卫：剪辑后重转写比对，嫌疑洞自动回退 ──
        if _src_words and bool(opts.get("fluencyGuard", True)) \
                and not os.environ.get("AICUT_EDL_OFF"):
            try:
                _kf, _gr, _gn = _edl_fluency_guard(au, sr, [(float(s), float(e)) for s, e in _union(keep)],
                                                   _src_words, tmp,
                                                   model_size=str(opts.get("modelSize", "small")),
                                                   language=locals().get("language"))
                if _kf:
                    if len(_kf) != len(_union(keep)):
                        print(f"  [EDL] 守卫回退 {len(_union(keep))-len(_kf)} 个洞 (r={_gr:.2f})", flush=True)
                    keep = _kf
                if _gn:
                    warnings_out.append(_gn)
            except Exception as _e:
                warnings_out.append(f"edl_guard_failed:{_e}")

        # ── [P1] 暂停压缩优先 + 语速统计（纯逻辑，增量输出）──
        # 用于「是否插暂停」判定的硬删集合：仅含真正打断语句 interior 删除的声音事件
        # （填充词/瞬态/咳嗽/手动）。isolated_noise / intra_keep / tonal_sfx 不计入——
        # 这三类在含背景音乐/哼鸣的样本里会把「自然停顿间隙」整体误判为硬删事件，
        # 导致 compress_keep_timeline 把所有间隙判成硬删、零停顿（即"机关枪"式拼接），
        # 与「暂停压缩优先」的设计目标相悖。它们仍照常参与 keep 的实际删除（见 all_remove），
        # 仅不决定是否在间隙插短暂停。gap_breath / vad_silence 本就是软停顿。
        # 副语言事件(sed_events)属离散爆发、打断语句，类比咳嗽计入硬删；
        # 呼吸(resp_breath)是软停顿，严禁进 hard_remove——否则复现机关枪 bug。
        hard_remove = _union(text_fillers + transients + cough_events
                             + sed_events + manual
                             + stutter_events)
        keep_out, output_dur, compressed = ([], 0.0, [])
        if pause_compress:
            keep_out, output_dur, compressed = compress_keep_timeline(
                keep, hard_remove, dur, target_pause)

        # ── [E] musicSegments（仅分离成功时）：保留 gap 内的音乐/环境音 ──
        # 取 [head_trim, dur - tail_trim] 内 keep 的补集得到候选 gap；
        # 若伴奏(accomp)在该区间 RMS 能量 > 0.01（真有音乐而非静音），则作为
        # 纯伴奏桥接段保留，gap 音乐不被删除。
        music_segments = []
        if separated and voice and accomp:
            try:
                au_a, sr_a = _read_wav(accomp)
                lo, hi = head_trim, dur - tail_trim
                cand = []
                cur = lo
                for s, e in _union(keep):
                    if e <= cur:
                        continue
                    if s - cur > 1e-3:
                        cand.append((cur, s))
                    cur = max(cur, e)
                if hi - cur > 1e-3:
                    cand.append((cur, hi))
                for gs, ge in cand:
                    a, b = int(gs * sr_a), int(ge * sr_a)
                    if b <= a:
                        continue
                    seg = au_a[a:b]
                    rms = float(np.sqrt(np.mean(seg ** 2)))
                    if rms > 0.01:
                        music_segments.append([float(gs), float(ge)])
            except Exception as e:
                print(f"  [WARN] musicSegments 计算失败({e})", flush=True)

        # ── detail：类型化删除明细（与 keep 互为补集）──
        detail = []
        for typ, ivs in (("text_filler", text_fillers),
                         ("isolated_noise", isolated),
                         ("gap_breath", gap_breath),
                         ("transient", transients),
                         ("intra_keep", intra_fillers),
                         ("cough", cough_events),
                         ("tonal_sfx", tonal_events),
                         ("sed_event", sed_events),
                         ("resp_breath", respiro_events),
                         ("stutter", stutter_events),
                         ("vad_silence", vad_sil),
                         ("manual_exclude", manual)):
            for s, e in ivs:
                detail.append(_mk_detail(typ, s, e))
        # P1：被压缩的软停顿（暂停压缩优先策略的可视化标记）
        for (cs, ce) in compressed:
            detail.append(_mk_detail("pause_compressed", cs, ce))
        # [EDL-g] 被接缝安全阀回填的语流内剪切 → 建议事件（人工逐个确认）
        for (s, e) in locals().get("_seam_spans") or []:
            _dsm = _mk_detail("seam_suggest", s, e)
            _dsm["note"] = "建议：此处剪断会伤韵律，请试听后人工决定是否删除"
            detail.append(_dsm)
        # [EDL-e] 口吃/卡顿类默认全部转「建议」事件展示（宁缺毋滥，不自动删）
        for (s, e) in locals().get("_suggests") or []:
            _dsg = _mk_detail("stutter_suggest", s, e)
            _dsg["note"] = "建议：在连续语流内剪断会伤韵律，请试听后人工决定是否删除"
            detail.append(_dsg)
        detail.sort(key=lambda d: d["start"])

        total_kept = sum(e - s for s, e in keep)
        total_removed = max(0.0, dur - total_kept)
        ratio = (total_removed / dur) if dur > 0 else 0.0

        print(f"  删除合计: {total_removed:.1f}s ({ratio*100:.0f}%)", flush=True)
        print(f"  保留段: {len(keep)} 段", flush=True)

        # ── 能量曲线（供前端波形/能量可视化；相对量纲，前端自行归一化）──
        _N = int(au.size)
        _pts = 300                       # 目标点数（几十~几百）
        _hop = max(1, _N // _pts)
        energy_curve = [float(round(float(np.sqrt(float(np.mean(au[i:i + _hop] ** 2)))), 6))
                        for i in range(0, _N, _hop)]

        result = {
            "duration": round(dur, 6),
            "sampleRate": 16000,
            "words": [{"word": w["word"], "start": float(w["start"]), "end": float(w["end"])}
                      for w in words],
            "keepSegments": [[float(s), float(e)] for s, e in keep],
            # detail 除 type/start/end 外补齐 §5.5 契约字段（P1 检测器覆盖）
            "detail": [{"type": d["type"],
                        "start": round(float(d["start"]), 6),
                        "end": round(float(d["end"]), 6),
                        "flag_disfluency": d.get("flag_disfluency"),
                        "gap_type": d.get("gap_type", ""),
                        "conf": d.get("conf"),
                        "src": d.get("src", "rule")} for d in detail],
            "totalRemovedSec": round(total_removed, 6),
            "ratio": round(ratio, 6),
            "separated": bool(separated),
            # P0-A/D：ASR 状态可观测（前端可据此提示"转写失败，已按 VAD 保守处理"）
            "asr": {
                "status": asr_status,
                "words": len(words),
                "modelSize": model_size,
                "cloudWords": bool(use_cloud_words),
            },
            # P0-B：denoise 标志透传 —— Rust speech_assemble 可据此启用 declick/adeclick
            "denoise": bool(do_denoise),
            "denoiseMethod": denoise_method,
            # 「干净人声直接入片」：降噪成功时为源旁的 *_denoised.wav 持久化路径（16k mono）；
            # Rust assemble 检测到该字段且文件存在时用它重建成片音轨
            "enhancedAudioPath": enhanced_audio_path,
            "assembleHints": {"declick": bool(do_denoise)},
            # P1：暂停压缩优先（输出时间轴增量）+ 语速统计
            "pauseCompress": bool(pause_compress),
            # 「真剪掉」守卫：仅当暂停压缩真的产生了更紧凑的输出时间轴（keep_out != keep）
            # 时才下发 keepSegmentsOut。恒等回退会让 Rust 暂停路径把删除区当成"插入的停顿"
            # 补成等长静音/冻结帧——删除区变哑段、总时长不缩短，与用户直觉相悖。
            "keepSegmentsOut": ([[float(s), float(e)] for s, e in keep_out]
                                if keep_out and keep_out != keep else None),
            "outputDuration": (round(output_dur, 6) if (keep_out and keep_out != keep)
                               else round(sum(e - s for s, e in keep), 6)),
            "speakingRate": speaking_rate_stats(words, dur, window=rate_window),
            "energyCurve": energy_curve,
        }
        if warnings_out:
            result["warnings"] = warnings_out
            result["warning"] = warnings_out[0]
        if separated and voice and accomp:
            result["vocalPath"] = voice
            result["accompPath"] = accomp
            result["musicSegments"] = music_segments
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def separate(input_path, opts):
    """媒体分离：音频分离(av) 或 人声分离(vocal)。返回 dict（由 bridge 写 stdout 单行 JSON）。"""
    mode = opts.get('mode')
    out_dir = os.path.join(os.path.dirname(input_path), '.aicut_speech')
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(input_path))[0]

    def probe_duration(p):
        try:
            cp = subprocess.run([FFPROBE, '-v', 'error', '-show_entries', 'format=duration',
                                 '-of', 'default=nw=1:nk=1', p],
                                capture_output=True, text=True, encoding='utf-8', errors='replace')
            s = cp.stdout.strip()
            return float(s) if s else 0.0
        except Exception:
            return 0.0

    if mode == 'av':
        v_path = os.path.join(out_dir, f"{base}_video.mp4")
        a_path = os.path.join(out_dir, f"{base}_audio.m4a")
        # 视频-only：保留视频流、去掉音轨（copy 优先，失败回退重编码）
        try:
            _run_ffmpeg(["-i", input_path, "-an", "-c:v", "copy", v_path])
        except Exception:
            _run_ffmpeg(["-i", input_path, "-an", "-c:v", "libx264", "-crf", "18",
                         "-pix_fmt", "yuv420p", v_path])
        # 音频-only：提取音轨转 aac
        _run_ffmpeg(["-i", input_path, "-vn", "-c:a", "aac", "-b:a", "192k", a_path])
        return {"videoOnlyPath": v_path, "audioOnlyPath": a_path,
                "duration": probe_duration(input_path)}

    elif mode == 'vocal':
        keep = opts.get('keep', 'vocals')          # 'vocals' | 'accomp'
        track_type = opts.get('trackType', 'audio')  # 'video' | 'audio'
        # 1) 转 16k 单声道 wav 供 demucs
        wav16 = os.path.join(out_dir, f"{base}_16k.wav")
        _run_ffmpeg(["-i", input_path, "-ac", "1", "-ar", "16000", wav16])
        # 2) demucs two-stems=vocals
        import importlib.util as _u
        if not _u.find_spec("demucs"):
            raise RuntimeError("demucs 未安装，无法做人声分离")
        work = os.path.join(out_dir, "_demucs")
        os.makedirs(work, exist_ok=True)
        env = dict(os.environ, HF_ENDPOINT="https://hf-mirror.com", HF_HUB_DISABLE_XET="1")
        cp = subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals",
                             "-n", "htdemucs", "-o", work, wav16],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            encoding='utf-8', errors='replace', env=env)
        if cp.returncode != 0:
            raise RuntimeError(f"demucs exit={cp.returncode}: {cp.stderr[-800:]}")
        # Demucs 输出子目录名 = 输入文件主名（这里是 wav16 的 base，即 <源base>_16k）
        wav_stem = os.path.splitext(os.path.basename(wav16))[0]
        got_v = os.path.join(work, "htdemucs", wav_stem, "vocals.wav")
        got_a = os.path.join(work, "htdemucs", wav_stem, "no_vocals.wav")
        if not (os.path.exists(got_v) and os.path.exists(got_a)):
            raise RuntimeError("demucs 未产出 vocals/no_vocals stem")
        stem = got_v if keep == 'vocals' else got_a
        if track_type == 'video':
            out_path = os.path.join(out_dir,
                                    f"{base}_vocals.mp4" if keep == 'vocals' else f"{base}_bg.mp4")
            _run_ffmpeg(["-i", input_path, "-i", stem, "-map", "0:v", "-map", "1:a",
                         "-c:v", "copy", "-c:a", "aac", "-shortest", out_path])
            return {"resultPath": out_path, "duration": probe_duration(out_path)}
        else:
            return {"resultPath": stem, "duration": probe_duration(stem)}
    else:
        raise ValueError(f"未知 separate mode: {mode}")


# ══════════════════════════════════════════════════════
# 命令行自测（仅 core；正式入口见 bridge.py）
# ══════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description="AIcut 口播剪辑决策层（仅分析，返回计划）")
    ap.add_argument("input", help="输入音频/视频路径")
    ap.add_argument("--model", default="small", help="Whisper 模型大小（P0-A 默认 small）")
    ap.add_argument("--denoise", action="store_true", help="检测前对 16k 音频做降噪")
    ap.add_argument("--no-demucs", action="store_true", help="跳过 Demucs 声源分离")
    ap.add_argument("--vad-threshold", type=float, default=0.25)
    ap.add_argument("--min-gap", type=float, default=0.18)
    ap.add_argument("--word-pad", type=float, default=0.04)
    ap.add_argument("--no-fillers", action="store_true", help="不删除填充词")
    ap.add_argument("--exclude", nargs="*", default=[], help="人工排除区 start,end ...")
    args = ap.parse_args()

    exclude = []
    it = iter(args.exclude)
    for a in it:
        try:
            b = next(it)
            exclude.append([float(a), float(b)])
        except StopIteration:
            break

    rep = analyze(args.input, {
        "modelSize": args.model,
        "useDemucs": not args.no_demucs,
        "vadThreshold": args.vad_threshold,
        "minGap": args.min_gap,
        "wordPad": args.word_pad,
        "fillers": not args.no_fillers,
        "denoise": args.denoise,
        "exclude": exclude,
    })
    print(json.dumps(rep, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
