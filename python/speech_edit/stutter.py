"""口吃/重复/拖音 语音级不流畅检测（参考 arXiv:2409.10177「改进 CTC + gap 分类」思路）。

论文核心思路：用「改进 CTC」做强制对齐，产生词与词之间的 gap；再用一个分类器把
gap 标为「含语音（空 gap 里有口吃/重复音）」或「空 gap（纯停顿 / 阻塞）」。

本模块是 **P0 轻量落地**：
  由于论文的 gap 分类器权重（基于 wav2vec2 微调、且需配套 ASR 转录文本）当前没有
  稳定公开下载地址（HuggingFace / GitHub 上未找到可直接入库的权重；其训练依赖私有
  disfluency 数据集），这里用纯声学线索复现同一语义目标——
    · 重复(sound/syllable repetition)：相邻极短同音段（粗窗特征自相关/相邻窗余弦相似度）
    · 拖长音(prolongation)：某音素能量异常持续超阈值（延长的浊音段、能量几乎不调制）
    · 阻塞停顿(block)：语音区内的短促能量骤降（非自然句逗的空 gap，对应 gap 分类的
      "empty gap due to block"）
  三类事件统一在 detail 里记为 `stutter`；对外只返回 [(s,e)]，与 sed/respiro 检测器一致。

接口（对齐 panns_sed / respiro 范式）：
    detect_stutter(wav_path, words, word_pad=0.08, threshold=0.5,
                   min_dur=0.10, max_dur=3.0) -> list[(start, end)]   # 源秒
  - 第 1 参 wav_path，内部自行读音频（避免顶部循环 import core）。
  - 权重缺失 / 异常 -> 返回 [] 做 no-op 降级，绝不抛错阻断 analyze。
  - 用本地等价版 _apply_word_safety 做词保护区安全阀（避免切碎连续朗读；与 respiro.py
    同样不 import core，规避循环依赖）。

若未来论文权重可落地：把 _backbone 换成「改进 CTC 强制对齐 + wav2vec2 gap 分类器」
即可，detect_stutter 接口签名保持不变（见文末 _backbone 注释）。
"""
import os
import numpy as np

# 顶层导入约束：模块间互相引用用「先相对后绝对」兜底（对齐 panns_sed / respiro）。
try:
    from .core import _read_wav as _core_read_wav  # noqa: F401
except ImportError:
    _core_read_wav = None

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT = os.path.dirname(_HERE)
STUTTER_MODEL_DIR = os.path.join(_PROJECT, "models", "stutter")  # 方案 A 权重目录（当前空）

_FRAME_SEC = 0.01       # 10ms 能量栅格
_WIN_SEC = 0.05         # 50ms 粗窗（重复相似度特征）
_NBANDS = 24            # 粗窗频谱包络的频带数


# ───────────────────────── 本地安全阀（等价 core._apply_word_safety，避免循环 import） ──
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


def _overlap_len(s: float, e: float, ivs: list) -> float:
    tot = 0.0
    for ps, pe in ivs:
        lo, hi = max(s, ps), min(e, pe)
        if hi > lo:
            tot += hi - lo
    return tot


def _subtract(s: float, e: float, ivs: list) -> list:
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


def _apply_word_safety(events: list, word_ivs: list,
                       keep_ratio: float = 0.5, min_piece: float = 0.03) -> list:
    """词保护区安全阀（语义与 core._apply_word_safety 一致）。

    overlap 比例 >= keep_ratio → 主体是朗读语音，整段不删；否则只保留词区之外的部分。
    """
    out = []
    for s, e in events:
        dur = e - s
        if dur <= 0:
            continue
        ov = _overlap_len(s, e, word_ivs)
        if dur > 0 and (ov / dur) >= keep_ratio:
            continue
        for ps, pe in _subtract(s, e, word_ivs):
            if pe - ps >= min_piece:
                out.append((ps, pe))
    return _union(out)


