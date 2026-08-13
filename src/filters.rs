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
/// 线性(linear) → geq 沿 angle 方向的渐变带（中心可见、两端渐隐）；
/// 圆形(circle) → geq 以 (x,y) 为中心的距离场遮罩；
/// 矩形(rect) → geq 圆角矩形距离场遮罩（支持羽化/反转/圆角/旋转）；
/// 镜面(mirror) → geq 带 angle 的对称渐变带（中心透明、两端可见）；
/// 多边形(polygon) / 星形(star) → geq 极坐标有符号距离场遮罩。
///
/// 几何语义与 gui/src/utils/maskRender.ts 前端预览精确一致：
///   circle : 中心 (x,y) 归一化、半径 radius 归一化（相对帧短边 min(w,h)）
///   linear : 以 (x,y) 为中心、angle 为渐变轴方向，half=width*min(W,H)，中心可见两端渐隐
///   mirror : 同 linear 几何，但相反——中心透明、两端可见
///   polygon/star : 中心 (x,y) 归一化、外接/外顶点半径 radius*min(W,H)；rotation=0 时
///                 第一个顶点指向正上方（屏幕顶部），正角度=顺时针；star 另有 innerRatio
///                 (内/外半径比 0..1) 与 sides（整数 ≥3）。
///
/// 自本增量起改用直通 alpha 通道（straight alpha）合成：
///   - output: geq=r='...':g='...':b='...':a='...'，alpha 通道由 overlay 做真 alpha 合成
///     (dst = src*rgb*src_alpha + base*(1-src_alpha))，不再依赖"黑遮罩技巧"。
///   - 羽化从单向内侧改为对称（clip(0.5-sd/fp)），边界 alpha=0.5 通过真合成自然半透明，
///     无黑环问题。
///   - 阴影从沿轮廓环（ring）改为偏移填充剪影（filled silhouette），
///     用大羽化半径模拟模糊扩散（blur=1 时软边扩至 0.5*minSide）。
///
/// 多蒙版：本函数接收该 clip 的全部蒙版，在**单一 geq** 中按 alpha-max 求并集
/// （a_union = max(a_1, a_2, ...)），与前端预览的 lighter 并集语义对齐。
///
/// 描边(stroke)/阴影(shadow) 自本增量起由带 alpha 通道的 geq 输出合成：
///   阴影先通过 (1-a_union) 因子叠加到直通 RGB，再取 alpha=max(a_union,shadowAlpha)；
///   描边在阴影之上用标准 straight-alpha over 合成。
///   顺序匹配前端 composeMaskedFrame（先 shadow 后 stroke）。
/// 蒙版滤镜构建结果。
/// - `geq`：单输入 geq 滤镜后缀（适用于 circle/rect/linear/mirror/polygon/star/heart 等
///   可用闭合表达式表示的形状），附加到主视频链后产出带 alpha 的视频。
/// - `image_masks`：需要外部/生成蒙版流的形状（text），每个是一项独立滤镜图语句
///   （生成带 alpha 的蒙版流，标签见 `label`）与合成步骤。
pub struct MaskSpec {
    pub geq: Option<String>,
    pub image_masks: Vec<ImageMask>,
}
/// 一个需要独立滤镜图语句生成的蒙版流（如文字 drawtext）。
pub struct ImageMask {
    /// 该蒙版流在滤镜图中的标签（如 "tx0"），合成时用 [vid][tx0]alphamerge[vid] 引用。
    pub label: String,
    /// 生成该蒙版流的完整滤镜图语句（以 `;` 分隔、内部自包含，最后定义出 `label` 流）。
    /// 蒙版流应为 RGBA，且以亮度(luma) 表示可见度（白字黑底 → luma=字形覆盖度），
    /// 因为 alphamerge 取第二路输入的 luma 作为 alpha。
    pub statement: String,
}

