//! src/provider.rs — AI Provider 接口 (Phase 3)
//!
//! ASR (语音识别) 和 LLM (文案生成) 的抽象接口。
//! 默认实现：Whisper CLI + OpenAI/DeepSeek API。
//! MCP 工具: transcribe_audio / generate_script / text_to_project

use serde::{Deserialize, Serialize};
use std::process::Command;

// ════════════════════ ASR Provider ════════════════════

/// ASR 转写结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptResult {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// ASR Provider 接口
pub trait AsrProvider {
    fn transcribe(&self, audio_path: &str, language: &str) -> Result<TranscriptResult, String>;
}

/// Whisper CLI 实现（需 whisper.cpp 在 PATH 中）
pub struct WhisperProvider {
    pub model_path: String,
}

impl AsrProvider for WhisperProvider {
    fn transcribe(&self, audio_path: &str, language: &str) -> Result<TranscriptResult, String> {
        let out = Command::new("whisper")
            .args(["-m", &self.model_path, "-f", audio_path, "-l", language, "-oj"])
            .output()
            .map_err(|e| format!("Whisper 执行失败: {}", e))?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }

        let stdout = String::from_utf8_lossy(&out.stdout);
        parse_whisper_json(&stdout)
    }
}

fn parse_whisper_json(json: &str) -> Result<TranscriptResult, String> {
    let root: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Whisper JSON 解析失败: {}", e))?;

    let text = root["text"].as_str().unwrap_or("").to_string();
    let segments: Vec<TranscriptSegment> = root["segments"].as_array()
        .map(|arr| arr.iter().filter_map(|s| Some(TranscriptSegment {
            start: s["start"].as_f64()?,
            end: s["end"].as_f64()?,
            text: s["text"].as_str()?.to_string(),
        })).collect())
        .unwrap_or_default();

    Ok(TranscriptResult { text, segments })
}

/// 将转写结果转换为 SRT 字幕字符串
pub fn transcript_to_srt(result: &TranscriptResult) -> String {
    let mut srt = String::new();
    for (i, seg) in result.segments.iter().enumerate() {
        srt.push_str(&format!("{}\n", i + 1));
        srt.push_str(&format!("{} --> {}\n", format_srt_time(seg.start), format_srt_time(seg.end)));
        srt.push_str(&format!("{}\n\n", seg.text));
    }
    srt
}

fn format_srt_time(seconds: f64) -> String {
    let h = (seconds / 3600.0) as u32;
    let m = ((seconds % 3600.0) / 60.0) as u32;
    let s = seconds % 60.0;
    format!("{:02}:{:02}:{:06.3}", h, m, s).replace('.', ",")
}

// ════════════════════ LLM Provider ════════════════════

/// LLM API 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: String,       // "openai", "deepseek", "ollama"
    pub api_key: String,
    pub model: String,          // "gpt-4o", "deepseek-chat", "llama3"
    pub base_url: Option<String>,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: "deepseek".into(),
            api_key: std::env::var("DEEPSEEK_API_KEY").unwrap_or_default(),
            model: "deepseek-chat".into(),
            base_url: Some("https://api.deepseek.com/v1".into()),
        }
    }
}

/// 文案生成请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptRequest {
    pub topic: String,
    pub duration_secs: f64,
    pub style: String,      // "vlog", "tutorial", "commercial", "story"
}

