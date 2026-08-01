# -*- coding: utf-8 -*-
"""数据准备：ffmpeg 抽帧 + bootstrap 伪标 + 规范标注数据集 loader。

合规说明（重要）：
    - bootstrap 伪标**仅用于冷启动 / 管线验证**，绝对不是最终成品训练分布。
      它用 python/beauty/core.py 的阈值皮肤检测（纯数学统计，非模型）作为弱标记者，
      只能可靠区分「皮肤 vs 背景」，face/neck 等靠中心启发式粗略划分，其余类别
      （hair/arm/clothes）在 bootstrap 中一律当作 background（5）。
    - 最终权重必须以「自有采集 + 伪标 + 人工轻校正边界」的 ≥5K 标注图为主训练；
      公开 research-only 数据集（CelebAMask-HQ/LaPa/LIP/ATR 等）仅可作冷启动参考。

本模块**不会** import 任何预训练权重或第三方人脸 SDK；皮肤检测复用 core.py 的自研实现。
"""
import os
import sys
import glob
import random

import numpy as np
import torch
from PIL import Image
from scipy import ndimage
from torch.utils.data import Dataset

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# 复用 core.py 的自研皮肤检测（纯 numpy/scipy 统计，无模型）。
from core import (  # noqa: E402
    _ffmpeg_exe,
    rgb_to_ycbcr,
    rgb_to_hsv,
    _skin_candidate,
    _morph_close,
    _keep_largest,
)

# 类别顺序（与 ONNX 契约一致）
CLASS_FACE_SKIN = 0
CLASS_NECK = 1
CLASS_ARM = 2
CLASS_HAIR = 3
CLASS_CLOTHES = 4
CLASS_BACKGROUND = 5

IMG_SIZE = 512

# 归一化（与推理服务契约一致，仅作文档参考）
INPUT_MEAN = (0.485, 0.456, 0.406)
INPUT_STD = (0.229, 0.224, 0.225)


# ───────────────────────── ffmpeg 抽帧 ─────────────────────────

