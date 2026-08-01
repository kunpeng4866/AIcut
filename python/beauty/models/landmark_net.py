# -*- coding: utf-8 -*-
"""自研 106 点人脸关键点模型（MobileNetV3 骨干 + 坐标回归头）。

架构（全部从零实现，**不加载任何第三方预训练权重**）：
    - 骨干：MobileNetV3（Inverted-Residual + SE + H-Swish），从 256×256 输入逐级下采样，
      末端 1×1 卷积 + 全局平均池化得到固定维度特征向量。
    - 回归头：两层全连接（含 Dropout）→ 106×2 = **212** 个输出，再经 sigmoid 映射到 [0,1]。
      输出直接是归一化坐标，满足后端推理服务契约，无需 heatmap 后处理，ORT 友好。

输入输出契约（导出 ONNX 严格匹配 python/beauty/landmark_service.py）：
    - 输入：1×3×256×256 RGB **float32**，已在外部用
      mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225] 归一化（模型内部不再归一化）。
    - 输出：1×212 **float32** = 106 个点 × [x, y]，每个坐标归一化到 [0,1]
      （相对 256 输入尺寸）。推理服务把它缩放到原帧尺寸得到像素坐标。
    - 导出：torch.onnx.export，dynamic_axes 允许 batch 维变化。

106 点整体布局（索引 0..105，顺序固定，与训练数据 / warp.py 一致）：
    ------------------------------------------------------------------
    段            索引范围            说明
    ------------------------------------------------------------------
    contour(轮廓)  0  – 32   (33点)   人脸外轮廓：从 jaw_left(0) 沿左侧脸颊向下到
                                     chin(16，下巴最低点)，再沿右侧脸颊向上到 jaw_right(32)。
                                     其中 cheek_left≈4、cheek_right≈28 为两侧颧骨点。
    左眉           33 – 43   (11点)   图像中人脸左眉（x 较小一侧），由内向外分布。
    右眉           44 – 54   (11点)   图像中人脸右眉（x 较大一侧），由内向外分布。
    左眼           55 – 66   (12点)   左眼轮廓环（含上下眼睑），left_eye_center=60 为代表性中心点。
    右眼           67 – 78   (12点)   右眼轮廓环（含上下眼睑），right_eye_center=72 为代表性中心点。
    鼻             79 – 91   (13点)   鼻梁（上→下）+ 鼻翼 + 鼻尖；nose_tip=91 为鼻尖点。
    嘴(外轮廓)     92 – 105  (14点)   嘴外轮廓环；mouth_left=92（左嘴角）、mouth_right=105（右嘴角）。
    ------------------------------------------------------------------
    合计：33+11+11+12+12+13+14 = 106 点。

    ⚠ 左右定义均基于「图像坐标」：左 = x 较小一侧，右 = x 较大一侧（即照片中人物的
      对侧）。warp.py 只负责按索引切片 212 向量，不关心左右语义，按本约定保持一致即可。

合规硬约束：不加载任何第三方预训练权重 / 商业 SDK / 公开 research-only 数据直接作训练分布。
"""
import math
import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_LANDMARKS = 106
OUT_DIM = NUM_LANDMARKS * 2  # 212

# 与推理服务契约一致（仅作文档/校验参考，模型内部不执行）。
INPUT_MEAN = (0.485, 0.456, 0.406)
INPUT_STD = (0.229, 0.224, 0.225)
INPUT_SIZE = 256  # 输入空间尺寸（正方形）

# ───────────────────────── 106 点布局 / 具名索引 ─────────────────────────
# 供后端形变代码(python/beauty/warp.py)使用：按名取索引即可切片 212 向量。
LANDMARK_INDEX = {
    # 轮廓
    "jaw_left": 0,        # 左侧下颌角（轮廓起点）
    "jaw_right": 32,      # 右侧下颌角（轮廓终点）
    "chin": 16,           # 下巴最低点
    "cheek_left": 4,      # 左侧颧骨/脸颊点
    "cheek_right": 28,    # 右侧颧骨/脸颊点
    # 眉（图像坐标：左=x 小，右=x 大）
    "left_brow_left": 33,
    "left_brow_right": 43,
    "right_brow_left": 44,
    "right_brow_right": 54,
    # 眼（中心点为本模型回归的"代表中心"，warp 也可自行对眼环取均值）
    "left_eye_center": 60,
    "right_eye_center": 72,
    "left_eye_left": 55,
    "left_eye_right": 66,
    "right_eye_left": 67,
    "right_eye_right": 78,
    # 鼻
    "nose_bridge_top": 79,
    "nose_tip": 91,       # 鼻尖
    # 嘴（图像坐标：左=x 小，右=x 大）
    "mouth_left": 92,     # 左嘴角
    "mouth_right": 105,   # 右嘴角
    "mouth_top": 99,
    "mouth_bottom": 105 - 6,  # 下唇中点附近（外轮廓环的下侧）
}

