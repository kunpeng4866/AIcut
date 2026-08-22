//! src/subtitle.rs — 字幕系统
//! SRT 解析 + ASS 基础解析 + drawtext 滤镜生成

use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

/// 前端 TextBackground 的 Rust 映射
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBackground {
    #[serde(default)] pub enabled: bool,
    #[serde(default = "default_black")] pub color: String,
    #[serde(default)] pub opacity: f64,
    #[serde(default)] pub radius: f64,
    #[serde(default)] pub width: f64,
    #[serde(default)] pub height: f64,
    #[serde(default)] pub offset_x: f64,
    #[serde(default)] pub offset_y: f64,
}

/// 前端 TextShadow 的 Rust 映射
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextShadow {
    #[serde(default)] pub enabled: bool,
    #[serde(default = "default_black")] pub color: String,
    #[serde(default)] pub opacity: f64,
    #[serde(default)] pub blur: f64,
    #[serde(default)] pub distance: f64,
    #[serde(default)] pub angle: f64,
}

fn default_black() -> String { "#000000".into() }

/// 前端 TextContent 的 Rust 映射（字段用 camelCase 对齐）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOverlay {
    pub content: String,
    #[serde(default)] pub font_family: Option<String>,
    #[serde(default)] pub font_size: Option<u32>,
    #[serde(default)] pub font_weight: Option<String>,
    #[serde(default)] pub color: Option<String>,
    #[serde(default)] pub stroke_color: Option<String>,
    #[serde(default)] pub stroke_width: Option<f64>,
    #[serde(default)] pub stroke_opacity: Option<f64>,
    #[serde(default)] pub text_align: Option<String>,
    #[serde(default)] pub x: Option<f64>,
    #[serde(default)] pub y: Option<f64>,
    #[serde(default)] pub rotation: Option<f64>,
    #[serde(default)] pub opacity: Option<f64>,
    #[serde(default)] pub background: Option<TextBackground>,
    #[serde(default)] pub shadow: Option<TextShadow>,
}

/// 前端 SubtitleContent 的 Rust 映射
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleOverlay {
    pub items: Vec<SubtitleItemOverride>,
    #[serde(default)] pub font_family: Option<String>,
    #[serde(default)] pub font_size: Option<u32>,
    #[serde(default)] pub color: Option<String>,
    #[serde(default)] pub stroke_color: Option<String>,
    #[serde(default)] pub stroke_width: Option<f64>,
    #[serde(default)] pub stroke_opacity: Option<f64>,
    #[serde(default)] pub position: Option<String>,
    #[serde(default)] pub align: Option<String>,
    // 自由定位：归一化坐标（0..1, y-down），(0.5,0.5)=画布中心，文字以该点居中锚定。
    // 优先级高于 position/align；与预览端预览拖拽 / X/Y 滑杆对称。
    #[serde(default)] pub pos_x: Option<f64>,
    #[serde(default)] pub pos_y: Option<f64>,
    #[serde(default)] pub background: Option<TextBackground>,
    #[serde(default)] pub shadow: Option<TextShadow>,
    #[serde(default)] pub time_offset: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleItemOverride {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// 单条字幕
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleItem {
    pub index: u32,
    pub start: f64,     // 秒
    pub end: f64,       // 秒
    pub text: String,
}

/// 字幕轨道
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubtitleTrack {
    pub items: Vec<SubtitleItem>,
    #[serde(default)]
    pub style: SubtitleStyle,
}

/// 字幕样式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleStyle {
    #[serde(default = "default_font")]
    pub font: String,
    #[serde(default = "default_size")]
    pub font_size: u32,
    #[serde(default = "default_color")]
    pub color: String,       // "white", "yellow", "#FFFFFF"
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub outline: u32,        // 描边宽度
    #[serde(default = "default_align")]
    pub alignment: u32,      // 1=bottom, 2=middle, 3=top
}

fn default_font() -> String { "Arial".into() }
fn default_size() -> u32 { 48 }
fn default_color() -> String { "white".into() }
fn default_align() -> u32 { 2 }

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            font: default_font(), font_size: default_size(),
            color: default_color(), bold: false, outline: 1,
            alignment: default_align(),
        }
    }
}

/// 解析 SRT 格式字幕
pub fn parse_srt(content: &str) -> SubtitleTrack {
    let mut track = SubtitleTrack::default();
    let mut lines = content.lines().peekable();

    while let Some(line) = lines.next() {
        let index: u32 = match line.trim().parse() { Ok(n) => n, Err(_) => continue };
        let time_line = match lines.next() {
            Some(l) => l.trim().to_string(),
            None => break,
        };
        // "00:00:01,000 --> 00:00:03,500"
        let parts: Vec<&str> = time_line.split("-->").collect();
        if parts.len() != 2 { continue; }
        let start = parse_srt_time(parts[0].trim());
        let end = parse_srt_time(parts[1].trim());

        let mut text = String::new();
        while let Some(t) = lines.peek() {
            if t.trim().is_empty() { lines.next(); break; }
            if !text.is_empty() { text.push('\n'); }
            text.push_str(lines.next().unwrap());
        }
        track.items.push(SubtitleItem { index, start, end, text });
    }
    track.items.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    track
}

/// 将颜色名/hex 转换为 ASS &HAABBGGRR 格式
fn color_to_ass_bgr(color: &str) -> String {
    let rgb = match color.to_lowercase().as_str() {
        "white" => (255, 255, 255),
        "yellow" => (255, 255, 0),
        "red" => (255, 0, 0),
        "green" => (0, 255, 0),
        "blue" => (0, 0, 255),
        "black" => (0, 0, 0),
        s if s.starts_with('#') && s.len() == 7 => {
            let r = u8::from_str_radix(&s[1..3], 16).unwrap_or(255);
            let g = u8::from_str_radix(&s[3..5], 16).unwrap_or(255);
            let b = u8::from_str_radix(&s[5..7], 16).unwrap_or(255);
            (r, g, b)
        }
        _ => (255, 255, 255),
    };
    format!("&H00{:02X}{:02X}{:02X}", rgb.2, rgb.1, rgb.0) // BGR order
}

fn parse_srt_time(s: &str) -> f64 {
    // "00:00:01,000" → seconds
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().unwrap_or(0.0);
        let m: f64 = parts[1].parse().unwrap_or(0.0);
        let sec: f64 = parts[2].parse().unwrap_or(0.0);
        h * 3600.0 + m * 60.0 + sec
    } else {
        0.0
    }
}

/// 将字幕轨道转换为 FFmpeg drawtext 滤镜串数组
pub fn build_drawtext_filters(track: &SubtitleTrack, width: u32, height: u32) -> Vec<String> {
    let y_pos = match track.style.alignment {
        1 => height - track.style.font_size - 40, // bottom
        3 => 40,                                   // top
        _ => height / 2 - track.style.font_size / 2, // middle
    };

    track.items.iter().map(|item| {
        let escaped = item.text.replace(':', "\\:").replace('\'', "'\\''");
        format!(
            "drawtext=text='{}':fontsize={}:fontcolor={}:x=(w-text_w)/2:y={}:enable='between(t,{},{})'",
            escaped, track.style.font_size, track.style.color, y_pos,
            item.start, item.end
        )
    }).collect()
}

