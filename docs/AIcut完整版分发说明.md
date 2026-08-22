# AIcut 完整版分发说明（免安装便携包）

生成时间：2026-08-22
产物位置：`gui/dist-full/win-unpacked/`（双击 `AIcut.exe` 即可运行，无需安装）

## 运行方式
1. 进入 `gui/dist-full/win-unpacked/`
2. 双击 `AIcut.exe`（不要通过 `start.bat`，那是开发模式）
3. 首次启动会创建用户配置目录（`%APPDATA%/AIcut`），无需联网即可使用**基础剪辑**全部功能

## 包内已自包含的内容（离线可用）
| 组件 | 位置 | 说明 |
|---|---|---|
| 应用外壳 | `AIcut.exe` + `resources/app/` | Electron 主程序 + React 渲染层 |
| 剪辑引擎 | `resources/engine/aicut-engine.exe` | Rust 引擎（含 flip/crop/rotate 等最新功能） |
| ffmpeg | `resources/ffmpeg/` | 完整共享版（含 libx264 / NVENC 等），引擎与导出共用 |
| Python 推理 | `resources/python/` | 自带解释器 + torch/onnxruntime/demucs/whisper 等依赖 |
| 内置模型 | `resources/models/` | `rmbg2.onnx`(~1GB 抠像)、`rmbg2.int8.onnx`、`modnet.onnx` |
| 字体 | `resources/fonts/` | 中文等宽/无衬线，导出 drawtext 用 |

## 各功能对模型的依赖
- **智能抠像（rmbg2 / modnet）**：模型已内置，`resources/models/` 直接加载，**完全离线**。
- **超清增强（SR）**：⚠️ 当前为骨架版本，仍使用测试权重、存在 3 个已知 bug，**暂不建议生产使用**。
- **口播剪辑 / 人声分离（Demucs）**：首次使用需联网从 HuggingFace 镜像下载 Demucs 模型（约数百 MB，缓存到工程目录），之后离线。
- **语音识别（ASR）**：默认走阿里百炼云端 API，需配置 `AICUT_ASR_API_KEY`；本地 whisper 兜底需首跑下载模型。
- **云端 TTS / AI 辅助**：依赖系统已安装 `curl`（Windows 11 通常自带；若缺失相关云功能不可用，不影响本地编辑）。

## 已知限制（非 bug，设计取舍）
1. SR 超清未达生产可用（测试权重 + 3 bug），后续修复后替换 `resources/models/sr_v0_test.onnx` 即可。
2. 口播 / 本地 ASR 首跑需联网下载模型；纯本地剪辑不受影响。
3. 云 TTS / 云 AI 调用依赖 `curl`，打包未捆绑（避免体积膨胀），用本地能力无需关心。
4. 本包为「完整版」，已含全部 AI 运行时（约 5GB）。如需更小体积，可改为「模型首跑下载」策略压回 ~200MB——按需告知。

## 体量
完整包解压后约 **5GB**（其中 Python 环境 3.1G + 模型 1.4G + ffmpeg 0.2G + 应用与引擎 <0.1G）。

## 重新打包（开发机）
```bash
cd E:/AIcut/gui
npm run build            # 渲染层
npm run build:electron   # 主进程
cargo build --release    # 引擎（已含最新功能）
npx electron-builder --win --dir   # 生成 dist-full/win-unpacked
```
`pack-staging/`（ffmpeg/python/models 暂存）由开发机准备，勿 `git add`。
