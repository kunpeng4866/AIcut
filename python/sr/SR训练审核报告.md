# AIcut 超清增强（SuperResolution）训练成品审核报告

**审核对象**：`python/sr/checkpoints/v1_x2/model_g_100000.pth`（生成器，配套 `model_d_100000.pth` 判别器）
**训练配置**：`train_config_v1_x2.json` — GAN 版，`use_amp=false`（fp32）、`w_gan=0.005`、`r1_weight=0`、scale=2、num_block=12、num_feat=64
**训练规模**：100000 迭代，每 5000 迭代一个 checkpoint 完整无缺（8/7 07:12 → 8/8 03:32，约 20 小时）
**审核环境**：E:/Python310 + torch 2.13 cu130 + RTX 5060 Ti 16GB，ffmpeg 走 AICUT_FFMPEG

---

## 一、结论：符合预期，且超出基线预期 ✅

三项核心审核全部 PASS。尤其是真实超分质量相对 bicubic 基线 **ΔPSNR=+6.32dB**（远超 SR 领域 "+3dB 即好"的判据），说明模型确实学到了有效的 2× 重建能力，而非仅过拟合退化噪声。

---

## 二、权重健康度 ✅ PASS

| 指标 | 结果 |
|---|---|
| 参数量 | 8,824,707（8.82M，与 RRDBNet scale2/block12 架构吻合） |
| 缺失键 / 多余键 | 0 / 0（权重完整加载） |
| NaN 元素数 | 0 |
| Inf 元素数 | 0 |
| 权重范围 / 分布 | [-0.5546, 0.5137]，均值 -0.0006，std 0.0263（典型已训练分布，非随机初始化） |

> checkpoint 为封装结构（顶层键 `model` 含 state_dict + 少量配置元数据），已正确解析加载。

---

## 三、真实超分质量（验证集，Y 通道 PSNR/SSIM）✅ 超出预期

验证集采用与训练**同分布**的退化管线（模糊+噪声+2×下采样），用中心帧做 bicubic 上采样作基线，取 30 个样本：

| 方法 | PSNR | SSIM |
|---|---|---|
| Bicubic 基线 | 30.90 dB | 0.7143 |
| **SR 模型 (v1_x2)** | **37.23 dB** | **0.9204** |
| **提升** | **+6.32 dB** | **+0.206** |

- 单样本 PSNR 范围 [14.54, 64.24]：**均值强，但存在难样本掉点**。
- 这是 **GAN 训练版**（w_gan=0.005），相比纯 L1 基线预期纹理更锐利、主观观感更好。

---

## 四、ONNX 导出与可部署性 ✅ PASS

- 导出：`model_g_100000.onnx`，`onnx.checker` 结构有效，输入 `[1, 9, H, W]`（三帧 RGB 沿通道拼接）、H/W 动态。
- 实测推理（onnxruntime CPU）：输出 `[1, 3, 256, 256]`（128×128 LR → 256×256 SR，scale=2 正确），值范围 [0.189, 0.898] 合理、无 NaN。
- **可直接接入 SR bridge 的 ONNX 推理路径**。

---

## 五、需注意的事项 / 后续

1. **难样本方差**：PSNR 下探到 14.54dB，疑似 `low_light / old_film / high_motion` 等难类或极端退化导致。建议补做 **per-scene 细分 PSNR**，定位掉点类，针对性补数据或调退化难度。
2. **ONNX 落地路径**：当前 ONNX 在 `v1_x2/` 目录下，需放到 SR bridge 默认读取路径（历史记忆指向 `sr_v0_test.onnx` 默认名）才能被生产链路加载。
3. **onnxruntime-gpu 待装**：本次仅装 CPU 版 onnxruntime 做验证；生产推理需 `onnxruntime-gpu`（CUDA EP）才能真正用上显卡加速。
4. **关于此前全量训练**：我之前启的 `train_config_base_l1 → v1_x2_base` 全量训练实际只到 iter 3800 就停（save_interval=5000 故无存盘），未产出有效权重；你这份 `v1_x2` GAN 成品已取代它，无损失。

---

## 六、建议的下一步

1. 将 `model_g_100000.onnx` 接入 SR bridge 默认路径 → SRTab 对比预览 → **真权重端到端验证**。
2. 安装 `onnxruntime-gpu` 启用 CUDA EP 推理。
3. 跑 per-scene 质量细分，确认各场景达标情况，决定是否需要补训。

**总体判定**：训练成功、模型健康、质量显著优于基线、可部署。可以进入「接入 bridge → SRTab 预览 → 端到端验证」阶段。
