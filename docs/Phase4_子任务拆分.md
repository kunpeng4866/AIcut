# AIcut Phase 4 剩余工作 — 子任务拆分

> 每个子任务独立可执行，用全新上下文（流转）。
> 执行前先读 `CLAUDE.md`（架构摘要）+ `docs/Phase4_进度.md`（已完成的接口规格）。
> **不要**读原始 TS 基准文件全文——按 CLAUDE.md 摘要操作即可。

---

## 子任务 A：Rust 四模块重建 + 编译通过

### 输入
- `CLAUDE.md` — 架构摘要、关键常量、模块职责划分
- `docs/Phase4_进度.md` — 四模块的完整接口规格（数据结构/函数签名/行数估算）
- `deepseek剪映1.txt` — VClip 完整设计文档（TS 数据模型参考）
- 已有文件：`Cargo.toml`（需确认存在）

### 输出
1. `src/project.rs`（~78 行）— Project/Asset/Track/Clip/Transform + ASPECT_PRESETS + compute_canvas()
2. `src/ffmpeg.rs`（~164 行）— RenderCommand/FilterChain + FFmpeg 命令构建 + 滤镜探测降级
3. `src/filters.rs`（~957 行）— FilterType 枚举/注册表、FilterParam、Keyframe 系统、FilterGraphBuilder、预置包、序列化、降级处理
4. `src/lib.rs`（~160 行）— N-API 导出层（napi-rs）
5. `build.rs`（~40 行）— napi-rs 构建脚本

### 完成标准
- [ ] `cargo build` **零错误零警告** 通过（release + target x86_64-pc-windows-msvc 或默认）
- [ ] 所有模块的 pub struct/pub fn 与 Phase4_进度.md 规格一致
- [ ] NAPI 导出签名匹配：`render(projectJson: string) -> string`, `getPresetList() -> string[]`, `getVersion() -> string`
- [ ] FFmpeg 滤镜探测降级逻辑实现（启动时探测 → 缺失时降级替代）

### 禁止事项
- ❌ 不要读 TS 基准文件（engine.ts/project.ts/ffmpeg.ts/index.ts）的全文
- ❌ 不要在一个对话中生成超过 600 行代码（分多次 Write/Edit）
- ❌ 不要同时做 TS 桥接和集成测试（那是子任务 B/C）

### 预估工作量
- 生成 ~1359 行 Rust 代码 + 编译调试 ≈ 3-5 轮对话

---

## 子任务 B：TypeScript 桥接层 + 联调

### 输入
- 子任务 A 的产物：编译通过的 `.node` 二进制 + 头文件
- `docs/Phase4_进度.md` 的 lib.rs NAPI 签名规格
- 原 TS 引擎的调用方式（从 deepseek剪映1.txt 推断的 API 形状）

### 输出
1. `packages/engine/src/index.ts`（或等价入口）— TS wrapper 层：
   - `renderProject(project: ProjectConfig): Promise<RenderResult>`
   - 内部调用 `@aicut/engine-native` 的 render()
   - 类型定义：`ProjectConfig`, `RenderResult`, `FilterPreset`
2. `packages/engine/package.json` — 依赖声明（含 `@aicut/engine-native`）
3. 单元测试：`*.test.ts` 至少覆盖 render() 正常路径

### 完成标准
- [ ] `npm run build`（tsc）零错误
- [ ] `npm test` 通过（mock native module 或加载真实 .node）
- [ ] TS 类型与 Rust NAPI 导出的 JSON schema 一致
- [ ] 错误边界清晰：native crash → JS Error 包装

### 依赖条件
- 必须在子任务 A 编译通过后执行（需要 .node 文件）

### 预估工作量
- TS wrapper + 类型 + 测试 ≈ 2-3 轮对话

---

## 子任务 C：端到端集成验证

### 输入
- 子任务 A + B 的全部产物
- 测试视频素材（至少 1 个 mp4，可用 ffmpeg -f lavfi 生成）
- `deepseek剪映1.txt` 中的导出参数规格

### 输出
1. `tests/integration_test.rs` 或 `tests/e2e.ts`:
   - 加载一个最小工程 JSON（1 视频 + 1 滤镜 + 1 关键帧）
   - 调用 render() → 获得 FFmpeg 命令字符串
   - 执行该命令 → 验证输出文件存在且可播放
2. 性能基线报告：
   - render() 调用延迟 < 100ms（纯命令构建，不含实际渲染）
   - 内存占用合理（无泄漏）
3. `docs/Phase4_完成报告.md`

### 完成标准
- [ ] 最小工程端到端跑通：JSON in → FFmpeg command out → 可播放视频 out
- [ ] 至少测试 3 个场景：纯裁剪、调色+关键帧、多轨道合成
- [ ] FFmpeg 滤镜降级路径被触发且不 panic
- [ ] 所有测试可复现（有固定 seed 的测试素材）

### 依赖条件
- 必须在子任务 A 和 B 都完成后执行

### 预估工作量
- 集成测试编写 + 调试 + 场景覆盖 ≈ 2-4 轮对话

---

## 流转协议（Handoff Protocol）

```
每个子任务的 agent 启动时：

1. 读 CLAUDE.md（前 80 行即可获得全局视图）
2. 读对应子任务的本段规格（输入/输出/完成标准）
3. 如需了解已完成模块细节 → 只读 docs/Phase4_进度.md 的对应章节
4. 开始工作，每完成一个文件就 Edit/Write（不要攒到一起）
5. 完成后更新 docs/Phase4_进度.md 的状态表
6. 将产出文件列表写入交接备忘录
```
