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
use crate::probe::probe;

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
    /// 输出时间轴保留段（暂停压缩后；由 Python analyze 的 keepSegmentsOut 提供）。
    /// 与 keep_segments 一一对应且索引对齐：段 i 的源区间 = keep_segments[i]，
    /// 输出区间 = keep_segments_out[i]，段长度保持一致；相邻输出段之间的间隙 = 需插入的暂停时长。
    /// 缺省（None/空/长度不匹配）时回退到「间隙全删」的旧行为。
    #[serde(default)]
    keep_segments_out: Option<Vec<(f64, f64)>>,
    output_path: String,
    /// 交叉淡入淡出时长（毫秒）。默认 20ms：>0 且保留片段数 >= 2 时启用 crossfade。
    #[serde(default = "default_crossfade_ms")]
    crossfade_ms: f64,
    #[serde(default)]
    deess: Option<bool>,
    /// 去除语音中的咔哒/爆音（adeclick 滤镜）。
    #[serde(default)]
    declick: Option<bool>,
    #[serde(default)]
    normalize: Option<bool>,
    /// 是否使用分离 stem 重组（Demucs 成功分离出人声/伴奏时）。
    #[serde(default)]
    separated: Option<bool>,
    /// 分离出的人声 stem 路径（separated 时提供）。
    #[serde(default)]
    vocal_path: Option<String>,
    /// 分离出的伴奏 stem 路径（separated 时提供）。
    #[serde(default)]
    accomp_path: Option<String>,
    /// 纯伴奏桥接段（separated 时与 keep_segments 交替拼接，gap 音乐不丢）。
    #[serde(default)]
    music_segments: Option<Vec<(f64, f64)>>,
}

fn default_crossfade_ms() -> f64 {
    20.0
}

