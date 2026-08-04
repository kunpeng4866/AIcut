# -*- coding: utf-8 -*-
"""AIcut 视频超清增强 (Super Resolution) 模块。

架构（与 keying/beauty 模块一致）:
    - core.py / inference.py : ONNX CUDA EP 推理 + 分块处理 + Gaussian Blending
    - bridge.py             : CLI 入口，JSON 协议（与 Rust 引擎对接）
    - model.py              : RRDBNet 12 块 PyTorch 模型定义（训练用）
    - temporal.py           : 3 帧 LR 特征融合模块
    - degradation.py        : 二阶退化模拟器（训练数据增强）
    - dataset.py            : 场景分类训练数据加载器
    - train.py              : 训练脚本
    - export_onnx.py        : ONNX 导出脚本

合规硬约束:
    禁止使用任何第三方预训练权重 / 商业 SDK。
    模型架构参考 Real-ESRGAN 的 RRDBNet (BSD 3-Clause)，权重自行训练。
"""
