# -*- coding: utf-8 -*-
r"""
bench_denoise.py — 口播降噪「客观评测脚手架」(A/B 基准)

用途
----
在 DFN3(DeepFilterNet3) 真推理实现之前，先把客观评测脚手架搭好。等 lead 把
`core._denoise_onnx` 换成 DFN3 三段图 ONNX 后，即可一键跑：

    python bench_denoise.py --backend auto      # 期望日后走 onnx
    python bench_denoise.py --backend lightweight  # 强制走轻量谱减基线

对比两张表，用数据判断「是否真的更好、有没有引入损伤」。

设计要点（硬约束）
------------------
* 仅新建本文件，**不修改 core.py**（lead 正在并行改它，会冲突）。
* 后端切换用 monkeypatch：导入 core 后，把 `core._denoise_onnx` 临时替换成
  `lambda au, sr: None` 来模拟 lightweight（让 `denoise_wav` 必然回退到
  `_denoise_lightweight`）；`auto` 则保留原函数，由 core 的默认逻辑决定走 onnx
  还是 lightweight。用完在 finally 里恢复原函数。
* 仅依赖 numpy + 标准库 + ffmpeg 命令行，**不引入新 pip 依赖**。
* 不下载任何模型权重。
* 纯 numpy 实现所有指标（不依赖 pesq/pystoi 等）。
* 单个样本失败不影响整批：捕获异常，在表里标 FAIL + 原因。

指标说明
--------
* SNR 改善 (dSNR, dB)：snr_out - snr_in，用干净参考对齐后计算（需有干净参考）。
  注意这是**波形级**指标：输入已经很干净时（15dB 档），增强模型引入的处理失真
  会略大于它去掉的噪声，dSNR 出现 -1~-2dB 属正常（真实语音实测 -1.5dB，
  且整体增益 a≈0.91 无衰减），不代表回归。判断是否真的过抑制要看增益 a。
* 静音残余降低 (silR, dB)：停顿段的输出 RMS 比输入 RMS 低多少 dB。
* 语音失真 (LSD, dB)：语音段的 log 谱距离，越低越好（防把人声削坏）。
* 对齐 (lag_ms / align)：输出长度必须 == 输入长度；互相关确认无整体时间偏移。
  这条最重要——下游依赖词级时间戳，降噪绝不允许整体平移。
* 削波 (clip)：|y|>0.999 的样本数。
* 边界尖峰 (edge)：首尾 50ms 是否出现输入里没有的新能量（STFT 重叠相加伪影）。
* 实时率 (RTx)：audio_dur / wall_time。

运行
----
    python bench_denoise.py [--backend auto|lightweight] [--out DIR]
后端也可用环境变量 AICUT_DENOISE_BACKEND 指定。默认 out=E:\AIcut\verify_tmp\denoise_bench\
"""
from __future__ import annotations

import os
import sys
import json
import argparse
import subprocess
import shutil
import tempfile

import numpy as np

# ── 在 import onnxruntime 之前必须先导入 core（core 内 CUDA DLL 路径注入依赖它）。
#    本脚手架当前两种后端都不会真正触发 onnxruntime（无权重时 _denoise_onnx 提前
#    返回 None），但保持先 import core 的习惯，避免日后 lead 启用 DFN3 后 CUDA EP 失败。
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import core  # noqa: E402

SR = 16000
N_FFT = 512
HOP = 256
SEED = 20240826
REAL_SAMPLE = r"C:\Users\Administrator\Documents\录音\仓哥有温度.m4a"


