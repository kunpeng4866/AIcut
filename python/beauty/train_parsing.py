# -*- coding: utf-8 -*-
"""自研皮肤/人脸解析模型训练脚本（BiSeNetV2）。

特性：
    - 损失：CrossEntropy + Dice + boundary loss（距离变换边界加权 CE），加权求和。
    - AMP：torch.cuda.amp（仅 CUDA 可用时启用）；目标 RTX 5060 Ti 16GB。
      先 print(torch.cuda.is_available()) 探测；CUDA 不可用则退回 CPU 冒烟。
    - 数据来源（三选一）：
        (a) standard  —— 规范标注数据集（自有/合规 ≥5K 标注到位后直接训练）。
        (b) bootstrap —— 用 data_prep 的弱 bootstrap 伪标（仅冷启动 / 验证，非最终）。
        (c) synthetic —— 合成几何数据（仅冒烟测试，验证脚本可跑通）。
    - 训练结束导出 python/beauty/models/parsing.onnx，严格匹配推理服务契约：
        输入 1x3x512x512 RGB float32（已 mean/std 归一化），
        输出 1x6x512x512 float32 logits，类别顺序固定。

合规硬约束：不加载任何第三方预训练权重 / 商业 SDK / 公开 research-only 数据直接作训练分布。

用法示例：
    # 冒烟（合成数据，CPU 可跑）
    python train_parsing.py --smoke
    # bootstrap（从视频抽帧做弱伪标，短训练）
    python train_parsing.py --data-mode bootstrap --video "E:/AIcut/test_video_skin_mask.mp4" --epochs 3
    # 最终训练（自有 ≥5K 标注到位后）
    python train_parsing.py --data-mode standard --image-dir D:/data/imgs --mask-dir D:/data/masks --epochs 50 --batch 8
"""
import os
import sys
import argparse

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from data_prep import (  # noqa: E402
    SyntheticSegDataset,
    StandardSegDataset,
    BootstrapSegDataset,
    load_standard_pairs,
    extract_frames,
    bootstrap_dataset_from_frames,
)
from models.bisenetv2 import BiSeNetV2, NUM_CLASSES, INPUT_MEAN, INPUT_STD  # noqa: E402

ONNX_PATH = os.path.join(_HERE, "models", "parsing.onnx")
IMG_SIZE = 512
NUM_CLASSES = NUM_CLASSES


# ───────────────────────── 损失函数 ─────────────────────────

def dice_loss(logits, target, eps=1e-5):
    """软 Dice loss（逐类平均，含背景类）。"""
    num_classes = logits.shape[1]
    probs = F.softmax(logits, dim=1)
    onehot = F.one_hot(target, num_classes).permute(0, 3, 1, 2).float()
    dims = (2, 3)
    inter = (probs * onehot).sum(dims)
    union = probs.sum(dims) + onehot.sum(dims)
    dice = (2.0 * inter + eps) / (union + eps)
    return 1.0 - dice.mean()


def boundary_weight(target, num_classes, bandwidth=12):
    """由 GT 计算边界权重图（边界附近像素权重高），用于边界加权 CE。

    对每类取二值掩码的距离变换，距离 ≤ bandwidth 的环带视为「近边界」并加权。
    """
    from scipy import ndimage
    gt = target.cpu().numpy()
    B, H, W = gt.shape
    w = np.ones((B, H, W), dtype=np.float32)
    for b in range(B):
        m = gt[b]
        band = np.zeros((H, W), dtype=np.float32)
        for c in range(num_classes):
            bin_ = (m == c)
            if bin_.sum() == 0:
                continue
            dt = ndimage.distance_transform_edt(~bin_)
            band += (dt <= bandwidth).astype(np.float32)
        w[b] = 1.0 + 8.0 * band
    return torch.from_numpy(w)


def boundary_ce(logits, target, num_classes, bandwidth=12):
    """边界加权交叉熵：在 CE 基础上对近边界像素加大权重，强化边界学习。"""
    w = boundary_weight(target, num_classes, bandwidth).to(logits.device)
    ce_per = F.cross_entropy(logits, target, reduction="none")  # (B,H,W)
    return (ce_per * w).mean()


