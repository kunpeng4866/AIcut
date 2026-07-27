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

import numpy as np


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


def _has_video(path: str) -> bool:
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type",
                            "-of", "csv=p=0", path], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        return "video" in (r.stdout or "")
    except Exception:
        return False


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
# [2] Whisper 词级转写
# ══════════════════════════════════════════════════════

def transcribe(wav_path: str, model_size: str = "base", language: str = None) -> tuple:
    """返回 (words, duration, asr_model)。words: [{word,start,end}]

    language=None 时交给 faster-whisper 自动检测（泛化：支持英文 / 中英混说 / 方言样本，
    不再硬编码中文导致非中文样本词缺失 → 级联误删）。
    """
    from faster_whisper import WhisperModel
    # 先估算时长（即便转写失败也能让后续 VAD 兜底走通）
    dur = 0.0
    try:
        au, sr = _read_wav(wav_path)
        dur = len(au) / sr
    except Exception:
        dur = 0.0
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segs, info = model.transcribe(wav_path, beam_size=5, language=language, word_timestamps=True)
        words = []
        for seg in segs:
            for w in (seg.words or []):
                words.append({"word": w.word, "start": float(w.start), "end": float(w.end)})
        dur = float(getattr(info, "duration", 0) or 0) or dur
        return words, dur, model
    except Exception as e:
        sys.stderr.write(f"[transcribe] 转写失败({e})，降级为无词（仅 VAD 路径）\n")
        return [], dur, None



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


def _word_protected_ivs(words: list, vad_regs: list, word_pad: float,
                        events: list, au: np.ndarray, sr: int,
                        edge: float = 0.12) -> list:
    """词对齐保护区间（删除决策安全阀）。

    默认 = 每个词区间向外扩 word_pad。两层收窄，逐步暴露被 Whisper 吞掉、
    但其实是非语音的声音事件：

    1) ∩ VAD 语音区：Whisper 常把静音/非语音拉长进词时间戳（过长），
       而 silero VAD 不会，故把保护区间收窄为「词区间 ∩ VAD 语音区」。
    2) 事件边缘优先（仅对**孤立且局部**的声音事件生效）：
       - 局部：至多重叠 1 个词（跨多词事件=连续语音元音，维持整词保护）。
       - 孤立：**事件某一侧紧邻静音**（`_has_silence_border`）→ 是独立非
         语音（咳嗽/提示音/咂嘴），可信其优先于词边界，把词保护边界推过
         该事件并删除；嵌在语音里、两侧皆语音的元音无静音边 → 保留。
       这是"只删独立非语音、绝不切朗读元音"的关键防回归原则。
    """
    def _n_overlap(ev):
        s, e = ev
        cnt = 0
        for w in words:
            ws, we = max(0.0, w["start"] - word_pad), w["end"] + word_pad
            if not (e <= ws or s >= we):
                cnt += 1
        return cnt

    ivs = []
    for w in words:
        s = max(0.0, w["start"] - word_pad)
        e = w["end"] + word_pad
        # 1) ∩ VAD 语音区
        if vad_regs:
            segs = [(max(s, vs), min(e, ve))
                    for (vs, ve) in vad_regs
                    if min(e, ve) - max(s, vs) > 1e-3]
            if segs:
                s, e = segs[0][0], segs[-1][1]
        # 2) 孤立局部事件：有静音边才推词边界
        for (es, ee) in events:
            if _n_overlap((es, ee)) > 1:
                continue  # 跨多词：维持整词保护
            if not _has_silence_border(au, sr, es, ee):
                continue  # 嵌在语音里：维持整词保护
            if ee > s and es <= s + edge:       # 落在词起始边缘
                s = max(s, ee)
            elif es < e and ee >= e - edge:     # 落在词结束边缘
                e = min(e, es)
        if e > s:
            ivs.append((s, e))
    return _union(ivs)


