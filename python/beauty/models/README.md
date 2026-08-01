# 美颜解析模型（BiSeNetV2）自研训练管线

本目录 (`python/beauty/models/`) 存放**自研**皮肤/人脸解析模型的训练产物与说明。
解析模型的目的是为美颜模块（磨皮/祛斑/美白等）提供精确的**皮肤与邻近部位分割掩膜**，
仅作用于可美颜区域，避免误伤头发、衣服、背景。

---

## 1. 架构概述

模型文件：`bisenetv2.py`，从零实现 **BiSeNetV2**，由两路分支 + 融合构成：

| 组件 | 说明 |
|------|------|
| **Spatial Path** | 3 个 stride-2 卷积，保留高分辨率细节（输出 1/8 特征图，256 通道） |
| **Semantic Branch** | MobileNetV3 风格 Inverted-Residual 骨干（带 SE、H-Swish），总 stride=8，负责语义上下文；末端接 GELayer 注入全局上下文（128 通道） |
| **FFM** | Feature Fusion Module：拼接空间/语义特征并施加空间注意力融合（256 通道） |
| **Head + Upsample** | 1×1 卷积 → 6 类 logits（stride-8），再用双线性上采样到 **512×512** |

**类别顺序（固定，与后端推理服务契约一致）：**

```
0 = face_skin        脸部皮肤
1 = neck             脖子
2 = arm_other_skin   手臂/其他皮肤
3 = hair             头发
4 = clothes          衣服
5 = background       背景
```

**输入输出契约（导出 ONNX 严格匹配 `python/beauty/inference_service.py`）：**

- 输入：`1×3×512×512` RGB **float32**，已在外部用
  `mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225]` 归一化（模型内部不再归一化）。
- 输出：`1×6×512×512` **float32 logits**（未经过 softmax，由推理服务自行处理）。
- 导出：`torch.onnx.export`，`dynamic_axes` 允许 batch 维变化。

> ⚠️ 本模型**不加载任何第三方预训练权重**，也**不依赖** torchvision / MediaPipe / ABPN / ModelScope 等。
> 所有权重均由本管线从随机初始化训练得到，符合「自研 + 自有/合规授权数据」的发布硬约束。

---

## 2. 在真实数据上训练（最终权重）

最终生产权重**必须**在 **≥5K 张自有采集 + 伪标 + 人工轻校正边界** 的标注图上训练。

### 2.1 数据集格式（规范标注）

```
<data_root>/
    images/           # 原始图像：.jpg/.jpeg/.png/.bmp
    masks/            # 单通道分割图（.png），像素值即类别索引 0–5
```

- `masks/` 下每张图与 `images/` 同名（扩展名 `.png`），像素值直接为类别索引 0–5。
- 用 palette 或灰度（L 模式）保存均可，loader 以 L 模式读取。
- 图像在 loader 内统一 resize 到 512×512，mask 用最近邻（NEAREST）插值保持类别整数。

### 2.2 训练命令

```bash
cd python/beauty
python train_parsing.py \
    --data-mode standard \
    --image-dir D:/aicut_data/images \
    --mask-dir  D:/aicut_data/masks \
    --epochs 50 --batch 8 --lr 1e-3 \
    --out-onnx models/parsing.onnx
```

- 建议使用 CUDA（RTX 5060 Ti 16GB 目标）。脚本会先 `print(torch.cuda.is_available())`；
  CUDA 不可用时自动退回 CPU（仅用于开发/冒烟，生产训练请使用带 CUDA 的 PyTorch）。
- 启用 AMP（`torch.cuda.amp`）以在 16GB 显存下跑更大 batch / 更高分辨率。
- 损失 = `CrossEntropy + Dice + boundary loss`（边界加权 CE），三者加权求和，强化边界精度。

### 2.3 数据收集要求（生产模型必须满足）

- **数量**：≥ 5,000 张带精细标注的图。
- **来源**：自有采集视频/图像，或持有合规授权的数据；**不得使用** CelebAMask-HQ / LaPa / LIP / ATR / 300W / WFLW 等 research-only 公开集作为成品训练分布。
- **标注质量**：以「自有采集 + 弱伪标 + 人工轻校正边界」为主；公开集仅可在冷启动阶段作为伪标参考，**不得直接**作为最终训练分布。
- **多样性**：覆盖不同肤色、光照、姿态、妆容、多人脸/遮挡等场景，避免过拟合单一分布。
- **部位覆盖**：确保 face_skin / neck / arm_other_skin / hair / clothes / background 六类均有充分样本。

---

## 3. bootstrap 伪标（仅冷启动 / 管线验证，非最终）

`../data_prep.py` 提供 bootstrap 伪标能力：

- 复用 `../core.py` 的**阈值皮肤检测**（YCbCr/HSV 统计，纯 numpy/scipy，非模型）作为
  弱标记者，只能可靠区分「皮肤 vs 背景」。
