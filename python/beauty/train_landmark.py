# -*- coding: utf-8 -*-
"""自研 106 点人脸关键点模型训练脚本（LandmarkNet）。

特性：
    - 损失：Wing loss + 坐标 MSE（归一化坐标空间，[0,1]）。
    - AMP：torch.cuda.amp（仅 CUDA 可用时启用）；目标 RTX 5060 Ti 16GB。
      先 print(torch.cuda.is_available()) 探测；CUDA 不可用则退回 CPU 冒烟。
    - 数据来源（三选一）：
        (a) standard  —— 规范标注数据集（自有/合规 ≥5K 标注到位后直接训练）。
        (b) bootstrap —— 用 seed 模型给自有视频打伪标（仅冷启动 / 验证，非最终）。
        (c) synthetic —— 合成几何数据（仅冒烟测试，验证脚本可跑通）。
    - 训练结束导出 python/beauty/models/landmark.onnx，严格匹配推理服务契约：
        输入 1x3x256x256 RGB float32（已 mean/std 归一化），
        输出 1x212 float32 = 106×[x,y]，坐标 ∈ [0,1]。

合规硬约束：不加载任何第三方预训练权重 / 商业 SDK / 公开 research-only 数据直接作训练分布。
公开集（300W 68 点、WFLW 98 点）仅作为冷启动 seed 模型的训练数据（seed 不发布），
成品权重须以自有采集 + 伪标 + 人工轻校正的 ≥5K 张人脸为主训练。

用法示例：
    # 冒烟（合成数据，CPU 可跑）
    python train_landmark.py --smoke
    # bootstrap（从视频抽帧 + 自有 seed 模型打伪标，短训练）
    python train_landmark.py --data-mode bootstrap --video "E:/AIcut/_textsrc.mp4" \
        --seed-onnx models/landmark.onnx --epochs 3
    # 最终训练（自有 ≥5K 标注到位后）
    python train_landmark.py --data-mode standard --image-dir D:/data/imgs --pts-dir D:/data/pts \
        --epochs 60 --batch 16
"""
import os
import sys
import glob
import argparse

import numpy as np
import torch
from torch.utils.data import DataLoader

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from data_prep_landmark import (  # noqa: E402
    SyntheticLandmarkDataset,
    StandardLandmarkDataset,
    BootstrapLandmarkDataset,
    load_standard_pairs,
    extract_frames,
    bootstrap_pseudo_label_frames,
)
from models.landmark_net import (  # noqa: E402
    LandmarkNet, NUM_LANDMARKS, OUT_DIM, INPUT_SIZE, landmark_loss, count_params,
)

ONNX_PATH = os.path.join(_HERE, "models", "landmark.onnx")
IMG_SIZE = INPUT_SIZE
NUM_PTS = NUM_LANDMARKS


# ───────────────────────── 数据集构建 ─────────────────────────

def build_dataset(args):
    if args.data_mode == "synthetic":
        ds = SyntheticLandmarkDataset(n=args.samples, size=IMG_SIZE)
        print("[data] synthetic 数据集，样本数=%d（仅冒烟）" % len(ds))
        return ds
    if args.data_mode == "standard":
        if not args.image_dir or not args.pts_dir:
            raise SystemExit("--data-mode standard 需要 --image-dir 与 --pts-dir")
        pairs = load_standard_pairs(args.image_dir, args.pts_dir)
        if not pairs:
            raise SystemExit("未找到标准标注对，请检查 --image-dir/--pts-dir")
        ds = StandardLandmarkDataset(pairs, size=IMG_SIZE)
        print("[data] standard 标注数据集，样本数=%d" % len(ds))
        return ds
    if args.data_mode == "bootstrap":
        video = args.video
        frames_dir = args.frames_dir or os.path.join(_HERE, "_bootstrap_frames_lm")
        pseudo_dir = args.pseudo_dir or os.path.join(_HERE, "_bootstrap_pseudo_lm")
        if video and os.path.isfile(video):
            frames = extract_frames(video, frames_dir, fps=args.fps,
                                     max_frames=args.samples)
        else:
            frames = sorted(glob.glob(os.path.join(frames_dir, "*.png")))[: args.samples] \
                if os.path.isdir(frames_dir) else []
        if not frames:
            raise SystemExit("bootstrap 未获得任何帧（检查 --video 路径或 frames_dir）")
        # 用「自有 seed 模型」打伪标（非最终）；不提供 seed 则跳过伪标并告警。
        pairs = bootstrap_pseudo_label_frames(frames, pseudo_dir, seed_onnx=args.seed_onnx)
        if not pairs:
            raise SystemExit("bootstrap 伪标为空（需提供 --seed-onnx 自有 seed 模型）。")
        ds = BootstrapLandmarkDataset(pairs, size=IMG_SIZE)
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
        "landmarks": {0: "batch"},
    }
    with torch.no_grad():
        torch.onnx.export(
            model,
            dummy,
            path,
            input_names=["input"],
            output_names=["landmarks"],
            dynamic_axes=dynamic_axes,
            opset_version=opset,
            do_constant_folding=True,
        )
    # 内联可能产生的外部权重文件(.data)，便于推理服务单文件加载。
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
    """用 onnxruntime 加载并打印输出形状；不可用时跳过。"""
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
    print("[verify] 推理输出形状:", tuple(y.shape), "→ 期望 (1, %d)" % OUT_DIM)
    assert tuple(y.shape) == (1, OUT_DIM), "ONNX 输出形状不符契约！"
    assert y.min() >= 0.0 and y.max() <= 1.0, "ONNX 输出未在 [0,1] 范围！"


