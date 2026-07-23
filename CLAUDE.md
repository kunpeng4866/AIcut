# CLAUDE.md — AIcut 架构摘要

> **每次新会话先读此文件（前 100 行 = 全局视图）。不要读源文件全文。**

## 项目概况

| 项 | 值 |
|----|-----|
| 名称 | AIcut（智能视频剪辑工具） |
| 定位 | 类剪映的桌面视频编辑器，WebGPU 合成 + FFmpeg 渲染管线 |
| 技术栈 | **Rust**（引擎）+ **Electron 31**（桌面壳）+ **React 18 + TypeScript + Zustand**（前端）+ **WebGPU**（GPU 预览） |
| 架构 | Rust 引擎 (`src/`) + Electron 主进程 (`gui/electron/`) + React 渲染进程 (`gui/src/`) |
| Phase | **Phase 5 已完成** — 轨道管理 + 导出管线 + 多视频合成 |
| 代码规模 | Rust 7,499 行（24 文件）+ GUI 3,384 行（20 文件）= 10,883 行 |
| 测试 | 220 全绿（176 lib + 44 integration） |
| Rust 工具链 | cargo, napi-rs (条件编译 `--features napi`), target: x86_64-pc-windows-msvc |
| 项目路径 | E:\AIcut |

## 模块地图

```
AIcut/
├── Cargo.toml              # 纯 Rust lib+bin，N-API 条件编译 (--features napi)
├── build.rs                # napi-build 占位
├── src/                    # 24 模块
│   ├── lib.rs              # 公共 API + N-API 条件编译 + is_simple_project() + export_project() (342L)
│   ├── main.rs             # CLI 二进制 (render/export/probe/new/validate/presets/plugin/tts/mcp) (171L)
│   ├── project.rs          # 数据模型 + Track(locked/visible/muted/solo/is_main) + Default impl (386L)
│   ├── probe.rs            # ffprobe 封装 + JSON 解析(audio/video流 + duration字符串) (176L)
│   ├── ffmpeg.rs           # RenderCommand + 滤镜探测降级 (425L)
│   ├── filters.rs          # 滤镜定义/参数/构建 (474L)
│   ├── graph.rs            # FilterGraphBuilder + render_project_json + 快速路径 (231L)
│   ├── keyframe.rs         # 关键帧系统 (线性/贝塞尔) (149L)
│   ├── decoder.rs          # ★解码器池: 并行预取 + 帧缓存 (419L)
│   ├── compositor.rs       # ★合成器: 多轨道 Porter-Duff Over (465L)
│   ├── clock.rs            # ★播放时钟 + 帧率控制 (267L)
│   ├── timeline.rs         # ★时间轴计算 + 片段查找 (274L)
│   ├── audio_pipeline.rs   # ★音频管线: 混音/重采样/音量 (592L)
│   ├── mcp.rs              # MCP Server 骨架 (render/probe/presets/validate) (227L)
│   ├── provider.rs         # ASR + LLM 抽象 (Whisper + DeepSeek) (231L)
│   ├── subtitle.rs         # SRT/ASS 解析 + drawtext (179L)
│   ├── project_io.rs       # 工程文件读写 (117L)
│   ├── preset.rs           # 滤镜预置包 (51L)
│   ├── types.rs            # 共享类型 (66L)
│   ├── plugin.rs           # 插件系统: PluginManifest + PluginManager (295L)
│   ├── tts.rs              # 火山引擎TTS: VolcanoTtsClient + synthesize_to_file (297L)
│   └── pipeline/           # ★渲染管线
│       ├── mod.rs          # 模块导出 (21L)
│       ├── strategy.rs     # 策略选择(快速/完整) (339L)
│       ├── preview.rs      # 预览管线 (644L)
│       └── export.rs       # ★导出管线: DecoderPool+Compositor集成 (661L)
├── plugins/                # 插件目录
│   └── example_brightness/ # 示例: 亮度调节滤镜
│       └── manifest.json   # 插件清单 (id/name/parameters/filter_spec)
├── packages/engine/        # TS 桥接层
│   └── src/
│       ├── index.ts        # renderProject/getPresetList/getVersion
│       ├── plugin.ts       # PluginClient (list/buildFilter, N-API优先/CLI回退)
│       └── tts.ts          # TtsClient (synthesize, 类型与Rust对齐)
├── gui/                    # Electron + React 前端
│   ├── electron/
│   │   ├── main.ts         # 主进程 (IPC + aicut-asset协议 + FFmpeg进程管理 + 8个SSL开关)
│   │   └── preload.ts      # 安全IPC桥接 (contextBridge: engine/config/plugin/export/draft)
│   └── src/
│       ├── App.tsx         # 主布局 (Splitter可拖拽: 左面板+预览+右面板+时间轴) (130L)
│       ├── main.tsx        # React 入口 (4L)
│       ├── types.ts        # 前端类型 (TrackConfig含muted/solo/isMain, ExportOptions) (71L)
│       ├── config/         # AI配置系统
│       │   ├── ai_config.ts     # 配置类型+验证+默认值 (128L)
│       │   ├── useConfig.ts     # 配置读写Hook (105L)
│       │   ├── ConfigWizard.tsx # 4步配置向导Modal (169L)
│       │   └── AIGuard.tsx      # AI功能调用前检查 (100L)
│       ├── store/          # Zustand 状态管理
│       │   ├── projectStore.ts  # 工程/轨道/片段操作 + sortTracks + realignMainTrack (212L)
│       │   ├── uiStore.ts       # 选中/播放/缩放/双吸附开关/面板尺寸 (77L)
│       │   ├── configStore.ts   # 配置状态 (52L)
│       │   └── historyStore.ts  # 撤销/重做 (56L)
│       ├── hooks/
│       │   └── useWaveform.ts   # ★Web Audio API 音频波形解码 (80L)
│       └── components/
│           ├── Header.tsx         # 菜单栏 (新建/打开/保存/导出/AI配置) (128L)
│           ├── MediaPanel.tsx     # 素材导入面板 (148L)
│           ├── PreviewCanvas.tsx  # ★预览画布 (WebGPU多pass + HTML5回退 + RAF时钟 + 音频轨) (354L)
│           ├── WebGPUPreview.tsx  # ★WebGPU预览: 多pass Over合成, MAX_CLIPS=4 (278L)
│           ├── Timeline.tsx       # ★时间轴 (双吸附/跨轨拖拽/轨道控制/波形) (622L)
│           ├── PropertiesPanel.tsx # 属性面板 (变换/滤镜/特效/音频/关键帧) (323L)
│           ├── ExportDialog.tsx   # ★导出对话框 (分辨率/格式/质量/进度) (295L)
│           └── Splitter.tsx       # ★可拖拽分隔条 (horizontal/vertical) (51L)
├── tests/integration_test.rs  # 44 场景全过
├── docs/                    # 文档
│   ├── 调研报告/            # R1-R5 调研产出
│   ├── AIcut进一步开发设计报告.md  # Phase 4.5-8 路线图
│   └── ...
├── 开发进展报告.md          # ★最新进展 (2025-07-22)
└── CLAUDE.md               # ← 本文件
```

