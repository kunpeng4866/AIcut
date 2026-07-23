//! src/pipeline/ — 渲染管线模块
//!
//! 双管线架构：
//! - ExportPipeline：高质量导出，SteppedClock 按帧步进，零丢帧
//! - PreviewPipeline：低延迟预览，RealtimeClock 跟随系统时钟，支持跳帧降级
//!
//! 统一通过 RenderStrategy trait 接口驱动：
//! ```text
//! Timeline 查询层 → 渲染时钟 → 单轨道骨架 → 并行解码池 → 多轨道合成器 → 音频管线
//! ```
//!
//! 当前完成：步骤3 单轨道骨架
//! 后续扩展：
//! - 步骤4：并行解码池 (decoder.rs) 替换当前 FFmpeg 子进程抽帧
//! - 步骤5：多轨道合成器 (compositor.rs) 替换单轨道简单取首帧逻辑
//! - 步骤6：音频独立管线 (audio_pipeline.rs) 替换当前简化音频处理

pub mod strategy;
pub mod export;
pub mod preview;

// 重导出核心类型
pub use strategy::{
    AudioChunk, PixelFormat, RenderStrategy, VideoFrame,
    clip_active_range, timeline_to_source_time,
};
pub use export::{ExportConfig, ExportPipeline, ExportStats};
pub use preview::{FrameCache, PreviewConfig, PreviewPipeline};
