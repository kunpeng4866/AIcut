//! src/lib.rs — AIcut 引擎公共 API
//!
//! 双模式导出：
//!   默认（pure Rust）：`pub fn render(&str) -> Result<String, AppError>`
//!   N-API（`--features napi`）：额外导出 `#[napi]` 绑定供 Node.js 调用
//!
//! 公共 API；部分项为外部消费者预留。

#![allow(dead_code)] // 仅允许未使用的公共 API 项

pub mod ffmpeg;
pub mod project;
pub mod probe;
pub mod project_io;
pub mod subtitle;
pub mod mcp;
mod types;
mod keyframe;
mod filters;
mod preset;
mod graph;

use thiserror::Error;

/// 引擎错误类型
#[derive(Error, Debug)]
pub enum AppError {
    #[error("JSON 解析失败: {0}")]
    Json(#[from] serde_json::Error),

    #[error("渲染失败: {0}")]
    Render(String),

    #[error("无效参数: {0}")]
    InvalidArg(String),

    #[error("滤镜不可用: {0}")]
    FilterUnavailable(String),
}

/// 主入口：解析工程 JSON → 返回 FFmpeg 命令行字符串
pub fn render(project_json: &str) -> Result<String, AppError> {
    graph::render_project_json(project_json).map_err(|e| AppError::Render(e.to_string()))
}

/// 返回可用滤镜预置名列表
pub fn get_preset_list() -> Vec<String> {
    graph::get_preset_list()
}

/// 版本查询
pub fn get_version() -> String {
    graph::engine_version()
}

// ════════════════════ N-API 绑定（条件编译） ════════════════════

/// N-API 导出层。需 `cargo build --features napi` 激活。
/// 网络不可用时使用默认 pure Rust 模式。
#[cfg(feature = "napi")]
mod napi_bindings {
    use napi_derive::napi;

    #[napi]
    pub fn render(project_json: String) -> napi::Result<String> {
        crate::render(&project_json).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn get_preset_list() -> Vec<String> {
        crate::get_preset_list()
    }

    #[napi]
    pub fn get_version() -> String {
        crate::get_version()
    }
}