## 核心数据流（三条路径）

### 1. WebGPU 预览路径（实时编辑）
```
用户操作 → React Store (projectStore) → PreviewCanvas
  → activeVideoClips (按轨道层次.reverse排序, 主轨底层)
  → WebGPUPreview: 多pass渲染 (pass0 clear, pass1-N load, Porter-Duff Over)
  → 隐藏<video>元素解码 → copyExternalImageToTexture → canvas显示
  → RAF全局时钟驱动currentTime, 不依赖video.ontimeUpdate
  → 失败自动回退HTML5 (CSS zIndex叠加所有视频轨道)
```

### 2. 快速导出路径（单视频轨道无transform）
```
export_project(json, output_path)
  → is_simple_project() 检测: 单视频轨 + 无transform → true
  → graph.rs 直接生成 FFmpeg 命令 (跳过DecoderPool/Compositor)
  → 执行 ffmpeg 单命令导出
```

### 3. 完整导出路径（多轨道合成）
```
export_project(json, output_path)
  → is_simple_project() → false
  → ExportPipeline:
    → DecoderPool (并行预取所有轨道帧)
    → Compositor (逐层解码 → Porter-Duff Over合成)
    → FFmpeg 管道编码 (stdin写入帧数据)
  → 输出视频文件
```

## 关键数据结构

### Track（轨道）— Phase 5 新增字段

```rust
// src/project.rs
struct Track {
    id: String,
    track_type: String,          // "video" | "audio" | "text"
    order: u32,
    clips: Vec<Clip>,
    locked: bool,                // ★锁定: 可播放不可编辑
    visible: bool,               // ★隐藏: 视频轨不渲染, 音频轨不影响
    muted: bool,                 // ★静音: 画面正常声音静默
    solo: bool,                  // ★独奏: 仅独奏轨有声音
    is_main: bool,               // ★主视频轨标记
}
// 实现了 Default trait, 构造时用 ..Default::default()
```

