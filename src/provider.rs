//! src/provider.rs — AI Provider 接口 (Phase 3)
//!
//! ASR (语音识别) 和 LLM (文案生成) 的抽象接口。
//! 默认实现：Whisper CLI + OpenAI/DeepSeek API。
//! MCP 工具: transcribe_audio / generate_script / text_to_project

use serde::{Deserialize, Serialize};
use std::process::Command;

/// whisper.cpp CLI 默认路径（Windows 原生二进制，使用反斜杠路径）
pub const DEFAULT_WHISPER_ENGINE: &str = r"E:\codex\codex-tools\whisper\whisper-cli.exe";
/// whisper.cpp 默认多语种模型（base，支持 zh/en）
pub const DEFAULT_WHISPER_MODEL: &str = r"E:\codex\codex-tools\whisper\ggml-base.bin";
/// ffmpeg 默认路径（用于把任意音视频抽成 16k 单声道 wav）
pub const DEFAULT_FFMPEG: &str = r"E:\codex\codex-tools\bin\ffmpeg.exe";

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

/// whisper.cpp 实现（本地 whisper-cli + ffmpeg 抽轨）
pub struct WhisperProvider {
    pub engine_path: String,  // whisper-cli.exe 路径
    pub model_path: String,   // ggml-*.bin 模型路径
    pub ffmpeg_path: String,  // ffmpeg.exe 路径（抽音频用）
}

impl WhisperProvider {
    /// 使用默认引擎/模型/ffmpeg 路径构造
    pub fn new() -> Self {
        Self {
            engine_path: DEFAULT_WHISPER_ENGINE.into(),
            model_path: DEFAULT_WHISPER_MODEL.into(),
            ffmpeg_path: DEFAULT_FFMPEG.into(),
        }
    }

    /// 显式指定引擎与模型路径（ffmpeg 仍用默认路径）
    pub fn with_paths(engine_path: String, model_path: String) -> Self {
        Self {
            engine_path,
            model_path,
            ffmpeg_path: DEFAULT_FFMPEG.into(),
        }
    }
}

impl Default for WhisperProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AsrProvider for WhisperProvider {
    fn transcribe(&self, audio_path: &str, language: &str) -> Result<TranscriptResult, String> {
        let lang = if language.is_empty() { "zh" } else { language };

        // 1) 用 ffmpeg 把任意音视频抽成 16k 单声道 wav（whisper.cpp 自带解码器有限）
        let wav_base = std::env::temp_dir().join(format!("aicut_asr_{}", unique_id()));
        let wav_path = wav_base.to_string_lossy().to_string();
        let ff = Command::new(&self.ffmpeg_path)
            .args(["-y", "-i", audio_path, "-ar", "16000", "-ac", "1", "-f", "wav", &wav_path])
            .output()
            .map_err(|e| format!("ffmpeg 执行失败 ({}): {}", self.ffmpeg_path, e))?;
        if !ff.status.success() {
            let _ = std::fs::remove_file(&wav_path);
            return Err(format!("ffmpeg 抽取音频失败: {}", String::from_utf8_lossy(&ff.stderr)));
        }

        // 2) 用 whisper.cpp 转写，JSON 输出到 <base>.json（-np 抑制控制台多余输出）
        let json_base = std::env::temp_dir().join(format!("aicut_asr_{}", unique_id()));
        let json_base_s = json_base.to_string_lossy().to_string();
        let json_path = format!("{}.json", json_base_s);

        let wcmd = Command::new(&self.engine_path)
            .args([
                "-m", &self.model_path,
                "-f", &wav_path,
                "-l", lang,
                "-oj", "-of", &json_base_s,
                "-np",
            ])
            .output()
            .map_err(|e| format!("whisper-cli 执行失败 ({}): {}", self.engine_path, e))?;

        // 无论成功与否都清理临时 wav
        let _ = std::fs::remove_file(&wav_path);

        // 优先读取 whisper.cpp 写出的 JSON 文件；文件缺失时回退到 stdout
        let json_text = if std::path::Path::new(&json_path).exists() {
            std::fs::read_to_string(&json_path).unwrap_or_default()
        } else {
            String::from_utf8_lossy(&wcmd.stdout).to_string()
        };
        let _ = std::fs::remove_file(&json_path);

        if !wcmd.status.success() && json_text.trim().is_empty() {
            return Err(format!("whisper-cli 转写失败: {}", String::from_utf8_lossy(&wcmd.stderr)));
        }

        parse_whisper_json(&json_text)
    }
}

/// 生成进程内唯一的临时文件名片段
fn unique_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}_{}", std::process::id(), nanos)
}

/// 把 JSON Value 读成 f64（兼容整数/浮点）
fn as_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|i| i as f64))
        .or_else(|| v.as_u64().map(|i| i as f64))
}

/// 读取 transcription[i].offsets.{from,to}（毫秒）并转为秒
fn offset_ms(seg: &serde_json::Value, key: &str) -> f64 {
    seg.get("offsets")
        .and_then(|o| o.get(key))
        .and_then(as_f64)
        .unwrap_or(0.0)
        / 1000.0
}

fn parse_whisper_json(json: &str) -> Result<TranscriptResult, String> {
    let root: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Whisper JSON 解析失败: {}", e))?;

    // whisper.cpp `-oj` 实测结构：root["transcription"] = [{ offsets:{from,to}(ms), text, timestamps }]
    if let Some(arr) = root.get("transcription").and_then(|v| v.as_array()) {
        let mut text = String::new();
        let mut segments = Vec::with_capacity(arr.len());
        for seg in arr {
            let start = offset_ms(seg, "from");
            let end = offset_ms(seg, "to");
            let seg_text = seg.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&seg_text);
            segments.push(TranscriptSegment { start, end, text: seg_text });
        }
        return Ok(TranscriptResult { text, segments });
    }

    // 兼容：根对象直接含 text / segments（start/end 为秒）的变体
    let root_text = root.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let root_segments: Vec<TranscriptSegment> = root.get("segments").and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().filter_map(|s| {
                Some(TranscriptSegment {
                    start: s.get("start").and_then(as_f64)?,
                    end: s.get("end").and_then(as_f64)?,
                    text: s.get("text").and_then(|v| v.as_str())?.to_string(),
                })
            }).collect()
        })
        .unwrap_or_default();

    if root_text.is_empty() && root_segments.is_empty() {
        return Err("Whisper 返回 JSON 缺少 transcription / text / segments 字段".into());
    }
    Ok(TranscriptResult { text: root_text, segments: root_segments })
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
            effects: vec![], masks: vec![], filters, keyframes: Default::default(), speed_curve: vec![], time_remap: crate::project::TimeRemap { reverse: false, freeze: None, curve: Vec::new() },             text: None, subtitle: None, transition: None, audio_fade_in: 0.0, audio_fade_out: 0.0,
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