pub fn build_mask_spec(masks: &[Mask], w: u32, h: u32, fps: u32, dur: f64) -> Option<MaskSpec> {
    let mut base_exprs = Vec::new();
    for m in masks {
        if let Some(a) = mask_alpha_expr(m) {
            base_exprs.push(a);
        }
    }
    // 文字类蒙版走 drawtext 独立流，不入 geq 并集。
    let mut text_masks: Vec<ImageMask> = Vec::new();
    let mut ti = 0usize;
    for m in masks {
        if m.shape == "text" {
            if let Some(im) = build_text_mask(m, w, h, fps, dur, ti) {
                text_masks.push(im);
            }
            ti += 1;
        }
    }
    // alpha-max 并集：多蒙版取各蒙版 base alpha 的最大值（任一蒙版覆盖即可见）。
    let has_decor = masks.iter().any(|m| m.stroke.enabled || m.shadow.enabled);
    let has_base = !base_exprs.is_empty();
    if !has_base && text_masks.is_empty() && !has_decor {
        return None;
    }
    let a_union = if !has_base {
        "0".to_string()
    } else if base_exprs.len() == 1 {
        base_exprs.into_iter().next().unwrap()
    } else {
        let mut acc = base_exprs.pop().unwrap();
        while let Some(e) = base_exprs.pop() {
            acc = format!("max({}, {})", e, acc);
        }
        acc
    };
    // 分层合成（straight alpha）：内容保持原色，alpha 用并集蒙版做真合成；再叠阴影、再叠描边。
    // stroke/shadow 仅在 geq 形状里生效（text 蒙版本轮回退，只产出填充字形+羽化+反转）。
    let mut col_r = "r(X,Y)".to_string();
    let mut col_g = "g(X,Y)".to_string();
    let mut col_b = "b(X,Y)".to_string();
    let mut col_a = a_union.clone();
    for m in masks {
        // 阴影在描边之下（填充剪影贡献到 alpha，颜色通过 (1-a_union) 因子叠加到直通通道）
        if m.shadow.enabled {
            if let Some((sr, sg, sb, sa)) = build_shadow_terms(m) {
                col_r = format!("(({col_r})+({sr})*({sa})*(1-({au})))",
                    col_r = col_r, sr = sr, sa = sa, au = a_union);
                col_g = format!("(({col_g})+({sg})*({sa})*(1-({au})))",
                    col_g = col_g, sg = sg, sa = sa, au = a_union);
                col_b = format!("(({col_b})+({sb})*({sa})*(1-({au})))",
                    col_b = col_b, sb = sb, sa = sa, au = a_union);
                col_a = format!("max({col_a},{sa})", col_a = col_a, sa = sa);
            }
        }
        // 描边在上（标准 straight-alpha over 合成）
        if m.stroke.enabled {
            if let Some((tr, tg, tb, ta)) = build_stroke_terms(m) {
                col_r = format!("(({col_r})*(1-({ta}))+({tr})*({ta}))",
                    col_r = col_r, ta = ta, tr = tr);
                col_g = format!("(({col_g})*(1-({ta}))+({tg})*({ta}))",
                    col_g = col_g, ta = ta, tg = tg);
                col_b = format!("(({col_b})*(1-({ta}))+({tb})*({ta}))",
                    col_b = col_b, ta = ta, tb = tb);
                col_a = format!("(({col_a})*(1-({ta}))+({ta}))",
                    col_a = col_a, ta = ta);
            }
        }
    }
    // col_a is 0..1 float range from mask_alpha_expr; multiply by 255 for 8-bit RGBA alpha plane
    // geq 仅在存在 geq 形状（has_base）或存在描边/阴影合成（has_decor）时产出；
    // 纯文字蒙版（无 geq 形状、无装饰）时 geq 为 None，仅靠 image_masks + alphamerge 合成。
    let geq = if !has_base && !has_decor {
        None
    } else {
        Some(format!(
            "format=rgba,geq=r='{col_r}':g='{col_g}':b='{col_b}':a='({col_a})*255'"
        ))
    };
    Some(MaskSpec { geq, image_masks: text_masks })
}

/// 抠像滤镜构建结果。
/// - `filter`：chromakey 滤镜后缀（插入 video 链 core 与 tail 之间）；None 表示不抠像。
pub struct KeyingSpec {
    pub filter: Option<String>,
}

/// 将 KeyingConfig 转换为 FFmpeg chromakey 滤镜串（M1 仅支持 chroma 模式）。
/// - 非 enabled 或非 chroma 模式 → 返回 None（不挂载滤镜）。
/// - chromakey 接受 0xRRGGBB 颜色。
/// - 溢出抑制 spill：预览（keyingRender.ts）对保留像素按键色主通道去除绿/红/蓝溢光；
///   此前后端未实现 → 预览/导出不一致。此处用 ffmpeg `despill` 补齐，type 与预览一致
///   （按键色主通道选 green/red/blue），mix=spill（0..1 抑制强度）。spill<=0 时不挂滤镜，
///   保持与历史行为一致。
pub fn build_keying_spec(keying: &Option<KeyingConfig>, _w: u32, _h: u32) -> Option<KeyingSpec> {
    let k = match keying { Some(k) if k.enabled && k.mode == "chroma" => k, _ => return None };
    let hex = k.color.trim_start_matches('#');
    let color_arg = format!("0x{}", hex); // chromakey 接受 0xRRGGBB
    let sim = fmt(k.similarity);
    let blend = fmt(k.edge_softness);
    let mut f = format!("chromakey=color={}:similarity={}:blend={}", color_arg, sim, blend);
    if k.spill > 0.0 {
        // 解析键色主通道（与预览 keyingRender.ts 一致：green 优先，其次 red，否则 blue）
        let h = if hex.len() >= 6 { &hex[0..6] } else { "00ff00" };
        let cr = u8::from_str_radix(&h[0..2], 16).unwrap_or(0);
        let cg = u8::from_str_radix(&h[2..4], 16).unwrap_or(0);
        let cb = u8::from_str_radix(&h[4..6], 16).unwrap_or(0);
        let stype = if cg >= cr && cg >= cb {
            "green"
        } else if cr >= cg && cr >= cb {
            "red"
        } else {
            "blue"
        };
        let mix = fmt(k.spill.min(1.0));
        f.push_str(&format!(",despill=type={}:mix={}", stype, mix));
    }
    Some(KeyingSpec { filter: Some(f) })
}

