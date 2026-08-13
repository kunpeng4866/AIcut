# -*- coding: utf-8 -*-
"""真实内容超分效果评测：我们的 RRDBNet(SR) vs 双三次放大(bicubic)。

为什么需要它：
    之前审核报告的 PSNR 37.23dB 是在「合成 bicubic 退化测试集」上量的——
    即先把高清图 bicubic 缩小当 LR，再让模型放大回去和原图比。这是 SR 模型
    **最有利**的场景，会高估真实表现。

    而真正使用时，我们喂给模型的「LR」是**原生分辨率真实画面**
    （并没有被 bicubic 退化过），模型没有可恢复的真实低频细节，
    往往只能产出「≈ bicubic 的轻微锐化」，看起来和双三次差不多。

    本脚本复现这个差异：把你的真实视频降采样当 LR，分别用
      (a) RRDBNet 超分回原尺寸  → SR
      (b) 双三次放大回原尺寸    → bicubic 基线
    都和原视频(ground truth) 比 PSNR 与锐度(梯度方差)，
    直观看出：在真实内容上，模型到底比 bicubic 强多少（还是基本持平）。

用法（在你装有 onnxruntime-gpu 的原生环境，如 E:\Python310）：
    python eval_sr_real.py <输入视频> [--scale 2] [--frames 30] [--provider cuda]
                          [--degradation bicubic|realistic]

说明：
    - 只做评测，不改动任何工程文件、不写盘产物（临时帧在内存里）。
    - `--degradation realistic` 用「模糊+噪声」近似真实素材（比 bicubic 更贴近
      实际使用），此时 SR 若仍≈bicubic，就坐实了「训练分布错配」。
"""
import os
import sys
import json
import argparse
import subprocess

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from inference import SuperResolver, _ffmpeg_exe, _ffprobe_exe, default_model_path
from PIL import Image, ImageFilter


# ───────────────────────── 基础工具 ─────────────────────────

def _ffprobe_wh(input_path):
    cmd = [_ffprobe_exe(), "-v", "error",
           "-show_entries", "stream=width,height,r_frame_rate",
           "-of", "json", input_path]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
    info = json.loads(out.decode("utf-8", "ignore"))
    vs = next(s for s in info["streams"] if s.get("codec_type") == "video")
    w, h = int(vs["width"]), int(vs["height"])
    rfr = vs.get("r_frame_rate", "0/0")
    a, b = rfr.split("/")
    fps = float(a) / float(b) if float(b) > 0 else 30.0
    return w, h, fps


def _read_frames(input_path, w, h, max_frames):
    ff = _ffmpeg_exe()
    p = subprocess.Popen([ff, "-v", "error", "-i", input_path,
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                         stdout=subprocess.PIPE)
    fb = w * h * 3
    frames = []
    while len(frames) < max_frames:
        raw = p.stdout.read(fb)
        if not raw or len(raw) < fb:
            break
        frames.append(np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3))
    p.stdout.close()
    p.wait()
    return frames


def _make_lr(frames, scale, mode):
    """把原帧降采样当 LR。bicubic=干净退化(模型最有利);realistic=模糊+噪声(贴近真实)。"""
    lr = []
    for f in frames:
        im = Image.fromarray(f)
        small = im.resize((im.width // scale, im.height // scale), Image.BICUBIC)
        if mode == "realistic":
            small = small.filter(ImageFilter.GaussianBlur(radius=1.0))
            arr = np.asarray(small, dtype=np.float32)
            noise = np.random.normal(0, 3.0, arr.shape).astype(np.float32)
            small = Image.fromarray(np.clip(arr + noise, 0, 255).astype(np.uint8))
        lr.append(np.asarray(small, dtype=np.uint8))
    return lr


def _bicubic_up(frames, scale):
    out = []
    for f in frames:
        im = Image.fromarray(f).resize((f.shape[1] * scale, f.shape[0] * scale),
                                       Image.BICUBIC)
        out.append(np.asarray(im, dtype=np.uint8))
    return out


def _psnr(a, b):
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    mse = np.mean((a - b) ** 2)
    if mse <= 1e-10:
        return 99.0
    return 10.0 * np.log10(255.0 ** 2 / mse)


def _sharpness(frames):
    """梯度方差均值（越大越锐），作为相对锐度指标。"""
    tot = 0.0
    n = 0
    for f in frames:
        g = f.astype(np.float64)
        gx = np.diff(g, axis=1)
        gy = np.diff(g, axis=0)
        tot += float(np.mean(gx ** 2) + np.mean(gy ** 2))
        n += 1
    return tot / max(n, 1)


def _avg_psnr(pred_frames, gt_frames):
    return float(np.mean([_psnr(p, g) for p, g in zip(pred_frames, gt_frames)]))


# ───────────────────────── 主流程 ─────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--frames", type=int, default=30)
    ap.add_argument("--provider", default="cuda")
    ap.add_argument("--degradation", default="bicubic",
                    choices=["bicubic", "realistic"])
    ap.add_argument("--model", default=None)
    args = ap.parse_args()

    w, h, fps = _ffprobe_wh(args.input)
    print(f"[eval] 源 {w}x{h} @{fps:.2f}fps，取前 {args.frames} 帧，"
          f"退化模式={args.degradation}")

    orig = _read_frames(args.input, w, h, args.frames)
    if not orig:
        print("[eval] 读不到帧，退出")
        return
    print(f"[eval] 实际读到 {len(orig)} 帧")

    lr = _make_lr(orig, args.scale, args.degradation)
    sr_scale = SuperResolver(
        model_path=args.model or default_model_path(),
        scale=args.scale, tile_size=256, tile_overlap=32,
        provider=args.provider,
    )

    # 逐帧跑模型（3 帧滑动窗口，与正式推理一致）；首/末帧用自身补齐邻帧
    sr_out = []
    n = len(lr)
    for i in range(n):
        prev = lr[i - 1] if i > 0 else lr[i]
        nxt = lr[i + 1] if i < n - 1 else lr[i]
        sr_out.append(sr_scale.process_frame(prev, lr[i], nxt, strength=1.0))

    bic = _bicubic_up(lr, args.scale)

    psnr_sr = _avg_psnr(sr_out, orig)
    psnr_bi = _avg_psnr(bic, orig)
    sh_sr = _sharpness(sr_out)
    sh_bi = _sharpness(bic)
    sh_orig = _sharpness(orig)

    print("-" * 56)
    print(f"退化模式        : {args.degradation}")
    print(f"原图锐度(基准)  : {sh_orig:.2f}")
    print(f"双三次 PSNR     : {psnr_bi:.2f} dB    锐度 {sh_bi:.2f}")
    print(f"RRDBNet PSNR    : {psnr_sr:.2f} dB    锐度 {sh_sr:.2f}")
    print(f"ΔPSNR(SR-bic)   : {psnr_sr - psnr_bi:+.2f} dB")
    print(f"锐度比(SR/原图) : {sh_sr / sh_orig:.3f}   "
          f"锐度比(bic/原图): {sh_bi / sh_orig:.3f}")
    print("-" * 56)
    if (psnr_sr - psnr_bi) < 1.0:
        print("结论：在真实内容上，模型相比双三次几乎无增益 —— "
              "印证「训练分布(合成 bicubic LR)与真实素材错配」。")
    else:
        print("结论：模型在真实内容上仍有可观增益，质量基本可用。")


if __name__ == "__main__":
    main()