/// 生成的视频脚本
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptResult {
    pub scenes: Vec<ScriptScene>,
    pub total_duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptScene {
    pub description: String,
    pub duration: f64,
    pub text_overlay: Option<String>,
    pub suggested_filter: Option<String>,
}

/// 将脚本转换为 AIcut 工程 JSON
pub fn script_to_project(script: &ScriptResult, assets: &[String]) -> crate::project::Project {
    let mut project = crate::project::Project {
        version: "1.0".into(),
        canvas: crate::project::CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
        assets: vec![],
        tracks: vec![crate::project::Track {
            id: "main".into(), track_type: "video".into(), order: 0, clips: vec![],
            ..Default::default()
        }],
    };

    for (i, asset_path) in assets.iter().enumerate() {
        project.assets.push(crate::project::Asset {
            id: format!("a{}", i), asset_type: "video".into(),
            path: asset_path.clone(), duration: script.total_duration,
            width: 1920, height: 1080, codec: "h264".into(),
        });
    }

    let mut t = 0.0;
    for (i, scene) in script.scenes.iter().enumerate() {
        let asset_id = format!("a{}", i.min(assets.len().saturating_sub(1)));
        let mut filters = Vec::new();
        if let Some(ref f) = scene.suggested_filter {
            let mut params = std::collections::HashMap::new();
            params.insert("brightness".to_string(), 0.0);
            filters.push(crate::types::FilterInstance { kind: f.clone(), params, enabled: true });
        }
        project.tracks[0].clips.push(crate::project::Clip {
            id: format!("c{}", i), asset_id,
            src_range: crate::project::Range { start: 0.0, end: scene.duration },
            timeline_in: t, timeline_out: t + scene.duration,
            transform: crate::project::Transform { x: 0.5, y: 0.5, scale_x: 1.0, scale_y: 1.0, rotation: 0.0, opacity: 1.0 },
            volume: 1.0, speed: 1.0,
            effects: vec![], masks: vec![], filters, keyframes: Default::default(), speed_curve: vec![],
        });
        t += scene.duration;
    }
    project
}

/// 通过 LLM API 生成视频脚本（同步占位实现，网络可用时替换为 HTTP client）
pub fn generate_script(_config: &LlmConfig, request: &ScriptRequest) -> Result<ScriptResult, String> {
    // 实际实现需要 HTTP client (reqwest) + tokio 调用 LLM API。
    // 当前返回模板脚本作为占位。
    let scene_count = (request.duration_secs / 5.0).ceil() as usize;
    let scenes: Vec<ScriptScene> = (0..scene_count).map(|i| ScriptScene {
        description: format!("{} - 场景 {}", request.topic, i + 1),
        duration: 5.0,
        text_overlay: if i == 0 { Some(request.topic.clone()) } else { None },
        suggested_filter: match request.style.as_str() {
            "vlog" => Some("coloradjust".into()),
            "commercial" => Some("curves".into()),
            _ => None,
        },
    }).collect();

    Ok(ScriptResult {
        total_duration: scene_count as f64 * 5.0,
        scenes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_srt_time() {
        assert_eq!(format_srt_time(1.5), "00:00:01,500");
        assert_eq!(format_srt_time(3661.0), "01:01:01,000");
    }

    #[test]
    fn test_transcript_to_srt() {
        let result = TranscriptResult {
            text: "Hello world".into(),
            segments: vec![TranscriptSegment { start: 0.0, end: 2.0, text: "Hello world".into() }],
        };
        let srt = transcript_to_srt(&result);
        assert!(srt.contains("Hello world"));
        assert!(srt.contains("00:00:00,000 --> 00:00:02,000"));
    }

    #[test]
    fn test_script_to_project() {
        let script = ScriptResult {
            scenes: vec![
                ScriptScene { description: "Intro".into(), duration: 3.0, text_overlay: Some("Title".into()), suggested_filter: None },
                ScriptScene { description: "Main".into(), duration: 4.0, text_overlay: None, suggested_filter: Some("coloradjust".into()) },
            ],
            total_duration: 7.0,
        };
        let assets = vec!["clip1.mp4".to_string()];
        let project = script_to_project(&script, &assets);
        assert_eq!(project.tracks[0].clips.len(), 2);
        assert!((project.tracks[0].clips[1].timeline_in - 3.0).abs() < 0.01);
        assert_eq!(project.assets.len(), 1);
    }

    #[test]
    fn test_llm_config_default() {
        let config = LlmConfig::default();
        assert_eq!(config.provider, "deepseek");
        assert_eq!(config.model, "deepseek-chat");
    }
}