def extract_frames(video_path, out_dir, fps=1.0, max_frames=50, size=IMG_SIZE):
    """用 ffmpeg 从视频抽取帧到 out_dir，返回帧文件路径列表。

    失败（如 ffmpeg 不可用 / 视频损坏）时返回空列表并记录警告，不抛异常——
    以保证数据准备步骤在缺帧时仍能给出明确反馈。
    """
    import subprocess
    os.makedirs(out_dir, exist_ok=True)
    ff = _ffmpeg_exe()
    if not os.path.isfile(ff):
        sys.stderr.write("[data_prep] 未找到 ffmpeg: %s，跳过抽帧\n" % ff)
        return []
    cmd = [
        ff, "-y", "-v", "error", "-i", video_path,
        "-vf", "fps=%.4f,scale=%d:%d" % (fps, size, size),
        "-frames:v", str(max_frames),
        os.path.join(out_dir, "frame_%05d.png"),
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("[data_prep] 抽帧异常: %s\n" % e)
        return []
    if p.returncode != 0:
        sys.stderr.write("[data_prep] 抽帧失败(%s): %s\n" %
                         (video_path, p.stderr.decode("utf-8", "ignore")[:300]))
        return []
    frames = sorted(glob.glob(os.path.join(out_dir, "frame_*.png")))
    return frames[:max_frames]


# ───────────────────────── bootstrap 伪标 ─────────────────────────

def bootstrap_pseudo_label(rgb):
    """弱 bootstrap 标记者：返回 HxW 单通道类别索引 (0-5) 的伪标 mask。

    策略：
        1) 用 core._skin_candidate 取皮肤候选 → 形态学闭运算。
        2) 皮肤像素默认标为 face_skin(0)。
        3) 中心纵向启发式：将「皮肤候选」按中央竖向带再细分为
           - 上半（脸核区域）→ face_skin(0)
           - 下半（脖子区域）→ neck(1)
           以粗略区分脸/脖子（非精确，仅为冷启动提供弱信号）。
        4) 其余区域（含 hair/arm/clothes）一律 background(5)。

    明确标注：这是 bootstrap，**非最终**，边界与细类不可信。
    """
    h, w = rgb.shape[:2]
    y, cb, cr = rgb_to_ycbcr(rgb)
    hh, ss, vv = rgb_to_hsv(rgb)
    cand = _skin_candidate(y, cb, cr, hh, ss, 0.25)
    cand = _morph_close(cand)
    cand = _keep_largest(cand)

    mask = np.full((h, w), CLASS_BACKGROUND, dtype=np.uint8)

    if cand.any():
        # 中央纵向带：水平 30%~70%，垂直 12%~72%
        x0, x1 = int(w * 0.30), int(w * 0.70)
        y0, y1 = int(h * 0.12), int(h * 0.72)
        face_y0, face_y1 = y0, int((y0 + y1) * 0.62)
        neck_y0, neck_y1 = face_y1, y1
        skin_ys, skin_xs = np.where(cand)
        for sy, sx in zip(skin_ys, skin_xs):
            if not (x0 <= sx <= x1):
                mask[sy, sx] = CLASS_FACE_SKIN
                continue
            if face_y0 <= sy <= face_y1:
                mask[sy, sx] = CLASS_FACE_SKIN
            elif neck_y0 <= sy <= neck_y1:
                mask[sy, sx] = CLASS_NECK
            else:
                mask[sy, sx] = CLASS_FACE_SKIN
    return mask


def bootstrap_dataset_from_frames(frames, pseudo_dir, cache=True):
    """对一批帧生成 bootstrap 伪标并缓存，返回 [(img_path, mask_path), ...]。

    伪标 mask 写入 pseudo_dir（明确命名为 pseudo_*.png 以示「非最终」）。
    """
    os.makedirs(pseudo_dir, exist_ok=True)
    pairs = []
    for fp in frames:
        base = os.path.splitext(os.path.basename(fp))[0]
        mp = os.path.join(pseudo_dir, "pseudo_" + base + ".png")
        if cache and os.path.isfile(mp):
            pairs.append((fp, mp))
            continue
        rgb = np.asarray(Image.open(fp).convert("RGB"), dtype=np.uint8)
        mask = bootstrap_pseudo_label(rgb)
        Image.fromarray(mask, mode="L").save(mp)
        pairs.append((fp, mp))
    return pairs


# ───────────────────────── 规范标注数据集 loader ─────────────────────────

def load_standard_pairs(image_dir, mask_dir):
    """加载规范标注数据集：image_dir 下图像与 mask_dir 下同名单通道 png 配对。

    规范 mask 约定：单通道 png，像素值即类别索引 0-5（palette/灰度均可，按 L 模式读）。
    支持扩展名：.jpg/.jpeg/.png/.bmp。
    """
    valid_ext = (".jpg", ".jpeg", ".png", ".bmp")
    imgs = sorted([f for f in os.listdir(image_dir) if f.lower().endswith(valid_ext)])
    pairs = []
    for name in imgs:
        stem = os.path.splitext(name)[0]
        cand = os.path.join(mask_dir, stem + ".png")
        if not os.path.isfile(cand):
            cand = os.path.join(mask_dir, name)
        if os.path.isfile(cand):
            pairs.append((os.path.join(image_dir, name), cand))
        else:
            sys.stderr.write("[data_prep] 跳过无对应 mask 的图像: %s\n" % name)
    return pairs


# ───────────────────────── torch Dataset ─────────────────────────

class StandardSegDataset(Dataset):
    """规范标注数据集（自有/合规 ≥5K 标注到位后直接训练用）。"""

    def __init__(self, pairs, size=IMG_SIZE, mean=INPUT_MEAN, std=INPUT_STD):
        self.pairs = pairs
        self.size = size
        self.mean = np.asarray(mean, np.float32)
        self.std = np.asarray(std, np.float32)

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        img_p, mask_p = self.pairs[idx]
        img = Image.open(img_p).convert("RGB").resize((self.size, self.size), Image.BILINEAR)
        mask = Image.open(mask_p).convert("L").resize((self.size, self.size), Image.NEAREST)
        img = np.asarray(img, dtype=np.float32) / 255.0
        img = (img - self.mean) / self.std
        img = img.transpose(2, 0, 1).astype(np.float32)
        mask = np.asarray(mask, dtype=np.int64)
        return torch.from_numpy(img), torch.from_numpy(mask)


class BootstrapSegDataset(Dataset):
    """bootstrap 伪标数据集（标注 = bootstrap 伪标，仅冷启动/验证用）。"""

    def __init__(self, pairs, size=IMG_SIZE, mean=INPUT_MEAN, std=INPUT_STD):
        self.pairs = pairs
        self.size = size
        self.mean = np.asarray(mean, np.float32)
        self.std = np.asarray(std, np.float32)

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        img_p, mask_p = self.pairs[idx]
        img = Image.open(img_p).convert("RGB").resize((self.size, self.size), Image.BILINEAR)
        mask = Image.open(mask_p).convert("L").resize((self.size, self.size), Image.NEAREST)
        img = np.asarray(img, dtype=np.float32) / 255.0
        img = (img - self.mean) / self.std
        img = img.transpose(2, 0, 1).astype(np.float32)
        mask = np.asarray(mask, dtype=np.int64)
        return torch.from_numpy(img), torch.from_numpy(mask)


class SyntheticSegDataset(Dataset):
    """合成几何数据集（仅冒烟测试用，证明训练管线可跑通）。

    生成带明确 6 类区域（脸/脖子/头发/衣服/手臂/背景）的彩色图与精确 mask，
    让模型在几十张上几步即可下降，验证脚本而非提供真实能力。
    """

    def __init__(self, n=40, size=IMG_SIZE, seed=0,
                 mean=INPUT_MEAN, std=INPUT_STD, num_classes=6):
        self.n = n
        self.size = size
        self.num_classes = num_classes
        self.mean = np.asarray(mean, np.float32)
        self.std = np.asarray(std, np.float32)
        self.rng = random.Random(seed)

    def __len__(self):
        return self.n

    def _make(self):
        s = self.size
        img = np.zeros((s, s, 3), dtype=np.float32)
        mask = np.full((s, s), CLASS_BACKGROUND, dtype=np.int64)
        # 背景底色
        img[:, :] = np.array([0.55, 0.60, 0.65], dtype=np.float32)
        # 头发（上部横带）
        hair_top, hair_bot = int(s * 0.10), int(s * 0.30)
        img[hair_top:hair_bot, :] = np.array([0.12, 0.10, 0.10], dtype=np.float32)
        mask[hair_top:hair_bot, :] = CLASS_HAIR
        # 脸（中央椭圆）
        fy0, fy1 = int(s * 0.18), int(s * 0.52)
        fx0, fx1 = int(s * 0.34), int(s * 0.66)
        yy, xx = np.mgrid[fy0:fy1, fx0:fx1]
        cy = (fy0 + fy1) / 2.0
        cxn = (fx0 + fx1) / 2.0
        ry = (fy1 - fy0) / 2.0
        rx = (fx1 - fx0) / 2.0
        inside = (((yy - cy) / ry) ** 2 + ((xx - cxn) / rx) ** 2) <= 1.0
        img[fy0:fy1, fx0:fx1][inside] = np.array([0.86, 0.72, 0.62], dtype=np.float32)
        mask[fy0:fy1, fx0:fx1][inside] = CLASS_FACE_SKIN
        # 脖子（脸下竖条）
        ny0, ny1 = fy1, int(s * 0.62)
        nx0, nx1 = int(s * 0.40), int(s * 0.60)
        img[ny0:ny1, nx0:nx1] = np.array([0.84, 0.69, 0.60], dtype=np.float32)
        mask[ny0:ny1, nx0:nx1] = CLASS_NECK
        # 衣服（下部大块）
        img[int(s * 0.62):, :] = np.array([0.20, 0.30, 0.55], dtype=np.float32)
        mask[int(s * 0.62):, :] = CLASS_CLOTHES
        # 手臂（两侧竖条）
        ax0, ax1 = int(s * 0.05), int(s * 0.16)
        img[int(s * 0.40):, ax0:ax1] = np.array([0.85, 0.70, 0.61], dtype=np.float32)
        mask[int(s * 0.40):, ax0:ax1] = CLASS_ARM
        bx0, bx1 = int(s * 0.84), int(s * 0.95)
        img[int(s * 0.40):, bx0:bx1] = np.array([0.85, 0.70, 0.61], dtype=np.float32)
        mask[int(s * 0.40):, bx0:bx1] = CLASS_ARM
        return img, mask

    def __getitem__(self, idx):
        img, mask = self._make()
        jitter = np.asarray([self.rng.uniform(-0.04, 0.04) for _ in range(3)], dtype=np.float32)
        img = np.clip(img + jitter, 0, 1)
        img = (img - self.mean) / self.std
        img = img.transpose(2, 0, 1).astype(np.float32)
        return torch.from_numpy(img), torch.from_numpy(mask)


if __name__ == "__main__":
    s = SyntheticSegDataset(n=4)
    for i, (im, mk) in enumerate(s):
        assert im.shape == (3, IMG_SIZE, IMG_SIZE)
        assert mk.shape == (IMG_SIZE, IMG_SIZE)
    print("SyntheticSegDataset OK, len=", len(s))