/// 为 shape=="text" 的蒙版生成 drawtext 滤镜语句（自包含的多语句滤镜图）。
/// 产出 RGBA 蒙版流（黑底白字，luma=字形覆盖度），供 graph.rs 用 alphamerge 合到主视频。
pub(crate) fn build_text_mask(mask: &Mask, w: u32, h: u32, fps: u32, dur: f64, idx: usize) -> Option<ImageMask> {
    let text = mask.text.trim();
    if text.is_empty() {
        return None;
    }
    let min_side = (w.min(h)) as f64;
    let size = mask.params.get("size").copied().unwrap_or(0.15);
    let fontsize = (size * min_side).round().max(1.0) as u32;
    let x = mask.params.get("x").copied().unwrap_or(0.5);
    let y = mask.params.get("y").copied().unwrap_or(0.5);
    let rotation_rad = mask.params.get("rotation").copied().unwrap_or(0.0) * std::f64::consts::PI / 180.0;
    let feather = mask.feather.max(0.0);
    let sigma = if feather > 0.0 { feather * min_side * 0.5 } else { 0.0 };
    // drawtext 文本与路径用单引号包裹。ffmpeg 滤镜图把 ':' 当作选项分隔符，即使在单引号内
    // 也会误判（实测：fontfile='C:/Windows/...' 报错 "No option name near '/Windows/...'"），
    // 故必须对 ':' 转义为 '\:'；同时转义 '\' 与单引号，避免破坏转义序列。
    let escaped = text.replace('\\', "\\\\").replace('\'', "\\'").replace(':', "\\:");
    // 优先微软雅黑（支持中文），Windows 上 ffmpeg 接受正斜杠路径；路径中的冒号需转义。
    let fontfile = "C:/Windows/Fonts/msyh.ttc".replace(':', "\\:");
    // 标签按文字蒙版序号(idx)唯一化：同一 clip 上多个文字蒙版时，原先硬编码的 [bgT]/[tx0]
    // 会重复定义导致 ffmpeg "Label already exists" 崩溃。每个文字蒙版用独立标签后缀规避。
    let bg = format!("bgT{}", idx);
    let tx = format!("tx0{}", idx);
    let txraw = format!("txraw{}", idx);
    let mut draw = format!(
        "[{bg}]drawtext=text='{text}':fontfile='{ff}':fontsize={fs}:fontcolor=white:x='(main_w-tw)/2+(({x})*main_w-main_w/2)':y='(main_h-th)/2+(({y})*main_h-main_h/2)'",
        bg = bg, text = escaped, ff = fontfile, fs = fontsize, x = fmt(x), y = fmt(y)
    );
    if sigma > 0.0 {
        draw.push_str(&format!(",gblur=sigma={s}", s = fmt(sigma)));
    }
    if mask.invert {
        // alphamerge 取第二路输入的 luma 作为 alpha，故反转须翻转亮度（negate 翻转所有通道亮度，
        // 使白字变黑、黑底变白），alpha 通道被忽略无所谓。
        draw.push_str(",negate");
    }
    // 本机构建版本的 drawtext 不支持 rotation 选项（实测 "Option not found"），旋转改用独立
    // rotate 滤镜实现。最终标签统一为 [tx{idx}]（graph.rs 按 im.label 动态引用）；非 0 旋转时
    // 先以临时 [txraw{idx}] 收尾 drawtext 链，再 rotate 到 [tx{idx}]，rotate 用透明黑填充保证蒙版外为透明。
    let has_rot = rotation_rad.abs() > 1e-6;
    if has_rot {
        draw.push_str(&format!("[{txraw}]"));
        draw.push_str(&format!(";[{txraw}]rotate=angle={a}:c=black@0[{tx}]", a = fmt(rotation_rad), txraw = txraw, tx = tx));
    } else {
        draw.push_str(&format!("[{tx}]"));
    }
    let statement = format!(
        "color=c=black@0:s={W}x{H}:d={DUR}:r={FPS},format=rgba[{bg}];{draw}",
        W = w, H = h, DUR = fmt(dur), FPS = fps, bg = bg, draw = draw
    );
    Some(ImageMask { label: tx, statement })
}

