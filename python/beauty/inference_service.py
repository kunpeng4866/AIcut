# -*- coding: utf-8 -*-
"""美颜自研推理服务：加载皮肤解析 ONNX，逐帧输出 face/neck/arm 多区域 mask。

数据流：
    ffmpeg 解码输入视频 → rawvideo(rgb24) 管道 → 逐帧 BeautyInferenceService.infer
    → 返回 face/neck/arm 三张区域 mask（float32 HxW ∈[0,1]）→ 由 core.generate_skin_mask
    写出独立的灰度 mask 视频。

合规硬约束（本项目既定、不可违反）：
    - 本服务只加载「训练管线产出的自研 ONNX」；发布代码不内置任何第三方预训练权重/SDK。
    - 若 model_path 为 None 或文件缺失 → __init__ 抛异常，调用方必须回退到旧阈值法
      （core.generate_skin_mask 的 YCbCr/HSV 分支），不得静默使用其它来源权重。

ONNX 约定：
    - 输入: 1x3x512x512 RGB float32，归一化 mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225]
    - 输出: 1x6x512x512 logits，类别顺序 [face_skin, neck, arm_other_skin, hair, clothes, background]
"""
import glob as _glob
import os
import sys

import numpy as np

# P6-CUDA：onnxruntime-gpu 依赖 nvidia-* pip 包提供的 CUDA/cuDNN DLL，但 ORT 不会自动把它们
# 加入 PATH，缺失时 CUDA EP 静默回退 CPU。此处在 import onnxruntime 之前把 bin 目录注入 PATH
# （glob 兼容 cu13→cu14 升级，不硬编码版本）。仅当目录存在时生效，onnxruntime-directml 环境无害。
def _prepend_cuda_dll_path() -> None:
    sp = os.path.join(sys.prefix, "Lib", "site-packages")
    nvidia_root = os.path.join(sp, "nvidia")
    add: list = []
    if os.path.isdir(nvidia_root):
        for pat in (os.path.join(nvidia_root, "*", "bin"),
                    os.path.join(nvidia_root, "*", "bin", "x86_64")):
            for d in _glob.glob(pat):
                if os.path.isdir(d):
                    add.append(d)
    if add:
        os.environ["PATH"] = os.pathsep.join(add + [os.environ.get("PATH", "")])


_prepend_cuda_dll_path()

import onnxruntime as ort  # noqa: E402


class BeautyInferenceService:
    """加载皮肤解析 ONNX，逐帧推理 face/neck/arm 区域 mask。

    infer(rgb_np_HWC_uint8) 返回 dict，键 face/neck/arm，值为 np.float32 HxW ∈[0,1]
    的区域 mask（已双线性上采样回原帧尺寸）。
    """

    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    # 输出通道顺序（与训练管线约定一致）
    IDX_FACE = 0
    IDX_NECK = 1
    IDX_ARM = 2

    def __init__(self, model_path):
        if not model_path or not os.path.isfile(model_path):
            raise FileNotFoundError("美颜解析模型不存在: {}".format(model_path))
        self.model_path = model_path
        # CUDA 优先，缺失时自动回退 CPU（不会抛异常，仅变慢）
        self.session = ort.InferenceSession(
            model_path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        shape = self.session.get_inputs()[0].shape
        self.in_size = int(shape[-1]) if isinstance(shape[-1], int) else 512

    def infer(self, rgb_np_HWC_uint8: np.ndarray) -> dict:
        """rgb_np_HWC_uint8: HxWx3 uint8 RGB。返回 face/neck/arm 区域 mask（原帧尺寸 float32）。"""
        orig_h, orig_w = rgb_np_HWC_uint8.shape[:2]
        # 1) resize 到模型输入尺寸
        small = self._resize(rgb_np_HWC_uint8, self.in_size, self.in_size)
        # 2) 归一化到 NCHW float32
        rgb_f = small.astype(np.float32) / 255.0
        rgb_f = (rgb_f - self.MEAN) / self.STD
        inp = np.transpose(rgb_f, (2, 0, 1))[None, ...].astype(np.float32)
        # 3) 推理 → 1x6xHxW logits
        logits = self.session.run([self.output_name], {self.input_name: inp})[0]
        prob = self._softmax(logits[0])  # 6xHxW
        # 4) 取 face/neck/arm 三类概率并上采样回原尺寸
        out: dict = {}
        for key, idx in (("face", self.IDX_FACE),
                         ("neck", self.IDX_NECK),
                         ("arm", self.IDX_ARM)):
            m = prob[idx].astype(np.float32)
            out[key] = self._upsample(m, orig_h, orig_w)
        return out

    # ── 内部工具 ──

    @staticmethod
    def _softmax(x: np.ndarray) -> np.ndarray:
        x = x - x.max(axis=0, keepdims=True)
        e = np.exp(x)
        return e / e.sum(axis=0, keepdims=True)

    @staticmethod
    def _resize(img: np.ndarray, th: int, tw: int) -> np.ndarray:
        from PIL import Image
        return np.asarray(Image.fromarray(img).resize((tw, th), Image.BILINEAR))

    @staticmethod
    def _upsample(mask: np.ndarray, th: int, tw: int) -> np.ndarray:
        from PIL import Image
        m = (np.clip(mask, 0.0, 1.0) * 255.0).astype(np.uint8)
        up = np.asarray(Image.fromarray(m).resize((tw, th), Image.BILINEAR))
        return up.astype(np.float32) / 255.0
