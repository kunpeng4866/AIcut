# AGENTS.md — AIcut 项目专属约束

> 通用行为纪律（身份 / 动手前 / 决策梯 / Bug 根因 / 输出纪律 / 绝不偷懒）见全局指导：
> `C:\Users\Administrator\.workbuddy\AGENTS.md`（或 `~/.workbuddy/AGENTS.md`）。
> 本节仅对本项目（AIcut）生效。

## 项目专属红线
- 导出双路径（graph.rs / compositor.rs、WebGPU / HTML5 回退）必须对称实现，不得为精简删其一。
- 改 Rust 必须先 `cargo build` 验证；改 renderer 必须先 `vite build`；改后彻底退出 Electron 重开。
- 已确认需求不再质疑，只做最小正确实现。
- 单次代码生成 ≤ 600 行；大任务拆子代理并行，共享文件归单一子代理独占。
