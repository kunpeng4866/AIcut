//! src/types.rs — 共享数据类型
//!
//! 从 project.rs 和 filters.rs 中提取，消除循环依赖。
//! Effect / Mask / FilterInstance / KeyframeTrack 被两边引用，
//! 提取到此处作为单一真相源。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn default_enabled() -> bool { true }

/// 片段级特效
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Effect {
    pub kind: String,
    #[serde(default)]
    pub params: HashMap<String, f64>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// 蒙版描边（graph.rs 导出路径暂不支持，仅做数据承载）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MaskStroke {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub color: String, // "#rrggbb"
    #[serde(default)]
    pub size: f64,     // px
    #[serde(default)]
    pub opacity: f64,  // 0~1
    #[serde(default)]
    pub blur: f64,     // px
}

/// 蒙版阴影（graph.rs 导出路径暂不支持，仅做数据承载）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MaskShadow {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub opacity: f64,
    #[serde(default)]
    pub blur: f64,
    #[serde(default)]
    pub distance: f64,
    #[serde(default)]
    pub angle: f64, // deg
}

/// 蒙版（片段透明度形状）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Mask {
    pub shape: String,
    #[serde(default)]
    pub params: HashMap<String, f64>,
    #[serde(default)]
    pub invert: bool,
    #[serde(default)]
    pub feather: f64,
    /// 文字蒙版内容（shape=="text" 时使用），用 ffmpeg drawtext 生成字形流。
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub stroke: MaskStroke,
    #[serde(default)]
    pub shadow: MaskShadow,
}

/// 背景合成配置：抠出主体后，在透明区背后铺一层背景。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyingBackground {
    #[serde(rename = "type", default = "default_bg_type")]
    pub bg_type: String, // 'none' | 'color' | 'image' | 'video'
    #[serde(default = "default_keying_color")]
    pub color: String,   // type==='color' 时生效，'#rrggbb'
    #[serde(rename = "assetId", default)]
    pub asset_id: Option<String>, // type==='image'|'video' 时生效
}

fn default_bg_type() -> String { "none".to_string() }

/// 抠像配置（片段级色度抠像 / 智能抠像）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyingConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_keying_mode")]
    pub mode: String,
    #[serde(default = "default_keying_color")]
    pub color: String,
    #[serde(default)]
    pub similarity: f64,
    #[serde(rename = "edgeSoftness", default)]
    pub edge_softness: f64,
    #[serde(default)]
    pub spill: f64,
    // ── P1 智能抠像（与前端/导出统一契约）──
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub threshold: Option<f64>,
    #[serde(rename = "matteAssetId", default)]
    pub matte_asset_id: Option<String>,
    // ── 背景合成（P3）──
    #[serde(default)]
    pub background: Option<KeyingBackground>,
}

fn default_keying_mode() -> String { "chroma".to_string() }
fn default_keying_color() -> String { "#00ff00".to_string() }

/// 滤镜实例（来自 Clip.filters）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterInstance {
    pub kind: String,
    #[serde(default)]
    pub params: HashMap<String, f64>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// 单个关键帧
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyframe {
    pub time: f64,
    pub value: f64,
    #[serde(default)]
    pub easing: Easing,
}

/// 缓动函数
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Easing {
    #[serde(alias = "线性")]
    Linear,
    #[serde(alias = "缓入")]
    EaseIn,
    #[serde(alias = "缓出")]
    EaseOut,
    #[serde(alias = "缓入缓出")]
    EaseInOut,
    Bezier(f64, f64, f64, f64),
}

impl Default for Easing {
    fn default() -> Self { Easing::Linear }
}

/// 关键帧轨道的反序列化中间件：前端直接存成 `[{time,value,easing}, ...]` 数组，
/// 历史 Rust 类型则包成 `{"keyframes":[...]}`；两边都兼容，避免已有关键帧工程解析失败。
#[derive(Deserialize)]
#[serde(untagged)]
enum KeyframeTrackInput {
    Wrapped { keyframes: Vec<Keyframe> },
    Raw(Vec<Keyframe>),
}

impl From<KeyframeTrackInput> for KeyframeTrack {
    fn from(v: KeyframeTrackInput) -> Self {
        let kfs = match v {
            KeyframeTrackInput::Wrapped { keyframes } => keyframes,
            KeyframeTrackInput::Raw(k) => k,
        };
        Self { keyframes: kfs }
    }
}

/// 某属性的关键帧轨道
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(from = "KeyframeTrackInput")]
pub struct KeyframeTrack {
    #[serde(default)]
    pub keyframes: Vec<Keyframe>,
}
