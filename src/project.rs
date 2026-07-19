//! src/project.rs — AIcut 工程/画布数据模型
//! 对应 TS `project.ts`：Project / Asset / Track / Clip / Transform。
//! 纯 Rust 模块，与 N-API 解耦（仅依赖 serde）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const DEFAULT_FPS: u32 = 30;
pub const DEFAULT_SAMPLE_RATE: u32 = 48000;

/// 宽高比预设表：(名称, 参考宽, 参考高)
pub const ASPECT_PRESETS: &[(&str, u32, u32)] = &[
    ("16:9", 1920, 1080),
    ("9:16", 1080, 1920),
    ("1:1", 1080, 1080),
    ("4:3", 1440, 1080),
    ("21:9", 2560, 1080),
];

/// 工程根：版本、画布、素材列表、轨道列表
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    #[serde(default = "default_version")]
    pub version: String,
    pub canvas: CanvasConfig,
    #[serde(default)]
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub tracks: Vec<Track>,
}

/// 画布配置（导出分辨率 / 帧率 / 采样率）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasConfig {
    pub width: u32,
    pub height: u32,
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
}

/// 素材描述
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub path: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub codec: String,
}

/// 2D 变换（归一化 0-1，原点左下角）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transform {
    #[serde(default = "default_center")]
    pub x: f64,
    #[serde(default = "default_center")]
    pub y: f64,
    #[serde(default = "one_f")]
    pub scale_x: f64,
    #[serde(default = "one_f")]
    pub scale_y: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "one_f")]
    pub opacity: f64,
}

/// 时间范围（秒，浮点）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Range {
    pub start: f64,
    pub end: f64,
}

/// 曲线变速控制点：(源时间位置, 播放时间位置)，用于构建分段线性 setpts 表达式
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SpeedPoint {
    /// 源素材时间位置（秒）
    pub src: f64,
    /// 对应的播放时间线位置（秒）
    pub play: f64,
}

/// 轨道：按 order 排序的多片段容器
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    #[serde(rename = "type")]
    pub track_type: String,
    #[serde(default)]
    pub order: u32,
    #[serde(default)]
    pub clips: Vec<Clip>,
}

/// 片段：素材引用 + 源/时间线范围 + 变换 + 效果/蒙版/滤镜/关键帧
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    #[serde(rename = "assetId")]
    pub asset_id: String,
    pub src_range: Range,
    #[serde(rename = "timelineIn")]
    pub timeline_in: f64,
    #[serde(rename = "timelineOut")]
    pub timeline_out: f64,
    #[serde(default = "default_transform")]
    pub transform: Transform,
    #[serde(default = "one_f")]
    pub volume: f64,
    #[serde(default = "one_f")]
    pub speed: f64,
    /// 曲线变速控制点：[(源时间位置, 播放时间位置)]，空/None 则用线性 speed
    #[serde(default)]
    pub speed_curve: Vec<SpeedPoint>,
    #[serde(default)]
    pub effects: Vec<crate::filters::Effect>,
    #[serde(default)]
    pub masks: Vec<crate::filters::Mask>,
    #[serde(default)]
    pub filters: Vec<crate::filters::FilterInstance>,
    #[serde(default)]
    pub keyframes: HashMap<String, crate::filters::KeyframeTrack>,
}

// ---- 默认辅助函数 ----
fn default_version() -> String { "1.0".into() }
fn default_fps() -> u32 { DEFAULT_FPS }
fn default_sample_rate() -> u32 { DEFAULT_SAMPLE_RATE }
fn default_center() -> f64 { 0.5 }
fn one_f() -> f64 { 1.0 }
fn default_transform() -> Transform {
    Transform {
        x: 0.5,
        y: 0.5,
        scale_x: 1.0,
        scale_y: 1.0,
        rotation: 0.0,
        opacity: 1.0,
    }
}

impl Project {
    /// 时间线总时长 = 所有轨道最远片段结束时间的最大值
    pub fn total_duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter().map(|c| c.timeline_out))
            .fold(0.0_f64, f64::max)
    }

    /// 按 id 查找素材
    pub fn asset_by_id(&self, id: &str) -> Option<&Asset> {
        self.assets.iter().find(|a| a.id == id)
    }
}

/// 根据宽高比名 + 基准高度，查 ASPECT_PRESETS 计算画布尺寸
pub fn compute_canvas(aspect: &str, base_height: u32) -> (u32, u32) {
    for (name, w, h) in ASPECT_PRESETS {
        if *name == aspect {
            let scale = base_height as f64 / *h as f64;
            return ((*w as f64 * scale).round() as u32, base_height);
        }
    }
    // 未命中 → 默认 16:9
    (((base_height as f64 * 16.0 / 9.0).round()) as u32, base_height)
}