# ══════════════════════════════════════════════════════
# 1. 测试素材生成
# ══════════════════════════════════════════════════════
def make_speech_clean(dur: float = 6.0):
    """合成类语音干净参考 + 停顿/语音区间标签。

    结构：3 段浊音活动，中间夹 2 段 >0.5s 静音停顿（[1.0,1.6]、[3.0,3.6]），
    模拟口播。

    谱结构必须贴近真实语音，否则落在 DNN 增强模型（DFN3）的训练分布之外：
    早期版本只有 5 次谐波（750Hz 截止、1kHz 以上能量 0.0%），15dB 高 SNR 档
    被模型当作低频嗡鸣整体衰减 5.4dB（增益 a=0.54），产出 dSNR≈-9dB 的
    误导性结论；真实语音同档只 -1.5dB 且增益 a=0.91。故：
      - 浊音：基频 150Hz 谐波列覆盖到 ~7.5kHz，声门源 -12dB/oct 斜率 +
        3 共振峰（700/1220/2600Hz，洛伦兹型）包络；
      - 清音：每段活动内插 3 个 40–60ms 带通(2–7kHz)噪声突发，模拟 /s//sh/ 摩擦音。
    返回 (clean_float32, silence_ranges, speech_ranges)，区间单位秒。
    """
    rng = np.random.default_rng(SEED + 1)
    n = int(SR * dur)
    t = np.arange(n) / SR
    f0 = 150.0
    acts = [(0.0, 1.0), (1.6, 3.0), (3.6, dur)]
    silence_ranges = [(1.0, 1.6), (3.0, 3.6)]
    speech_ranges = acts

    # 声道传输函数：3 共振峰（洛伦兹）× 声门源 -12dB/oct
    F = np.array([700.0, 1220.0, 2600.0])
    BW = np.array([80.0, 120.0, 180.0])
    A = np.array([1.0, 0.7, 0.4])

    def _h_gain(f):
        g = float(np.sum(A * BW ** 2 / ((f - F) ** 2 + BW ** 2)))
        return g * (f0 / f) ** 2

    harmonics = [(h, _h_gain(f0 * h)) for h in range(1, 51) if f0 * h < 7600]

    sig = np.zeros(n, dtype=np.float64)
    for (s, e) in acts:
        m = (t >= s) & (t < e)
        env = (0.5 + 0.5 * np.sin(2 * np.pi * 5.0 * t[m])) ** 2.0  # 音节包络
        # 轻微随机相位，避免每次完全一样
        ph = rng.uniform(0, 2 * np.pi, size=1)
        for h, amp in harmonics:
            sig[m] += amp * np.sin(2 * np.pi * f0 * h * t[m] + ph * h) * env
    sig /= (np.max(np.abs(sig)) + 1e-9)

    # 清音（摩擦音）突发：带通 2–7kHz 白噪，只落在活动段内并避开边界
    fric = np.zeros(n, dtype=np.float64)
    for (s, e) in acts:
        if e - s < 0.3:
            continue
        for _ in range(3):
            d = rng.uniform(0.04, 0.06)
            st = rng.uniform(s + 0.05, e - d - 0.05)
            i0, i1 = int(st * SR), int((st + d) * SR)
            if i1 - i0 > 4:
                fric[i0:i1] += rng.standard_normal(i1 - i0) * np.hanning(i1 - i0)
    if np.any(fric):
        nf = 1 << int(np.ceil(np.log2(n)))
        fq = np.fft.rfftfreq(nf, 1.0 / SR)
        spec = np.fft.rfft(fric, nf)
        spec[(fq < 2000) | (fq > 7000)] = 0.0
        fric = np.fft.irfft(spec, nf)[:n]
        fric /= (np.max(np.abs(fric)) + 1e-9)
        sig += 0.35 * fric

    sig /= (np.max(np.abs(sig)) + 1e-9)
    sig = (sig * 0.7).astype(np.float32)  # 留出余量，避免混合后削波
    # 静音段严格归零（带通滤波的 sinc 尾巴不允许泄漏进停顿）
    for (s, e) in silence_ranges:
        sig[int(s * SR):int(e * SR)] = 0.0
    return sig, silence_ranges, speech_ranges


def _white(N, rng):
    return rng.standard_normal(N).astype(np.float32)


def _pink(N, rng):
    """Paul Kellet 粉噪 (≈1/f)，向量化后逐点递推。"""
    white = rng.standard_normal(N)
    b = np.zeros(7)
    out = np.zeros(N, dtype=np.float32)
    for i in range(N):
        w = white[i]
        b[0] = 0.99886 * b[0] + w * 0.0555179
        b[1] = 0.99332 * b[1] + w * 0.0750759
        b[2] = 0.96900 * b[2] + w * 0.1538520
        b[3] = 0.86650 * b[3] + w * 0.3104856
        b[4] = 0.55000 * b[4] + w * 0.5329522
        b[5] = -0.7616 * b[5] - w * 0.0168980
        out[i] = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362
        b[6] = w * 0.115926
    out /= (np.std(out) + 1e-12)
    return out.astype(np.float32)


