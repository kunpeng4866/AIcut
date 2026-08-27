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
import sys
import numpy as np

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
# ───────────────────── 词内连读重复（gap-less 口吃，音节脉冲链判据） ─────────────────────
# 背景：Whisper 有"流利化"倾向，会把「我我我觉得」合并转写成单个词 [我觉得]，词时间戳
# 覆盖全部三个"我"。① 文本匹配通道没有独立 token；② 外部声学事件被词保护区安全阀丢弃。
#
# 判据（**音节脉冲一致性链**）：
#   在 ASR 词区间内按能量谷切分「音节脉冲」——同一字的重复（我/我/我）其整段频谱
#   包络高度一致（逐对余弦 ≥ 阈值），而正常相连的不同字（我→觉→得）彼此显著不同。
#   因此：连续 ≥3 个"两两一致的相同脉冲链"即判定为口吃重复，删除该链但保留最后一个
#   脉冲（最后一个往往承载真实语义并与后文连读）。
# 守卫（整体防误伤）：常见叠词白名单（妈妈/谢谢等）/ 单脉冲不足跳过 / 删除段 ≤ 词跨度
#   70% 且最短 0.15s / 全局每次分析最多保留 8 个。返回的事件 **绕过词保护区安全阀**。
_LEXICAL_REDUP = {
    "妈妈", "爸爸", "爷爷", "奶奶", "叔叔", "阿姨", "舅舅", "姥姥", "哥哥", "弟弟", "姐姐",
    "谢谢", "刚刚", "慢慢", "渐渐", "轻轻", "常常", "往往", "天天", "年年", "人人", "家家",
    "宝宝", "乖乖", "试试", "看看", "听听", "想想", "讲讲", "说说", "读读", "写写", "瞧瞧",
    "纷纷", "久久", "悄悄", "恰恰", "仅仅", "统统", "种种", "点点",
}
_FUNC_TAIL = set("的呢吧嘛啊呀哦嗯哩咯哟")


def _strip_punct(t: str) -> str:
    return "".join(ch for ch in t if ch.isalnum())


