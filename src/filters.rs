//! src/filters.rs — 滤镜/特效系统（核心最大模块）
//! 对应 TS 内联滤镜逻辑：统一到 FilterType 枚举 / 注册表 / 关键帧插值 /
//! FilterGraphBuilder / 预置包 / 序列化 / 降级处理。
//! 纯 Rust 模块，与 N-API 解耦。

use crate::ffmpeg;
use crate::project::{Clip, Project, Track};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ════════════════════ 关键帧系统 ════════════════════

/// 缓动函数。命名变体内部映射到贝塞尔控制点。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    /// 自定义三次贝塞尔：控制点 (x1, y1, x2, y2)
    Bezier(f64, f64, f64, f64),
}

impl Default for Easing {
    fn default() -> Self {
        Easing::Linear
    }
}

impl Easing {
    /// 将命名缓动映射为贝塞尔控制点；Bezier 直接返回自身
    fn as_bezier(&self) -> (f64, f64, f64, f64) {
        match self {
            Easing::Linear => (0.0, 0.0, 1.0, 1.0),
            Easing::EaseIn => (0.42, 0.0, 1.0, 1.0),
            Easing::EaseOut => (0.0, 0.0, 0.58, 1.0),
            Easing::EaseInOut => (0.42, 0.0, 0.58, 1.0),
            Easing::Bezier(x1, y1, x2, y2) => (*x1, *y1, *x2, *y2),
        }
    }
}

/// 三次贝塞尔求值：给定时间进度 x∈[0,1]，返回值进度 y
fn cubic_bezier(p1x: f64, p1y: f64, p2x: f64, p2y: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let bx = |t: f64| 3.0 * (1.0 - t).powi(2) * t * p1x + 3.0 * (1.0 - t) * t.powi(2) * p2x + t.powi(3);
    let by = |t: f64| 3.0 * (1.0 - t).powi(2) * t * p1y + 3.0 * (1.0 - t) * t.powi(2) * p2y + t.powi(3);
    let dx = |t: f64| {
        let u = 1.0 - t;
        3.0 * u * u * p1x + 6.0 * u * t * (p2x - p1x) + 3.0 * t * t * (1.0 - p2x)
    };
    let mut t = x;
    for _ in 0..8 {
        let x_err = bx(t) - x;
        let d = dx(t);
        if d.abs() < 1e-6 {
            break;
        }
        t -= x_err / d;
        t = t.clamp(0.0, 1.0);
    }
    by(t)
}

/// 应用缓动到线性进度 p∈[0,1]
fn apply_easing(e: Easing, p: f64) -> f64 {
    let (x1, y1, x2, y2) = e.as_bezier();
    cubic_bezier(x1, y1, x2, y2, p.clamp(0.0, 1.0))
}

/// 单个关键帧
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyframe {
    pub time: f64, // 秒
    pub value: f64,
    #[serde(default)]
    pub easing: Easing,
}

/// 某属性的关键帧轨道（按时间有序）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KeyframeTrack {
    #[serde(default)]
    pub keyframes: Vec<Keyframe>,
}

impl KeyframeTrack {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.keyframes.is_empty()
    }

    /// 在时刻 t 插值得到属性值。无关键帧返回 0.0（调用方应先用 is_empty 判断）。
    pub fn sample(&self, t: f64) -> f64 {
        let kfs = &self.keyframes;
        if kfs.is_empty() {
            return 0.0;
        }
        if kfs.len() == 1 || t <= kfs[0].time {
            return kfs[0].value;
        }
        let last = kfs.len() - 1;
        if t >= kfs[last].time {
            return kfs[last].value;
        }
        // 二分查找区间
        let mut lo = 0usize;
        let mut hi = last;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if kfs[mid].time <= t {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let a = &kfs[lo];
        let b = &kfs[hi];
        let denom = (b.time - a.time).max(1e-9);
        let p = (t - a.time) / denom;
        let pe = apply_easing(b.easing, p);
        a.value + (b.value - a.value) * pe
    }
}

// ════════════════════ 滤镜参数 ════════════════════

/// 运行期滤镜参数（名称 + 当前值）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterParam {
    pub name: String,
    pub value: f64,
}

/// 参数模式（约束 min/max/default/step + 对应 FFmpeg 键名）
#[derive(Debug, Clone)]
pub struct FilterParamSchema {
    pub name: String,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    pub step: f64,
    /// FFmpeg 滤镜中的键，例如 eq 的 "brightness"
    pub ffmpeg_key: &'static str,
}

// ════════════════════ FilterType 枚举 + 注册表 ════════════════════

/// 滤镜类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterType {
    ColorAdjust,
    CropRotate,
    Speed,
    Mask,
    Transition,
    TextOverlay,
    AudioVolume,
    Fade,
    Flip,
    Crop,
    Lut3d,
    Equalizer,
    ChromaKey,
}

/// 单个滤镜的静态定义
pub struct FilterDef {
    pub filter_type: FilterType,
    /// JSON 中的 kind 字符串
    pub kind: &'static str,
    /// 底层 FFmpeg 滤镜名（用于降级探测）
    pub ffmpeg_filter: &'static str,
    pub display: &'static str,
    pub schema: Vec<FilterParamSchema>,
}

