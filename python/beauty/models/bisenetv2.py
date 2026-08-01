# -*- coding: utf-8 -*-
"""自研 BiSeNetV2 皮肤/人脸解析模型（6 类）。

架构（全部从零实现，**不加载任何第三方预训练权重**）：
    - Spatial Path：3 个 stride-2 卷积，保住高分辨率细节，输出 1/8 特征图。
    - Semantic Branch：MobileNetV3 风格的 Inverted Residual 骨干（带 SE），
      总 stride=8，负责语义上下文；末端接 GELayer 注入全局上下文。
    - Feature Fusion Module (FFM)：拼接空间/语义特征并做空间注意力融合。
    - 分割头：1x1 卷积 → 6 类 logits（stride-8），再用双线性上采样到 512x512，
      使导出 ONNX 输出严格为 1x6x512x512。

类别顺序（与后端推理服务契约固定一致）：
    0=face_skin, 1=neck, 2=arm_other_skin, 3=hair, 4=clothes, 5=background

输入约定：1x3x512x512 RGB float32，**已在外部**用
    mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225] 归一化。
模型内部不再做归一化（与 inference_service.py 解耦）。

导出：用 torch.onnx.export，dynamic_axes 允许 batch 维变化。
"""
import math
import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_CLASSES = 6

# 与推理服务契约一致（仅作文档/校验参考，模型内部不执行）。
INPUT_MEAN = (0.485, 0.456, 0.406)
INPUT_STD = (0.229, 0.224, 0.225)
# 模型输入/输出空间尺寸（ONNX 输出固定为该尺寸）。
OUTPUT_SIZE = (512, 512)


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


class SpatialPath(nn.Module):
    """高分辨率细节路径：3×stride-2 卷积 → 1/8 特征图（256 通道）。"""

    def __init__(self):
        super().__init__()
        self.conv1 = ConvBNReLU(3, 64, 3, 2, 1)
        self.conv2 = ConvBNReLU(64, 128, 3, 2, 1)
        self.conv3 = ConvBNReLU(128, 256, 3, 2, 1)

    def forward(self, x):
        x = self.conv1(x)  # 1/2
        x = self.conv2(x)  # 1/4
        x = self.conv3(x)  # 1/8
        return x


class GELayer(nn.Module):
    """Global Average Pooling 注入全局上下文（BiSeNetV2 Context Path 风格）。"""

    def __init__(self, in_c, out_c):
        super().__init__()
        self.conv1 = ConvBNReLU(in_c, out_c, 3, 1, 1)
        self.conv2 = nn.Sequential(
            nn.Conv2d(out_c, out_c, 1, bias=False),
            nn.BatchNorm2d(out_c),
            nn.ReLU(inplace=True),
        )
        self.conv3 = nn.Conv2d(out_c, out_c, 1, bias=False)

    def forward(self, x):
        h = self.conv1(x)
        g = F.adaptive_avg_pool2d(h, 1)
        g = self.conv2(g)
        g = F.interpolate(g, size=h.shape[2:], mode="bilinear", align_corners=False)
        h = h + g
        return self.conv3(h)


class SemanticBranch(nn.Module):
    """MobileNetV3 风格语义骨干，输出 stride=8（64×64 @512 输入）。"""

    def __init__(self):
        super().__init__()
        self.stem = ConvBNReLU(3, 16, 3, 2, 1)  # 1/2
        self.stage1 = InvertedResidual(16, 32, 24, stride=2,
                                       use_se=False, use_hs=False)  # 1/4
        self.stage2 = InvertedResidual(24, 72, 40, stride=2,
                                       use_se=True, use_hs=True)   # 1/8
        self.stage3 = InvertedResidual(40, 120, 112, stride=1,
                                       use_se=True, use_hs=True)   # 1/8
        self.stage4 = InvertedResidual(112, 336, 160, stride=1,
                                       use_se=True, use_hs=True)   # 1/8
        self.reduce = nn.Sequential(
            nn.Conv2d(160, 128, 1, bias=False),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
        )
        self.boost = GELayer(128, 128)  # 注入全局上下文

    def forward(self, x):
        x = self.stem(x)
        x = self.stage1(x)
        x = self.stage2(x)
        x = self.stage3(x)
        x = self.stage4(x)
        x = self.reduce(x)
        x = self.boost(x)
        return x  # 128ch @ 1/8


class FeatureFusionModule(nn.Module):
    """拼接空间/语义特征并做空间注意力加权融合。"""

    def __init__(self, sp_ch, sem_ch, out_ch):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(sp_ch + sem_ch, out_ch, 3, 1, 1, bias=False),
            nn.BatchNorm2d(out_ch),
            nn.ReLU(inplace=True),
        )
        self.att = nn.Sequential(
            nn.Conv2d(2, 1, 3, 1, 1, bias=False),
            nn.BatchNorm2d(1),
            nn.ReLU(inplace=True),
            nn.Conv2d(1, 1, 1, bias=False),
            nn.Sigmoid(),
        )

    def forward(self, sp, sem):
        x = torch.cat([sp, sem], dim=1)
        x = self.conv(x)
        avg = torch.mean(x, dim=1, keepdim=True)
        mx, _ = torch.max(x, dim=1, keepdim=True)
        a = self.att(torch.cat([avg, mx], dim=1))
        return x * a


class BiSeNetV2(nn.Module):
    """完整解析网络：输出 1x6x512x512 logits。"""

    def __init__(self, num_classes=NUM_CLASSES):
        super().__init__()
        self.num_classes = num_classes
        self.spatial = SpatialPath()
        self.semantic = SemanticBranch()
        self.ffm = FeatureFusionModule(sp_ch=256, sem_ch=128, out_ch=256)
        self.head = nn.Conv2d(256, num_classes, 1, 1, 0, bias=True)
        # 固定上采样到 512x512，保证 ONNX 输出形状契约。
        self.up = nn.Upsample(size=OUTPUT_SIZE, mode="bilinear", align_corners=False)

    def forward(self, x):
        sp = self.spatial(x)     # 256ch @ 1/8
        sem = self.semantic(x)   # 128ch @ 1/8
        fused = self.ffm(sp, sem)
        logits = self.head(fused)        # num_classes @ 1/8
        logits = self.up(logits)         # num_classes @ 512
        return logits


def count_params(model):
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


if __name__ == "__main__":
    m = BiSeNetV2()
    m.eval()
    print("trainable params:", count_params(m))
    dummy = torch.randn(1, 3, 512, 512)
    out = m(dummy)
    print("output shape:", tuple(out.shape), "(expect (1, 6, 512, 512))")