/// 返回蒙版形状在给定坐标变量下的**有符号距离**表达式（负=形状内部，0=轮廓）。
/// 坐标变量 `x_expr`/`y_expr` 默认 "X"/"Y"；阴影传偏移后的坐标以获得偏移环 sd。
/// 各 shape 的 sd 公式与 `mask_alpha_expr` 内部完全一致，仅坐标变量参数化，供描边环/填充剪影复用。
fn mask_sd_expr(mask: &Mask, x_expr: &str, y_expr: &str) -> Option<String> {
    if mask.shape.is_empty() {
        return None;
    }
    let x = mask.params.get("x").copied().unwrap_or(0.5);
    let y = mask.params.get("y").copied().unwrap_or(0.5);
    match mask.shape.as_str() {
        "circle" => {
            let r = mask.params.get("radius").copied().unwrap_or(0.3);
            let dist = format!("sqrt(({xe}-{x}*W)^2+({ye}-{y}*H)^2)", xe = x_expr, ye = y_expr, x = fmt(x), y = fmt(y));
            let r_px = format!("({r}*min(W,H))", r = fmt(r));
            Some(format!("(({dist})-({r_px}))", dist = dist, r_px = r_px))
        }
        "heart" => {
            // 近似有符号距离（供 stroke/shadow 视觉用，非精确 SDF）：
            // 复用 mask_alpha_expr 的隐式函数 f，sd = sign(f)·sqrt(|f|)·(radius·minSide)·0.5。
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let r = mask.params.get("radius").copied().unwrap_or(0.3);
            let rot = mask.params.get("rotation").copied().unwrap_or(0.0);
            let ang = rot * std::f64::consts::PI / 180.0;
            let ca = ang.cos();
            let sa = ang.sin();
            let nx = format!("(({xe})-({x}*W))/(({r})*min(W,H))", xe = x_expr, x = fmt(x), r = fmt(r));
            let ny = format!("(-(({ye})-({y}*H))/(({r})*min(W,H)))", ye = y_expr, y = fmt(y), r = fmt(r));
            let nxr = format!("(({nx})*({ca})-({ny})*({sa}))", nx = nx, ca = fmt(ca), ny = ny, sa = fmt(sa));
            let nyr = format!("(({nx})*({sa})+({ny})*({ca}))", nx = nx, sa = fmt(sa), ny = ny, ca = fmt(ca));
            let e = format!("(({nxr})*({nxr})+({nyr})*({nyr})-1)", nxr = nxr, nyr = nyr);
            let f = format!("(({e})*({e})*({e})-({nxr})*({nxr})*({nyr})*({nyr}))", e = e, nxr = nxr, nyr = nyr);
            let r_px = format!("({r}*min(W,H))", r = fmt(r));
            let sd = format!("((({f})>=0?1:-1)*sqrt(abs({f}))*({r_px})*0.5)", f = f, r_px = r_px);
            Some(sd)
        }
        "rect" => {
            let w = mask.params.get("width").copied().unwrap_or(0.5);
            let h = mask.params.get("height").copied().unwrap_or(0.5);
            let rot = mask.params.get("rotation").copied().unwrap_or(0.0);
            let round = mask.params.get("roundness").copied().unwrap_or(0.0);
            let a = rot * std::f64::consts::PI / 180.0;
            let ca = a.cos();
            let sa = a.sin();
            let hw_expr = format!("(({w})*W/2)", w = fmt(w));
            let hh_expr = format!("(({h})*H/2)", h = fmt(h));
            let r0_expr = format!("(({r})*min({hw},{hh}))", r = fmt(round), hw = hw_expr, hh = hh_expr);
            let dx = format!("(({xe}-({x})*W)*({ca})+({ye}-({y})*H)*({sa}))",
                xe = x_expr, ye = y_expr, x = fmt(x), y = fmt(y), ca = fmt(ca), sa = fmt(sa));
            let dy = format!("(-({xe}-({x})*W)*({sa})+({ye}-({y})*H)*({ca}))",
                xe = x_expr, ye = y_expr, x = fmt(x), y = fmt(y), sa = fmt(sa), ca = fmt(ca));
            let qx = format!("(abs({dx})-(({hw})-({r0})))", dx = dx, hw = hw_expr, r0 = r0_expr);
            let qy = format!("(abs({dy})-(({hh})-({r0})))", dy = dy, hh = hh_expr, r0 = r0_expr);
            let sd = format!("(min(max({qx},{qy}),0)+sqrt(max({qx},0)*max({qx},0)+max({qy},0)*max({qy},0))-({r0}))",
                qx = qx, qy = qy, r0 = r0_expr);
            Some(sd)
        }
        "linear" | "mirror" => {
            let ang = mask.params.get("angle").copied().unwrap_or(0.0) * std::f64::consts::PI / 180.0;
            let ca = ang.cos();
            let sa = ang.sin();
            let width = mask.params.get("width").copied().unwrap_or(0.3);
            let feather = mask.feather.max(0.0);
            let half = format!("({width}*min(W,H)*(1+{feather}*2))", width = fmt(width), feather = fmt(feather));
            let d = format!("(({xe}-({x})*W)*({ca})+({ye}-({y})*H)*({sa}))",
                xe = x_expr, ye = y_expr, x = fmt(x), y = fmt(y), ca = fmt(ca), sa = fmt(sa));
            Some(format!("(abs({d})-({half}))", d = d, half = half))
        }
        "polygon" => {
            let radius = mask.params.get("radius").copied().unwrap_or(0.3);
            let sides = mask.params.get("sides").copied().unwrap_or(3.0).max(3.0);
            let rotation = mask.params.get("rotation").copied().unwrap_or(0.0);
            let px = format!("(({xe})-({x})*W)", xe = x_expr, x = fmt(x));
            let py = format!("(({ye})-({y})*H)", ye = y_expr, y = fmt(y));
            let r_expr = format!("sqrt({px}*{px}+{py}*{py})", px = px, py = py);
            let ang = format!("atan2({py},{px})", py = py, px = px);
            let half_seg = fmt(std::f64::consts::PI / sides);
            let seg = fmt(2.0 * std::f64::consts::PI / sides);
            let rot_rad = fmt(rotation * std::f64::consts::PI / 180.0);
            let aa = format!("(mod({ang}+PI/2+{half_seg}-({rot_rad}),{seg})-{half_seg})",
                ang = ang, half_seg = half_seg, rot_rad = rot_rad, seg = seg);
            let r_px = format!("({radius}*min(W,H))", radius = fmt(radius));
            let edge_dist = format!("(({r_px})*cos({half_seg})/cos({aa}))", r_px = r_px, half_seg = half_seg, aa = aa);
            Some(format!("(({r_expr})-({edge_dist}))", r_expr = r_expr, edge_dist = edge_dist))
        }
        "star" => {
            let radius = mask.params.get("radius").copied().unwrap_or(0.3);
            let inner_ratio = mask.params.get("innerRatio").copied().unwrap_or(0.5).clamp(0.0, 1.0);
            let sides = mask.params.get("sides").copied().unwrap_or(3.0).max(3.0);
            let rotation = mask.params.get("rotation").copied().unwrap_or(0.0);
            let px = format!("(({xe})-({x})*W)", xe = x_expr, x = fmt(x));
            let py = format!("(({ye})-({y})*H)", ye = y_expr, y = fmt(y));
            let r_expr = format!("sqrt({px}*{px}+{py}*{py})", px = px, py = py);
            let ang = format!("atan2({py},{px})", py = py, px = px);
            let half_seg = fmt(std::f64::consts::PI / sides);
            let seg = fmt(2.0 * std::f64::consts::PI / sides);
            let rot_rad = fmt(rotation * std::f64::consts::PI / 180.0);
            let aa = format!("(mod({ang}+PI/2+{half_seg}-({rot_rad}),{seg})-{half_seg})",
                ang = ang, half_seg = half_seg, rot_rad = rot_rad, seg = seg);
            let r_px = format!("({radius}*min(W,H))", radius = fmt(radius));
            let rin_px = format!("({ir}*{r_px})", ir = fmt(inner_ratio), r_px = r_px);
            let t = format!("(abs({aa})/{half_seg})", aa = aa, half_seg = half_seg);
            let edge_dist_star = format!("(({r_px})+(({rin_px})-({r_px}))*({t}))", r_px = r_px, rin_px = rin_px, t = t);
            Some(format!("(({r_expr})-({edge_dist_star}))", r_expr = r_expr, edge_dist_star = edge_dist_star))
        }
        _ => None,
    }
}