# 段范围（供调试/可视化/校验使用）
LANDMARK_SEGMENTS = {
    "contour": (0, 32),
    "left_brow": (33, 43),
    "right_brow": (44, 54),
    "left_eye": (55, 66),
    "right_eye": (67, 78),
    "nose": (79, 91),
    "mouth": (92, 105),
}


# ───────────────────────── 基础构建块（MobileNetV3 风格） ─────────────────────────

class ConvBNReLU(nn.Module):
    """带 BN 与激活的卷积块。"""

    def __init__(self, in_c, out_c, k=3, s=1, p=1, groups=1, act=True):
        super().__init__()
        self.conv = nn.Conv2d(in_c, out_c, k, s, p, groups=groups, bias=False)
        self.bn = nn.BatchNorm2d(out_c)
        self.act = nn.ReLU(inplace=True) if act else nn.Identity()

    def forward(self, x):
        return self.act(self.bn(self.conv(x)))


class HSwish(nn.Module):
    def forward(self, x):
        return x * F.relu6(x + 3.0) / 6.0


class SqueezeExcite(nn.Module):
    """MobileNetV3 通道注意力（SE）。"""

    def __init__(self, channels, reduction=4):
        super().__init__()
        mid = max(1, channels // reduction)
        self.se = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Conv2d(channels, mid, 1, bias=False),
            nn.ReLU(inplace=True),
            nn.Conv2d(mid, channels, 1, bias=False),
            nn.Hardsigmoid(inplace=True),
        )

    def forward(self, x):
        return x * self.se(x)


class InvertedResidual(nn.Module):
    """MobileNetV3 Inverted Residual 块（带可选 SE / H-Swish）。"""

    def __init__(self, in_c, hidden_c, out_c, stride, use_se, use_hs):
        super().__init__()
        self.stride = stride
        self.use_residual = (stride == 1 and in_c == out_c)
        act = HSwish() if use_hs else nn.ReLU(inplace=True)

        layers = []
        # expand
        if hidden_c != in_c:
            layers.append(ConvBNReLU(in_c, hidden_c, k=1, p=0, act=True))
        # depthwise
        layers.append(ConvBNReLU(hidden_c, hidden_c, k=3, s=stride, p=1,
                                 groups=hidden_c, act=True))
        if use_se:
            layers.append(SqueezeExcite(hidden_c, reduction=4))
        # project
        layers.append(nn.Conv2d(hidden_c, out_c, 1, 1, 0, bias=False))
        layers.append(nn.BatchNorm2d(out_c))
        self.block = nn.Sequential(*layers)
        self.act = act

    def forward(self, x):
        out = self.block(x)
        if self.use_residual:
            out = out + x
        return self.act(out)


# ───────────────────────── MobileNetV3 骨干 ─────────────────────────
# 配置格式: (in_c, exp, out_c, se, hs, stride)
# 针对 256×256 输入设计，总 stride = 32 → 末端特征图 8×8。
_BACKBONE_CFG = [
    # stem 在外面单独定义；下面是从 stage1 开始的块序列
    (16, 16, 16, False, False, 1),    # 保持 128×128（stem 已 stride2）
    (16, 64, 24, False, False, 2),    # 64×64
    (24, 72, 40, True, True, 2),      # 32×32
    (40, 120, 40, True, True, 1),     # 32×32
    (40, 160, 80, True, True, 2),     # 16×16
    (80, 200, 80, True, True, 1),     # 16×16
    (80, 240, 112, True, True, 1),    # 16×16
    (112, 320, 160, True, True, 2),   # 8×8
    (160, 480, 160, True, True, 1),   # 8×8
]


