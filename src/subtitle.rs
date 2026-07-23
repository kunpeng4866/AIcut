//! src/subtitle.rs — 字幕系统
//! SRT 解析 + ASS 基础解析 + drawtext 滤镜生成

use serde::{Deserialize, Serialize};

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
    #[serde(default)] pub stroke_width: Option<u32>,
    #[serde(default)] pub text_align: Option<String>,
    #[serde(default)] pub x: Option<f64>,
    #[serde(default)] pub y: Option<f64>,
    #[serde(default)] pub rotation: Option<f64>,
    #[serde(default)] pub opacity: Option<f64>,
}

/// 前端 SubtitleContent 的 Rust 映射
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleOverlay {
    pub items: Vec<SubtitleItemOverride>,
    #[serde(default)] pub font_family: Option<String>,
    #[serde(default)] pub font_size: Option<u32>,
    #[serde(default)] pub color: Option<String>,
    #[serde(default)] pub position: Option<String>,
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
) -> Option<String> {
    if text.content.trim().is_empty() { return None; }
    let escaped = text.content.replace(':', "\\:").replace('\'', "'\\''");
    let fontsize = text.font_size.unwrap_or(48);
    let fontcolor = text.color.clone().unwrap_or_else(|| "white".to_string());
    // x 定位
    let x_expr = match text.text_align.as_deref() {
        Some("left") => "20".to_string(),
        Some("right") => "(w-text_w-20)".to_string(),
        _ => "(w-text_w)/2".to_string(), // center 默认
    };
    // y 定位：优先用 text.y（归一化 0-1，原点左下角 → 像素），否则垂直居中偏上
    let y_expr = if let Some(y) = text.y {
        format!("((1-{})*h - text_h/2)", y)
    } else {
        format!("(h - {})/2", fontsize)
    };
    let _ = (width, height);
    Some(format!(
        "drawtext=text='{}':fontsize={}:fontcolor={}:x={}:y={}:enable='between(t,{},{})'",
        escaped, fontsize, fontcolor, x_expr, y_expr,
        timeline_in, timeline_out
    ))
}

/// 生成字幕 drawtext 滤镜串数组（每条 item 按相对偏移 + clip 起点定位）
pub fn build_subtitle_overlay_filters(
    sub: &SubtitleOverlay,
    timeline_in: f64,
    width: u32,
    height: u32,
) -> Vec<String> {
    let fontsize = sub.font_size.unwrap_or(48);
    let fontcolor = sub.color.clone().unwrap_or_else(|| "white".to_string());
    let y_pos = match sub.position.as_deref() {
        Some("top") => 40i64,
        Some("bottom") => (height as i64) - fontsize as i64 - 40,
        _ => ((height as i64) / 2) - (fontsize as i64) / 2, // center 默认
    };
    let _ = width;
    sub.items.iter().filter(|i| !i.text.trim().is_empty()).map(|item| {
        let escaped = item.text.replace(':', "\\:").replace('\'', "'\\''");
        let abs_start = timeline_in + item.start;
        let abs_end = timeline_in + item.end;
        format!(
            "drawtext=text='{}':fontsize={}:fontcolor={}:x=(w-text_w)/2:y={}:enable='between(t,{},{})'",
            escaped, fontsize, fontcolor, y_pos, abs_start, abs_end
        )
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
        let f = build_text_overlay_filter(&t, 0.0, 5.0, 1920, 1080).unwrap();
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
        let fs = build_subtitle_overlay_filters(&s, 10.0, 1920, 1080);
        assert_eq!(fs.len(), 1);
        assert!(fs[0].contains("你好"));
        assert!(fs[0].contains("between(t,11,13)"));  // 10 + 1 .. 10 + 3
    }
}
