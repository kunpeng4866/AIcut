# -*- coding: utf-8 -*-
"""视频超清增强训练脚本（RRDBNet + PatchGAN 对抗训练 / Phase 0）。

损失：L1 + 0.2*MS-SSIM + 0.005*GAN + 0.01*temporal
调度：warmup(5000 iter) → cosine annealing
精度：CUDA 可用时启用 AMP（torch.amp）；CPU 下自动关闭
产物：output_dir/model_g_{iter}.pth、model_d_{iter}.pth

用法：
    python train.py --data_dir <dir> --output_dir <dir> [--num_iterations 100000]
    python train.py --config train_config.json

技术约束（Phase 0 硬性）：
    - 不用 torchvision / cv2 / tqdm；SSIM、进度打印均自实现。
    - torch 当前为 CPU 版（2.13.0+cpu），代码需同时支持 GPU 与 CPU 回退。
    - 使用 torch.amp.{GradScaler,autocast}（torch.cuda.amp.* 在 2.13 已废弃告警）。

合规硬约束：
    禁止加载任何第三方预训练权重 / 商业 SDK。模型架构参考 Real-ESRGAN 的 RRDBNet
    (BSD 3-Clause)，权重必须自行从零训练；--model_path 只允许指向本项目自训练的产物。
"""
import os
import sys
import json
import math
import time
import argparse

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from dataset import SRVideoDataset  # noqa: E402


DEFAULTS = {
    "data_dir": None,
    "val_dir": None,
    "output_dir": os.path.join(_HERE, "checkpoints"),
    "model_path": None,          # 预训练 generator 权重（finetune 用）
    "model_d_path": None,        # 预训练 discriminator 权重（可选）
    "num_iterations": 100000,
    "batch_size": 4,
    "lr_g": 1e-4,
    "lr_d": 1e-4,
    "patch_size": 256,
    "device": "cuda",
    "save_interval": 5000,
    "val_interval": 2000,
    "log_interval": 100,
    "warmup_iters": 5000,
    "num_workers": 0,
    "scale": 2,
    "num_block": 12,
    "num_feat": 64,
    "num_grow_ch": 32,
    # 训练用 'none'：RRDBNet 默认的 'clamp' 会把 [0,1] 外的输出梯度截断为 0，
    # 早期迭代大量像素落在区间外，会显著拖慢收敛。推理/导出时再用 'clamp' 保证值域。
    "out_mode": "none",
    "w_l1": 1.0,
    "w_msssim": 0.2,
    "w_gan": 0.005,
    "w_temporal": 0.01,
    "val_samples": 32,
    "seed": 0,
    "scene_categories": None,
}


def _log(msg):
    """进度输出统一走 stderr（stdout 留给 JSON 协议 / 管道）。"""
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def _import_models():
    """延迟导入模型定义，使 `import train` 不强依赖 model.py 落地。"""
    try:
        from model import RRDBNet, PatchDiscriminator, MSSSIMLoss
    except ImportError as e:
        raise ImportError(
            "无法从 model.py 导入 RRDBNet/PatchDiscriminator/MSSSIMLoss（%s）。"
            "请确保 %s 下存在 model.py。" % (e, _HERE))
    return RRDBNet, PatchDiscriminator, MSSSIMLoss


# ───────────────────────── 评估指标 ─────────────────────────

def _gaussian_window(size, sigma, channels, device, dtype):
    coords = torch.arange(size, dtype=torch.float32) - (size - 1) / 2.0
    g = torch.exp(-(coords ** 2) / (2.0 * sigma ** 2))
    g = g / g.sum()
    win = torch.outer(g, g)
    return win.expand(channels, 1, size, size).contiguous().to(device=device, dtype=dtype)


def ssim(x, y, window=None, size=11, sigma=1.5):
    """标准单尺度 SSIM（高斯窗，data_range=1.0），返回批均值标量。"""
    c = x.shape[1]
    if window is None:
        window = _gaussian_window(size, sigma, c, x.device, x.dtype)
    pad = size // 2
    mu_x = F.conv2d(x, window, padding=pad, groups=c)
    mu_y = F.conv2d(y, window, padding=pad, groups=c)
    mu_x2, mu_y2, mu_xy = mu_x * mu_x, mu_y * mu_y, mu_x * mu_y
    sx = F.conv2d(x * x, window, padding=pad, groups=c) - mu_x2
    sy = F.conv2d(y * y, window, padding=pad, groups=c) - mu_y2
    sxy = F.conv2d(x * y, window, padding=pad, groups=c) - mu_xy
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    m = ((2 * mu_xy + c1) * (2 * sxy + c2)) / ((mu_x2 + mu_y2 + c1) * (sx + sy + c2))
    return m.mean()