def _hum(N):
    """低频电流轰鸣：50/100/150Hz 正弦 + 轻微幅度摆动（空调/电源）。"""
    t = np.arange(N) / SR
    sig = (0.8 * np.sin(2 * np.pi * 50 * t)
           + 0.6 * np.sin(2 * np.pi * 100 * t)
           + 0.3 * np.sin(2 * np.pi * 150 * t)
           + 0.1 * np.sin(2 * np.pi * 0.5 * t))
    sig = sig.astype(np.float32)
    sig /= (np.std(sig) + 1e-12)
    return sig


def _fan(N):
    """宽带风扇噪：带通(200–4000Hz)白噪，用 1 阶 IIR 级联近似。"""
    rng = np.random.default_rng(SEED + 7)
    x = rng.standard_normal(N).astype(np.float32)

    def hp(sig, fc):
        rc = 1.0 / (2 * np.pi * fc)
        a = rc / (rc + 1.0)
        y = np.empty_like(sig)
        y[0] = a * sig[0]
        for i in range(1, N):
            y[i] = a * (y[i - 1] + sig[i] - sig[i - 1])
        return y

    def lp(sig, fc):
        rc = 1.0 / (2 * np.pi * fc)
        a = 1.0 / (rc + 1.0)
        y = np.empty_like(sig)
        y[0] = sig[0]
        for i in range(1, N):
            y[i] = y[i - 1] + a * (sig[i] - y[i - 1])
        return y

    y = hp(x, 200.0)
    y = lp(y, 4000.0)
    y /= (np.std(y) + 1e-12)
    return y.astype(np.float32)


NOISE_GENS = {
    "white": lambda N, rng: _white(N, rng),
    "pink": lambda N, rng: _pink(N, rng),
    "hum": lambda N, rng: _hum(N),
    "fan": lambda N, rng: _fan(N),
}
NOISE_LABELS = {
    "white": "白噪",
    "pink": "粉噪(1/f)",
    "hum": "低频轰鸣(50/100Hz)",
    "fan": "宽带风扇噪",
}

SNR_LEVELS = [0, 5, 15]


def mix_clean(clean, noise, snr_db):
    """把 unit-variance 噪声按目标输入 SNR 混到 clean 上。"""
    pc = float(np.mean(clean ** 2))
    target_pn = pc / (10.0 ** (snr_db / 10.0))
    scale = np.sqrt(target_pn)
    noisy = (clean + scale * noise).astype(np.float32)
    return noisy


# ══════════════════════════════════════════════════════
# 2. 指标（纯 numpy）
# ══════════════════════════════════════════════════════
def _snr_of(clean, est):
    """est 相对 clean 的 SNR(dB)；est 与 clean 等长且已对齐。"""
    pc = float(np.mean(clean ** 2))
    pe = float(np.mean((est - clean) ** 2))
    if pe < 1e-12:
        return 60.0
    return 10.0 * np.log10(pc / pe)


def _rms_db(x):
    r = float(np.sqrt(np.mean(x ** 2)))
    if r < 1e-12:
        return -120.0
    return 20.0 * np.log10(r)


