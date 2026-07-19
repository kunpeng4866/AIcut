# AIcut 项目审计报告

> **日期**: 2026-07-20
> **审计覆盖**: Phase 1-5 设计方案 x 当前代码实现
> **审计文件**: 设计文档 6 份 + 源码 8 个文件 + 测试 1 个文件 + 配置 3 个文件
> **环境**: Windows (E:\AIcut), Rust CLI 二进制, N-API 延后

---

## 目录
1. [架构与设计一致性](#1-架构与设计一致性)
2. [代码质量深度评估](#2-代码质量深度评估)
3. [测试策略评估](#3-测试策略评估)
4. [工程化成熟度](#4-工程化成熟度)
5. [安全性审查](#5-安全性审查)
6. [可维护性](#6-可维护性)
7. [Phase 对比 & 路线图偏差](#7-phase-对比--路线图偏差)
8. [优先级行动清单](#8-优先级行动清单)

---

## 1. 架构与设计一致性

### 1.1 总体架构偏差

Phase 1 设计的分层架构（`Electron + React → Node.js 编排层 → Rust 引擎`）与实际实现之间存在**巨大鸿沟**：

| 设计层 | 设计方案中应有 | 实际存在 | 偏差 |
|--------|---------------|---------|------|
| GUI | `apps/desktop/` (Electron + React) | **不存在** | 无 GUI |
| AI 接口层 | `apps/mcp-server/` (MCP Server) | **不存在** | 无 MCP |
| 编排层 | `packages/core/` (命令总线/工程管理) | **不存在** | 无编排 |
| UI 组件 | `packages/ui/` (面板/时间轴/画布) | **不存在** | 无 UI |
| AI Provider | `packages/ai/` (TTS/ASR/抠像) | **不存在** | 无 AI |
| Schema | `packages/schema/` (类型/校验) | **不存在** | 无 TS Schema |
| Rust 引擎 | `packages/engine/` (napi-rs 绑定) | `src/` (纯 Rust lib+bin) | 无 N-API |
| CLI | `cli/` | `src/main.rs` (内置) | 已整合, 合理 |

**严重程度**: P0 — 当前产物仅为 Rust 引擎二进制的 20%，与设计方案中的完整架构差距巨大。

### 1.2 Rust 引擎架构对齐度

设计方案 Phase 4 §1.1 描述的 Rust 模块结构：

```
packages/engine/src/
  lib.rs      ← 重写：完整 FFmpeg 命令构建 + 渲染
  project.rs  ← 工程模型（serde 反序列化）
  ffmpeg.rs   ← 编码器探测、滤镜兼容性
  filters.rs  ← 各功能滤镜链构建
```

实际结构：
```
src/
  lib.rs      ← 纯 Rust pub fn API (27行, 极简)
  project.rs  ← 工程模型 (178行, 完整)
  ffmpeg.rs   ← RenderCommand + 滤镜探测 (218行, 完整)
  filters.rs  ← 滤镜/关键帧/预置/构建器 (1110行, 完整但臃肿)
  main.rs     ← CLI 二进制 (63行)
```

**基本对齐**, 但：
- `lib.rs` 只有 27 行，远少于设计预期的 160 行（No N-API code）
- `filters.rs` 1110 行远超设计预期的 ~957 行 — 过度膨胀
- 缺少设计中的 `build_render_args` 函数名（实际用 `build_render_command`）
- 缺少 `rust_generate_proxy` / `rust_render` / `rust_probe_duration` 这些 napi 导出

**严重程度**: P2

### 1.3 设计决策回顾

| 设计决策 | 当前状态 | 是否应重审 |
|----------|---------|-----------|
| Rust 引擎等效替代 TS 引擎 | Rust 引擎完全无 TS 对应层 | ✅ 重审 — 无 TS 可比对，是否需要 TS 参照？ |
| 代理固定 720p | 未实现代理生成逻辑 | ✅ 代理是 Phase 4 核心收益，应优先实现 |
| N-API 作为主桥接 | 被完全移除 | ✅ 网络恢复后必须恢复 |
| 预编译 Windows x64 | 无预编译流程 | ✅ 缺少发布脚本 |

---

## 2. 代码质量深度评估

### 2.1 模块边界与耦合 [P1]

```
┌─────────────────────┐
│       lib.rs        │  pub render() → filters::render_project_json()
│  (facade, 27 行)    │
└────────┬────────────┘
         │ calls
         ▼
┌─────────────────────┐      imports from      ┌─────────────────────┐
│    filters.rs       │ ◄────────────────────── │    project.rs       │
│  (1110 行, GOD MOD) │      Clip.effects       │  (178 行, 数据模型)  │
│                     │      Clip.masks          │                     │
│  imports project::* │      Clip.filters        │  references back:   │
│  imports ffmpeg::*  │      Clip.keyframes      │  → filters::Effect  │
└────────┬────────────┘                         │  → filters::Mask    │
         │ imports                              │  → filters::Filter   │
         ▼                                      │  → filters::KF Track │
┌─────────────────────┐                         └─────────────────────┘
│    ffmpeg.rs        │
│  (218 行, 清晰)      │
└─────────────────────┘
```

**问题**: `project.rs` 和 `filters.rs` 互相引用（`project.rs:126-133` 引用 `crate::filters::Effect` / `Mask` / `FilterInstance` / `KeyframeTrack`；`filters.rs:7-8` 引用 `crate::project::*`），形成准循环依赖。这在 Rust 中是合法的，但说明类型归属不清。`Effect`, `Mask`, `FilterInstance` 应定义在 `project.rs`（它们只是数据）或提取到独立模块。

### 2.2 错误处理模式 [P1]

| 位置 | 问题 | 严重程度 |
|------|------|---------|
| `filters.rs:654` | `asset_to_idx.get(&c.asset_id).unwrap_or(&0)` — 找不到素材时静默使用索引 0 | P1 — 导致错误素材被渲染 |
| `filters.rs:721-915` | `build_render_command` 不返回 Result，内部所有 `unwrap` 会 panic | P1 — 无效工程会崩溃 |
| `lib.rs:36-37` | `render()` 将 `filters::render_project_json` 的 anyhow::Error 映射为泛化 `AppError::Render`，丢失具体错误类型 | P2 — 调用方无法区分错误类型 |
| `ffmpeg.rs:167-184` | `probe_filters()` 执行 ffmpeg 子进程，失败时返回空 HashSet（静默降级） | P2 — 应 Warning |
| `filters.rs:744-762` | 视频和音频的 input 去重逻辑完全重复 | P2 — DRY 违反 |
| `filters.rs:893-905` | 只有当 multi_audio 时产生 `[aout]`, 导致单音轨无 `-map`。这是一致性隐患 | P2 |

**最佳实践**: 可以认为 `filters.rs` 的错误模式是所有 `?` 都不会被触发（因为 serde 解析在外部完成），但防御性编程应确保 `build_render_command` 安全。

### 2.3 性能热路径分析 `build_render_command` [P2]

`build_render_command` `(filters.rs:721-915)` 是每次 render 调用的核心热路径。分析其复杂度：

```
1. 轨道排序: O(T log T)   T=轨道数
2. 收集 video/audio clips: O(T * C)   C=每轨 clip 数
3. 去重 inputs: O(V + A)   遍历所有 clip 查 asset
4. 轨道分组: O(V)    HashMap 分组
5. 视频链构建:
   - 每 clip: build_video_chain (keyframed x 4 = 4×二分查找)
   - 同轨多 clip: concat/xfade 决策
   - overlay 合成: 每轨一次
6. 音频链构建: O(A)   每 clip 一次
7. filter_graph 拼接: join(";")
```

**瓶颈识别**:
- `keyframed()` 在 `build_video_chain` 中调用 4 次（scaleX, scaleY, rotation, opacity），每次执行二分查找。若 clip 很多，可缓存。
- `build_clip_filters` 每 clip 调用一次，每次遍历所有 filter + effect — 合理。
- **最大的性能问题是**：每次 `render()` 调用完全重建整个 filter graph，无缓存。当前规模下（测试用 80 clips 通过 < 2s）可接受，但对于数千 clips 的项目会退化。

### 2.4 内存分配模式 [P2]

```rust
// filters.rs:745-763  — 冗余分配
let mut asset_to_idx: HashMap<String, usize> = HashMap::new();  // 每次重建
let mut inputs: Vec<String> = Vec::new();
for (_, c) in &video_clips { ... inputs.push(a.path.clone()); } // 克隆路径
for c in &audio_clips { ... }  // 完全相同的循环
```

- `String` 克隆: `a.path.clone()` 每次 render 调用都会克隆所有资产路径
- `nodes: Vec<String>` 所有 filter node 字符串都存在 Vec 里再 join — 不可避免但可优化
- `filter_graph = nodes.join(";")` 创建新的 String — 合理
- **无内存泄漏风险**, 但大量的短生命 String 分配会产生 GC 压力

### 2.5 API 设计 [P2]

```rust
// lib.rs:35 — 强制所有权转移
pub fn render(project_json: String) -> Result<String, AppError>
// 应改为 &str:
pub fn render(project_json: &str) -> Result<String, AppError>
```

- `render()` 取 `String` 而非 `&str` — 调用方不得不转移所有权或 clone
- `compute_canvas` `(project.rs:168)` 未命中的比例无声默认 16:9 — 应返回 Result
- `build_render_command` `(filters.rs:721)` 返回 `RenderCommand` 而非 `Result` — 假设所有数据都已验证, 脆弱

### 2.6 Rust 惯用法评估

| 方面 | 评价 | 示例 |
|------|------|------|
| serde 派生 | ✅ 良好 | `#[derive(Debug, Clone, Serialize, Deserialize)]` |
| OnceLock | ✅ 正确 | `REGISTRY`, `FILTER_AVAILABILITY` |
| Option/Result | ⚠️ 部分未用 | `unwrap()` 在热路径中使用 |
| 模式匹配 | ⚠️ 缺少 | `build_mask_spec` 的 if-else 链可换 match |
| 迭代器 | ⚠️ 部分 | `project.total_duration` 用好迭代器，但 input 构建用显式 for 循环 |
| 新类型 | ❌ 未用 | `Resolution(pixels)`, `Timestamp(seconds)` 能增加类型安全 |
| Cow | ❌ 未用 | 多处可零拷贝 |
| trait | ⚠️ 未用 | FilterGraphBuilder 是空 struct，不如用 trait |

---

## 3. 测试策略评估

### 3.1 测试金字塔 [P2]

```
         ┌──────────┐
         │  E2E  ❌  │  — 无真实 ffmpeg 执行验证
         ├──────────┤
         │  集成 8   │  — 命令字符串验证 (tests/integration_test.rs)
         ├──────────┤
         │  单元 12  │  — 嵌在 filters.rs 中
         └──────────┘
```

**问题**:
- `ffmpeg.rs` (218 行) — 0 单元测试（`resolve_encoder`, `bitrate_for_resolution`, `degrade_filter` 等纯函数可测但未测）
- `project.rs` (178 行) — 0 单元测试（`compute_canvas`, `total_duration`, `asset_by_id` 可测但未测）
- `lib.rs` (27 行) — 0 单元测试
- 集成测试 8 个全通过，但都在验证命令**字符串内容**，无实际 ffmpeg 执行验证

### 3.2 边角覆盖 [P1]

| 场景 | 覆盖 | 严重程度 |
|------|------|---------|
| 基本 render | ✅ test_render_basic_path | — |
| Mask 降级 | ✅ test_render_mask_degrade_path | — |
| 变速 | ✅ test_render_speed | — |
| 音频轨道 | ✅ test_render_audio_track | — |
| 旋转 | ✅ test_render_rotation | — |
| 过渡 | ✅ test_render_xfade_transition | — |
| 空工程 | ✅ test_render_empty_project | — |
| 多轨合成 | ✅ test_render_multi_track_overlay | — |
| 无效 JSON | ✅ test_render_invalid_json | — |
| 多音频 | ✅ test_render_multi_audio_amix | — |
| 组合滤镜 | ✅ test_render_combined_filters | — |
| 镜像翻转 | ✅ test_render_flip | — |
| 色度抠图 | ✅ test_render_chromakey | — |
| 编码器解析 | ✅ test_resolve_hw_encoder | — |
| 大工程压测 | ✅ test_render_large_project (80 clips, <2s) | — |
| **曲线变速 SpeedPoint** | ❌ 无测试 | P2 |
| **非重叠 clip + gap** | ❌ 无测试 | P2 |
| **极限分辨率** | ❌ 无测试 | P2 |
| **重复 asset_id** | ❌ 无测试 | P2 |

总体边角覆盖较好，但缺少对 `speed_curve`（曲线变速）路径的测试。

### 3.3 测试可维护性 [P2]

- JSON fixture 全部内联 — 测试文件 537 行中约 350 行是 JSON
- 多个测试包含几乎相同的 JSON 结构（transform 块重复）
- 无测试 builder/helper 模式
- 字符串断言脆弱：`cmd.contains("scale=576:324")` 精确匹配像素值，缩放公式变化会失败

### 3.4 缺失的测试类别 [P2]

| 类别 | 状态 | 建议 |
|------|------|------|
| 基准测试 Benchmark | ❌ | 对 `build_render_command` 做 `#[bench]` |
| Fuzz 测试 | ❌ | 对 JSON 解析做模糊测试 |
| 属性测试 (Property) | ❌ | 关键帧插值不变性（单调性、边界）适合 proptest |
| Doc 测试 | ❌ | 所有 pub fn 可加 `/// ```rust` 示例 |

---

## 4. 工程化成熟度

### 4.1 Cargo.toml 完整性 [P2]

```toml
[package]
name = "aicut-engine"
version = "0.1.0"
edition = "2021"
description = "AIcut video editing engine core (Rust)"
license = "MIT"
# ❌ 缺失: authors, repository, homepage, keywords, categories, readme

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
thiserror = "1"
# 版本未固定到 minor — 可重现构建风险低但存在
```

### 4.2 缺失的工程基础设施 [P1]

| 基础设施 | 状态 | 严重程度 |
|----------|------|---------|
| CI/CD (GitHub Actions) | ❌ | P1 — 无自动化验证 |
| 代码格式化 (rustfmt) | ❌ 无 `.rustfmt.toml` | P2 |
| Lint (clippy) | ❌ 无 `clippy.toml` | P2 |
| 预提交钩子 | ❌ | P2 |
| Git 仓库 | ❌ 目录不是 git repo | P1 — 无版本管理 |
| CHANGELOG | ❌ | P3 |
| 构建脚本/发布流程 | ❌ 无 Makefile/taskfile | P2 |
| README | ❌ | P2 — 但用户指示不要创建 |

### 4.3 版本管理 [P2]

- `version = "0.1.0"` — pre-release 状态, 合理
- `engine_version()` 使用 `env!("CARGO_PKG_VERSION")` — 正确
- 无预发布流程 (pre-release / nightly / stable)

### 4.4 依赖审计 [P2]

```
serde + serde_json — 必要，JSON 序列化/反序列化
anyhow           — 用于 filters.rs 内部错误，但公共 API 使用 AppError
thiserror        — 用于 AppError derive
```

- `anyhow` 仅在 `filters.rs` 的 `render_project_json` 中使用，可考虑移除或改为内部使用
- 无 N-API 依赖（有意延迟）
- **建议**: 恢复 napi-rs 依赖后加入 `napi`, `napi-derive`, `napi-build`，配合 `cfg(feature = "napi")` 条件编译

---

## 5. 安全性审查

### 5.1 FFmpeg 命令注入风险 [P1]

**关键发现**: 资产路径直接从用户提供的 JSON 传入 FFmpeg 参数

```rust
// filters.rs:750-752
inputs.push(a.path.clone());  // 路径来自 JSON → 直接成为 -i 参数
```

当前代码仅构造 `Vec<String>` 命令，不执行 ffmpeg。但当 `RenderCommand::to_command_line()` 的返回值被用于 shell 调用时，攻击者可构造恶意 path：

```json
{ "path": "input.mp4; rm -rf /" }
```

如果调用方使用 `sh -c` 或 `cmd /c` 执行返回的字符串：
```
ffmpeg -y -i "input.mp4; rm -rf /" -c:v libx264 ... output.mp4
```
→ **潜在命令注入**。

**建议**:
1. 文档强制要求使用 `std::process::Command::args()` 而非字符串拼接
2. 在 `to_command_string()` 输出的路径两侧加引号并提供安全警告
3. 添加 `RenderCommand::execute()` 方法，内部使用 `Command::args()` 安全执行

**严重程度**: P1 — 当前不直接危险，但 API 设计鼓励调用方用危险方式执行

### 5.2 输入验证 [P2]

| 路径 | 验证 | 剩余风险 |
|------|------|---------|
| JSON 解析 | serde 安全解析 | 类型正确但值未验证（负时间、超大分辨率） |
| 资产路径 | 无验证 | 空路径、相对/绝对路径无校验 |
| Clip 时间范围 | 无验证 | `timeline_in > timeline_out`, 负值 |
| 分辨率 | 无验证 | width=0, height=0 会生成无效 scale |

`serde_json::from_str` 不会检查逻辑一致性，工程可能包含：
- 负数时间范围 → 生成无效 `trim`/`setpts`
- 零分辨率 → `scale=0:0` → FFmpeg 报错
- 缺失 `assetId` 引用的素材 → `unwrap_or(&0)` 静默使用错误素材

### 5.3 资源耗尽 [P2]

- `build_render_command` 内存分配 O(n): 对极大规模工程（数千 clips），每次渲染分配 ~MB 级字符串
- `build_speed_curve_expr` 递归嵌套：`if(lt(T, ...), ..., if(lt(T, ...), ..., PTS))` 深度 = control points 数。理论无绑, 但实际上 100+ points 会产生 ~10KB 表达式字符串
- `probe_filters` 的子进程调用会 fork — 在受限环境下可能失败

### 5.4 错误信息泄露 [P3]

- `AppError::Json` 包含原始错误: `"JSON 解析失败: {0}"` — 泄露 JSON 结构到错误消息
- CLI `main.rs:32`: `eprintln!("无法读取文件 {}: {}", path, e)` — 泄露文件路径
- 桌面应用场景下风险低, 但 `render()` 作为库 API 时, 错误的 JSON 可能包含敏感信息

---

## 6. 可维护性

### 6.1 代码重复 [P2]

1. **input 去重逻辑双重循环** `(filters.rs:747-763)`:
   ```rust
   for (_, c) in &video_clips { ... }  // 与下面几乎相同
   for c in &audio_clips { ... }        // 重复
   ```

2. **格式化模式重复**: `fmt()` 函数 + `format!("{}={}", ...)` 模式在 `build_filter_spec`, `build_mask_spec`, `build_video_chain` 中重复出现

3. **prebuilt JSON 测试片段重复**: 每个测试函数内联几乎相同的 `transform: { "x": 0.5, "y": 0.5...}` 块

### 6.2 Magic Numbers/Strings [P2]

| 位置 | 值 | 建议 |
|------|-----|------|
| `filters.rs:58` | `8` (Newton 迭代次数) | 命名常量 `BEZIER_NEWTON_ITERATIONS` |
| `filters.rs:61,127,603,616,886` | `1e-6`, `1e-9` (epsilon) | 命名常量 `EPSILON` |
| `ffmpeg.rs:14` | CRF=18 | 提取到配置 |
| `filters.rs:204` | `"format=yuv420p"` | 命名常量 |
| `filters.rs:781` | `"black"` (底色) | 命名常量或配置参数 |
| `filters.rs:788` | `"base"` (标签名) | 命名常量 |

### 6.3 文档覆盖 [P2]

| 模块 | 模块级文档 | 函数级文档 | 示例代码 |
|------|-----------|-----------|---------|
| `project.rs` | ✅ | ⚠️ 部分字段有 doc | ❌ |
| `ffmpeg.rs` | ✅ | ⚠️ 主要函数有 doc | ❌ |
| `filters.rs` | ✅ | ⚠️ 大部分函数缺少 doc | ❌ |
| `lib.rs` | ✅ | ❌ pub fn render 无 doc | ❌ |
| `main.rs` | ✅ | ✅ | — |

- `#![allow(dead_code)]` (lib.rs:10) 屏蔽了有用警告 — 应删除此声明并修复实际死代码
- `pub struct FilterGraphBuilder` (filters.rs:711) 是空 struct, 仅作为命名空间。应加 `#[doc(hidden)]` 或改进设计

### 6.4 单一职责违规 [P1]

**`filters.rs` — 1110 行, 承担 7+ 个职责**:

| 职责 | 行范围 |
|------|--------|
| 关键帧系统 (Easing, Keyframe, KeyframeTrack) | 11-132 |
| 滤镜参数 (FilterParam, FilterParamSchema) | 134-154 |
| 滤镜注册表 (FilterType, FilterDef, registry) | 157-337 |
| 效果/蒙版/滤镜实例 (Effect, Mask, FilterInstance) | 338-374 |
| 滤镜构建 (build_filter_spec, build_mask_spec, build_clip_filters) | 376-515 |
| 预设风格包 (PresetPack, FILTER_PRESETS) | 517-585 |
| 曲线变速 (build_speed_curve_expr) | 587-628 |
| FilterGraphBuilder + render command 构建 | 630-915 |
| 公共 API (render_project_json, get_preset_list, engine_version) | 917-933 |
| 单元测试 | 937-1110 |

**建议**: 拆分为至少 5 个文件:
- `src/keyframe.rs` — Easing, Keyframe, KeyframeTrack
- `src/filter_def.rs` — FilterType, FilterDef, registry
- `src/filter_builder.rs` — build_filter_spec, build_mask_spec
- `src/preset.rs` — PresetPack, FILTER_PRESETS
- `src/graph_builder.rs` — FilterGraphBuilder, build_render_command

---

## 7. Phase 对比 & 路线图偏差

### 7.1 Phase 1-3 实现情况

| Phase | 设计承诺 | 实现状态 | 偏差度 |
|-------|---------|---------|--------|
| **P1** 导入→剪辑→1080P 导出 | 最小可用闭环 | Rust 引擎可生成 1080P FFmpeg 导出命令（仅 CLI） | **60%** — 缺失 GUI、导入流程、实际渲染执行 |
| **P2** 功能对齐剪映 | 文本/字幕/音频/特效/转场/调色 | Rust 数据模型完整，filter 构建支持所有这些。但无 GUI 面板 | **40%** — 引擎能力存在但不可用 |
| **P3** AI 自动化 | MCP Server + TTS/ASR/工作流 | **完全不存**在 | **0%** — 无一行代码 |

### 7.2 Phase 4 完成度

```
设计目标: Rust 引擎 + 4K 代理 + WebGPU (延后)
           ↓
实际交付: Rust 引擎核心 ✓  —— 滤镜图、关键帧、预置完全实现
           CLI 二进制 ✓       —— aicut-engine.exe
           8 个集成测试 ✓     —— 所有通过
           N-API 绑定 ✗      —— 网络限制，napi 依赖从 Cargo.toml 移除
           Proxy 生成 ✗      —— Asset.proxyPath 在 schema 但无生成代码
           TS 桥接层 ✗        —— engine.ts 不存在
```

**实际 Phase 4 完成度**: ~45%
- Rust 引擎核心: 90% 完整
- N-API 集成: 0%（核心价值丢失）
- 4K 代理: 5%（仅 schema）
- 桥接: 0%

### 7.3 Phase 5 准备度

| 前提条件 | 状态 | 阻塞项 |
|---------|------|--------|
| Electron 渲染进程存在 | ❌ 无 GUI | 必须先建立桌面应用 |
| `navigator.gpu` 可用 | ❌ 无法验证 | 需 Electron + WebGPU |
| proxy 720p 可用 | ❌ 未实现 | 需实现代理生成 |
| `aicut-asset://` 协议 | ❌ 未实现 | 需主进程注册 |
| Timeline 纯逻辑 | ❌ 未实现 | 需新建 |

**结论**: Phase 5 准备度为 **0%**。

### 7.4 总体路线图偏差

```
方案路线:
  Phase 1 (最小闭环) → Phase 2 (功能对齐) → Phase 3 (AI驱动) → Phase 4 (Rust+4K) → Phase 5 (WebGPU)

实际进度:
  Phase 1 ── 60% ──→ Phase 2 ── 40% ──→ Phase 3 ── 0% ──→ Phase 4 ── 45% ──→ Phase 5 ── 0%
     └── all engine core work here
```

**核心问题**: 开发提前进入了 Rust 引擎，跳过了 GUI、AI、桥接等大量前期依赖。Rust 引擎本身质量不错，但无法被任何上层消费。

---

## 8. 优先级行动清单

### P0 — 阻止生产使用的阻塞项

| # | 项目 | 文件/位置 | 描述 |
|---|------|----------|------|
| 0.1 | **命令注入防护** | `filters.rs:751`, `ffmpeg.rs:157` | 资产路径直接嵌入命令字符串；`to_command_string()` 返回裸字符串可能被 shell 执行。应添加 `RenderCommand::execute()` 方法使用 `Command::args()` |
| 0.2 | **N-API 恢复** | `Cargo.toml`, `lib.rs`, `build.rs` | 恢复 `napi`/`napi-derive`/`napi-build` 依赖，`#[napi]` 属性，`napi_build::setup()`。无 N-API 引擎无法被 Node.js/Electron 调用 |
| 0.3 | **建立 Git 仓库** | 项目根 | 当前无版本管理 |
| 0.4 | **TS 桥接层** | `packages/engine/` | 即使无 N-API，先建立 mock/stub 桥接，定义类型签名 |

### P1 — 重要质量改进

| # | 项目 | 文件/位置 | 描述 |
|---|------|----------|------|
| 1.1 | **拆分 `filters.rs`** | `src/filters.rs` (1110 行) | 按 6.4 节建议拆为 5 个文件。这是最大的单一责任违规 |
| 1.2 | **`build_render_command` 错误处理** | `filters.rs:654`, 721-915 | 替换 `unwrap_or(&0)` 为返回 `Result`，asset 找不到时返回错误而非静默使用索引 0 |
| 1.3 | **`ffmpeg.rs` 单元测试** | `src/ffmpeg.rs` | 对 `resolve_encoder`, `bitrate_for_resolution`, `degrade_filter` 等纯函数添加测试 |
| 1.4 | **`project.rs` 单元测试** | `src/project.rs` | 对 `compute_canvas`, `total_duration`, `asset_by_id` 添加测试 |
| 1.5 | **CI 配置** | `.github/workflows/` | GitHub Actions: `cargo build`, `cargo test`, `cargo clippy`, `cargo fmt` |
| 1.6 | **代理生成实现** | `src/ffmpeg.rs` / `src/lib.rs` | 实现 `generate_proxy()` 调用 ffmpeg scale 生成 720p 代理。当前 `Asset.proxyPath` 在 schema 中但无实体逻辑 |
| 1.7 | **Cargo 配置完善** | `Cargo.toml` | 补全 metadata, 添加 `[profile.release]` LTO 配置 |

### P2 — 有价值的改进

| # | 项目 | 文件/位置 | 描述 |
|---|------|----------|------|
| 2.1 | **Magic numbers 命名常量** | `filters.rs`, `ffmpeg.rs` | 提取 8 (Newton iterations), 1e-6 (epsilon), CRF=18, yuv420p, "black" |
| 2.2 | **input 去重 DRY** | `filters.rs:747-763` | 合并 video/audio 的 asset 收集逻辑 |
| 2.3 | **`render()` 签名 &str** | `lib.rs:35` | `fn render(project_json: &str)` 避免强制所有权转移 |
| 2.4 | **Clippy 配置** | `clippy.toml` | 添加并修复所有 clippy 警告 |
| 2.5 | **`#[allow(dead_code)]` 移除** | `lib.rs:10` | 删除并修复真正的死代码 |
| 2.6 | **Benchmark 测试** | `tests/bench.rs` | 对 `build_render_command` 1000 clips 规模的基准测试 |
| 2.7 | **`compute_canvas` 返回 Result** | `project.rs:168` | 未命中的比例应返回错误而非默认 16:9 |
| 2.8 | **曲线变速 SpeedPoint 测试** | `tests/integration_test.rs` | 添加 `speed_curve` 路径的集成测试 |

### P3 — 未来考虑

| # | 项目 | 描述 |
|---|------|------|
| 3.1 | Fuzz 测试 | 对 JSON 解析做模糊测试 |
| 3.2 | Property-based 测试 | keyframe 插值不变性 (proptest) |
| 3.3 | 内存 profiling | 对 10000+ clip 规模做分析 |
| 3.4 | WASM 目标 | 扩展 Rust 引擎到 WASM 用于 Web 预览 |
| 3.5 | FFmpeg 多版本兼容矩阵 | 对不同 ffmpeg 版本做回归测试 |
| 3.6 | Phase 3 AI 架构 | MCP Server, Provider 接口 |
| 3.7 | Phase 2 GUI 组件 | Electron + React 应用 |
| 3.8 | Phase 5 WebGPU 预览 | Timeline 逻辑 + WGSL 着色器 |

---

## 总结

### 最大发现

1. **架构鸿沟**: 当前代码仅为 Rust 引擎层（约 20% 的完整架构），无 GUI、无 AI、无桥接
2. **核心交付未达成**: Phase 4 的主要价值（N-API 绑定 + 4K 代理）未被实现
3. **`filters.rs` 严重超标**: 1110 行集 7 个职责，是最大的维护风险
4. **错误处理不彻底**: 热路径中的 `unwrap()` 在生产中可能 panic
5. **命令注入风险**: API 设计鼓励调用方以不安全方式使用返回的命令字符串
6. **测试覆盖表层**: 虽然边角覆盖好，但核心模块无单元测试，且无真实渲染验证

### 亮点

- Rust 代码质量整体不错，serde 使用规范，模块间接口清晰
- 滤镜系统完整（13 种滤镜类型 + 5 个预置 + 关键帧 + 曲线变速 + 转场 + 蒙版）
- 滤镜探测降级机制设计合理（`OnceLock` + `degrade_filter`）
- 测试覆盖了大部分功能特征（15 个集成测试覆盖基本所有路径）
- CLI 二进制工作正常，可以端到端生成 FFmpeg 命令
