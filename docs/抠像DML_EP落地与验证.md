# 抠像 rmbg2 推理后端：DirectML（DML）落地与验证

> ⚠️ **本决策已变更（2026-08-01）**：本文是 2026-07-30「CUDA EP 在 Blackwell sm_120 上静默回退 CPU」时期的结论。
> 此后升级 NVIDIA 驱动至 610.62（含 CUDA 13.3 运行时）+ onnxruntime-gpu 1.28.0 + nvidia-* pip 包后，
> **CUDA EP 已在本机 Blackwell(sm_120) 实测可用**，抠像推理 provider 兜底链改回 **CUDA → DML → CPU（CUDA 优先）**。
> 当前 DML 仅作为 CUDA 不可用时的兜底分支（且本机未装 onnxruntime-directml，故实际走 CUDA）。
> 新结论与代码实现见 `python/keying/core.py`（`_prepend_cuda_dll_path` 注入 + `CUDAExecutionProvider` 优先）。

> 决策日期：2026-07-30（原始决策，已失效）
> 背景：P5 阶段尝试用 CUDA EP 加速 rmbg2（BRIA RMBG-2.0 / BiRefNet）失败，
> 本机 RTX 5060 Ti（Blackwell, sm_120）+ onnxruntime-gpu 1.28 组合下 CUDA EP
> 静默回退 CPU。经用户拍板：**放弃 CUDA 路线，改用 Windows 自带 DirectML（DML）**，
> 并把已下载的 CUDA toolkit 相关卸载干净。

## 1. 为什么不用 CUDA

- 显卡 RTX 5060 Ti = **Blackwell 架构，计算能力 sm_120**。
- 安装 CUDA toolkit 12.8.61 + onnxruntime-gpu 1.28.0 + 全套 `nvidia-*` cu12(12.9) DLL
  全部就位后逐一验证：
  - **CUDA EP**：即使只请求 CUDA，也 `used=['CPUExecutionProvider']`、5.85 s/帧，
    **无报错、纯静默回退**。根因是 ORT 1.28 预编译的 CUDA EP **不含 sm_120 内核**，
    toolkit 装了也救不了。
  - **TensorRT EP**：缺 TRT 运行时（`nvinfer*.dll` 不在），显式报
    *"Please install TensorRT libraries... GPU is supported"*。
- 结论：CUDA EP 在「当前 ORT 版本 + 本机 Blackwell」组合下是**死路**，toolkit 安装无效。

## 2. 为什么选 DML（DirectML）

- DML 走 **Windows 系统自带的 DirectML**，由 `onnxruntime-directml` 提供
  `DmlExecutionProvider`，**不依赖 CUDA toolkit / 独立显卡驱动分支**。
- 本机复测（隔离 venv + 生产 venv 两次一致）：
  - DML：**0.58–0.61 s/帧（≈1.6–1.7 f/s）**
  - CPU：**5.9 s/帧（0.17 f/s）**
  - **加速比 ≈ 10×**，且稳定。

## 3. 改动内容

### 3.1 Python venv（default）
- 卸载：`onnxruntime-gpu` + `nvidia-cublas-cu12` / `nvidia-cuda-nvrtc-cu12` /
  `nvidia-cuda-runtime-cu12` / `nvidia-cudnn-cu12`（含清理 pip 残留 `~` 半残目录与孤儿 `nvidia/` 空目录）。
- 安装：`onnxruntime-directml`（清华镜像）。
- 最终：`onnx 1.22.0` + `onnxruntime-directml 1.24.4`，
  `ort.get_available_providers() == ['DmlExecutionProvider', 'CPUExecutionProvider']`。

### 3.2 `python/keying/core.py`
`_Predictor.__init__` 的 EP 选择：
- rmbg2（重模型）：若 `DmlExecutionProvider` 可用 → `["DmlExecutionProvider", "CPUExecutionProvider"]`；
  否则 `["CPUExecutionProvider"]`。
- modnet（轻量）：维持 CPU 单线程（原设计不变）。
- 加载后记录**实际使用的 EP** 到日志（`EP: DML` / `EP: CPU`）。
- 显式注释：CUDA EP 在本机 Blackwell 会静默回退 CPU，故不启用；DML 不依赖 CUDA toolkit。

## 4. 验证

- 探针（生产代码路径 `core._Predictor(model_kind='rmbg2')`，default venv）：
  - `use_real=True`，日志 `EP: DML` → 实际走 DML。
  - 1280×720 帧推理 **0.61 s/帧（1.64 f/s）**，与隔离 venv 0.58 s/帧一致（≈10× CPU）。
- 回归：modnet 仍为 CPU 单线程，行为不变。

## 5. CUDA 相关清理（用户要求）

- **CUDA toolkit 12.8** 静默卸载（`cuda_12.8.0_windows.exe -uninstall -s`，nvcc 已消失）。
- 下载的 **CUDA 安装包（3.38GB）** 已删除（位于 `.workbuddy/tmp_cuda/`）。
- venv 内 `onnxruntime-gpu` 与全套 `nvidia-*` pip 包已卸载。

### ⚠️ 事故与恢复（重要）
- 卸载 CUDA toolkit 时，**当初安装 CUDA 12.8 一并装上的 NVIDIA 显示驱动也被带走**，
  导致 Windows 回退到「Microsoft 基本显示适配器」，分辨率骤降。
- 修复：用**同一个安装器只重装显示驱动**组件 —— `cuda_12.8.0_windows.exe -s Display.Driver`
  （不重装 toolkit）。驱动 576.88 重新加载，分辨率恢复 **3840×2160（4K）**，`nvidia-smi` 正常。
- 教训：**以后卸载 CUDA toolkit 前，务必先确认显示驱动是否为独立安装**；
  若与 toolkit 绑定，需单独保留/重装显示驱动，否则会连带卸掉显卡驱动。

## 6. 已知缺口 / 后续
- 当前 DML 驱动版本 576.88（CUDA 12.8 捆绑版），若用户此前为更新的 580.x，
  可经 NVIDIA App / GeForce Experience 自行升级到最新 Studio/Game Ready 驱动（不影响抠像）。
- CUDA 路线若日后想复活，需升级 onnxruntime 到含 Blackwell(sm_120) 内核的版本，或换支持
  Blackwell 的 ORT 构建；届时再评估（当前 DML 已满足 ~10× 加速需求）。
