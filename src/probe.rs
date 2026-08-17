//! src/probe.rs — 媒体文件探测
//! 通过 ffprobe 提取视频/音频/图片的元数据

use serde::{Deserialize, Serialize};
use std::process::Command;

/// 探测结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    pub path: String,
    pub media_type: String,     // "video", "audio", "image"
    pub duration: f64,          // 秒
    pub width: u32,
    pub height: u32,
    pub codec: String,
    pub fps: f64,
    pub sample_rate: u32,
    pub bitrate_kbps: f64,
    /// 采样宽高比 (SAR)：如 "4:3"→1.333、"1:1"→1.0。非正方形像素时用于换算显示宽高。
    #[serde(default = "one_f")]
    pub sar: f64,
}

impl Default for MediaInfo {
    fn default() -> Self {
        Self {
            path: String::new(), media_type: "video".into(),
            duration: 0.0, width: 1920, height: 1080,
            codec: "h264".into(), fps: 30.0, sample_rate: 48000, bitrate_kbps: 8000.0,
            sar: 1.0,
        }
    }
}

impl MediaInfo {
    /// 显示宽度：码流像素宽 × SAR（非正方形像素纠正为显示像素）。
    pub fn display_width(&self) -> u32 { (self.width as f64 * self.sar).round() as u32 }
    /// 显示高度：SAR 仅拉伸宽度（像素宽高比），高度不变。
    pub fn display_height(&self) -> u32 { self.height }
}

/// 通过 ffprobe 探测媒体文件元数据
pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let out = Command::new("ffprobe")
        .args([
            "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", path,
        ])
        .output()
        .map_err(|e| format!("ffprobe 执行失败: {}", e))?;

    if !out.status.success() {
        return Err(format!("ffprobe 返回错误: {}", String::from_utf8_lossy(&out.stderr)));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);

    // ffprobe 可能返回空 JSON（如路径编码问题），在此报错而非返回默认值
    if stdout.trim().is_empty() || stdout.trim() == "{}" {
        return Err(format!("ffprobe 无法探测文件 (返回空结果): {}", path));
    }

    parse_ffprobe_json(path, &stdout)
}

/// 从 JSON 值中提取 duration，同时支持数字和字符串格式
/// ffprobe 不同版本/平台可能返回 `"37.76"` (string) 或 `37.76` (number)
fn json_duration(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

fn parse_ffprobe_json(path: &str, json: &str) -> Result<MediaInfo, String> {
    let root: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("ffprobe JSON 解析失败: {}", e))?;

    // 初始 media_type 设为空字符串，避免默认 "video" 导致音频流被跳过
    let mut info = MediaInfo {
        path: path.to_string(),
        media_type: String::new(),
        ..Default::default()
    };

    // 取第一个视频流或音频流
    if let Some(streams) = root["streams"].as_array() {
        for s in streams {
            let codec_type = s["codec_type"].as_str().unwrap_or("");
            match codec_type {
                "video" => {
                    info.media_type = "video".into();
                    info.width = s["width"].as_u64().unwrap_or(1920) as u32;
                    info.height = s["height"].as_u64().unwrap_or(1080) as u32;
                    info.codec = s["codec_name"].as_str().unwrap_or("h264").into();
                    // SAR：sample_aspect_ratio 形如 "4:3"，解析为数值；缺失/无效/0 默认 1.0。
                    info.sar = s["sample_aspect_ratio"].as_str()
                        .and_then(parse_ratio)
                        .filter(|r| *r > 0.0)
                        .unwrap_or(1.0);
                    // fps = r_frame_rate (如 "30000/1001")
                    if let Some(fps_str) = s["r_frame_rate"].as_str() {
                        info.fps = parse_fraction(fps_str).unwrap_or(30.0);
                    }
                    info.duration = json_duration(&s["duration"]).unwrap_or(0.0);
                }
                "audio" => {
                    if info.media_type == "video" { continue; } // 已有视频流
                    info.media_type = "audio".into();
                    info.codec = s["codec_name"].as_str().unwrap_or("aac").into();
                    info.sample_rate = s["sample_rate"].as_str()
                        .and_then(|s| s.parse().ok()).unwrap_or(48000);
                    info.duration = json_duration(&s["duration"]).unwrap_or(0.0);
                }
                _ => {}
            }
        }
    }

    // format 级别的 duration 作为后备
    if info.duration == 0.0 {
        if let Some(dur) = json_duration(&root["format"]["duration"]) {
            info.duration = dur;
        }
    }
    // format 级别的 bit_rate（字符串格式）
    if let Some(bitrate) = root["format"]["bit_rate"].as_str() {
        info.bitrate_kbps = bitrate.parse::<f64>().unwrap_or(8000.0) / 1000.0;
    }

    Ok(info)
}

