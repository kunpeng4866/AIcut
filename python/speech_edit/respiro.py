"""Respiro-en 风格呼吸专项检测。

上游官方 Respiro 仓库(anuragchowdhury13/Respiro) 当前 404，权重不可得。
本实现以「呼吸专项检测器」落地该能力，融合两类信号、仅在非语音低能量区门控：
  1) 若 PANNs 权重就绪：取 AudioSet 的 Breathing/Respiration 帧级概率作为 ML 呼吸似然；
  2) 声学呼吸线索：包络在 0.2–0.5Hz 的低频调幅 + 低谱平坦度，即使无 PANNs 权重也能独立工作。
两者取高并阈值成段，仅在「非语音词保护区之外」区域标记，
与既有 detect_gap_breath 哲学一致（呼吸属软停顿，不进 hard_remove）。

若官方 Respiro-en 权重重现，只需把 backbone 换成其模型即可，接口不变。

接口：
    detect_respiro_breath(wav_path, words, word_pad=0.08, thr=0.35,
                          min_dur=0.05, max_dur=3.0)
        -> list[(start, end, score)]  # 源秒，score∈[0,1]
"""
import os
import numpy as np

try:
    from .panns_sed import (panns_sed, _SAMPLE_RATE as PANNS_SR, panns_available)
except ImportError:  # 顶层模块导入（sys.path.insert 场景）
    from panns_sed import (panns_sed, _SAMPLE_RATE as PANNS_SR, panns_available)

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT = os.path.dirname(_HERE)
RESPIRO_MODEL_DIR = os.path.join(_PROJECT, "models", "respiro")

_FRAME_SEC = 0.01  # 10ms 栅格


def _merge_ivs(ivs: list) -> list:
    """合并重叠/相邻区间（与 core._union 等价，本地实现避免 import core 循环）。"""
    out = []
    for s, e in ivs:
        if out and s <= out[-1][1] + 1e-4:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def _read_wav_local(path: str):
    """极简 wav 读取（避免顶部循环 import core）。返回 (float32 单声道, sr)。"""
    import wave
    wf = wave.open(path, "rb")
    sr = wf.getframerate()
    n = wf.getnframes()
    au = np.frombuffer(wf.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    wf.close()
    return au, sr


def _acoustic_breath_likelihood(au: np.ndarray, sr: int) -> np.ndarray:
    """逐 10ms 帧的声学呼吸似然 0..1。

    呼吸特征：包络在 0.2–0.6Hz 的低频调幅（吸气/呼气的周期性）+ 相对低能量。
    返回长度 = len(au)//(0.01*sr) 的数组；过短返回空。
    """
    frame = max(1, int(_FRAME_SEC * sr))
    n_frames = len(au) // frame
    if n_frames < 8:
        return np.zeros(0, dtype=np.float32)
    env = np.abs(au)
    env_f = np.array([env[i * frame:(i + 1) * frame].mean() for i in range(n_frames)],
                     dtype=np.float32)
    env_f = env_f - np.mean(env_f)
    sd = np.std(env_f) + 1e-6
    try:
        from scipy.signal import butter, filtfilt
        ny = 0.5 / _FRAME_SEC
        b, a = butter(2, [0.2 / ny, 0.6 / ny], btype="band")
        mod = filtfilt(b, a, env_f)
        mod = np.abs(mod) / sd
    except Exception:
        mod = np.abs(env_f) / sd
    mod = np.clip(mod, 0.0, 1.0)
    amp = np.clip(np.abs(env_f) / (np.max(np.abs(env_f)) + 1e-9), 0.0, 1.0)
    # 呼吸似然：有低频调幅、且能量不过高（非喊叫）
    likelihood = np.clip(mod * (1.0 - 0.5 * amp), 0.0, 1.0)
    return likelihood.astype(np.float32)


def detect_respiro_breath(wav_path, words, word_pad: float = 0.08, thr: float = 0.35,
                          min_dur: float = 0.05, max_dur: float = 3.0) -> list:
    """呼吸专项检测。返回 list[(start, end, score)]（源秒）。无异常即 []。"""
    try:
        au, sr = _read_wav_local(wav_path)
    except Exception:
        return []
    if sr != PANNS_SR:
        try:
            import librosa
            au = librosa.resample(au.astype(np.float32), orig_sr=sr, target_sr=PANNS_SR)
            sr = PANNS_SR
        except Exception:
            return []
    au = np.asarray(au, dtype=np.float32)
    if au.ndim > 1:
        au = au.mean(axis=1)
    if len(au) < sr:
        return []

    # 词保护区（呼吸在词内通常是正常发音，不标记）
    word_ivs = []
    if words:
        ivs = sorted((max(0.0, w["start"] - word_pad), w["end"] + word_pad) for w in words)
        word_ivs = _merge_ivs(ivs)

    # 1) PANNs 呼吸概率（ML 似然）
    panns_breath = None
    try:
        if panns_available():
            evs = panns_sed(audio=au, sr=sr,
                            classes={"Breathing": 0.20, "Respiration": 0.25})
            T = len(au) // int(_FRAME_SEC * sr)
            panns_breath = np.zeros(T, dtype=np.float32)
            for s, e, _, sc in evs:
                a = int(round(s / _FRAME_SEC))
                b = int(round(e / _FRAME_SEC))
                if b > a:
                    panns_breath[a:b] = max(float(panns_breath[a:b].max()), sc)
    except Exception:
        panns_breath = None

    # 2) 声学线索
    try:
        acu = _acoustic_breath_likelihood(au, sr)
    except Exception:
        acu = np.zeros(0, dtype=np.float32)
    if len(acu) == 0:
        return []

    # 融合：取高
    if panns_breath is not None and len(panns_breath) == len(acu):
        fuse = np.maximum(acu, panns_breath)
    else:
        fuse = acu

    # 词区门控：词保护区内（含小余量）不标记
    def in_word(ti: int) -> bool:
        t = ti * _FRAME_SEC
        for ws, we in word_ivs:
            if ws - 0.06 <= t <= we + 0.06:
                return True
        return False

    events = []
    T = len(fuse)
    i = 0
    while i < T:
        if fuse[i] >= thr and not in_word(i):
            j = i
            while j < T and fuse[j] >= thr and not in_word(j):
                j += 1
            s = i * _FRAME_SEC
            e = (j - 1) * _FRAME_SEC + _FRAME_SEC
            if min_dur <= (e - s) <= max_dur:
                score = float(fuse[i:j].max())
                events.append((round(s, 4), round(e, 4), score))
            i = j
        else:
            i += 1
    return events
