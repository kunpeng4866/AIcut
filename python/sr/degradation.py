# -*- coding: utf-8 -*-
"""Real-ESRGAN 风格二阶退化模拟器（训练数据合成）。

合规约束（重要，勿删）:
    - 退化策略参考 Real-ESRGAN 论文公开描述的 "high-order degradation"
      (BSD 3-Clause, Copyright (c) 2021 Xintao Wang)，本文件为独立实现，
      不含第三方源码拷贝，也不依赖任何预训练模型 / 商业 SDK。
    - 仅依赖 numpy + PIL + scipy（工程未安装 cv2，禁止引入）。

管线:
    HR -> [一阶退化] -> [二阶退化] -> [缩放到目标尺寸] -> LR
    每一阶包含 6 类操作，**执行顺序每次随机打乱**，每类操作按独立概率触发:
        1. 模糊    : 各向同性高斯 / 各向异性高斯（带旋转） / 运动模糊
        2. 缩放    : 双三次 / 面积法(BOX) / 双线性 / 最近邻，可缩小也可放大
        3. 噪声    : 高斯噪声 与/或 泊松噪声，支持灰度噪声（三通道同噪声）
        4. JPEG    : PIL 有损压缩，quality 30~95
        5. sinc    : 圆形低通 sinc 核，模拟振铃/过冲效应
        6. 块丢失  : 16 像素对齐的宏块置零/纯色/强模糊，模拟 H.264 丢包花屏

用法:
    dp = DegradationPipeline()                  # 或 DegradationPipeline(cfg, seed=0)
    noisy = dp(hr_uint8)                        # 同尺寸退化图 (H, W, 3) uint8
    lr, hr = dp.degrade_to_lr(hr_uint8, 2)      # LR 为 HR 的 1/2 尺寸
"""
import copy
import io
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from scipy import ndimage, signal, special

__all__ = ["DegradationPipeline", "DEFAULT_CONFIG"]

# PIL 重采样滤波器；'area' 即 BOX 面积平均
_PIL_FILTERS = {
    "bicubic": Image.BICUBIC,
    "bilinear": Image.BILINEAR,
    "area": Image.BOX,
    "nearest": Image.NEAREST,
}

# 一阶退化：强度较大；二阶退化：强度收敛，避免过度破坏结构
_STAGE1 = {
    # --- 1. 模糊 ---
    "blur_prob": 0.8,
    "blur_sigma": (0.2, 4.0),
    "aniso_prob": 0.45,          # 走各向异性分支的概率
    "motion_prob": 0.25,         # 各向异性分支内走运动模糊的概率
    "blur_kernel_range": (7, 21),
    # --- 2. 缩放 ---
    "resize_prob": 1.0,
    "resize_mode_probs": {"up": 0.2, "down": 0.7, "keep": 0.1},
    "resize_scale": (1.0, 4.0),  # 缩小/放大倍率
    # --- 3. 噪声 ---
    "noise_prob": 0.8,
    "gaussian_noise_prob": 0.7,
    "noise_sigma": (1.0, 30.0),  # 0~255 尺度
    "poisson_prob": 0.5,
    "poisson_scale": (0.001, 0.1),
    "gray_noise_prob": 0.4,
    # --- 4. JPEG ---
    "jpeg_prob": 0.6,
    "jpeg_quality": (30, 95),
    # --- 5. sinc 振铃 ---
    "sinc_prob": 0.3,
    "sinc_kernel_range": (3, 11),
    "sinc_cutoff": (np.pi / 3.0, np.pi),
    # --- 6. 块丢失 ---
    "block_drop_prob": 0.15,
    "block_num": (1, 4),
    "block_size_ratio": (0.02, 0.12),
}