- 中心纵向启发式粗略划分 face / neck。
- **局限（务必知悉）**：
  - 仅能可靠标 skin(0) vs background(5)；face/neck 划分是启发式、不精确；
  - hair / arm_other_skin / clothes **在 bootstrap 中一律当作 background(5)**，无法学到；
  - 边界粗糙、对光照/同色背景敏感。
- 因此 bootstrap 产物**只能用于验证管线可跑通**，绝不能当作成品模型训练分布。

```bash
# 从视频抽帧 + 弱伪标，做短时验证训练
python train_parsing.py --data-mode bootstrap \
    --video "E:/AIcut/test_video_skin_mask.mp4" --epochs 3
```

---

## 4. 冒烟测试（无 5K 标注时验证管线）

无现成 5K 标注时，可用合成几何数据做短时冒烟训练，证明脚本能跑通并导出有效 ONNX：

```bash
python train_parsing.py --smoke
```

- 使用 `SyntheticSegDataset`（几何生成的 6 类区域）做几十张、几个 epoch 的短训练。
- 训练结束后导出 `models/parsing.onnx`（文件大小 > 0，且可用 onnxruntime 加载、输出形状 `1×6×512×512`）。
- 这证明**管线可用**；完整 5K 训练是独立的数据收集工作流。

验证脚本产出（示例）：
```
python -m py_compile bisenetv2.py train_parsing.py data_prep.py models/bisenetv2.py
python -c "import onnxruntime; ...; 打印输入输出形状"   # 期望 1x6x512x512
```

---

## 5. 文件清单

| 文件 | 作用 |
|------|------|
| `models/bisenetv2.py` | 从零实现的 BiSeNetV2（6 类），无预训练权重 |
| `train_parsing.py` | 训练脚本（CE+Dice+boundary，AMP，CUDA 探测，三数据源，导出 ONNX） |
| `../data_prep.py` | ffmpeg 抽帧、bootstrap 伪标、规范标注 loader、合成数据集 |
| `models/parsing.onnx` | 导出的推理模型（由训练脚本生成） |
| `models/parsing_last.pt` | 训练 checkpoint |
| `models/README.md` | 本说明 |

---

## 6. 合规声明

- 发布产品仅使用**自研 + 自有/合规授权数据训练**的权重。
- **禁止**任何第三方预训练权重或商业 SDK（不加载 torchvision 预训练、不用 MediaPipe/ABPN/ModelScope 等）。
- 公开研究数据集仅作冷启动伪标参考，**不得**直接进入成品训练分布。
- 最终权重必须在 **≥5K** 自有/合规标注图上完成训练。

---

## 7. P2 关键点模型（106 点，自研）

本目录另含**自研 106 点人脸关键点模型**训练管线，服务于美颜模块的面部形变/瘦脸/大眼等需要
人脸几何驱动的功能。与解析模型（P0/P1）同理，**不加载任何第三方预训练权重 / 商业 SDK**。

### 7.1 架构概述

模型文件：`models/landmark_net.py`，从零实现：

| 组件 | 说明 |
|------|------|
| **MobileNetV3 骨干** | 自研 Inverted-Residual + SE + H-Swish 骨干（无预训练），256 输入 → 末端 8×8 特征图，再经 1×1 + 全局平均池化得到固定维度特征向量 |
| **坐标回归头** | 两层 FC（含 Dropout）→ **106×2 = 212** 输出，末层 sigmoid 保证坐标 ∈ [0,1] |
| **损失** | Wing loss + 坐标 MSE（均在归一化 [0,1] 坐标空间） |
| **导出** | `torch.onnx.export`，`dynamic_axes` 允许 batch 维变化，输出单一 `landmarks` 节点 |

> 直接回归坐标（而非 heatmap）的好处：输出即 `1×212`，无需后处理，ORT 推理极简；
> 契约与 `python/beauty/landmark_service.py` 严格匹配。

**106 点布局（索引 0..105，顺序固定）：**

| 段 | 索引范围 | 说明 |
|----|----------|------|
| contour 轮廓 | 0–32 (33点) | 人脸外轮廓：jaw_left(0) → chin(16) → jaw_right(32)；cheek_left≈4, cheek_right≈28 |
| 左眉 | 33–43 (11点) | 图像中人脸左眉（x 较小） |
| 右眉 | 44–54 (11点) | 图像中人脸右眉（x 较大） |
| 左眼 | 55–66 (12点) | left_eye_center=60 |
| 右眼 | 67–78 (12点) | right_eye_center=72 |
| 鼻 | 79–91 (13点) | 鼻梁 + 鼻翼；nose_tip=91 |
| 嘴(外轮廓) | 92–105 (14点) | mouth_left=92, mouth_right=105 |

`models/landmark_net.py` 导出 `LANDMARK_INDEX` 字典（具名索引），供后端形变代码
`python/beauty/warp.py` 按名切片 212 向量（至少含 jaw_left/jaw_right/chin/cheek_left/
cheek_right/left_eye_center/right_eye_center/nose_tip/mouth_left/mouth_right）。

