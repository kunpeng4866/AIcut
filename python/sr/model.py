# -*- coding: utf-8 -*-
"""RRDBNet 超分主干 + PatchGAN 判别器 + MS-SSIM 损失（训练侧模型定义）。

合规约束（重要，勿删）:
    - 网络结构参考 ESRGAN / Real-ESRGAN 公开论文中的 RRDBNet 架构
      (Real-ESRGAN, BSD 3-Clause, Copyright (c) 2021 Xintao Wang)。
      本文件是按公开架构描述**独立编写**的实现，不含任何第三方源码拷贝，
      更**不加载、不分发任何第三方预训练权重**。
    - PatchDiscriminator 参考 pix2pix (BSD) 的 70x70 PatchGAN 结构，同为独立实现。
    - MSSSIMLoss 依据 Wang et al. 2003 "Multiscale structural similarity" 用纯
      PyTorch 实现，不依赖 torchvision / pytorch-msssim 等外部库。
    - 全部权重由 AIcut 自有数据 + 退化模拟（degradation.py）训练产出。
      禁止引入商业 SDK 或 research-only 许可的权重。

输入输出契约:
    RRDBNet.forward: (B, 9, H, W) float32 [0,1]  ->  (B, 3, H*scale, W*scale) float32 [0,1]
    其中 9 = 3 帧（t-1, t, t+1）x RGB，时序信息在通道维前融合。

规模（num_block=12, num_feat=64, num_grow_ch=32）:
    参数量 8,824,707 (~8.82M)，FP32 权重 ~33.7 MiB，FP16 ~16.8 MiB。
"""
from typing import List, Sequence, Union

import torch
import torch.nn as nn
import torch.nn.functional as F

__all__ = [
    "ResidualDenseBlock",
    "RRDB",
    "RRDBNet",
    "PatchDiscriminator",
    "MSSSIMLoss",
    "default_init_weights",
]


@torch.no_grad()
def default_init_weights(
    module_list: Union[nn.Module, Sequence[nn.Module]], scale: float = 1.0
) -> None:
    """Kaiming 初始化；残差分支用 scale<1 缩小初值以稳定深层残差训练。"""
    if isinstance(module_list, nn.Module):
        module_list = [module_list]
    for module in module_list:
        for m in module.modules():
            if isinstance(m, nn.Conv2d):
                nn.init.kaiming_normal_(
                    m.weight, a=0.2, mode="fan_in", nonlinearity="leaky_relu"
                )
                m.weight.mul_(scale)
                if m.bias is not None:
                    nn.init.zeros_(m.bias)
            elif isinstance(m, nn.BatchNorm2d):
                nn.init.constant_(m.weight, 1.0)
                nn.init.zeros_(m.bias)


# --------------------------------------------------------------------------- #
# 超分主干
# --------------------------------------------------------------------------- #
class ResidualDenseBlock(nn.Module):
    """5 层密集连接卷积块（growth = num_grow_ch）。

    第 1~4 层卷积后接 LeakyReLU(0.2)，**第 5 层卷积后不加激活**，
    输出以 res_scale 缩放后与输入相加。
    """

    def __init__(
        self, num_feat: int = 64, num_grow_ch: int = 32, res_scale: float = 0.2
    ) -> None:
        super().__init__()
        self.res_scale = res_scale
        self.conv1 = nn.Conv2d(num_feat + 0 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + 1 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

        default_init_weights(
            [self.conv1, self.conv2, self.conv3, self.conv4, self.conv5], 0.1
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))  # 无激活
        return x5 * self.res_scale + x


class RRDB(nn.Module):
    """Residual in Residual Dense Block：3 个 RDB 串联 + 残差缩放。"""

    def __init__(
        self, num_feat: int = 64, num_grow_ch: int = 32, res_scale: float = 0.2
    ) -> None:
        super().__init__()
        self.res_scale = res_scale
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch, res_scale)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch, res_scale)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch, res_scale)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.rdb3(self.rdb2(self.rdb1(x)))
        return out * self.res_scale + x