/// ffmpeg 可执行文件：优先环境变量 `AICUT_FFMPEG`，否则走 PATH 上的 `ffmpeg`
/// （与引擎其余部分保持一致 —— `src/ffmpeg.rs` 同样以 `"ffmpeg"` 字面量启动）。
fn ffmpeg_exe() -> String {
    std::env::var("AICUT_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// ffprobe 可执行文件：优先环境变量 `AICUT_FFPROBE`，否则走 PATH 上的 `ffprobe`。
fn ffprobe_exe() -> String {
    std::env::var("AICUT_FFPROBE").unwrap_or_else(|_| "ffprobe".to_string())
}

/// 文件路径是否存在（用于判断分离 stem 是否已就绪）。
fn file_exists(p: &str) -> bool {
    std::path::Path::new(p).exists()
}

/// 探测输入媒体是否包含视频流（crossfade 路径决定是否拼接视频）。
fn has_video_stream(input: &str) -> Result<bool, AppError> {
    let probe = ffprobe_exe();
    let out = Command::new(&probe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            input,
        ])
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 ffprobe ({}): {}", probe, e)))?;
    if !out.status.success() {
        // ffprobe 失败时保守地当作无视频，避免阻断合成。
        return Ok(false);
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Ok(s.contains("video"))
}

/// 构造音频后处理滤镜链（仅包含启用项）。
/// 返回 `None` 表示没有任何启用项（调用方应使用 `anull` 透传）。
fn audio_post_filters(declick: bool, deess: bool, normalize: bool) -> Option<String> {
    let mut af: Vec<String> = Vec::new();
    if declick {
        af.push("adeclick".to_string());
    }
    if deess {
        af.push("highshelf=f=8000:g=-6".to_string());
    }
    if normalize {
        af.push("loudnorm=I=-16:TP=-1.5:LRA=11".to_string());
    }
    if af.is_empty() {
        None
    } else {
        Some(af.join(","))
    }
}

/// 生成「暂停」片段：冻结 `prev_seg` 的末帧并叠加静音音频，时长 `pause` 秒。
/// 输入无视频流时仅生成静音音频片段。供暂停压缩路径在保留段之间插入短停顿，
/// 使输出节奏自然（不被压成机关枪）。返回生成的片段路径。
fn build_pause_clip(
    ff: &str,
    fps: f64,
    has_video: bool,
    prev_seg: &PathBuf,
    pause: f64,
    idx: usize,
    temp_dir: &std::path::Path,
    pid: u32,
) -> Result<PathBuf, AppError> {
    let blank = temp_dir.join(format!("aicut_speech_pause_{}_{}.mp4", pid, idx));
    let blank_str = blank.to_string_lossy().replace('\\', "/");
    let prev_str = prev_seg.to_string_lossy().replace('\\', "/");
    let args: Vec<String> = if has_video {
        // 取 prev_seg 末帧 → 冻结为 pause 秒静帧（避免暂停时黑屏/跳变）。
        let last_png = temp_dir.join(format!("aicut_speech_pause_last_{}_{}.png", pid, idx));
        let last_str = last_png.to_string_lossy().replace('\\', "/");
        let ext = Command::new(ff)
            .args([
                "-y",
                "-sseof",
                "-0.04",
                "-i",
                &prev_str,
                "-vf",
                "select=eq(n\\,0)",
                "-frames:v",
                "1",
                &last_str,
            ])
            .output()
            .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
        if !ext.status.success() {
            return Err(AppError::Render(format!(
                "暂停片段提取末帧失败 (退出码 {:?}): {}",
                ext.status.code(),
                String::from_utf8_lossy(&ext.stderr).chars().take(400).collect::<String>()
            )));
        }
        vec![
            "-y".into(),
            "-loop".into(),
            "1".into(),
            "-i".into(),
            last_str,
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("anullsrc=r=48000:cl=stereo:d={:.6}", pause),
            "-t".into(),
            format!("{:.6}", pause),
            "-c:v".into(),
            "libx264".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
            "-r".into(),
            format!("{:.4}", fps),
            "-shortest".into(),
            blank_str,
        ]
    } else {
        vec![
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("anullsrc=r=48000:cl=stereo:d={:.6}", pause),
            "-t".into(),
            format!("{:.6}", pause),
            "-c:a".into(),
            "aac".into(),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
            blank_str,
        ]
    };
    let out = Command::new(ff)
        .args(&args)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
    if !out.status.success() {
        return Err(AppError::Render(format!(
            "暂停片段生成失败 (退出码 {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).chars().take(400).collect::<String>()
        )));
    }
    Ok(blank)
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
        // Windows 上 torch/whisper 多 OpenMP 线程易触发 0xC0000005 访问冲突 segfault，限单线程保稳定
        .env("OMP_NUM_THREADS", "1")
        .env("MKL_NUM_THREADS", "1")
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

/// 调用 Python 桥对媒体做分离（音频分离 av / 人声分离 vocal）。
///
/// 与 `speech_analyze` 完全一致的「Rust spawn Python 桥」范式：
/// `opts_json` 作为单个参数传给 Python，桥再把 dict 转成 stdout 单行 JSON 返回。
pub fn speech_separate(input: &str, opts_json: &str) -> Result<Value, AppError> {
    let py = std::env::var("AICUT_PYTHON_BIN").unwrap_or_else(|_| MANAGED_PYTHON.to_string());
    let bridge = resolve_bridge()?;
    let bridge_str = bridge
        .to_str()
        .ok_or_else(|| AppError::Render("bridge.py 路径包含非 UTF-8 字符".into()))?;

    let output = Command::new(&py)
        .env("PYTHONIOENCODING", "utf-8") // Windows 下管道 stdout 默认按本地 codepage，中文会乱码/解析失败
        .env("PYTHONUTF8", "1")
        // Windows 上 torch/whisper 多 OpenMP 线程易触发 0xC0000005 访问冲突 segfault，限单线程保稳定
        .env("OMP_NUM_THREADS", "1")
        .env("MKL_NUM_THREADS", "1")
        .arg(bridge_str)
        .arg(input)
        .arg(opts_json)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 Python ({})：{}", py, e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Render(format!(
            "speech separate 失败 (退出码 {:?}): {}",
            output.status.code(),
            stderr.chars().take(1000).collect::<String>()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        AppError::Render(format!(
            "speech separate 输出不是合法 JSON: {} (原始前 200 字符: {})",
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

    // 分离重组路径：Demucs 成功分离出人声/伴奏 stem 时，保留说话段落间的背景音乐，
    // 而不是把音乐删掉（对应客户投诉 #2）。要求 separated 为真且两个 stem 文件都存在；
    // 否则回退到原有「切割 input 再 concat」路径。
    let take_separated = opts.separated == Some(true)
        && opts.vocal_path.as_deref().map(file_exists).unwrap_or(false)
        && opts.accomp_path.as_deref().map(file_exists).unwrap_or(false);
    if take_separated {
        return speech_assemble_separated(input, &opts);
    }

    if opts.keep_segments.is_empty() {
        return Err(AppError::Render("keepSegments 为空，没有可保留的片段".into()));
    }

    // 音频后处理开关（默认关闭）。
    let declick = opts.declick.unwrap_or(false);
    let deess = opts.deess.unwrap_or(false);
    let normalize = opts.normalize.unwrap_or(false);

    // 是否走 crossfade 路径：时长 > 0 且保留片段 >= 2。
    let use_crossfade = opts.crossfade_ms > 0.0 && opts.keep_segments.len() >= 2;

    let ff = ffmpeg_exe();
    let temp_dir = std::env::temp_dir();
    let pid = std::process::id();

    // 用源真实帧率切割，而非硬编码 30：25/24/29.97 等源若被强制 30fps，
    // 段实际时长会与请求时长错位，导致 xfade offset 超出真实段长 → 合成失败或视频缺帧/卡顿。
    let src_fps = probe(input).map(|m| m.fps).unwrap_or(30.0);
    let fps = if src_fps > 0.0 && src_fps.is_finite() { src_fps } else { 30.0 };

    // 按起始时间升序排列，保证合成顺序正确
    let mut segments = opts.keep_segments.clone();
    segments.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    // 剔除零长/负长段（避免切出空段导致 ffmpeg 整段失败），空结果直接报错
    segments.retain(|(s, e)| (e - s) > 1e-4);
    if segments.is_empty() {
        return Err(AppError::Render("保留片段均无效（长度为 0），无法合成".into()));
    }

    // 输入是否含视频流（暂停压缩路径据此决定「冻结末帧+静音」还是纯静音片段）。
    let has_video = has_video_stream(input)?;

    // ── 暂停压缩路径判定（P1：消费 keepSegmentsOut）──
    // keep_segments_out 是输出时间轴（含被压缩后插入的短停顿），与 keep_segments 同源排序、
    // 索引一一对应：段 i 的源区间 = keep_segments[i]，输出区间 = keep_segments_out[i]，段长不变。
    // 相邻输出段之间的间隙 = 需插入的暂停时长。仅当其有效（长度匹配、段长一致、首段始于 0）
    // 且确实存在正暂停时启用；否则回退到「间隙全删」旧行为（并尊重 crossfade）。
    let mut out_segs = opts.keep_segments_out.clone().unwrap_or_default();
    out_segs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let segs_valid = !out_segs.is_empty()
        && out_segs.len() == segments.len()
        && out_segs[0].0 <= 1e-3
        && (0..out_segs.len()).all(|i| {
            let a = (segments[i].1 - segments[i].0).abs();
            let b = (out_segs[i].1 - out_segs[i].0).abs();
            (a - b).abs() < 5e-3
        });
    let has_positive_pause = (0..out_segs.len().saturating_sub(1))
        .any(|i| (out_segs[i + 1].0 - out_segs[i].1) > 1e-3);
    let use_pause_compress = segs_valid && has_positive_pause;

    let mut seg_paths: Vec<PathBuf> = Vec::with_capacity(segments.len());
    let mut seg_durations: Vec<f64> = Vec::with_capacity(segments.len());
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
            // 用源真实帧率切割（不再硬编码 30）：25/24/29.97 等源若被强制 30fps，
            // 段实际时长会与请求时长错位，导致 xfade offset 超出真实段长 → 合成失败/视频缺帧卡顿。
            "-r".into(),
            format!("{:.4}", fps),
            "-c:v".into(),
            "libx264".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            // 固定音频规格（48k/立体声），保证「段 + 暂停静音片段」在 concat -c copy 下参数一致。
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
        ];

        // 音频后处理滤镜（declick / de-ess / loudnorm）。
        // 注意：仅在非 crossfade 路径（及暂停压缩路径）把它烘焙进片段；crossfade 路径会在
        // filter_complex 末级统一施加，避免重复处理音频。
        let af_opt: Option<String> = if use_crossfade && !use_pause_compress {
            None
        } else {
            audio_post_filters(declick, deess, normalize)
        };
        if let Some(af) = af_opt {
            args.push("-af".into());
            args.push(af);
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
        // 实测该段真实时长，供 xfade offset 计算（不能用请求的 e-s，否则量化错位导致缺帧）
        let seg_dur = probe(seg_str)
            .map(|m| m.duration)
            .unwrap_or_else(|_| ((*e - *s).max(0.0) * fps).round() / fps);
        seg_durations.push(seg_dur.max(1.0 / fps));
        seg_paths.push(seg_path);
    }

    // ── 暂停压缩路径（P1）：按 keepSegmentsOut 在保留段之间插入「冻结末帧+静音」短暂停 ──
    // keepSegmentsOut 已在源时间轴切好的各段间补入 targetPause 量级的停顿（而非全删），
    // 避免「机关枪」节奏。段本身仍按源 keep_segments 精确切割（零回归），只在拼接处补暂停。
    if use_pause_compress {
        let out_dur: f64 = out_segs.last().map(|&(_, e)| e).unwrap_or(0.0);
        // 组装 [段0, 暂停0, 段1, 暂停1, ...] 的 concat 列表（仅正暂停插片段）
        let mut concat_paths: Vec<PathBuf> = Vec::with_capacity(seg_paths.len() * 2);
        for i in 0..segments.len() {
            concat_paths.push(seg_paths[i].clone());
            if i + 1 < segments.len() {
                let pause = (out_segs[i + 1].0 - out_segs[i].1).max(0.0);
                if pause > 1e-3 {
                    match build_pause_clip(&ff, fps, has_video, &seg_paths[i], pause, i, &temp_dir, pid) {
                        Ok(p) => concat_paths.push(p),
                        Err(e) => {
                            cleanup(&seg_paths, None);
                            return Err(e);
                        }
                    }
                }
            }
        }
        let list_path = temp_dir.join(format!("aicut_speech_list_{}.txt", pid));
        let mut list_content = String::new();
        for p in &concat_paths {
            list_content.push_str(&format!("file '{}'\n", p.to_string_lossy().replace('\\', "/")));
        }
        if let Err(e) = std::fs::write(&list_path, list_content) {
            cleanup(&concat_paths, Some(&list_path));
            return Err(AppError::Render(format!("写入 concat 列表失败: {}", e)));
        }
        let concat_args: Vec<String> = vec![
            "-y".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list_path.to_string_lossy().replace('\\', "/"),
            "-c".into(),
            "copy".into(),
            opts.output_path.clone(),
        ];
        let out = Command::new(&ff)
            .args(&concat_args)
            .output()
            .map_err(|e| {
                cleanup(&concat_paths, Some(&list_path));
                AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e))
            });
        let out = match out {
            Ok(o) => o,
            Err(e) => return Err(e),
        };
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            cleanup(&concat_paths, Some(&list_path));
            return Err(AppError::Render(format!(
                "暂停压缩合成失败 (退出码 {:?}): {}",
                out.status.code(),
                stderr.chars().take(800).collect::<String>()
            )));
        }
        cleanup(&concat_paths, Some(&list_path));
        // 返回真实输出时长（concat -c copy 后实测），保证落轨片段长度与实际文件一致。
        let real_dur = probe(&opts.output_path)
            .map(|m| m.duration)
            .unwrap_or(out_dur);
        return Ok(json!({
            "outputPath": opts.output_path.clone(),
            "duration": real_dur,
            "ok": true
        }));
    }

    // 根据是否启用 crossfade 选择合成路径。
    let (output_path, out_duration) = if use_crossfade {
        // ---- 交叉淡入淡出路径：消除拼接处的硬切「卡顿」 ----
        let cf = opts.crossfade_ms / 1000.0;
        let durs: Vec<f64> = seg_durations.clone();
        let n = segments.len();

        let mut fc = String::new();

        // 音频 crossfade 链（始终构建）。
        let mut last_a = "0:a".to_string();
        for k in 1..n {
            let lbl = format!("a0{}", k);
            fc.push_str(&format!("[{}][{}:a]acrossfade=d={:.6}[{}];", last_a, k, cf, lbl));
            last_a = lbl;
        }

        // 视频：逐段归一为精确 CFR（fps=FPS,setpts=PTS-STARTPTS）后用 concat 滤镜拼接。
        // 注意：原先的 xfade 在本机 ffmpeg 下会丢弃大量帧（实测 drop=63），导致后段无画面/卡顿；
        // concat 滤镜零丢帧、画面完整，代价是拼接处为硬切（音频仍走 crossfade 保持平滑过渡）。
        let mut vin_labels: Vec<String> = Vec::with_capacity(n);
        if has_video {
            for k in 0..n {
                let lbl = format!("v{}", k);
                fc.push_str(&format!(
                    "[{}:v]fps={:.4},setpts=PTS-STARTPTS[{}];",
                    k, fps, lbl
                ));
                vin_labels.push(lbl);
            }
            let ins: String = vin_labels.iter().map(|l| format!("[{}]", l)).collect();
            fc.push_str(&format!("{}concat=n={}:v=1:a=0[vout];", ins, n));
        }

        // 末级音频统一施加 de-ess / declick / normalize（仅启用项）。
        if let Some(af) = audio_post_filters(declick, deess, normalize) {
            fc.push_str(&format!("[{}]{}[aout];", last_a, af));
        } else {
            fc.push_str(&format!("[{}]anull[aout];", last_a));
        }
        if fc.ends_with(';') {
            fc.pop();
        }

        let mut args: Vec<String> = vec!["-y".into()];
        for p in &seg_paths {
            args.push("-i".into());
            args.push(p.to_string_lossy().replace('\\', "/"));
        }
        args.push("-filter_complex".into());
        args.push(fc);
        args.push("-map".into());
        args.push("[aout]".into());
        if has_video {
            args.push("-map".into());
            args.push("[vout]".into());
        }
        args.push("-c:v".into());
        args.push("libx264".into());
        args.push("-r".into());
        args.push(format!("{:.4}", fps));
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push(opts.output_path.clone());

        let out = Command::new(&ff)
            .args(&args)
            .output()
            .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            cleanup(&seg_paths, None);
            return Err(AppError::Render(format!(
                "口播合成失败 (退出码 {:?}): {}",
                out.status.code(),
                stderr.chars().take(800).collect::<String>()
            )));
        }

        cleanup(&seg_paths, None);
        // 视频为 concat 硬切（无重叠段），实际时长 = 各段真实时长之和；音频 crossfade 略短，
        // clip 取视频时长可避免末尾静帧。
        let out_duration = durs.iter().sum::<f64>();
        (opts.output_path.clone(), out_duration)
    } else {
        // ---- 原 concat-demuxer 路径（行为不变） ----
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
        (opts.output_path.clone(), duration)
    };

    Ok(json!({
        "outputPath": output_path,
        "duration": out_duration,
        "ok": true
    }))
}