def compute_loss(logits, target, num_classes, w_ce=1.0, w_dice=1.0, w_bd=1.0, use_boundary=True):
    ce = F.cross_entropy(logits, target, ignore_index=255)
    dice = dice_loss(logits, target)
    total = w_ce * ce + w_dice * dice
    bd = None
    if use_boundary:
        bd = boundary_ce(logits, target, num_classes)
        total = total + w_bd * bd
    return total, ce, dice, bd


# ───────────────────────── 数据集构建 ─────────────────────────

def build_dataset(args):
    if args.data_mode == "synthetic":
        ds = SyntheticSegDataset(n=args.samples, size=IMG_SIZE)
        print("[data] synthetic 数据集，样本数=%d（仅冒烟）" % len(ds))
        return ds
    if args.data_mode == "standard":
        if not args.image_dir or not args.mask_dir:
            raise SystemExit("--data-mode standard 需要 --image-dir 与 --mask-dir")
        pairs = load_standard_pairs(args.image_dir, args.mask_dir)
        if not pairs:
            raise SystemExit("未找到标准标注对，请检查 --image-dir/--mask-dir")
        ds = StandardSegDataset(pairs, size=IMG_SIZE)
        print("[data] standard 标注数据集，样本数=%d" % len(ds))
        return ds
    if args.data_mode == "bootstrap":
        video = args.video
        frames_dir = args.frames_dir or os.path.join(_HERE, "_bootstrap_frames")
        pseudo_dir = args.pseudo_dir or os.path.join(_HERE, "_bootstrap_pseudo")
        if video and os.path.isfile(video):
            frames = extract_frames(video, frames_dir, fps=args.fps,
                                     max_frames=args.samples)
        else:
            # 没有指定视频：复用 frames_dir 中已有帧
            import glob
            frames = sorted(glob.glob(os.path.join(frames_dir, "*.png")))
            frames = frames[: args.samples]
        if not frames:
            raise SystemExit("bootstrap 未获得任何帧（检查 --video 路径或 frames_dir）")
        pairs = bootstrap_dataset_from_frames(frames, pseudo_dir)
        ds = BootstrapSegDataset(pairs, size=IMG_SIZE)
        print("[data] bootstrap 伪标数据集，样本数=%d（非最终，仅冷启动/验证）" % len(ds))
        return ds
    raise SystemExit("未知 --data-mode: %s" % args.data_mode)


# ───────────────────────── ONNX 导出 ─────────────────────────

def export_onnx(model, path, opset=13):
    model.eval()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    dummy = torch.randn(1, 3, IMG_SIZE, IMG_SIZE)
    dynamic_axes = {
        "input": {0: "batch"},
        "logits": {0: "batch"},
    }
    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            path,
            input_names=["input"],
            output_names=["logits"],
            dynamic_axes=dynamic_axes,
            opset_version=opset,
            do_constant_folding=True,
        )
    # 将可能产生的外部权重文件(.data)内联回单一 ONNX，便于推理服务单文件加载。
    try:
        import onnx
        m = onnx.load(path)
        onnx.save(m, path)
        data_file = path + ".data"
        if os.path.exists(data_file):
            os.remove(data_file)
    except Exception as e:  # noqa: BLE001
        print("[export] 内联外部权重失败（保留 .data）: %s" % e)
    print("[export] ONNX 已写出: %s (%.1f KB)" % (path, os.path.getsize(path) / 1024.0))
    _verify_onnx(path)


def _verify_onnx(path):
    """用 onnxruntime 加载并打印输入输出形状；不可用时跳过。"""
    try:
        import onnxruntime as ort
    except Exception:  # noqa: BLE001
        print("[verify] 未安装 onnxruntime，跳过运行时校验（torch 已成功导出）")
        return
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    print("[verify] ONNX 输入:", sess.get_inputs()[0].name, sess.get_inputs()[0].shape)
    print("[verify] ONNX 输出:", sess.get_outputs()[0].name, sess.get_outputs()[0].shape)
    x = np.random.randn(1, 3, IMG_SIZE, IMG_SIZE).astype(np.float32)
    y = sess.run([out_name], {in_name: x})[0]
    print("[verify] 推理输出形状:", tuple(y.shape), "→ 期望 (1, 6, 512, 512)")
    assert tuple(y.shape) == (1, 6, IMG_SIZE, IMG_SIZE), "ONNX 输出形状不符契约！"