_STAGE2 = {
    "blur_prob": 0.5,
    "blur_sigma": (0.2, 2.0),
    "aniso_prob": 0.35,
    "motion_prob": 0.2,
    "blur_kernel_range": (5, 15),
    "resize_prob": 1.0,
    "resize_mode_probs": {"up": 0.3, "down": 0.6, "keep": 0.1},
    "resize_scale": (1.0, 2.0),
    "noise_prob": 0.6,
    "gaussian_noise_prob": 0.6,
    "noise_sigma": (1.0, 20.0),
    "poisson_prob": 0.5,
    "poisson_scale": (0.001, 0.05),
    "gray_noise_prob": 0.4,
    "jpeg_prob": 0.6,
    "jpeg_quality": (30, 95),
    "sinc_prob": 0.3,
    "sinc_kernel_range": (3, 11),
    "sinc_cutoff": (np.pi / 3.0, np.pi),
    "block_drop_prob": 0.1,
    "block_num": (1, 3),
    "block_size_ratio": (0.02, 0.08),
}

DEFAULT_CONFIG: Dict = {
    "seed": None,
    "stage1": _STAGE1,
    "stage2": _STAGE2,
    # 最终缩放回目标尺寸时使用的插值方式
    "final_resize_methods": ("bicubic", "area", "bilinear"),
}


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _to_float(img: np.ndarray) -> np.ndarray:
    if img.dtype == np.uint8:
        return img.astype(np.float32) / 255.0
    return np.clip(img.astype(np.float32), 0.0, 1.0)


def _to_uint8(img: np.ndarray) -> np.ndarray:
    return np.clip(img * 255.0 + 0.5, 0, 255).astype(np.uint8)


def _merge_config(default: Dict, user: Optional[Dict]) -> Dict:
    out = copy.deepcopy(default)
    for key, val in (user or {}).items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = _merge_config(out[key], val)
        else:
            out[key] = val
    return out


def _cap_kernel_size(ksize: int, img: np.ndarray) -> int:
    """限制核尺寸，保证 reflect padding 宽度 < 图像边长（小图时必需）。"""
    limit = 2 * min(img.shape[0], img.shape[1]) - 1
    ksize = min(ksize, limit)
    return max(3, ksize if ksize % 2 == 1 else ksize - 1)


def _filter2d(img: np.ndarray, kernel: np.ndarray, use_convolve2d: bool = False) -> np.ndarray:
    """逐通道 2D 卷积，reflect 边界，输出与输入同尺寸。

    kernel 均为中心对称核，卷积/相关等价。大核走 FFT 更快；
    sinc 按规范使用 scipy.signal.convolve2d。
    """
    kh, kw = kernel.shape
    ph, pw = kh // 2, kw // 2
    pad = np.pad(img, ((ph, ph), (pw, pw), (0, 0)), mode="reflect")
    chans = []
    for c in range(img.shape[2]):
        if use_convolve2d:
            chans.append(signal.convolve2d(pad[..., c], kernel, mode="valid"))
        else:
            chans.append(signal.fftconvolve(pad[..., c], kernel, mode="valid"))
    out = np.stack(chans, axis=-1)
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def _iso_gaussian_kernel(size: int, sigma: float) -> np.ndarray:
    ax = np.arange(size, dtype=np.float64) - (size - 1) / 2.0
    xx, yy = np.meshgrid(ax, ax)
    k = np.exp(-(xx ** 2 + yy ** 2) / (2.0 * sigma ** 2))
    return k / k.sum()


def _aniso_gaussian_kernel(size: int, sigma_x: float, sigma_y: float, theta: float) -> np.ndarray:
    """带旋转的各向异性高斯核（sigma_x != sigma_y）。"""
    ax = np.arange(size, dtype=np.float64) - (size - 1) / 2.0
    xx, yy = np.meshgrid(ax, ax)
    cos_t, sin_t = np.cos(theta), np.sin(theta)
    x_rot = xx * cos_t + yy * sin_t
    y_rot = -xx * sin_t + yy * cos_t
    k = np.exp(-0.5 * ((x_rot / sigma_x) ** 2 + (y_rot / sigma_y) ** 2))
    return k / k.sum()


def _motion_kernel(size: int, angle: float) -> np.ndarray:
    """沿 angle 方向过中心的线性运动模糊核。"""
    k = np.zeros((size, size), dtype=np.float64)
    c = (size - 1) / 2.0
    cos_t, sin_t = np.cos(angle), np.sin(angle)
    for i in range(size):
        t = i - c
        x = int(round(c + t * cos_t))
        y = int(round(c - t * sin_t))
        if 0 <= x < size and 0 <= y < size:
            k[y, x] = 1.0
    total = k.sum()
    if total <= 0:  # 理论上不会发生，兜底成 delta 核
        k[int(c), int(c)] = 1.0
        total = 1.0
    return k / total