def psnr(x, y, eps=1e-10):
    mse = F.mse_loss(x, y)
    return 10.0 * torch.log10(1.0 / (mse + eps))


# ───────────────────────── 学习率调度 ─────────────────────────

def _make_lr_lambda(total_iters, warmup_iters):
    """线性 warmup → cosine annealing 到 0。"""
    warmup = max(0, int(warmup_iters))
    total = max(1, int(total_iters))

    def fn(it):
        if warmup > 0 and it < warmup:
            return float(it + 1) / float(warmup)
        prog = float(it - warmup) / float(max(1, total - warmup))
        prog = min(1.0, max(0.0, prog))
        return 0.5 * (1.0 + math.cos(math.pi * prog))
    return fn


# ───────────────────────── 时序损失 ─────────────────────────

def temporal_loss(net_g, lr_seq, sr_curr, scale):
    """简化版时序一致性损失（帧间一致性，HR 空间）。

    数据集只提供 curr 帧的 HR，因此按「3 帧分别做超分」的思路，从同一 3 帧窗口
    构造两个平移窗口（边界复制），得到 SR_prev / SR_next：
        prev 窗口 = [prev, prev, curr]，next 窗口 = [curr, next, next]
    直接约束 L1(SR_curr, SR_prev) 会连真实运动一起惩罚，因此改为**时序梯度匹配**：
    以 LR 双三次上采样帧作为运动参考，只惩罚偏离真实运动的部分（即闪烁）。
        loss = L1(SR_curr - SR_prev, Up_curr - Up_prev)
             + L1(SR_next - SR_curr, Up_next - Up_curr)

    注意：本项会额外引入 2 次 generator 前向，配置 w_temporal=0 时调用方应跳过。
    """
    win_prev = torch.cat([lr_seq[:, 0:3], lr_seq[:, 0:3], lr_seq[:, 3:6]], dim=1)
    win_next = torch.cat([lr_seq[:, 3:6], lr_seq[:, 6:9], lr_seq[:, 6:9]], dim=1)
    sr_prev = net_g(win_prev)
    sr_next = net_g(win_next)

    def up(x):
        return F.interpolate(x, scale_factor=scale, mode="bicubic", align_corners=False)

    up_prev, up_curr, up_next = up(lr_seq[:, 0:3]), up(lr_seq[:, 3:6]), up(lr_seq[:, 6:9])
    a = F.l1_loss(sr_curr - sr_prev, up_curr - up_prev)
    b = F.l1_loss(sr_next - sr_curr, up_next - up_curr)
    return 0.5 * (a + b)


# ───────────────────────── 辅助 ─────────────────────────

def _resolve_device(pref):
    if str(pref).startswith("cuda") and torch.cuda.is_available():
        return torch.device(pref)
    if str(pref).startswith("cuda"):
        _log("[train] CUDA 不可用，回退 CPU")
    return torch.device("cpu")


def _infinite(loader):
    while True:
        for batch in loader:
            yield batch


def _load_weights(module, path, tag):
    """加载权重，兼容裸 state_dict 与 {'model'/'params'/'state_dict': ...} 包装。"""
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    if isinstance(ckpt, dict):
        for key in ("model", "params_ema", "params", "state_dict"):
            if key in ckpt and isinstance(ckpt[key], dict):
                ckpt = ckpt[key]
                break
    ckpt = {k[7:] if k.startswith("module.") else k: v for k, v in ckpt.items()}
    missing, unexpected = module.load_state_dict(ckpt, strict=False)
    _log("[train] 载入 %s 权重: %s (missing=%d unexpected=%d)"
         % (tag, path, len(missing), len(unexpected)))


def _build_dataset(root, cfg, num_samples):
    return SRVideoDataset(
        video_dir=root,
        scene_categories=cfg["scene_categories"],
        patch_size=cfg["patch_size"],
        temporal_frames=3,
        num_samples=num_samples,
        lr_scale=cfg["scale"],
    )