class RRDBNet(nn.Module):
    """12 块 RRDB 超分网络（时序 3 帧输入，PixelShuffle 上采样）。

    结构:
        conv_first (num_in_ch -> num_feat)
        -> num_block x RRDB(num_feat)
        -> conv_body (num_feat -> num_feat) + 全局残差
        -> conv_up (num_feat -> num_feat * scale^2) + PixelShuffle(scale) + LeakyReLU
        -> conv_last (num_feat -> num_out_ch)
        -> out_mode 约束到 [0,1]

    Args:
        out_mode: 'clamp'（默认，训练/推理都保证 [0,1]）、'sigmoid'、
            或 'none'（不约束，供纯 L1/感知损失训练时使用）。
    """

    def __init__(
        self,
        num_in_ch: int = 9,
        num_out_ch: int = 3,
        scale: int = 2,
        num_feat: int = 64,
        num_block: int = 12,
        num_grow_ch: int = 32,
        out_mode: str = "clamp",
    ) -> None:
        super().__init__()
        if out_mode not in ("clamp", "sigmoid", "none"):
            raise ValueError(f"unsupported out_mode: {out_mode}")
        if scale < 1:
            raise ValueError(f"scale must be >= 1, got {scale}")

        self.num_in_ch = num_in_ch
        self.num_out_ch = num_out_ch
        self.scale = scale
        self.num_feat = num_feat
        self.num_block = num_block
        self.out_mode = out_mode

        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = nn.Sequential(
            *[RRDB(num_feat, num_grow_ch) for _ in range(num_block)]
        )
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        # scale=2 时即 64 -> 256，PixelShuffle(2) 还原为 64 通道、2 倍分辨率
        self.conv_up = nn.Conv2d(num_feat, num_feat * scale * scale, 3, 1, 1)
        self.pixel_shuffle = nn.PixelShuffle(scale)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

        # 头尾卷积用标准 Kaiming（scale=1）；0.1 缩放只用于 RDB 残差分支，
        # 否则初始输出会被压到接近全黑，拖慢早期收敛。
        default_init_weights(
            [self.conv_first, self.conv_body, self.conv_up, self.conv_last], 1.0
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if x.dim() != 4 or x.shape[1] != self.num_in_ch:
            raise ValueError(
                f"expect input (B, {self.num_in_ch}, H, W), got {tuple(x.shape)}"
            )

        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.pixel_shuffle(self.conv_up(feat)))
        out = self.conv_last(feat)

        if self.out_mode == "clamp":
            out = out.clamp(0.0, 1.0)
        elif self.out_mode == "sigmoid":
            out = torch.sigmoid(out)
        return out


