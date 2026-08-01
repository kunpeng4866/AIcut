# -*- coding: utf-8 -*-
"""数据准备：ffmpeg 抽帧 + bootstrap 伪标 + 规范标注 loader + 合成几何人脸（仅冒烟）。

合规说明（重要）：
    - bootstrap 伪标**仅用于冷启动 / 管线验证**，绝对不是最终成品训练分布。
      我们用「自有采集 + 一个冷启动 seed 模型（仅由 research-only 公开集如 300W/WFLW
      训练、不发布、仅作伪标种子）」给自有视频打伪标，再叠加人工轻校正。
      ⚠ 公开集权重本身不会进入成品；成品权重须以自有/合规标注为主重新训练。
    - 本模块**不会** import 任何第三方预训练人脸 SDK（不依赖 MediaPipe/dlib/face_alignment）。
      若提供 seed ONNX，也是用 onnxruntime 跑「我们自己的」seed 模型，不接触外部权重。

106 点布局（与 models/landmark_net.py 中 LANDMARK_INDEX / 文档完全一致）：
    轮廓 0-32 / 左眉 33-43 / 右眉 44-54 / 左眼 55-66 / 右眼 67-78 / 鼻 79-91 / 嘴 92-105。
    所有坐标归一化到 [0,1]（相对 256 输入尺寸）。
"""
import os
import sys
import glob
import math
import random

import numpy as np
import torch
from PIL import Image, ImageDraw
from torch.utils.data import Dataset

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# 复用 core.py 的 ffmpeg 探测（纯工具，无模型）。
from core import _ffmpeg_exe  # noqa: E402

# 复用模型定义里的布局与契约常量（单一事实来源）。
from models.landmark_net import (  # noqa: E402
    NUM_LANDMARKS,
    LANDMARK_INDEX,
    LANDMARK_SEGMENTS,
    INPUT_MEAN,
    INPUT_STD,
    INPUT_SIZE,
)

IMG_SIZE = INPUT_SIZE  # 256
NUM_PTS = NUM_LANDMARKS  # 106


# ───────────────────────── ffmpeg 抽帧 ─────────────────────────

def extract_frames(video_path, out_dir, fps=1.0, max_frames=50, size=IMG_SIZE):
    """用 ffmpeg 从视频抽取帧到 out_dir，返回帧文件路径列表。

    失败（ffmpeg 不可用 / 视频损坏）时返回空列表并记录警告，不抛异常。
    """
    import subprocess
    os.makedirs(out_dir, exist_ok=True)
    ff = _ffmpeg_exe()
    if not os.path.isfile(ff):
        sys.stderr.write("[data_prep_landmark] 未找到 ffmpeg: %s，跳过抽帧\n" % ff)
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
        sys.stderr.write("[data_prep_landmark] 抽帧异常: %s\n" % e)
        return []
    if p.returncode != 0:
        sys.stderr.write("[data_prep_landmark] 抽帧失败(%s): %s\n" %
                         (video_path, p.stderr.decode("utf-8", "ignore")[:300]))
        return []
    frames = sorted(glob.glob(os.path.join(out_dir, "frame_*.png")))
    return frames[:max_frames]


# ───────────────────────── 规范标注 loader（image + pts，106 点） ─────────────────────────

def save_pts(pts, path):
    """把 (106,2) 的 [0,1] 归一化点保存为规范 .pts 文本。

    格式：106 行，每行 "x y"（空格分隔，浮点，范围 [0,1]）。
    """
    pts = np.asarray(pts, dtype=np.float32).reshape(NUM_PTS, 2)
    with open(path, "w", encoding="utf-8") as f:
        for (x, y) in pts:
            f.write("%.6f %.6f\n" % (x, y))


def load_pts(path):
    """读取规范 .pts 文本（106 行 "x y"，[0,1] 归一化）→ (106,2) float32 数组。

    兼容两种常见变体：逗号分隔 或 空格分隔；并在越界时做 [0,1] 裁剪保护。
    """
    coords = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.replace(",", " ").split()
            if len(parts) < 2:
                continue
            coords.append((float(parts[0]), float(parts[1])))
            if len(coords) == NUM_PTS:
                break
    if len(coords) != NUM_PTS:
        raise ValueError("pts 文件 %s 点数=%d，期望 %d" % (path, len(coords), NUM_PTS))
    arr = np.asarray(coords, dtype=np.float32).reshape(NUM_PTS, 2)
    arr = np.clip(arr, 0.0, 1.0)
    return arr


