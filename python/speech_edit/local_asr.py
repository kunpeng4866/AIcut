# -*- coding: utf-8 -*-
"""本地高精度 ASR + 强制对齐主路径（零出域，±0.02s）。

流水线：
  1) FunASR Paraformer（paraformer-zh, 16k）本地识别 → 中文字级文本 + 原生字级时间戳；
  2) Qwen3-ForcedAligner（官方 qwen-asr 包 Qwen3ForcedAligner）用识别文本做强制对齐 →
     字/词级时间戳，精度 ±0.02s（设计目标）。

输出对齐到 core.transcribe 的 {word,start,end} schema（源媒体绝对秒），可直接替换
whisper+cloud 兜底链。降级策略（任一环节失败均不影响主流程）：
  - Qwen3-FA 不可用 → 退回 FunASR 原生字级时间戳（仍本地、零出域，精度略低）；
  - FunASR 不可用   → 返回 ([], "failed", "") ，交由 transcribe 回退 whisper/cloud/VAD；
  - 显式禁用(AICUT_ASR_LOCAL=0) → 直接返回空，走旧链路。

许可：FunASR / Paraformer 为 ModelScope 社区_license（商用需确认）；Qwen3-FA 权重商用
需法务核实（代码可引，权重见设计文档 §10）。权重按项目资产分发惯例不入库。
"""
import os
import sys
import tempfile
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT = os.path.dirname(_HERE)                       # python/
_ASR_DIR = os.path.join(_PROJECT, "models", "asr")
_FUNASR_CACHE = os.path.join(_ASR_DIR, "modelscope_cache")
# 解析优先级：环境变量 AICUT_QWEN3FA_DIR（Electron 按「resources 优先 → userData 下载目录」注入）
# → 兜底到本模块相对路径（开发/打包内置场景）。qwen3_fa 为 1.8G，>500M 不随包，走一键补全。
_QWEN_FA_DIR = os.environ.get("AICUT_QWEN3FA_DIR") or os.path.join(_ASR_DIR, "qwen3_fa")

# ── 延迟缓存（首次调用时加载，避免 import 期硬依赖）──
_funasr_model = None
_qwen_model = None
_qwen_loaded = False

# 强制对齐文本不需要标点
_PUNCT = set("，。！？、；：\"'「」『』（）《》<>.,!?;:'\"()[]{} \t\n…—“”‘’—-")

_LANG_MAP = {
    "zh": "Chinese", "chinese": "Chinese", "cn": "Chinese",
    "en": "English", "english": "English",
    "ja": "Japanese", "jp": "Japanese",
    "ko": "Korean", "yue": "Cantonese", "cantonese": "Cantonese",
    "fr": "French", "de": "German", "it": "Italian",
    "ru": "Russian", "es": "Spanish", "pt": "Portuguese",
}


def _local_enabled() -> bool:
    """默认启用本地主路径；设 AICUT_ASR_LOCAL=0/false 可关闭（回退旧链路）。"""
    return os.environ.get("AICUT_ASR_LOCAL", "1").strip().lower() not in ("0", "false", "no")


def _cuda_ok() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _norm_text_for_align(text: str) -> str:
    """去标点/空白，仅留中英文与数字（强制对齐对标点无音频对应）。"""
    return "".join(ch for ch in text if ch not in _PUNCT)


def _load_16k_mono(wav_path: str):
    """读 wav，重采样到 16k 单声道 float32，返回 (arr, sr=16000)。"""
    import soundfile as sf
    au, sr = sf.read(wav_path, dtype="float32", always_2d=False)
    if au.ndim > 1:
        au = au.mean(axis=1)
    if sr != 16000:
        try:
            import librosa
            au = librosa.resample(au.astype(np.float32), orig_sr=sr, target_sr=16000)
        except Exception:
            # 极简线性重采样兜底
            n = int(round(len(au) * 16000 / sr))
            au = np.interp(np.linspace(0, len(au) - 1, n), np.arange(len(au)), au).astype(np.float32)
    return np.ascontiguousarray(au.astype(np.float32)), 16000