@torch.no_grad()
def validate(net_g, loader, device):
    """验证集评估：L1 / PSNR / SSIM。"""
    net_g.eval()
    tot = {"l1": 0.0, "psnr": 0.0, "ssim": 0.0}
    n = 0
    for lr_seq, hr in loader:
        lr_seq, hr = lr_seq.to(device), hr.to(device)
        sr = net_g(lr_seq).clamp(0.0, 1.0)
        b = hr.shape[0]
        tot["l1"] += F.l1_loss(sr, hr).item() * b
        tot["psnr"] += psnr(sr, hr).item() * b
        tot["ssim"] += ssim(sr, hr).item() * b
        n += b
    net_g.train()
    if n == 0:
        return None
    return {k: v / n for k, v in tot.items()}


# ───────────────────────── 训练主流程 ─────────────────────────

def train(config):
    """训练入口。config 见模块 DEFAULTS。"""
    cfg = dict(DEFAULTS)
    cfg.update({k: v for k, v in (config or {}).items() if v is not None})
    if not cfg["data_dir"]:
        raise ValueError("config 缺少 data_dir")

    torch.manual_seed(cfg["seed"])
    device = _resolve_device(cfg["device"])
    use_amp = device.type == "cuda"
    os.makedirs(cfg["output_dir"], exist_ok=True)

    total = int(cfg["num_iterations"])
    _log("[train] device=%s amp=%s torch=%s" % (device, use_amp, torch.__version__))

    # ── 数据 ──
    train_set = _build_dataset(cfg["data_dir"], cfg,
                               num_samples=total * cfg["batch_size"])
    train_loader = DataLoader(
        train_set, batch_size=cfg["batch_size"], shuffle=False,
        num_workers=cfg["num_workers"], drop_last=True,
        persistent_workers=bool(cfg["num_workers"]),
    )
    data_iter = _infinite(train_loader)

    val_loader = None
    if cfg["val_dir"]:
        val_set = _build_dataset(cfg["val_dir"], cfg, num_samples=cfg["val_samples"])
        val_loader = DataLoader(val_set, batch_size=cfg["batch_size"],
                                shuffle=False, num_workers=0, drop_last=False)

    # ── 模型 ──
    RRDBNet, PatchDiscriminator, MSSSIMLoss = _import_models()
    net_g = RRDBNet(num_in_ch=9, num_out_ch=3, scale=cfg["scale"],
                    num_block=cfg["num_block"], num_feat=cfg["num_feat"],
                    num_grow_ch=cfg["num_grow_ch"],
                    out_mode=cfg["out_mode"]).to(device)
    net_d = PatchDiscriminator(num_in_ch=3, num_feat=cfg["num_feat"]).to(device)
    if cfg["model_path"]:
        _load_weights(net_g, cfg["model_path"], "generator")
    if cfg["model_d_path"]:
        _load_weights(net_d, cfg["model_d_path"], "discriminator")

    n_g = sum(p.numel() for p in net_g.parameters() if p.requires_grad)
    n_d = sum(p.numel() for p in net_d.parameters() if p.requires_grad)
    _log("[train] 参数量 G=%.2fM D=%.2fM" % (n_g / 1e6, n_d / 1e6))

    # ── 损失 / 优化器 ──
    criterion_msssim = MSSSIMLoss().to(device)
    criterion_gan = nn.BCEWithLogitsLoss()

    opt_g = torch.optim.Adam(net_g.parameters(), lr=cfg["lr_g"], betas=(0.9, 0.999))
    opt_d = torch.optim.Adam(net_d.parameters(), lr=cfg["lr_d"], betas=(0.9, 0.999))
    lr_fn = _make_lr_lambda(total, cfg["warmup_iters"])
    sch_g = torch.optim.lr_scheduler.LambdaLR(opt_g, lr_fn)
    sch_d = torch.optim.lr_scheduler.LambdaLR(opt_d, lr_fn)
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    net_g.train()
    net_d.train()
    started = time.time()
    acc_g = acc_d = 0.0
    acc_n = 0

    for it in range(1, total + 1):
        lr_seq, hr = next(data_iter)
        lr_seq = lr_seq.to(device, non_blocking=True)
        hr = hr.to(device, non_blocking=True)

        with torch.amp.autocast("cuda", enabled=use_amp):
            sr = net_g(lr_seq)

        # ── Step 1: 判别器 ──
        opt_d.zero_grad(set_to_none=True)
        with torch.amp.autocast("cuda", enabled=use_amp):
            pred_real = net_d(hr)
            loss_real = criterion_gan(pred_real, torch.ones_like(pred_real))
            pred_fake = net_d(sr.detach())
            loss_fake = criterion_gan(pred_fake, torch.zeros_like(pred_fake))
            d_loss = (loss_real + loss_fake) * 0.5
        scaler.scale(d_loss).backward()
        scaler.step(opt_d)

        # ── Step 2: 生成器 ──
        opt_g.zero_grad(set_to_none=True)
        with torch.amp.autocast("cuda", enabled=use_amp):
            l_l1 = F.l1_loss(sr, hr)
            l_ms = criterion_msssim(sr, hr)
            pred_g = net_d(sr)
            l_gan = criterion_gan(pred_g, torch.ones_like(pred_g))
            g_loss = cfg["w_l1"] * l_l1 + cfg["w_msssim"] * l_ms + cfg["w_gan"] * l_gan
            if cfg["w_temporal"] > 0:
                l_tmp = temporal_loss(net_g, lr_seq, sr, cfg["scale"])
                g_loss = g_loss + cfg["w_temporal"] * l_tmp
        scaler.scale(g_loss).backward()
        scaler.step(opt_g)
        scaler.update()  # 两个优化器共用一个 scaler，每 iteration 只 update 一次

        sch_g.step()
        sch_d.step()

        acc_g += float(g_loss.detach())
        acc_d += float(d_loss.detach())
        acc_n += 1

        if it % cfg["log_interval"] == 0 or it == 1:
            _log("[train] iter=%d/%d g_loss=%.4f d_loss=%.4f lr=%.1e elapsed=%ds"
                 % (it, total, acc_g / acc_n, acc_d / acc_n,
                    sch_g.get_last_lr()[0], int(time.time() - started)))
            acc_g = acc_d = 0.0
            acc_n = 0

        if val_loader is not None and it % cfg["val_interval"] == 0:
            m = validate(net_g, val_loader, device)
            if m:
                _log("[train] iter=%d val l1=%.4f psnr=%.2fdB ssim=%.4f"
                     % (it, m["l1"], m["psnr"], m["ssim"]))

        if it % cfg["save_interval"] == 0 or it == total:
            _save(net_g, net_d, cfg, it)

    _log("[train] 完成，总耗时 %ds" % int(time.time() - started))
    return {"iterations": total, "output_dir": cfg["output_dir"]}