/// 全局滤镜注册表（惰性初始化，保证 `&'static` 生命周期）
static REGISTRY: std::sync::OnceLock<Vec<FilterDef>> = std::sync::OnceLock::new();

pub fn registry() -> &'static [FilterDef] {
    REGISTRY.get_or_init(build_registry)
}

fn build_registry() -> Vec<FilterDef> {
    use FilterType::*;
    vec![
        FilterDef {
            filter_type: ColorAdjust,
            kind: "coloradjust",
            ffmpeg_filter: "eq",
            display: "调色",
            schema: vec![
                sp("brightness", -0.3, 0.3, 0.0, 0.01, "brightness"),
                sp("contrast", 0.0, 2.0, 1.0, 0.01, "contrast"),
                sp("saturation", 0.0, 3.0, 1.0, 0.01, "saturation"),
                sp("gamma", 0.1, 4.0, 1.0, 0.01, "gamma"),
            ],
        },
        FilterDef {
            filter_type: CropRotate,
            kind: "croprotate",
            ffmpeg_filter: "transpose",
            display: "裁剪旋转",
            schema: vec![
                sp("angle", 0.0, 360.0, 0.0, 1.0, "angle"),
                sp("cropLeft", 0.0, 1.0, 0.0, 0.01, "crop_left"),
                sp("cropTop", 0.0, 1.0, 0.0, 0.01, "crop_top"),
                sp("cropRight", 0.0, 1.0, 0.0, 0.01, "crop_right"),
                sp("cropBottom", 0.0, 1.0, 0.0, 0.01, "crop_bottom"),
            ],
        },
        FilterDef {
            filter_type: Speed,
            kind: "speed",
            ffmpeg_filter: "setpts",
            display: "变速",
            schema: vec![sp("rate", 0.1, 100.0, 1.0, 0.1, "rate")],
        },
        FilterDef {
            filter_type: Mask,
            kind: "mask",
            ffmpeg_filter: "mask",
            display: "蒙版",
            schema: vec![
                sp("feather", 0.0, 1.0, 0.0, 0.01, "feather"),
                sp("invert", 0.0, 1.0, 0.0, 1.0, "invert"),
            ],
        },
        FilterDef {
            filter_type: Transition,
            kind: "transition",
            ffmpeg_filter: "xfade",
            display: "转场",
            schema: vec![sp("duration", 0.0, 5.0, 0.5, 0.05, "duration")],
        },
        FilterDef {
            filter_type: TextOverlay,
            kind: "text",
            ffmpeg_filter: "drawtext",
            display: "文字",
            schema: vec![
                sp("fontsize", 8.0, 200.0, 48.0, 1.0, "fontsize"),
                sp("alpha", 0.0, 1.0, 1.0, 0.01, "alpha"),
            ],
        },
        FilterDef {
            filter_type: AudioVolume,
            kind: "volume",
            ffmpeg_filter: "volume",
            display: "音量",
            schema: vec![sp("volume", 0.0, 2.0, 1.0, 0.01, "volume")],
        },
        FilterDef {
            filter_type: Fade,
            kind: "fade",
            ffmpeg_filter: "fade",
            display: "淡入淡出",
            schema: vec![
                sp("type", 0.0, 1.0, 0.0, 1.0, "type"),
                sp("duration", 0.0, 5.0, 0.5, 0.05, "duration"),
            ],
        },
        FilterDef {
            filter_type: Flip,
            kind: "flip",
            ffmpeg_filter: "hflip",
            display: "镜像翻转",
            schema: vec![
                sp("horizontal", 0.0, 1.0, 1.0, 1.0, "horizontal"),
                sp("vertical", 0.0, 1.0, 0.0, 1.0, "vertical"),
            ],
        },
        FilterDef {
            filter_type: Crop,
            kind: "crop",
            ffmpeg_filter: "crop",
            display: "裁剪",
            schema: vec![
                sp("left", 0.0, 1.0, 0.0, 0.01, "left"),
                sp("top", 0.0, 1.0, 0.0, 0.01, "top"),
                sp("right", 0.0, 1.0, 1.0, 0.01, "right"),
                sp("bottom", 0.0, 1.0, 1.0, 0.01, "bottom"),
            ],
        },
        FilterDef {
            filter_type: Lut3d,
            kind: "lut3d",
            ffmpeg_filter: "lut3d",
            display: "LUT 调色",
            schema: vec![
                sp("intensity", 0.0, 1.0, 1.0, 0.01, "intensity"),
            ],
        },
        FilterDef {
            filter_type: Equalizer,
            kind: "equalizer",
            ffmpeg_filter: "equalizer",
            display: "音频均衡器",
            schema: vec![
                sp("frequency", 20.0, 20000.0, 1000.0, 1.0, "frequency"),
                sp("width", 10.0, 10000.0, 200.0, 1.0, "width"),
                sp("gain", -20.0, 20.0, 0.0, 0.1, "gain"),
            ],
        },
        FilterDef {
            filter_type: ChromaKey,
            kind: "chromakey",
            ffmpeg_filter: "chromakey",
            display: "色度抠图",
            schema: vec![
                sp("hue", 0.0, 360.0, 120.0, 0.1, "hue"),
                sp("similarity", 0.0, 1.0, 0.1, 0.01, "similarity"),
                sp("blend", 0.0, 1.0, 0.0, 0.01, "blend"),
            ],
        },
    ]
}