def load_standard_pairs(image_dir, pts_dir):
    """加载规范关键点数据集：image_dir 下图像与 pts_dir 下同名 .pts 配对。

    支持图像扩展名：.jpg/.jpeg/.png/.bmp；pts 固定为 .pts。
    """
    valid_ext = (".jpg", ".jpeg", ".png", ".bmp")
    imgs = sorted([f for f in os.listdir(image_dir) if f.lower().endswith(valid_ext)])
    pairs = []
    for name in imgs:
        stem = os.path.splitext(name)[0]
        cand = os.path.join(pts_dir, stem + ".pts")
        if not os.path.isfile(cand):
            cand = os.path.join(pts_dir, name.rsplit(".", 1)[0] + ".pts")
        if os.path.isfile(cand):
            pairs.append((os.path.join(image_dir, name), cand))
        else:
            sys.stderr.write("[data_prep_landmark] 跳过无对应 pts 的图像: %s\n" % name)
    return pairs


# ───────────────────────── bootstrap 伪标（用 seed 模型给自有视频打伪标，非最终） ─────────────────────────

def bootstrap_pseudo_label_frames(frames, pseudo_dir, seed_onnx=None, cache=True):
    """对一批帧用「自有 seed 模型」打伪标，返回 [(img_path, pts_path), ...]。

    ⚠ 明确标注：这是 bootstrap 伪标，**非最终**。仅用于冷启动 / 管线验证。
       最终权重必须以「自有采集 + 伪标 + 人工轻校正」的 ≥5K 标注图为主重新训练。

    参数：
        seed_onnx: 我们自己的冷启动 seed 模型 ONNX 路径（输出须为 1×212，[0,1] 归一化）。
                   若不提供，则无法打伪标（我们不使用任何第三方 SDK），返回空列表并警告。
    """
    os.makedirs(pseudo_dir, exist_ok=True)
    if not seed_onnx or not os.path.isfile(seed_onnx):
        sys.stderr.write(
            "[data_prep_landmark] 未提供自有 seed ONNX，跳过 bootstrap 伪标"
            "（禁止使用第三方 SDK；成品须用自有/合规标注重训）。\n")
        return []
    try:
        import onnxruntime as ort
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("[data_prep_landmark] 未安装 onnxruntime，无法跑 seed 模型: %s\n" % e)
        return []

    sess = ort.InferenceSession(seed_onnx, providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name
    mean = np.asarray(INPUT_MEAN, np.float32)
    std = np.asarray(INPUT_STD, np.float32)

    pairs = []
    for fp in frames:
        base = os.path.splitext(os.path.basename(fp))[0]
        # 明确命名为 pseudo_*.pts 以示「非最终」。
        mp = os.path.join(pseudo_dir, "pseudo_" + base + ".pts")
        if cache and os.path.isfile(mp):
            pairs.append((fp, mp))
            continue
        rgb = np.asarray(Image.open(fp).convert("RGB").resize((IMG_SIZE, IMG_SIZE),
                                                             Image.BILINEAR), dtype=np.float32) / 255.0
        x = ((rgb - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
        y = sess.run([out_name], {in_name: x})[0]  # (1, 212)
        pts = y.reshape(NUM_PTS, 2)
        save_pts(pts, mp)
        pairs.append((fp, mp))
    print("[data_prep_landmark] bootstrap 伪标完成，%d 对（非最终）" % len(pairs))
    return pairs


# ───────────────────────── torch Dataset ─────────────────────────

class StandardLandmarkDataset(Dataset):
    """规范关键点数据集（自有/合规 ≥5K 标注到位后直接训练用）。"""

    def __init__(self, pairs, size=IMG_SIZE, mean=INPUT_MEAN, std=INPUT_STD):
        self.pairs = pairs
        self.size = size
        self.mean = np.asarray(mean, np.float32)
        self.std = np.asarray(std, np.float32)

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        img_p, pts_p = self.pairs[idx]
        img = Image.open(img_p).convert("RGB").resize((self.size, self.size), Image.BILINEAR)
        pts = load_pts(pts_p)
        img = np.asarray(img, dtype=np.float32) / 255.0
        img = (img - self.mean) / self.std
        img = img.transpose(2, 0, 1).astype(np.float32)
        return torch.from_numpy(img), torch.from_numpy(pts.reshape(-1).astype(np.float32))


class BootstrapLandmarkDataset(Dataset):
    """bootstrap 伪标数据集（标注 = seed 模型伪标，仅冷启动/验证用，非最终）。"""

    def __init__(self, pairs, size=IMG_SIZE, mean=INPUT_MEAN, std=INPUT_STD):
        self.pairs = pairs
        self.size = size
        self.mean = np.asarray(mean, np.float32)
        self.std = np.asarray(std, np.float32)

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        img_p, pts_p = self.pairs[idx]
        img = Image.open(img_p).convert("RGB").resize((self.size, self.size), Image.BILINEAR)
        pts = load_pts(pts_p)
        img = np.asarray(img, dtype=np.float32) / 255.0
        img = (img - self.mean) / self.std
        img = img.transpose(2, 0, 1).astype(np.float32)
        return torch.from_numpy(img), torch.from_numpy(pts.reshape(-1).astype(np.float32))


# ───────────────────────── 合成几何人脸（仅冒烟） ─────────────────────────

def _arc_points(cx, cy, rx, ry, a0, a1, n):
    """在椭圆上从角度 a0 到 a1 均匀取 n 个点（屏幕坐标，y 向下）。"""
    out = []
    for i in range(n):
        t = a0 + (a1 - a0) * (i / max(1, n - 1))
        out.append((cx + rx * math.cos(t), cy + ry * math.sin(t)))
    return out


def _build_face_geometry(cx, cy, rx, ry):
    """根据脸的几何参数生成 106 个关键点的归一化坐标（[0,1]）。"""
    pts = np.zeros((NUM_PTS, 2), dtype=np.float32)
    # 1) 轮廓 0-32：下半椭圆（左下颌→下巴→右下颌）
    c = _arc_points(cx, cy, rx, ry, math.pi, 0.0, 33)
    pts[0:33] = c
    # 2) 左眉 33-43：左眼上方小弧
    lb_cy = cy - ry * 0.34
    pts[33:44] = _arc_points(cx - rx * 0.46, lb_cy, rx * 0.22, ry * 0.05, math.pi, 0.0, 11)
    # 3) 右眉 44-54
    rb_cy = cy - ry * 0.34
    pts[44:55] = _arc_points(cx + rx * 0.46, rb_cy, rx * 0.22, ry * 0.05, math.pi, 0.0, 11)
    # 4) 左眼 55-66：眼环
    le_cx, le_cy = cx - rx * 0.45, cy - ry * 0.12
    pts[55:67] = _arc_points(le_cx, le_cy, rx * 0.16, ry * 0.09, 0.0, 2 * math.pi, 12)
    # 5) 右眼 67-78：眼环
    re_cx, re_cy = cx + rx * 0.45, cy - ry * 0.12
    pts[67:79] = _arc_points(re_cx, re_cy, rx * 0.16, ry * 0.09, 0.0, 2 * math.pi, 12)
    # 6) 鼻 79-91：鼻梁（上→下）+ 鼻尖 + 鼻翼
    nose_x = cx
    pts[79:90, 0] = nose_x
    for i in range(11):
        pts[79 + i, 1] = cy - ry * 0.02 + (ry * 0.42) * (i / 10.0)
    # 鼻尖 91 在鼻梁末端正下方一点
    pts[91] = (nose_x, cy + ry * 0.44)
    # 7) 嘴 92-105：外轮廓环
    mo_cx, mo_cy = cx, cy + ry * 0.66
    pts[92:106] = _arc_points(mo_cx, mo_cy, rx * 0.26, ry * 0.12, 0.0, 2 * math.pi, 14)
    pts = np.clip(pts, 0.0, 1.0)
    return pts


def _draw_face(img, pts):
    """按几何点在图像上画简单人脸（皮肤 + 眼 + 眉 + 鼻 + 嘴），用于合成训练样本。"""
    draw = ImageDraw.Draw(img)
    # 背景
    draw.rectangle([0, 0, IMG_SIZE, IMG_SIZE], fill=(140, 153, 166))
    skin = (219, 181, 158)
    # 脸椭圆（填充皮肤）
    cx, cy, rx, ry = 0.5, 0.5, 0.30, 0.38
    x0, y0, x1, y1 = (int((cx - rx) * IMG_SIZE), int((cy - ry) * IMG_SIZE),
                      int((cx + rx) * IMG_SIZE), int((cy + ry) * IMG_SIZE))
    draw.ellipse([x0, y0, x1, y1], fill=skin)
    # 头发（顶部横带）
    draw.rectangle([0, 0, IMG_SIZE, int((cy - ry) * IMG_SIZE)], fill=(60, 45, 40))
    # 眉
    for seg in (range(33, 44), range(44, 55)):
        p = [tuple(int(v * IMG_SIZE) for v in pts[i]) for i in seg]
        for i in range(len(p) - 1):
            draw.line([p[i], p[i + 1]], fill=(40, 30, 25), width=3)
    # 眼（深色填充小椭圆）
    for seg in (range(55, 67), range(67, 79)):
        p = [tuple(int(v * IMG_SIZE) for v in pts[i]) for i in seg]
        xs = [q[0] for q in p]
        ys = [q[1] for q in p]
        draw.ellipse([min(xs), min(ys), max(xs), max(ys)], fill=(30, 25, 25))
    # 鼻（线）
    draw.line([tuple(int(v * IMG_SIZE) for v in pts[79]),
               tuple(int(v * IMG_SIZE) for v in pts[91])], fill=(178, 140, 127), width=2)
    # 嘴（椭圆）
    p = [tuple(int(v * IMG_SIZE) for v in pts[i]) for i in range(92, 106)]
    xs = [q[0] for q in p]
    ys = [q[1] for q in p]
    draw.ellipse([min(xs), min(ys), max(xs), max(ys)], fill=(150, 60, 60))
    return img


class SyntheticLandmarkDataset(Dataset):
    """合成几何人脸数据集（仅冒烟测试用，证明训练管线可跑通）。

    用确定性几何生成「脸 + 106 关键点标签」，让模型在几十张/几百 iter 内即可下降，
    验证脚本与 ONNX 导出，不提供真实泛化能力。
    """

    def __init__(self, n=40, size=IMG_SIZE, seed=0,
                 mean=INPUT_MEAN, std=INPUT_STD):
        self.n = n
        self.size = size
        self.mean = np.asarray(mean, np.float32)
        self.std = np.asarray(std, np.float32)
        self.rng = random.Random(seed)
        self.cx, self.cy, self.rx, self.ry = 0.5, 0.5, 0.30, 0.38
        self.pts0 = _build_face_geometry(self.cx, self.cy, self.rx, self.ry)

    def __len__(self):
        return self.n

    def _make(self):
        # 轻微随机抖动几何，制造样本多样性（标签与绘制保持同步）
        dx = self.rng.uniform(-0.02, 0.02)
        dy = self.rng.uniform(-0.02, 0.02)
        s = self.rng.uniform(0.97, 1.03)
        rx, ry = self.rx * s, self.ry * s
        pts = _build_face_geometry(self.cx + dx, self.cy + dy, rx, ry)
        img = Image.new("RGB", (self.size, self.size), (0, 0, 0))
        img = _draw_face(img, pts)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        # 颜色抖动
        jitter = np.asarray([self.rng.uniform(-0.04, 0.04) for _ in range(3)], np.float32)
        arr = np.clip(arr + jitter, 0, 1)
        arr = (arr - self.mean) / self.std
        arr = arr.transpose(2, 0, 1).astype(np.float32)
        return torch.from_numpy(arr), torch.from_numpy(pts.reshape(-1).astype(np.float32))

    def __getitem__(self, idx):
        return self._make()


if __name__ == "__main__":
    s = SyntheticLandmarkDataset(n=4)
    for i, (im, lb) in enumerate(s):
        assert im.shape == (3, IMG_SIZE, IMG_SIZE)
        assert lb.shape == (NUM_PTS * 2,)
    print("SyntheticLandmarkDataset OK, len=", len(s))
    # 校验 LANDMARK_INDEX 关键名存在
    for k in ("jaw_left", "jaw_right", "chin", "cheek_left", "cheek_right",
              "left_eye_center", "right_eye_center", "nose_tip", "mouth_left", "mouth_right"):
        assert k in LANDMARK_INDEX, "缺少具名索引: %s" % k
    print("LANDMARK_INDEX 关键名校验通过。")
