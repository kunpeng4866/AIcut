# AIcut 设计方案 · Phase 3（已审核 · 已实现 · 已验证）

> 基于 Phase 2 交付成果。目标：**AI 自动化工作流**——让 Agent 和用户都能通过 AI 能力完成图文成片、批量口播、智能包装等场景。

---

## 0. Phase 3 范围

| 模块 | 目标 | 交付物 |
|---|---|---|
| AI Provider 架构 | 统一 AI 能力接入层，内置/云端可切换 | `AIProvider` 接口 + 注册表 + 内置规则实现 + 云端模板 |
| TTS | 文本→音频，供 Agent 自动配音 | `tts` MCP 工具真实实现 + espeak-ng 本地 + Azure/OpenAI 云端模板 |
| 字幕识别 | 音频→文本+时间码（ASR） | `auto_subtitle` MCP 工具 + ffmpeg silence 分段 + Whisper 云端模板 |
| 智能配乐 | 按场景/情绪推荐音乐 | `smart_music` 工具 + 内置规则库 + 云端推荐模板 |
| 一键工作流 | 图文成片 / 批量口播 | `text_to_video` / `batch_dub` MCP 工具（编排现有能力） |

**明确不在 Phase 3（留 Phase 4）**：本地 Whisper 模型部署（需 GPU/大型依赖）、WebGPU 实时预览、Rust 引擎。

---

## 1. AI Provider 架构

### 1.1 接口定义

```ts
interface AIProvider {
  id: string;                         // 'local' | 'openai' | 'azure'
  // TTS：文本 → 音频文件路径
  tts(text: string, opts?: { voice?: string; speed?: number }): Promise<string>;
  // ASR：音频路径 → 字幕片段列表
  transcribe(audioPath: string, opts?: { lang?: string }): Promise<SubtitleEntry[]>;
  // 配乐推荐：场景/情绪 → 推荐曲目列表
  recommendMusic(mood: string, duration?: number): Promise<string[]>;
}

interface SubtitleEntry { text: string; start: number; end: number; }
```

### 1.2 Provider 注册与切换

- 全局 `AIProviderRegistry`：注册多个 provider，按优先级递减尝试。
- 环境变量 `AICUT_AI_PROVIDER=local|azure|openai` 选择。
- 云端 provider 依赖用户配置的 API key（`AICUT_OPENAI_KEY` 等环境变量或配置文件）。

### 1.3 内置 Provider（`local`）

- **TTS**：`espeak-ng`（跨平台文本→语音合成，轻量，支持中英文）。生成 wav，转 aac 后入工程音频轨。
- **ASR**：简易规则版——用 ffmpeg `silencedetect` 做音频分句，为每句生成空白字幕占位（Agent 可后续填入文字）。不做真实识别（需 Whisper），但分段时间码已准。
- **配乐**：内置情绪-风格映射表（欢快→upbeat, 平静→ambient, 悲伤→melancholy, 紧张→dramatic）。从用户配置的本地音乐库或内置示例中匹配。无本地库时返回空。

---

## 2. MCP 工具实现

| 工具 | 入参 | 行为 |
|---|---|---|
| `tts` | text, voice?, speed?, track? | 调用 provider.tts() 生成音频 → 导入音频轨 |
| `auto_subtitle` | clipId?, lang?, track? | 提取 clip 音轨 → provider.transcribe() → 生成字幕片段写入字幕轨 |
| `smart_music` | mood, duration?, track? | provider.recommendMusic() → 导入匹配的音频到音频轨（淡入淡出） |
| `text_to_video` | text, aspectRatio?, resolution? | 拆段→每段 TTS 配音 + 标题文字 → 组装工程（图片底片 + 文字 + TTS 音频），渲染 |
| `batch_dub` | clips: {text, voice?, speed?}[] | 逐段 TTS → 合成口播音频轨 |

---

## 3. 工作流详解

### 3.1 图文成片 `text_to_video`

输入：一段 Markdown/纯文本 → 输出完整工程并渲染。

步骤：
1. 文本拆段（按段落/句号，每段≤30 字）。
2. 每段：生成纯色底片（color）→ 叠加该段文字（drawtext）→ 调用 TTS 生成配音（add_music）。
3. 组装时序：段间加转场（fade）。
4. 渲染导出。

### 3.2 批量口播 `batch_dub`

输入：一批文本片段 + 配音参数 → 输出音频轨。

步骤：
1. 逐段调 TTS，产物为独立音频文件。
2. 按顺序拼接到一条音频轨，段间加 0.5s 静音间隔。
3. 可选合成到现有工程音轨或导出纯音频。

---

## 4. 实现计划

1. **AIProvider 接口 + 注册表**（`packages/core/src/ai-provider.ts`）。
2. **内置 local provider**：TTS（espeak-ng）+ ASR（silencedetect）+ 配乐规则表。
3. **云端 provider 模板**（OpenAI TTS/Whisper, Azure Speech），代码+文档。
4. **MCP 工具实现**：`tts`, `auto_subtitle`, `smart_music`, `text_to_video`, `batch_dub`。
5. **端到端验证**：text_to_video 一句话 → 生成完整工程 → 渲染导出。

---

## 5. 审核要点

1. Provider 架构（内置+云端可切换）是否认可？
2. 内置 TTS 用 espeak-ng（轻量、跨平台、中英文）是否可接受？或期望直接接云端？
3. Phase 3 是否就做这 5 个 MCP 工具，其他延后？
4. `text_to_video` 是否当前重点（图文成片是剪映核心 AI 卖点）？