# ───────────────────────── 训练主流程 ─────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="冒烟预设：synthetic+少量样本+少量 epoch")
    ap.add_argument("--data-mode", choices=["synthetic", "standard", "bootstrap"], default="synthetic")
    ap.add_argument("--image-dir", default="")
    ap.add_argument("--mask-dir", default="")
    ap.add_argument("--video", default="")
    ap.add_argument("--frames-dir", default="")
    ap.add_argument("--pseudo-dir", default="")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--iters", type=int, default=0, help="若>0，按 iteration 训练而非 epoch")
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--samples", type=int, default=40, help="synthetic/bootstrap 使用样本数")
    ap.add_argument("--fps", type=float, default=1.0, help="抽帧 fps")
    ap.add_argument("--no-boundary", action="store_true", help="关闭 boundary loss")
    ap.add_argument("--out-onnx", default=ONNX_PATH)
    ap.add_argument("--ckpt", default=os.path.join(_HERE, "models", "parsing_last.pt"))
    ap.add_argument("--opset", type=int, default=13)
    args = ap.parse_args()

    if args.smoke:
        args.data_mode = "synthetic"
        args.samples = 40
        args.epochs = 3
        args.batch = 4

    # CUDA 探测
    cuda_ok = torch.cuda.is_available()
    print("torch.__version__ =", torch.__version__)
    print("torch.cuda.is_available() =", cuda_ok)
    device = torch.device("cuda" if cuda_ok else "cpu")
    use_amp = cuda_ok
    print("使用设备:", device, "| AMP:", use_amp)

    ds = build_dataset(args)
    loader = DataLoader(ds, batch_size=args.batch, shuffle=True,
                        num_workers=0, drop_last=False)

    model = BiSeNetV2(num_classes=NUM_CLASSES).to(device)
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print("模型可训练参数: %.2f M" % (n_params / 1e6))

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    scaler = torch.cuda.amp.GradScaler(enabled=use_amp)

    model.train()
    global_step = 0
    iters_per_epoch = max(1, len(loader))
    total_iters = args.iters if args.iters > 0 else (args.epochs * iters_per_epoch)
    max_iters = total_iters

    print("开始训练：%s 模式，%d 样本/epoch，%d epoch，batch=%d，总 iter≈%d" %
          (args.data_mode, len(ds), args.epochs, args.batch, max_iters))

    run_epochs = args.epochs if args.iters <= 0 else 100000
    for epoch in range(run_epochs):
        for x, y in loader:
            x = x.to(device)
            y = y.to(device)
            optimizer.zero_grad()
            with torch.cuda.amp.autocast(enabled=use_amp):
                logits = model(x)
                loss, ce, dice, bd = compute_loss(
                    logits, y, NUM_CLASSES, use_boundary=not args.no_boundary)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

            global_step += 1
            bd_s = ("bd=%.4f" % bd.item()) if bd is not None else ""
            if global_step % 5 == 0 or global_step == 1:
                print("iter=%d loss=%.4f ce=%.4f dice=%.4f %s" %
                      (global_step, loss.item(), ce.item(), dice.item(), bd_s))

            if args.iters > 0 and global_step >= max_iters:
                break
        if args.iters > 0 and global_step >= max_iters:
            break

    # 保存 checkpoint
    os.makedirs(os.path.dirname(args.ckpt), exist_ok=True)
    torch.save({"model": model.state_dict(), "num_classes": NUM_CLASSES}, args.ckpt)
    print("[train] checkpoint 已保存:", args.ckpt)

    # 导出 ONNX（匹配契约）
    export_onnx(model, args.out_onnx, opset=args.opset)
    print("完成。")


if __name__ == "__main__":
    main()
