//! src/subtitle.rs — 字幕系统
//! SRT 解析 + ASS 基础解析 + drawtext 滤镜生成

use serde::{Deserialize, Serialize};

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
    ass.push_str(&format!("Style: Default,{},24,&H00FFFFFF,{},{},{}\n\n",
        track.style.font, if track.style.bold { 1 } else { 0 }, track.style.outline, track.style.alignment));
    ass.push_str("[Events]\nFormat: Layer, Start, End, Style, Text\n");
    for item in &track.items {
        ass.push_str(&format!("Dialogue: 0,{:.2},{:.2},Default,{}\n",
            item.start, item.end, item.text));
    }
    ass
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
}