/// 构造 FilterParamSchema 的辅助函数
fn sp(name: &'static str, min: f64, max: f64, default: f64, step: f64, ffmpeg_key: &'static str) -> FilterParamSchema {
    FilterParamSchema { name: name.to_string(), min, max, default, step, ffmpeg_key }
}

/// 按 kind 字符串查找滤镜定义
pub fn lookup(kind: &str) -> Option<&'static FilterDef> {
    registry().iter().find(|d| d.kind == kind)
}

// ════════════════════ 片段效果/蒙版/滤镜实例 ════════════════════

fn default_enabled() -> bool {
    true
}

/// 片段级特效（与滤镜类似，作用于 Effect Stack）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Effect {
    pub kind: String,
    #[serde(default)]
    pub params: HashMap<String, f64>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// 蒙版（片段透明度形状）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mask {
    pub shape: String,
    #[serde(default)]
    pub params: HashMap<String, f64>,
    #[serde(default)]
    pub invert: bool,
    #[serde(default)]
    pub feather: f64,
}

/// 滤镜实例（来自 Clip.filters）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterInstance {
    pub kind: String,
    #[serde(default)]
    pub params: HashMap<String, f64>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// 浮点格式化：去掉多余尾零，空结果回退 "0"
fn fmt(v: f64) -> String {
    let s = format!("{:.4}", v);
    let t = s.trim_end_matches('0').trim_end_matches('.');
    if t.is_empty() {
        "0".to_string()
    } else {
        t.to_string()
    }
}

fn clamp(v: f64, min: f64, max: f64) -> f64 {
    v.max(min).min(max)
}

/// 将单个滤镜实例构建为 FFmpeg 滤镜串，应用降级逻辑。
/// 返回 None 表示该滤镜缺失且应跳过（如 mask）；返回 Some 为最终滤镜串。
pub fn build_filter_spec(kind: &str, params: &HashMap<String, f64>) -> Option<String> {
    let def = lookup(kind)?;

    // ── 特殊滤镜：需要非标准参数处理 ──
    match kind {
        "flip" => {
            let h = params.get("horizontal").copied().unwrap_or(1.0) > 0.5;
            let v = params.get("vertical").copied().unwrap_or(0.0) > 0.5;
            return match (h, v) {
                (true, true) => Some("hflip,vflip".to_string()),
                (true, false) => Some("hflip".to_string()),
                (false, true) => Some("vflip".to_string()),
                _ => None,
            };
        }
        "lut3d" => {
            let _intensity = params.get("intensity").copied().unwrap_or(1.0);
            // 注：LUT 文件路径需由前端传入，此处使用占位符
            return Some("lut3d=file=LUT_PATH:interp=tetrahedral".to_string());
        }
        "crop" => {
            // 归一化坐标 → 像素坐标在 build_video_chain 中处理
            // 此处生成 crop filter 模板，实际值由调用方替换
            let left = params.get("left").copied().unwrap_or(0.0);
            let top = params.get("top").copied().unwrap_or(0.0);
            let right = params.get("right").copied().unwrap_or(1.0);
            let bottom = params.get("bottom").copied().unwrap_or(1.0);
            let cw = (right - left).max(0.01);
            let ch = (bottom - top).max(0.01);
            return Some(format!("crop=iw*{:.4}:ih*{:.4}:iw*{:.4}:ih*{:.4}", cw, ch, left, top));
        }
        "equalizer" => {
            // 音频滤镜：频率/宽度/增益
            let freq = params.get("frequency").copied().unwrap_or(1000.0);
            let width = params.get("width").copied().unwrap_or(200.0);
            let gain = params.get("gain").copied().unwrap_or(0.0);
            return Some(format!("equalizer=f={}:t=q:w={}:g={}", fmt(freq), fmt(width), fmt(gain)));
        }
        "chromakey" => {
            let _hue = params.get("hue").copied().unwrap_or(120.0);
            let similarity = params.get("similarity").copied().unwrap_or(0.1);
            let blend = params.get("blend").copied().unwrap_or(0.0);
            return Some(format!("chromakey=0x00FF00:similarity={}:blend={}", fmt(similarity), fmt(blend)));
        }
        _ => {}
    }

    // ── 标准滤镜：schema 驱动 ──
    match ffmpeg::degrade_filter(def.ffmpeg_filter) {
        None => None,
        Some(replacement) => {
            if replacement != def.ffmpeg_filter {
                return Some(replacement);
            }
            let mut parts = Vec::new();
            for s in &def.schema {
                let raw = params.get(&s.name).copied().unwrap_or(s.default);
                let v = clamp(raw, s.min, s.max);
                parts.push(format!("{}={}", s.ffmpeg_key, fmt(v)));
            }
            Some(format!("{}={}", def.ffmpeg_filter, parts.join(":")))
        }
    }
}

