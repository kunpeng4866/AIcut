# AIcut 设计方案 · Phase 5（已审核 · 已实现 · 已验证（逻辑层））

> 目标：**WebGPU 实时预览** —— 用 GPU 在桌面端渲染进程中连续播放时间线（含变换/特效/调色/转场/字幕），替代当前"逐帧 FFmpeg 抽帧"预览。
> 前置：Phase 4 已完成 Rust 引擎 + 4K 代理；本阶段复用代理（720p）作为预览解码源，进一步降低开销。

---

## 0. 现状与动机

| 现状 | 问题 |
|---|---|
| 预览 = `extractFrame`（FFmpeg 抽单帧 PNG） | 每拖动 playhead 0.2s 调一次 FFmpeg，卡顿、无连续播放感 |
| 播放 = `setInterval` 步进 + 反复抽帧 | 高 CPU、无法平滑预览特效/转场 |
| 全部滤镜在导出时才生效 | 编辑时看不到效果，所见非所得 |

Phase 5 用 **WebGPU**（Chromium 内置，Electron 渲染进程可用）做实时合成：把每个片段当前帧作为纹理上传 GPU，用 WGSL 着色器应用变换/特效/调色/不透明度，按时间线 z 序合成并叠加文本/字幕，连续出帧。

---

## 1. 架构

```
Electron 渲染进程 (React)
  └─ PreviewEngine (WebGPU)
       ├─ Timeline 逻辑（纯函数，可单测）：给定 project + t → 当前激活的 视频层 / 文本层 / 字幕层 / 转场态
       ├─ 每个视频素材 → 一个离屏 <video>（静音、加载 proxyPath）→ requestVideoFrameCallback 取帧
       ├─ 帧 → GPUTexture（copyExternalImageToTexture）
       ├─ WGSL 管线：顶点变换(scale/rotate/translate) + 片元特效(gblur/vignette/eq色彩/opacity)
       ├─ 合成：z 序叠加；转场激活时按进度混合 prev/next
       └─ 文本/字幕：2D canvas 叠加层（清晰、免着色器）
  └─ 回退：navigator.gpu 不可用时，自动退回现有 extractFrame <img> 预览
```

### 1.1 解码策略（推荐 `<video>` 复用浏览器解码）
- 不自己写 mp4 demux + WebCodecs 解码器；直接复用浏览器 `<video>` 的硬件解码（最快、最稳）。
- 预览源用 **proxyPath（720p）**（Phase 4 已生成），解码/上传开销最低。
- 需要一个安全资源通道：主进程注册 `aicut-asset://` 协议映射到工程 assets 目录（避免 `file://` 安全限制），渲染进程用 `<video src="aicut-asset://<id>">` 加载。

### 1.2 可测试的核心（不依赖 GPU）
`Timeline` 纯逻辑（Node 可单测）：
- `activeVideoLayers(project, t)`：返回当前激活视频片段（含素材相对 in/out、全局位置）。
- `activeTransition(project, t)`：返回激活转场对 + 进度 p∈[0,1]（对齐引擎 xfade 的 `offset/duration` 模型）。
- `activeTextSubtitle(project, t)`：返回当前应显示的文本/字幕（按 `in/out` + `enable`）。
这些逻辑与导出引擎保持一致（同一份 project 模型），保证"预览所见 = 导出所得"。

### 1.3 WGSL 着色器范围
- **MVP 核心**：顶点变换（scale/rotate/translate 矩阵）、opacity、cross-fade 转场混合、文本/字幕叠加、色彩调整（brightness/contrast/saturation ≈ eq）。
- **增强**：gblur（可分离高斯）、vignette、chroma key（绿幕）。
- 蒙版（rectangle/linear）若首版未覆盖，回退用 2D canvas 蒙版近似。

---

## 2. 渲染进程改动

| 文件 | 改动 |
|---|---|
| `packages/ui/src/preview/Timeline.ts` | 纯逻辑：激活层/转场/字幕计算（单测） |
| `packages/ui/src/preview/PreviewEngine.ts` | WebGPU 合成器：device/canvas/管线/播放循环 |
| `packages/ui/src/preview/effects.wgsl.ts` | WGSL 着色器字符串（色彩/模糊/暗角/绿幕/变换） |
| `packages/ui/src/App.tsx` | 检测 `navigator.gpu`：有则挂载 `<canvas>`+PreviewEngine，无则保留 `<img>`+extractFrame；共享 playhead/time 状态 |
| `apps/desktop/src/main.ts` | 注册 `aicut-asset://` 协议映射工程 assets（安全加载 proxy 给 `<video>`） |
| `apps/desktop/src/preload.ts` | 暴露 `previewEngine` 控制 API（可选，或仅在渲染进程内管理） |

---

## 3. 里程碑

| # | 内容 | 验证 |
|---|---|---|
| M1 | Timeline 纯逻辑 + 单测（激活层/转场/字幕，对齐引擎模型） | `vitest`/`tsx` 单测全过 |
| M2 | `aicut-asset://` 协议 + 离屏 `<video>` 加载 proxy | 渲染进程能取到帧（手动验证） |
| M3 | WebGPU 合成器骨架：device/canvas/单视频纹理上传+transform+opacity | 单视频可实时播放 |
| M4 | 转场混合 + 文本/字幕叠加 | 转场/字幕实时可见 |
| M5 | 特效着色器：色彩调整 + gblur/vignette/chroma | 特效实时可见 |
| M6 | 回退链路 + 回归：navigator.gpu 不可用时退回 extractFrame；tsc 零错误；Phase 1/2/4 冒烟不破 | 零回归 |

---

## 4. 验证边界（重要）

- 本沙盒为 **无显示、无 GPU 的 headless Linux**，WebGPU 无法在 Node/无头环境运行时验证。
- Phase 5 在本环境的**可验证项**：`tsc` 零错误；Timeline 纯逻辑单测全过（与导出引擎模型一致）；现有 FFmpeg 抽帧预览与 MCP/桌面构建**保持绿色**（作为回退与对照）。
- **无法在本环境验证**：实际 GPU 出帧、WGSL 着色效果、`<video>` 解码流畅度——这些需在 **Windows（你的主力，D3D12 后端）桌面端**实机验收。
- 因此 Phase 5 交付 = "可编译、逻辑已测、回退可用" 的代码 + 一份 Windows 实机验收清单。

---

## 5. 审核要点

1. 预览管线用 **WebGPU 合成器（`<video>` 解码 + WGSL 着色器）**，还是更轻的 **`<video>`→2D canvas 合成（无着色器，特效受限）**？
2. 首版着色器覆盖范围：**核心集（变换/opacity/转场/色彩/模糊/暗角/绿幕）一次性做**，还是 **MVP 仅变换/opacity/转场，特效后补**？
3. 预览解码源：用 **proxy（720p，推荐）** 还是 source？
4. 本阶段范围：直接实现 WebGPU 合成器 + 回退（完整 Phase 5），还是先只做 **Timeline 逻辑 + 回退脚手架**（GPU 着色器后置）？