/// 随安装包内置的字体文件名（与前端 gui/public/fonts 保持一致）。
/// 仅包含「非系统字体」（思源黑体 / 站酷 / Bebas），系统字体（楷体/黑体/仿宋/Impact）
/// 不随包，交由 resolve_font 的系统字体库步骤从终端用户的系统字体目录读取。
/// 导出时若 fontfile_dir 存在，将 font_family 解析为具体字体文件路径，
/// 拼入 drawtext 的 fontfile=，保证预览/导出一致。
const BUNDLED_FONT_FILES: &[&str] = &[
    "NotoSansSC-Regular.ttf",
    "NotoSansSC-Bold.ttf",
    "ZCOOLKuaiLe-Regular.ttf",
    "ZCOOLQingKeHuangYou-Regular.ttf",
    "BebasNeue-Regular.ttf",
];

/// 字体 id（前端存进工程的 font_family 值）→ 随包字体文件名。
/// 仅包含随包字体；楷体/黑体/仿宋/Impact 等系统字体不在此映射，
/// 由 resolve_font 的系统字体库步骤解析（不随包、不兜底到下面 CJK 字体）。
// (字体 id, 字重, 随包文件名)。字重可选 normal / bold。
// 仅随包字体有独立 Bold 变体的是思源黑体；站酷 / Bebas 无 Bold 文件，bold 回退 Regular。
const FONT_ID_TO_FILE: &[(&str, &str, &str)] = &[
    ("source-han-sans", "normal", "NotoSansSC-Regular.ttf"),
    ("source-han-sans", "bold", "NotoSansSC-Bold.ttf"),
    ("zcool-kuaile", "normal", "ZCOOLKuaiLe-Regular.ttf"),
    ("zcool-kuaile", "bold", "ZCOOLKuaiLe-Regular.ttf"),
    ("zcool-hei", "normal", "ZCOOLQingKeHuangYou-Regular.ttf"),
    ("zcool-hei", "bold", "ZCOOLQingKeHuangYou-Regular.ttf"),
    ("bebas", "normal", "BebasNeue-Regular.ttf"),
    ("bebas", "bold", "BebasNeue-Regular.ttf"),
];

/// 全局兜底：未知/未指定/旧工程 id 时使用，保证中文不渲染成 tofu。
const CJK_FALLBACK_FILE: &str = "NotoSansSC-Regular.ttf";

/// 根据字体 id/家族名返回随包字体文件名（仅限随包字体，不含系统字体）。
/// weight：normal / bold；bold 时优先返回 Bold 变体（思源黑体有独立 Bold 文件），
/// 其它随包字体无 Bold 文件则回退 Regular。
/// 系统字体（楷体/黑体/仿宋/Impact 等）不随包，交由 resolve_font 的系统字体库步骤解析。
fn resolve_bundled_filename(family_lc: &str, weight: &str) -> Option<&'static str> {
    let family_lc = family_lc.trim();
    let weight = weight.trim().to_lowercase();
    let is_bold = weight == "bold";
    if family_lc.is_empty() { return None; }
    // 0) 按字体 id + 字重精确匹配（仅随包字体）
    for (id, w, file) in FONT_ID_TO_FILE {
        if family_lc.eq_ignore_ascii_case(id) && w.eq_ignore_ascii_case(&weight) { return Some(file); }
    }
    // 1) 若 font_family 已直接是随包字体文件名（.ttf/.otf/.woff2）
    if family_lc.ends_with(".ttf") || family_lc.ends_with(".otf") || family_lc.ends_with(".woff2") {
        for f in BUNDLED_FONT_FILES {
            if f.eq_ignore_ascii_case(family_lc) { return Some(f); }
        }
        // 旧工程里的 woff2 子集文件名 → 映射到完整随包 TTF（bold 时优先 Bold 变体）
        if family_lc.ends_with(".woff2") {
            if family_lc.contains("zcool") {
                if family_lc.contains("kuai") { return Some("ZCOOLKuaiLe-Regular.ttf"); }
                if family_lc.contains("qing") { return Some("ZCOOLQingKeHuangYou-Regular.ttf"); }
            }
            if family_lc.contains("noto") || family_lc.contains("source") || family_lc.contains("alibaba")
                || family_lc.contains("puhuiti") || family_lc.contains("harmony") || family_lc.contains("douyin") {
                return Some(if is_bold { "NotoSansSC-Bold.ttf" } else { "NotoSansSC-Regular.ttf" });
            }
        }
    }
    // 2) 关键字匹配（兼容旧工程/导入工程里的 family 名 → 映射到随包的完整 CJK 字体）
    //    先解析到 base 文件，bold 且命中思源黑体系列时升级到 Bold 变体。
    let base = if family_lc.contains("noto sans sc") || family_lc.contains("source han sans") || family_lc.contains("notosanssc") {
        Some("NotoSansSC-Regular.ttf")
    } else if family_lc.contains("noto serif sc") || family_lc.contains("source han serif") || family_lc.contains("notoserifsc")
        || family_lc.contains("alibaba") || family_lc.contains("puhuiti") || family_lc.contains("harmonyos") || family_lc.contains("harmony") {
        Some("NotoSansSC-Regular.ttf") // 这些字体已从安装包移除，尽量解析到思源黑体（同风格且完整）
    } else if family_lc.contains("zcool kuai") || family_lc.contains("zcoolkuaile") {
        Some("ZCOOLKuaiLe-Regular.ttf")
    } else if family_lc.contains("zcool qing") || family_lc.contains("zcoolqingke") {
        Some("ZCOOLQingKeHuangYou-Regular.ttf")
    } else if family_lc.contains("bebas") {
        Some("BebasNeue-Regular.ttf")
    } else if family_lc.contains("douyin") || family_lc.contains("meihao") {
        Some("NotoSansSC-Regular.ttf")
    } else {
        None
    };
    if let Some(b) = base {
        // 注：kaiti/simhei/fangsong/impact 等系统字体不在此返回，交系统字体库步骤解析。
        if is_bold && b == "NotoSansSC-Regular.ttf" { return Some("NotoSansSC-Bold.ttf"); }
        return Some(b);
    }
    None
}

