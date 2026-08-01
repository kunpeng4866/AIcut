# -*- coding: utf-8 -*-
"""人脸关键点（landmark）推理服务：加载自研 106 点 ONNX，逐帧输出原始帧像素坐标。

与 P1 `BeautyInferenceService` 完全相同的工程约定（ORT CUDA EP 优先、_prepend_cuda_dll_path
注入 PATH、输入 mean/std 归一化、输出后处理），仅模型不同。坐标后处理与
`models/landmark_net.py` 的 `LANDMARK_INDEX` 对应，返回 **原始帧像素坐标** (106,2) 的
float32 数组，供 `warp.py` / `core.generate_warp_maps` 生成形变网格。

ONNX 约定（与 landmark_net.py 严格一致）：
    - 输入: 1x3x256x256 RGB float32，已用 mean=[0.485,0.456,0.406]
      std=[0.229,0.224,0.225] 归一化（模型内部不再归一化）。
    - 输出: 1x212 float32 = 106 点 × [x, y]，每坐标归一化到 [0,1]（相对 256 输入尺寸）。
    - 后处理：模型输入是对原帧做 stretch resize 到 256×256，故像素坐标
      = norm_coord * 原帧尺寸（x: *width, y: *height），得到原帧像素坐标。
"""
import glob as _glob
import os
import sys

import numpy as np


# ── P6-CUDA：与 BeautyInferenceService 完全一致的 DLL 注入（见 inference_service.py）──
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


class LandmarkInferenceService:
    """加载 106 点人脸关键点 ONNX，逐帧推理原帧像素坐标。

    infer(rgb_np_HWC_uint8) -> np.float32 (106,2)，坐标为原帧像素坐标。
    """

    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    # 与 landmark_net.py 一致
    IN_SIZE = 256
    NUM_LANDMARKS = 106

    def __init__(self, model_path):
        if not model_path or not os.path.isfile(model_path):
            raise FileNotFoundError("人脸关键点模型不存在: {}".format(model_path))
        self.model_path = model_path
        # CUDA 优先，缺失时自动回退 CPU（不会抛异常，仅变慢）
        self.session = ort.InferenceSession(
            model_path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        shape = self.session.get_inputs()[0].shape
        self.in_size = int(shape[-1]) if isinstance(shape[-1], int) else self.IN_SIZE

    def infer(self, rgb_np_HWC_uint8: np.ndarray) -> np.ndarray:
        """rgb_np_HWC_uint8: HxWx3 uint8 RGB。返回 (106,2) float32 原帧像素坐标。"""
        orig_h, orig_w = rgb_np_HWC_uint8.shape[:2]
        # 1) stretch resize 到模型输入尺寸（与 landmark_net 导出时一致：非保持比例）
        small = self._resize(rgb_np_HWC_uint8, self.in_size, self.in_size)
        # 2) 归一化到 NCHW float32（mean/std 与训练/导出一致）
        rgb_f = small.astype(np.float32) / 255.0
        rgb_f = (rgb_f - self.MEAN) / self.STD
        inp = np.transpose(rgb_f, (2, 0, 1))[None, ...].astype(np.float32)
        # 3) 推理 -> 1x212，reshape 为 106x2 归一化坐标（相对 256 输入空间）
        out = self.session.run([self.output_name], {self.input_name: inp})[0]
        coords = out[0].reshape(self.NUM_LANDMARKS, 2).astype(np.float32)
        # 4) 还原到原帧像素坐标：stretch resize 下，归一化坐标 * 原帧尺寸即可。
        coords = coords * np.array([orig_w, orig_h], dtype=np.float32)
        return coords.astype(np.float32)

    @staticmethod
    def _resize(img: np.ndarray, th: int, tw: int) -> np.ndarray:
        from PIL import Image
        return np.asarray(Image.fromarray(img).resize((tw, th), Image.BILINEAR))
