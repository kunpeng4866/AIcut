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
pub mod ai;
pub mod mcp;
pub mod provider;
pub mod plugin;
pub mod tts;
pub mod timeline;
pub mod clock;
pub mod pipeline;
pub mod decoder;
pub mod compositor;
pub mod audio_pipeline;
mod types;
mod keyframe;
mod filters;
mod preset;
mod graph;

use thiserror::Error;

use crate::project::{Project, Track, Transform};

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

// ════════════════════ 快速路径检测 ════════════════════

/// 默认 Transform（居中、无缩放、无旋转、完全不透明）
fn default_transform_value() -> Transform {
    Transform {
        x: 0.5,
        y: 0.5,
        scale_x: 1.0,
        scale_y: 1.0,
        rotation: 0.0,
        opacity: 1.0,
    }
}

/// 判断工程是否为"简单工程"，可走 graph.rs 快速路径
///
/// 条件：
/// - 恰好 1 个视频轨道（track_type == "video" 或 "effect"）
/// - 该轨道每个 clip 的 transform 全为默认值
/// - 无 filters / effects / masks / keyframes / speed_curve
pub fn is_simple_project(project: &Project) -> bool {
    let video_tracks: Vec<&Track> = project.tracks.iter()
        .filter(|t| t.track_type == "video" || t.track_type == "effect")
        .collect();

    if video_tracks.len() != 1 {
        return false;
    }

    let default_tf = default_transform_value();

    for clip in &video_tracks[0].clips {
        if clip.transform != default_tf {
            return false;
        }
        if !clip.filters.is_empty() {
            return false;
        }
        if !clip.effects.is_empty() {
            return false;
        }
        if !clip.masks.is_empty() {
            return false;
        }
        if !clip.keyframes.is_empty() {
            return false;
        }
        if !clip.speed_curve.is_empty() {
            return false;
        }
    }

    // 任何轨道（含 text/subtitle 轨道）含文字/字幕叠加层 → 走完整路径渲染 drawtext
    for track in &project.tracks {
        for clip in &track.clips {
            if clip.text.is_some() || clip.subtitle.is_some() {
                return false;
            }
        }
    }

    true
}

// ════════════════════ 导出 API ════════════════════