/// 分离重组路径：用 Demucs 分离出的人声/伴奏 stem 重建音频，保留说话段落间的背景音乐。
///
/// 与原有「切割 input 再 concat」路径不同，这里音频完全由 stem 重建；当 `input` 含视频流时，
/// 原视频流被重新封装（音频被替换），并用 `-shortest` 将视频裁到新音频长度。
///
/// ffmpeg 滤镜图语法铁律：输入标签 `[1]`/`[2]` 后必须紧跟第一个滤镜、不能加逗号
/// （`[1]atrim=...` ✅，不是 `[1],atrim=...`）；逗号只分隔同链内滤镜。原视频用 `[0:v]`，
/// 不要 map `[0:a]`（原音频丢弃）。
fn speech_assemble_separated(input: &str, opts: &SpeechAssembleOptions) -> Result<Value, AppError> {
    let vocal = opts.vocal_path.as_deref().unwrap();
    let accomp = opts.accomp_path.as_deref().unwrap();

    let ff = ffmpeg_exe();
    let has_video = has_video_stream(input)?;

    let declick = opts.declick.unwrap_or(false);
    let deess = opts.deess.unwrap_or(false);
    let normalize = opts.normalize.unwrap_or(false);
    let cf = opts.crossfade_ms / 1000.0;

    // ── 暂停压缩路径判定（分离路径 P1：消费 keepSegmentsOut）──
    // 与非分离路径一致：keep_segments_out 是输出时间轴（含被压缩后的短停顿），与 keep_segments
    // 索引一一对应、段长相等。仅当其有效（长度匹配、段长一致、首段始于≈0）且确实存在正暂停时
    // 启用；否则回退到下方「按源时间轴铺满」的既有行为（零回归）。
    let mut sep_segments = opts.keep_segments.clone();
    sep_segments.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    sep_segments.retain(|(s, e)| (e - s) > 1e-4);
    let mut sep_out = opts.keep_segments_out.clone().unwrap_or_default();
    sep_out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let sep_valid = !sep_segments.is_empty()
        && !sep_out.is_empty()
        && sep_out.len() == sep_segments.len()
        && sep_out[0].0 <= 1e-3
        && (0..sep_out.len()).all(|i| {
            let a = (sep_segments[i].1 - sep_segments[i].0).abs();
            let b = (sep_out[i].1 - sep_out[i].0).abs();
            (a - b).abs() < 5e-3
        });
    let sep_has_pause = (0..sep_out.len().saturating_sub(1))
        .any(|i| (sep_out[i + 1].0 - sep_out[i].1) > 1e-3);
    if sep_valid && sep_has_pause {
        return speech_assemble_separated_pause(
            input, opts, &ff, has_video, vocal, accomp, &sep_segments, &sep_out,
            declick, deess, normalize,
        );
    }

    // 构造按时间升序的音频段：
    //   - 每个 keep_segment  → 混合段   = amix(vocal 截[s,e], accomp 截[s,e])
    //   - 每个 music_segment → 纯伴奏段 = accomp 截[s,e]
    // 这些段已由 Python 侧钳制到修剪后的时间轴，按时间顺序铺满编辑后的音频。
    #[derive(Clone, Copy)]
    enum SegKind {
        Mix,
        Accomp,
    }
    let mut segs: Vec<(SegKind, f64, f64)> = Vec::new();
    for &(s, e) in &opts.keep_segments {
        segs.push((SegKind::Mix, s, e));
    }
    if let Some(music) = &opts.music_segments {
        for &(s, e) in music {
            segs.push((SegKind::Accomp, s, e));
        }
    }
    segs.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let n = segs.len();
    if n == 0 {
        return Err(AppError::Render(
            "分离路径没有可用音频段（keepSegments 与 musicSegments 均为空）".into(),
        ));
    }

    let mut fc = String::new();
    let mut audio_labels: Vec<String> = Vec::with_capacity(n);

    for (i, seg) in segs.iter().enumerate() {
        let (kind, s, e) = *seg;
        let lbl = format!("a{}", i);
        match kind {
            SegKind::Mix => {
                // 人声 stem 截 [s,e] + 伴奏 stem 截 [s,e]，混回为人声+音乐的混合段。
                fc.push_str(&format!(
                    "[1]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[vt{}];",
                    s, e, i
                ));
                fc.push_str(&format!(
                    "[2]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[at{}];",
                    s, e, i
                ));
                fc.push_str(&format!(
                    "[vt{}][at{}]amix=inputs=2:duration=longest[{}];",
                    i, i, lbl
                ));
            }
            SegKind::Accomp => {
                // 纯伴奏桥接段（说话段落间的背景音乐）。
                fc.push_str(&format!(
                    "[2]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[{}];",
                    s, e, lbl
                ));
            }
        }
        audio_labels.push(lbl);
    }

    // 按时间顺序对音频段做过渡链。
    let use_crossfade = opts.crossfade_ms > 0.0 && n >= 2;
    let mut last = audio_labels[0].clone();
    if n == 1 {
        // 单段：直接使用该段标签，无需过渡。
    } else if use_crossfade {
        for k in 1..n {
            let lbl = format!("af{}", k);
            fc.push_str(&format!(
                "[{}][{}]acrossfade=d={:.6}[{}];",
                last, audio_labels[k], cf, lbl
            ));
            last = lbl;
        }
    } else {
        // crossfade_ms==0 且段数>=2：用 concat 直连（无重叠），保持段落顺序。
        let ins: String = audio_labels.iter().map(|l| format!("[{}]", l)).collect();
        let lbl = "afc".to_string();
        fc.push_str(&format!("{}concat=n={}:v=0:a=1[{}];", ins, n, lbl));
        last = lbl;
    }

    // 末级统一施加 de-ess / declick / normalize（仅启用项），否则 anull 透传。
    if let Some(af) = audio_post_filters(declick, deess, normalize) {
        fc.push_str(&format!("[{}]{}[aout];", last, af));
    } else {
        fc.push_str(&format!("[{}]anull[aout];", last));
    }
    if fc.ends_with(';') {
        fc.pop();
    }

    let mut args: Vec<String> = vec!["-y".into()];
    // 输入顺序：idx0 = 原 input（仅用其视频），idx1 = 人声 stem，idx2 = 伴奏 stem。
    args.push("-i".into());
    args.push(input.to_string());
    args.push("-i".into());
    args.push(vocal.to_string());
    args.push("-i".into());
    args.push(accomp.to_string());
    args.push("-filter_complex".into());
    args.push(fc);
    args.push("-map".into());
    if has_video {
        // 注意：直接引用输入流用裸写法 `0:v`（无方括号）；方括号会被当成滤镜图输出标签而报错。
        args.push("0:v".into());
        args.push("-map".into());
    }
    args.push("[aout]".into());
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-shortest".into());
    args.push(opts.output_path.clone());

    let out = Command::new(&ff)
        .args(&args)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::Render(format!(
            "分离重组合成失败 (退出码 {:?}): {}",
            out.status.code(),
            stderr.chars().take(800).collect::<String>()
        )));
    }

    // 输出时长 = 各段时长之和；crossfade 时减去 (段数-1)*cf 的重叠量。
    let durs: Vec<f64> = segs.iter().map(|&(_, s, e)| (e - s).max(0.0)).collect();
    let total: f64 = durs.iter().sum();
    let out_duration = if use_crossfade {
        total - (n - 1) as f64 * cf
    } else {
        total
    };

    Ok(json!({
        "outputPath": opts.output_path.clone(),
        "duration": out_duration,
        "ok": true
    }))
}

