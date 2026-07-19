# AIcut 设计方案 · Phase 2（已审核 · 已实现 · 已验证）

> 基于《AIcut设计方案_v1.1_已审核定稿.md》。目标：**桌面端可用化** 与 **功能对齐剪映** 双线并行。
> 本文仅描述方案，未写实现代码。审核通过后进入实现。

---

## 0. Phase 2 目标与范围

| 主线 | 目标 | 交付物 |
|---|---|---|
| A. 桌面端可用化 | 把 React UI 真正接上引擎，能手动剪片 | 多轨时间线 + 预览 + 属性面板 + 导入/导出 |
| B. 功能对齐剪映 | 文本/字幕、音频/配乐、特效/转场、调色/画质 | 数据模型扩展 + FFmpeg 构建器扩展 + MCP 工具实现 |

**明确不在 Phase 2（留待 Phase 3/4）**：WebGPU 实时播放（先用抽帧预览兜底）、内置云端 AI Provider 真实模型（先留接口+规则兜底）、Rust 引擎生产路径替换 TS 引擎、4K 代理/性能优化。

---

## 1. 工程数据模型扩展（`packages/schema`）

在现有 `Project / Canvas / Track / Clip / Asset / Transform` 基础上扩展：

### 1.1 文本片段（TextClip）
```ts
type TextClip = {
  id: string; type: 'text';
  text: string;
  style: { fontFamily: string; fontSize: number; color: string; bold?: boolean;
           align?: 'left'|'center'|'right'; background?: string; stroke?: string };
  transform: Transform;            // x/y/scale/rotation/opacity
  in: number; out: number;         // 时间入出点（秒）
  animation?: 'none'|'fade'|'slide_up'|'pop';
};
```

### 1.2 字幕轨（Subtitle）
- 新增 `track.type = 'subtitle'`，其 clips 为 `SubtitleClip { id, type:'subtitle', start, end, text, style? }`。
- 也支持整条字幕轨由外部 `.srt/.ass` 导入（asset 引用）。

### 1.3 音频片段增强（AudioClip）
```ts
type AudioClip = Clip & {
  type: 'audio';
  volume: number;                  // 0~2，默认 1
  fadeIn?: number; fadeOut?: number;   // 秒
  envelope?: Keyframe[];           // 音量关键帧
};
```

### 1.4 特效 / 滤镜（Effect）
```ts
type Effect = {
  kind: 'filter'|'transition';
  name: string;                    // gblur / eq / colorbalance / xfade / fade ...
  params: Record<string, number|string>;
  // filter 挂在 clip 上；transition 挂在两 clip 之间（track.transitions[]）
};
```
- `Track.transitions?: Transition[]`，`Transition { id, fromClipId, toClipId, name, duration }`。
- `Clip.effects?: Effect[]`（如滤镜、调色、画质增强）。

### 1.5 关键帧（Keyframe）
```ts
type Keyframe = { at: number; value: number };   // 某属性在时间 at 的值
// 支持属性：transform.x/y/scale/rotation/opacity、audio volume
```

### 1.6 调色 / 画质（ColorGrade）
挂在 `Clip.colorGrade?`：
```ts
type ColorGrade = {
  brightness?: number; contrast?: number; saturation?: number;
  temperature?: number; tint?: number;
  lut?: string;                    // 可选 .cube LUT 路径
  sharpen?: number;                // 画质增强（unsharp）
  // 美颜/超分标记为 Phase 3 外部 Provider
};
```

### 1.7 蒙版（Mask）
`Clip.mask?: { type:'rectangle'|'circle'|'linear'|'chroma'; params: Record<string,number|string> }`。

> 所有扩展均向后兼容：`project.json` 旧工程缺字段时由 Zod 默认值补全，非破坏性。

---

## 2. 引擎 / FFmpeg 构建器扩展（`packages/core/src/engine.ts`）

在现有 `buildRenderCommand` 基础上，按 clip 类型与轨道类型分派滤镜链：

| 能力 | FFmpeg 实现 | 备注 |
|---|---|---|
| 文本标题 | `drawtext`（`fontfile`/`text`/`fontcolor`/`fontsize`/`x`/`y`/`alpha`） | 动画用 `enable` + `t` 表达式或分段 |
| 字幕 | `subtitles=filename.srt/.ass` 滤镜 | 支持烧录；也可保留为软字幕流（导出 mp4 不保留，故默认烧录） |
| 音频音量 | `volume=eval=frame` + 关键帧段 / `afade` | 淡入淡出用 `afade` |
| 转场 | `xfade=transition=...:duration=...:offset=...` | 两 clip 间；不支持的回退 `fade` |
| 滤镜/特效 | 各 clip 的 `effects` 串成 `filter_complex` 节点 | gblur/vignette/boxblur 等 |
| 调色 | `eq`(亮度/对比/饱和) + `colorbalance` + `lut3d`(LUT) + `unsharp`(锐化) | 画质增强走 unsharp |
| 蒙版 | `mask`/`overlay` 或 `chromakey`/`alphaextract` | 线性渐变用 `gradients`/叠加 |
| 关键帧动画 | 对支持表达式的滤镜用 `t` 驱动；不支持的按关键帧切片 + `zoompan` | FFmpeg 关键帧为"近似"，Phase 2 用分段实现 |