/// 将 Mask 数据结构转换为 FFmpeg 滤镜串。
/// 线性蒙版 → crop+overlay；圆形蒙版 → geq 表达式生成 alpha
pub fn build_mask_spec(mask: &Mask) -> Option<String> {
    if mask.shape.is_empty() {
        return None;
    }
    match mask.shape.as_str() {
        "linear" => {
            let _feather = mask.feather.max(0.0).min(1.0);
            // 线性蒙版简化为调整透明度 + 羽化
            if mask.invert {
                Some(format!("colorchannelmixer=aa={}", fmt(1.0 - mask.params.get("opacity").copied().unwrap_or(0.5))))
            } else {
                Some(format!("colorchannelmixer=aa={}", fmt(mask.params.get("opacity").copied().unwrap_or(1.0))))
            }
        }
        "circle" => {
            let _feather = mask.feather.max(0.0);
            let cx = mask.params.get("cx").copied().unwrap_or(0.5);
            let cy = mask.params.get("cy").copied().unwrap_or(0.5);
            let r = mask.params.get("radius").copied().unwrap_or(0.3);
            if mask.invert {
                Some(format!("geq=r='if(gt((X/W-{})^2+(Y/H-{})^2,{}^2),r(X,Y),0)':g='if(gt((X/W-{cx})^2+(Y/H-{cy})^2,{r}^2),g(X,Y),0)':b='if(gt((X/W-{cx})^2+(Y/H-{cy})^2,{r}^2),b(X,Y),0)'",
                    fmt(cx), fmt(cy), fmt(r)))
            } else {
                Some(format!("geq=r='if(lt((X/W-{})^2+(Y/H-{})^2,{}^2),r(X,Y),0)':g='if(lt((X/W-{cx})^2+(Y/H-{cy})^2,{r}^2),g(X,Y),0)':b='if(lt((X/W-{cx})^2+(Y/H-{cy})^2,{r}^2),b(X,Y),0)'",
                    fmt(cx), fmt(cy), fmt(r)))
            }
        }
        _ => None,
    }
}

/// 合并片段上所有启用滤镜为一个滤镜串（以 `,` 连接）
pub fn build_clip_filters(clip: &Clip) -> Option<String> {
    let mut specs = Vec::new();
    for f in &clip.filters {
        if !f.enabled {
            continue;
        }
        if let Some(s) = build_filter_spec(&f.kind, &f.params) {
            specs.push(s);
        }
    }
    for e in &clip.effects {
        if !e.enabled {
            continue;
        }
        if let Some(s) = build_filter_spec(&e.kind, &e.params) {
            specs.push(s);
        }
    }
    if specs.is_empty() {
        None
    } else {
        Some(specs.join(","))
    }
}

// ════════════════════ 预置风格包 ════════════════════

/// 预置中的一个滤镜条目
pub struct PresetEntry {
    pub kind: &'static str,
    pub params: &'static [(&'static str, f64)],
}

/// 风格包（一组滤镜参数）
pub struct PresetPack {
    pub name: &'static str,
    pub display: &'static str,
    pub filters: &'static [PresetEntry],
}

/// 内置滤镜预置（电影感 / 日系 / 复古 / 清爽 / 黑白）
pub const FILTER_PRESETS: &[PresetPack] = &[
    PresetPack {
        name: "cinematic",
        display: "电影感",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", -0.05), ("contrast", 1.2), ("saturation", 0.9)] },
            PresetEntry { kind: "fade", params: &[("type", 0.0), ("duration", 0.4)] },
        ],
    },
    PresetPack {
        name: "japanese",
        display: "日系",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", 0.08), ("contrast", 0.9), ("saturation", 1.1)] },
        ],
    },
    PresetPack {
        name: "vintage",
        display: "复古",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", 0.02), ("contrast", 0.95), ("saturation", 0.8), ("gamma", 1.1)] },
        ],
    },
    PresetPack {
        name: "fresh",
        display: "清爽",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("brightness", 0.05), ("contrast", 1.05), ("saturation", 1.15)] },
        ],
    },
    PresetPack {
        name: "mono",
        display: "黑白",
        filters: &[
            PresetEntry { kind: "coloradjust", params: &[("saturation", 0.0), ("contrast", 1.1)] },
        ],
    },
];

/// 返回可用预置名列表（供 N-API get_preset_list）
pub fn preset_names() -> Vec<String> {
    FILTER_PRESETS.iter().map(|p| p.name.to_string()).collect()
}

/// 返回预置展示名列表
pub fn preset_displays() -> Vec<String> {
    FILTER_PRESETS.iter().map(|p| p.display.to_string()).collect()
}

/// 按名查找预置包
pub fn find_preset(name: &str) -> Option<&'static PresetPack> {
    FILTER_PRESETS.iter().find(|p| p.name == name)
}

// ════════════════════ 曲线变速 ════════════════════