def _read_wav_local(path: str):
    """极简 wav 读取（避免顶部循环 import core）。返回 (float32 单声道, sr)。"""
    import wave
    wf = wave.open(path, "rb")
    sr = wf.getframerate()
    n = wf.getnframes()
    au = np.frombuffer(wf.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    wf.close()
    return au, sr


# ───────────────────────── 帧级特征 ─────────────────────────
def _frame_energy(au: np.ndarray, sr: int) -> np.ndarray:
    """10ms 帧 RMS 能量（已去直流）。返回 (n_frames,)。"""
    n = max(1, int(_FRAME_SEC * sr))
    nf = len(au) // n
    if nf == 0:
        return np.zeros(0, dtype=np.float32)
    au = au - np.mean(au)
    env = np.array([np.sqrt(np.mean(au[i * n:(i + 1) * n] ** 2))
                    for i in range(nf)], dtype=np.float32)
    return env


def _frame_zcr(au: np.ndarray, sr: int) -> np.ndarray:
    """10ms 帧过零率（浊/清音区分）。返回 (n_frames,)。"""
    n = max(1, int(_FRAME_SEC * sr))
    nf = len(au) // n
    if nf == 0:
        return np.zeros(0, dtype=np.float32)
    z = np.zeros(nf, dtype=np.float32)
    for i in range(nf):
        seg = au[i * n:(i + 1) * n]
        if seg.size > 1:
            z[i] = float(np.mean(seg[1:] * seg[:-1] < 0))
    return z


def _coarse_bands(au: np.ndarray, sr: int) -> tuple:
    """50ms 粗窗频谱包络（log 幅度，按频带聚合并 L2 归一化）+ 对应窗能量。

    返回 (feats (nw, _NBANDS), wins_energy (nw,))；nw==0 表示音频过短。
    重复音节检测靠「相邻窗特征余弦相似度」+「窗能量调制」实现，无需外部模型。
    """
    w = max(1, int(_WIN_SEC * sr))
    nf = len(au) // w
    if nf < 4:
        return np.zeros((0, _NBANDS), dtype=np.float32), np.zeros(0, dtype=np.float32)
    au = au - np.mean(au)
    # 频带边界（log 间隔 80Hz~min(4000, sr/2)）
    ny = sr / 2.0
    hi = min(4000.0, ny * 0.95)
    edges = np.logspace(np.log10(80.0), np.log10(hi), _NBANDS + 1)
    freqs = np.fft.rfftfreq(w, 1.0 / sr)
    feats = np.zeros((nf, _NBANDS), dtype=np.float32)
    wins_e = np.zeros(nf, dtype=np.float32)
    hann = np.hanning(w)
    for i in range(nf):
        seg = au[i * w:(i + 1) * w] * hann
        mag = np.abs(np.fft.rfft(seg) + 1e-12)
        for b in range(_NBANDS):
            lo_f, hi_f = edges[b], edges[b + 1]
            idx = np.where((freqs >= lo_f) & (freqs < hi_f))[0]
            if idx.size:
                feats[i, b] = float(np.mean(mag[idx]))
        wins_e[i] = float(np.sqrt(np.mean(seg ** 2)))
    # 对数压缩 + L2 归一化，使「同音」余弦相似度高、响度差不敏感
    feats = np.log1p(feats)
    nrm = np.linalg.norm(feats, axis=1, keepdims=True) + 1e-6
    feats = feats / nrm
    return feats, wins_e


# ───────────────────────── 三个子检测器 ─────────────────────────
def _detect_repetition(feats: np.ndarray, wins_e: np.ndarray,
                       thr: float, min_dur: float, win_sec: float = _WIN_SEC) -> list:
    """相邻同音段重复（音节/词重复）。

    相邻粗窗余弦相似度 > sim_thr 且窗口能量高于语音底、且整段能量有调制（区分拖长音）
    -> 标记为重复；合并成段后过滤短于 min_dur 的。
    """
    sim_thr = max(0.55, 0.85 - thr)   # 用户阈值越高要求越严（相似度门槛越高）
    if feats.shape[0] < 3:
        return []
    e_max = float(np.max(wins_e)) + 1e-9
    voiced = wins_e > 0.2 * e_max
    n = feats.shape[0]
    flagged = np.zeros(n, dtype=bool)
    for i in range(n - 1):
        if not voiced[i] or not voiced[i + 1]:
            continue
        # 余弦相似度（已 L2 归一化 -> 内积即余弦）
        sim = float(np.dot(feats[i], feats[i + 1]))
        if sim >= sim_thr:
            flagged[i] = flagged[i + 1] = True
    # 合并相邻 flagged 窗
    out = []
    i = 0
    while i < n:
        if flagged[i]:
            j = i
            while j < n and flagged[j]:
                j += 1
            s = i * win_sec
            e = j * win_sec
            # 能量调制：有「开/关」起伏才视为重复（持续稳态音归 prolongation）
            seg_e = wins_e[i:j]
            mod = float(np.std(seg_e) / (np.mean(seg_e) + 1e-9)) if seg_e.size else 0.0
            if (e - s) >= min_dur and mod >= 0.15:
                out.append((round(s, 4), round(e, 4)))
            i = j
        else:
            i += 1
    return out


def _detect_prolongation(env: np.ndarray, zcr: np.ndarray, sr: int,
                         thr: float, min_dur: float = 0.45,
                         frame_sec: float = _FRAME_SEC) -> list:
    """拖长音（延长浊音段）：能量持续高于语音底、过零率低、且能量几乎不调制。

    与重复的区别：调制低（稳态）；与正常长元音的区别：超过 prolong_min 阈值。
    """
    if env.size == 0:
        return []
    e_max = float(np.max(env)) + 1e-9
    voiced_floor = 0.25 * e_max
    voiced = env > voiced_floor
    # 浊音判据：过零率低于整体中位（清音/塞音 zcr 高）
    z_med = float(np.median(zcr)) if zcr.size else 0.1
    sonorant = zcr < max(0.05, 1.3 * z_med)
    mask = voiced & sonorant
    out = []
    n = mask.size
    i = 0
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            s = i * frame_sec
            e = j * frame_sec
            seg = env[i:j]
            mod = float(np.std(seg) / (np.mean(seg) + 1e-9)) if seg.size else 0.0
            if (e - s) >= min_dur and mod < 0.2:
                out.append((round(s, 4), round(e, 4)))
            i = j
        else:
            i += 1
    return out


def _detect_block(env: np.ndarray, sr: int, thr: float,
                  frame_sec: float = _FRAME_SEC) -> list:
    """阻塞停顿（block）：语音区内的短促能量骤降（非自然句逗的空 gap）。

    判据：静音帧（能量 < sil_floor）形成 [0.10, 0.45]s 的 gap，且两侧 0.25s 内都有
    语音（即 gap 夹在连续朗读之间，非句末自然长停顿）。对应 gap 分类的 "empty gap"。
    """
    if env.size == 0:
        return []
    e_max = float(np.max(env)) + 1e-9
    sil_floor = 0.06 * e_max
    sil = env < sil_floor
    min_f = int(0.10 / frame_sec)
    max_f = int(0.45 / frame_sec)
    ctx_f = int(0.25 / frame_sec)
    out = []
    n = sil.size
    i = 0
    while i < n:
        if sil[i]:
            j = i
            while j < n and sil[j]:
                j += 1
            L = j - i
            if min_f <= L <= max_f:
                # 两侧上下文需有语音（避免句末/段末自然停顿）
                pre = env[max(0, i - ctx_f):i]
                post = env[j:min(n, j + ctx_f)]
                if (pre.size and float(np.max(pre)) > sil_floor and
                        post.size and float(np.max(post)) > sil_floor):
                    s = i * frame_sec
                    e = j * frame_sec
                    out.append((round(s, 4), round(e, 4)))
            i = j
        else:
            i += 1
    return out


# ───────────────────────── 顶层接口 ─────────────────────────
def detect_stutter(wav_path, words, word_pad: float = 0.08, threshold: float = 0.5,
                   min_dur: float = 0.10, max_dur: float = 3.0) -> list:
    """口吃/重复/拖音检测（P0 声学落地）。返回 list[(start, end)]（源秒）。

    Args:
        wav_path: 16k 单声道 WAV（speech_edit 工作音频）。
        words:    ASR 词级时间戳 [{start,end}, ...]；用于词保护区安全阀。
        word_pad: 词保护余量（秒）。
        threshold: 主灵敏度阈值（0..1，越高越严）。
        min_dur/max_dur: 事件最小/最大时长过滤。
    Returns:
        list[(s, e)]；无权重/异常/过短 -> []（no-op 降级）。
    """
    # 方案 A 占位：若未来权重就绪，在此优先调用 _backbone（改进 CTC + wav2vec2 gap
    # 分类器）并映射到 [(s,e)]；当前 STUTTER_MODEL_DIR 为空 -> 走 P0 声学分支。
    try:
        au, sr = _read_wav_local(wav_path)
    except Exception:
        return []
    au = np.asarray(au, dtype=np.float32)
    if au.ndim > 1:
        au = au.mean(axis=1)
    if len(au) < int(0.5 * sr):   # <0.5s 太短，无足信上下文
        return []

    env = _frame_energy(au, sr)
    zcr = _frame_zcr(au, sr)
    feats, wins_e = _coarse_bands(au, sr)
    if env.size == 0 or feats.shape[0] == 0:
        return []

    # 三个子检测
    rep = _detect_repetition(feats, wins_e, threshold, min_dur)
    pro = _detect_prolongation(env, zcr, sr, threshold)
    blk = _detect_block(env, sr, threshold)

    ivs = _union(rep + pro + blk)
    # 时长过滤（max_dur 上限避免把整段长朗读误判为拖长音）
    ivs = [(s, e) for (s, e) in ivs if min_dur <= (e - s) <= max_dur]

    # 词保护区安全阀（避免切碎连续朗读；与 sed_events 同策略）
    word_ivs = []
    if words:
        word_ivs = _union([(max(0.0, w["start"] - word_pad), w["end"] + word_pad)
                           for w in words if "start" in w and "end" in w])
    return _apply_word_safety(ivs, word_ivs) if word_ivs else ivs


# ───────────────────────── 方案 A 接入预留（当前未启用） ─────────────────────────
# def _backbone(wav_path, words, threshold):
#     """改进 CTC 强制对齐 + gap 分类器（arXiv:2409.10177）。
#     需 wav2vec2 微调权重（STUTTER_MODEL_DIR 下）+ 配套转录；输出与声学分支同形 [(s,e)]。
#     权重可得后取消注释并接管 detect_stutter 主干即可，接口不变。"""
#     raise NotImplementedError("stutter backbone weights 未就绪，使用 P0 声学落地")
