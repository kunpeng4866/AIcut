# AIcut 进一步开发设计报告

> **日期**：2026-07-20
> **基于**：R1-R5 五项调研（渲染管线/特效热更新/着色器运行时/技术选型/剪映功能矩阵）
> **深度**：设计级
> **目标**：为 AIcut 从"Rust 引擎核心"进化到"完整类剪映编辑器"提供系统化开发路线

---

## 一、现状定位

### 1.1 已完成能力（2806行 Rust 代码）

| 模块 | 能力 | 成熟度 |
|------|------|--------|
| project.rs | 工程数据模型、画布预设、曲线变速 SpeedPoint | ✅ 完整 |
| ffmpeg.rs | FFmpeg 命令构建、滤镜探测降级 | ✅ 完整 |
| filters.rs | 滤镜定义/参数/构建 | ✅ 完整 |
| graph.rs | FilterGraphBuilder、render_project_json | ✅ 完整 |
| keyframe.rs | 关键帧系统（线性/贝塞尔插值） | ✅ 完整 |
| mcp.rs | MCP Server 骨架（4个工具） | 🔨 骨架 |
| provider.rs | ASR + LLM 抽象接口 | 🔨 骨架 |
| subtitle.rs | SRT/ASS 解析 + drawtext 生成 | ✅ 完整 |
| probe.rs | ffprobe 媒体探测封装 | ✅ 完整 |
| project_io.rs | 工程文件读写 | ✅ 完整 |
| preset.rs | 滤镜预置包 | ✅ 基础 |

### 1.2 核心差距（对标剪映 + OpenCut）

| 层级 | 差距 | 严重度 |
|------|------|--------|
| GUI 前端 | 完全不存在（无 Electron/React/UI 组件） | **P0** |
| 实时预览 | 仅 FFmpeg 抽帧，无 WebGPU 合成 | **P0** |
| 渲染管线 | 单次命令构建，无双管线/并行解码/合成器 | **P0** |
| 特效生态 | 无特效包格式/热更新/着色器运行时 | **P1** |
| 自动卡点 | 无节拍检测 | **P1** |
| 智能抠像 | 仅绿幕 chromakey，无人像抠像 | **P2** |
| N-API 绑定 | 条件编译移除，待网络恢复 | **P1** |
| 编排层 | 无命令总线/工程管理 | **P1** |

---

## 二、架构蓝图（目标态）