def _stft_mag(x):
    n = len(x)
    if n < N_FFT:
        return np.abs(np.fft.rfft(x, n=N_FFT))[None, :]
    nframes = 1 + (n - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(nframes)[:, None]
    seg = x[idx] * np.hanning(N_FFT)
    return np.abs(np.fft.rfft(seg, axis=1))


def log_spectral_distance(clean_seg, out_seg):
    """语音段 log 谱距离(dB)，越低越好——衡量人声有没有被削坏。

    只在「语音实际存在」的频点比较（每帧取相对能量 > -30dB 的频点），避免把本应
    静音的频点（残余噪声很大）算进来把 LSD 撑爆，从而真正反映语音谱的失真。
    """
    Pc = _stft_mag(clean_seg) ** 2 + 1e-12
    Py = _stft_mag(out_seg) ** 2 + 1e-12
    lc = 10.0 * np.log10(Pc)
    ly = 10.0 * np.log10(Py)
    per_frame_max = Pc.max(axis=1, keepdims=True)
    present = Pc > (per_frame_max * 1e-3 + 1e-12)  # 语音存在的频点
    diffs = lc - ly
    vals = []
    for fr in range(lc.shape[0]):
        m = present[fr]
        if int(m.sum()) < 3:
            continue
        vals.append(float(np.sqrt(np.mean(diffs[fr][m] ** 2))))
    return float(np.mean(vals)) if vals else 0.0


def best_lag(ref, out, max_lag=512, margin=0.02):
    """归一化互相关找整体时间偏移（样本）。限定搜索窗，效率足够且能抓真实平移。

    两条硬要求（早期版本各踩一次）：
    1. ref 必须是**输入音频**而非干净参考——下游词级时间戳建立在输入音频轴上；
       用 clean 做参考时"被正确去掉的噪声"会算进失配，把结论带偏。
    2. 必须归一化 + 要求峰值显著超过 lag=0 才判平移。准周期语音的互相关在
       ±1 个基频周期处存在近乎等高的次峰（实测 r 差 <0.3%），未归一化的
       argmax 会随机跳到 ±107 样本（-6.688ms），产生纯属抖动的假警报。
    """
    N = min(len(ref), len(out))
    ref = np.asarray(ref[:N], dtype=np.float64)
    out = np.asarray(out[:N], dtype=np.float64)
    vals = {}
    for lag in range(-max_lag, max_lag + 1):
        if lag >= 0:
            va, vb = ref[: N - lag], out[lag:N]
        else:
            va, vb = ref[-lag:], out[: N + lag]
        if va.size == 0:
            continue
        d = np.sqrt(float(va @ va) * float(vb @ vb)) + 1e-20
        vals[lag] = float(va @ vb) / d
    if not vals:
        return 0
    peak = max(vals, key=vals.get)
    return peak if vals[peak] > vals.get(0, -np.inf) + margin else 0


def _ranges_to_mask(n, ranges, sr):
    mask = np.zeros(n, dtype=bool)
    for (s, e) in ranges:
        mask[int(s * sr): int(e * sr)] = True
    return mask


def evaluate(noisy, out, clean, sr, silence_ranges, speech_ranges, has_clean):
    """计算全部指标，返回 dict。clean 为 None 时跳过 SNR/LSD（真实样本无干净参考）。"""
    m = {}
    n = len(out)
    m["len_in"] = len(noisy)
    m["len_out"] = n
    m["len_ok"] = (len(noisy) == n)

    # 对齐：互相关。参考恒为**输入音频** noisy——词级时间戳建立在输入轴上，
    # 用 clean 做参考会把"被正确去掉的噪声"算成失配（详见 best_lag 注释）。
    ref = noisy
    if len(ref) != n:
        ref = ref[:n] if len(ref) > n else np.concatenate([ref, np.zeros(n - len(ref))])
    lag = best_lag(ref, out)
    m["lag_samples"] = lag
    m["lag_ms"] = round(lag / sr * 1000.0, 3)
    m["align_ok"] = m["len_ok"] and abs(lag) <= 1  # 容差 1 样本(<0.1ms)

    # 削波
    m["clip_count"] = int(np.sum(np.abs(out) > 0.999))
    m["peak"] = float(np.max(np.abs(out)))

    # 边界尖峰：首尾 50ms 是否出现输入里没有的新能量
    edge = int(0.05 * sr)
    in_edge_max = float(max(np.max(np.abs(noisy[:edge])), np.max(np.abs(noisy[-edge:])))) if n > 2 * edge else 1e-3
    out_edge_max = float(max(np.max(np.abs(out[:edge])), np.max(np.abs(out[-edge:])))) if n > 2 * edge else 0.0
    m["edge_spike"] = bool(out_edge_max > 3.0 * max(in_edge_max, 1e-3))
    m["edge_ratio"] = round(out_edge_max / max(in_edge_max, 1e-3), 2)

    if has_clean:
        # SNR 改善
        snr_in = _snr_of(clean, noisy)
        snr_out = _snr_of(clean, out)
        m["snr_in"] = round(snr_in, 2)
        m["snr_out"] = round(snr_out, 2)
        m["dsnr"] = round(snr_out - snr_in, 2)

        # 语音整体增益 a = <out,clean>/<clean,clean>：区分「正常处理失真」与
        # 「过抑制」的关键判据。a≈0.9–1.0 正常；a<0.8 表示语音本身被衰减。
        # 高 SNR 档 dSNR 转负必须配合 a 一起读，否则会误判为回归。
        cc = float(np.dot(clean, clean))
        m["gain"] = round(float(np.dot(out, clean)) / cc, 4) if cc > 1e-20 else None

        # 静音残余降低
        sm = _ranges_to_mask(n, silence_ranges, sr)
        if sm.any():
            sil_in_db = _rms_db(noisy[sm])
            sil_out_db = _rms_db(out[sm])
            m["sil_in_db"] = round(sil_in_db, 2)
            m["sil_out_db"] = round(sil_out_db, 2)
            m["sil_red"] = round(sil_in_db - sil_out_db, 2)
        else:
            m["sil_red"] = None

        # 语音失真 LSD（逐语音段平均）
        smask = _ranges_to_mask(n, speech_ranges, sr)
        vals = []
        for (s, e) in speech_ranges:
            a, b = int(s * sr), int(e * sr)
            if b - a >= N_FFT:
                vals.append(log_spectral_distance(clean[a:b], out[a:b]))
        m["lsd"] = round(float(np.mean(vals)), 2) if vals else None
    else:
        # 真实样本：低频能量区噪声底的降低量
        m["snr_in"] = None
        m["snr_out"] = None
        m["dsnr"] = None
        m["lsd"] = None
        fl = N_FFT
        hp2 = fl // 2
        nframes = max(1, 1 + (n - fl) // hp2)
        idx = np.arange(fl)[None, :] + hp2 * np.arange(nframes)[:, None]
        seg = out[idx]
        rms = np.sqrt(np.mean(seg ** 2, axis=1))
        k = max(1, int(0.1 * nframes))
        quiet = np.argsort(rms)[:k]
        q_flat_in = np.concatenate([noisy[idx[i]] for i in quiet])
        q_flat_out = np.concatenate([out[idx[i]] for i in quiet])
        nf_in = _rms_db(q_flat_in)
        nf_out = _rms_db(q_flat_out)
        m["noisefloor_in_db"] = round(nf_in, 2)
        m["noisefloor_out_db"] = round(nf_out, 2)
        m["sil_red"] = round(nf_in - nf_out, 2)  # 复用 sil_red 列展示噪声底降低量
    return m


# ══════════════════════════════════════════════════════
# 3. 后端切换 + 单样本处理
# ══════════════════════════════════════════════════════
def apply_backend_patch(backend):
    """monkeypatch core._denoise_onnx。返回原函数，调用方负责恢复。

    lightweight：强制 _denoise_onnx 返回 None → denoise_wav 必回退轻量谱减。
    auto：保留 core 原逻辑（日后 DFN3 就位会自动走 onnx）。
    """
    orig = core._denoise_onnx
    if backend == "lightweight":
        core._denoise_onnx = lambda au, sr: None
    return orig


def process_case(name, clean, noisy, silence_ranges, speech_ranges, sr, out_dir, backend):
    row = {"case": name, "backend": backend}
    try:
        in_path = os.path.join(out_dir, f"{name}_noisy.wav")
        out_path = os.path.join(out_dir, f"{name}_denoised.wav")
        core._write_wav(in_path, noisy, sr)
        t0 = __import__("time").perf_counter()
        ok, method, warning = core.denoise_wav(in_path, out_path)
        wall = __import__("time").perf_counter() - t0
        row["method"] = method
        row["warning"] = warning
        if not ok:
            row["status"] = "FAIL"
            row["reason"] = warning or "denoise_wav returned ok=False"
            return row
        out, _ = core._read_wav(out_path)
        audio_dur = len(noisy) / sr
        row["rt_x"] = round(audio_dur / wall, 1) if wall > 0 else None
        row["wall_s"] = round(wall, 4)
        has_clean = clean is not None
        m = evaluate(noisy, out, clean, sr, silence_ranges, speech_ranges, has_clean)
        row.update(m)
        # 对齐是唯一硬失败项（影响词级时间戳）
        if not m["align_ok"]:
            row["status"] = "WARN_ALIGN"
            row["reason"] = f"len_ok={m['len_ok']} lag={m['lag_ms']}ms"
        else:
            row["status"] = "OK"
            row["reason"] = ""
    except Exception as e:
        row["status"] = "FAIL"
        row["reason"] = f"{type(e).__name__}: {e}"
    return row


def find_quiet_ranges(au, sr, frac=0.15, win=0.2):
    """能量法找最安静的若干块作为「停顿段」（真实录音无人工标签时用）。

    返回 [(start_s, end_s)]，取短时 RMS 最低的 frac 比例块并按时间合并。
    """
    w = max(1, int(win * sr))
    nb = au.size // w
    if nb < 4:
        return []
    rms = np.sqrt(np.mean(au[: nb * w].reshape(nb, w) ** 2, axis=1))
    k = max(1, int(frac * nb))
    picked = sorted(np.argsort(rms)[:k].tolist())
    ranges, s, p = [], picked[0], picked[0]
    for i in picked[1:]:
        if i == p + 1:
            p = i
            continue
        ranges.append((s * win, (p + 1) * win))
        s = p = i
    ranges.append((s * win, (p + 1) * win))
    return ranges


def maybe_real_sample(out_dir, backend, dur=30):
    """真实口播样本：ffmpeg 转 16k 单声道、截取前 dur 秒。不存在则优雅跳过。"""
    if not os.path.exists(REAL_SAMPLE):
        return None
    try:
        wav = os.path.join(out_dir, "_real_16k.wav")
        ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
        subprocess.run([ffmpeg, "-y", "-i", REAL_SAMPLE, "-ac", "1", "-ar",
                        str(SR), "-t", str(dur), wav],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=120)
        au, sr = core._read_wav(wav)
        if au.size == 0:
            return None
        return au, sr
    except Exception as e:
        sys.stderr.write(f"[bench] 真实样本处理跳过: {e}\n")
        return None


# ══════════════════════════════════════════════════════
# 4. 输出（控制台表 + report.md + report.json）
# ══════════════════════════════════════════════════════
def _fmt(v, nd=2):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def _row_cells(r):
    """一行的展示单元（控制台表与 report.md 共用，避免两处漂移）。"""
    return [
        r.get("case", ""), r.get("method", "-"),
        _fmt(r.get("snr_in"), 1), _fmt(r.get("dsnr")), _fmt(r.get("gain"), 3),
        _fmt(r.get("sil_red")), _fmt(r.get("lsd")), _fmt(r.get("lag_ms"), 3),
        "PASS" if r.get("align_ok") else "FAIL",
        _fmt(r.get("clip_count"), 0) if r.get("clip_count") is not None else "-",
        "Y" if r.get("edge_spike") else "n",
        _fmt(r.get("rt_x"), 1), r.get("status", "-"),
    ]


TABLE_HDR = ["case", "method", "snr_in", "dSNR", "gain", "silR", "LSD",
             "lag(ms)", "align", "clip", "edge", "RTx", "status"]


def print_table(rows):
    cols = [16, 12, 7, 7, 7, 7, 7, 8, 6, 6, 6, 8, 9]
    line = "  ".join(h.ljust(c) for h, c in zip(TABLE_HDR, cols))
    print("\n" + line)
    print("-" * len(line))
    for r in rows:
        print("  ".join(str(v).ljust(c) for v, c in zip(_row_cells(r), cols)))
    print()


def write_reports(rows, out_dir, backend, py_exe):
    md = [f"# 降噪客观评测报告 (backend=`{backend}`)", "",
          f"- Python: `{py_exe}`",
          f"- 采样率: {SR} Hz",
          f"- 素材: `synth_*` 合成类语音（4 噪声 × 3 SNR 档）；"
          f"`real_*` 真实口播录音叠已知噪声（有干净参考，质量判据以此为准）；"
          f"`real_raw` 真实录音原样（无参考，只看噪声底/对齐）",
          f"- 指标: dSNR=SNR 改善, gain=语音整体增益(0.9–1.0 正常, <0.8 过抑制), "
          f"silR=静音残余降低, LSD=语音失真(越低越好), lag=整体时间偏移(必须 0), "
          f"clip=削波样本数, edge=边界尖峰", "",
          f"> 合成素材是稳态周期信号，落在 DNN 增强模型训练分布外：15dB 高 SNR 档"
          f"会被整体衰减（gain≈0.6）而产出 dSNR≈-7dB 的误导值。**质量结论只看 "
          f"`real_*` 行**；`synth_*` 仅用于对齐/削波/边界/实时率等硬回归。", "",
          "| " + " | ".join(TABLE_HDR) + " |",
          "| " + " | ".join(["---"] * len(TABLE_HDR)) + " |"]
    for r in rows:
        md.append("| " + " | ".join(str(c) for c in _row_cells(r)) + " |")
    fails = [r for r in rows if r.get("status", "").startswith("FAIL")]
    warns = [r for r in rows if r.get("status", "").startswith("WARN")]
    md += ["", "## 失败/告警", ""]
    if not fails and not warns:
        md.append("无。全部对齐全 PASS。")
    else:
        for r in fails + warns:
            md.append(f"- **{r.get('case')}** `{r.get('status')}`: {r.get('reason','')}")
    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump({"backend": backend, "rows": rows}, f, ensure_ascii=False, indent=2)


def main():
    ap = argparse.ArgumentParser(description="口播降噪客观评测脚手架")
    ap.add_argument("--backend", choices=["auto", "lightweight"],
                    default=os.environ.get("AICUT_DENOISE_BACKEND", "auto"),
                    help="denoise 后端：lightweight 强制轻量谱减；auto 走 core 默认逻辑")
    ap.add_argument("--out", default=r"E:\AIcut\verify_tmp\denoise_bench",
                    help="输出目录（默认 E:\\AIcut\\verify_tmp\\denoise_bench）")
    args = ap.parse_args()

    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    py_exe = sys.executable
    print(f"[bench] Python: {py_exe}")
    print(f"[bench] backend={args.backend}  out={out_dir}")

    orig = apply_backend_patch(args.backend)
    try:
        rows = []
        rng = np.random.default_rng(SEED)
        clean, silence_ranges, speech_ranges = make_speech_clean()
        N = clean.size
        for nk in NOISE_GENS:
            noise = NOISE_GENS[nk](N, rng)
            for snr in SNR_LEVELS:
                noisy = mix_clean(clean, noise, snr)
                name = f"synth_{nk}_{snr}dB"
                rows.append(process_case(name, clean, noisy, silence_ranges,
                                         speech_ranges, SR, out_dir, args.backend))

        # 真实样本：① 原样（无参考，只看噪声底/对齐）② 叠已知噪声（有干净参考，
        # 质量结论以这组为准——合成素材在高 SNR 档会因 OOD 产出误导性 dSNR）
        real = maybe_real_sample(out_dir, args.backend)
        if real is not None:
            au, sr = real
            rows.append(process_case("real_raw", None, au, [], [], sr,
                                     out_dir, args.backend))
            ref = au[: int(20 * sr)].astype(np.float32)  # 前 20s 当准 clean
            r_sil = find_quiet_ranges(ref, sr)
            r_sp = [(0.0, ref.size / sr)]
            for nk in ("white", "fan"):
                noise = NOISE_GENS[nk](ref.size, np.random.default_rng(SEED))
                for snr in SNR_LEVELS:
                    noisy = mix_clean(ref, noise, snr)
                    ref_c = ref
                    peak = float(np.max(np.abs(noisy)))
                    if peak > 0.99:  # 真实录音峰值高，叠噪后需防削波
                        s = 0.99 / peak  # clean 参考必须同比例缩放，否则 SNR/gain 全错
                        noisy = (noisy * s).astype(np.float32)
                        ref_c = (ref * s).astype(np.float32)
                    rows.append(process_case(f"real_{nk}_{snr}dB", ref_c, noisy,
                                             r_sil, r_sp, sr, out_dir, args.backend))
            print(f"[bench] 已纳入真实样本: 原样 {len(au)/sr:.1f}s + "
                  f"叠噪 {len(SNR_LEVELS) * 2} 例（参考 {ref.size/sr:.0f}s）")
        else:
            print(f"[bench] 真实样本缺失，跳过: {REAL_SAMPLE}")
    finally:
        core._denoise_onnx = orig  # 恢复，避免影响后续 import core 的代码

    print_table(rows)
    write_reports(rows, out_dir, args.backend, py_exe)
    print(f"[bench] 报告已写出: {os.path.join(out_dir, 'report.md')}")


if __name__ == "__main__":
    main()