/// 从 SpeedPoint 数组构建分段线性 setpts 表达式。
/// 控制点 [(src0,play0), (src1,play1), ...] 定义源时间→播放时间的映射。
/// 例：[(0,0), (2,1), (5,5)] → if(lt(T,2), 0.5*PTS, if(lt(T,5), 1.333*PTS-1.667, PTS))
pub fn build_speed_curve_expr(points: &[crate::project::SpeedPoint]) -> Option<String> {
    if points.len() < 2 {
        return None;
    }
    let last = points.len() - 1;
    // 最后一段作为默认
    let pf = &points[last];
    let pn = &points[last - 1];
    let dt_f = pf.src - pn.src;
    let dp_f = pf.play - pn.play;
    let rate_f = if dt_f.abs() > 1e-6 { dp_f / dt_f } else { 1.0 };
    let offset_f = pf.play - rate_f * pf.src;

    let mut expr = format!("{}*PTS", fmt(rate_f));
    if offset_f.abs() > 1e-6 {
        expr.push_str(&format!("{:+}", offset_f));
    }

    // 逐段包裹 if(lt(T, boundary), segment_expr, outer)
    for i in (1..points.len() - 1).rev() {
        let p0 = &points[i - 1];
        let p1 = &points[i];
        let dt = p1.src - p0.src;
        let dp = p1.play - p0.play;
        if dt.abs() < 1e-6 {
            continue;
        }
        let rate = dp / dt;
        let offset = p0.play - rate * p0.src;
        let mut seg = format!("{}*PTS", fmt(rate));
        if offset.abs() > 1e-6 {
            seg.push_str(&format!("{:+}", offset));
        }
        expr = format!("if(lt(T,{}),{},{}))", fmt(p1.src), seg, expr);
    }
    Some(expr)
}

// ════════════════════ FilterGraphBuilder ════════════════════

/// 从关键帧轨道采样属性值；无关键帧则回退 base。
/// 注：由于 FFmpeg filter_complex 是静态图，关键帧动画通过帧级表达式（如
/// colorchannelmixer=aa='expr'）实现更精确。当前采样取 clip 中位时间作为近似。
fn keyframed(clip: &Clip, path: &str, base: f64) -> f64 {
    clip.keyframes
        .get(path)
        .map(|t| {
            let mid = (clip.timeline_in + clip.timeline_out) * 0.5;
            t.sample(mid)
        })
        .unwrap_or(base)
}

/// 构建单个视频片段的滤镜链，返回标签名
fn build_clip_chain(
    c: &Clip,
    ci: usize,
    asset_to_idx: &HashMap<String, usize>,
    w: u32,
    h: u32,
    nodes: &mut Vec<String>,
) -> String {
    let idx = *asset_to_idx.get(&c.asset_id).unwrap_or(&0);
    let label = format!("vs{}", ci);
    let chain = build_video_chain(c, idx, w, h, &label);
    nodes.push(chain);
    label
}

/// 对单个片段构造 FFmpeg 视频滤镜串：[N:v]scale=W:H[,setpts=...][,rotate=...][,filters][,colorchannelmixer][label]
fn build_video_chain(c: &Clip, idx: usize, w: u32, h: u32, label: &str) -> String {
    let sx = keyframed(c, "transform.scaleX", c.transform.scale_x).max(0.01);
    let sy = keyframed(c, "transform.scaleY", c.transform.scale_y).max(0.01);
    let sw = (w as f64 * sx).round() as u32;
    let sh = (h as f64 * sy).round() as u32;

    let mut chain = format!("[{}:v]scale={}:{}", idx, sw, sh);

    // 曲线变速优先，否则线性变速
    if let Some(expr) = build_speed_curve_expr(&c.speed_curve) {
        chain.push_str(&format!(",setpts={}", expr));
    } else if (c.speed - 1.0).abs() > 0.001 {
        chain.push_str(&format!(",setpts={}*PTS", fmt(1.0 / c.speed)));
    }
    let rot = keyframed(c, "transform.rotation", c.transform.rotation);
    if rot.abs() > 0.01 {
        chain.push_str(&format!(",rotate={}*PI/180", fmt(rot)));
    }

    let clip_filters = build_clip_filters(c).unwrap_or_default();
    if !clip_filters.is_empty() {
        chain.push_str(&format!(",{}", clip_filters));
    }
    // 蒙版处理：对每个蒙版生成 mask 滤镜串
    for mask in &c.masks {
        if let Some(s) = build_mask_spec(mask) {
            chain.push_str(&format!(",{}", s));
        }
    }
    let opacity = keyframed(c, "transform.opacity", c.transform.opacity).clamp(0.0, 1.0);
    if opacity < 1.0 {
        chain.push_str(&format!(",colorchannelmixer=aa={}", fmt(opacity)));
    }
    chain.push_str(&format!("[{}]", label));
    chain
}

fn offset_x(c: &Clip, w: u32) -> i64 {
    let x = keyframed(c, "transform.x", c.transform.x);
    ((x - 0.5) * w as f64).round() as i64
}

fn offset_y(c: &Clip, h: u32) -> i64 {
    let y = keyframed(c, "transform.y", c.transform.y);
    ((0.5 - y) * h as f64).round() as i64
}

