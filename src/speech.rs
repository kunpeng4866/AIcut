//! src/speech.rs — 口播剪辑（speech auto-editing）引擎侧实现
//!
//! 两个公开函数：
//!   - `speech_analyze`  : 调用 Python 桥 (`python/speech_edit/bridge.py`) 做语音分析，
//!                         返回分段/静音/填充词等 JSON。
//!   - `speech_assemble` : 用 ffmpeg 按保留区间切割并 concat 合成最终视频（纯 Rust，不依赖 Python）。
//!
//! 所有错误统一用 `crate::AppError::Render(String)` 返回，保持与 `render` 一致的风格。

use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Command;

use crate::AppError;

/// 托管的 Python 解释器（WorkBuddy 内置环境）。
/// 可用环境变量 `AICUT_PYTHON_BIN` 覆盖。
const MANAGED_PYTHON: &str = "C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe";

/// 口播分析选项（目前由 `speech_analyze` 直接透传给 Python，这里保留结构以便将来在引擎侧校验）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SpeechEditOptions {
    model_size: Option<String>,
    use_demucs: Option<bool>,
    vad_threshold: Option<f64>,
    min_gap: Option<f64>,
    word_pad: Option<f64>,
    fillers: Option<bool>,
    exclude: Option<Vec<(f64, f64)>>,
}

/// 口播合成选项（来自 GUI 的 `--opts` JSON，camelCase 字段名）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeechAssembleOptions {
    keep_segments: Vec<(f64, f64)>,
    output_path: String,
    #[serde(default)]
    crossfade_ms: Option<u64>,
    #[serde(default)]
    deess: Option<bool>,
    #[serde(default)]
    normalize: Option<bool>,
}

/// ffmpeg 可执行文件：优先环境变量 `AICUT_FFMPEG`，否则走 PATH 上的 `ffmpeg`
/// （与引擎其余部分保持一致 —— `src/ffmpeg.rs` 同样以 `"ffmpeg"` 字面量启动）。
fn ffmpeg_exe() -> String {
    std::env::var("AICUT_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// 解析 bridge.py 路径：
///   - 环境变量 `AICUT_SPEECH_BRIDGE` 优先；
///   - 否则从当前可执行文件反推仓库根目录：
///     exe 位于 `<repo>/target/debug/` 或 `<repo>/target/release/`，
///     故 `parent().parent().parent()` 即 `<repo>`，再拼接 `python/speech_edit/bridge.py`。
fn resolve_bridge() -> Result<PathBuf, AppError> {
    if let Ok(p) = std::env::var("AICUT_SPEECH_BRIDGE") {
        return Ok(PathBuf::from(p));
    }
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Render(format!("无法定位当前可执行文件: {}", e)))?;
    let repo_root = exe
        .parent() // <repo>/target/debug
        .and_then(|p| p.parent()) // <repo>/target
        .and_then(|p| p.parent()) // <repo>
        .ok_or_else(|| AppError::Render("无法从可执行文件路径推断仓库根目录".into()))?;
    Ok(repo_root.join("python/speech_edit/bridge.py"))
}

/// 调用 Python 桥对音频/视频做语音分析。
///
/// `opts_json` 是一个紧凑的 JSON 字符串（无空格），作为**单个参数**传给 Python。
pub fn speech_analyze(input: &str, opts_json: &str) -> Result<Value, AppError> {
    let py = std::env::var("AICUT_PYTHON_BIN").unwrap_or_else(|_| MANAGED_PYTHON.to_string());
    let bridge = resolve_bridge()?;
    let bridge_str = bridge
        .to_str()
        .ok_or_else(|| AppError::Render("bridge.py 路径包含非 UTF-8 字符".into()))?;

    let output = Command::new(&py)
        .env("PYTHONIOENCODING", "utf-8") // Windows 下管道 stdout 默认按本地 codepage，中文会乱码/解析失败
        .env("PYTHONUTF8", "1")
        .arg(bridge_str)
        .arg(input)
        .arg(opts_json)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 Python ({})：{}", py, e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Render(format!(
            "speech analyze 失败 (退出码 {:?}): {}",
            output.status.code(),
            stderr.chars().take(1000).collect::<String>()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Render(format!(
            "speech analyze 输出不是合法 JSON: {} (原始前 200 字符: {})",
            e,
            &stdout.chars().take(200).collect::<String>()
        ))
    })?;
    Ok(v)
}