# ───────────────────────── 训练主流程 ─────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="冒烟预设：synthetic+少量样本+少量 iter")
    ap.add_argument("--data-mode", choices=["synthetic", "standard", "bootstrap"], default="synthetic")
    ap.add_argument("--image-dir", default="")
    ap.add_argument("--pts-dir", default="")
    ap.add_argument("--video", default="")
    ap.add_argument("--frames-dir", default="")
    ap.add_argument("--pseudo-dir", default="")
    ap.add_argument("--seed-onnx", default="", help="自有冷启动 seed 模型 ONNX（bootstrap 用）")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--iters", type=int, default=0, help="若>0，按 iteration 训练而非 epoch")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--samples", type=int, default=40, help="synthetic/bootstrap 使用样本数")
    ap.add_argument("--fps", type=float, default=1.0, help="抽帧 fps")
    ap.add_argument("--out-onnx", default=ONNX_PATH)
    ap.add_argument("--ckpt", default=os.path.join(_HERE, "models", "landmark_last.pt"))
    ap.add_argument("--opset", type=int, default=13)
    args = ap.parse_args()

    if args.smoke:
        args.data_mode = "synthetic"
        args.samples = 40
        args.iters = 200
        args.batch = 8

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

    model = LandmarkNet(num_landmarks=NUM_PTS).to(device)
    n_params = count_params(model)
    print("模型可训练参数: %.2f M" % (n_params / 1e6))

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    scaler = torch.cuda.amp.GradScaler(enabled=use_amp)

    model.train()
    global_step = 0
    iters_per_epoch = max(1, len(loader))
    total_iters = args.iters if args.iters > 0 else (args.epochs * iters_per_epoch)
    max_iters = total_iters

    print("开始训练：%s 模式，%d 样本，batch=%d，总 iter≈%d" %
          (args.data_mode, len(ds), args.batch, max_iters))

    run_epochs = args.epochs if args.iters <= 0 else 100000
    for epoch in range(run_epochs):
        for x, y in loader:
            x = x.to(device)
            y = y.to(device)
            optimizer.zero_grad()
            with torch.cuda.amp.autocast(enabled=use_amp):
                pred = model(x)
                loss, wl, mse = landmark_loss(pred, y)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()

            global_step += 1
            if global_step % 10 == 0 or global_step == 1:
                print("iter=%d loss=%.4f wing=%.4f mse=%.4f" %
                      (global_step, loss.item(), wl.item(), mse.item()))

            if args.iters > 0 and global_step >= max_iters:
                break
        if args.iters > 0 and global_step >= max_iters:
            break

    # 保存 checkpoint
    os.makedirs(os.path.dirname(args.ckpt), exist_ok=True)
    torch.save({"model": model.state_dict(), "num_landmarks": NUM_PTS}, args.ckpt)
    print("[train] checkpoint 已保存:", args.ckpt)

    # 导出 ONNX（匹配契约：1x212）
    export_onnx(model, args.out_onnx, opset=args.opset)
    print("完成。")


if __name__ == "__main__":
    main()