/// hex `#rrggbb`（可选前导 #）→ (r,g,b) ∈ 0..1。空/非法回退白色 (1,1,1)。
fn hex_to_rgb_f64(hex: &str) -> (f64, f64, f64) {
    let h = hex.trim_start_matches('#');
    if h.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&h[0..2], 16),
            u8::from_str_radix(&h[2..4], 16),
            u8::from_str_radix(&h[4..6], 16),
        ) {
            return (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
        }
    }
    (1.0, 1.0, 1.0)
}

/// 环（ring）alpha 表达式：沿轮廓居中、半宽 `hw_expr`、软边 `se_expr`，不透明度 `opacity` 烘焙进 alpha。
/// 公式与前端 drawStrokeShadow 一致：`ringA = clip((hw + se/2 - |sd|)/se, 0, 1) * opacity`。
fn ring_alpha_expr(sd_expr: &str, hw_expr: &str, se_expr: &str, opacity: f64) -> String {
    let op = opacity.max(0.0).min(1.0);
    format!(
        "((clip((({hw})+({se})/2-abs({sd}))/({se}),0,1))*({op}))",
        hw = hw_expr, se = se_expr, sd = sd_expr, op = fmt(op)
    )
}

/// 描边项：(R,G,B, A) 四个 geq 表达式。颜色分量 0..1，alpha 已烘焙不透明度。
/// 前端 `lineWidth = max(0.5, size*minSide)` 为**居中描边**，真实半宽 = `max(0.5, size*minSide)/2`；
/// 软边 `seStroke = max(0.5, blur*minSide*0.1)`（blur>0 时才有模糊，否则硬边）。
fn build_stroke_terms(mask: &Mask) -> Option<(String, String, String, String)> {
    let sd = mask_sd_expr(mask, "X", "Y")?;
    let hw = format!("max(0.5,({s}*min(W,H)))/2", s = fmt(mask.stroke.size));
    let se = format!("max(0.5,({b}*min(W,H)*0.1))", b = fmt(mask.stroke.blur));
    let a = ring_alpha_expr(&sd, &hw, &se, mask.stroke.opacity);
    let (r, g, b) = hex_to_rgb_f64(&mask.stroke.color);
    // geq 像素值范围 0..255，颜色分量须 *255 再 premultiply。
    Some((fmt(r * 255.0), fmt(g * 255.0), fmt(b * 255.0), a))
}

/// 阴影项：(R,G,B,A)。阴影为偏移后的填充剪影（filled silhouette），用大羽化半径模拟模糊。
/// `dx = cos(angle)*distance*minSide`，`dy = sin(angle)*distance*minSide`；
/// 羽化半径 `shadowFeather = max(1, max(2, blur*minSide*0.5))` 模拟模糊扩散。
fn build_shadow_terms(mask: &Mask) -> Option<(String, String, String, String)> {
    let ang = mask.shadow.angle * std::f64::consts::PI / 180.0;
    let ca = ang.cos();
    let sa = ang.sin();
    let dx = format!("(({ca})*({dist})*min(W,H))", ca = fmt(ca), dist = fmt(mask.shadow.distance));
    let dy = format!("(({sa})*({dist})*min(W,H))", sa = fmt(sa), dist = fmt(mask.shadow.distance));
    let sd_off = mask_sd_expr(mask, &format!("(X-({dx}))"), &format!("(Y-({dy}))"))?;
    let blur_px = format!("max(2,({b}*min(W,H)*0.5))", b = fmt(mask.shadow.blur));
    let shadow_feather = format!("max(1,{blur})", blur = blur_px);
    // 填充剪影（对称羽化）：中心不透明→边缘渐透明
    let fill_alpha = format!("clip(0.5-({sd})/({sf}),0,1)", sd = sd_off, sf = shadow_feather);
    let a = format!("({fa})*({op})", fa = fill_alpha, op = fmt(mask.shadow.opacity));
    let (r, g, b) = hex_to_rgb_f64(&mask.shadow.color);
    // geq 像素值范围 0..255，颜色分量 *255；opacity 通过 alpha 烘焙，不预乘颜色。
    Some((fmt(r * 255.0), fmt(g * 255.0), fmt(b * 255.0), a))
}