/// 分离路径「暂停压缩」实现：按 keepSegmentsOut 输出时间轴组装音频。
///
/// 算法要点：
///   - vocal 段 i：从 vocal/accomp stem 各 atrim 源 `[keep_segments[i]]` 后 amix（人声 + 该段背景音乐），
///     时长 = 源段长 L_i（compress_keep_timeline 保证 keep_segments 与 keep_segments_out 段长相等）。
///   - 间隙 i（vocal i 与 i+1 之间）：输出间隙 `gap_dur = keep_segments_out[i+1].0 - keep_segments_out[i].1`；
///       * 若 `gap_dur > 1ms`：找覆盖源 gap `(keep_segments[i].1, keep_segments[i+1].0)` 的 `music_segment`
///         （重叠即 `m.start < gap_b && m.end > gap_a`，多者取重叠最大）；命中则从 accomp stem atrim
///         其前 `gap_dur` 秒（取该背景音乐前段 → 实现压缩），未命中（静音无音乐）用 anullsrc 静音 `gap_dur` 秒。
///       * 若 `gap_dur <= 1ms`：跳过（无暂停，硬切到下一 vocal 段）。
///   - 各输出段按序用 concat demuxer 直连（暂停压缩禁用 crossfade，避免语音 crossfade 进静音/音乐）；
///     末级统一施加 de-ess/declick/normalize。
///   - 视频沿用既有 full-input + `-shortest` 行为（不逐段冻结），保证与修改前一致、不引入回归。
fn speech_assemble_separated_pause(
    input: &str,
    opts: &SpeechAssembleOptions,
    ff: &str,
    has_video: bool,
    vocal: &str,
    accomp: &str,
    segments: &[(f64, f64)],
    out_segs: &[(f64, f64)],
    declick: bool,
    deess: bool,
    normalize: bool,
) -> Result<Value, AppError> {
    let temp_dir = std::env::temp_dir();
    let pid = std::process::id();

    let mut clips: Vec<PathBuf> = Vec::with_capacity(segments.len() * 2);
    let mut clip_durations: Vec<f64> = Vec::with_capacity(segments.len() * 2);

    // 预解析 music_segments（源坐标）供间隙桥接查找（构造上 ⊆ 源 gap）。
    let music = opts.music_segments.clone().unwrap_or_default();

    for i in 0..segments.len() {
        let (vs, ve) = segments[i];
        // 1) vocal Mix 段：vocal + accomp 各 atrim[vs,ve] 后 amix。
        let mix_path = temp_dir.join(format!("aicut_sep_mix_{}_{}.m4a", pid, i));
        if let Err(e) = build_vocal_mix_clip(ff, vocal, accomp, vs, ve, &mix_path) {
            cleanup(&clips, None);
            return Err(e);
        }
        clips.push(mix_path);
        clip_durations.push((ve - vs).max(0.0));

        // 2) 间隙段（vocal i 与 i+1 之间）。
        if i + 1 < segments.len() {
            let gap_dur = (out_segs[i + 1].0 - out_segs[i].1).max(0.0);
            if gap_dur > 1e-3 {
                let gap_a = ve; // 源 gap 起点 = vocal i 源终点
                let gap_b = segments[i + 1].0; // 源 gap 终点 = vocal i+1 源起点
                // 找覆盖源 gap 的 music_segment（重叠最大者优先）。
                let mut best: Option<(f64, f64)> = None;
                let mut best_overlap = 0.0_f64;
                for &(m_s, m_e) in &music {
                    if m_s < gap_b && m_e > gap_a {
                        let ov = (m_e.min(gap_b) - m_s.max(gap_a)).max(0.0);
                        if ov > best_overlap {
                            best_overlap = ov;
                            best = Some((m_s, m_e));
                        }
                    }
                }
                if let Some((m_s, _)) = best {
                    // 命中：从 accomp stem 取该背景音乐前 gap_dur 秒（压缩到间隙时长）。
                    let br_path = temp_dir.join(format!("aicut_sep_br_{}_{}.m4a", pid, i));
                    if let Err(e) = build_accomp_bridge_clip(ff, accomp, m_s, gap_dur, &br_path) {
                        cleanup(&clips, None);
                        return Err(e);
                    }
                    clips.push(br_path);
                } else {
                    // 未命中（gap 是纯静音无音乐）：生成 gap_dur 秒静音桥接。
                    let sl_path = temp_dir.join(format!("aicut_sep_sil_{}_{}.m4a", pid, i));
                    if let Err(e) = build_silence_audio_clip(ff, gap_dur, &sl_path) {
                        cleanup(&clips, None);
                        return Err(e);
                    }
                    clips.push(sl_path);
                }
                clip_durations.push(gap_dur);
            }
        }
    }

    // 3) concat demuxer 直连各段（均为 aac/48k/2ch，可 -c copy）。
    let combined = temp_dir.join(format!("aicut_sep_combined_{}.m4a", pid));
    let list_path = temp_dir.join(format!("aicut_sep_list_{}.txt", pid));
    {
        let mut content = String::new();
        for p in &clips {
            content.push_str(&format!("file '{}'\n", p.to_string_lossy().replace('\\', "/")));
        }
        if let Err(e) = std::fs::write(&list_path, content) {
            cleanup(&clips, None);
            return Err(AppError::Render(format!("写入 concat 列表失败: {}", e)));
        }
    }
    let concat_args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.to_string_lossy().replace('\\', "/"),
        "-c".into(),
        "copy".into(),
        combined.to_string_lossy().replace('\\', "/"),
    ];
    let out = Command::new(ff)
        .args(&concat_args)
        .output()
        .map_err(|e| {
            cleanup(&clips, Some(&list_path));
            AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e))
        })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        cleanup(&clips, Some(&list_path));
        return Err(AppError::Render(format!(
            "分离路径暂停压缩合成失败 (退出码 {:?}): {}",
            out.status.code(),
            stderr.chars().take(800).collect::<String>()
        )));
    }
    cleanup(&clips, Some(&list_path));

    // 4) 末级 mux：原视频流 0:v（若有） + 合并音频（统一后处理），-shortest 截断到音频时长。
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        input.to_string(),
        "-i".into(),
        combined.to_string_lossy().replace('\\', "/"),
    ];
    if let Some(af) = audio_post_filters(declick, deess, normalize) {
        args.push("-filter_complex".into());
        args.push(format!("[1:a]{}[aout];", af));
        args.push("-map".into());
        if has_video {
            args.push("0:v".into());
            args.push("-map".into());
        }
        args.push("[aout]".into());
    } else {
        args.push("-map".into());
        if has_video {
            args.push("0:v".into());
            args.push("-map".into());
        }
        args.push("1:a".into());
    }
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-shortest".into());
    args.push(opts.output_path.clone());

    let out = Command::new(ff)
        .args(&args)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_file(&combined);
        return Err(AppError::Render(format!(
            "分离路径末级 mux 失败 (退出码 {:?}): {}",
            out.status.code(),
            stderr.chars().take(800).collect::<String>()
        )));
    }
    let _ = std::fs::remove_file(&combined);

    let out_duration: f64 = clip_durations.iter().sum();
    let real_dur = probe(&opts.output_path)
        .map(|m| m.duration)
        .unwrap_or(out_duration);
    Ok(json!({
        "outputPath": opts.output_path.clone(),
        "duration": real_dur,
        "ok": true
    }))
}