class MobileNetV3Backbone(nn.Module):
    """MobileNetV3 风格骨干，输出 8×8 特征图（256 输入）。"""

    def __init__(self, width_mult=1.0, last_c=160):
        super().__init__()
        # stem: 3 -> 16, stride 2
        self.stem = ConvBNReLU(3, 16, 3, 2, 1)
        stages = []
        in_c = 16
        for (cin, exp, cout, se, hs, stride) in _BACKBONE_CFG:
            # 简单 width 缩放（保留整数通道）
            cin = in_c
            e = max(1, int(round(exp * width_mult)))
            co = max(1, int(round(cout * width_mult)))
            stages.append(InvertedResidual(cin, e, co, stride, se, hs))
            in_c = co
        self.stages = nn.Sequential(*stages)
        self.last_c = in_c
        # 末端 1×1 扩张到固定宽度，便于回归头统一处理
        self.conv_last = nn.Sequential(
            nn.Conv2d(in_c, last_c, 1, 1, 0, bias=False),
            nn.BatchNorm2d(last_c),
            HSwish(),
        )

    def forward(self, x):
        x = self.stem(x)
        x = self.stages(x)
        x = self.conv_last(x)        # last_c × 8 × 8 (256 输入)
        return x


# ───────────────────────── 完整关键点网络 ─────────────────────────

class LandmarkNet(nn.Module):
    """106 点人脸关键点回归网络：骨干 + 全局池化 + 两层 FC 头 → 212 坐标(sigmoid)。"""

    def __init__(self, num_landmarks=NUM_LANDMARKS, width_mult=1.0,
                 feat_c=160, hidden_c=512, dropout=0.2):
        super().__init__()
        self.num_landmarks = num_landmarks
        self.out_dim = num_landmarks * 2
        self.backbone = MobileNetV3Backbone(width_mult=width_mult, last_c=feat_c)
        self.pool = nn.AdaptiveAvgPool2d(1)
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(feat_c, hidden_c),
            HSwish(),
            nn.Dropout(dropout),
            nn.Linear(hidden_c, hidden_c),
            HSwish(),
            nn.Dropout(dropout),
            nn.Linear(hidden_c, self.out_dim),
            # sigmoid 保证输出严格落在 [0,1]，满足契约"归一化到 [0,1]"
            nn.Sigmoid(),
        )

    def forward(self, x):
        """x: (B,3,256,256) → (B, 212)，每个坐标 ∈ [0,1]。"""
        f = self.backbone(x)
        f = self.pool(f)            # (B, feat_c, 1, 1)
        out = self.head(f)          # (B, 212)
        return out


def count_params(model):
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


# ───────────────────────── 损失函数 ─────────────────────────

def wing_loss(pred, target, w=0.1, eps=0.02, reduction="mean"):
    """Wing loss（针对 [0,1] 归一化坐标版本，w/eps 取小值）。

    pred, target: (B, 212) 归一化坐标。对小幅误差用对数惩罚，大误差退化为 L1。
    """
    diff = torch.abs(target - pred)
    c = w - w * math.log(1.0 + w / eps)
    small = w * torch.log(1.0 + diff / eps)
    large = diff - c
    loss = torch.where(diff < w, small, large)
    if reduction == "mean":
        return loss.mean()
    if reduction == "sum":
        return loss.sum()
    return loss


def landmark_loss(pred, target, w_wing=1.0, w_mse=1.0):
    """组合损失：Wing loss + 坐标 MSE（均在 [0,1] 归一化坐标空间）。"""
    wl = wing_loss(pred, target)
    mse = F.mse_loss(pred, target)
    return w_wing * wl + w_mse * mse, wl, mse


if __name__ == "__main__":
    m = LandmarkNet()
    m.eval()
    print("trainable params: %.2f M" % (count_params(m) / 1e6))
    dummy = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    out = m(dummy)
    print("output shape:", tuple(out.shape), "(expect (1, 212))")
    assert tuple(out.shape) == (1, OUT_DIM)
    assert out.min() >= 0.0 and out.max() <= 1.0
    print("LANDMARK_INDEX sample:", {k: LANDMARK_INDEX[k]
          for k in ("jaw_left", "jaw_right", "chin", "cheek_left",
                    "cheek_right", "left_eye_center", "right_eye_center",
                    "nose_tip", "mouth_left", "mouth_right")})