/// 滤镜图构建器：将工程（轨道 + 片段 + 滤镜）组合为 FFmpeg RenderCommand。
/// 按「轨道从底到顶、同轨片段顺序拼接（含 xfade 过渡）」构建视频图层。
pub struct FilterGraphBuilder;

impl FilterGraphBuilder {
    /// 主入口：解析工程 → 构建渲染命令
    pub fn build(project: &Project) -> ffmpeg::RenderCommand {
        build_render_command(project)
    }
}

/// 核心：构建 RenderCommand（供 N-API render 调用）
pub fn build_render_command(project: &Project) -> ffmpeg::RenderCommand {
    let mut cmd = ffmpeg::RenderCommand::default();
    let (w, h) = (project.canvas.width, project.canvas.height);
    cmd.resolution = (w, h);
    cmd.fps = project.canvas.fps;
    cmd.bitrate = ffmpeg::bitrate_for_resolution((w, h));

    // 轨道按 order 升序（底→顶）
    let mut sorted: Vec<&Track> = project.tracks.iter().collect();
    sorted.sort_by_key(|t| t.order);

    let mut video_clips: Vec<(usize, &Clip)> = Vec::new();  // (track_order, clip)
    let mut audio_clips: Vec<&Clip> = Vec::new();
    for t in &sorted {
        for c in &t.clips {
            if t.track_type == "audio" {
                audio_clips.push(c);
            } else {
                video_clips.push((t.order as usize, c));
            }
        }
    }

    // 去重输入：asset_id → 输入序号（视频+音频共用索引）
    let mut asset_to_idx: HashMap<String, usize> = HashMap::new();
    let mut inputs: Vec<String> = Vec::new();
    for (_, c) in &video_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) {
                asset_to_idx.insert(a.id.clone(), inputs.len());
                inputs.push(a.path.clone());
            }
        }
    }
    for c in &audio_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) {
                asset_to_idx.insert(a.id.clone(), inputs.len());
                inputs.push(a.path.clone());
            }
        }
    }
    cmd.inputs = inputs;

    let mut nodes: Vec<String> = Vec::new();

    // ── 视频滤镜图 ──
    // 分组：按 track_order 归类视频片段（同轨顺序 = clips 数组顺序）
    let video_tracks: Vec<(usize, Vec<&Clip>)> = {
        let mut groups: HashMap<usize, Vec<&Clip>> = HashMap::new();
        for (order, c) in &video_clips {
            groups.entry(*order).or_default().push(c);
        }
        let mut entries: Vec<_> = groups.into_iter().collect();
        entries.sort_by_key(|(k, _)| *k);
        entries
    };

    let mut vout_label = String::new();
    if !video_tracks.is_empty() {
        nodes.push(format!("color=c=black:s={}x{}:d=1[base]", w, h));
        let mut acc = "base".to_string();
        let mut vci = 0usize; // global video clip counter

        for (track_order, clips) in &video_tracks {
            if clips.is_empty() {
                continue;
            }
            if clips.len() == 1 {
                // 单片段轨道：直接 overlay
                let c = clips[0];
                let idx = *asset_to_idx.get(&c.asset_id).unwrap_or(&0);
                let src = format!("vs{}", vci);
                let chain = build_video_chain(c, idx, w, h, &src);
                nodes.push(chain);
                let next_acc = format!("va{}", vci + 1);
                let ox = offset_x(c, w);
                let oy = offset_y(c, h);
                nodes.push(format!("[{}][{}]overlay=x={}:y={}:shortest=1[{}]", acc, src, ox, oy, next_acc));
                acc = next_acc;
                vci += 1;
            } else {
                // 多片段轨道：顺序链 + 交叉过渡（xfade）
                let mut track_acc = build_clip_chain(clips[0], vci, &asset_to_idx, w, h, &mut nodes);
                vci += 1;

                for ci in 1..clips.len() {
                    let prev = clips[ci - 1];
                    let curr = clips[ci];
                    let gap = curr.timeline_in - prev.timeline_out;

                    let has_transition = prev.filters.iter().any(|f| f.kind == "transition" && f.enabled)
                        || curr.filters.iter().any(|f| f.kind == "transition" && f.enabled);

                    let curr_label = build_clip_chain(curr, vci, &asset_to_idx, w, h, &mut nodes);
                    vci += 1;

                    if has_transition && gap <= 0.0 {
                        // xfade：前一片段尾与当前片段头重叠
                        let xdur = (-gap).min(1.0).max(0.1);
                        // 提取转场类型：从 transition filter 的 params 读取 "style" 字段
                        let xstyle = prev.filters.iter()
                            .chain(curr.filters.iter())
                            .find(|f| f.kind == "transition" && f.enabled)
                            .and_then(|f| f.params.get("style"))
                            .map(|&s| {
                                match s as i32 {
                                    1 => "dissolve", 2 => "wipeleft", 3 => "wiperight",
                                    4 => "wipeup", 5 => "wipedown", 6 => "slideleft",
                                    7 => "slideright", 8 => "slideup", 9 => "slidedown",
                                    _ => "fade",
                                }
                            })
                            .unwrap_or("fade");
                        let merged = format!("x{}", vci);
                        nodes.push(format!("[{}][{}]xfade=transition={}:duration={}:offset={}:fps={}[{}]",
                            track_acc, curr_label, xstyle, fmt(xdur),
                            fmt((prev.timeline_out - prev.timeline_in) - xdur),
                            project.canvas.fps,
                            merged));
                        track_acc = merged;
                    } else {
                        // 无过渡：concat
                        let merged = format!("x{}", vci);
                        nodes.push(format!("[{}][{}]concat=n=2:v=1:a=0[{}]", track_acc, curr_label, merged));
                        track_acc = merged;
                    }
                }

                // 将整轨 overlay 到累积画布上
                let next_acc = format!("va{}", vci + 1);
                // 第一轨直接替换 base，后续轨 overlay
                if *track_order == 0 && acc == "base" {
                    // 主轨：替换 base
                    nodes.push(format!("[{}]null[{}]", track_acc, next_acc));
                } else {
                    let ox = 0i64;
                    let oy = 0i64;
                    nodes.push(format!("[{}][{}]overlay=x={}:y={}:shortest=1[{}]", acc, track_acc, ox, oy, next_acc));
                }
                acc = next_acc;
            }
        }
        vout_label = format!("[{}]", acc);
    }

    // ── 音频滤镜图 ──
    let mut aout_label = String::new();
    if !audio_clips.is_empty() {
        let mut audio_parts: Vec<String> = Vec::new();
        for (ai, c) in audio_clips.iter().enumerate() {
            let idx = match asset_to_idx.get(&c.asset_id) {
                Some(i) => *i,
                None => continue,
            };
            let alabel = format!("a{}", ai);
            let mut achain = format!("[{}:a]", idx);
            // 音量（支持关键帧采样）
            let vol = keyframed(c, "volume", c.volume).clamp(0.0, 2.0);
            if (vol - 1.0).abs() > 0.01 {
                achain.push_str(&format!("volume={}", fmt(vol)));
            } else {
                achain.push_str("anull");
            }
            // 变速（atempo）
            if (c.speed - 1.0).abs() > 0.001 {
                let tempo = c.speed.clamp(0.5, 2.0);
                achain.push_str(&format!(",atempo={}", fmt(tempo)));
            }
            achain.push_str(&format!("[{}]", alabel));
            audio_parts.push(achain);
        }
        if audio_parts.len() == 1 {
            aout_label = format!("[a0]");
        } else {
            // 混音
            let mut mix_inputs = Vec::new();
            for ai in 0..audio_parts.len() {
                mix_inputs.push(format!("[a{}]", ai));
            }
            audio_parts.push(format!("{}amix=inputs={}:duration=first[aout]",
                mix_inputs.join(""),
                mix_inputs.len()));
            aout_label = "[aout]".to_string();
        }
        nodes.extend(audio_parts);
    }

    cmd.filter_graph = nodes.join(";");
    let map_label = format!("{}{}", vout_label, aout_label);
    if !map_label.is_empty() {
        cmd.map_label = Some(map_label);
    }
    cmd
}