/// 返回常见系统字体目录（跨平台）。
fn system_fonts_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "windows") {
        if let Ok(windir) = std::env::var("WINDIR") {
            dirs.push(std::path::PathBuf::from(windir).join("Fonts"));
        }
        dirs.push(std::path::PathBuf::from("C:/Windows/Fonts"));
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(std::path::PathBuf::from("/Library/Fonts"));
        dirs.push(std::path::PathBuf::from("/System/Library/Fonts"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(std::path::PathBuf::from(home).join("Library/Fonts"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        dirs.push(std::path::PathBuf::from("/usr/share/fonts"));
        dirs.push(std::path::PathBuf::from("/usr/local/share/fonts"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(std::path::PathBuf::from(home).join(".local/share/fonts"));
        }
    }
    dirs
}

/// 根据字体 id/家族名返回系统字体候选文件名列表（Windows 为主）。
/// weight：normal / bold；bold 时把粗体变体排在候选列表前面（找不到则用原文件）。
fn system_font_candidates(family_lc: &str, weight: &str) -> Vec<&'static str> {
    let is_bold = weight.trim().eq_ignore_ascii_case("bold");
    let mut out = Vec::new();
    if family_lc.contains("kaiti") {
        // 楷体通常无独立粗体文件，bold 时仍用原文件（交浏览器/ffmpeg 渲染原字形）
        out.extend(["simkai.ttf", "KaiTi.ttf"]);
    }
    if family_lc.contains("simhei") || family_lc.contains("heiti") {
        // 黑体无独立粗体文件；bold 仍用 simhei.ttf，避免回退到微软雅黑(msyhbd.ttc)导致与
        // 预览（系统 SimHei）字体不一致。预览已禁用伪粗体(font-synthesis:none)，故两端都用真实 SimHei。
        out.extend(["simhei.ttf", "SimHei.ttf", "msyh.ttc", "msyhbd.ttc"]);
    }
    if family_lc.contains("fangsong") {
        out.extend(["simfang.ttf", "FangSong.ttf"]);
    }
    if family_lc.contains("noto sans sc") || family_lc.contains("source han sans") || family_lc.contains("notosanssc") {
        if is_bold { out.extend(["NotoSansSC-Bold.ttf", "NotoSansSC-VF.ttf"]); }
        out.extend(["NotoSansSC-Regular.ttf", "NotoSansSC-VF.ttf"]);
    }
    if family_lc.contains("noto serif sc") || family_lc.contains("source han serif") || family_lc.contains("notoserifsc") {
        out.extend(["NotoSerifSC-Regular.ttf", "NotoSerifSC-Regular.otf"]);
    }
    if family_lc.contains("impact") {
        out.extend(["impact.ttf", "Impact.ttf"]);
    }
    if family_lc.contains("bebas") {
        out.push("BebasNeue-Regular.ttf");
    }
    if family_lc.contains("zcool kuai") || family_lc.contains("zcoolkuaile") {
        out.push("ZCOOLKuaiLe-Regular.ttf");
    }
    if family_lc.contains("zcool qing") || family_lc.contains("zcoolqingke") {
        out.push("ZCOOLQingKeHuangYou-Regular.ttf");
    }
    if family_lc.contains("douyin") || family_lc.contains("meihao") {
        if is_bold { out.extend(["DouyinSans-Bold.ttf", "DouyinSans.ttf", "DouyinMeihao.ttf"]); }
        out.extend(["DouyinSans.ttf", "DouyinMeihao.ttf", "DouyinSans-Bold.ttf"]);
    }
    out
}

/// 返回随包字体可能的目录列表（按优先级）：
/// 1) 调用方传入的 fontfile_dir（通常来自 AICUT_FONTS_DIR，由 Electron 主进程设置）；
/// 2) 引擎可执行文件所在目录的相对候选（兼容 AICUT_FONTS_DIR 未设置/路径错误导致随包字体
///    静默回退成默认细体的场景）：
///    - 开发态: target/debug/aicut-engine.exe -> ../../gui/public/fonts
///    - 打包态: resources/engine/aicut-engine.exe -> ../fonts
fn bundled_font_dirs(fontfile_dir: &str) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let d = fontfile_dir.trim();
    if !d.is_empty() {
        dirs.push(std::path::PathBuf::from(d));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for rel in ["fonts", "../fonts", "../gui/public/fonts", "../../gui/public/fonts"] {
                let p = exe_dir.join(rel);
                if !dirs.iter().any(|x| x == &p) {
                    dirs.push(p);
                }
            }
        }
    }
    dirs
}

/// 解析字体文件绝对路径。
/// 策略：1) 随包字体目录（优先字重匹配，bold 回退 Regular）；2) 系统字体目录；3) 全局兜底（NotoSansSC-Regular.ttf）。
/// 随包字体目录在「调用方传入的 fontfile_dir」之外，额外尝试「引擎可执行文件相对目录」，
/// 避免 AICUT_FONTS_DIR 未生效时随包字体（思源黑体等）静默回退成默认细体、与预览不一致。
fn resolve_font(font_family: &Option<String>, weight: &str, fontfile_dir: &str) -> Option<String> {
    let family_lc = font_family.as_ref().map(|s| s.to_lowercase()).unwrap_or_default();
    let dirs = bundled_font_dirs(fontfile_dir);

    // 1) 随包字体目录（多候选：传入目录 + 引擎相对目录）
    for dir in &dirs {
        let dir = dir.to_string_lossy().into_owned();
        if let Some(file) = resolve_bundled_filename(&family_lc, weight) {
            let p = std::path::Path::new(&dir).join(file);
            if p.exists() { return Some(p.to_string_lossy().into_owned()); }
        }
        // bold 请求但 Bold 变体缺失 → 回退 Regular（仅当 base 与 bold 不同，避免死循环）
        if weight.trim().eq_ignore_ascii_case("bold") {
            if let Some(file) = resolve_bundled_filename(&family_lc, "normal") {
                if file != resolve_bundled_filename(&family_lc, weight).unwrap_or("") {
                    let p = std::path::Path::new(&dir).join(file);
                    if p.exists() { return Some(p.to_string_lossy().into_owned()); }
                }
            }
        }
    }

    // 2) 系统字体目录
    for sys_dir in system_fonts_dirs() {
        if !sys_dir.exists() { continue; }
        for cand in system_font_candidates(&family_lc, weight) {
            let p = sys_dir.join(cand);
            if p.exists() { return Some(p.to_string_lossy().into_owned()); }
        }
        // 若 family 本身已是文件名，直接尝试
        if family_lc.ends_with(".ttf") || family_lc.ends_with(".otf") || family_lc.ends_with(".ttc") || family_lc.ends_with(".woff2") {
            let p = sys_dir.join(&family_lc);
            if p.exists() { return Some(p.to_string_lossy().into_owned()); }
        }
    }

    // 3) 最终兜底：随包目录里的全局 CJK 字体（同样遍历多候选目录）
    for dir in &dirs {
        let p = std::path::Path::new(dir).join(CJK_FALLBACK_FILE);
        if p.exists() { return Some(p.to_string_lossy().into_owned()); }
    }
    None
}

/// 为 drawtext 滤镜追加 fontfile=（若解析到内置字体）
fn with_fontfile(base: String, fontfile: &Option<String>) -> String {
    match fontfile {
        Some(path) => format!("{}:fontfile='{}'", base, path.replace('\\', "\\\\").replace(':', "\\:")),
        None => base,
    }
}

/// 生成 ASS 格式字幕内容（用于嵌入视频或软字幕）
pub fn to_ass(track: &SubtitleTrack) -> String {
    let mut ass = String::from("[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Outline, Alignment\n");
    let ass_color = color_to_ass_bgr(&track.style.color);
    ass.push_str(&format!("Style: Default,{},{},{},{},{}\n\n",
        track.style.font, track.style.font_size, ass_color,
        if track.style.bold { -1 } else { 0 }, track.style.outline));
    ass.push_str("[Events]\nFormat: Layer, Start, End, Style, Text\n");
    for item in &track.items {
        ass.push_str(&format!("Dialogue: 0,{:.2},{:.2},Default,{}\n",
            item.start, item.end, item.text));
    }
    ass
}

/// 生成单条文字 drawtext 滤镜串（text clip 整段可见）
pub fn build_text_overlay_filter(
    text: &TextOverlay,
    timeline_in: f64,
    timeline_out: f64,
    width: u32,
    height: u32,
    fontfile_dir: &str,
) -> Option<String> {
    if text.content.trim().is_empty() { return None; }
    let escaped = text.content.replace(':', "\\:").replace('\'', "'\\''");
    let fontsize = text.font_size.unwrap_or(48);
    let fontcolor = text.color.clone().unwrap_or_else(|| "white".to_string());

    // 背景偏移（像素）：0.5 为居中，范围 [-100, 100]
    let bg_offset_x = text.background.as_ref().map(|b| ((b.offset_x - 0.5) * 200.0).round() as i64).unwrap_or(0);
    let bg_offset_y = text.background.as_ref().map(|b| ((b.offset_y - 0.5) * 200.0).round() as i64).unwrap_or(0);

    // ffmpeg drawtext 的 text_w / text_h 已包含 borderw（描边），描边变粗会撑大 text_w/text_h，
    // 导致居中表达式 (w-text_w)/2 偏移、文字随粗细移动。补偿 borderw/2 抵消，保证仅描边粗细变化、文字不动。
    let borderw = text.stroke_width.filter(|w| *w > 0.0).map(|w| w.round() as i64).unwrap_or(0);
    let stroke_comp = borderw as f64 / 2.0;
    // 合并背景偏移与描边补偿，统一以带符号形式拼接（0 则不显示 +0）
    let x_off = bg_offset_x as f64 + stroke_comp;
    let y_off = bg_offset_y as f64 + stroke_comp;
    let off_str = |v: f64| -> String { if v.abs() < 1e-9 { String::new() } else { format!("{:+}", v) } };

    // x 定位
    let x_expr = match text.text_align.as_deref() {
        Some("left") => format!("20{}", off_str(x_off)),
        Some("right") => format!("(w-text_w-20){}", off_str(x_off)),
        _ => format!("(w-text_w)/2{}", off_str(x_off)), // center 默认
    };
    // y 定位：优先用 text.y（归一化 0-1，原点**左上角**，与前端预览 top:y*100% 一致）。
    // 文字中心定在 y*h，故 top-left = y*h - text_h/2。
    // ⚠️ 历史坑：曾误用 (1-y)*h（原点左下角），与预览镜像，导致多个文字上下顺序颠倒。
    let y_expr = if let Some(y) = text.y {
        format!("({}*h - text_h/2){}", y, off_str(y_off))
    } else {
        format!("(h - {})/2{}", fontsize, off_str(y_off))
    };
    let _ = (width, height);
    // 字重：预览 text 默认 bold（textOverlayStyle 默认 'bold'），导出默认也应 bold，
    // 使 fontfile 指向真实 Bold ttf，消除浏览器伪粗体 vs 真粗体差异。
    let weight = text.font_weight.as_deref().unwrap_or("bold");
    let mut base = format!(
        "drawtext=text='{}':fontsize={}:fontcolor={}:x={}:y={}:enable='between(t,{},{})'",
        escaped, fontsize, fontcolor, x_expr, y_expr,
        timeline_in, timeline_out
    );

    // 背景：ffmpeg drawtext 原生 box 为矩形，圆角仅在前端预览生效；导出为矩形背景盒
    if let Some(bg) = &text.background {
        if bg.enabled {
            let boxcolor = format!("{}@{:.2}", bg.color, bg.opacity.clamp(0.0, 1.0));
            // width/height 取平均作为 boxborderw（单边边框宽度，近似内边距）
            let boxborderw = (((bg.width + bg.height) / 2.0) * 100.0).round() as i64;
            base.push_str(&format!(":box=1:boxcolor={}:boxborderw={}", boxcolor, boxborderw.max(0)));
        }
    }

    // 描边：borderw + bordercolor（支持不透明度）。borderw 已在上方计算并用于位置补偿
    if borderw > 0 {
        let bordercolor = format!("{}@{:.2}", text.stroke_color.clone().unwrap_or_else(|| "#000000".into()), text.stroke_opacity.unwrap_or(1.0).clamp(0.0, 1.0));
        base.push_str(&format!(":borderw={}:bordercolor={}", borderw, bordercolor));
    }

    // 阴影：drawtext 原生 shadowx/shadowy/shadowcolor（无模糊）。
    // 距离 + 角度极坐标：角度 0°=右，90°=下，-45°=右上；文字本身不被移动
    if let Some(sh) = &text.shadow {
        if sh.enabled {
            let rad = sh.angle * PI / 180.0;
            let shadowx = (sh.distance * rad.cos()).round() as i64;
            let shadowy = (sh.distance * rad.sin()).round() as i64;
            let shadowcolor = format!("{}@{:.2}", sh.color, sh.opacity.clamp(0.0, 1.0));
            base.push_str(&format!(":shadowx={}:shadowy={}:shadowcolor={}", shadowx, shadowy, shadowcolor));
        }
    }

    let fontfile = resolve_font(&text.font_family, weight, fontfile_dir);
    Some(with_fontfile(base, &fontfile))
}

/// 生成字幕 drawtext 滤镜串数组（每条 item 按相对偏移 + clip 起点定位）
pub fn build_subtitle_overlay_filters(
    sub: &SubtitleOverlay,
    timeline_in: f64,
    width: u32,
    height: u32,
    fontfile_dir: &str,
) -> Vec<String> {
    build_subtitle_overlay_filters_impl(sub, width, height, fontfile_dir, |item| {
        (timeline_in + item.start, timeline_in + item.end)
    })
}

/// 完整导出路径用：字幕 item 是素材源时间戳（ASR 结果），预览端按 clipSourceTime
/// 把时间线时间映射为源时间再匹配；导出 drawtext 的 enable 需要时间线时间，故反向换算
/// （变速/倒放/裁剪/曲线变速）。冻结帧（freeze）源时间非单调、语义不唯一，不特殊处理。
pub fn build_subtitle_overlay_filters_for_clip(
    sub: &SubtitleOverlay,
    clip: &crate::project::Clip,
    width: u32,
    height: u32,
    fontfile_dir: &str,
) -> Vec<String> {
    // 时间偏移（提前量）：与预览端 (offset + lead) 严格对称——导出把源时间戳提前 lead 秒，
    // 使字幕比语音提前出现，补偿 ASR 流式识别的时间戳滞后。
    let lead = sub.time_offset;
    build_subtitle_overlay_filters_impl(sub, width, height, fontfile_dir, |item| {
        (source_to_timeline(item.start - lead, clip), source_to_timeline(item.end - lead, clip))
    })
}

/// 源素材时间 → 时间线时间（`clip_source_time` 的逆映射），用于字幕 item 定位。
///
/// 正向映射（预览端 `clipSourceTime`，见 strategy.rs）：
///   `src = src_range.start + off · speed`（正放）；`src_range.start + (dur - off) · speed`（倒放）
/// 逆向（给定源时间 S，求时间线绝对时间 T）：
/// - 线性：`T = timeline_in + (S - src_range.start) / speed`
/// - 倒放（reverse 标志，speed 仍为正）：`T = timeline_in + dur - (S - src_range.start) / speed`
/// - 曲线（curve 非空时忽略 reverse/freeze）：二分反解归一化偏移 `off_norm`，
///   使 `speed_integral(curve, off_norm, 0) == (S - src_range.start) / dur`，
///   再 `T = timeline_in + off_norm · dur`。
pub(crate) fn source_to_timeline(src: f64, clip: &crate::project::Clip) -> f64 {
    let timeline_in = clip.timeline_in;
    let dur = clip.timeline_out - timeline_in;
    let remap = &clip.time_remap;
    let off = if !remap.curve.is_empty() {
        let target = if dur > 1e-9 { (src - clip.src_range.start) / dur } else { 0.0 };
        let mut lo = 0.0f64;
        let mut hi = 1.0f64;
        for _ in 0..80 {
            let mid = 0.5 * (lo + hi);
            if crate::pipeline::strategy::speed_integral(&remap.curve, mid, 0.0) < target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        0.5 * (lo + hi) * dur
    } else if remap.reverse {
        dur - (src - clip.src_range.start) / clip.speed
    } else {
        (src - clip.src_range.start) / clip.speed
    };
    timeline_in + off
}

/// 单条字幕 item 的时间线绝对窗口 [start, end)（`source_to_timeline` 的公开封装）。
/// 供导出端的逐帧 Debug 日志复用，保证与 drawtext 的 enable 窗口完全一致。
pub fn subtitle_item_timeline(item: &SubtitleItemOverride, clip: &crate::project::Clip) -> (f64, f64) {
    (source_to_timeline(item.start, clip), source_to_timeline(item.end, clip))
}

fn build_subtitle_overlay_filters_impl<F>(
    sub: &SubtitleOverlay,
    width: u32,
    height: u32,
    fontfile_dir: &str,
    time_of: F,
) -> Vec<String>
where
    F: Fn(&SubtitleItemOverride) -> (f64, f64),
{
    let fontsize = sub.font_size.unwrap_or(24); // 与预览端 PreviewCanvas 默认 24 对齐
    let fontcolor = sub.color.clone().unwrap_or_else(|| "white".to_string());
    let stroke_width = sub.stroke_width.unwrap_or(0.0);
    let stroke_color = sub.stroke_color.clone().unwrap_or_else(|| "#000000".into());
    let stroke_opacity = sub.stroke_opacity.unwrap_or(1.0).clamp(0.0, 1.0);
    // ffmpeg 的 text_w / text_h 已包含 borderw，描边变粗会撑大 text_w/text_h 导致位置偏移。
    // 补偿 borderw/2 抵消，保证仅描边粗细变化、文字不动。
    let borderw = if stroke_width > 0.0 { stroke_width.round() as i64 } else { 0 };
    let stroke_comp = borderw / 2; // 整数像素补偿
    // 垂直位置：自由定位 pos_y 优先（文字中心锚定到 pos_y*height），否则回退 position 预设。
    // ⚠️ WYSIWYG：position 预设必须与预览（PreviewCanvas.tsx）完全一致——预览把文字**中心**锚定在
    // 归一化比例（top=0.15 / center=0.5 / bottom=0.85），故导出也用 `h*比例 - text_h/2`（drawtext 的
    // y 是文字**顶部**，减 text_h/2 把中心定到比例处）。旧实现 bottom=`h-fontsize-40`(中心≈0.94h)、
    // top=`40`(≈0.04h)，与预览 bottom=0.85/top=0.15 相差甚远——双语字幕「中文 bottom + 英文 pos_y=0.91」
    // 时，预览中文(0.85)在上、导出中文(0.94)反而跑到英文(0.91)下面 → 上下颠倒。
    let y_expr = if let Some(py) = sub.pos_y {
        format!("(h*{} - text_h/2)+{}", py.max(0.0).min(1.0), stroke_comp)
    } else {
        match sub.position.as_deref() {
            Some("top") => format!("(h*0.15 - text_h/2)+{}", stroke_comp),
            Some("bottom") => format!("(h*0.85 - text_h/2)+{}", stroke_comp),
            _ => format!("(h*0.5 - text_h/2)+{}", stroke_comp), // center 默认
        }
    };
    // 水平位置：自由定位 pos_x 优先（文字中心锚定到 pos_x*width），否则回退 align 预设，与预览端一致
    let x_expr = if let Some(px) = sub.pos_x {
        format!("(w*{} - text_w/2)+{}", px.max(0.0).min(1.0), stroke_comp)
    } else {
        match sub.align.as_deref().unwrap_or("center") {
            "left" => format!("20+{}", stroke_comp),
            "right" => format!("(w-text_w-20)+{}", stroke_comp),
            _ => format!("(w-text_w)/2+{}", stroke_comp),
        }
    };
    let _ = width;
    // 字幕无 weight 字段，按 normal 处理（与预览字幕未设字重一致）。
    let fontfile = resolve_font(&sub.font_family, "normal", fontfile_dir);
    // 修复①顺序对齐：构建前按 start 升序排序（仿 parse_srt），保证时序正确、与预览一致。
    let mut items: Vec<&SubtitleItemOverride> = sub.items.iter().filter(|i| !i.text.trim().is_empty()).collect();
    items.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    items.into_iter().map(|item| {
        let escaped = item.text.replace(':', "\\:").replace('\'', "'\\''");
        let (abs_start, abs_end) = time_of(item);
        let mut base = format!(
            "drawtext=text='{}':fontsize={}:fontcolor={}:x={}:y={}:enable='between(t,{},{})'",
            escaped, fontsize, fontcolor, x_expr, y_expr, abs_start, abs_end
        );
        if borderw > 0 {
            let bordercolor = format!("{}@{:.2}", stroke_color, stroke_opacity);
            base.push_str(&format!(":borderw={}:bordercolor={}", borderw, bordercolor));
        }
        // 背景：ffmpeg drawtext 原生 box 为矩形（圆角仅前端预览生效）；width/height 取平均作为边框宽度（近似内边距）
        if let Some(bg) = &sub.background {
            if bg.enabled {
                let boxcolor = format!("{}@{:.2}", bg.color, bg.opacity.clamp(0.0, 1.0));
                let boxborderw = (((bg.width + bg.height) / 2.0) * 100.0).round() as i64;
                base.push_str(&format!(":box=1:boxcolor={}:boxborderw={}", boxcolor, boxborderw.max(0)));
            }
        }
        // 阴影：drawtext 原生 shadowx/shadowy/shadowcolor（无模糊），与预览观感近似一致
        if let Some(sh) = &sub.shadow {
            if sh.enabled {
                let rad = sh.angle * PI / 180.0;
                let shadowx = (sh.distance * rad.cos()).round() as i64;
                let shadowy = (sh.distance * rad.sin()).round() as i64;
                let shadowcolor = format!("{}@{:.2}", sh.color, sh.opacity.clamp(0.0, 1.0));
                base.push_str(&format!(":shadowx={}:shadowy={}:shadowcolor={}", shadowx, shadowy, shadowcolor));
            }
        }
        with_fontfile(base, &fontfile)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_srt_time() {
        assert!((parse_srt_time("00:00:01,500") - 1.5).abs() < 0.01);
        assert!((parse_srt_time("01:00:00,000") - 3600.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_srt_basic() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\nHello World\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line\n";
        let track = parse_srt(srt);
        assert_eq!(track.items.len(), 2);
        assert_eq!(track.items[0].text, "Hello World");
        assert!((track.items[0].start - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_build_drawtext() {
        let track = SubtitleTrack {
            items: vec![SubtitleItem { index: 1, start: 0.0, end: 2.0, text: "Test".into() }],
            style: SubtitleStyle::default(),
        };
        let filters = build_drawtext_filters(&track, 1920, 1080);
        assert_eq!(filters.len(), 1);
        assert!(filters[0].contains("drawtext="));
        assert!(filters[0].contains("Test"));
    }

    #[test]
    fn test_build_text_overlay_filter() {
        let t = TextOverlay { content: "标题".into(), font_size: Some(60), color: Some("yellow".into()), text_align: Some("center".into()), x: None, y: None, ..Default::default() };
        let f = build_text_overlay_filter(&t, 0.0, 5.0, 1920, 1080, "").unwrap();
        assert!(f.contains("drawtext="));
        assert!(f.contains("标题"));
        assert!(f.contains("enable='between(t,0,5)'"));
    }

    #[test]
    fn test_build_subtitle_overlay_filters() {
        let s = SubtitleOverlay {
            items: vec![SubtitleItemOverride { start: 1.0, end: 3.0, text: "你好".into() }],
            font_size: Some(48), color: Some("white".into()), position: Some("bottom".into()),
            ..Default::default()
        };
        let fs = build_subtitle_overlay_filters(&s, 10.0, 1920, 1080, "");
        assert_eq!(fs.len(), 1);
        assert!(fs[0].contains("你好"));
        assert!(fs[0].contains("between(t,11,13)"));  // 10 + 1 .. 10 + 3
    }

    #[test]
    fn test_source_to_timeline_linear_and_reverse() {
        let clip: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c1","assetId":"a1","src_range":{"start":10,"end":50},"timelineIn":5,"timelineOut":25,"speed":2}"#,
        ).unwrap();
        // 线性变速：源时间 12/14 → 时间线 6/7（timeline_in=5 + (12-10)/2 .. (14-10)/2）
        assert!((source_to_timeline(12.0, &clip) - 6.0).abs() < 1e-6);
        assert!((source_to_timeline(14.0, &clip) - 7.0).abs() < 1e-6);

        let rev: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c2","assetId":"a2","src_range":{"start":10,"end":30},"timelineIn":0,"timelineOut":20,"speed":1,"time_remap":{"reverse":true}}"#,
        ).unwrap();
        // 倒放：源 10 → 末尾(20)，源 30 → 开头(0)
        assert!((source_to_timeline(10.0, &rev) - 20.0).abs() < 1e-6);
        assert!((source_to_timeline(30.0, &rev) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn test_build_subtitle_overlay_filters_for_clip() {
        let clip: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c1","assetId":"a1","src_range":{"start":10,"end":50},"timelineIn":5,"timelineOut":25,"speed":2}"#,
        ).unwrap();
        let s = SubtitleOverlay {
            items: vec![SubtitleItemOverride { start: 12.0, end: 14.0, text: "变速字幕".into() }],
            ..Default::default()
        };
        let fs = build_subtitle_overlay_filters_for_clip(&s, &clip, 1920, 1080, "");
        assert_eq!(fs.len(), 1);
        assert!(fs[0].contains("between(t,6,7)"), "got: {}", fs[0]);
    }

    #[test]
    fn test_subtitle_overlay_style_and_offset() {
        let clip: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c1","assetId":"a1","src_range":{"start":0,"end":10},"timelineIn":0,"timelineOut":10,"speed":1}"#,
        ).unwrap();
        let s = SubtitleOverlay {
            items: vec![SubtitleItemOverride { start: 2.0, end: 4.0, text: "样式字幕".into() }],
            align: Some("left".into()),
            position: Some("bottom".into()),
            time_offset: 0.5,
            background: Some(TextBackground { enabled: true, color: "#000000".into(), opacity: 0.9, radius: 0.06, width: 0.2, height: 0.15, offset_x: 0.5, offset_y: 0.5 }),
            shadow: Some(TextShadow { enabled: true, color: "#ff0000".into(), opacity: 0.9, blur: 0.15, distance: 5.0, angle: -45.0 }),
            ..Default::default()
        };
        let fs = build_subtitle_overlay_filters_for_clip(&s, &clip, 1920, 1080, "");
        assert_eq!(fs.len(), 1);
        // 提前量 0.5 → 源时间窗 [2-0.5, 4-0.5) = [1.5, 3.5) → 时间线窗口 (1.5, 3.5)
        assert!(fs[0].contains("between(t,1.5,3.5)"), "got: {}", fs[0]);
        // 左对齐
        assert!(fs[0].contains("x=20+"), "got: {}", fs[0]);
        // 背景盒
        assert!(fs[0].contains("box=1:boxcolor=#000000@0.90"), "got: {}", fs[0]);
        // 阴影
        assert!(fs[0].contains("shadowcolor=#ff0000@0.90"), "got: {}", fs[0]);
    }

    #[test]
    fn test_subtitle_overlay_free_position() {
        let clip: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c1","assetId":"a1","src_range":{"start":0,"end":10},"timelineIn":0,"timelineOut":10,"speed":1}"#,
        ).unwrap();
        // 自由定位：pos_x=0.3, pos_y=0.25 → x=(w*0.3 - text_w/2), y=(h*0.25 - text_h/2)
        let s = SubtitleOverlay {
            items: vec![SubtitleItemOverride { start: 1.0, end: 3.0, text: "自由定位".into() }],
            pos_x: Some(0.3),
            pos_y: Some(0.25),
            ..Default::default()
        };
        let fs = build_subtitle_overlay_filters_for_clip(&s, &clip, 1920, 1080, "");
        assert_eq!(fs.len(), 1);
        assert!(fs[0].contains("x=(w*0.3 - text_w/2)"), "got: {}", fs[0]);
        assert!(fs[0].contains("y=(h*0.25 - text_h/2)"), "got: {}", fs[0]);
    }

    // 用户验证标准：timeline_in=6.44, src_range.start=0, speed=1, item 0~5
    // 必须严格返回绝对时间线窗口 (6.44, 11.44)，既不能遗漏 timeline_in，也不能把 en 算成 st+帧时长。
    #[test]
    fn test_subtitle_item_timeline_absolute_window() {
        let clip: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c","assetId":"a","src_range":{"start":0,"end":5},"timelineIn":6.44,"timelineOut":11.44,"speed":1}"#,
        ).unwrap();
        let item = SubtitleItemOverride { start: 0.0, end: 5.0, text: "验证".into() };
        let (st, en) = subtitle_item_timeline(&item, &clip);
        assert!((st - 6.44).abs() < 1e-9, "st 应为 6.44，实际 {}", st);
        assert!((en - 11.44).abs() < 1e-9, "en 应为 11.44，实际 {}", en);

        // 端到端：导出 drawtext 滤镜的 enable 表达式必须用绝对时间线窗口（浮点尾数 11.4400…001 不影响）
        let s = SubtitleOverlay { items: vec![item], ..Default::default() };
        let fs = build_subtitle_overlay_filters_for_clip(&s, &clip, 1280, 720, "");
        assert!(fs[0].contains("enable='between(t,6.44,11.44"), "got: {}", fs[0]);
    }

    #[test]
    fn test_source_to_timeline_curve_roundtrip() {
        // 曲线变速：srcDur=30，曲线 speed 1→2（f1=∫₀¹=1.5），dur=srcDur/f1=20。
        // clip_source_time 用积分映射 t→src，source_to_timeline 用二分反解 src→t，二者应互逆。
        let clip: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c","assetId":"a","src_range":{"start":10,"end":40},"timelineIn":5,"timelineOut":25,"speed":1,"time_remap":{"curve":[{"speed":1,"play":0},{"speed":2,"play":1}]}}"#,
        ).unwrap();
        for &t in &[5.0, 8.0, 12.0, 15.0, 18.0, 22.0, 25.0] {
            let (src, _frozen) = crate::pipeline::strategy::clip_source_time(t, &clip);
            let back = source_to_timeline(src, &clip);
            assert!((back - t).abs() < 1e-2, "t={} src={} back={}", t, src, back);
        }
    }

    #[test]
    fn test_source_to_timeline_roundtrip() {
        let clip: crate::project::Clip = serde_json::from_str(
            r#"{"id":"c1","assetId":"a1","src_range":{"start":10,"end":50},"timelineIn":5,"timelineOut":25,"speed":2}"#,
        ).unwrap();
        for &t in &[5.0, 8.0, 12.0, 20.0, 25.0] {
            let (src, _frozen) = crate::pipeline::strategy::clip_source_time(t, &clip);
            let back = source_to_timeline(src, &clip);
            assert!((back - t).abs() < 1e-3, "t={} src={} back={}", t, src, back);
        }
    }

    // 关键回归：字幕 items 必须按 start 升序渲染（修复①顺序对齐），乱序构造也应被排序。
    #[test]
    fn test_subtitle_items_sorted_by_start() {
        let s = SubtitleOverlay {
            items: vec![
                SubtitleItemOverride { start: 5.0, end: 7.0, text: "后".into() },
                SubtitleItemOverride { start: 1.0, end: 3.0, text: "先".into() },
                SubtitleItemOverride { start: 3.0, end: 5.0, text: "中".into() },
            ],
            ..Default::default()
        };
        let fs = build_subtitle_overlay_filters(&s, 0.0, 1920, 1080, "");
        assert_eq!(fs.len(), 3);
        assert!(fs[0].contains("先") && fs[0].contains("between(t,1,3)"));
        assert!(fs[1].contains("中") && fs[1].contains("between(t,3,5)"));
        assert!(fs[2].contains("后") && fs[2].contains("between(t,5,7)"));
        // 默认字幕字号应 = 24（与预览 PreviewCanvas 对齐）
        assert!(fs[0].contains("fontsize=24"), "subtitle default fontsize must be 24, got: {}", fs[0]);
    }

    // 关键回归：阴影偏移必须是「阴影相对文字」的偏移，文字本身定位不应被阴影移动
    #[test]
    fn test_shadow_offset_is_relative_to_text() {
        let mut t = TextOverlay {
            content: "标题".into(),
            font_size: Some(60),
            ..Default::default()
        };
        t.shadow = Some(TextShadow {
            enabled: true,
            color: "#000000".into(),
            opacity: 0.9,
            blur: 0.1,
            distance: 22.36,  // sqrt(20^2+10^2) ≈ 22.36 → shadowx≈20, shadowy≈10（角度≈26.565°）
            angle: 26.565,
        });
        let f = build_text_overlay_filter(&t, 0.0, 5.0, 1920, 1080, "").unwrap();
        // 1) 阴影相对文字：正确生成 shadowx/shadowy 偏移量
        assert!(f.contains("shadowx=20"), "shadow must offset relative to text, got: {}", f);
        assert!(f.contains("shadowy=10"), "shadow must offset relative to text, got: {}", f);
        // 2) 文字自身定位由 text_align 决定（默认 center → x=(w-text_w)/2），与阴影偏移完全独立
        assert!(f.contains("x=(w-text_w)/2"), "text positioning must be independent of shadow offset, got: {}", f);
        // 3) 把阴影段去掉后，文字定位段里不应残留 shadowx/shadowy（证明二者是独立字段）
        let text_part = f.split(":shadowx=").next().unwrap_or("");
        assert!(!text_part.contains("shadowx"), "shadow leaked into text positioning: {}", f);
        assert!(!text_part.contains("shadowy"), "shadow leaked into text positioning: {}", f);
    }

    // 关键回归：文字 y 坐标必须以「顶部」为原点（与前端预览 top:y*100% 一致），
    // 不得再用 (1-y)*h（底部原点）造成上下镜像、多文字顺序颠倒。
    #[test]
    fn test_text_overlay_y_is_top_origin() {
        // y=0.25 → 文字中心应在画面 25% 高度处 → top-left = 0.25*h - text_h/2
        let t = TextOverlay {
            content: "标题".into(),
            font_size: Some(60),
            y: Some(0.25),
            ..Default::default()
        };
        let f = build_text_overlay_filter(&t, 0.0, 5.0, 1920, 1080, "").unwrap();
        assert!(f.contains("y=(0.25*h - text_h/2)"),
            "y must be top-origin (y*h), got: {}", f);
        // 反向断言：绝不能出现底部原点写法 (1-y)*h
        assert!(!f.contains("(1-0.25)*h"),
            "y must NOT use bottom-origin (1-y)*h, got: {}", f);
        // y=0.5（居中）时中心应在 50% 高度
        let mut tc = t.clone(); tc.y = Some(0.5);
        let f2 = build_text_overlay_filter(&tc, 0.0, 5.0, 1920, 1080, "").unwrap();
        assert!(f2.contains("(0.5*h - text_h/2)"), "center y must be 0.5*h, got: {}", f2);
    }

    // 描边回归：borderw/bordercolor 必须生成，且 bordercolor 带 alpha 反映 stroke_opacity
    #[test]
    fn test_text_stroke_opacity_in_filter() {
        let t = TextOverlay {
            content: "描边".into(),
            font_size: Some(48),
            stroke_color: Some("#ff0000".into()),
            stroke_width: Some(2.5),
            stroke_opacity: Some(0.75),
            ..Default::default()
        };
        let f = build_text_overlay_filter(&t, 0.0, 5.0, 1920, 1080, "").unwrap();
        assert!(f.contains("borderw=3"), "stroke width must round to integer borderw, got: {}", f);
        assert!(f.contains("bordercolor=#ff0000@0.75"), "stroke color must carry opacity, got: {}", f);
    }

    #[test]
    fn test_subtitle_stroke_in_filter() {
        let s = SubtitleOverlay {
            items: vec![SubtitleItemOverride { start: 0.0, end: 2.0, text: "字幕描边".into() }],
            stroke_color: Some("#00ff00".into()),
            stroke_width: Some(1.5),
            stroke_opacity: Some(0.6),
            ..Default::default()
        };
        let fs = build_subtitle_overlay_filters(&s, 0.0, 1920, 1080, "");
        assert_eq!(fs.len(), 1);
        assert!(fs[0].contains("borderw=2"), "subtitle stroke width must round, got: {}", fs[0]);
        assert!(fs[0].contains("bordercolor=#00ff00@0.60"), "subtitle stroke color must carry opacity, got: {}", fs[0]);
    }

    // 关键回归：随包字体解析到随包 TTF；系统字体（楷体/黑体/仿宋/Impact）必须读取
    // 终端用户的系统字体库，绝不能把系统字体直接兜底成 NotoSansSC-Regular.ttf。
    #[test]
    fn test_cjk_font_fallback_to_ttf() {
        let fonts_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/gui/public/fonts");
        // 随包字体：必须解析到随包目录里的真实 TTF
        let bundled_cases = vec![
            (Some("source-han-sans".into()), "NotoSansSC-Regular.ttf"),
            (Some("zcool-kuaile".into()), "ZCOOLKuaiLe-Regular.ttf"),
            (Some("zcool-hei".into()), "ZCOOLQingKeHuangYou-Regular.ttf"),
            (Some("bebas".into()), "BebasNeue-Regular.ttf"),
            (Some("NotoSansSC-Regular.woff2".into()), "NotoSansSC-Regular.ttf"), // 旧工程 woff2 → 完整 TTF
            (Some("alipuhui".into()), "NotoSansSC-Regular.ttf"),                   // 已移除 id → 可用 CJK
            (Some("source-han-serif".into()), "NotoSansSC-Regular.ttf"),           // 已移除 id → 可用 CJK
            (None, "NotoSansSC-Regular.ttf"),                                      // 未指定 → 兜底
        ];
        for (family, expected) in bundled_cases {
            let resolved = resolve_font(&family, "normal", fonts_dir);
            assert!(resolved.is_some(), "family={:?} should resolve", family);
            let path = resolved.unwrap();
            assert!(path.replace('\\', "/").ends_with(expected),
                "family={:?} expected to end with {}, got {}", family, expected, path);
        }

        // 系统字体（楷体/黑体/仿宋/Impact）：不随包，必须读取终端用户的系统字体库。
        // 仅在当前环境能发现系统字体目录时才断言（跨平台 CI 可能无系统字体）。
        let has_sys = system_fonts_dirs().iter().any(|d| d.exists());
        if has_sys {
            let sys_cases = vec![
                ("kaiti", "simkai"),
                ("simhei", "simhei"),
                ("fangsong", "simfang"),
                ("impact", "impact"),
            ];
            for (id, needle) in sys_cases {
                // 传空随包目录，强制只走系统字体库路径，验证不落到保底字体
                let resolved = resolve_font(&Some(id.into()), "normal", "");
                assert!(resolved.is_some(), "system font {} should resolve from system lib", id);
                let p = resolved.unwrap().replace('\\', "/").to_lowercase();
                assert!(p.contains(needle),
                    "system font {} must resolve to *{}* in user's system font library, got {}", id, needle, p);
                assert!(!p.ends_with("notosanssc-regular.ttf"),
                    "system font {} must NOT be silently fallback to bundled CJK font, got {}", id, p);
            }

            // 关键回归：黑体 bold 必须解析到真实 SimHei(simhei.ttf)，绝不能换成微软雅黑(msyhbd.ttc)，
            // 否则与预览（系统 SimHei + font-synthesis:none 禁用伪粗体）字体不一致 → 导出比预览细/不同。
            let simhei_bold = resolve_font(&Some("simhei".into()), "bold", "");
            assert!(simhei_bold.is_some(), "simhei bold should resolve from system lib");
            let sb = simhei_bold.unwrap().replace('\\', "/").to_lowercase();
            assert!(sb.contains("simhei"), "simhei bold must resolve to simhei.ttf, got {}", sb);
            assert!(!sb.contains("msyh"), "simhei bold must NOT fall back to Microsoft YaHei (msyh*), got {}", sb);
        }
    }

    // 关键回归：字重 bold 必须解析到 *-Bold.ttf 变体（思源黑体），与前端 @font-face 契约一致；
    // 其余随包字体（站酷/Bebas）无 Bold 文件时 bold 回退 Regular，绝不能臆造不存在的文件。
    #[test]
    fn test_font_weight_resolves_bold_ttf() {
        let fonts_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/gui/public/fonts");
        // 思源黑体 bold → 真实 Bold ttf
        let resolved = resolve_font(&Some("source-han-sans".into()), "bold", fonts_dir);
        assert!(resolved.is_some());
        assert!(resolved.unwrap().replace('\\', "/").ends_with("NotoSansSC-Bold.ttf"),
            "source-han-sans bold must resolve to NotoSansSC-Bold.ttf");
        // 思源黑体 normal → Regular ttf
        let r2 = resolve_font(&Some("source-han-sans".into()), "normal", fonts_dir);
        assert!(r2.unwrap().replace('\\', "/").ends_with("NotoSansSC-Regular.ttf"));
        // 站酷快乐体无 Bold 文件 → bold 回退 Regular（同文件），而非报错或落到别的字体
        let r3 = resolve_font(&Some("zcool-kuaile".into()), "bold", fonts_dir);
        assert!(r3.unwrap().replace('\\', "/").ends_with("ZCOOLKuaiLe-Regular.ttf"));
        // 未指定字重（默认）也应解析成功
        let r4 = resolve_font(&Some("bebas".into()), "", fonts_dir);
        assert!(r4.unwrap().replace('\\', "/").ends_with("BebasNeue-Regular.ttf"));
    }

    // 关键回归：描边粗细变化不应移动文字中心（导出侧 borderw 补偿）
    // ffmpeg 的 text_w 含 borderw，描边变粗会撑大 text_w，使 (w-text_w)/2 偏移；
    // 补偿 borderw/2 后中心 x = (w-real_text_w)/2 恒定，仅描边粗细变、文字不动。
    #[test]
    fn test_stroke_width_does_not_shift_text_center() {
        let base = TextOverlay { content: "标题".into(), font_size: Some(60), ..Default::default() };
        let f0 = build_text_overlay_filter(&base, 0.0, 5.0, 1920, 1080, "").unwrap();
        let mut thin = base.clone(); thin.stroke_width = Some(2.0);
        let f_thin = build_text_overlay_filter(&thin, 0.0, 5.0, 1920, 1080, "").unwrap();
        let mut thick = base.clone(); thick.stroke_width = Some(10.0);
        let f_thick = build_text_overlay_filter(&thick, 0.0, 5.0, 1920, 1080, "").unwrap();
        assert!(f0.contains("x=(w-text_w)/2"), "无描边应无补偿: {}", f0);
        assert!(f_thin.contains("x=(w-text_w)/2+1"), "细描边 borderw=2 → 补偿 +1: {}", f_thin);
        assert!(f_thick.contains("x=(w-text_w)/2+5"), "粗描边 borderw=10 → 补偿 +5: {}", f_thick);
        // y 同样需要补偿（center 默认 y=(h-fontsize)/2+...）
        assert!(f_thin.contains("+1"), "细描边 y 也应补偿 +1: {}", f_thin);
        assert!(f_thick.contains("+5"), "粗描边 y 也应补偿 +5: {}", f_thick);

        // 字幕分支同理
        let s_base = SubtitleOverlay { items: vec![SubtitleItemOverride { start: 0.0, end: 2.0, text: "字幕".into() }], ..Default::default() };
        let mut s_thick = s_base.clone(); s_thick.stroke_width = Some(10.0);
        let fs = build_subtitle_overlay_filters(&s_thick, 0.0, 1920, 1080, "");
        assert!(fs[0].contains("x=(w-text_w)/2+5"), "字幕粗描边 x 补偿 +5: {}", fs[0]);
    }
}