**渲染顺序（filter_complex 拓扑）**：
1. 每轨每 clip → 裁剪(`trim`/`atrim`) → 缩放适配画布(`scale`+`pad`) → 应用本 clip 滤镜/调色/蒙版/关键帧 → 文本叠加(`drawtext`) → 输出 `[vN]`/`[aN]`。
2. 同轨 clip 用 `concat`（视频）/ 转场节点（`xfade`）串联。
3. `subtitles` 烧录在合成后整轨统一叠加（或逐 clip 烧录）。
4. 多轨 `overlay` 合成 → `[vout]`；音频 `amix` → `[aout]`。

**编码器**：沿用 Phase 1 的 `videoEncoderCandidates()` 运行时回退（NVENC→libx264→hevc→mpeg4）；新增加 `libx264` 默认 `-crf 20 -preset medium` 高质量档。

---

## 3. 桌面端可用化（`packages/ui` + `apps/desktop`）

### 3.1 布局（沿用 4 面板，Phase 2 做实）
```
┌─────────┬───────────────────────┬──────────┐
│ 素材库   │      预览 (抽帧)        │  属性面板  │
│ (导入)   │   playhead / 播放控制   │ (上下文感知)│
├─────────┴───────────────────────┴──────────┤
│            时间线 (多轨 / 拖拽 / 缩放)        │
└─────────────────────────────────────────────┘
```

### 3.2 时间线
- 多轨行（视频/音频/文本/字幕），clip 块可拖拽移动、拖边缘裁剪。
- playhead 拖动 → 触发引擎抽帧预览（FFmpeg 抽当前时间码的一帧 PNG 显示在中央）。
- 轨道增删、缩放（时间轴 px/秒）。

### 3.3 属性面板（上下文感知）
- 选中视频 clip → 变换/特效/调色/蒙版/关键帧编辑器。
- 选中文本 clip → 文本编辑器（内容/字体/颜色/动画）。
- 选中音频 clip → 音量/淡入淡出/关键帧。
- 选中字幕 → 文本与时间码。

### 3.4 导入/导出
- 导入：文件对话框 → 拷贝/转码到 `assets/` → 建 `Asset` + 拖入轨道建 `Clip`。
- 导出：调用 IPC `aicut:render`（复用 CLI 同引擎），显示进度。

### 3.5 预览策略（Phase 2 兜底）
- **抽帧预览**：playhead 变动时引擎抽一帧（低分辨率 proxy）显示；不追求实时播放。
- WebGPU 连续播放留 Phase 4。

---

## 4. AI 驱动层扩展（`apps/mcp-server`）

把 Phase 1 占位的工具做成真实实现（命令总线已支持，引擎需先支持对应能力）：

| 工具 | 行为 |
|---|---|
| `add_text` | 在指定轨/时间加 TextClip |
| `add_subtitle` | 由 `.srt/.ass` 导入，或（Phase 3）由 Provider 生成 |
| `apply_effect` | 给 clip 加 Effect（滤镜/特效） |
| `add_transition` | 在两 clip 间加 Transition |
| `add_music` | 导入音频资产并加到音频轨（支持淡入淡出） |
| `set_audio_volume` | 设音量/关键帧 |
| `apply_colorgrade` | 设 clip 调色参数 / LUT |
| `add_keyframe` | 给属性加关键帧 |
| `tts` | （Phase 3 接 Provider；Phase 2 留接口，返回提示） |

**Provider 抽象（为 Phase 3 铺路）**：定义 `AIProvider` 接口（字幕识别、TTS、配乐推荐、智能包装），Phase 2 提供 `rule-based` 内置实现 + `cloud`（用户自配密钥）的空壳，真正模型接入放 Phase 3。

---

## 5. 实现里程碑（建议提交顺序）

1. **M1 数据模型 + 引擎文本/字幕**：schema 扩展 + drawtext/subtitles 渲染 + add_text/add_subtitle MCP。
2. **M2 音频增强**：音量/淡入淡出/关键帧 + add_music/set_audio_volume + 音频属性面板。
3. **M3 特效/转场/蒙版**：effects/transitions/mask + apply_effect/add_transition + 滤镜库。
4. **M4 调色/画质**：colorGrade + apply_colorgrade + 调色面板。
5. **M5 关键帧系统**：关键帧 UI + 引擎分段动画。
6. **M6 桌面 UI 做实**：时间线拖拽/预览抽帧/导入导出/属性面板全接引擎。
7. **M7 端到端验证**：4 种长宽比 × 1080/4K 渲染回归 + MCP 全流程冒烟。

每个 M 完成后跑 `tsc --noEmit` + 对应渲染/冒烟测试，保持 Phase 1 的"可验证交付"节奏。

---

## 6. 风险与取舍

- **FFmpeg 关键帧动画是近似**：用分段+表达式实现，复杂曲线不平滑 → 接受 Phase 2 简化，Phase 4 可换 Rust/WebGPU 精确时间轴。
- **美颜/超分非纯 FFmpeg 强项**：标记 Phase 3 外部 Provider，Phase 2 不实现。
- **抽帧预览非实时**：Phase 2 用户体验弱于剪映实时预览；Phase 4 上 WebGPU。
- **drawtext 依赖系统字体**：Windows 打包需随附字体或指定 `fontfile`，安装脚本需处理。

---

## 7. 审核要点（请确认）

1. 数据模型扩展是否符合你对"对齐剪映"的预期（文本/字幕/音频/特效/转场/调色/蒙版/关键帧）。
2. 预览用"抽帧"兜底（非实时）是否可接受（实时放 Phase 4）。
3. 实现顺序 M1→M7 是否认可，或要调整优先级。
4. MCP 工具清单是否覆盖你要的 AI 成片能力。