```
┌──────────────────────────────────────────────────────────────┐
│                     Electron 桌面壳                           │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  时间轴 UI      │  │  预览画布     │  │  特效/滤镜面板   │  │
│  │  (React)       │  │  (WebGPU)    │  │  (React)         │  │
│  └───────┬────────┘  └──────┬───────┘  └────────┬─────────┘  │
│          │    IPC / N-API    │                    │            │
├──────────┼───────────────────┼────────────────────┼────────────┤
│          ▼                   ▼                    ▼            │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              Rust 引擎核心 (N-API / WASM)                │  │
│  │                                                         │  │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐ │  │
│  │  │ 渲染管线  │  │ 特效系统   │  │ AI 能力  │  │ MCP    │ │  │
│  │  │ (R2)     │  │ (R3+R4)   │  │ (R5)     │  │ Server │ │  │
│  │  │          │  │            │  │          │  │        │ │  │
│  │  │•双管线   │  │•.aifx包   │  │•节拍检测 │  │•render │ │  │
│  │  │•并行解码 │  │•热更新    │  │•智能抠像 │  │•probe  │ │  │
│  │  │•合成器   │  │•着色器沙箱│  │•字幕识别 │  │•vfx    │ │  │
│  │  │•音频管线 │  │•LRU缓存   │  │•TTS/ASR  │  │•beats  │ │  │
│  │  └──────────┘  └───────────┘  └──────────┘  └────────┘ │  │
│  │                                                         │  │
│  │  ┌──────────────────────────────────────────────────┐   │  │
│  │  │         FFmpeg 命令构建 (已有, 保留作快速路径)      │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 三、分阶段开发路线图

### Phase 4.5：渲染管线升级（R2 落地）

**目标**：从"单次 FFmpeg 命令"升级到"双管线渲染架构"

| 步骤 | 内容 | 产出 | 依赖 |
|------|------|------|------|
| 1 | Timeline 查询层：`Vec<ClipRef> + binary_search` | `src/timeline.rs` | 无 |
| 2 | 渲染时钟：SteppedClock(导出) + RealtimeClock(预览) | `src/clock.rs` | 步骤1 |
| 3 | 单轨道骨架：解码→变换→合成→编码 | `src/pipeline/` | 步骤2 |
| 4 | 并行解码池：rayon + LRU 预取 | `src/decoder.rs` | 步骤3 |
| 5 | 多轨道合成器：逐轨道 Over 合成 | `src/compositor.rs` | 步骤4 |
| 6 | 音频独立管线：重采样→混音→限制器 | `src/audio_pipeline.rs` | 步骤3 |
| 7 | 预览管线接入 Phase5 WebGPU | 衔接 Phase5 | 步骤5 |
| 8 | 并行优化 + graph.rs 保留作快速路径 | 性能调优 | 步骤7 |

**关键设计决策**：
- 不引 `rangemap` crate，用 `Vec<ClipRef> + binary_search`（clips 已有序）
- `RenderStrategy` trait 统一导出/预览两条管线
- `graph.rs` 现有 FFmpeg 命令构建保留，作为"快速路径"（简单工程直接出命令，复杂工程走管线）

### Phase 5：WebGPU 实时预览（已设计，待实现）

**目标**：用 GPU 实时合成预览，替代 FFmpeg 抽帧

| 里程碑 | 内容 | 验证方式 |
|--------|------|---------|
| M1 | Timeline 纯逻辑 + 单测 | vitest 全过 |
| M2 | `aicut-asset://` 协议 + 离屏 `<video>` | 手动验证 |
| M3 | WebGPU 合成器骨架（单视频纹理+变换） | 单视频实时播放 |
| M4 | 转场混合 + 文本/字幕叠加 | 转场/字幕实时可见 |
| M5 | 特效着色器：色彩+模糊+暗角+绿幕 | 特效实时可见 |
| M6 | 回退链路 + 回归测试 | 零回归 |

**衔接点**：M1 的 Timeline 逻辑应调用 Rust 侧（N-API），而非 TS 纯函数，保证"预览=导出"。

### Phase 6：特效热更新系统（R3+R4 落地）

**目标**：实现 `.aifx` 特效包格式 + 云端热更新 + 着色器安全运行时

| 里程碑 | 内容 | 验证方式 |
|--------|------|---------|
| M1 | `.aifx` 包格式定义 + manifest.json 规范 | 格式文档 + 示例包 |
| M2 | Rust 侧 `src/vfx/` 模块（包管理器 + 清单解析） | 单测通过 |
| M3 | 着色器静态扫描（正则粗扫 19 条规则） | 恶意着色器被拦截 |
| M4 | 签名校验 + HMAC-SHA256 | 篡改包被拒绝 |
| M5 | LRU 缓存管理 + 资源锁定 | 500MB 上限自动清理 |
| M6 | FFmpeg 后端集成（filter.spec 模板替换） | 特效包导出生效 |
| M7 | WebGPU 后端集成（WGSL 注入） | 特效包预览生效 |
| M8 | 云端清单同步 + 按需下载 | 端到端热更新 |
| M9 | MCP 工具扩展（list_vfx/download_vfx/apply_vfx） | AI Agent 可调用 |

**关键设计决策**：
- 双后端冗余：同一 `.aifx` 包同时提供 WGSL（预览）+ filter.spec（导出）
- 四层安全：SHA256 整包校验 → HMAC 签名 → 着色器静态扫描 → 解压路径穿越防护
- 着色器扫描分两阶段：首版正则粗扫（零依赖），后续引入 naga AST 精扫

### Phase 7：AI 智能能力（R5 落地）

**目标**：实现自动卡点、智能抠像、AI 字幕等差异化能力