/// 按保留区间切割源视频并 concat 合成为最终口播成片。
pub fn speech_assemble(input: &str, opts_json: &str) -> Result<Value, AppError> {
    let opts: SpeechAssembleOptions = serde_json::from_str(opts_json)
        .map_err(|e| AppError::Render(format!("assemble 选项解析失败: {}", e)))?;

    if opts.keep_segments.is_empty() {
        return Err(AppError::Render("keepSegments 为空，没有可保留的片段".into()));
    }

    let ff = ffmpeg_exe();
    let temp_dir = std::env::temp_dir();
    let pid = std::process::id();

    // 按起始时间升序排列，保证合成顺序正确
    let mut segments = opts.keep_segments.clone();
    segments.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut seg_paths: Vec<PathBuf> = Vec::with_capacity(segments.len());
    let mut duration = 0.0_f64;

    for (i, (s, e)) in segments.iter().enumerate() {
        let seg_path = temp_dir.join(format!("aicut_speech_seg_{}_{}.mp4", pid, i));
        let seg_str = seg_path
            .to_str()
            .ok_or_else(|| AppError::Render("临时片段路径包含非 UTF-8 字符".into()))?;

        // 构建切割参数：`-ss` 放在 `-i` 之前做快速 seek，`-to` 为输入时间轴上的绝对终点。
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-ss".into(),
            format!("{:.6}", s),
            "-to".into(),
            format!("{:.6}", e),
            "-i".into(),
            input.to_string(),
            "-c:v".into(),
            "libx264".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
        ];

        // 音频后处理滤镜：de-ess / loudnorm（两者可串联，逗号分隔避免冲突）。
        let mut af: Vec<String> = Vec::new();
        if opts.deess.unwrap_or(false) {
            af.push("highshelf=f=8000:g=-6".to_string());
        }
        if opts.normalize.unwrap_or(false) {
            af.push("loudnorm=I=-16:TP=-1.5:LRA=11".to_string());
        }
        if !af.is_empty() {
            args.push("-af".into());
            args.push(af.join(","));
        }

        args.push(seg_str.into());

        let out = Command::new(&ff)
            .args(&args)
            .output()
            .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            cleanup(&seg_paths, None);
            return Err(AppError::Render(format!(
                "片段 {} 切割失败 (退出码 {:?}): {}",
                i,
                out.status.code(),
                stderr.chars().take(800).collect::<String>()
            )));
        }

        duration += (e - s).max(0.0);
        seg_paths.push(seg_path);
    }

    // 写 ffmpeg concat demuxer 列表文件（绝对路径，正斜杠以兼容 Windows）。
    let list_path = temp_dir.join(format!("aicut_speech_list_{}.txt", pid));
    {
        let mut list_content = String::new();
        for p in &seg_paths {
            let p_str = p.to_string_lossy().replace('\\', "/");
            list_content.push_str(&format!("file '{}'\n", p_str));
        }
        if let Err(e) = std::fs::write(&list_path, list_content) {
            cleanup(&seg_paths, Some(&list_path));
            return Err(AppError::Render(format!("写入 concat 列表失败: {}", e)));
        }
    }

    let list_str = list_path
        .to_str()
        .ok_or_else(|| AppError::Render("列表路径包含非 UTF-8 字符".into()))?;

    // 片段已统一编码，使用 `-c copy` 直拷，快速且安全。
    let concat_args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_str.into(),
        "-c".into(),
        "copy".into(),
        opts.output_path.clone(),
    ];

    let out = Command::new(&ff)
        .args(&concat_args)
        .output()
        .map_err(|e| {
            cleanup(&seg_paths, Some(&list_path));
            AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e))
        });
    let out = match out {
        Ok(o) => o,
        Err(e) => return Err(e),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        cleanup(&seg_paths, Some(&list_path));
        return Err(AppError::Render(format!(
            "concat 合成失败 (退出码 {:?}): {}",
            out.status.code(),
            stderr.chars().take(800).collect::<String>()
        )));
    }

    cleanup(&seg_paths, Some(&list_path));

    Ok(json!({
        "outputPath": opts.output_path,
        "duration": duration,
        "ok": true
    }))
}

/// 尽力清理临时片段文件与 concat 列表（失败忽略）。
fn cleanup(seg_paths: &[PathBuf], list_path: Option<&PathBuf>) {
    for p in seg_paths {
        let _ = std::fs::remove_file(p);
    }
    if let Some(l) = list_path {
        let _ = std::fs::remove_file(l);
    }
}