/// 解析工程 JSON → 构建 FFmpeg 命令字符串
pub fn render_project_json(json: &str) -> anyhow::Result<String> {
    let project: Project =
        serde_json::from_str(json).map_err(|e| anyhow::anyhow!("工程 JSON 解析失败: {}", e))?;
    let cmd = build_render_command(&project);
    Ok(cmd.to_command_string())
}

/// 可用滤镜预置名列表（N-API get_preset_list）
pub fn get_preset_list() -> Vec<String> {
    preset_names()
}

/// 版本字符串
pub fn engine_version() -> String {
    format!("aicut-engine {}", env!("CARGO_PKG_VERSION"))
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── 缓动函数 ──

    #[test]
    fn test_easing_bezier_linear() {
        let (x1, y1, x2, y2) = Easing::Linear.as_bezier();
        assert_eq!((x1, y1, x2, y2), (0.0, 0.0, 1.0, 1.0));
    }

    #[test]
    fn test_cubic_bezier_boundaries() {
        // x=0 → y=0, x=1 → y=1 (任何贝塞尔)
        for e in &[Easing::Linear, Easing::EaseIn, Easing::EaseOut, Easing::EaseInOut] {
            let y0 = apply_easing(*e, 0.0);
            let y1 = apply_easing(*e, 1.0);
            assert!((y0 - 0.0).abs() < 0.001, "{:?} at 0: {}", e, y0);
            assert!((y1 - 1.0).abs() < 0.001, "{:?} at 1: {}", e, y1);
        }
    }

    #[test]
    fn test_easing_monotonic() {
        // 缓动函数应单调递增
        for e in &[Easing::Linear, Easing::EaseIn, Easing::EaseOut, Easing::EaseInOut] {
            let mut prev = 0.0;
            for i in 1..=20 {
                let x = i as f64 / 20.0;
                let y = apply_easing(*e, x);
                assert!(y >= prev - 0.001, "{:?} non-monotonic at x={}", e, x);
                prev = y;
            }
        }
    }

    // ── 关键帧轨道 ──

    #[test]
    fn test_keyframe_single() {
        let track = KeyframeTrack {
            keyframes: vec![Keyframe { time: 0.0, value: 42.0, easing: Easing::Linear }],
        };
        assert!((track.sample(0.0) - 42.0).abs() < 0.001);
        assert!((track.sample(5.0) - 42.0).abs() < 0.001);
    }

    #[test]
    fn test_keyframe_linear_interpolation() {
        let track = KeyframeTrack {
            keyframes: vec![
                Keyframe { time: 0.0, value: 0.0, easing: Easing::Linear },
                Keyframe { time: 2.0, value: 100.0, easing: Easing::Linear },
            ],
        };
        assert!((track.sample(1.0) - 50.0).abs() < 0.01);
        assert!((track.sample(0.0) - 0.0).abs() < 0.01);
        assert!((track.sample(2.0) - 100.0).abs() < 0.01);
    }

    #[test]
    fn test_keyframe_binary_search() {
        // 10个关键帧，验证二分查找正确插值
        let mut kfs: Vec<Keyframe> = (0..10).map(|i| Keyframe {
            time: i as f64,
            value: (i * 10) as f64,
            easing: Easing::Linear,
        }).collect();
        let track = KeyframeTrack { keyframes: kfs };
        assert!((track.sample(4.5) - 45.0).abs() < 0.01);
        assert!((track.sample(0.0) - 0.0).abs() < 0.01);
        assert!((track.sample(9.0) - 90.0).abs() < 0.01);
        // 超出范围：clamp 到首尾
        assert!((track.sample(-1.0) - 0.0).abs() < 0.01);
        assert!((track.sample(99.0) - 90.0).abs() < 0.01);
    }

    #[test]
    fn test_keyframe_empty_track() {
        let track = KeyframeTrack::new();
        assert!(track.is_empty());
        assert!((track.sample(5.0) - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_keyframe_ease_out() {
        let track = KeyframeTrack {
            keyframes: vec![
                Keyframe { time: 0.0, value: 0.0, easing: Easing::Linear },
                Keyframe { time: 2.0, value: 100.0, easing: Easing::EaseOut },
            ],
        };
        // EaseOut 中点应 > 50（缓出：开始快、结束慢，所以前半段进度 > 线性）
        let mid = track.sample(1.0);
        assert!(mid > 50.0, "EaseOut 中点应 > 50，实际: {}", mid);
        // 端点应准确
        assert!((track.sample(0.0) - 0.0).abs() < 0.01);
        assert!((track.sample(2.0) - 100.0).abs() < 0.01);
    }

    // ── 滤镜降级矩阵 ──

    #[test]
    fn test_degrade_eq_unavailable() {
        // eq 不可用时 → brightness/contrast 退化版
        let result = ffmpeg::degrade_filter("eq");
        // 取决于沙盒 ffmpeg 是否可用 eq
        assert!(result.is_some(), "degrade_filter 不应返回 None");
        let s = result.unwrap();
        assert!(s == "eq" || s == "brightness=0:contrast=1",
            "eq 应保持或降级为 brightness，实际: {}", s);
    }

    #[test]
    fn test_degrade_mask_unavailable() {
        let result = ffmpeg::degrade_filter("mask");
        // mask 不可用时 → None（跳过）
        match result {
            None => {} // 预期的降级路径
            Some(s) => assert_eq!(s, "mask", "mask 可用时应保持原名"),
        }
    }

    #[test]
    fn test_degrade_format_always_available() {
        let result = ffmpeg::degrade_filter("format");
        assert_eq!(result, Some("format=yuv420p".to_string()));
    }

    #[test]
    fn test_degrade_pass_through() {
        // 未知滤镜：原样返回
        assert_eq!(ffmpeg::degrade_filter("scale"), Some("scale".to_string()));
        assert_eq!(ffmpeg::degrade_filter("overlay"), Some("overlay".to_string()));
        assert_eq!(ffmpeg::degrade_filter("hflip"), Some("hflip".to_string()));
    }

    // ── 滤镜注册表 ──

    #[test]
    fn test_registry_all_kinds_lookup() {
        for kind in &["coloradjust", "croprotate", "speed", "mask", "transition",
                       "text", "volume", "fade", "flip", "crop", "lut3d", "equalizer", "chromakey"] {
            let def = lookup(kind);
            assert!(def.is_some(), "滤镜 kind '{}' 应在注册表中", kind);
        }
    }

    #[test]
    fn test_registry_unknown_kind() {
        assert!(lookup("nonexistent_filter_xyz").is_none());
    }

    // ── 辅助函数 ──

    #[test]
    fn test_fmt_formatting() {
        assert_eq!(fmt(1.0), "1");
        assert_eq!(fmt(0.5), "0.5");
        assert_eq!(fmt(0.0), "0");
        assert_eq!(fmt(1.23456), "1.2346");
        assert_eq!(fmt(0.333333), "0.3333");
    }

    #[test]
    fn test_clamp() {
        assert!((clamp(0.5, 0.0, 1.0) - 0.5).abs() < 0.001);
        assert!((clamp(-1.0, 0.0, 1.0) - 0.0).abs() < 0.001);
        assert!((clamp(2.0, 0.0, 1.0) - 1.0).abs() < 0.001);
    }
}

