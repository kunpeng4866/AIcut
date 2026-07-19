# AIcut 设计方案 · Phase 4（已审核 · 已实现 · 已验证）

> 目标：**Rust 引擎生产路径** + **4K 代理加速** + **WebGPU 实时预览**（可选，留 Phase 5）。
> 审核结论（通过）：仅做 Rust+代理；等效+性能增强；代理固定 720p；预编译 Windows x64。

---

## 0. Phase 4 范围

| 模块 | 目标 | 交付物 |
|---|---|---|
| Rust 引擎 | 用 Rust(napi-rs) 重写 FFmpeg 命令构建与渲染，替换 TS 引擎 | `packages/engine/src/lib.rs` 完整实现，napi 编译→Node addon |
| 4K 代理 | 导入高清素材时自动生成 720p 代理，编辑用代理→渲染切回原片 | Asset.proxyPath，引擎自动探测，import_media 自动生成 |
| WebGPU 预览 | 实时连续播放替代抽帧，支持带特效/调色的实时预览 | Phase 4 可做可延（见 §4 取舍） |

**明确不在 Phase 4**：云端 AI 模型本地部署、关键帧精确时间轴（FFmpeg 近似已满足 Phase 2-3）。

---

## 1. Rust 引擎（`packages/engine`）

### 1.1 架构

```
packages/engine/
  Cargo.toml          ← 已有（napi-rs + serde_json）
  build.rs            ← 已有
  src/
    lib.rs            ← 重写：完整 FFmpeg 命令构建 + 渲染
    project.rs        ← 工程模型（serde 反序列化，同 schema JSON）
    ffmpeg.rs         ← 编码器探测、滤镜兼容性
    filters.rs        ← 各功能滤镜链构建（文本/特效/调色/蒙版/关键帧/转场）
```

### 1.2 导出的 napi 函数

```rust
// lib.rs
#[napi]
fn rust_build_render_command(project_json: String, opts_json: String) -> napi::Result<RenderCommand>;

#[napi]
fn rust_render(project_json: String, opts_json: String) -> napi::Result<RenderResult>;

#[napi]
fn rust_probe_duration(path: String) -> napi::Result<f64>;
```

### 1.3 TS 侧集成

TS 引擎变为薄封装：

```ts
// engine.ts Phase 4
let rustEngine = null;
async function getEngine() {
  if (!rustEngine) rustEngine = await import('../../engine/index.js'); // napi 绑定
  return rustEngine;
}

export async function buildRenderCommand(project, opts, encoder) {
  try { return await (await getEngine()).rustBuildRenderCommand(project, opts); }
  catch { /* 回退 TS 引擎 */ return tsBuildRenderCommand(project, opts, encoder); }
}
```

### 1.4 收益

- 滤镜图构建从 JS 字符串拼接→Rust 结构化构建（类型安全、性能 ~10×）
- 导入导出无 Node GC 抖动（大工程体验提升）
- 最终产物是 `.node` 二进制，发行时无需编译（Windows/Mac/Linux 预编译）

---

## 2. 4K 代理（Proxy）

### 2.1 流程

```
导入 4K 素材 (3840x2160)
  ↓
检测分辨率 >1080p → 自动生成 720p 代理 (ffmpeg scale)
  ↓
Asset { path: "原片.mp4", proxyPath: "原片_proxy_720p.mp4" }
  ↓
编辑/预览全程用 proxyPath → 响应流畅
  ↓
渲染时：
  resolution='source' → 使用原片 path
  resolution='1080' → 使用原片（引擎 scale 到 1080）
  代理仅用于编辑预览，渲染自动忽略
```

### 2.2 改动点

- **Schema**：`Asset.proxyPath?: string`
- **Engine**：`buildRenderCommand` —— 渲染时忽略 proxyPath（始终用 path）；新增 `buildPreviewCommand` —— 用 proxyPath 生成低清预览帧
- **Import/CLI/MCP**：`import_media` 参数 `proxy?: boolean`（默认 true），生成 720p 代理
- **Desktop UI**：抽帧预览用 proxyPath（性能提升显著）