| 能力 | MVP | 增强 | 高端 | 优先级 |
|------|-----|------|------|--------|
| 自动卡点 | beat-detector (Rust) | madmom (MCP 调用) | - | P0 |
| 字幕识别 | Whisper (已有) | faster-whisper | 豆包 ASR | P1 |
| TTS 朗读 | 火山引擎 TTS | CosyVoice 2 | - | P1 |
| 文案生成 | DeepSeek (已有) | - | - | P1 |
| 绿幕抠像 | FFmpeg chromakey (已有) | - | - | ✅ |
| 人像抠像 | - | RobustVideoMatting | 火山引擎 | P2 |
| 人脸检测 | - | MediaPipe | 火山引擎 | P2 |
| 美颜 | eq 滤镜 (已有) | MediaPipe+磨皮 | 火山引擎 | P2 |

### Phase 8：GUI 前端

**目标**：构建 Electron + React 桌面编辑器

| 模块 | 技术选型 | 参考 |
|------|---------|------|
| 桌面壳 | Electron 28+ | OpenCut 用 GPUI（可选对标） |
| 前端框架 | React 19 + TypeScript | OpenCut 同栈 |
| UI 组件 | shadcn/ui + Tailwind | OpenCut 同栈 |
| 状态管理 | Zustand | OpenCut 同栈 |
| 时间轴 | 自研（Canvas/WebGL 渲染） | 对标剪映交互 |
| 预览画布 | WebGPU canvas | Phase5 |
| 构建工具 | Vite + Turborepo | OpenCut 同栈 |

---

## 四、模块新增/重构清单

### 4.1 新增 Rust 模块

```
src/
├── timeline.rs          [新] 时间线查询层（binary_search）
├── clock.rs             [新] 渲染时钟（Stepped/Realtime）
├── pipeline/
│   ├── mod.rs           [新] 渲染管线入口
│   ├── export.rs        [新] 高质量导出管线
│   ├── preview.rs       [新] 低延迟预览管线
│   └── strategy.rs      [新] RenderStrategy trait
├── decoder.rs           [新] 并行解码池（rayon + LRU）
├── compositor.rs        [新] 多轨道合成器
├── audio_pipeline.rs    [新] 音频独立管线
├── beats.rs             [新] 节拍检测（beat-detector 集成）
└── vfx/                 [新] 特效热更新系统
    ├── mod.rs           [新] 模块入口
    ├── manifest.rs      [新] manifest.json 解析
    ├── package.rs       [新] .aifx 包加载/解压
    ├── signature.rs     [新] HMAC-SHA256 签名校验
    ├── scanner.rs       [新] 着色器静态扫描
    ├── cache.rs         [新] LRU 缓存管理
    ├── registry.rs      [新] 特效注册表
    └── sync.rs          [新] 云端清单同步
```

### 4.2 重构现有模块

| 模块 | 改动 | 原因 |
|------|------|------|
| `filters.rs` ↔ `project.rs` | 提取 Effect/Mask/FilterInstance 到 `types.rs` | 消除准循环依赖（审计 P1） |
| `graph.rs` | `build_render_command` 返回 `Result` | 消除 unwrap panic（审计 P1） |
| `lib.rs` | 恢复 N-API 绑定（网络可用后） | N-API 是主桥接 |
| `mcp.rs` | 扩展工具：list_vfx/download_vfx/apply_vfx/beats | 支持新能力 |

### 4.3 新增前端结构

```
packages/
├── engine/              [已有] TS 桥接层
├── ui/                  [新] UI 组件库
│   ├── src/
│   │   ├── timeline/    [新] 时间轴组件
│   │   ├── preview/     [新] 预览画布（WebGPU）
│   │   ├── panels/      [新] 特效/滤镜/属性面板
│   │   └── stores/      [新] Zustand 状态管理
│   └── package.json
apps/
└── desktop/             [新] Electron 桌面应用
    ├── src/
    │   ├── main.ts      [新] Electron 主进程
    │   ├── preload.ts   [新] 预加载脚本
    │   └── renderer/    [新] React 渲染进程
    └── package.json
```

---

