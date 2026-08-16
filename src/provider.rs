//! src/provider.rs — AI Provider 接口 (Phase 3)
//!
//! ASR (语音识别) 和 LLM (文案生成) 的抽象接口。
//! 默认实现：Whisper CLI + OpenAI/DeepSeek API。
//! MCP 工具: transcribe_audio / generate_script / text_to_project

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

/// whisper.cpp CLI 默认路径（Windows 原生二进制，使用反斜杠路径）
pub const DEFAULT_WHISPER_ENGINE: &str = r"E:\codex\codex-tools\whisper\whisper-cli.exe";
/// whisper.cpp 默认多语种模型（base，支持 zh/en）
pub const DEFAULT_WHISPER_MODEL: &str = r"E:\codex\codex-tools\whisper\ggml-base.bin";
/// ffmpeg 默认路径（用于把任意音视频抽成 16k 单声道 wav）
pub const DEFAULT_FFMPEG: &str = r"E:\codex\codex-tools\bin\ffmpeg.exe";

/// 托管的 Python 解释器（与 `src/speech.rs` 保持一致），可用 `AICUT_PYTHON_BIN` 覆盖
const MANAGED_PYTHON: &str =
    "C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe";
/// 百炼（DashScope）默认转写模型
pub const DEFAULT_BAILIAN_MODEL: &str = "paraformer-v1";

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

// ════════════════════ 百炼 (DashScope) ASR Provider ════════════════════

/// 百炼语音转写实现：通过子进程调用 Python 桥 `python/asr/bridge.py`。
///
/// 桥契约：`python bridge.py <audio_path> <lang> <model> <api_key> <endpoint>`，
/// stdout 输出单行 JSON（成功 `{"success":true,"data":{text,segments}}`，
/// 失败 `{"success":false,"error":...}`），日志一律走 stderr。
pub struct BailianAsrProvider {
    pub api_key: String,
    pub endpoint: String,
    /// 为空时使用 `DEFAULT_BAILIAN_MODEL`
    pub model: String,
}

impl BailianAsrProvider {
    pub fn new(api_key: String, endpoint: String, model: String) -> Self {
        Self { api_key, endpoint, model }
    }

    /// 实际生效的模型名（空 → paraformer-v1）
    fn effective_model(&self) -> &str {
        if self.model.trim().is_empty() { DEFAULT_BAILIAN_MODEL } else { self.model.trim() }
    }
}

/// Python 解释器：优先环境变量 `AICUT_PYTHON_BIN`，否则用托管环境
fn python_bin() -> String {
    std::env::var("AICUT_PYTHON_BIN").unwrap_or_else(|_| MANAGED_PYTHON.to_string())
}

/// 解析 ASR 桥路径：
///   - 环境变量 `AICUT_ASR_BRIDGE` 优先；
///   - 否则从当前可执行文件反推仓库根（`<repo>/target/{debug,release}/exe`）拼 `python/asr/bridge.py`；
///   - 仍不存在则退回编译期的 `CARGO_MANIFEST_DIR`（开发态运行 `cargo test` 时 exe 在 deps/ 下）。
fn resolve_asr_bridge() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("AICUT_ASR_BRIDGE") {
        return Ok(PathBuf::from(p));
    }
    let exe = std::env::current_exe().map_err(|e| format!("无法定位当前可执行文件: {}", e))?;
    let from_exe = exe
        .parent() // <repo>/target/debug
        .and_then(|p| p.parent()) // <repo>/target
        .and_then(|p| p.parent()) // <repo>
        .map(|root| root.join("python/asr/bridge.py"));
    if let Some(ref p) = from_exe {
        if p.exists() {
            return Ok(p.clone());
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("python/asr/bridge.py");
    if manifest.exists() {
        return Ok(manifest);
    }
    from_exe.ok_or_else(|| "无法推断 python/asr/bridge.py 路径".to_string())
}

/// 极简 `.env` 加载器（不引入任何外部 crate）：
/// 从 `.env` 读取 `KEY=VALUE`，仅当进程尚未设置该键时才注入 `std::env`，
/// 避免覆盖已存在的真实环境变量 / CLI 显式参数（shell 里 `export` 的 Key 优先级最高）。
///
/// 搜索顺序：环境变量 `AICUT_ENV_FILE` 指定路径 → `<仓库根>/.env`。
/// 文件不存在 / 不可读 / 解析失败均静默忽略，不影响其它来源的 Key。
fn load_dotenv() {
    let env_path = if let Ok(p) = std::env::var("AICUT_ENV_FILE") {
        PathBuf::from(p)
    } else {
        repo_root().join(".env")
    };
    let content = match std::fs::read_to_string(&env_path) {
        Ok(c) => c,
        Err(_) => return, // 无 .env 文件：静默跳过
    };
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let kv = line.strip_prefix("export ").unwrap_or(line);
        let mut it = kv.splitn(2, '=');
        let (k, v) = match (it.next(), it.next()) {
            (Some(k), Some(v)) => (k.trim(), v.trim()),
            _ => continue,
        };
        if k.is_empty() {
            continue;
        }
        // 去引号
        let v = v.trim_matches(|c| c == '"' || c == '\'');
        if std::env::var(k).is_err() {
            std::env::set_var(k, v);
        }
    }
}