### 轨道排序规则
```
text (顶层) → video (中层, 主轨最下) → audio (底层)
由 sortTracks() 维护, addTrack() 按类型自动插入正确位置
```

### 双吸附系统
```
magneticSnap (主轨): realignMainTrack() — 片段按timelineIn排序后cursor累加左对齐
  触发: addClip/removeClip/splitClip/moveClipToTrack + 拖拽松手时 realignMainTrackAction
  拖拽中: snapTime(true, Infinity) 不受距离限制吸附到相邻边缘
  松手后: realignMainTrackAction 强制左对齐（0:00起依次排列）
clipSnap (其他轨道): snapTime() — 边缘吸附, 阈值0.05秒
  所有非主轨拖拽时参与边缘吸附
```

### 预览层次与播放
```
activeVideoClips: 按project.tracks数组顺序.reverse() (主轨底层先渲染, 上方轨顶层后渲染)
播放驱动: RAF全局时钟, 每帧按时间增量推进currentTime, 不依赖任何video.ontimeUpdate
播放结束: currentTime >= 总时长(所有轨道最长clip末尾)
音频独立: audio轨visible不影响播放, 仅muted/solo控制; video轨hidden→无声音
```

### 其他核心结构

```rust
struct Project { version, canvas: CanvasConfig, assets: Vec<Asset>, tracks: Vec<Track> }
struct Asset { id, type, path, duration, width, height, codec }
struct Clip { asset_id, src_range: Range<f64>, timeline_in/out: f64,
             transform: Transform, volume: f64, speed: f64,
             effects: Vec<Effect>, masks: Vec<Mask>, filters: Vec<FilterInstance>,
             keyframes: HashMap<String, KeyframeTrack> }
struct Transform { x, y, scale_x, scale_y, rotation, opacity } // 归一化 0-1
struct RenderCommand { inputs, filter_graph: String, output_codec, crf, resolution, fps, bitrate }
```

## 自定义协议

```
aicut-asset:// 协议 — 绕过系统代理直接读本地文件
  路径解析: 从 url.hostname 恢复盘符 (Chromium把C:当hostname导致丢失)
  setProxy({ proxyRules: 'direct://' }) 禁用代理
  8个appendSwitch彻底关闭Chromium后台网络 (SSL/同步/崩溃报告等)
  registerSchemesAsPrivileged: { corsEnabled: true }
```

## 前端类型 ↔ Rust 映射

| 前端文件 | Rust 文件 | 关键映射 |
|---------|----------|---------|
| `types.ts` TrackConfig | `src/project.rs` Track | 字段对齐, TS多isMain/muted/solo |
| `projectStore.ts` | `src/project.rs` | sortTracks ↔ 轨道排序, realign ↔ 主轨排列 |
| `PreviewCanvas.tsx` | `src/pipeline/preview.rs` | WebGPU预览 ↔ 预览管线 |
| `ExportDialog.tsx` | `src/pipeline/export.rs` + `src/main.rs` | 导出UI ↔ export_project() |
| `useWaveform.ts` | — | Web Audio API解码, 无Rust依赖 |

## 当前状态（2025-07-22）

### 已完成

- **Phase 1-3 核心引擎**：24 模块，7,499 行 Rust 代码，220 测试全绿
- **Phase 4.5 渲染管线（步骤1-8）**：
  - 快速路径：`is_simple_project()` → graph.rs 直接 FFmpeg 命令
  - 完整路径：ExportPipeline 集成 DecoderPool + Compositor
  - 导出 API：`export_project()` + `aicut-engine export` 子命令
  - WebGPU 预览：多 pass Over 合成，已验证 GPU 渲染正常
- **Phase 5 里程碑**：
  - 多视频纹理合成：WebGPUPreview 多 pass 渲染 + PreviewCanvas 多 video 管理
  - 导出管线对接：ExportDialog + IPC + FFmpeg 进程管理 + 进度解析
  - 轨道管理系统：主轨 + 双吸附 + 跨轨拖拽 + 轨道间插入 + 锁定/隐藏/静音/独奏
  - 可拖拽窗口：Splitter 组件 + 3 个分隔条
  - 音频波形：useWaveform hook（Web Audio API 解码 → WaveformCanvas）
- **Electron 桌面应用**：Vite 构建成功，窗口正常，IPC 全通道

### 启动方式

