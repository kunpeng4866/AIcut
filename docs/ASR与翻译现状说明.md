# AIcut 语音转文字（ASR）与翻译 现状说明

> 目的：把当前实现现状、数据流、以及三个未解决问题整理清楚，供后续接手修复使用。
> 更新日期：2026-08-20

## 一、两套功能与链路

项目里有两个独立的「字幕」入口，勿混淆：

1. **语音转文字（ASR）**：音频/视频 → 文字。走本地 ASR，当前用 **百炼 qwen3 omni**。
2. **翻译**：文字 → 目标语言（英/中为主）。走 **DeepSeek LLM**。

### ASR 链路（端到端）

```
TextPanel.handleAsr
  → aiStore.transcribe(audioPath, lang)
  → window.aicut.asr.transcribe  (preload)
  → ipcRenderer.invoke('asr:transcribe')
  → main.ts handler → callEngine('asr','transcribe',...)
  → aicut-engine.exe 子命令 "asr transcribe"
  → src/provider.rs  BailianAsrProvider::transcribe
  → python/asr/bridge.py  (qwen3 omni 实时 WebSocket)
  → 返回 { text, segments: [{start,end,text}] }
  → aiStore 存到 asrResult
  → TextPanel 调 createSubtitleClipFromAsr(segments, refClip) 生成字幕片段
```

### 翻译链路（端到端）

```
TextPanel.handleTranslate（选中字幕片段）
  → aiStore.translate(texts[], targetLang)
  → window.aicut.ai.translate  (preload)
  → ipcRenderer.invoke('ai:translate')
  → main.ts handler（先 injectDeepSeekKey 把 config.ai.apiKey 注入 env DEEPSEEK_API_KEY）
  → callEngine('ai','translate', tmpfile, targetLang)
  → aicut-engine.exe 子命令 "ai translate"
  → src/ai.rs  translate_sync → DeepSeek API（curl）
  → 返回换行拼接的译文
  → createTranslatedClipFromClip(selectedClip, lines) 生成译文片段到新轨
```

## 二、关键文件清单

| 文件 | 作用 |
|------|------|
| `python/asr/bridge.py` | ASR 后端桥：`_recognize_qwen_omni` 实时识别 + 时间戳推算 |
| `src/provider.rs` | ASR 抽象：`WhisperProvider`（whisper.cpp，有词级时间戳）+ `BailianAsrProvider`（qwen3 omni，无词级时间戳） |
| `src/ai.rs` | DeepSeek LLM：`translate_sync`、`build_translate_prompt` |
| `src/main.rs` | CLI 分发：`asr transcribe` / `ai translate` 子命令 |
| `gui/electron/main.ts` | 主进程 IPC：`asr:transcribe`、`ai:translate`、`injectDeepSeekKey` |
| `gui/electron/preload.ts` | contextBridge：`window.aicut.asr.transcribe`、`window.aicut.ai.translate` |
| `gui/src/store/aiStore.ts` | 前端状态：`transcribe`、`translate`、`asrResult` |
| `gui/src/utils/clipFactories.ts` | 字幕片段工厂：`createSubtitleClipFromAsr`、`resegmentForCaptions`、`buildSubtitleClips`、`createTranslatedClipFromClip` |
| `gui/src/components/panels/TextPanel.tsx` | 文字面板 UI：ASR 按钮、翻译子模块 |
| `gui/src/components/PreviewCanvas.tsx` | 字幕渲染：`clipSourceTime` + `subtitle.items` 匹配（约 600-638 行） |

## 三、ASR 输出的数据形态（实测）

音频：`男高音张大伟.m4a`，时长 29.8s。bridge.py 返回（stdout 单行 JSON）：

