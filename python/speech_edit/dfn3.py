# -*- coding: utf-8 -*-
r"""DeepFilterNet3（DFN3）三段图 ONNX 推理 —— 纯 numpy 前后处理。

本模块把本地 `python/models/denoise/{enc,erb_dec,df_dec}.onnx` 跑成一个可用的
降噪器。所有前后处理公式**严格对照官方实现** Rikorose/DeepFilterNet，逐条核对
过源码（参考源码见 verify_tmp/dfn_ref/，行号标在各函数注释里）：

  - libDF/src/lib.rs
      freq2erb/erb2freq            :42-47
      erb_fb（每带频点数）          :68-100
      MEAN_NORM_INIT/UNIT_NORM_INIT:12-13
      vorbis 窗                     :127-132
      wnorm                        :133
      feat_erb                     :206-212   (10*log10(x+1e-10) 后接 EMA 均值归一)
      band_mean_norm_erb           :244-251   (s=x(1-a)+sa; x-=s; x/=40)
      band_unit_norm               :253-259   (s=|x|(1-a)+sa; x/=sqrt(s))
      apply_interp_band_gain       :314-326   (整带广播乘，无插值)
      frame_analysis/synthesis     :356-427
  - libDF/src/tract.rs
      process                      :509-642
      apply_stages（lsnr 门控）     :658-672
      df（deep filtering）          :713-767
      门控常量默认值                :182-184
      calc_norm_alpha              :989-999

## 与官方流式实现的等价性（重要）

官方 tract 是**逐帧流式**：mask 施加在滚动缓冲索引 `df_order-1` 的帧上，因此输出
相对输入有 `(fft_size-hop_size) + lookahead*hop_size = 1440` 样本的延迟，调用方需
事后丢弃（enhance_wav.rs:133-135 的 `compensate_delay`）。

本模块按**整段批处理**，把同一个延迟表达为「索引对齐」：
    目标帧 j 使用 m[j + CONV_LOOKAHEAD] 与 coefs[j + CONV_LOOKAHEAD]，
    coefs 的 order 维 k 对应频谱帧 j - DF_LOOKAHEAD + k（以 j 为中心的 5 帧窗）。
配合「左侧补 HOP 个零（等价 analysis_mem 初始为零）+ 末尾补零」，输出与输入
**样本级零平移**。这一点对下游词级时间戳是硬要求，由 bench_denoise.py 的互相关
lag 检查守护（必须恒为 0.000ms）。

## 状态量与向量化

含跨帧状态、必须按帧顺序递推的只有两处 EMA（erb 均值归一 / 复数谱单位归一），
本模块用显式循环递推，绝不退化成全局统计。其余（ERB 掩码展开、deep filtering
的时间窗、ISTFT 的 50% overlap-add）都是固定偏移的线性运算，已完全向量化。
三段 ONNX 图的 S 维是动态的，按块（默认 2000 帧）推理并丢弃块边界，避免 GRU
在块首未收敛以及 c0 大张量占用显存。
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np

__all__ = ["enhance", "erb_widths", "vorbis_window"]


# ── 模型固定超参（与 python/models/denoise/config.ini 的 [df] 段一致）──
SR_MODEL = 48000
FFT = 960
HOP = 480
NB_ERB = 32
NB_DF = 96
DF_ORDER = 5
DF_LOOKAHEAD = 2
CONV_LOOKAHEAD = 2
MIN_NB_ERB_FREQS = 2
NORM_TAU = 1.0
FREQ_SIZE = FFT // 2 + 1  # 481

MEAN_NORM_INIT = (-60.0, -90.0)   # lib.rs:12
UNIT_NORM_INIT = (1e-3, 1e-4)     # lib.rs:13

# tract.rs:182-184 的库默认门控阈值。默认**不启用**门控（离线质量优先，与官方
# PyTorch enhance 的行为一致：全帧都跑两阶段）；需要时用 lsnr_gate=True 打开。
MIN_DB_THRESH = -10.0
MAX_DB_ERB_THRESH = 30.0
MAX_DB_DF_THRESH = 20.0

# mask 软化（#7）：仅对「已较干净」的频带（ERB 增益 ≥ 此阈值）朝原频谱回混；
# 增益低于阈值的频带视为仍需降噪 → 全增强。阈值取 0.5（中点），可按听感微调。
MASK_SOFTEN_GAIN_FLOOR = 0.5

# ONNX 分块推理
CHUNK_FRAMES = 2000     # 每块帧数（20s @48k）
CHUNK_OVERLAP = 200     # 块间重叠帧数（1s 供 GRU 收敛，取中间有效区）

_SESS_CACHE: dict = {}


# ══════════════════════════════════════════════════════
# ERB 滤波器组
# ══════════════════════════════════════════════════════

def _freq2erb(f: float) -> float:
    """lib.rs:42-44  9.265 * ln_1p(f / (24.7 * 9.265))"""
    return 9.265 * math.log1p(f / (24.7 * 9.265))


def _erb2freq(e: float) -> float:
    """lib.rs:45-47  24.7 * 9.265 * (exp(e / 9.265) - 1)"""
    return 24.7 * 9.265 * (math.exp(e / 9.265) - 1.0)


def erb_widths(sr: int = SR_MODEL, fft: int = FFT, nb_bands: int = NB_ERB,
               min_nb_freqs: int = MIN_NB_ERB_FREQS) -> np.ndarray:
    """每个 ERB 带包含的 rfft 频点数，总和恒等于 fft//2+1（lib.rs:68-100 逐行移植）。

    注意 Rust 的 `f32::round` 是「四舍五入远离零」，而 Python 内建 round 是
    banker's rounding，这里必须用 floor(x+0.5) 才能与官方分带完全一致。
    """
    nyq = sr // 2
    freq_width = sr / float(fft)
    erb_low = _freq2erb(0.0)
    erb_high = _freq2erb(float(nyq))
    step = (erb_high - erb_low) / nb_bands
    widths = [0] * nb_bands
    prev_freq = 0
    freq_over = 0
    for i in range(1, nb_bands + 1):
        f = _erb2freq(erb_low + i * step)
        fb = int(math.floor(f / freq_width + 0.5))
        nb = fb - prev_freq - freq_over
        if nb < min_nb_freqs:
            freq_over = min_nb_freqs - nb
            nb = min_nb_freqs
        else:
            freq_over = 0
        widths[i - 1] = nb
        prev_freq = fb
    widths[-1] += 1  # lib.rs:93  因为有 WINDOW_SIZE/2+1 个频点
    too_large = sum(widths) - (fft // 2 + 1)
    if too_large > 0:
        widths[-1] -= too_large
    out = np.asarray(widths, dtype=np.int64)
    if int(out.sum()) != fft // 2 + 1:
        raise RuntimeError(f"erb_widths 总和 {int(out.sum())} != {fft // 2 + 1}")
    return out


def vorbis_window(fft: int = FFT) -> np.ndarray:
    """lib.rs:127-132  sin(pi/2 * sin^2(pi/2 * (i+0.5) / (fft/2)))，满足 Princen-Bradley。"""
    half = fft // 2
    i = np.arange(fft, dtype=np.float64)
    s = np.sin(0.5 * math.pi * (i + 0.5) / half)
    return np.sin(0.5 * math.pi * s * s).astype(np.float32)


def _calc_norm_alpha(sr: int = SR_MODEL, hop: int = HOP, tau: float = NORM_TAU) -> float:
    """tract.rs:989-999。本配置（48000/480/1）下结果为 0.99。"""
    dt = hop / float(sr)
    alpha = math.exp(-dt / tau)
    precision = 3
    a = 1.0
    while a >= 1.0:
        p = 10 ** precision
        a = math.floor(alpha * p + 0.5) / p
        precision += 1
    return a


# ══════════════════════════════════════════════════════
# 重采样（16k ↔ 48k，整数 3 倍，线性相位零平移）
# ══════════════════════════════════════════════════════

def _fftconv_same(x: np.ndarray, h: np.ndarray) -> np.ndarray:
    """overlap-add FFT 卷积，返回与 x 等长的居中结果（等价 np.convolve(x,h,'same')）。

    h 必须为奇数长度的对称核，居中截取才能保证零相位、无整体平移。
    """
    n, m = int(x.size), int(h.size)
    if m == 1:
        return (x * h[0]).astype(np.float32)
    block = 1 << 15
    step = block - m + 1
    if step <= 0:
        raise ValueError("滤波器过长")
    H = np.fft.rfft(h.astype(np.float64), block)
    full = np.zeros(n + m - 1, dtype=np.float64)
    for i in range(0, n, step):
        seg = x[i:i + step].astype(np.float64)
        if seg.size == 0:
            break
        y = np.fft.irfft(np.fft.rfft(seg, block) * H, block)[:seg.size + m - 1]
        full[i:i + seg.size + m - 1] += y
    off = (m - 1) // 2
    return full[off:off + n].astype(np.float32)


def _design_lp(up: int, half_len: int = 24, beta: float = 8.0) -> np.ndarray:
    """截止在 fs_high/(2*up) 的 Kaiser 窗 sinc 低通，长度 2*half_len*up+1（奇数、对称）。"""
    taps = 2 * half_len * up + 1
    n = np.arange(taps, dtype=np.float64) - (taps - 1) / 2.0
    h = np.sinc(n / float(up)) * np.kaiser(taps, beta)
    return h.astype(np.float64)


def _resample_up(x: np.ndarray, up: int) -> np.ndarray:
    """整数上采样：插零 + 低通（DC 增益归一到 up，保持幅度）。"""
    h = _design_lp(up)
    h = h * (up / h.sum())
    xz = np.zeros(int(x.size) * up, dtype=np.float32)
    xz[::up] = x
    return _fftconv_same(xz, h.astype(np.float32))


def _resample_down(x: np.ndarray, down: int, n_out: int) -> np.ndarray:
    """整数下采样：低通（DC 增益 1）+ 抽取，并把长度对齐到 n_out。"""
    h = _design_lp(down)
    h = h / h.sum()
    y = _fftconv_same(x, h.astype(np.float32))[::down]
    if y.size < n_out:
        y = np.concatenate([y, np.zeros(n_out - y.size, dtype=np.float32)])
    return y[:n_out]


# ══════════════════════════════════════════════════════
# STFT / 特征 / ISTFT
# ══════════════════════════════════════════════════════

def _stft(xp: np.ndarray, n_frames: int, win: np.ndarray, wnorm: float) -> np.ndarray:
    """分帧 STFT。帧 t 取 xp[t*HOP : t*HOP+FFT]，与 frame_analysis(lib.rs:356) 的
    「前半窗作用于上一帧、后半窗作用于当前帧」完全等价；末尾乘 wnorm（lib.rs:390）。"""
    out = np.empty((n_frames, FREQ_SIZE), dtype=np.complex64)
    step = 4096
    for t0 in range(0, n_frames, step):
        t1 = min(n_frames, t0 + step)
        idx = np.arange(FFT)[None, :] + HOP * np.arange(t0, t1)[:, None]
        frames = xp[idx] * win[None, :]
        out[t0:t1] = (np.fft.rfft(frames, axis=1) * wnorm).astype(np.complex64)
    return out


def _feat_erb(spec: np.ndarray, widths: np.ndarray, alpha: float) -> np.ndarray:
    """feat_erb（lib.rs:206-212）：每带平均功率 → 10*log10(x+1e-10) → EMA 均值归一。

    EMA（band_mean_norm_erb, lib.rs:244-251）含跨帧状态，必须逐帧递推。
    """
    starts = np.concatenate([[0], np.cumsum(widths)[:-1]]).astype(np.int64)
    power = (spec.real.astype(np.float32) ** 2 + spec.imag.astype(np.float32) ** 2)
    banded = np.add.reduceat(power, starts, axis=1) / widths[None, :].astype(np.float32)
    db = (np.log10(banded + 1e-10) * 10.0).astype(np.float32)

    state = np.linspace(MEAN_NORM_INIT[0], MEAN_NORM_INIT[1], NB_ERB).astype(np.float32)
    out = np.empty_like(db)
    a = np.float32(alpha)
    one_minus = np.float32(1.0 - alpha)
    for t in range(db.shape[0]):
        state = db[t] * one_minus + state * a
        out[t] = (db[t] - state) / np.float32(40.0)
    return out


def _feat_spec(spec: np.ndarray, alpha: float) -> np.ndarray:
    """feat_cplx（lib.rs:214-217 + band_unit_norm :253-259）：前 NB_DF 点除以 sqrt(EMA(|X|))。

    返回 [2, T, NB_DF]，channel 0 = 实部、1 = 虚部（tract.rs:460-463 的 permute 顺序）。
    """
    x = spec[:, :NB_DF]
    mag = np.abs(x).astype(np.float32)
    state = np.linspace(UNIT_NORM_INIT[0], UNIT_NORM_INIT[1], NB_DF).astype(np.float32)
    scale = np.empty_like(mag)
    a = np.float32(alpha)
    one_minus = np.float32(1.0 - alpha)
    for t in range(mag.shape[0]):
        state = mag[t] * one_minus + state * a
        scale[t] = np.sqrt(state)
    norm = x / np.maximum(scale, 1e-12)
    return np.stack([norm.real.astype(np.float32), norm.imag.astype(np.float32)], axis=0)


def _istft(spec: np.ndarray, win: np.ndarray) -> np.ndarray:
    """50% overlap-add 合成（lib.rs:396-427）。

    numpy 的 irfft 自带 1/N，而官方 realfft 的 inverse 不归一化，故乘回 FFT。
    合成侧再乘一次 vorbis 窗，w^2 的 Princen-Bradley 性质保证完美重构。
    """
    n_frames = spec.shape[0]
    y = np.empty((n_frames, HOP), dtype=np.float32)
    tail_prev = np.zeros(HOP, dtype=np.float32)
    step = 4096
    for t0 in range(0, n_frames, step):
        t1 = min(n_frames, t0 + step)
        frames = np.fft.irfft(spec[t0:t1], n=FFT, axis=1).astype(np.float32) * np.float32(FFT)
        frames *= win[None, :]
        head = frames[:, :HOP]
        tail = frames[:, HOP:]
        blk = head.copy()
        blk[0] += tail_prev
        blk[1:] += tail[:-1]
        y[t0:t1] = blk
        tail_prev = tail[-1]
    return y.reshape(-1)


# ══════════════════════════════════════════════════════
# ONNX 会话
# ══════════════════════════════════════════════════════

def _load_sessions(model_dir: str, session_factory):
    """加载三段图（带进程内缓存）。session_factory 由调用方注入（复用 provider 兜底链）。"""
    key = os.path.abspath(model_dir)
    cached = _SESS_CACHE.get(key)
    if cached is not None:
        return cached
    paths = {n: os.path.join(model_dir, f"{n}.onnx") for n in ("enc", "erb_dec", "df_dec")}
    for n, p in paths.items():
        if not os.path.isfile(p):
            return None
    sessions = {}
    ep_used = None
    for n, p in paths.items():
        sess, ep = session_factory(p)
        if sess is None:
            return None
        sessions[n] = sess
        ep_used = ep_used or ep
    out = (sessions, ep_used)
    _SESS_CACHE[key] = out
    return out


def _run_chunk(sessions: dict, feat_erb: np.ndarray, feat_spec: np.ndarray):
    """跑一块：enc → erb_dec / df_dec。返回 (m[L,32], coefs[L,96,10], lsnr[L])。"""
    enc = sessions["enc"]
    enc_out = enc.run(None, {"feat_erb": feat_erb, "feat_spec": feat_spec})
    names = [o.name for o in enc.get_outputs()]
    got = dict(zip(names, enc_out))
    emb, c0 = got["emb"], got["c0"]

    m = sessions["erb_dec"].run(["m"], {
        "emb": emb, "e3": got["e3"], "e2": got["e2"], "e1": got["e1"], "e0": got["e0"],
    })[0]
    # df_dec 有两个输出，第二个（sigmoid）官方推理未消费（tract.rs:498 / deepfilternet3.py:456），
    # 这里显式按名字取 coefs，避免依赖输出顺序。
    coefs = sessions["df_dec"].run(["coefs"], {"emb": emb, "c0": c0})[0]

    lsnr = np.asarray(got["lsnr"], dtype=np.float32).reshape(-1)
    return (np.asarray(m, dtype=np.float32).reshape(-1, NB_ERB),
            np.asarray(coefs, dtype=np.float32).reshape(-1, NB_DF, DF_ORDER * 2),
            lsnr)


# ══════════════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════════════

def enhance(au: np.ndarray, sr: int, model_dir: str, session_factory,
            lsnr_gate: bool = False, mask_soften: bool = True,
            mask_soften_floor: float = MASK_SOFTEN_GAIN_FLOOR):
    """对单声道波形做 DFN3 降噪。返回与输入等长的 float32，或 None（不可用 → 调用方降级）。

    参数
      au              : float32 [-1,1] 单声道
      sr              : 输入采样率（必须是 48000 或能整数升到 48000，如 16000）
      model_dir       : 含 enc/erb_dec/df_dec.onnx 的目录
      session_factory : (model_path) -> (session, ep)，由 core._onnx_session 注入
      lsnr_gate       : 是否启用 tract 的 lsnr 分级跳过（默认 False = 全帧两阶段，质量优先）
      mask_soften     : 高 SNR 时 mask 软化（默认 True）。用 ERB 掩码增益本身做连续混合
                        权重（**不用**官方 lsnr 二进制门控）：仅当某频带增益 ≥ 阈值
                        （MASK_SOFTEN_GAIN_FLOOR，默认 0.5，即「已较干净」）才朝原始频谱
                        回混以保留干净语音、抑制 deep filtering 在净区引入的染色；增益低于
                        阈值的频带视为仍需降噪 → 全增强。纯频谱线性运算，零平移不变。可用
                        环境变量 AICUT_DFN3_SOFTEN=0 关闭（退回硬掩码 + 硬 DF 覆盖）。
      mask_soften_floor: 软化增益阈值（默认 0.5，UI 可调 0.3~0.9 微调听感）。越低 → 越
                        激进回混（保真优先、保守降噪）；越高 → 仅对「非常干净」频带回混（强降噪）。
    """
    x = np.asarray(au, dtype=np.float32).reshape(-1)
    n_in = int(x.size)
    if n_in == 0:
        return None

    # 高 SNR mask 软化开关（环境变量逃生，默认开）
    mask_soften = bool(mask_soften) and os.environ.get("AICUT_DFN3_SOFTEN", "1") != "0"

    max_sec = float(os.environ.get("AICUT_DFN3_MAX_SEC", "900"))
    if n_in / float(sr) > max_sec:
        sys.stderr.write(f"[dfn3] 音频超过 {max_sec:.0f}s，跳过 DFN3（交给轻量方案）\n")
        return None

    if sr == SR_MODEL:
        up = 1
    elif SR_MODEL % sr == 0:
        up = SR_MODEL // sr
    else:
        sys.stderr.write(f"[dfn3] 采样率 {sr} 无法整数升到 48k，跳过\n")
        return None

    loaded = _load_sessions(model_dir, session_factory)
    if loaded is None:
        return None
    sessions, ep = loaded

    # ── 16k → 48k ──
    x48 = _resample_up(x, up) if up > 1 else x
    n48 = int(x48.size)

    # ── padding：左补 HOP（等价 analysis_mem 初始零），右补足够帧
    #    右侧需要 ≥ CONV_LOOKAHEAD 帧（供目标帧取到 m/coefs）+ 一个完整窗
    win = vorbis_window()
    wnorm = 1.0 / (FFT ** 2 / float(2 * HOP))     # lib.rs:133 → 1/960
    widths = erb_widths()
    alpha = _calc_norm_alpha()

    need = HOP + n48 + (CONV_LOOKAHEAD + 1) * HOP + FFT
    n_frames = int(math.ceil((need - FFT) / float(HOP))) + 1
    xp = np.zeros((n_frames - 1) * HOP + FFT, dtype=np.float32)
    xp[HOP:HOP + n48] = x48

    # ── STFT + 特征（EMA 逐帧递推）──
    spec = _stft(xp, n_frames, win, wnorm)
    f_erb = _feat_erb(spec, widths, alpha)[None, None, :, :]           # [1,1,T,32]
    f_spec = _feat_spec(spec, alpha)[None, :, :, :]                    # [1,2,T,96]

    # ── 分块推理 + 逐块应用（mask → deep filtering）──
    spec_enh = spec.copy()
    T = n_frames
    step = max(1, CHUNK_FRAMES - CHUNK_OVERLAP)
    half_ovl = CHUNK_OVERLAP // 2
    k_off = np.arange(DF_ORDER)[None, :] - DF_LOOKAHEAD

    s0 = 0
    while s0 < T:
        s1 = min(T, s0 + CHUNK_FRAMES)
        m_b, coefs_b, lsnr_b = _run_chunk(
            sessions,
            np.ascontiguousarray(f_erb[:, :, s0:s1, :]),
            np.ascontiguousarray(f_spec[:, :, s0:s1, :]),
        )
        # 丢弃块边界（GRU 未收敛）；首块保留开头，末块保留结尾
        t_lo = s0 if s0 == 0 else s0 + half_ovl
        t_hi = s1 if s1 == T else s1 - half_ovl
        tt = np.arange(t_lo, t_hi)
        jj = tt - CONV_LOOKAHEAD                      # 目标频谱帧
        keep = (jj >= 0) & (jj < T)
        tt, jj = tt[keep], jj[keep]
        if tt.size:
            loc = tt - s0
            gains = m_b[loc]                                          # [n,32]
            lsnr = lsnr_b[loc]
            erb_on = np.ones(tt.size, dtype=bool)
            df_on = np.ones(tt.size, dtype=bool)
            if lsnr_gate:
                # tract.rs:658-672 apply_stages
                zero_m = lsnr < MIN_DB_THRESH
                skip_all = lsnr > MAX_DB_ERB_THRESH
                erb_on = ~skip_all
                df_on = (~zero_m) & (~skip_all) & (lsnr <= MAX_DB_DF_THRESH)
                gains = np.where(zero_m[:, None], np.float32(0.0), gains)

            # ── ERB 掩码：整带广播乘（lib.rs:314-326，无插值）──
            g_full = np.repeat(gains, widths, axis=1)                  # [n,481]
            g_full = np.where(erb_on[:, None], g_full, np.float32(1.0))

            # ── Deep filtering：改写前 NB_DF 频点（tract.rs:586-597 + df :713-767）──
            # coefs 末维 10 = (df_order=5, 2)，2 为 (实,虚)（tract.rs:499）
            c = coefs_b[loc].reshape(-1, NB_DF, DF_ORDER, 2)
            cc = (c[..., 0] + 1j * c[..., 1]).astype(np.complex64).transpose(0, 2, 1)  # [n,5,96]
            idx = jj[:, None] + k_off                                  # [n,5] → j-2..j+2
            ok = (idx >= 0) & (idx < T)
            wnd = np.where(ok[..., None],
                           spec[np.clip(idx, 0, T - 1)][:, :, :NB_DF],
                           np.complex64(0))
            df_val = (cc * wnd).sum(axis=1)                            # [n,96]

            if mask_soften:
                # 高 SNR mask 软化：用 ERB 掩码增益本身做**连续**混合权重
                # （不用官方 lsnr 二进制门控）。增益≈1 → 该频带本就干净 → 朝原
                # 频谱回混以保留干净语音、抑制 DF 在净区引入的染色；增益低 → 全增强。
                # 纯频谱线性运算，零平移不变。
                _floor = min(float(mask_soften_floor), 0.99)          # 防御 floor→1 除零
                c_clean = np.clip((g_full - _floor) / max(1.0 - _floor, 1e-6),
                                  0.0, 1.0)                           # [n,481] 干净度权重
                # ERB 阶段：把 (spec*g_full) 按 c 朝原频谱回混
                spec_enh[jj] = spec[jj] * (c_clean + (1.0 - c_clean) * g_full)
                # Deep filtering 阶段：前 NB_DF 频点按 c 回混原频谱
                c_df = c_clean[:, :NB_DF]                              # [n,96]
                df_blend = c_df * spec[jj][:, :NB_DF] + (1.0 - c_df) * df_val
                sel = df_on
                if sel.any():
                    rows = jj[sel]
                    spec_enh[rows[:, None], np.arange(NB_DF)[None, :]] = df_blend[sel]
            else:
                # 原行为：硬掩码乘 + 硬 DF 覆盖
                spec_enh[jj] = spec[jj] * g_full
                sel = df_on
                if sel.any():
                    rows = jj[sel]
                    spec_enh[rows[:, None], np.arange(NB_DF)[None, :]] = df_val[sel]
        if s1 >= T:
            break
        s0 += step

    # ── ISTFT + 去掉左侧 HOP 补零 → 与输入样本级对齐 ──
    y48 = _istft(spec_enh, win)[HOP:HOP + n48]
    if y48.size < n48:
        y48 = np.concatenate([y48, np.zeros(n48 - y48.size, dtype=np.float32)])

    y = _resample_down(y48, up, n_in) if up > 1 else y48[:n_in]
    sys.stderr.write(f"[dfn3] DeepFilterNet3 降噪完成（{T} 帧 @ {ep}, gate={lsnr_gate}, soften={mask_soften}）\n")
    return np.clip(y, -1.0, 1.0).astype(np.float32)