def _subtract_intervals(events: list, protected: list) -> list:
    """从声音事件里挖掉与 protected 重叠的部分，保留不重叠的残余段。

    取代原『重叠即整段丢弃』硬开关：只删没有词覆盖的残余，更安全——
    被保护区间覆盖的部分（真实朗读）绝不删，仅删露出边界的非语音事件。
    """
    prot = _union(protected)
    out = []
    for (s, e) in events:
        cur = s
        for (ps, pe) in prot:
            if pe <= cur or ps >= e:
                continue
            if ps > cur:
                out.append((cur, ps))
            cur = max(cur, pe)
            if cur >= e:
                break
        if cur < e:
            out.append((cur, e))
    return [(s, e) for s, e in out if e - s >= 0.04]


def detect_cough(wav_path: str, words: list, win_ms: int = 10, hop_ms: int = 5,
                 onset_factor: float = 4.5, min_dur: float = 0.10,
                 max_dur: float = 0.7, min_voiced: float = 0.08,
                 word_pad: float = 0.12, vad_regs: list = None) -> list:
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
    # 减法式安全阀：挖掉与词对齐保护区间重叠的部分，只删无词覆盖的残余
    # （保护区间默认=词区间外扩 word_pad；提供 vad_regs 时收窄为 词∩VAD +
    #  事件边缘优先，暴露被 Whisper 吞掉的非语音声音事件）
    prot = _word_protected_ivs(words, vad_regs, word_pad, events, au, sr)
    out = _subtract_intervals(events, prot)
    return _union(out)


def detect_tonal_sfx(wav_path: str, words: list, win_ms: int = 30, hop_ms: int = 15,
                     flat_thr: float = 0.12, min_rel_energy: float = 1.5,
                     min_dur: float = 0.05, max_dur: float = 0.6,
                     word_pad: float = 0.08, vad_regs: list = None) -> list:
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
    prot = _word_protected_ivs(words, vad_regs, word_pad, events, au, sr)
    out = _subtract_intervals(events, prot)
    return _union(out)


# ══════════════════════════════════════════════════════
# [4f-4i] 保留段内部精细化（保留以备参考；analyze 不调用其中改写音频者）
# ══════════════════════════════════════════════════════

def _cleanup_wordless(keep: list, words: list) -> list:
    """移除没有任何词覆盖的保留段。"""
    if not words:
        return keep
    word_ivs = _union([(w["start"], w["end"]) for w in words])
    out = []
    for ks, ke in keep:
        if any(not (ke <= ws or ks >= we) for ws, we in word_ivs):
            out.append((ks, ke))
    return out


def _tighten_to_words(keep: list, words: list, pad_head: float, pad_tail: float) -> list:
    """非对称收紧保留段边界: 词前紧(抓填充词), 词后松(保尾音)。"""
    if not words:
        return keep
    word_ivs = _union([(max(0.0, w["start"] - pad_head), w["end"] + pad_tail) for w in words])
    new_keep = []
    for ks, ke in keep:
        new_s, new_e = None, None
        for ws, we in word_ivs:
            if we <= ks or ws >= ke:
                continue
            if new_s is None:
                new_s = max(ks, ws)
            new_e = min(ke, we)
        if new_s is not None and new_e is not None and new_e - new_s >= 0.1:
            new_keep.append((new_s, new_e))
    return _union(new_keep)


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


def _expand_tails(keep: list, words: list, pad_tail: float, dur: float) -> list:
    """扩展每个保留段的尾部至最后词的 pad_tail 保护区。"""
    if not words:
        return keep
    word_tail_prot = {w["end"]: w["end"] + pad_tail for w in words}
    new_keep = []
    for ks, ke in keep:
        best_tail = ke
        for we, wp in word_tail_prot.items():
            if ks - 0.05 <= we <= ke + 0.05:
                best_tail = max(best_tail, wp)
        new_keep.append((ks, min(best_tail, dur)))
    return _union(new_keep)


def _merge_same_sentence(keep: list, words: list, sentence_gap: float = 0.35) -> list:
    """合并属于同一句话的保留段。"""
    if len(keep) <= 1 or not words:
        return keep
    sw = sorted(words, key=lambda w: w["start"])
    merged = [keep[0]]
    for i in range(1, len(keep)):
        gs, ge = merged[-1][1], keep[i][0]
        same_sent = False
        for j in range(len(sw) - 1):
            a, b = sw[j], sw[j + 1]
            if a["end"] <= gs + 0.08 and b["start"] >= ge - 0.08:
                if b["start"] - a["end"] < sentence_gap:
                    same_sent = True
                break
        if same_sent:
            merged[-1] = (merged[-1][0], keep[i][1])
        else:
            merged.append(keep[i])
    return merged


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