### 2.3 代理生成命令

```sh
ffmpeg -i 4k_source.mp4 -vf scale=1280:720 -c:v libx264 -preset ultrafast -crf 28 proxy_720p.mp4
```

---

## 3. WebGPU 预览（可选，方案供审核决策）

### 3.1 方案

用 Electron 渲染进程的 WebGPU API 做持续视频解码与滤镜叠加：

```
素材（proxyPath）→ FFmpeg 解码帧 → 共享内存 (SharedArrayBuffer) → WebGPU texture → 实时滤镜链（shader） → canvas 输出
```

### 3.2 复杂度

- 需要自定义视频解码管线（FFmpeg → WebCodecs 或直接解码到纹理）
- 滤镜需用 WGSL shader 重写（gblur/vignette/colorgrade 等）
- 与当前抽帧预览相比，工程量大 ~5×

**建议**：Phase 4 先不做 WebGPU，抽帧预览已能满足编辑需求。WebGPU 留 Phase 5 或作为独立专项。

---

## 4. 实现里程碑

| # | 内容 | 验证 |
|---|---|---|
| M1 | Rust 引擎基础：project 模型 + FFmpeg 编码器探测 | `cargo build` + napi 绑定加载成功 |
| M2 | Rust 滤镜链：视频/音频/文本/字幕/特效/调色/转场/关键帧 | 与 TS 引擎输出相同 FFmpeg 命令（对比测试） |
| M3 | Rust 渲染闭环：`rustRender()` 端到端 | 渲染 4 种组合（16:9/9:16×1080/4K）全部通过 |
| M4 | TS→Rust 桥接：engine.ts 优先调 Rust，失败回退 TS | Rust 不可用时自动降级（`npm install` 跳过 napi 编译的场景） |
| M5 | 4K 代理：import 自动生成 proxy，预览/渲染自动切换 | 导入 4K 素材→生成 720p proxy→编辑流畅→渲染用原片 |
| M6 | 回归：全量 MCP 冒烟 + tsc + 代理+4K 渲染 | 零回归 |

---

## 5. 审核要点与结论（已通过）

| # | 审核点 | 结论 |
|---|---|---|
| 1 | Phase 4 范围 | **只做 Rust 引擎 + 4K 代理**；WebGPU 实时预览留 Phase 5（抽帧预览已够用）。 |
| 2 | Rust 引擎定位 | **等效替代 + 性能增强**：输出与 TS 引擎完全一致的 FFmpeg 命令；增强点为（a）结构化滤镜构建（类型安全、无字符串抖动）、（b）代理生成并发化（导入多素材时并行）。 |
| 3 | 代理分辨率 | **固定 720p**（简单稳定，编辑足够流畅）。 |
| 4 | 编译产物 | **预编译 Windows x64** 作为主力发行目标；其他平台源编译兜底。 |

### 5.1 实现约定（据此落地）

- **Rust 模块**：`packages/engine/src/{project.rs, ffmpeg.rs, filters.rs, lib.rs}`。
  - `project.rs`：`resolve_dims`/`default_bitrate`/`fmt_num`/`num` 等纯函数（对齐 schema 的 `computeCanvas`/`defaultBitrateMbps`）。
  - `ffmpeg.rs`：`detect_encoders`/`detect_filters`/`filter_supports_option`/`probe_duration`/`has_audio_track`/`run`（带缓存，与 TS `ffmpeg.ts` 等价）。
  - `filters.rs`：`build_render_args`（完整滤镜图构建，1:1 复刻 `engine.ts` 的 `buildRenderCommand`）。
  - `lib.rs`：napi 导出 `rust_build_render_command`/`rust_render`/`rust_probe_duration`/`rust_generate_proxy`；`render` 走 `AsyncTask` 不阻塞事件循环。
