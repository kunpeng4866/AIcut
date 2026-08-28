# AIcut 完整版分发说明（免安装便携包）

更新时间：2026-08-28
产物目录：`dist-full/win-unpacked/`（双击 `AIcut.exe` 即可运行，无需安装）

> 本包为「完整版」：应用外壳 + Rust 引擎 + ffmpeg + 字体 + **Python 推理运行时 + 模型权重**大部分随包，主打开箱即用。
> 打包阈值：**单个权重 <500MB 直接随包，≥500MB 首次用到时由软件内一键从免费公共镜像补全**（sha256 校验 + Range 续传）。
> 按此标准，不随包、需一键补全的权重为：`rmbg2.onnx`（~1GB 抠像）、`qwen3_fa`（~1.8GB 口播高精度强制对齐）。
> `sr_v0_test.onnx`（超清测试权重）因超清功能已取消，不随包也不提供补全。

## 运行方式
1. 进入 `dist-full/win-unpacked/`
2. 双击 `AIcut.exe`（不要通过 `start.bat`，那是开发模式）
3. 首次启动创建用户配置目录（`%APPDATA%/AIcut`），基础剪辑全部功能离线可用

## 包内已自包含（离线可用）
| 组件 | 位置 | 说明 |
|---|---|---|
| 应用外壳 | `AIcut.exe` + `resources/app/` | Electron 主程序 + React 渲染层 |
| 剪辑引擎 | `resources/engine/aicut-engine.exe` | Rust 引擎（含 flip/crop/rotate 等最新功能） |
| ffmpeg | `resources/ffmpeg/` | 完整共享版（含 libx264 / NVENC 等），引擎与导出共用 |
| 字体 | `resources/fonts/` | 中文等宽/无衬线，导出 drawtext 用 |
| Python 推理运行时 | `resources/python/` | 自带解释器 + torch/onnxruntime/demucs/whisper 等依赖（~3.1G） |
| 模型 | `resources/models/` | `modnet.onnx`、`frcrn_se16k.onnx`、`denoise/`（DFN3 三件套+config）、`panns/`（PANNs）随包内置；`rmbg2`/`qwen3_fa`/`sr_v0_test` 不随包（见下） |

## 需 CDN 补全（应用内一键下载，不随包）
| 组件 | 大小/说明 | 补全触发 | 源（domesticUrl 已配） |
|---|---|---|---|
> 判定标准：单个权重 ≥500MB 才走一键补全；<500MB 一律随包（见上表）。
| `rmbg2.onnx` | ~1GB 抠像权重 | 首次使用智能抠像（KeyingTab 调 `ensureAssets(['python','modnet','rmbg2'])`） | ModelScope `briaai/RMBG-2.0`（`assets-manifest.ts` 已回填） |
| `qwen3_fa` | ~1.8GB 口播高精度强制对齐（Qwen3-ForcedAligner，9 文件） | 首次使用口播剪辑（SpeechPanel 分析/批量前调 `ensureAssets([9×qwen3fa-*])`） | ModelScope Qwen 官方仓库 + HuggingFace 双源（`assets-manifest.ts` 已配） |

> 其余 AI 资产（python 运行时、modnet、frcrn、DFN3 三件套+config、PANNs）均 <500MB 已随包内置，开箱即用；
> 运行时若检测到文件缺失/损坏，也会走同一 CDN 补全机制按 sha256 修复，无需重新安装。
> 注：`sr_v0_test.onnx`（超清测试权重）因超清功能已取消，不随包也不提供补全。

## 各功能对补全的依赖
- **基础剪辑 / 导出**：完全离线，无需补全。
- **智能抠像（modnet / rmbg2）**：modnet 随包离线可用；rmbg2 首次使用需联网补全（~1GB）。
- **超清增强（SR）**：⚠️ 当前为骨架版本，仍使用测试权重、存在 3 个已知 bug，**暂不建议生产使用**。
- **口播剪辑 / 人声分离（Demucs）**：python 运行时随包离线可用；AI 降噪（DFN3）、副语言事件检测（PANNs）均已随包（<500MB），开箱即用；**高精度强制对齐（qwen3_fa, 1.8GB）** 首次需一键补全。
- **语音识别（ASR）**：默认走阿里百炼云端 API，需配置 `AICUT_ASR_API_KEY`；本地 whisper 兜底随包。
- **云端 TTS / AI 辅助**：依赖系统已安装 `curl`（Windows 11 通常自带；若缺失相关云功能不可用，不影响本地编辑）。