/// 推断仓库根目录（`<repo>`），用于定位默认 `.env` 与桥路径。
fn repo_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe
            .parent() // <repo>/target/debug
            .and_then(|p| p.parent()) // <repo>/target
            .and_then(|p| p.parent()) // <repo>
        {
            return root.to_path_buf();
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

impl AsrProvider for BailianAsrProvider {
    fn transcribe(&self, audio_path: &str, language: &str) -> Result<TranscriptResult, String> {
        load_dotenv(); // 让 .env 里的 AICUT_ASR_API_KEY 自动生效（CLI 直跑也能读）
        let lang = if language.is_empty() { "zh" } else { language };
        let py = python_bin();
        let bridge = resolve_asr_bridge()?;
        let bridge_s = bridge
            .to_str()
            .ok_or_else(|| "ASR 桥路径包含非 UTF-8 字符".to_string())?;

        let output = Command::new(&py)
            .env("PYTHONIOENCODING", "utf-8") // Windows 管道默认本地 codepage，中文会乱码
            .env("PYTHONUTF8", "1")
            .arg(bridge_s)
            .arg(audio_path)
            .arg(lang)
            .arg(self.effective_model())
            .arg(&self.api_key)
            .arg(&self.endpoint)
            .output()
            .map_err(|e| format!("无法启动 Python ({}): {}", py, e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        if line.is_empty() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "百炼 ASR 桥无输出 (退出码 {:?}): {}",
                output.status.code(),
                stderr.chars().take(600).collect::<String>()
            ));
        }

        let root: serde_json::Value = serde_json::from_str(line)
            .map_err(|e| format!("百炼 ASR 桥输出解析失败: {} (原始: {})", e, line.chars().take(300).collect::<String>()))?;

        if !root.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
            let err = root.get("error").and_then(|v| v.as_str()).unwrap_or("未知错误");
            return Err(format!("百炼 ASR 转写失败: {}", err));
        }

        let data = root
            .get("data")
            .ok_or_else(|| "百炼 ASR 返回缺少 data 字段".to_string())?;

        let segments: Vec<TranscriptSegment> = data
            .get("segments")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|s| TranscriptSegment {
                        start: s.get("start").and_then(as_f64).unwrap_or(0.0),
                        end: s.get("end").and_then(as_f64).unwrap_or(0.0),
                        text: s.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut text = data.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if text.trim().is_empty() && !segments.is_empty() {
            text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
        }
        if text.trim().is_empty() && segments.is_empty() {
            return Err("百炼 ASR 返回空结果（text 与 segments 均为空）".into());
        }

        Ok(TranscriptResult { text, segments })
    }
}

// ════════════════════ 简繁安全网（OpenCC t2s，走外部 Python） ════════════════════