```json
{
  "text": "朋友们大家好，我是男中音张大伟，今天呢我带大家体验一下我家乡的美景，来到了天桥沟国家森林公园，大家看一下，这都是纯天然的景色。我想送给他一首我的歌，微微的风，轻飘。",
  "segments": [
    { "start": 0.0, "end": 23.4, "text": "朋友们大家好，我是男中音张大伟，今天呢我带大家体验一下我家乡的美景，来到了天桥沟国家森林公园，大家看一下，这都是纯天然的景色。" },
    { "start": 23.4, "end": 29.5, "text": "我想送给他一首我的歌，微微的风，轻飘。" }
  ]
}
```

### ★ 关键事实：qwen3 omni 没有原生时间戳

- qwen3 omni 的 `conversation.item.input_audio_transcription.completed` 事件**只给最终文本，不给时间戳**。
- bridge.py `_emit_segment` 用「已推送音频字节数」推算每句起止：
  ```python
  end   = min(state["bytes_sent"] / 32000.0, duration)   # 32000 字节/秒
  start = state["last_end"]                              # 上一句的 end
  ```
- 因此 segments 只有**句子级（VAD turn）边界**，且边界有延迟误差（`completed` 事件滞后于音频推送，`bytes_sent` 已推进到更后面）。
- **没有词级/短语级时间戳**，无法精确切分子句——这是「文字片段与音频不对应」的根本原因。

### ★ 可选的 word-timestamp 方案

`src/provider.rs` 里还有 `WhisperProvider`（whisper.cpp 本地引擎 `whisper-cli.exe` + `ggml-*.bin`），`-oj` 输出结构是**词级**的：

```
root["transcription"] = [{ offsets:{from,to}(毫秒), text, timestamps }]
```

即 whisper.cpp 能给出每个词的真实起止毫秒，可据此精确切分子句。当前默认走的是 Bailian(qwen3 omni)，没有用 whisper 的时间戳。

## 四、当前字幕片段生成逻辑（clipFactories.ts）

`createSubtitleClipFromAsr(segments, refClip)`：

1. `resegmentForCaptions(segments)`：按句读标点（。！？；，、： 等）切短句 → 单句 >18 字再按字数强切 → **每段时长按字数比例分摊**（qwen3 无词级时间戳，这是「估」出来的时间）。
2. `buildSubtitleClips(lines, refClip, trackId)`：每句生成一个 clip，对齐到参考音/视频片段。

对齐数学（关键约定）：

```
relStart   = line.start - refClip.src_range.start
timelineIn = refClip.timelineIn + relStart / speed
clip.src_range = { start: relStart, end: relEnd }
clip.subtitle.items = [{ start: relStart, end: relEnd, text }]
```

即字幕 clip 的 `src_range` 与 `subtitle.items[].start/end` 都用「相对参考片段源」的 relStart/relEnd（**不是绝对时间轴**）。渲染（PreviewCanvas.clipSourceTime）和导出（subtitle.rs source_to_timeline）都依赖这个约定。

渲染匹配（PreviewCanvas.tsx ~600-638 行）：

```
const { srcT: offset } = clipSourceTime(currentTime, clip)
const item = s.items.find(i => offset >= i.start && offset < i.end)
```

## 五、翻译当前实现（clipFactories.ts / TextPanel.tsx）

- `handleTranslate`：读**当前选中的单个字幕片段**，取 `subtitle.items` 的 text 数组 → `aiStore.translate`（换行拼接 → DeepSeek 逐行翻译 → 按行拆回）→ `createTranslatedClipFromClip`。
- `createTranslatedClipFromClip(sourceClip, translatedTexts)`：**克隆选中的那一个片段**（timelineIn/Out、src_range、speed 全保留），仅替换 `subtitle.items` 文本，放到新字幕轨。

> 注意：当前**只翻译「选中的单个片段」**，不满足需求三。

## 六、三个待解决问题

### 问题 1：文字片段与音频素材不对应