## 五、技术选型总表

| 领域 | 选型 | 理由 |
|------|------|------|
| 渲染核心 | Rust | 已有基础，性能+安全 |
| 前端 | React 19 + TypeScript | 生态成熟，对标 OpenCut |
| 桌面壳 | Electron 28+ | 生态最成熟，WebGPU 支持 |
| GPU 预览 | WebGPU + WGSL | Phase5 已设计 |
| 视频编解码 | FFmpeg | 已有集成 |
| 节拍检测 | beat-detector (Rust) + madmom (Python) | 分层策略 |
| 抠像 | FFmpeg chromakey + RobustVideoMatting | 分层策略 |
| AI 字幕 | Whisper / faster-whisper | 已有 provider.rs |
| TTS | 火山引擎 TTS | 进行中 |
| LLM | DeepSeek API | 已有 |
| 状态管理 | Zustand | 轻量，对标 OpenCut |
| UI 组件 | shadcn/ui + Tailwind | 对标 OpenCut |
| 构建 | Vite + Turborepo | monorepo 友好 |

---

## 六、需要协助的事项

### 6.1 用户需协助

| # | 事项 | 说明 | 优先级 |
|---|------|------|--------|
| 1 | **剪映功能矩阵素材收集** | 按 R1 清单操作剪映截图，放 `docs/调研报告/剪映截图/` | P0 |
| 2 | **火山引擎 TTS Token** | AppID 3322215921，Access Token 尚未获取，TTS 功能依赖 | P1 |
| 3 | **网络环境恢复** | N-API 依赖恢复（napi/napi-derive/napi-build）需网络 | P1 |
| 4 | **火山引擎 CV SDK 评估** | 如需高端美颜/抠像能力，需联系火山引擎商务获取 License | P2 |

### 6.2 技术风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| WebGPU 兼容性 | 部分旧 GPU 不支持 | 回退 FFmpeg 抽帧（Phase5 已设计） |
| 着色器安全沙箱 | 第三方着色器可能恶意 | 四层安全防护（R4 设计） |
| Rust↔Python 跨进程 | madmom/Whisper 需 Python 子进程 | MCP 工具封装，异步调用 |
| Electron 体积 | 打包后 150MB+ | 可选 Tauri 替代（更轻量） |

---

## 七、开发优先级总览

```
Phase 4.5  渲染管线升级     ──┐
Phase 5    WebGPU 实时预览   ──┤── 可并行启动（不同层）
Phase 6    特效热更新系统    ──┘
Phase 7    AI 智能能力       ──── 依赖 Phase 4.5/5
Phase 8    GUI 前端          ──── 依赖 Phase 5（预览画布）
```

**推荐启动顺序**：
1. **立即**：Phase 4.5 步骤1-3（Timeline + 时钟 + 单轨道骨架）—— 纯 Rust，无外部依赖
2. **立即**：Phase 7 自动卡点 MVP（beat-detector 集成）—— 独立模块，可快速出成果
3. **网络恢复后**：N-API 绑定恢复 + Phase 5 WebGPU 预览
4. **并行**：Phase 6 特效热更新（R3+R4 设计已完备，可逐步实现）
5. **最后**：Phase 8 GUI 前端（依赖前面所有阶段的 API 稳定）

---

## 八、与 OpenCut 的差异化定位

| 维度 | OpenCut | AIcut |
|------|---------|-------|
| 核心理念 | 隐私优先（全本地） | AI 优先（智能创作） |
| AI 能力 | Whisper 字幕（本地） | 卡点+抠像+字幕+TTS+文案（云+端） |
| 特效生态 | 插件系统（规划中） | .aifx 热更新（设计完备） |
| 目标市场 | 全球开源社区 | 中国创作者生态 |
| 技术栈 | Rust + Next.js + GPUI | Rust + React + Electron |
| MCP | 内置 | 内置（对标） |

**结论**：AIcut 不与 OpenCut 竞争，而是差异化互补——AIcut 聚焦 AI 能力 + 中国生态，可参考 OpenCut 的 Rust 核心设计但不直接 fork。