def _sinc_kernel(size: int, cutoff: float) -> np.ndarray:
    """圆形低通 sinc 核（第一类贝塞尔函数），用于模拟振铃/过冲。"""
    if size % 2 == 0:
        size += 1
    c = (size - 1) // 2
    ax = np.arange(size, dtype=np.float64) - c
    xx, yy = np.meshgrid(ax, ax)
    r = np.sqrt(xx ** 2 + yy ** 2)
    with np.errstate(invalid="ignore", divide="ignore"):
        k = cutoff * special.j1(cutoff * r) / (2.0 * np.pi * r)
    k[c, c] = cutoff ** 2 / (4.0 * np.pi)  # r=0 处的极限值
    return k / k.sum()


# --------------------------------------------------------------------------- #
# 退化管线
# --------------------------------------------------------------------------- #
class DegradationPipeline:
    """二阶退化模拟器。

    Args:
        config: 覆盖 DEFAULT_CONFIG 的配置（深合并，可只写要改的字段）。
        seed: 随机种子；也可通过 config['seed'] 指定，显式参数优先。

    Attributes:
        last_ops: 最近一次调用实际执行的操作记录（调试 / Phase 0 验证用）。
    """

    def __init__(self, config: Optional[Dict] = None, seed: Optional[int] = None) -> None:
        self.config = _merge_config(DEFAULT_CONFIG, config)
        if seed is None:
            seed = self.config.get("seed")
        self.rng = np.random.default_rng(seed)
        self.last_ops: List[str] = []

    # ---------------- 公共接口 ---------------- #
    def __call__(self, hr_image: np.ndarray) -> np.ndarray:
        """对 HR 图做二阶退化，返回**同尺寸** uint8 图像 (H, W, 3)。"""
        img = self._validate(hr_image)
        h, w = img.shape[:2]
        out = self._run(_to_float(img), out_w=w, out_h=h)
        return _to_uint8(out)

    def degrade_to_lr(
        self, hr_image: np.ndarray, lr_scale: int = 2
    ) -> Tuple[np.ndarray, np.ndarray]:
        """生成训练用 (LR, HR) 配对。

        HR 会被裁剪到 lr_scale 的整数倍，LR 尺寸为 HR 的 1/lr_scale。
        返回均为 uint8 (H, W, 3)。
        """
        if lr_scale < 1:
            raise ValueError(f"lr_scale must be >= 1, got {lr_scale}")
        img = self._validate(hr_image)

        h = (img.shape[0] // lr_scale) * lr_scale
        w = (img.shape[1] // lr_scale) * lr_scale
        if h == 0 or w == 0:
            raise ValueError(f"image {img.shape[:2]} too small for scale {lr_scale}")
        hr = np.ascontiguousarray(img[:h, :w])

        lr = self._run(_to_float(hr), out_w=w // lr_scale, out_h=h // lr_scale)
        return _to_uint8(lr), hr

    # ---------------- 内部实现 ---------------- #
    @staticmethod
    def _validate(img: np.ndarray) -> np.ndarray:
        if img.ndim != 3 or img.shape[2] != 3:
            raise ValueError(f"expect (H, W, 3) RGB image, got {img.shape}")
        return img if img.dtype == np.uint8 else _to_uint8(_to_float(img))

    def _run(self, img: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
        self.last_ops = []
        img = self._run_stage(img, self.config["stage1"], "s1")
        img = self._run_stage(img, self.config["stage2"], "s2")

        if img.shape[1] != out_w or img.shape[0] != out_h:
            method = self._choice(self.config["final_resize_methods"])
            img = self._resize_to(img, out_w, out_h, method)
            self.last_ops.append(f"final_resize:{method}->{out_w}x{out_h}")
        return img

    def _run_stage(self, img: np.ndarray, cfg: Dict, tag: str) -> np.ndarray:
        ops = [
            ("blur", cfg["blur_prob"], self._op_blur),
            ("resize", cfg["resize_prob"], self._op_resize),
            ("noise", cfg["noise_prob"], self._op_noise),
            ("jpeg", cfg["jpeg_prob"], self._op_jpeg),
            ("sinc", cfg["sinc_prob"], self._op_sinc),
            ("block_drop", cfg["block_drop_prob"], self._op_block_drop),
        ]
        self.rng.shuffle(ops)  # 顺序随机打乱
        for name, prob, fn in ops:
            if self.rng.random() < prob:
                img = fn(img, cfg, tag)
        return img

    # --- 1. 模糊 --- #
    def _op_blur(self, img: np.ndarray, cfg: Dict, tag: str) -> np.ndarray:
        lo, hi = cfg["blur_sigma"]
        sigma = self._uniform(lo, hi)
        ksize = self._odd_int(*cfg["blur_kernel_range"])
        # 核尺寸至少覆盖 ±3 sigma
        ksize = max(ksize, self._make_odd(int(2 * np.ceil(3 * sigma) + 1)))
        ksize = _cap_kernel_size(ksize, img)

        if self.rng.random() < cfg["aniso_prob"]:
            if self.rng.random() < cfg["motion_prob"]:
                angle = self._uniform(0.0, np.pi)
                kernel = _motion_kernel(ksize, angle)
                self.last_ops.append(f"{tag}:blur_motion(k={ksize},a={angle:.2f})")
            else:
                sigma_x = sigma
                sigma_y = max(0.1, self._uniform(lo, hi))
                theta = self._uniform(0.0, np.pi)
                kernel = _aniso_gaussian_kernel(ksize, sigma_x, sigma_y, theta)
                self.last_ops.append(
                    f"{tag}:blur_aniso(sx={sigma_x:.2f},sy={sigma_y:.2f},t={theta:.2f})"
                )
            return _filter2d(img, kernel)

        # 各向同性直接用 ndimage 的可分离实现，更快
        self.last_ops.append(f"{tag}:blur_iso(s={sigma:.2f})")
        out = ndimage.gaussian_filter(img, sigma=(sigma, sigma, 0), mode="reflect")
        return np.clip(out, 0.0, 1.0).astype(np.float32)

    # --- 2. 缩放 --- #
    def _op_resize(self, img: np.ndarray, cfg: Dict, tag: str) -> np.ndarray:
        h, w = img.shape[:2]
        probs = cfg["resize_mode_probs"]
        mode = self._choice(list(probs.keys()), list(probs.values()))
        lo, hi = cfg["resize_scale"]

        if mode == "up":
            factor = self._uniform(1.0, hi)
        elif mode == "down":
            factor = 1.0 / self._uniform(max(lo, 1.0), hi)
        else:
            factor = 1.0

        new_w = max(8, int(round(w * factor)))
        new_h = max(8, int(round(h * factor)))
        if new_w == w and new_h == h:
            return img

        method = self._choice(["bicubic", "area", "bilinear"], [0.5, 0.35, 0.15])
        self.last_ops.append(f"{tag}:resize_{mode}({method},x{factor:.2f})")
        return self._resize_to(img, new_w, new_h, method)

    def _resize_to(self, img: np.ndarray, out_w: int, out_h: int, method: str) -> np.ndarray:
        pil = Image.fromarray(_to_uint8(img)).resize(
            (out_w, out_h), _PIL_FILTERS[method]
        )
        return np.asarray(pil, dtype=np.float32) / 255.0

    # --- 3. 噪声 --- #
    def _op_noise(self, img: np.ndarray, cfg: Dict, tag: str) -> np.ndarray:
        add_gauss = self.rng.random() < cfg["gaussian_noise_prob"]
        add_poisson = self.rng.random() < cfg["poisson_prob"]
        if not add_gauss and not add_poisson:  # 至少来一种
            add_gauss = True

        if add_gauss:
            sigma = self._uniform(*cfg["noise_sigma"]) / 255.0
            gray = self.rng.random() < cfg["gray_noise_prob"]
            shape = (img.shape[0], img.shape[1], 1) if gray else img.shape
            img = img + self.rng.normal(0.0, sigma, shape).astype(np.float32)
            img = np.clip(img, 0.0, 1.0)
            self.last_ops.append(f"{tag}:noise_gauss(s={sigma * 255:.1f},gray={gray})")

        if add_poisson:
            scale = self._uniform(*cfg["poisson_scale"])
            gray = self.rng.random() < cfg["gray_noise_prob"]
            vals = 1.0 / max(scale, 1e-4)  # scale 越大 -> vals 越小 -> 噪声越强
            if gray:
                base = img.mean(axis=2)
                noise = (self.rng.poisson(base * vals) / vals - base)[..., None]
            else:
                noise = self.rng.poisson(img * vals) / vals - img
            img = np.clip(img + noise.astype(np.float32), 0.0, 1.0)
            self.last_ops.append(f"{tag}:noise_poisson(sc={scale:.3f},gray={gray})")

        return img.astype(np.float32)

    # --- 4. JPEG --- #
    def _op_jpeg(self, img: np.ndarray, cfg: Dict, tag: str) -> np.ndarray:
        quality = int(self._int(*cfg["jpeg_quality"]))
        buf = io.BytesIO()
        Image.fromarray(_to_uint8(img)).save(buf, format="JPEG", quality=quality)
        buf.seek(0)
        with Image.open(buf) as decoded:
            out = np.asarray(decoded.convert("RGB"), dtype=np.float32) / 255.0
        self.last_ops.append(f"{tag}:jpeg(q={quality})")
        return out

    # --- 5. sinc 振铃 --- #
    def _op_sinc(self, img: np.ndarray, cfg: Dict, tag: str) -> np.ndarray:
        ksize = _cap_kernel_size(self._odd_int(*cfg["sinc_kernel_range"]), img)
        cutoff = self._uniform(*cfg["sinc_cutoff"])
        kernel = _sinc_kernel(ksize, cutoff)
        self.last_ops.append(f"{tag}:sinc(k={ksize},wc={cutoff:.2f})")
        # 规范要求：sinc 用 convolve2d
        return _filter2d(img, kernel, use_convolve2d=True)

    # --- 6. 块丢失 --- #
    def _op_block_drop(self, img: np.ndarray, cfg: Dict, tag: str) -> np.ndarray:
        h, w = img.shape[:2]
        img = img.copy()
        n_blocks = int(self._int(*cfg["block_num"]))
        r_lo, r_hi = cfg["block_size_ratio"]

        for _ in range(n_blocks):
            bh = max(8, int(h * self._uniform(r_lo, r_hi)))
            bw = max(8, int(w * self._uniform(r_lo, r_hi)))
            bh, bw = min(bh, h), min(bw, w)
            # 对齐到 16 像素，贴近 H.264 宏块行为
            y0 = int(self.rng.integers(0, max(1, h - bh + 1))) // 16 * 16
            x0 = int(self.rng.integers(0, max(1, w - bw + 1))) // 16 * 16
            y1, x1 = min(y0 + bh, h), min(x0 + bw, w)
            patch = img[y0:y1, x0:x1]
            if patch.size == 0:
                continue

            mode = self._choice(["zero", "mean", "blur"], [0.3, 0.3, 0.4])
            if mode == "zero":
                patch[:] = 0.0
            elif mode == "mean":
                patch[:] = patch.mean(axis=(0, 1), keepdims=True)
            else:
                patch[:] = ndimage.gaussian_filter(
                    patch, sigma=(self._uniform(2.0, 6.0),) * 2 + (0,), mode="nearest"
                )
            self.last_ops.append(f"{tag}:block_drop({mode},{x0},{y0},{x1 - x0}x{y1 - y0})")
        return img

    # ---------------- 随机数辅助 ---------------- #
    def _uniform(self, lo: float, hi: float) -> float:
        return float(self.rng.uniform(lo, hi))

    def _int(self, lo: int, hi: int) -> int:
        return int(self.rng.integers(int(lo), int(hi) + 1))

    def _choice(self, items, weights=None):
        if weights is None:
            return items[int(self.rng.integers(0, len(items)))]
        p = np.asarray(weights, dtype=np.float64)
        return items[int(self.rng.choice(len(items), p=p / p.sum()))]

    @staticmethod
    def _make_odd(value: int) -> int:
        return value if value % 2 == 1 else value + 1

    def _odd_int(self, lo: int, hi: int) -> int:
        return self._make_odd(self._int(lo, hi))