/// 生成 vocal Mix 段：vocal/accomp stem 各 atrim 源 [s,e] 后 amix（人声 + 该段背景音乐）。
/// 输出音频统一为 aac/48k/2ch，便于后续 concat demuxer -c copy。
fn build_vocal_mix_clip(
    ff: &str,
    vocal: &str,
    accomp: &str,
    s: f64,
    e: f64,
    out_path: &std::path::Path,
) -> Result<(), AppError> {
    let out_str = out_path.to_string_lossy().replace('\\', "/");
    let fc = format!(
        "[0]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[vt];\
         [1]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[at];\
         [vt][at]amix=inputs=2:duration=longest[mo];",
        s, e, s, e
    );
    let args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        vocal.to_string(),
        "-i".into(),
        accomp.to_string(),
        "-filter_complex".into(),
        fc,
        "-map".into(),
        "[mo]".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-c:a".into(),
        "aac".into(),
        out_str,
    ];
    let out = Command::new(ff)
        .args(&args)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
    if !out.status.success() {
        return Err(AppError::Render(format!(
            "vocal Mix 段切割失败 (退出码 {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).chars().take(600).collect::<String>()
        )));
    }
    Ok(())
}

/// 生成 accomp 桥接段：从 accomp stem atrim 源 [m_start, m_start+gap_dur]，
/// 取该背景音乐的前 gap_dur 秒（实现压缩到输出间隙时长）。
fn build_accomp_bridge_clip(
    ff: &str,
    accomp: &str,
    m_start: f64,
    gap_dur: f64,
    out_path: &std::path::Path,
) -> Result<(), AppError> {
    let out_str = out_path.to_string_lossy().replace('\\', "/");
    let fc = format!(
        "[0]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[a];",
        m_start,
        m_start + gap_dur
    );
    let args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        accomp.to_string(),
        "-filter_complex".into(),
        fc,
        "-map".into(),
        "[a]".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-c:a".into(),
        "aac".into(),
        out_str,
    ];
    let out = Command::new(ff)
        .args(&args)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
    if !out.status.success() {
        return Err(AppError::Render(format!(
            "accomp 桥接段切割失败 (退出码 {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).chars().take(600).collect::<String>()
        )));
    }
    Ok(())
}

/// 生成静音桥接段（gap 无背景音乐时）：anullsrc 生成 gap_dur 秒静音，音频 aac/48k/2ch。
/// 注意：分离路径只桥接音频，不需冻结视频帧（与非分离路径的 build_pause_clip 不同，勿误用）。
fn build_silence_audio_clip(
    ff: &str,
    gap_dur: f64,
    out_path: &std::path::Path,
) -> Result<(), AppError> {
    let out_str = out_path.to_string_lossy().replace('\\', "/");
    let args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        format!("anullsrc=r=48000:cl=stereo:d={:.6}", gap_dur),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-c:a".into(),
        "aac".into(),
        out_str,
    ];
    let out = Command::new(ff)
        .args(&args)
        .output()
        .map_err(|e| AppError::Render(format!("无法启动 ffmpeg ({}): {}", ff, e)))?;
    if !out.status.success() {
        return Err(AppError::Render(format!(
            "静音桥接段生成失败 (退出码 {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).chars().take(600).collect::<String>()
        )));
    }
    Ok(())
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