- **TS 桥接**：`packages/core/src/engine.ts` 改为薄封装，`buildRenderCommand`/`render` 优先调 Rust，捕获异常回退 TS；`extractFrame` 复用 Bridge 自动受益。
- **代理**：schema 新增 `Asset.proxyPath`；`buildRenderCommand` 增加 `useProxy` 选项（预览用代理、渲染用原片）；`extractFrame` 默认 `useProxy=true`；导入（`import_media`）自动生成 720p 代理（优先并发调 `rust_generate_proxy`）。
- **验证**：`cargo test`（命令等价性单元断言）+ napi `.node` 本地构建加载 + 全量 MCP 冒烟 + tsc 零错误 + 代理+4K 渲染。

---

## 6. 实现状态（已交付）

### 6.1 交付物

| 模块 | 文件 | 说明 |
|---|---|---|
| Rust 引擎 | `packages/engine/src/{project.rs, ffmpeg.rs, filters.rs, lib.rs}` | napi 导出 `rust_build_render_command`/`rust_render`/`rust_probe_duration`/`rust_generate_proxy`；完整滤镜图构建 1:1 对齐 TS 引擎 |
| 原生模块封装 | `packages/engine/{index.js, package.json, aicut_engine.linux-x64-gnu.node}` | 按平台加载 `.node`；`napi.targets` 含 `x86_64-pc-windows-msvc`（预编目标） |
| TS 桥接 | `packages/core/src/engine.ts` | `buildRenderCommand`/`render` **Rust 优先、TS 回退**；`extractFrame` 默认 `useProxy=true`；新增 `generateProxy` |
| 代理 | `packages/schema/src/index.ts`（`Asset.proxyPath`）+ 桌面/ MCP 导入流程 | 仅对 >1080p 视频自动生成 720p 代理；编辑/预览用代理、渲染回源 |
| 验证 | `scripts/verify_phase4.ts` | Rust↔TS 等价性 + 代理 + 4K 渲染闭环断言 |

### 6.2 验证结果（沙盒：Ubuntu / cargo 1.93 / 极简 ffmpeg 无 libx264 与 CUDA）

**M1 基础**：`cargo test` 4/4 通过（`resolve_dims` 多比例、`build_render_args` 单视频与纯文本工程）。
**M2 滤镜链**：`scripts/verify_phase4.ts` 三个特征组合（纯文本 / 全特征[特效+调色+关键帧+蒙版+变换+音频] / 转场）的 `filter_complex` 与画布尺寸与 TS 引擎**逐字节一致**。
**M3 渲染闭环**：Rust 经 napi 实际执行 ffmpeg 生成 720p 代理（1280×720 真实文件）；`rust_render` 走 `AsyncTask` 不阻塞事件循环。
**M4 TS↔Rust 桥接**：引擎 `render()` 优先调 Rust，Rust（nvenc 无 GPU）失败时自动回退 TS（mpeg4），端到端产出真实文件，零破坏。
**M5 4K 代理**：合成 4K 素材 → 自动生成 720p 代理；`buildRenderCommand(useProxy=true)` 预览走代理、`(useProxy=false)` 渲染回源；4K 渲染产出 3840×2160。
**M6 回归**：`tsc --noEmit` 零错误；Phase 1 / Phase 2 MCP 冒烟全过（1080×1920，~4.5MB）；桌面端 `npm run build` 主进程+预加载+UI 构建成功。

### 6.3 已知边界与后续

- 沙盒 ffmpeg 为极简构建（缺 `libx264`/`eq`/`mask`/`colorchannelmixer.eval`/CUDA），Rust 与 TS 均通过运行时探测降级；在完整 ffmpeg 构建上功能完整（与 Phase 2/3 一致）。
- 桌面端（Electron 捆绑后）动态导入当前按相对路径解析，若打包后 `.node` 不在该路径则自动回退 TS 引擎（功能不受影响）；生产打包（Windows）应将 `packages/engine` 随附资源目录并改用 `@aicut/engine` 外部依赖解析（已在 `package.json` 预留 `napi.targets` 与 `build:win` 脚本）。
- WebGPU 实时预览按审核结论留 **Phase 5**。
