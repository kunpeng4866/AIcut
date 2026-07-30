# 抠像 P4：启用 rmbg2 模型（BRIA RMBG-2.0）

> 状态：✅ 已实现并验证（提交 `bb34a9c`）
> 依赖：P0 色度 / P1 MODNet 智能 / P2 手动 / P3 背景合成
> 许可：BRIA RMBG-2.0（Apache-2.0），与既有 MODNet(Apache-2.0)+ONNX Runtime(MIT) 路线一致，避开 RVM(GPL-3.0)

---

## 1. 目标

在「智能抠像」模型下拉里启用 **rmbg2**（BRIA RMBG-2.0，BiRefNet 架构，通用去背景），
与既有 MODNet 并列。用户选择 rmbg2 后，后端用 RMBG-2.0 ONNX 推理生成灰度 matte，
预览/导出链路与 MODNet 完全共用（matte 契约、alphamerge、背景合成均不变）。

---

## 2. 实现要点

### 2.1 模型获取（`python/keying/core.py`）
- `RMBG2_MODEL_FILENAME = "rmbg2.onnx"`（FP32，约 976MB，BiRefNet ~230M 参数）。
- `_ensure_rmbg2_model(log)` 优先级：
  1. 环境变量 `AICUT_RMBG2_MODEL` 指定本地路径（原样使用）；
  2. 本地 FP32 缓存 `~/.cache/aicut/models/rmbg2.onnx`；
  3. ModelScope 国内镜像拉取 `briaai/RMBG-2.0/onnx/model.onnx`
     （`hf-mirror.com` 不代理 `briaai/*`，会 308 跳到被 egress 拦截的 `huggingface.co`，故走 modelscope.cn）。
- 权重文件头确认：`producer "pytorch" v2.5.0`，输入 `pixel_values` 动态 `[1,3,H,W]`，输出 `(1,1,H,W)`。

### 2.2 推理（`_Predictor` + `generate_matte`）
- `model_kind='rmbg2'`：输入 **1024×1024 方图**（BiRefNet 设计为 1024；512 下 deformable conv/ASPP 对齐会崩，已实测），ImageNet 归一化，输出已含 sigmoid（自适应：超出 [0,1] 才补 sigmoid）。
- `generate_matte` 按 `opts['model']` 分支：
  - `rmbg2` → `_ensure_rmbg2_model()` → `_Predictor(model_path, log, 'rmbg2')`；
  - 默认 `modnet` → 原有逻辑。
- 返回 `model: 'rmbg2'`（真实模型）或 `'placeholder'`（权重缺失回退）。

### 2.3 引擎线程（`src/keying.rs`）
- 对 rmbg2 放开 `OMP_NUM_THREADS` / `MKL_NUM_THREADS` 到 **8**（默认单线程是为 MODNet 轻量模型避免争核）。
- 解析 `opts_json` 的 `model` 字段决定线程数；modnet/manual 维持单线程不回归。

### 2.4 前端（`gui/src/components/panels/KeyingTab.tsx`）
- 解禁 rmbg2 选项：`<option value="rmbg2">rmbg2（BRIA RMBG-2.0）</option>`（移除 `disabled`）。
- 调用路径不变：`runSmartKeying` 已把 `model` 透传进 opts。

---

## 3. 关键坑（已踩并固化）

### 3.1 动态 INT8 量化反而更慢（❌ 弃用）
- 初版把 FP32 动态量化为 INT8（366MB），期望提速省内存。
- 实测：**INT8 单帧 1024² 推理 24.48s，FP32 仅 2.18s（慢 ~11 倍）**。
- 根因：onnxruntime CPU 对 BiRefNet 的 **deformable conv 无 INT8 内核**，量化后走更慢回退路径。
- 结论：**默认用 FP32 + 多线程**。INT8 量化函数已移除。

### 3.2 单线程导致「假死」（✅ 已修）
- 引擎原强制 `OMP_NUM_THREADS=1`，覆盖会话层多线程设置，BiRefNet 单线程下 1024 推理极慢（45 帧十几分钟，文件长期 48 字节看似卡死）。
- 修复：`keying.rs` 对 rmbg2 放开到 8 线程。FP32 + 8 线程实测 45 帧（480×270 源）约 5 分钟。

### 3.3 推理分辨率不能是 512（✅ 已修）
- BiRefNet 设计为 1024；512 下 `atrous_conv/GatherND` 运行时维度对齐失败 → 推理崩溃（exit 1）。
- 固定 1024 方图（源多为 ≤480p，上采样回原尺寸质量无损）。

### 3.4 内存峰值（ℹ️ 已知）
- FP32 1024 推理峰值 ~12GB 内存。本机 32GB 充足；低端机需注意。

---

## 4. 验证（做完一个验证一个）

### 4.1 后端 matte 生成（引擎 headless）
```
aicut-engine keying --mode matte --input rmbg2_sub.mp4 --opts '{"model":"rmbg2","threshold":0.5,"fps":30,"output":"rmbg2_sub_matte.mp4"}'
→ rc=0
→ {"duration":1.5,"fps":30.0,"frames":45,"height":270,"mattePath":"...","mode":"matte","model":"rmbg2","width":480}
→ model:"rmbg2"（真实模型，非占位）
```
- 抽中间帧：中心（前景）luma=254（完整保留）；四角（背景）63~114（RMBG-2.0 为通用去背景模型，对绿幕背景未压到 0，属正常）。

### 4.2 导出（共用 matte 链路）
```
aicut-engine export rmbg2_export_project.json rmbg2_out.mp4
→ rc=0；输出 video(h264)+audio(aac) 双流（源带静音音轨，绕过无音轨 -22 老坑）
```
- 像素断言：源四角亮绿（233/201）经 matte 后降到 42/62，四角均值 127.8→45.4（差值 82.4）→ **PASS**，确认 rmbg2 matte 已接入导出。

### 4.3 真实 App 预览/选项（app-cdp-verify）
- CDP 启动 App → 加载含 rmbg2 工程 → 打开抠像面板：
  `STORE: {"model":"rmbg2","mode":"smart","activePanel":"keying"}`
  `OPTION: {"found":true,"optionDisabled":false,"optionText":"rmbg2（BRIA RMBG-2.0）","selectDisabled":false,"selectValue":"rmbg2"}`
  → **RESULT: PASS**（rmbg2 选项已解禁可选）。
- 预览双路径（WebGPUPreview / PreviewCanvas）复用 `isMatte = matteAssetId && mode∈{smart,manual}`，与 MODNet 同路，无需额外改动。

---

## 5. 使用方式（用户侧）
1. 抠像面板 → 模型下拉选 **rmbg2（BRIA RMBG-2.0）** → 点「生成 matte」。
2. 首次会下载 ~976MB 权重到 `~/.cache/aicut/models/rmbg2.onnx`（国内走 ModelScope 镜像）。
3. 预览即时显示去背景结果；导出经 alphamerge + 阈值曲线，可与 P3 背景合成叠加。

> 性能提示：rmbg2（BiRefNet）较重，CPU 推理约 2s/帧（多线程）。1080p 源单次生成耗时较长，属预期。