/// 繁体 → 简体转换。通过托管 Python 调用 `opencc.OpenCC('t2s')`，文本以 argv 传入避免注入。
///
/// **容错**：python / opencc 不可用、进程失败、stderr 非空或输出为空时，**原样返回**输入文本，
/// 绝不因简繁转换导致整个转写失败。
pub fn to_simplified(text: &str) -> String {
    if text.trim().is_empty() {
        return text.to_string();
    }
    const SCRIPT: &str =
        "import sys;from opencc import OpenCC;sys.stdout.write(OpenCC('t2s').convert(sys.argv[1]))";
    let py = python_bin();
    let output = match Command::new(&py)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .arg("-c")
        .arg(SCRIPT)
        .arg(text)
        .output()
    {
        Ok(o) => o,
        Err(_) => return text.to_string(), // python 不存在 → 原文
    };
    if !output.status.success() || !output.stderr.is_empty() {
        return text.to_string(); // opencc 未安装 / 运行报错 → 原文
    }
    match String::from_utf8(output.stdout) {
        // Windows 文本模式会把 \n 写成 \r\n，这里还原
        Ok(s) if !s.is_empty() => s.replace("\r\n", "\n"),
        _ => text.to_string(),
    }
}

/// 对整体 text 与每个 segment.text 做简繁转换（失败即静默保持原文）。
///
/// 为避免逐段启动 Python 进程（几百段时开销巨大），这里把所有文本用 `\n` 拼成一次调用；
/// 行数对不上（文本自身含换行）时退回逐条转换。
fn simplify_result(result: &mut TranscriptResult) {
    let mut items: Vec<&str> = Vec::with_capacity(result.segments.len() + 1);
    items.push(result.text.as_str());
    items.extend(result.segments.iter().map(|s| s.text.as_str()));
    if items.iter().all(|t| t.trim().is_empty()) {
        return;
    }

    let joined = items.join("\n");
    let converted = to_simplified(&joined);
    let lines: Vec<&str> = converted.split('\n').collect();

    if lines.len() == items.len() {
        result.text = lines[0].to_string();
        for (seg, line) in result.segments.iter_mut().zip(lines[1..].iter()) {
            seg.text = (*line).to_string();
        }
    } else {
        result.text = to_simplified(&result.text);
        for seg in result.segments.iter_mut() {
            seg.text = to_simplified(&seg.text);
        }
    }
}

/// 装饰器：在内部 provider 转写完成后统一套用简繁安全网
struct SimplifiedAsrProvider {
    inner: Box<dyn AsrProvider>,
}

impl AsrProvider for SimplifiedAsrProvider {
    fn transcribe(&self, audio_path: &str, language: &str) -> Result<TranscriptResult, String> {
        let mut result = self.inner.transcribe(audio_path, language)?;
        simplify_result(&mut result);
        Ok(result)
    }
}

/// ASR provider 工厂：`bailian` → 百炼；其余（`whisper-local`/`whisper-api`/`custom`/空）→ whisper.cpp。
/// 返回的 provider 已包裹简繁安全网，转写结果统一为简体。
pub fn create_asr_provider(
    provider: &str,
    engine: &str,
    model_path: &str,
    api_key: &str,
    endpoint: &str,
    model: &str,
) -> Box<dyn AsrProvider> {
    let inner: Box<dyn AsrProvider> = match provider.trim().to_ascii_lowercase().as_str() {
        "bailian" => Box::new(BailianAsrProvider::new(
            api_key.to_string(),
            endpoint.to_string(),
            model.to_string(),
        )),
        _ => {
            let engine_path = if engine.trim().is_empty() {
                DEFAULT_WHISPER_ENGINE.to_string()
            } else {
                engine.to_string()
            };
            let model_file = if model_path.trim().is_empty() {
                DEFAULT_WHISPER_MODEL.to_string()
            } else {
                model_path.to_string()
            };
            Box::new(WhisperProvider::with_paths(engine_path, model_file))
        }
    };
    Box::new(SimplifiedAsrProvider { inner })
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
            transform: crate::project::Transform::default(),
            volume: 1.0, speed: 1.0,
            effects: vec![], masks: vec![], filters, keyframes: Default::default(), speed_curve: vec![], time_remap: crate::project::TimeRemap { reverse: false, freeze: None, curve: Vec::new() },             text: None, subtitle: None, transition: None, audio_fade_in: 0.0, audio_fade_out: 0.0, keying: None, super_resolution: None,
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