- **现象**：生成的文字片段起止位置与真实语音节奏不严格对应。
- **根因**：qwen3 omni 无词级时间戳；句子边界是字节数估算；子句时长按字数比例分摊（近似，非真实语音时间）。
- **解决方向**：
  1. 换用能输出词级时间戳的 ASR（`WhisperProvider` / whisper.cpp 已具备 `offsets.from/to`），或
  2. 若必须用 qwen3 omni，改 bridge.py 从 VAD 事件（`input_audio_buffer.speech_started` / `speech_stopped`）记录更准的**句子边界**，并接受「子句内仍按字数比例分摊」的近似。

### 问题 2：开头语音丢失（"朋友们，大家好，我是男中音张大伟"）

- **已确认**：ASR 后端数据正确——debug 日志显示 `segment1 [0.00s-23.40s]` 的 text 开头就是这句完整文字。**不是转写丢的**。
- **问题出在前端片段生成/渲染环节，尚未定位到确切根因**。需排查点：
  1. `buildSubtitleClips` 的越界守卫 `if (relEnd <= 0 || relStart >= refDur) continue`——当 `refClip.src_range.start` 非 0（如片段被裁/分割过）时，首句可能被 `relEnd <= 0` 或 `relStart >= refDur` 丢掉。
  2. 字幕轨已有旧片段时，新增片段与旧片段重叠/排序问题。
  3. PreviewCanvas 对 `timelineIn=0` 或首片段的渲染是否有 off-by-one 或首帧不显示。
- **建议排查方法**：转写后打印 `createSubtitleClipFromAsr` 内部 `lines` 与最终 clip 的 `timelineIn/timelineOut/src_range/items`，确认首句 clip 是否被 `addClip` 或 `buildSubtitleClips` 丢弃；再在 PreviewCanvas 里打断点确认 `clipSourceTime` 在 0~2.5s 是否匹配到首句 item。

### 问题 3：翻译需求（选中任意片段 = 翻译整个字幕，一一对应）

- **需求**：用户在字幕轨选中**任意一个片段**，即代表要翻译**整条字幕（该字幕轨所有片段）**；译文与原文**一一对应**（数量、顺序、时间一致），放到**新字幕轨**。
- **现状**：`handleTranslate` + `createTranslatedClipFromClip` 只翻译**选中的单个片段**。
- **需改**：选中任意片段后，收集该字幕轨（或全部字幕轨）的所有片段，按时间轴顺序取每个片段的 text，批量翻译，再**逐片段克隆替换文本**（保持 timelineIn/Out、src_range、speed 不变），译文按 1:1 顺序落到新轨。

## 七、关键坑 / 注意事项

1. **改 electron 主进程/preload 后必须重新编译**：`cd gui && npx tsc -p tsconfig.electron.json`（生成 `dist-electron/preload.js`、`main.js`）。否则运行中的 Electron 仍加载旧 preload，会报 `window.aicut.ai.translate is not a function`。改 renderer 后 `npx vite build`，改 Rust 后 `cargo build --offline`。改完务必**彻底退出 Electron 重开**（不要热重载）。
2. **DeepSeek key 注入**：main.ts 在 `ai:translate` / `ai:generateSubtitles` 前调 `injectDeepSeekKey()`，把 `config.ai.apiKey` 写入 `process.env.DEEPSEEK_API_KEY`；engine 侧 `src/ai.rs::api_key()` 读该环境变量。
3. **密钥勿泄露**：ASR key 在 `config.json` 与 `.env`，DeepSeek key 在 `config.json`——不要写进代码/日志/提交。
4. **字幕时间戳约定**：`src_range` 与 `subtitle.items[].start/end` 都是相对参考片段源的 relStart/relEnd，非绝对时间轴；改任何一边都要同步改渲染（PreviewCanvas）与导出（subtitle.rs），否则字幕会错位。
5. **两套「字幕」别混**：`AIPanel.tsx`（AI 自动字幕/脚本，走 DeepSeek 的 `generateSubtitles`）与 `TextPanel.tsx`（ASR 语音转文字）是两条独立链路，改 ASR 时不要碰 AIPanel。