fn parse_fraction(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() == 2 {
        let num: f64 = parts[0].parse().ok()?;
        let den: f64 = parts[1].parse().ok()?;
        if den != 0.0 { Some(num / den) } else { None }
    } else {
        None
    }
}

/// 解析 "4:3" 或 "4/3" 形式的比值字符串（SAR 用 ':'，帧率用 '/'）。
fn parse_ratio(s: &str) -> Option<f64> {
    for sep in [':', '/'] {
        if let Some((num, den)) = s.split_once(sep) {
            let n: f64 = num.trim().parse().ok()?;
            let d: f64 = den.trim().parse().ok()?;
            if d != 0.0 { return Some(n / d); }
        }
    }
    None
}

fn one_f() -> f64 { 1.0 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_fraction() {
        assert!((parse_fraction("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert!((parse_fraction("30/1").unwrap() - 30.0).abs() < 0.01);
        assert!(parse_fraction("invalid").is_none());
    }

    #[test]
    fn test_parse_ffprobe_json_minimal() {
        let json = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"codec_name":"h264","r_frame_rate":"30/1","duration":10.0}],"format":{"duration":"10.0","bit_rate":"8000000"}}"#;
        let info = parse_ffprobe_json("test.mp4", json).unwrap();
        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert!((info.duration - 10.0).abs() < 0.01);
        assert_eq!(info.media_type, "video");
    }

    #[test]
    fn test_parse_ffprobe_json_audio_only() {
        // ffprobe 对 m4a 文件返回的格式：duration 是字符串
        let json = r#"{"streams":[{"codec_type":"audio","codec_name":"aac","sample_rate":"48000","duration":"37.759937"}],"format":{"duration":"37.759938","bit_rate":"195121"}}"#;
        let info = parse_ffprobe_json("test.m4a", json).unwrap();
        assert_eq!(info.media_type, "audio");
        assert_eq!(info.codec, "aac");
        assert_eq!(info.sample_rate, 48000);
        assert!((info.duration - 37.76).abs() < 0.01);
    }

    #[test]
    fn test_parse_ffprobe_json_audio_with_video() {
        // 视频文件含音频流：应识别为 video，不跳过音频 duration
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"30/1","duration":"10.5"},{"codec_type":"audio","codec_name":"aac","sample_rate":"44100","duration":"10.5"}],"format":{"duration":"10.5"}}"#;
        let info = parse_ffprobe_json("test.mp4", json).unwrap();
        assert_eq!(info.media_type, "video");
        assert!((info.duration - 10.5).abs() < 0.01);
    }

    #[test]
    fn test_json_duration() {
        assert_eq!(json_duration(&serde_json::json!(37.76)), Some(37.76));
        assert_eq!(json_duration(&serde_json::json!("37.76")), Some(37.76));
        assert_eq!(json_duration(&serde_json::json!(null)), None);
        assert_eq!(json_duration(&serde_json::json!("invalid")), None);
    }

    #[test]
    fn test_media_info_default() {
        let info = MediaInfo::default();
        assert_eq!(info.media_type, "video");
        assert_eq!(info.width, 1920);
    }
}