**输入输出契约（导出 ONNX 严格匹配 `landmark_service.py`）：**
- 输入：`1×3×256×256` RGB **float32**，已在外部用
  `mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225]` 归一化（模型内部不再归一化）。
- 输出：`1×212` **float32** = 106 点 × [x,y]，坐标 ∈ [0,1]（相对 256 输入尺寸）。
- 导出文件：`python/beauty/models/landmark.onnx`。

### 7.2 在真实数据上训练（最终权重）

最终生产权重**必须**在 **≥5K 张自有采集 + 伪标 + 人工轻校正** 的 106 点标注图上训练。

#### 7.2.1 数据集格式（规范标注）
```
<data_root>/
    images/    # 原始图像：.jpg/.jpeg/.png/.bmp
    pts/       # 规范关键点：.pts 文本，106 行，每行 "x y"（[0,1] 归一化）
```
- `pts/` 下每张图与 `images/` 同名，扩展名 `.pts`。
- 坐标归一化到 [0,1]，相对 256 输入尺寸；loader 内统一 resize 到 256×256 并做 mean/std 归一化。
- 也兼容逗号分隔变体；越界值自动裁剪到 [0,1]。

#### 7.2.2 训练命令
```bash
cd python/beauty
# 最终训练（自有 ≥5K 标注到位后）
python train_landmark.py \
    --data-mode standard \
    --image-dir D:/aicut_data/imgs \
    --pts-dir   D:/aicut_data/pts \
    --epochs 60 --batch 16 --lr 1e-3 \
    --out-onnx models/landmark.onnx

# bootstrap（自有 seed 模型给自有视频打伪标，短训练，非最终）
python train_landmark.py --data-mode bootstrap \
    --video "E:/AIcut/_textsrc.mp4" --seed-onnx models/landmark.onnx --epochs 3
```
- 建议使用 CUDA（RTX 5060 Ti 16GB 目标）。脚本先 `print(torch.cuda.is_available())`；
  CUDA 不可用时自动退回 CPU（仅开发/冒烟，生产训练请用带 CUDA 的 PyTorch）。
- 启用 AMP（`torch.cuda.amp`）以在 16GB 显存下跑更大 batch。

### 7.3 bootstrap 伪标（仅冷启动 / 管线验证，非最终）

`data_prep_landmark.py` 提供 bootstrap 伪标：
- 用「**自有**冷启动 seed 模型」（`--seed-onnx`，仅由 research-only 公开集如 300W/WFLW
  训练、不发布、仅作伪标种子）给自有视频抽帧打伪标，写入 `pseudo_*.pts`，**明确标注非最终**。
- **禁止**直接 import MediaPipe/dlib/face_alignment 等第三方 SDK；也不允许把公开集权重
  本身进入成品。
- 局限：seed 模型来自 research-only 分布，标注存在偏差；bootstrap 仅用于验证管线可跑通，
  **绝不能**当作成品训练分布。

```bash
# 从视频抽帧 + 自有 seed 模型打伪标
python train_landmark.py --data-mode bootstrap \
    --video "E:/AIcut/_textsrc.mp4" --seed-onnx models/landmark.onnx
```

### 7.4 冒烟测试（无 5K 标注时验证管线）

无现成 5K 标注时，用合成几何人脸做短时冒烟训练，证明脚本跑通并导出有效 ONNX：
```bash
python train_landmark.py --smoke
```
- 使用 `SyntheticLandmarkDataset`（确定性几何人脸 + 106 点标签）跑 200 iter。
- 训练结束导出 `models/landmark.onnx`（文件 >0，onnxruntime 加载后输出形状 `1×212`）。
- 独立校验：`python -m py_compile models/landmark_net.py data_prep_landmark.py train_landmark.py`
  以及用 onnxruntime 加载并打印输出形状。

### 7.5 文件清单（P2）

| 文件 | 作用 |
|------|------|
| `models/landmark_net.py` | 从零实现的 106 点回归网络（MobileNetV3 骨干 + 头），无预训练权重；导出 `LANDMARK_INDEX` |
| `train_landmark.py` | 训练脚本（Wing+MSE，AMP，CUDA 探测，三数据源，导出 ONNX） |
| `data_prep_landmark.py` | ffmpeg 抽帧、bootstrap 伪标、规范标注 loader、合成数据集 |
| `models/landmark.onnx` | 导出的推理模型（由训练脚本生成，冒烟阶段产出） |
| `models/landmark_last.pt` | 训练 checkpoint |

### 7.6 合规声明（P2）

- 发布产品仅使用**自研 + 自有/合规授权数据训练**的权重。
- **禁止**任何第三方预训练权重或商业 SDK（不加载 torchvision 预训练、不用 MediaPipe/dlib/face_alignment 等）。
- 公开研究数据集（300W 68 点、WFLW 98 点）**仅作冷启动 seed 模型训练数据**（seed 不发布），
  **不得**直接作为成品模型的训练分布。
- **最终权重必须在 ≥5K 张自有/合规标注人脸**上完成训练（自有采集 + 伪标 + 人工轻校正）。