# --------------------------------------------------------------------------- #
# GAN 判别器
# --------------------------------------------------------------------------- #
class PatchDiscriminator(nn.Module):
    """70x70 PatchGAN 判别器（BatchNorm + LeakyReLU(0.2)）。

    num_layers=3 时共 4 层下采样/特征卷积 + 1 层输出卷积，感受野 70x70。
    输出为逐 patch 的未归一化 logits (B, 1, H', W')，配合 BCEWithLogits /
    hinge loss 使用。
    """

    def __init__(
        self, num_in_ch: int = 3, num_feat: int = 64, num_layers: int = 3
    ) -> None:
        super().__init__()
        kw, padw = 4, 1
        layers: List[nn.Module] = [
            nn.Conv2d(num_in_ch, num_feat, kw, 2, padw),
            nn.LeakyReLU(negative_slope=0.2, inplace=True),
        ]

        nf_mult = 1
        for n in range(1, num_layers + 1):
            nf_mult_prev = nf_mult
            nf_mult = min(2 ** n, 8)
            stride = 2 if n < num_layers else 1  # 最后一层步长 1，保住 70 感受野
            layers += [
                nn.Conv2d(
                    num_feat * nf_mult_prev,
                    num_feat * nf_mult,
                    kw,
                    stride,
                    padw,
                    bias=False,  # 后接 BN，bias 冗余
                ),
                nn.BatchNorm2d(num_feat * nf_mult),
                nn.LeakyReLU(negative_slope=0.2, inplace=True),
            ]
        layers += [nn.Conv2d(num_feat * nf_mult, 1, kw, 1, padw)]

        self.net = nn.Sequential(*layers)
        default_init_weights(self.net, 1.0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# --------------------------------------------------------------------------- #
# MS-SSIM 损失（纯 PyTorch）
# --------------------------------------------------------------------------- #
_MSSSIM_WEIGHTS = (0.0448, 0.2856, 0.3001, 0.2363, 0.1333)


def _gaussian_window(win_size: int, sigma: float) -> torch.Tensor:
    """1D 高斯窗，返回 (1, 1, 1, win_size)。"""
    coords = torch.arange(win_size, dtype=torch.float32) - (win_size - 1) / 2.0
    g = torch.exp(-(coords ** 2) / (2.0 * sigma ** 2))
    g = g / g.sum()
    return g.view(1, 1, 1, win_size)


def _blur(x: torch.Tensor, win: torch.Tensor) -> torch.Tensor:
    """可分离高斯滤波（valid 卷积，与 SSIM 标准实现一致）。"""
    c = x.shape[1]
    win_size = win.shape[-1]
    win = win.to(dtype=x.dtype, device=x.device)
    x = F.conv2d(x, win.expand(c, 1, 1, win_size), groups=c)
    x = F.conv2d(x, win.transpose(2, 3).expand(c, 1, win_size, 1), groups=c)
    return x


def _downsample(x: torch.Tensor) -> torch.Tensor:
    pad_h, pad_w = x.shape[-2] % 2, x.shape[-1] % 2
    if pad_h or pad_w:
        x = F.pad(x, (0, pad_w, 0, pad_h), mode="replicate")
    return F.avg_pool2d(x, kernel_size=2, stride=2)


class MSSSIMLoss(nn.Module):
    """多尺度结构相似性损失：loss = 1 - MS-SSIM(pred, target)。

    - 5 级金字塔、11x11 高斯窗（sigma=1.5），权重取自 Wang et al. 2003。
    - 图像过小时自动降级层数并重新归一化权重（每级需满足 边长 >= win_size）。
    - 纯 PyTorch 实现，高斯窗以 buffer 注册，随 .to(device) / .cuda() 迁移。
    """

    def __init__(
        self,
        win_size: int = 11,
        win_sigma: float = 1.5,
        data_range: float = 1.0,
        levels: int = 5,
        weights: Sequence[float] = None,
        k1: float = 0.01,
        k2: float = 0.03,
        eps: float = 1e-8,
    ) -> None:
        super().__init__()
        if win_size % 2 == 0:
            raise ValueError("win_size must be odd")
        if not 1 <= levels <= len(_MSSSIM_WEIGHTS):
            raise ValueError(f"levels must be in [1, {len(_MSSSIM_WEIGHTS)}]")

        self.win_size = win_size
        self.data_range = data_range
        self.levels = levels
        self.k1, self.k2 = k1, k2
        self.eps = eps

        w = torch.tensor(
            list(weights) if weights is not None else list(_MSSSIM_WEIGHTS[:levels]),
            dtype=torch.float32,
        )
        if w.numel() != levels:
            raise ValueError("len(weights) must equal levels")
        self.register_buffer("win", _gaussian_window(win_size, win_sigma))
        self.register_buffer("weights", w / w.sum())

    def _ssim(self, x: torch.Tensor, y: torch.Tensor):
        """返回 (ssim, cs)，形状均为 (B, C)。"""
        c1 = (self.k1 * self.data_range) ** 2
        c2 = (self.k2 * self.data_range) ** 2

        mu_x = _blur(x, self.win)
        mu_y = _blur(y, self.win)
        mu_x2, mu_y2, mu_xy = mu_x * mu_x, mu_y * mu_y, mu_x * mu_y

        sigma_x2 = _blur(x * x, self.win) - mu_x2
        sigma_y2 = _blur(y * y, self.win) - mu_y2
        sigma_xy = _blur(x * y, self.win) - mu_xy

        cs_map = (2 * sigma_xy + c2) / (sigma_x2 + sigma_y2 + c2)
        ssim_map = ((2 * mu_xy + c1) / (mu_x2 + mu_y2 + c1)) * cs_map
        return ssim_map.mean(dim=(2, 3)), cs_map.mean(dim=(2, 3))

    def _effective_levels(self, h: int, w: int) -> int:
        min_side = min(h, w)
        if min_side < self.win_size:
            raise ValueError(
                f"input {h}x{w} smaller than window {self.win_size}, cannot compute SSIM"
            )
        n = 1
        while n < self.levels and (min_side >> n) >= self.win_size:
            n += 1
        return n

    def forward(self, pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        if pred.shape != target.shape:
            raise ValueError(
                f"shape mismatch: {tuple(pred.shape)} vs {tuple(target.shape)}"
            )
        if pred.dim() != 4:
            raise ValueError(f"expect (B, C, H, W), got {tuple(pred.shape)}")

        levels = self._effective_levels(pred.shape[-2], pred.shape[-1])
        weights = self.weights[:levels]
        weights = weights / weights.sum()  # 降级后重新归一化

        x, y = pred, target
        vals = []
        for i in range(levels):
            ssim_val, cs_val = self._ssim(x, y)
            # 低层只取对比度项 cs，最高层取完整 ssim；clamp 保证 log 可用
            vals.append((cs_val if i < levels - 1 else ssim_val).clamp_min(self.eps))
            if i < levels - 1:
                x, y = _downsample(x), _downsample(y)

        log_vals = torch.log(torch.stack(vals, dim=0))  # (levels, B, C)
        ms_ssim = torch.exp((log_vals * weights.view(-1, 1, 1)).sum(dim=0))
        return 1.0 - ms_ssim.mean()
