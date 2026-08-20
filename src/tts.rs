//! src/tts.rs — 火山引擎 TTS（语音合成）模块
//!
//! 调用火山引擎公开 HTTP API 合成语音。
//! API: https://openspeech.bytedance.com/api/v1/tts
//!
//! 实现说明：
//! - HTTP 通过系统 curl（项目无 HTTP 库依赖，遵循 WhisperProvider 的 Command 模式）
//! - Base64 解码自行实现（项目无 base64 crate）
//! - reqid 用时间戳+随机数生成（项目无 uuid crate）

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

// ════════════════════ 公开常量 ════════════════════

/// 可用音色列表 (voice_type, 中文名)
pub const AVAILABLE_VOICES: &[(&str, &str)] = &[
    ("BV002_streaming", "通用女声"),
    ("BV700_streaming", "灿灿"),
    ("BV701_streaming", "擎苍"),
];

pub const DEFAULT_ENDPOINT: &str = "https://openspeech.bytedance.com/api/v1/tts";
pub const DEFAULT_CLUSTER: &str = "volcano_tts";

// ════════════════════ 数据结构 ════════════════════

/// TTS 配置（凭据 + 端点）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsConfig {
    pub appid: String,
    pub access_token: String,
    pub endpoint: String,
    pub cluster: String,
    pub default_voice: String,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            appid: String::new(),
            access_token: String::new(),
            endpoint: DEFAULT_ENDPOINT.into(),
            cluster: DEFAULT_CLUSTER.into(),
            default_voice: "BV002_streaming".into(),
        }
    }
}

/// TTS 请求参数
#[derive(Debug, Clone)]
pub struct TtsRequest {
    pub text: String,
    pub voice_type: String, // 为空则用 default_voice
    pub encoding: String,   // mp3 / wav / pcm / ogg_opus
    pub speed_ratio: f64,   // 0.2-3.0
    pub volume_ratio: f64,  // 0.1-3.0
    pub pitch_ratio: f64,   // 0.1-3.0
}

impl Default for TtsRequest {
    fn default() -> Self {
        Self {
            text: String::new(),
            voice_type: String::new(),
            encoding: "mp3".into(),
            speed_ratio: 1.0,
            volume_ratio: 1.0,
            pitch_ratio: 1.0,
        }
    }
}

/// TTS 响应（解码后的音频字节）
#[derive(Debug)]
pub struct TtsResponse {
    pub audio: Vec<u8>,
    pub encoding: String,
    pub duration: f64,
}

// ── 火山引擎 API 内部 JSON 结构 ──

#[derive(Serialize)]
struct ApiApp<'a> {
    appid: &'a str,
    token: &'a str,
    cluster: &'a str,
}

#[derive(Serialize)]
struct ApiUser<'a> {
    uid: &'a str,
}

#[derive(Serialize)]
struct ApiAudio<'a> {
    voice_type: &'a str,
    encoding: &'a str,
    speed_ratio: f64,
    volume_ratio: f64,
    pitch_ratio: f64,
}

#[derive(Serialize)]
struct ApiRequest<'a> {
    reqid: String,
    text: &'a str,
    text_type: &'a str,
    operation: &'a str,
}

#[derive(Serialize)]
struct ApiBody<'a> {
    app: ApiApp<'a>,
    user: ApiUser<'a>,
    audio: ApiAudio<'a>,
    request: ApiRequest<'a>,
}

#[derive(Deserialize)]
struct ApiResponse {
    code: i64,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    message: Option<String>,
}

// ════════════════════ Provider 抽象 ════════════════════

/// TTS Provider 抽象。各厂商客户端（火山 / 百炼 CosyVoice 等）均实现此 trait。
pub trait TtsProvider {
    /// 合成语音 → 返回音频字节
    fn synthesize(&self, req: &TtsRequest) -> Result<TtsResponse>;

    /// 合成语音并写入文件，返回时长（秒）。默认实现：先 synthesize 再落盘。
    fn synthesize_to_file(&self, req: &TtsRequest, output_path: &str) -> Result<f64> {
        let resp = self.synthesize(req)?;
        std::fs::write(output_path, &resp.audio)
            .map_err(|e| anyhow!("写入文件失败 {}: {}", output_path, e))?;
        Ok(resp.duration)
    }
}

// ════════════════════ 客户端 ════════════════════

/// 火山引擎 TTS 客户端
pub struct VolcanoTtsClient {
    config: TtsConfig,
}

impl VolcanoTtsClient {
    pub fn new(config: TtsConfig) -> Self {
        Self { config }
    }

    /// from_config 别名
    pub fn from_config(config: &TtsConfig) -> Self {
        Self::new(config.clone())
    }
}

