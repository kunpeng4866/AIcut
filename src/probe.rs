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
}

impl Default for MediaInfo {
    fn default() -> Self {
        Self {
            path: String::new(), media_type: "video".into(),
            duration: 0.0, width: 1920, height: 1080,
            codec: "h264".into(), fps: 30.0, sample_rate: 48000, bitrate_kbps: 8000.0,
        }
    }
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
    parse_ffprobe_json(path, &stdout)
}

fn parse_ffprobe_json(path: &str, json: &str) -> Result<MediaInfo, String> {
    let root: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("ffprobe JSON 解析失败: {}", e))?;

    let mut info = MediaInfo { path: path.to_string(), ..Default::default() };

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
                    // fps = r_frame_rate (如 "30000/1001")
                    if let Some(fps_str) = s["r_frame_rate"].as_str() {
                        info.fps = parse_fraction(fps_str).unwrap_or(30.0);
                    }
                    info.duration = s["duration"].as_f64()
                        .or_else(|| s["duration"].as_str().and_then(|v| v.parse().ok()))
                        .unwrap_or(0.0);
                }
                "audio" => {
                    if info.media_type == "video" { continue; } // 已有视频流
                    info.media_type = "audio".into();
                    info.codec = s["codec_name"].as_str().unwrap_or("aac").into();
                    info.sample_rate = s["sample_rate"].as_str()
                        .and_then(|s| s.parse().ok()).unwrap_or(48000);
                    if let Some(dur) = s["duration"].as_f64() { info.duration = dur; }
                }
                _ => {}
            }
        }
    }

    // format 级别的 duration 作为后备
    if info.duration == 0.0 {
        if let Some(dur) = root["format"]["duration"].as_f64() {
            info.duration = dur;
        }
    }
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
    fn test_media_info_default() {
        let info = MediaInfo::default();
        assert_eq!(info.media_type, "video");
        assert_eq!(info.width, 1920);
    }
}