def refine_keep(wav_path: str, keep: list, words: list,
                hf_thr: float = 0.28, zcr_thr: float = 0.08,
                min_dur: float = 0.04, word_pad: float = 0.06) -> list:
    """从保留段内部挖除气声(呼吸/齿音尾)，词保护区不挖。"""
    au, sr = _read_wav(wav_path)
    frame = int(0.020 * sr)
    hop = int(0.010 * sr)
    nh = (len(au) - frame) // hop + 1
    hf = np.zeros(nh)
    zcr_arr = np.zeros(nh)
    for i in range(0, len(au) - frame, hop):
        seg = au[i:i + frame]
        win = seg * np.hanning(seg.size)
        N = 1 << int(np.ceil(np.log2(max(seg.size, 256))))
        mag = np.abs(np.fft.rfft(win, N))
        fr = np.fft.rfftfreq(N, 1 / sr)
        hf[i // hop] = mag[fr >= 2000].sum() / (mag.sum() + 1e-12)
        zcr_arr[i // hop] = np.mean(np.diff(np.sign(seg)) != 0)
    t_arr = np.arange(nh) * hop / sr
    breath_mask = (hf > hf_thr) & (zcr_arr > zcr_thr)

    _bad = set(FILLERS) | set(_SINGLE_FILLER)
    prot = _union([(max(0.0, w["start"] - word_pad), w["end"] + word_pad)
                   for w in words if w["word"].strip(_PUNCT).lower() not in _bad])

    new_keep = []
    for ks, ke in keep:
        cuts = []
        i = 0
        while i < len(breath_mask):
            if breath_mask[i] and t_arr[i] >= ks and t_arr[i] <= ke:
                j = i
                while j < len(breath_mask) and breath_mask[j] and t_arr[j] <= ke:
                    j += 1
                bs, be = t_arr[i], t_arr[min(j, len(t_arr) - 1)]
                if be - bs >= min_dur and not any(bs < pe and be > ps for ps, pe in prot):
                    cuts.append((bs, be))
                i = j
            else:
                i += 1
        if not cuts:
            new_keep.append((ks, ke))
            continue
        cur = ks
        for cs, ce in cuts:
            if cs - cur >= 0.04:
                new_keep.append((cur, cs))
            cur = max(cur, ce)
        if ke - cur >= 0.04:
            new_keep.append((cur, ke))
    return _union(new_keep)


# ══════════════════════════════════════════════════════
# [5] 去齿音（DSP，仅保留参考；analyze 不调用）
# ══════════════════════════════════════════════════════

def deess(audio: np.ndarray, sr: int, freq_low: int = 4000,
          freq_high: int = 10000, threshold_ratio: float = 0.30,
          reduction_db: float = 8.0, attack_ms: float = 2.0,
          release_ms: float = 15.0) -> np.ndarray:
    """对过度齿音做高频动态压缩（不切除，保留擦音可懂度）。"""
    n_fft = 1024
    hop = n_fft // 4
    n_frames = (len(audio) - n_fft) // hop + 1
    if n_frames <= 0:
        return audio.copy()

    spec = np.zeros((n_fft // 2 + 1, n_frames), dtype=np.complex128)
    win = np.hanning(n_fft)
    for i in range(n_frames):
        seg = audio[i * hop:i * hop + n_fft] * win
        spec[:, i] = np.fft.rfft(seg)

    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    hf_bins = (freqs >= freq_low) & (freqs <= freq_high)

    attack_coef = min(0.99, 3.0 / max(1, int(attack_ms / 1000 * sr / hop)))
    release_coef = min(0.99, 3.0 / max(1, int(release_ms / 1000 * sr / hop)))
    target_gr = 10 ** (-reduction_db / 20)
    gain_reduction = np.ones(n_frames, dtype=np.float32)
    gr_smooth = 1.0

    for i in range(n_frames):
        mag = np.abs(spec[:, i])
        total_e = float(np.sum(mag ** 2)) + 1e-12
        hf_e = float(np.sum(mag[hf_bins] ** 2))
        if hf_e / total_e > threshold_ratio:
            gr_smooth += (target_gr - gr_smooth) * attack_coef
        else:
            gr_smooth += (1.0 - gr_smooth) * release_coef
        gr_smooth = max(target_gr * 0.5, min(1.0, gr_smooth))
        gain_reduction[i] = float(gr_smooth)

    spec_out = spec.copy()
    for i in range(n_frames):
        gr = gain_reduction[i]
        if gr < 0.99:
            spec_out[hf_bins, i] *= gr

    out = np.zeros(len(audio) + n_fft, dtype=np.float64)
    norm = np.zeros(len(audio) + n_fft, dtype=np.float64)
    for i in range(n_frames):
        seg = np.fft.irfft(spec_out[:, i])
        out[i * hop:i * hop + n_fft] += seg * win
        norm[i * hop:i * hop + n_fft] += win ** 2
    norm[norm < 1e-8] = 1.0
    result = out[:len(audio)] / norm[:len(audio)]
    return result.astype(np.float32)


# ══════════════════════════════════════════════════════
# [6] 智能拼接 / 响度归一化（DSP，仅保留参考；analyze 不调用）
# ══════════════════════════════════════════════════════

def _crossfade(a: np.ndarray, b: np.ndarray, sr: int, cf_ms: int = 20) -> np.ndarray:
    cf_n = min(int(cf_ms / 1000 * sr), len(a) // 4)
    if cf_n < 4:
        return np.concatenate([a, b])
    fo = np.linspace(1, 0, cf_n, dtype=np.float32)
    b_safe = b.copy()
    b_safe[:4] *= np.linspace(0.7, 1, 4)
    return np.concatenate([a[:-cf_n], a[-cf_n:] * fo, b_safe])


def _edge_fade(seg: np.ndarray, sr: int, fade_ms: int = 8) -> np.ndarray:
    fn = int(fade_ms / 1000 * sr)
    if len(seg) > 2 * fn:
        seg = seg.copy()
        seg[:fn] *= np.linspace(0, 1, fn)
        seg[-fn:] *= np.linspace(1, 0, fn)
    return seg


def smart_assemble(wav_path: str, keep: list, dur: float, words: list,
                   sentence_gap: float = 0.30, pause_len: float = 0.22,
                   xfade_inner_ms: int = 20, xfade_outer_ms: int = 40,
                   fade_edge_ms: int = 8) -> np.ndarray:
    """上下文感知拼接（仅供参考，analyze 不调用）。"""
    au, sr = _read_wav(wav_path)
    if not keep:
        return np.zeros(int(0.1 * sr), dtype=np.float32)
    segs = []
    for s, e in keep:
        a, b = max(0, int(s * sr)), min(len(au), int(e * sr))
        if b > a:
            segs.append(au[a:b].copy())
    if not segs:
        return np.zeros(int(0.1 * sr), dtype=np.float32)
    if len(segs) == 1:
        return _edge_fade(segs[0], sr, fade_edge_ms)

    result = _edge_fade(segs[0], sr, fade_edge_ms)
    for i in range(1, len(segs)):
        gap = keep[i][0] - keep[i - 1][1]
        cur = segs[i]
        if gap < sentence_gap:
            result = _crossfade(result, cur, sr, xfade_inner_ms)
        else:
            gs, ge = keep[i - 1][1], keep[i][0]
            result = _insert_pause(result, cur, au, sr, gs, ge, pause_len, xfade_outer_ms)
    return result


def _insert_pause(a: np.ndarray, b: np.ndarray, au: np.ndarray, sr: int,
                  gs: float, ge: float, pause_len: float = 0.22,
                  fade_ms: int = 20) -> np.ndarray:
    gap_audio = au[int(gs * sr):int(ge * sr)]
    pn = int(pause_len * sr)
    if gap_audio.size >= pn:
        st = max(0, (gap_audio.size - pn) // 2)
        sil = gap_audio[st:st + pn].astype(np.float32)
        if float(np.sqrt(np.mean(sil ** 2))) > 0.015:
            sil = np.zeros(pn, dtype=np.float32)
    else:
        sil = np.zeros(pn, dtype=np.float32)

    fn = int(fade_ms / 1000 * sr)
    if len(a) > fn and len(b) > 4:
        fo = np.linspace(1, 0, fn, dtype=np.float32)
        b_safe = b.copy()
        b_safe[:4] *= np.linspace(0.7, 1, 4)
        return np.concatenate([a[:-fn], a[-fn:] * fo, sil, b_safe])
    return np.concatenate([a, sil, b])


def normalize_lufs(audio: np.ndarray, sr: int, target_lufs: float = -16.0) -> np.ndarray:
    """简单集成 LUFS 归一化（仅供参数参考，analyze 不调用）。"""
    peak = float(np.abs(audio).max())
    if peak < 1e-6:
        return audio
    rms = float(np.sqrt(np.mean(audio ** 2))) + 1e-10
    current_db = 20 * np.log10(rms)
    gain_db = target_lufs - current_db
    peak_db = 20 * np.log10(peak)
    max_gain = -1.0 - peak_db
    gain_db = min(gain_db, max_gain)
    gain_linear = 10 ** (gain_db / 20)
    result = audio * gain_linear
    return np.clip(result, -1.0, 1.0).astype(np.float32)


# ══════════════════════════════════════════════════════
# 主分析入口（决策层，仅返回 JSON 计划，不生成任何媒体文件）
# ══════════════════════════════════════════════════════

def _apply_min_gap(remove_list: list, min_gap: float) -> list:
    """丢弃短于 min_gap 的声学检测删除区间（太短的静音不值得切）。"""
    if min_gap <= 0:
        return list(remove_list)
    return [(s, e) for s, e in remove_list if (e - s) >= min_gap]


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


def analyze(input_path: str, opts: dict) -> dict:
    """
    口播剪辑决策层：分析媒体文件，返回编辑计划（JSON 友好 dict）。

    参数
    ----
    input_path : str
        输入音频/视频文件路径。
    opts : dict
        选项（均可选，含默认值）：
          modelSize   (str,  默认 'base')  whisper 模型大小
          useDemucs   (bool, 默认 True)    是否用 Demucs 做人声分离（分析辅助）
          vadThreshold(float, 默认 0.25)    Silero VAD 阈值
          minGap      (float, 默认 0.18)    最短可切除静音间隙（s）
          wordPad     (float, 默认 0.04)    词保护边距（s）
          fillers     (bool, 默认 True)     是否删除填充词
          keepNonspeech(bool, 默认 True)    保留非语音内容：True=保留背景音乐/环境音，
                                            仅删语音内填充/呼吸；False=仅保留 VAD 语音段（紧凑旁白）
          trimSilence(bool, 默认 True)      裁剪首尾低能量静音段（基于原始 16k 包络）
          exclude     (list, 默认 [])       人工排除区 [[s,e], ...]（并入删除集）
          denoise/deess/normalize : 仅被 Rust 生成阶段使用，analyze 忽略

    返回（契约，必须包含以下键）
    ----------------------------------------------
      duration        : float   媒体时长（秒）
      sampleRate      : int     16000
      words           : [{word,start,end}, ...]
      keepSegments    : [[s,e], ...]  升序、非重叠、在 [0,duration] 内
      detail          : [{type,start,end}, ...]  每段删除区的类型化描述
      totalRemovedSec : float
      ratio           : float   0..1
      separated       : bool    是否成功做了 Demucs 声源分离
    分离成功时额外返回（可选键）：
      vocalPath       : str    人声 stem 路径（44.1k，已缓存到 .aicut_speech）
      accompPath      : str    伴奏 stem 路径（no_vocals，44.1k）
      musicSegments   : [[s,e], ...]  非语音但含音乐/环境音的区间（纯伴奏桥接段，gap 音乐保留）
    """
    opts = opts or {}

    model_size = opts.get("modelSize", "base")
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

    # 仅接受，不在此处使用（输出生成由 Rust 负责）
    # opts.get("denoise"); opts.get("deess"); opts.get("normalize")

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

        # ── [2] Whisper 转写 ──
        print("[2/6] Whisper 转写…", flush=True)
        words, _, _ = transcribe(work_wav, model_size, language)
        print(f"  {len(words)} 个词", flush=True)

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
        print("[4/6] 多层噪声检测…", flush=True)

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
                                    vad_regs=speech_regs)
        print(f"  4e. 咳嗽/清嗓(浊音爆发): {len(cough_events)} 段", flush=True)
        tonal_events = detect_tonal_sfx(work_wav, words, word_pad=word_pad,
                                        flat_thr=tonal_flat_thr, max_dur=tonal_max_dur,
                                        vad_regs=speech_regs)
        print(f"  4f. 提示音/纯音事件: {len(tonal_events)} 段", flush=True)
        sound_events = _union(cough_events + tonal_events)

        # 对声学类删除区应用 minGap 下限（太短不切）；声音事件不套（见上）
        isolated = _apply_min_gap(isolated, min_gap)
        gap_breath = _apply_min_gap(gap_breath, min_gap)
        transients = _apply_min_gap(transients, min_gap)

        # 初始删除集 → 初始保留段
        init_remove = _union(text_fillers + isolated + gap_breath + transients + sound_events)
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

        # ── 合并所有删除区 → 最终保留段 ──
        # keepNonspeech=True（默认）：删除集的补集 = 保留背景音乐/环境音，仅删语音内噪声
        # keepNonspeech=False（紧凑）：仅保留 VAD 语音段，段内再挖除各类填充/噪声，
        #   非语音间隙（静音+音乐）整体丢弃。
        if keep_nonspeech:
            all_remove = _union(text_fillers + isolated + gap_breath +
                                transients + intra_fillers + sound_events + manual)
            keep = _complement(all_remove, dur, min_keep=0.0)
        else:
            keep = []
            for (vs, ve) in speech_regs:
                rm = [(s, e) for (s, e) in
                      (text_fillers + isolated + gap_breath + transients +
                       intra_fillers + sound_events + manual)
                      if e > vs and s < ve]
                if not rm:
                    keep.append((vs, ve))
                    continue
                seg = _complement(rm, ve - vs, min_keep=0.0)
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
        for s, e in text_fillers:
            detail.append({"type": "text_filler", "start": s, "end": e})
        for s, e in isolated:
            detail.append({"type": "isolated_noise", "start": s, "end": e})
        for s, e in gap_breath:
            detail.append({"type": "gap_breath", "start": s, "end": e})
        for s, e in transients:
            detail.append({"type": "transient", "start": s, "end": e})
        for s, e in intra_fillers:
            detail.append({"type": "intra_keep", "start": s, "end": e})
        for s, e in cough_events:
            detail.append({"type": "cough", "start": s, "end": e})
        for s, e in tonal_events:
            detail.append({"type": "tonal_sfx", "start": s, "end": e})
        for s, e in manual:
            detail.append({"type": "manual_exclude", "start": s, "end": e})
        detail.sort(key=lambda d: d["start"])

        total_kept = sum(e - s for s, e in keep)
        total_removed = max(0.0, dur - total_kept)
        ratio = (total_removed / dur) if dur > 0 else 0.0

        print(f"  删除合计: {total_removed:.1f}s ({ratio*100:.0f}%)", flush=True)
        print(f"  保留段: {len(keep)} 段", flush=True)

        result = {
            "duration": round(dur, 6),
            "sampleRate": 16000,
            "words": [{"word": w["word"], "start": float(w["start"]), "end": float(w["end"])}
                      for w in words],
            "keepSegments": [[float(s), float(e)] for s, e in keep],
            "detail": [{"type": d["type"], "start": round(float(d["start"]), 6),
                        "end": round(float(d["end"]), 6)} for d in detail],
            "totalRemovedSec": round(total_removed, 6),
            "ratio": round(ratio, 6),
            "separated": bool(separated),
        }
        if separated and voice and accomp:
            result["vocalPath"] = voice
            result["accompPath"] = accomp
            result["musicSegments"] = music_segments
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════
# 命令行自测（仅 core；正式入口见 bridge.py）
# ══════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description="AIcut 口播剪辑决策层（仅分析，返回计划）")
    ap.add_argument("input", help="输入音频/视频路径")
    ap.add_argument("--model", default="base", help="Whisper 模型大小")
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
        "exclude": exclude,
    })
    print(json.dumps(rep, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