impl TtsProvider for VolcanoTtsClient {
    /// 合成语音 → 返回音频字节（保持原有火山逻辑不变）
    fn synthesize(&self, request: &TtsRequest) -> Result<TtsResponse> {
        if self.config.appid.is_empty() || self.config.access_token.is_empty() {
            return Err(anyhow!("TTS 未配置：appid / access_token 为空"));
        }
        if request.text.trim().is_empty() {
            return Err(anyhow!("TTS 文本为空"));
        }

        let voice = if request.voice_type.is_empty() {
            self.config.default_voice.as_str()
        } else {
            request.voice_type.as_str()
        };

        let body = ApiBody {
            app: ApiApp {
                appid: &self.config.appid,
                token: &self.config.access_token,
                cluster: &self.config.cluster,
            },
            user: ApiUser { uid: "aicut" },
            audio: ApiAudio {
                voice_type: voice,
                encoding: &request.encoding,
                speed_ratio: request.speed_ratio,
                volume_ratio: request.volume_ratio,
                pitch_ratio: request.pitch_ratio,
            },
            request: ApiRequest {
                reqid: generate_reqid(),
                text: &request.text,
                text_type: "plain",
                operation: "query",
            },
        };

        let json_body = serde_json::to_string(&body)
            .map_err(|e| anyhow!("请求体序列化失败: {}", e))?;

        let auth = format!("Bearer;{}", self.config.access_token);
        let resp_text = http_post_json(&self.config.endpoint, &auth, &json_body)?;

        let api: ApiResponse = serde_json::from_str(&resp_text).map_err(|e| {
            let snippet = &resp_text[..resp_text.len().min(200)];
            anyhow!("TTS 响应 JSON 解析失败: {} | 原文: {}", e, snippet)
        })?;

        if api.code != 3000 {
            return Err(anyhow!(
                "TTS 合成失败: code={}, message={}",
                api.code,
                api.message.unwrap_or_default()
            ));
        }

        let b64 = api.data.ok_or_else(|| anyhow!("TTS 响应缺少 data 字段"))?;
        let audio = base64_decode(&b64)?;

        Ok(TtsResponse {
            audio,
            encoding: request.encoding.clone(),
            duration: api.duration.unwrap_or(0.0),
        })
    }
}

// ── 阿里云百炼 CosyVoice ──

pub const COSYVOICE_ENDPOINT: &str =
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2audio/text-to-audio";
pub const DEFAULT_COSYVOICE_MODEL: &str = "cosyvoice-v2";

/// 阿里云百炼（DashScope）CosyVoice TTS 客户端
pub struct CosyVoiceClient {
    pub api_key: String,       // DashScope API Key
    pub model: String,         // 默认 "cosyvoice-v2"
    pub default_voice: String, // 百炼音色 id，如 "longxiaochun"
}

impl CosyVoiceClient {
    pub fn new(api_key: impl Into<String>, model: impl Into<String>, default_voice: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            model: model.into(),
            default_voice: default_voice.into(),
        }
    }

    /// 便捷构造：model 为空时使用默认 "cosyvoice-v2"
    pub fn from_config(api_key: &str, model: &str, voice: &str) -> Self {
        Self::new(
            api_key,
            if model.is_empty() { DEFAULT_COSYVOICE_MODEL } else { model },
            voice,
        )
    }
}

#[derive(Serialize)]
struct CosyInput<'a> {
    text: &'a str,
}

#[derive(Serialize)]
struct CosyParameters<'a> {
    voice: &'a str,
    format: &'a str,
    sample_rate: i64,
    volume: i64,
    rate: f64,
    pitch: f64,
}

#[derive(Serialize)]
struct CosyRequest<'a> {
    model: &'a str,
    input: CosyInput<'a>,
    parameters: CosyParameters<'a>,
}

#[derive(Deserialize)]
struct CosyAudio {
    #[serde(default)]
    data: Option<String>,
}

#[derive(Deserialize)]
struct CosyOutput {
    #[serde(default)]
    audio: Option<CosyAudio>,
}