/// 导出工程到视频文件
///
/// 内部流程：解析工程 → 快速路径检测 → 执行导出
/// - 快速路径（简单工程）：graph.rs 生成 FFmpeg 命令 + `std::process::Command` 执行
/// - 完整路径（复杂工程）：`ExportPipeline` 逐帧解码 + 合成 + 编码
pub fn export_project(project_json: &str, output_path: &str) -> Result<(), String> {
    let project: Project = serde_json::from_str(project_json)
        .map_err(|e| format!("工程 JSON 解析失败: {}", e))?;

    if is_simple_project(&project) {
        // 快速路径：graph.rs → FFmpeg 一次性命令
        let cmd = graph::build_render_command(&project);
        let output = cmd.execute_to_file(output_path)
            .map_err(|e| format!("FFmpeg 启动失败: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "FFmpeg 渲染失败 (退出码 {:?}): {}",
                output.status.code(),
                stderr.chars().take(500).collect::<String>()
            ));
        }
    } else {
        // 完整路径：ExportPipeline 逐帧渲染
        let mut pipeline = pipeline::ExportPipeline::from_project(&project);
        let stats = pipeline.run(output_path)
            .map_err(|e| e.to_string())?;
        eprintln!(
            "[export] 完成: {}/{} 帧成功, {} 帧失败 (成功率 {:.1}%)",
            stats.rendered_frames,
            stats.total_frames,
            stats.error_frames,
            stats.success_rate() * 100.0
        );
    }

    Ok(())
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

    #[napi]
    pub fn ai_generate_subtitles(transcript: String, lang: String) -> napi::Result<String> {
        let overlay = crate::ai::generate_subtitles_sync(&transcript, &lang)
            .map_err(|e| napi::Error::from_reason(e))?;
        serde_json::to_string(&overlay).map_err(|e| napi::Error::from_reason(e.to_string()))
    }
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Asset, CanvasConfig, Clip, Range, Track};

    fn make_simple_clip(id: &str, asset_id: &str, tl_in: f64, tl_out: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            src_range: Range { start: tl_in, end: tl_out },
            timeline_in: tl_in,
            timeline_out: tl_out,
            transform: default_transform_value(),
            volume: 1.0,
            speed: 1.0,
            effects: Vec::new(),
            masks: Vec::new(),
            filters: Vec::new(),
            keyframes: std::collections::HashMap::new(),
            speed_curve: Vec::new(),
            time_remap: crate::project::TimeRemap { reverse: false, freeze: None, curve: Vec::new() },
            text: None,
            subtitle: None, transition: None,
        }
    }

    fn make_asset(id: &str) -> Asset {
        Asset {
            id: id.to_string(),
            asset_type: "video".to_string(),
            path: format!("{}.mp4", id),
            duration: 10.0,
            width: 1920,
            height: 1080,
            codec: "h264".to_string(),
        }
    }

    fn make_simple_project() -> Project {
        Project {
            version: "1.0".to_string(),
            canvas: CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
            assets: vec![make_asset("a1")],
            tracks: vec![Track {
                id: "t1".to_string(),
                track_type: "video".to_string(),
                order: 0,
                clips: vec![make_simple_clip("c1", "a1", 0.0, 5.0)],
                ..Default::default()
            }],
        }
    }

    #[test]
    fn test_is_simple_project_true() {
        let project = make_simple_project();
        assert!(is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_multiple_video_tracks() {
        let mut project = make_simple_project();
        project.tracks.push(Track {
            id: "t2".to_string(),
            track_type: "video".to_string(),
            order: 1,
            clips: vec![make_simple_clip("c2", "a1", 0.0, 5.0)],
            ..Default::default()
        });
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_non_default_transform() {
        let mut project = make_simple_project();
        project.tracks[0].clips[0].transform.scale_x = 2.0;
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_with_filters() {
        let mut project = make_simple_project();
        project.tracks[0].clips[0].filters.push(crate::types::FilterInstance {
            kind: "brightness".to_string(),
            params: std::collections::HashMap::new(),
            enabled: true,
        });
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_with_effects() {
        let mut project = make_simple_project();
        project.tracks[0].clips[0].effects.push(crate::types::Effect {
            kind: "shake".to_string(),
            params: std::collections::HashMap::new(),
            enabled: true,
        });
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_with_audio_track_ok() {
        // 音频轨道不影响快速路径检测（只统计视频轨道数）
        let mut project = make_simple_project();
        project.tracks.push(Track {
            id: "t2".to_string(),
            track_type: "audio".to_string(),
            order: 1,
            clips: vec![make_simple_clip("c2", "a1", 0.0, 5.0)],
            ..Default::default()
        });
        assert!(is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_empty_project() {
        // 空工程（0 个视频轨道）不是简单工程
        let project = Project {
            version: "1.0".to_string(),
            canvas: CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
            assets: vec![],
            tracks: vec![],
        };
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_with_masks() {
        let mut project = make_simple_project();
        project.tracks[0].clips[0].masks.push(crate::types::Mask {
            shape: "rect".to_string(),
            params: std::collections::HashMap::new(),
            invert: false,
            feather: 0.0,
        });
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_with_keyframes() {
        let mut project = make_simple_project();
        project.tracks[0].clips[0].keyframes.insert(
            "transform.x".to_string(),
            crate::types::KeyframeTrack { keyframes: vec![] },
        );
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_with_speed_curve() {
        let mut project = make_simple_project();
        project.tracks[0].clips[0].speed_curve.push(crate::project::SpeedPoint { src: 0.0, play: 0.0 });
        assert!(!is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_speed_ok() {
        // speed != 1.0 不影响快速路径检测（graph.rs 能处理线性变速）
        let mut project = make_simple_project();
        project.tracks[0].clips[0].speed = 2.0;
        assert!(is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_multiple_clips_ok() {
        // 单轨道多片段仍可以是简单工程
        let mut project = make_simple_project();
        project.tracks[0].clips.push(make_simple_clip("c2", "a1", 5.0, 10.0));
        assert!(is_simple_project(&project));
    }

    #[test]
    fn test_is_simple_project_with_text_track() {
        // 主视频轨 + 文字轨道含文字 → 非简单工程（走完整路径渲染 drawtext）
        let mut project = make_simple_project();
        project.tracks.push(Track {
            id: "text1".to_string(),
            track_type: "text".to_string(),
            order: 0,
            clips: vec![make_simple_clip("tc1", "a1", 0.0, 5.0)],
            ..Default::default()
        });
        project.tracks.last_mut().unwrap().clips[0].text = Some(crate::subtitle::TextOverlay {
            content: "标题".into(),
            ..Default::default()
        });
        assert!(!is_simple_project(&project));
    }
}