```bash
# 开发模式
cd gui && npm run electron:dev
# 或
cd gui && npm run electron:start   # 已处理 ELECTRON_RUN_AS_NODE 环境变量

# 前端构建
cd gui && npx tsc --noEmit && npx vite build

# Rust 测试
cargo test --offline

# CLI 使用
aicut-engine render <project.json>          # 生成FFmpeg命令
aicut-engine export <project.json> <out.mp4> # 直接导出视频
aicut-engine probe <media_file>              # 探测媒体元数据
aicut-engine new <name> [WxH]               # 创建新工程
```

### 下一步开发优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | 文字/标题轨道 | 数据模型+编辑器+WebGPU纹理+FFmpeg drawtext |
| P0 | 滤镜与特效 UI | Rust端filters.rs已有，缺前端面板 |
| P0 | 关键帧动画 UI | Rust端keyframe.rs已有，缺前端录制/曲线编辑 |
| P0 | 撤销/重做完善 | historyStore有框架，需全面接入 |
| P1 | 字幕系统 | subtitle.rs已有解析，缺UI+语音转字幕 |
| P1 | AI 功能集成 | TTS/ASR/LLM 接口已有，缺前端调用 |
| P1 | 多轨混音器 | audio_pipeline.rs已有混音，缺混音器面板 |
| P1 | 高级时间轴 | 转场/变速/倒放/冻结帧/时间重映射 |
| P2 | 插件系统/性能优化/导出增强/工程管理 | 见开发进展报告.md |

## 开发规范

1. **读文件前先读 CLAUDE.md** — 用本文件的摘要代替全量读取
2. **单次代码生成 ≤ 600 行** — 避免上下文爆仓
3. **每完成一个文件立即 Write/Edit** — 不要攒到一起
4. **编译优先** — 写完一个模块就 `cargo check --offline` / `npx tsc --noEmit`
5. **错误处理统一** — Rust 用 `anyhow::Result` + `thiserror`；TS 用 try/catch + Result 类型
6. **调研先行** — 新功能开发前先读 `docs/调研报告/` 对应报告
7. **子代理并行** — 大任务拆分给子代理，各写文件，防主上下文爆仓。每组子代理读图≤7张
8. **对标 OpenCut** — 架构参考 github.com/BunsDev/OpenCut
9. **AI配置使用流程** — 调用AI功能前必须通过 `useAIGuard` 检查配置，未配置时引导到ConfigWizard
10. **插件开发规范** — 外部特效/滤镜/转场以 `plugins/<name>/manifest.json` 形式接入，filter_spec用FFmpeg滤镜模板（`{param}`占位符），shader用WGSL
11. **侵权规避原则** — 不复制剪映或任何商业软件的源码/UI/素材；滤镜基于FFmpeg开源滤镜；着色器自行编写用WGSL；UI功能参考但不照搬
12. **前端样式规范** — 深色主题(#1a1a2e/#16213e/#0f3460)，强调色#e94560，不引外部UI库，内联样式
13. **IPC通道规范** — 所有渲染进程↔主进程通信通过 preload.ts 的 contextBridge，命名格式 `domain:action`（如 `export:start`）
14. **★ 轨道操作规范** — Track 构造必须用 `..Default::default()`；moveClip 现在通过 `withMainTrackRealign` 检查 magneticSnap 开关决定是否 realign；所有 Store 层写操作 (addClip/removeClip/splitClip/moveClip/moveClipToTrack/updateClip) 必须检查 `track.locked` 前置守卫；锁定轨 onSelect 在 locked 检查之前允许选中查看属性，但后续编辑操作被 Store 层拦截
15. **★ WebGPU 规范** — 临时纹理 usage 必须含 `TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT`；validation error 不抛 JS 异常，需 `uncapturederror` 事件监听
16. **★ 路径处理** — `aicut-asset://` 协议路径需从 `url.hostname` 恢复盘符；`pathToUrl` 辅助函数在 Timeline.tsx 和 PreviewCanvas.tsx 各有一份
17. **★ 开发环境** — 软件装 E 盘；pip 用清华镜像；HuggingFace 用 hf-mirror.com（需设 HF_HUB_DISABLE_XET=1）；Rust 测试用 `cargo test --offline`
18. **★ 子代理任务拆分** — 不同任务（按功能/文件拆分）必须用独立子代理并行处理，避免主上下文爆仓。子代理之间不共享文件（不同任务→不同文件），每个子代理只改自己的目标文件。跨文件的同类改动可合并到一个子代理中
19. **★ 插件技能注册** — `claude plugin install` 安装后，需运行 `bash scripts/link-plugin-skills.sh` 将技能目录链接到 `~/.claude/skills/`，否则技能无法被发现（当前版本已知问题）
