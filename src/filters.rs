//! src/filters.rs — 滤镜/特效系统
//! 滤镜定义/注册表、构建器、预置包、渲染图构建。

use crate::ffmpeg;
use crate::keyframe::apply_easing;
use crate::plugin::PluginManager;
use crate::project::{Clip, Project, Track};
use crate::types::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::OnceLock;

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
    Denoise,
    Curves,
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
        FilterDef {
            filter_type: Denoise,
            kind: "denoise",
            ffmpeg_filter: "afftdn",
            display: "音频降噪",
            schema: vec![
                sp("noise_reduction", 0.0, 100.0, 12.0, 0.1, "nr"),
                sp("noise_floor", -80.0, 0.0, -50.0, 0.1, "nf"),
            ],
        },
        FilterDef {
            filter_type: Curves,
            kind: "curves",
            ffmpeg_filter: "curves",
            display: "曲线调色",
            schema: vec![
                sp("master_contrast", 0.0, 2.0, 1.0, 0.01, "master"),
                sp("red_contrast", 0.0, 2.0, 1.0, 0.01, "red"),
                sp("green_contrast", 0.0, 2.0, 1.0, 0.01, "green"),
                sp("blue_contrast", 0.0, 2.0, 1.0, 0.01, "blue"),
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

// ════════════════════ 浮点工具 ════════════════════

/// 浮点格式化：去掉多余尾零，空结果回退 "0"
pub(crate) fn fmt(v: f64) -> String {
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

/// HSV hue (0-360) → FFmpeg hex color (e.g. 0x00FF00 for green at 120)
fn hue_to_ffmpeg_color(hue: f64) -> String {
    let h = hue % 360.0;
    let (r, g, b) = if h < 60.0 { (255, (h * 4.25) as u8, 0) }
    else if h < 120.0 { (((120.0 - h) * 4.25) as u8, 255, 0) }
    else if h < 180.0 { (0, 255, ((h - 120.0) * 4.25) as u8) }
    else if h < 240.0 { (0, ((240.0 - h) * 4.25) as u8, 255) }
    else if h < 300.0 { (((h - 240.0) * 4.25) as u8, 0, 255) }
    else { (255, 0, ((360.0 - h) * 4.25) as u8) };
    format!("0x{:02X}{:02X}{:02X}", r, g, b)
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
            // LUT 文件路径：优先从 params["file"] (浮点→路径需前端处理)，
            // 或从环境变量 AICUT_LUT_PATH 读取默认路径
            let lut_path = std::env::var("AICUT_LUT_PATH")
                .unwrap_or_else(|_| "lut.cube".to_string());
            let intensity = params.get("intensity").copied().unwrap_or(1.0);
            return Some(format!("lut3d=file={}:interp=tetrahedral", lut_path));
        }
        "curves" => {
            // FFmpeg curves 格式: curves=master='0/0 0.5/0.5 1/1':red='...'
            let master = params.get("master_contrast").copied().unwrap_or(1.0);
            let red = params.get("red_contrast").copied().unwrap_or(1.0);
            let green = params.get("green_contrast").copied().unwrap_or(1.0);
            let blue = params.get("blue_contrast").copied().unwrap_or(1.0);
            let mid = 0.5 / master.max(0.01);
            return Some(format!(
                "curves=master='0/0 {}/{} 1/1':red='0/0 {}/{} 1/1':green='0/0 {}/{} 1/1':blue='0/0 {}/{} 1/1'",
                fmt(mid), fmt(mid), fmt(mid), fmt(mid), fmt(mid), fmt(mid), fmt(mid), fmt(mid)
            ));
        }
        "denoise" => {
            let nr = params.get("noise_reduction").copied().unwrap_or(12.0);
            let nf = params.get("noise_floor").copied().unwrap_or(-50.0);
            return Some(format!("afftdn=nr={}:nf={}", fmt(nr), fmt(nf)));
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
            let hue = params.get("hue").copied().unwrap_or(120.0);
            let similarity = params.get("similarity").copied().unwrap_or(0.1);
            let blend = params.get("blend").copied().unwrap_or(0.0);
            // HSV hue → approximate RGB hex for chromakey
            let color = hue_to_ffmpeg_color(hue);
            return Some(format!("chromakey={}:similarity={}:blend={}", color, fmt(similarity), fmt(blend)));
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
            let feather = mask.feather.max(0.0).min(1.0);
            let base_alpha = mask.params.get("opacity").copied().unwrap_or(1.0);
            let alpha = base_alpha * (1.0 - feather * 0.5); // 羽化降低整体透明度
            if mask.invert {
                Some(format!("colorchannelmixer=aa={}", fmt((1.0 - alpha).max(0.0))))
            } else {
                Some(format!("colorchannelmixer=aa={}", fmt(alpha)))
            }
        }
        "circle" => {
            let feather = mask.feather.max(0.0);
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

/// 进程级插件管理器（懒加载，读 AICUT_PLUGIN_DIR，回退 cwd/plugins）。
fn plugin_manager() -> &'static PluginManager {
    static MGR: OnceLock<PluginManager> = OnceLock::new();
    MGR.get_or_init(|| {
        let dir = PathBuf::from(env::var("AICUT_PLUGIN_DIR").unwrap_or_else(|_| "plugins".into()));
        let mut mgr = PluginManager::new(dir);
        let _ = mgr.scan();
        mgr
    })
}

/// 合并片段上所有启用滤镜为一个滤镜串（以 `,` 连接）
pub fn build_clip_filters(clip: &Clip) -> Option<String> {
    let mut specs = Vec::new();
    for f in &clip.filters {
        if !f.enabled {
            continue;
        }
        // transition 是 clip 间的合并操作（xfade），不是单 clip 滤镜，单 clip 链里不能生成 xfade
        if f.kind == "transition" {
            continue;
        }
        if plugin_manager().get(&f.kind).is_some() {
            if let Ok(s) = plugin_manager().build_filter(&f.kind, &f.params) {
                if !s.is_empty() {
                    specs.push(s);
                }
            }
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
        if e.kind == "transition" {
            continue;
        }
        if plugin_manager().get(&e.kind).is_some() {
            if let Ok(s) = plugin_manager().build_filter(&e.kind, &e.params) {
                if !s.is_empty() {
                    specs.push(s);
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

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