#[derive(Deserialize)]
struct CosyResponse {
    #[serde(default)]
    output: Option<CosyOutput>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

impl TtsProvider for CosyVoiceClient {
    /// 合成语音 → 返回音频字节（CosyVoice 不直接返回时长，duration 返回 0.0）
    fn synthesize(&self, request: &TtsRequest) -> Result<TtsResponse> {
        if self.api_key.is_empty() {
            return Err(anyhow!("CosyVoice 未配置：api_key 为空"));
        }
        if request.text.trim().is_empty() {
            return Err(anyhow!("TTS 文本为空"));
        }

        let voice = if request.voice_type.is_empty() {
            self.default_voice.as_str()
        } else {
            request.voice_type.as_str()
        };

        let body = CosyRequest {
            model: &self.model,
            input: CosyInput { text: &request.text },
            parameters: CosyParameters {
                voice,
                format: "wav",
                sample_rate: 24000,
                volume: 50,
                rate: 1.0,
                pitch: 1.0,
            },
        };

        let json_body = serde_json::to_string(&body)
            .map_err(|e| anyhow!("CosyVoice 请求体序列化失败: {}", e))?;

        // 注意：百炼使用标准 "Bearer <api_key>"（空格），与火山的分号形式不同
        let auth = format!("Bearer {}", self.api_key);
        let resp_text = http_post_json(COSYVOICE_ENDPOINT, &auth, &json_body)?;

        let api: CosyResponse = serde_json::from_str(&resp_text).map_err(|e| {
            let snippet = &resp_text[..resp_text.len().min(200)];
            anyhow!("CosyVoice 响应 JSON 解析失败: {} | 原文: {}", e, snippet)
        })?;

        let code = api.code.clone();
        let message = api.message.clone();
        let data_uri = api
            .output
            .and_then(|o| o.audio)
            .and_then(|a| a.data)
            .ok_or_else(|| {
                let mut msg = "CosyVoice 响应缺少 output.audio.data".to_string();
                if let (Some(c), Some(m)) = (&code, &message) {
                    msg.push_str(&format!(" (code={}, message={})", c, m));
                } else if let Some(m) = &message {
                    msg.push_str(&format!(" (message={})", m));
                }
                anyhow!(msg)
            })?;

        // data URI 可能为 "data:audio/wav;base64,xxxxx"，也可能为纯 base64。
        // 以 "data:" 开头时取第一个逗号之后的部分，否则整段当 base64。
        let b64 = if data_uri.starts_with("data:") {
            data_uri.split_once(',').map(|(_, b)| b).unwrap_or("")
        } else {
            data_uri.as_str()
        };
        if b64.is_empty() {
            return Err(anyhow!("CosyVoice 响应 data 为空，无法解码音频"));
        }

        let audio = base64_decode(b64)?;

        Ok(TtsResponse {
            audio,
            encoding: "wav".into(),
            duration: 0.0,
        })
    }
}

// ════════════════════ 顶层分发 ════════════════════

/// 按 provider 分发合成任务并写入文件，返回时长（秒）。
///
/// - provider: "volcano" | "cosyvoice"（其余按 volcano 处理）
/// - appid: volcano 传 AppID；cosyvoice 传 DashScope API Key
/// - token: volcano 传 Access Token；cosyvoice 忽略
/// - model: cosyvoice 模型名（默认 "cosyvoice-v2"）
pub fn synthesize_provider(
    provider: &str,
    appid: &str,
    token: &str,
    model: &str,
    text: &str,
    voice: &str,
    output: &str,
) -> Result<f64> {
    let req = TtsRequest {
        text: text.to_string(),
        voice_type: voice.to_string(),
        ..Default::default()
    };

    let dur = match provider {
        "cosyvoice" => {
            let client = CosyVoiceClient::from_config(appid, model, voice);
            client.synthesize_to_file(&req, output)?
        }
        _ => {
            // volcano（默认）
            let config = TtsConfig {
                appid: appid.to_string(),
                access_token: token.to_string(),
                ..Default::default()
            };
            let client = VolcanoTtsClient::from_config(&config);
            client.synthesize_to_file(&req, output)?
        }
    };

    Ok(dur)
}

// ════════════════════ 内部工具函数 ════════════════════

/// 通过 curl 发送 POST JSON 请求，返回响应体文本
fn http_post_json(url: &str, auth_header: &str, body: &str) -> Result<String> {
    let output = Command::new("curl")
        .args([
            "-s",           // 静默模式
            "-S",           // 出错时显示错误
            "--max-time", "30",
            "-X", "POST",
            "-H", &format!("Authorization: {}", auth_header),
            "-H", "Content-Type: application/json",
            "-d", body,
            url,
        ])
        .output()
        .map_err(|e| anyhow!("curl 启动失败: {}（请确认 curl 在 PATH 中）", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("curl 请求失败: {}", stderr.trim()));
    }

    String::from_utf8(output.stdout)
        .map_err(|e| anyhow!("响应非 UTF-8: {}", e))
}

/// 生成请求 ID（时间戳 + 随机数，32 位十六进制）
fn generate_reqid() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // 用纳秒 + 子秒毫秒组合，再异或一点熵
    let nanos = now.as_nanos();
    let entropy = now.subsec_nanos() as u128 ^ 0xA1C7;
    format!("{:016x}{:016x}", nanos, entropy)
}

/// 标准 Base64 解码（RFC 4648），支持 URL-safe 变体的 +/ → -_
fn base64_decode(input: &str) -> Result<Vec<u8>> {
    const TABLE: [i8; 256] = {
        let mut t = [-1i8; 256];
        let mut i = 0u8;
        while i < 26 {
            t[(b'A' + i) as usize] = i as i8;
            t[(b'a' + i) as usize] = (i + 26) as i8;
            i += 1;
        }
        let mut d = 0u8;
        while d < 10 {
            t[(b'0' + d) as usize] = (d + 52) as i8;
            d += 1;
        }
        t[b'+' as usize] = 62;
        t[b'-' as usize] = 62; // URL-safe
        t[b'/' as usize] = 63;
        t[b'_' as usize] = 63; // URL-safe
        t
    };

    let bytes: Vec<u8> = input.bytes().filter(|&b| b != b'\n' && b != b'\r' && b != b' ' && b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;

    for &b in &bytes {
        let v = TABLE[b as usize];
        if v < 0 {
            return Err(anyhow!("Base64 非法字符: 0x{:02x}", b));
        }
        buffer = (buffer << 6) | (v as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(out)
}