/// 计算单个蒙版的 geq alpha 表达式（0..1，已应用 invert）。
/// None 表示该 shape 不支持或为空。该表达式是 build_mask_spec 并集的核心构件。
fn mask_alpha_expr(mask: &Mask) -> Option<String> {
    if mask.shape.is_empty() {
        return None;
    }
    match mask.shape.as_str() {
        "linear" => {
            // 前端语义（maskRender.ts linear）：
            //   以 (x,y) 为中心、angle(度) 为渐变轴方向（dx=cos, dy=sin），
            //   半带宽 half = width*min(W,H)；沿轴中心可见、两端渐隐到透明
            //   （addColorStop 0→透明, 0.5→可见, 1→透明）。
            // 原实现是整帧 alpha 乘子（colorchannelmixer），完全没用 x/y/angle/width，
            // 此处重写为渐变带（geq）：a = clip(1 - |d|/half_eff, 0, 1)。
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let ang = mask.params.get("angle").copied().unwrap_or(0.0) * std::f64::consts::PI / 180.0;
            let ca = ang.cos();
            let sa = ang.sin();
            let width = mask.params.get("width").copied().unwrap_or(0.3);
            let feather = mask.feather.max(0.0);
            // half_eff = width*min(W,H)*(1+feather*2)：feather 折算为软化宽度，近似前端 blur
            let half_expr = format!("({width}*min(W,H)*(1+{feather}*2))", width = fmt(width), feather = fmt(feather));
            // 沿 angle 方向的有符号像素距离 d = (X-x*W)*ca + (Y-y*H)*sa
            let d_expr = format!("((X-{x}*W)*{ca}+(Y-{y}*H)*{sa})", x = fmt(x), y = fmt(y), ca = fmt(ca), sa = fmt(sa));
            // 中心可见、两端渐隐：a = clip(1 - |d|/half_eff, 0, 1)
            let mut a_expr = format!("clip(1-abs({d})/({half}),0,1)", d = d_expr, half = half_expr);
            if mask.invert {
                a_expr = format!("(1-({a_expr}))", a_expr = a_expr);
            }
            Some(a_expr)
        }
        "circle" => {
            // 前端语义：中心 (x,y) 归一化、半径 radius 归一化（相对帧短边 min(w,h)）。
            // 位置读 x/y（原 cx/cy 导致永远居中，已修正）；真圆距离判据相对 min(W,H) 归一化，
            // 与前端 maskRender.ts（r = radius*min(w,h)）一致；原生 (X/W-x)²+(Y/H-y)² 在 W≠H 时为椭圆，已废弃。
            // 羽化 feather 近似前端 blur（Canvas filter:blur(R)）：高斯模糊本质对称且过渡带宽 ≈ 1.6×R。
            // geq 用 clip(0.5-sd/fp) 对称线性近似，过渡总带宽 fp；取 fp=feather*min(W,H) 与前端的
            // 高斯 blur radius=feather*minSide*0.5 在视觉上可比（geq 过渡带宽约为前端的 ~77%），
            // 显著改善"导出羽化比预览小"问题。
            let feather = mask.feather.max(0.0);
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let r = mask.params.get("radius").copied().unwrap_or(0.3);
            let dist = format!("sqrt((X-{x}*W)^2+(Y-{y}*H)^2)", x = fmt(x), y = fmt(y));
            let r_px = format!("({r}*min(W,H))", r = fmt(r));
            let fp = format!("max(1,({feather}*min(W,H)))", feather = fmt(feather));
            // 对称羽化圆：dist<R 内 alpha=1，边界 alpha=0.5，dist>R 外 alpha=0（借助 alpha 通道真合成移除黑遮罩环）
            let mut a_expr = format!("clip(0.5-({dist}-{r_px})/({fp}),0,1)", dist = dist, r_px = r_px, fp = fp);
            if mask.invert {
                a_expr = format!("(1-({a_expr}))", a_expr = a_expr);
            }
            Some(a_expr)
        }
        "heart" => {
            // 心形用隐式函数软边（与前端 maskRender 一致的隐式函数 f）：
            //   f = (nx²+ny²-1)³ - nx²·ny³ ，f<0 为心形内部，f=0 为轮廓。
            // 坐标先归一化到以 (x,y) 为中心、radius*minSide 为尺度；屏幕 Y 向下，取负使心形顶点朝上；
            // rotation 顺时针旋转。软边 fp = max(feather*minSide*0.5, 1e-3) 像素，
            // a = clip(0.5 - f*4/fp, 0, 1)（系数 4 仅作量级近似，把 f 折算到像素软边）。
            let feather = mask.feather.max(0.0);
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let r = mask.params.get("radius").copied().unwrap_or(0.3);
            let rot = mask.params.get("rotation").copied().unwrap_or(0.0);
            let ang = rot * std::f64::consts::PI / 180.0;
            let ca = ang.cos();
            let sa = ang.sin();
            let nx = format!("((X-({x}*W))/(({r})*min(W,H)))", x = fmt(x), r = fmt(r));
            let ny = format!("(-(Y-({y}*H))/(({r})*min(W,H)))", y = fmt(y), r = fmt(r));
            let nxr = format!("(({nx})*({ca})-({ny})*({sa}))", nx = nx, ca = fmt(ca), ny = ny, sa = fmt(sa));
            let nyr = format!("(({nx})*({sa})+({ny})*({ca}))", nx = nx, sa = fmt(sa), ny = ny, ca = fmt(ca));
            let e = format!("(({nxr})*({nxr})+({nyr})*({nyr})-1)", nxr = nxr, nyr = nyr);
            let f = format!("(({e})*({e})*({e})-({nxr})*({nxr})*({nyr})*({nyr}))", e = e, nxr = nxr, nyr = nyr);
            let fp = format!("max(({feather})*min(W,H)*0.5,0.001)", feather = fmt(feather));
            let mut a_expr = format!("clip(0.5-({f})*4.0/({fp}),0,1)", f = f, fp = fp);
            if mask.invert {
                a_expr = format!("(1-({a_expr}))", a_expr = a_expr);
            }
            Some(a_expr)
        }
        "rect" => {
            // 归一化坐标/尺寸约定（与前端一致）：
            //   x,y       : 矩形中心，归一化 0~1（相对帧宽高）
            //   width,h   : 矩形宽高，归一化 0~1（相对帧宽高）
            //   rotation  : 旋转角度（度），graph.rs 仅支持 0（轴对齐）
            //   roundness : 圆角比例 0~1（圆角半径 = min(hw,hh)*roundness）
            //   feather   : 羽化宽度，归一化 0~1（相对帧宽高）
            //
            // 注意：geq 中 X/Y/W/H 均为像素；阈值必须用 W/H 折算成像素，
            // 不能把归一化常量当像素用（否则单位不一致会让整帧被遮黑）。
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let w = mask.params.get("width").copied().unwrap_or(0.5);
            let h = mask.params.get("height").copied().unwrap_or(0.5);
            let rot = mask.params.get("rotation").copied().unwrap_or(0.0);
            let round = mask.params.get("roundness").copied().unwrap_or(0.0);
            let feather = mask.feather.max(0.0);
            let a = rot * std::f64::consts::PI / 180.0;
            let ca = a.cos();
            let sa = a.sin();
            // 半宽/半高（像素）：用 W/H 折算，保证与 dx/dy 同单位
            let hw_expr = format!("(({w})*W/2)", w = fmt(w));
            let hh_expr = format!("(({h})*H/2)", h = fmt(h));
            let r0_expr = format!("(({r})*min({hw},{hh}))", r = fmt(round), hw = hw_expr, hh = hh_expr);
            // 羽化过渡带半宽（像素）：feather 相对帧短边 min(W,H) 折算（与 circle/polygon/star 一致）
            let ex_expr = format!("(max(({f})*min(W,H),0.001))", f = fmt(feather));
            // 像素 → 矩形局部坐标（绕中心旋转 -a）
            let dx = format!("((X-({x})*W)*({ca})+(Y-({y})*H)*({sa}))",
                x = fmt(x), y = fmt(y), ca = fmt(ca), sa = fmt(sa));
            let dy = format!("(-(X-({x})*W)*({sa})+(Y-({y})*H)*({ca}))",
                x = fmt(x), y = fmt(y), sa = fmt(sa), ca = fmt(ca));
            // 圆角矩形有符号距离场 (sdRoundBox)，单位：像素
            let qx = format!("(abs({dx})-(({hw})-({r0})))", dx = dx, hw = hw_expr, r0 = r0_expr);
            let qy = format!("(abs({dy})-(({hh})-({r0})))", dy = dy, hh = hh_expr, r0 = r0_expr);
            let sd = format!("(min(max({qx},{qy}),0)+sqrt(max({qx},0)*max({qx},0)+max({qy},0)*max({qy},0))-({r0}))",
                qx = qx, qy = qy, r0 = r0_expr);
            // 对称羽化矩形：sd<0 内 alpha=1，边界 alpha=0.5，sd>0 外 alpha=0（借助 alpha 通道真合成移除黑遮罩环）
            let mut a_expr = format!("clip(0.5-({sd})/({ex}),0,1)", sd = sd, ex = ex_expr);
            if mask.invert {
                a_expr = format!("(1-({a_expr}))", a_expr = a_expr);
            }
            Some(a_expr)
        }
        "mirror" => {
            // 前端语义（maskRender.ts mirror）：同 linear 几何，但相反——
            //   中心透明、两端可见（0→可见, 0.5→透明, 1→可见），即 linear 的 a 取反。
            // 原实现是沿 X 轴对称、仅有 feather/opacity、无 angle/width，此处重写为带 angle 的对称渐变带。
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let ang = mask.params.get("angle").copied().unwrap_or(0.0) * std::f64::consts::PI / 180.0;
            let ca = ang.cos();
            let sa = ang.sin();
            let width = mask.params.get("width").copied().unwrap_or(0.3);
            let feather = mask.feather.max(0.0);
            let half_expr = format!("({width}*min(W,H)*(1+{feather}*2))", width = fmt(width), feather = fmt(feather));
            let d_expr = format!("((X-{x}*W)*{ca}+(Y-{y}*H)*{sa})", x = fmt(x), y = fmt(y), ca = fmt(ca), sa = fmt(sa));
            // 中心透明、两端可见：a = clip(|d|/half_eff, 0, 1)（linear 的 1-a）
            let mut a_expr = format!("clip(abs({d})/({half}),0,1)", d = d_expr, half = half_expr);
            if mask.invert {
                a_expr = format!("(1-({a_expr}))", a_expr = a_expr);
            }
            Some(a_expr)
        }
        "polygon" => {
            // 前端语义（maskRender.ts polygon，与后端共享 SDF 公式）：
            //   中心 (x,y) 归一化（相对帧宽高），外接半径 R = radius*min(W,H)；
            //   sides：整数 ≥3；rotation：度，rotation=0 时第一顶点指向正上方，正角度顺时针。
            // 极坐标有符号距离场（负=形状内部）：
            //   r = sqrt(px²+py²), ang = atan2(py,px) （-PI/2 指向正上方）
            //   seg = 2*PI/sides；aa = mod(ang - rotRad + PI/2 + 0.5*seg, seg) - 0.5*seg （0 处为顶点）
            //   edgeDist = R*cos(0.5*seg)/cos(aa)；sd = r - edgeDist
            // 羽化 feather 近似前端 blur：对称线性过渡，fp=feather*min(W,H)。
            let feather = mask.feather.max(0.0);
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let radius = mask.params.get("radius").copied().unwrap_or(0.3);
            let sides = mask.params.get("sides").copied().unwrap_or(3.0).max(3.0);
            let rotation = mask.params.get("rotation").copied().unwrap_or(0.0);
            let px = format!("(X-{}*W)", fmt(x));
            let py = format!("(Y-{}*H)", fmt(y));
            let r_expr = format!("sqrt({}*{}+{}*{})", px, px, py, py);
            let ang = format!("atan2({},{})", py, px);
            let half_seg = fmt(std::f64::consts::PI / sides);
            let seg = fmt(2.0 * std::f64::consts::PI / sides);
            let rot_rad = fmt(rotation * std::f64::consts::PI / 180.0);
            // aa = mod(ang - rotRad + PI/2 + 0.5*seg, seg) - 0.5*seg （0 处为顶点，seg=2*PI/sides）
            let aa = format!("(mod({}+PI/2+{}-({}),{})-{})", ang, half_seg, rot_rad, seg, half_seg);
            let r_px = format!("({}*min(W,H))", fmt(radius));
            let edge_dist = format!("(({})*cos({})/cos({}))", r_px, half_seg, aa);
            let sd = format!("({}-({}))", r_expr, edge_dist);
            let fp = format!("max(1,({}*min(W,H)))", fmt(feather));
            let mut a_expr = format!("clip(0.5-({})/({}),0,1)", sd, fp);
            if mask.invert {
                a_expr = format!("(1-({a_expr}))", a_expr = a_expr);
            }
            Some(a_expr)
        }
        "star" => {
            // 前端语义（maskRender.ts star，与后端共享 SDF 公式）：
            //   中心 (x,y) 归一化，外顶点半径 R = radius*min(W,H)，内顶点半径 Rin = innerRatio*R；
            //   sides：星形尖数（整数 ≥3），rotation：度（rotation=0 时一尖指向正上方，顺时针）。
            // 径向近似（足以做遮罩）：在顶点(R)与扇区边(Rin)间按 t=|aa|/(0.5*seg) 线性插值边界半径：
            //   edgeDist = R + (Rin - R)*t；sd = r - edgeDist。其余约定同 polygon。
            let feather = mask.feather.max(0.0);
            let x = mask.params.get("x").copied().unwrap_or(0.5);
            let y = mask.params.get("y").copied().unwrap_or(0.5);
            let radius = mask.params.get("radius").copied().unwrap_or(0.3);
            let inner_ratio = mask.params.get("innerRatio").copied().unwrap_or(0.5).clamp(0.0, 1.0);
            let sides = mask.params.get("sides").copied().unwrap_or(3.0).max(3.0);
            let rotation = mask.params.get("rotation").copied().unwrap_or(0.0);
            let px = format!("(X-{}*W)", fmt(x));
            let py = format!("(Y-{}*H)", fmt(y));
            let r_expr = format!("sqrt({}*{}+{}*{})", px, px, py, py);
            let ang = format!("atan2({},{})", py, px);
            let half_seg = fmt(std::f64::consts::PI / sides);
            let seg = fmt(2.0 * std::f64::consts::PI / sides);
            let rot_rad = fmt(rotation * std::f64::consts::PI / 180.0);
            // aa = mod(ang - rotRad + PI/2 + 0.5*seg, seg) - 0.5*seg （0 处为顶点，seg=2*PI/sides）
            let aa = format!("(mod({}+PI/2+{}-({}),{})-{})", ang, half_seg, rot_rad, seg, half_seg);
            let r_px = format!("({}*min(W,H))", fmt(radius));
            let rin_px = format!("({}*{})", fmt(inner_ratio), r_px);
            let t = format!("(abs({})/{})", aa, half_seg);
            let edge_dist_star = format!("(({})+(({})-({}))*({}))", r_px, rin_px, r_px, t);
            let sd = format!("({}-({}))", r_expr, edge_dist_star);
            let fp = format!("max(1,({}*min(W,H)))", fmt(feather));
            let mut a_expr = format!("clip(0.5-({})/({}),0,1)", sd, fp);
            if mask.invert {
                a_expr = format!("(1-({a_expr}))", a_expr = a_expr);
            }
            Some(a_expr)
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

    // ── 抠像 spill 溢出抑制导出 ──

    fn mk_keying(enabled: bool, mode: &str, color: &str, spill: f64) -> KeyingConfig {
        KeyingConfig {
            enabled,
            mode: mode.to_string(),
            color: color.to_string(),
            similarity: 0.3,
            edge_softness: 0.1,
            spill,
            model: None,
            threshold: None,
            matte_asset_id: None,
            background: None,
        }
    }

    #[test]
    fn test_build_keying_spec_spill_green_despill() {
        // 绿幕（主通道 green）+ spill>0 → 应追加 despill=type=green
        let k = Some(mk_keying(true, "chroma", "#00ff00", 0.5));
        let spec = build_keying_spec(&k, 1920, 1080).expect("应生成 chromakey");
        let f = spec.filter.unwrap();
        assert!(f.contains("chromakey="), "应含 chromakey: {}", f);
        assert!(f.contains("despill=type=green:mix=0.5"), "应含 despill green: {}", f);
    }

    #[test]
    fn test_build_keying_spec_spill_red_blue_type() {
        let red = Some(mk_keying(true, "chroma", "#ff0000", 0.5));
        let f_red = build_keying_spec(&red, 100, 100).unwrap().filter.unwrap();
        assert!(f_red.contains("despill=type=red:mix=0.5"), "红幕应 red: {}", f_red);

        let blue = Some(mk_keying(true, "chroma", "#0000ff", 0.5));
        let f_blue = build_keying_spec(&blue, 100, 100).unwrap().filter.unwrap();
        assert!(f_blue.contains("despill=type=blue:mix=0.5"), "蓝幕应 blue: {}", f_blue);
    }

    #[test]
    fn test_build_keying_spec_no_spill_backward_compat() {
        // spill<=0 → 不挂 despill，保持历史行为（无溢出抑制）
        let k = Some(mk_keying(true, "chroma", "#00ff00", 0.0));
        let f = build_keying_spec(&k, 1920, 1080).unwrap().filter.unwrap();
        assert!(f.contains("chromakey="), "应含 chromakey: {}", f);
        assert!(!f.contains("despill"), "spill=0 不应含 despill: {}", f);
    }

    #[test]
    fn test_build_keying_spec_disabled_or_smart_no_filter() {
        assert!(build_keying_spec(&Some(mk_keying(false, "chroma", "#00ff00", 0.5)), 100, 100).is_none());
        assert!(build_keying_spec(&Some(mk_keying(true, "smart", "#00ff00", 0.5)), 100, 100).is_none());
    }
}