# ══════════════════════════════════════════════════════
# [1] FunASR Paraformer 本地字级识别
# ══════════════════════════════════════════════════════
def _modelscope_snapshot(repo_id: str) -> str:
    """解析 ModelScope 缓存在本地的权重快照目录（离线优先）：
    <FUNASR_CACHE>/models/<namespace--name>/snapshots/<rev>/ 。

    funasr 1.4.x 已不再注册 "paraformer-zh"/"fsmn-vad" 之类的旧版快捷名，
    直接用 repo id 会在无网/弱网/沙箱环境抛 "not registered"（进而整条本地 ASR 链路
    静默回退 whisper、Qwen3-FA 根本不跑 → "装了 Qwen3-FA 精度反而下降"的诱因）。
    故优先用本地缓存快照目录加载，缺快照时才退回 repo id 走在线下载。
    返回空串表示本地无缓存。"""
    ns_name = repo_id.replace("/", "--")
    base = os.path.join(_FUNASR_CACHE, "models", ns_name, "snapshots")
    if not os.path.isdir(base):
        return ""
    revs = [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
    if not revs:
        return ""
    # 取最新修改的快照（兼容 revision 变化）
    revs.sort(key=lambda d: os.path.getmtime(os.path.join(base, d)), reverse=True)
    return os.path.join(base, revs[0])


def _get_funasr():
    global _funasr_model
    if _funasr_model is not None:
        return _funasr_model
    try:
        os.environ.setdefault("MODELSCOPE_CACHE", _FUNASR_CACHE)
        from funasr import AutoModel
        # funasr 1.4.x 已移除 "paraformer-zh"/"fsmn-vad" 旧快捷名；改为指向本地
        # ModelScope 缓存快照（离线可用），缺失时退回 repo id 在线拉取。
        _MODEL_REPO = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
        _VAD_REPO = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
        _md = _modelscope_snapshot(_MODEL_REPO)
        _vd = _modelscope_snapshot(_VAD_REPO)
        _model_arg = _md if _md else _MODEL_REPO
        _vad_arg = _vd if _vd else _VAD_REPO
        _funasr_model = AutoModel(
            model=_model_arg,
            vad_model=_vad_arg,
            disable_update=True,
            device="cuda" if _cuda_ok() else "cpu",
        )
        return _funasr_model
    except Exception as e:
        sys.stderr.write(f"[local_asr] FunASR 加载失败({e})\n")
        _funasr_model = False  # 标记不可用，避免反复尝试
        return None


def _funasr_chars(wav_path: str):
    """返回 (chars:list[str], starts:list[float], ends:list[float]) 单位秒。

    paraformer-zh 输出 res[0]['text']（空格分隔中文）与 res[0]['timestamp']
    （[[start_ms,end_ms],...] 每字一对）。VAD 开启时 timestamp 可能为嵌套结构，
    这里做扁平化兼容。
    """
    model = _get_funasr()
    if model is None:
        return None
    try:
        au, sr = _load_16k_mono(wav_path)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            import soundfile as sf
            sf.write(tf.name, au, sr)
            tmp = tf.name
        try:
            res = model.generate(input=tmp)
            if "timestamp" not in res[0]:
                # 部分 FunASR 版本需显式开启字级时间戳
                res = model.generate(input=tmp, return_word_timestamps=True)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        if not res or "text" not in res[0]:
            return None
        text = res[0]["text"]
        chars = text.split()
        ts = res[0].get("timestamp")
        if not ts:
            return None
        # 扁平化：timestamp 可能是 [[s,e],...] 或 [[[s,e],...], ...]（逐句）
        flat = []
        for item in ts:
            if item and isinstance(item[0], (list, tuple)):
                flat.extend(item)
            else:
                flat.append(item)
        if len(flat) != len(chars):
            # 长度不一致不强行配对，退回 None（交由 Qwen3-FA 或上层兜底）
            sys.stderr.write(f"[local_asr] FunASR 字/时间戳长度不一致({len(chars)}!={len(flat)})\n")
            return None
        starts = [float(p[0]) / 1000.0 for p in flat]
        ends = [float(p[1]) / 1000.0 for p in flat]
        return chars, starts, ends
    except Exception as e:
        sys.stderr.write(f"[local_asr] FunASR 推理失败({e})\n")
        return None


# ══════════════════════════════════════════════════════
# [2] Qwen3-ForcedAligner 强制对齐（±0.02s）
#     官方 qwen-asr 包：Qwen3ForcedAligner.from_pretrained(...)
#     -> .align(audio=(arr,sr), text, language) -> List[ForcedAlignResult]
#     每个 item: .text / .start_time / .end_time（秒，3 位小数）
#     接受任意 ASR 文本做强制对齐，故上游喂 FunASR 识别文本。
# ══════════════════════════════════════════════════════
def _get_qwen_fa():
    """加载 Qwen3-ForcedAligner。权重缺失/导入失败返回 None（交由 FunASR 原生时间戳兜底）。"""
    global _qwen_model, _qwen_loaded
    if _qwen_loaded:
        return _qwen_model
    _qwen_loaded = True
    try:
        if not os.path.isdir(_QWEN_FA_DIR) or not os.listdir(_QWEN_FA_DIR):
            sys.stderr.write("[local_asr] Qwen3-FA 权重缺失，跳过强制对齐\n")
            return None
        # 鲁棒导入 qwen_asr：按"本文件所在目录下的 qwen_asr 子包"用 importlib 显式加载，
        # 不依赖 sys.path 含 speech_edit（bridge.py 会塞，但其它调用上下文不一定）。
        # 否则一旦 qwen_asr 顶层导入失败，会静默回退到 FunASR 原生粗时间戳
        # → "装了 Qwen3-FA 但精度反而下降"的诱因之一。
        import importlib.util as _iu
        _qa_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qwen_asr")
        _qa_init = os.path.join(_qa_dir, "__init__.py")
        if not os.path.isfile(_qa_init):
            sys.stderr.write("[local_asr] 未找到 qwen_asr 子包，跳过强制对齐\n")
            return None
        if "qwen_asr" not in sys.modules:
            _spec = _iu.spec_from_file_location(
                "qwen_asr", _qa_init, submodule_search_locations=[_qa_dir])
            _qam = _iu.module_from_spec(_spec)
            sys.modules["qwen_asr"] = _qam
            _spec.loader.exec_module(_qam)
        from qwen_asr import Qwen3ForcedAligner
        import torch
        dtype = torch.bfloat16 if _cuda_ok() else torch.float32
        device = "cuda:0" if _cuda_ok() else "cpu"
        _qwen_model = Qwen3ForcedAligner.from_pretrained(
            _QWEN_FA_DIR, device_map=device, dtype=dtype)
        return _qwen_model
    except Exception as e:
        sys.stderr.write(f"[local_asr] Qwen3-FA 加载失败({e})\n")
        _qwen_model = None
        return None


def _forced_align(audio: np.ndarray, sr: int, transcript: str, language: str):
    """用 Qwen3-FA 对 transcript 做强制对齐。返回 [{word,start,end}]（秒）或 None。"""
    aligner = _get_qwen_fa()
    if aligner is None:
        return None
    try:
        lang = _LANG_MAP.get((language or "zh").lower(), "Chinese")
        norm = _norm_text_for_align(transcript)
        if not norm:
            return None
        # audio 接受 (np.ndarray, sr)；包内统一重采样到 16k 单声道 float32
        results = aligner.align(audio=(audio, int(sr)), text=norm, language=lang)
        if not results:
            return None
        return _parse_qwen_ts(results)
    except Exception as e:
        sys.stderr.write(f"[local_asr] Qwen3-FA 对齐失败({e})\n")
        return None


def _parse_qwen_ts(ts):
    """解析 ForcedAlignResult -> [{word,start,end}]（秒）。"""
    out = []
    try:
        result = ts[0] if isinstance(ts, (list, tuple)) and ts else ts
        items = getattr(result, "items", None)
        if items is None:
            items = result
        for it in items:
            if hasattr(it, "text"):  # ForcedAlignItem
                w, s, e = it.text, float(it.start_time), float(it.end_time)
            elif isinstance(it, dict):
                w = it.get("text") or it.get("word") or ""
                s = float(it.get("start_time", it.get("start", 0)) or 0)
                e = float(it.get("end_time", it.get("end", 0)) or 0)
            elif isinstance(it, (list, tuple)) and len(it) >= 3:
                w, s, e = it[0], float(it[1]), float(it[2])
            else:
                continue
            out.append({"word": str(w), "start": s, "end": e})
    except Exception as e:
        sys.stderr.write(f"[local_asr] Qwen3-FA 输出解析失败({e})\n")
        return None
    return out if out else None


# ══════════════════════════════════════════════════════
# [3] 编排：FunASR 识别 → Qwen3-FA 对齐（失败回退 FunASR 原生时间戳）
# ══════════════════════════════════════════════════════
def local_transcribe(wav_path: str, language: str = None) -> tuple:
    """返回 (words, status, model_name)。

    words: [{word,start,end}]（源媒体绝对秒）；status: 'ok'/'empty'/'failed'；
    model_name: 'funasr+qwen3fa' / 'funasr' / ''。
    """
    if not _local_enabled():
        return [], "failed", ""
    try:
        chars_ts = _funasr_chars(wav_path)
        if chars_ts is None:
            return [], "failed", ""
        chars, cstarts, cends = chars_ts
        if not chars:
            return [], "empty", ""
        # 拼接成完整文本喂给强制对齐
        full_text = "".join(chars)
        au, sr = _load_16k_mono(wav_path)
        aligned = _forced_align(au, sr, full_text, language or "zh")
        if aligned:
            # 过滤掉首/尾可能出现的整段静音占位，保证 start>=0
            out = [{"word": w["word"], "start": max(0.0, float(w["start"])),
                    "end": max(0.0, float(w["end"]))} for w in aligned]
            out.sort(key=lambda x: x["start"])
            return out, "ok", "funasr+qwen3fa"
        # 回退：FunASR 原生字级时间戳（仍本地、零出域）
        out = [{"word": c, "start": max(0.0, s), "end": max(0.0, e)}
               for c, s, e in zip(chars, cstarts, cends)]
        out.sort(key=lambda x: x["start"])
        return out, "ok", "funasr"
    except Exception as e:
        sys.stderr.write(f"[local_asr] 本地 ASR 编排失败({e})\n")
        return [], "failed", ""


if __name__ == "__main__":
    if len(sys.argv) > 1:
        wp = sys.argv[1]
        words, st, model = local_transcribe(wp)
        print(f"model={model} status={st} n_words={len(words)}")
        for w in words[:20]:
            print(f"  {w['start']:.3f}-{w['end']:.3f}s  {w['word']}")