def _detect_inword_repeat(au: np.ndarray, sr: int, words: list,
                          threshold: float) -> list:
    """词内连读重复（音节脉冲链）。返回 [(s,e)]，按长度降序、最多 8 个。"""
    if not words or len(words) < 3 or len(au) < int(0.5 * sr):
        return []
    # 相邻同文 token 预合并：「我」「我」「我」这类口吃重复在 Whisper 词级输出里
    # 常是多个独立的短 token（各 ~0.15s，单看都够不到检测下限）。把相邻且转写文本
    # 相同的 token 合并成一个长区间（span 取并集），后续脉冲链判据在其上工作。
    merged_words = []
    for w in words:
        try:
            s = max(0.0, float(w["start"]))
            e = min(len(au) / sr, float(w["end"]))
        except Exception:
            continue
        t = _strip_punct(str(w.get("word", w.get("text", ""))))
        if not t:
            continue
        if merged_words and merged_words[-1]["txt"] == t and s - merged_words[-1]["end"] < 0.25:
            merged_words[-1]["end"] = max(merged_words[-1]["end"], e)
            continue
        merged_words.append({"start": s, "end": e, "txt": t})
    words = merged_words
    fsec = 0.005
    fh = max(1, int(sr * fsec))
    nf = len(au) // fh
    au0 = au[:nf * fh] - np.mean(au[:nf * fh])
    rms = np.sqrt(np.mean(au0.reshape(nf, fh) ** 2, axis=1))
    g_max = float(np.max(rms)) + 1e-9

    edges = np.logspace(np.log10(80.0), np.log10(min(4000.0, sr / 2 * 0.95)), 25)
    sim_thr = max(0.68, 0.90 - threshold)

    results = []
    for w in words:
        s, e = float(w["start"]), float(w["end"])
        txt = w["txt"]
        chars = len(txt)
        if not txt or (e - s) < 0.30 or txt in _LEXICAL_REDUP:
            continue
        i0, i1 = int(s / fsec), min(nf, int(e / fsec))
        seg_rms = rms[i0:i1]
        if seg_rms.size < 20:
            continue
        lo = float(np.max(seg_rms)) * 0.32          # 局部谷阈值：低于它的连续帧为音节间隙
        # ── 按谷切分脉冲 ──
        pulses = []
        k = 0
        while k < seg_rms.size:
            if seg_rms[k] > lo:
                j = k
                while j < seg_rms.size and seg_rms[j] > lo:
                    j += 1
                if (j - k) * fsec >= 0.05:          # 脉冲最短 50ms
                    pulses.append((i0 + k, i0 + j))
                k = j
            else:
                k += 1
        if len(pulses) < 3 or len(pulses) > 14:
            continue
        # ── 脉冲特征（核心 60% 帧的频带均值，log 压缩，L2 归一化）──
        feats = []
        for (pa, pb) in pulses:
            plen = pb - pa
            ca = pa + int(plen * 0.15)
            cb = pa + max(ca + fh + 1, int(plen * 0.85))
            nfr = cb - ca
            sub = au[ca * fh:cb * fh] + 1e-12
            wl = len(sub)
            mag = np.abs(np.fft.rfft(sub * np.hanning(wl)) + 1e-12)
            freqs = np.fft.rfftfreq(wl, 1.0 / sr)
            f = np.array([float(np.mean(mag[(freqs >= a) & (freqs < b_)]))
                          for a, b_ in zip(edges[:-1], edges[1:])], dtype=np.float32)
            f = np.log1p(f)
            feats.append(f / (np.linalg.norm(f) + 1e-6))
        # ── 相邻脉冲一致性链 ──
        cons = [float(np.dot(feats[k], feats[k + 1])) for k in range(len(feats) - 1)]
        # 找最长连续高相似 run（允许单对谷值一次豁免，应对轻微断续）
        best_len, best_i, miss_used = 1, 0, False
        cur_len, cur_i = 1, 0
        for k, c in enumerate(cons):
            if c >= sim_thr:
                cur_len += 1
            elif not miss_used and cur_len >= 2:
                miss_used = True                    # 一帧浅谷豁免
            else:
                if cur_len > best_len:
                    best_len, best_i = cur_len, cur_i
                cur_len, cur_i = 1, k + 1
        if cur_len > best_len:
            best_len, best_i = cur_len, cur_i
        if best_len < 3:
            continue                                 # 至少 3 个相同脉冲才算口吃链
        # 删除链中「除最后一个脉冲外」的全部重复，保留末脉冲（承载真实语义并与后文连读）
        keep_idx = best_i + best_len - 1                      # 末脉冲索引
        rm_first = pulses[best_i][0]
        rm_last = pulses[max(best_i, keep_idx - 1)][1]        # 删到倒数第二个脉冲为止
        rs_t = rm_first * fsec          # 帧索引 → 秒（5ms 网格）
        re_t = rm_last * fsec
        if re_t - rs_t < 0.14 or (re_t - rs_t) > 0.78 * (e - s):
            continue
        # 单字功能词短跨度更像自然拖长音
        if chars <= 2 and txt[-1] in _FUNC_TAIL and (e - s) < 0.55:
            continue
        out_s = round(rs_t, 4)
        out_e = round(re_t - min(0.04, (re_t - rs_t) * 0.2), 4)   # 尾部略收保护后续内容
        if out_e - out_s >= 0.15:
            results.append((out_s, out_e))

    results.sort(key=lambda x: -(x[1] - x[0]))
    return results[:8]


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
    safe = _apply_word_safety(ivs, word_ivs) if word_ivs else ivs
    # 词内连读重复（gap-less 口吃，如「我我我觉得」被 ASR 流利化成 [我觉得]）：
    # 绕过词保护区安全阀（其天然位于词内部），自带叠词白名单/语速门控/跨度上限三重守卫。
    try:
        inword = _detect_inword_repeat(au, sr, words, threshold)
        if os.environ.get("AICUT_STUTTER_DEBUG"):
            sys.stderr.write(
                f"[stutter-debug] merged_words={[(round(w['start'],2), round(w['end'],2), w['txt']) for w in words]}\n"
                f"[stutter-debug] inword={inword}\n")
    except Exception as _e:
        if os.environ.get("AICUT_STUTTER_DEBUG"):
            import traceback
            traceback.print_exc()
        inword = []
    return _union(safe + inword)


# ───────────────────────── 方案 A 接入预留（当前未启用） ─────────────────────────
# def _backbone(wav_path, words, threshold):
#     """改进 CTC 强制对齐 + gap 分类器（arXiv:2409.10177）。
#     需 wav2vec2 微调权重（STUTTER_MODEL_DIR 下）+ 配套转录；输出与声学分支同形 [(s,e)]。
#     权重可得后取消注释并接管 detect_stutter 主干即可，接口不变。"""
#     raise NotImplementedError("stutter backbone weights 未就绪，使用 P0 声学落地")