def _save(net_g, net_d, cfg, it):
    meta = {"scale": cfg["scale"], "num_block": cfg["num_block"],
            "num_feat": cfg["num_feat"], "num_grow_ch": cfg["num_grow_ch"],
            "num_in_ch": 9, "out_mode": cfg["out_mode"], "iteration": it}
    pg = os.path.join(cfg["output_dir"], "model_g_%d.pth" % it)
    pd = os.path.join(cfg["output_dir"], "model_d_%d.pth" % it)
    torch.save({"model": net_g.state_dict(), **meta}, pg)
    torch.save({"model": net_d.state_dict(), **meta}, pd)
    _log("[train] saved checkpoint to %s" % os.path.basename(pg))


# ───────────────────────── CLI ─────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description="AIcut 视频超清增强训练")
    ap.add_argument("--config", default=None, help="JSON 配置文件；CLI 参数优先级更高")
    ap.add_argument("--data_dir")
    ap.add_argument("--val_dir")
    ap.add_argument("--output_dir")
    ap.add_argument("--model_path")
    ap.add_argument("--model_d_path")
    ap.add_argument("--num_iterations", type=int)
    ap.add_argument("--batch_size", type=int)
    ap.add_argument("--lr_g", type=float)
    ap.add_argument("--lr_d", type=float)
    ap.add_argument("--patch_size", type=int)
    ap.add_argument("--device")
    ap.add_argument("--save_interval", type=int)
    ap.add_argument("--val_interval", type=int)
    ap.add_argument("--log_interval", type=int)
    ap.add_argument("--warmup_iters", type=int)
    ap.add_argument("--num_workers", type=int)
    ap.add_argument("--scale", type=int)
    ap.add_argument("--num_block", type=int)
    ap.add_argument("--w_temporal", type=float)
    ap.add_argument("--seed", type=int)
    args = ap.parse_args(argv)

    cfg = {}
    if args.config:
        with open(args.config, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    cfg.update({k: v for k, v in vars(args).items()
                if k != "config" and v is not None})
    train(cfg)


if __name__ == "__main__":
    main()
