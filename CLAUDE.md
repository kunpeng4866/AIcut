# CLAUDE.md — AIcut 架构摘要

> **每次新会话先读此文件（前 80 行 = 全局视图）。不要读源文件全文。**

## 项目概况

| 项 | 值 |
|----|-----|
| 名称 | AIcut（智能视频剪辑工具） |
| 定位 | 类剪映的视频编辑器，WebGPU 合成 + FFmpeg 渲染管线 |
| 技术栈 | **Rust (N-API)** + TypeScript (Node.js) |
| 架构 | monorepo: `packages/engine`（TS 调用层）+ `src/`（Rust native）+ `docs/` |
| Phase | **Phase 4**：将 TS 引擎核心迁移为 Rust N-API 原生模块 |
| Rust 工具链 | cargo 1.93, napi-rs, target: x86_64-pc-windows-msvc |

## 模块地图

```
AIcut/
├── Cargo.toml              # napi-rs 项目配置
├── build.rs                # napi-rs 构建脚本 [子任务A]
├── src/
│   ├── lib.rs              # N-API 导出入口 [✅已生成/待重建]
│   ├── project.rs          # 数据模型 [✅已生成/待重建]
│   ├── ffmpeg.rs           # FFmpeg 命令构建 [✅已生成/待重建]
│   └── filters.rs          # 滤镜系统(最大) [✅已生成/待重建]
├── packages/engine/
│   ├── src/index.ts        # TS 桥接层 [子任务B]
│   └── package.json
├── docs/
│   ├── Phase4_进度.md      # 已完成模块的详细接口规格
│   ├── Phase4_子任务拆分.md # 子任务 I/O/完成标准
│   ├── Phase[2-5]_草案.md  # 各阶段设计方案
│   └── deepseek剪映1.txt   # VClip 完整设计文档（原始规格）
└── CLAUDE.md               # ← 本文件
```

## 核心数据流

```
用户操作 → TS Project JSON
         ↓ napi_export_render()
    Rust project.rs (解析+验证)
         ↓
    Rust filters.rs (构建 FilterGraph)
         ↓
    Rust ffmpeg.rs (序列化为 FFmpeg 命令)
         ↓
    返回命令字符串 → Node.js 执行 ffmpeg → 输出视频文件
```

## 关键常量与接口

### computeCanvas / ASPECT_PRESETS

```rust
// src/project.rs — 画布尺寸计算
const ASPECT_PRESETS: &[(&str, u32, u32)] = &[
    ("16:9",  1920, 1080),  // 横屏（默认）
    ("9:16",  1080, 1920),  // 竖屏（抖音）
    ("1:1",   1080, 1080),  // 方形
    ("4:3",   1440, 1080),  // 传统
    ("21:9",  2560, 1080),  // 超宽
];

fn compute_canvas(aspect: &str, base_height: u32) -> (u32, u32) {
    // 根据 aspect 查表，按 base_height 缩放
}
```

### defaultBitrateMbps

```rust
// src/ffmpeg.rs — 导出码率
const DEFAULT_BITRATE_MBPS: f64 = 8.0;  // 1080p30 默认
// 4K → 25 Mbps, 720p → 5 Mbps（按分辨率阶梯）
```

### 核心 N-API 导出签名

```rust
#[napi]
fn render(project_json: String) -> Result<String> { /* → FFmpeg command line */ }

#[napi]
fn get_preset_list() -> Vec<String> { /* → 可用滤镜预设名 */ }

#[napi]
fn get_version() -> String { /* → "aicut-engine 0.1.0" */ }
```

### 核心数据结构速查

```rust
struct Project { version, canvas: CanvasConfig, assets: Vec<Asset>, tracks: Vec<Track> }
struct Asset { id, type, path, duration, width, height, codec }
struct Track { id, type: TrackType, order, clips: Vec<Clip> }
struct Clip { asset_id, src_range: Range<f64>, timeline_in/out: f64,
             transform: Transform, volume: f64, speed: f64,
             effects: Vec<Effect>, masks: Vec<Mask>, filters: Vec<FilterInstance>,
             keyframes: HashMap<String, KeyframeTrack> }
struct Transform { x, y, scale_x, scale_y, rotation, opacity } // 归一化 0-1
struct RenderCommand { inputs, filter_graph: String, output_codec, crf, resolution, fps, bitrate }
struct FilterChain { nodes: Vec<FilterNode> }
enum FilterType { ColorAdjust, CropRotate, Speed, Mask, Transition, TextOverlay, ... }
```

## FFmpeg 滤镜探测降级机制

**问题**: 沙盒环境可能缺少某些滤镜（eq/mask/format）
**方案**: 启动时探测，运行时降级

```rust
// src/ffmpeg.rs — 探测 + 降级
static FILTER_AVAILABILITY: OnceLock<HashSet<&str>> = OnceLock::new();

fn probe_filters() -> HashSet<&str> {
    // 执行 ffmpeg -filters 解析输出
    // 检查 eq, mask, format, overlay, scale 等
}

fn degrade_filter(name: &str) -> Option<&'static str> {
    match name {
        "eq" if !available("eq")     => Some("brightness=0:contrast=1"),  // 退化版
        "mask" if !available("mask") => None,                              // 跳过
        "format"                      => Some("format=yuv420p"),            // 强制
        _ => Some(name),
    }
}
```

**可用性缓存**: `OnceLock` 保证只探测一次。

## TS ↔ Rust 映射关系

| TS 文件 | Rust 文件 | 关键映射 |
|---------|----------|---------|
| `project.ts` | `src/project.rs` | class Project → struct Project, getters → pub fn |
| `engine.ts` | `src/lib.rs` | 主入口 renderProject() → napi_export_render() |
| `ffmpeg.ts` | `src/ffmpeg.ts` | buildFFmpegCommand() → RenderCommand::to_command_line() |
| (内联滤镜逻辑) | `src/filters.rs` | 分散在各处 → 统一到 FilterGraphBuilder |

## 当前状态（2026-07-19）

- **Phase 4 四模块已设计完成但源码需重建**（原会话上下文爆仓丢失）
- 详细接口规格见 `docs/Phase4_进度.md`
- 下一步：按 `docs/Phase4_子任务拆分.md` 的 A/B/C 子任务顺序执行

## 开发规范

1. **读文件前先读 CLAUDE.md** — 用本文件的摘要代替全量读取
2. **单次代码生成 ≤ 600 行** — 避免再次爆仓
3. **每完成一个文件立即 Write/Edit** — 不要攒到一起
4. **编译优先** — 写完一个模块就 cargo check
5. **错误处理统一** — 用 `anyhow::Result` + `thiserror` 自定义错误类型