## CDN 补全机制
- **触发**：`ensureAssets(ids)`（`gui/src/store/assetStore.ts`）—— 首次用到相关功能时由 `KeyingTab` / `SRTab` 等调用。
- **下载源**：`gui/electron/assets-manifest.ts` 的 `domesticUrl`（国内默认，ModelScope 免费公共镜像）+ `externalUrl`（外网 HF/GitHub 备选），按 国内→外网→absoluteUrl 回退。
- **校验**：下载完成 sha256 比对 + Range 续传（断网可续，不重头下）。
- **自有加工产物**：modnet / DFN3 三件套+config / PANNs 等已上传至公开仓库 `kunpeng4866/aicut-assets` 作为补充直链（默认随包内置、无需下载；qwen3_fa 走 Qwen 官方仓库双源）。
- ⚠️ 仓库必须**公开**，否则 `domesticUrl` 补全会 403。

## 已知限制（非 bug，设计取舍）
1. SR 超清未达生产可用（测试权重 + 3 bug），后续修复后替换 `resources/models/sr_v0_test.onnx` 即可。
2. `rmbg2.onnx` 首次使用需联网补全（~1GB，支持续传）；纯本地剪辑不受影响。
3. 口播剪辑默认离线可用（DFN3 降噪、PANNs 副语言检测均已随包）；仅高精度强制对齐（qwen3_fa, 1.8GB）首次需一键补全，补全后离线可用。
4. 云 TTS / 云 AI 调用依赖 `curl`，打包未捆绑（避免体积膨胀），用本地能力无需关心。

## 体量
完整包解压后约 **3.8G+**（python 3.1G 占大头 + 模型 ~0.4G 已含 DFN3/PANNs/frcrn/modnet + ffmpeg 0.2G + 应用与引擎/字体 <0.1G）；
AI 一键补全组件 `rmbg2.onnx`（~1GB）、`qwen3_fa`（~1.8GB）按需下载，不计入基础包。

## 重新打包（开发机）
```bash
cd E:/AIcut/gui
npm run build            # 渲染层 (tsc && vite build)
npm run build:electron   # 主进程 (tsc -p tsconfig.electron.json)
cargo build --release    # 引擎（在 E:/AIcut 根，产出 target/release/aicut-engine.exe）
npm run electron:build   # = vite build && tsc -p tsconfig.electron.json && electron-builder → dist-full/win-unpacked
```
`pack-staging/`（ffmpeg/python 暂存）由开发机准备，`cdn-upload/models`（modnet/rmbg2/sr 源）提供模型，均勿 `git add`。
`extraResources` 当前打包：`engine` + `fonts` + `ffmpeg` + `python` + `models`（仅过滤 `rmbg2.onnx` / `sr_v0_test.onnx`；DFN3/PANNs/frcrn 均随包，qwen3_fa 不在 pack-staging/python 中本就不随包，走一键补全）。

## 可选：精简版（剥离 AI 资产 + 全量 CDN 补全）
> 当前 `package.json` 仅实现「完整版」。`extraResources` 仍含 `python` 与 `models`。
> 若需出「精简版」（`dist-lite`，仅外壳+引擎+ffmpeg+字体，AI 资产全走 CDN），按以下改动 `gui/package.json` 的 `build` 字段：
> 1. 从 `extraResources` 删除 `../pack-staging/python` 与 `../cdn-upload/models` 两项；
> 2. 将 `directories.output` 由 `dist-full` 改为 `dist-lite`；
> 此时 python 与全部模型均走上文「CDN 补全机制」一节，首次使用按功能按需下载。
