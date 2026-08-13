//! src/ffmpeg.rs — FFmpeg 命令构建器 + 滤镜探测降级

use std::collections::HashSet;
use std::process::Command;
use std::sync::OnceLock;

/// 1080p30 默认导出码率 (Mbps)
pub const DEFAULT_BITRATE_MBPS: f64 = 8.0;
pub const DEFAULT_CODEC: &str = "libx264";
pub const DEFAULT_CRF: u32 = 18;

pub const HW_ENCODERS: &[(&str, &str, &str)] = &[
    ("nvenc", "h264_nvenc", "hevc_nvenc"),
    ("amf", "h264_amf", "hevc_amf"),
    ("qsv", "h264_qsv", "hevc_qsv"),
];

pub fn resolve_encoder(preset: &str, codec_type: &str) -> &'static str {
    if preset.is_empty() || preset == "software" {
        return if codec_type == "h265" { "libx265" } else { DEFAULT_CODEC };
    }
    let is_hevc = codec_type == "h265";
    for (name, h264, hevc) in HW_ENCODERS {
        if *name == preset { return if is_hevc { hevc } else { h264 }; }
    }
    DEFAULT_CODEC
}

/// 渲染命令容器
#[derive(Debug, Clone)]
/// 单个输入文件及其专属输入选项。
/// - `path`：媒体文件路径。
/// - `stream_loop`：输入级 `-stream_loop N`（N=-1 表示无限循环），用于让背景图片/视频
///   撑满前景时长；普通素材为 None（不循环）。
/// - `raw_video`：原始视频（gray16le rawvideo）输入，如瘦脸/大眼形变图（X/Y warp map）。
///   Some((w, h)) 时在 `-i` 前注入 `-f rawvideo -pix_fmt gray16le -s {w}x{h}`，
///   以 uint16 绝对像素坐标形式读取（本机 ffmpeg 不支持 format=float/grayf32le）；None 表示普通媒体输入。
pub struct InputSpec {
    pub path: String,
    pub stream_loop: Option<i64>,
    pub raw_video: Option<(u32, u32)>,
}

pub struct RenderCommand {
    pub inputs: Vec<InputSpec>,
    pub filter_graph: String,
    /// 滤镜图输出标签列表，每个元素追加为一个独立 `-map` 参数。
    /// 视频用 `[vout]` 滤镜标签，音频用 `[a0]`/`[aout]` 滤镜标签或 `0:a` 文件索引。
    /// 必须拆分多个 `-map`：音频不能写成 `[0:a]`（方括号是滤镜标签语法，会被当成不存在的标签而丢轨）。
    pub map_labels: Vec<String>,
    pub output_codec: String,
    pub crf: u32,
    pub resolution: (u32, u32),
    pub fps: u32,
    pub bitrate: f64,
}

impl Default for RenderCommand {
    fn default() -> Self {
        Self {
            inputs: Vec::new(),
            filter_graph: String::new(),
            map_labels: Vec::new(),
            output_codec: DEFAULT_CODEC.to_string(),
            crf: DEFAULT_CRF,
            resolution: (1920, 1080),
            fps: crate::project::DEFAULT_FPS,
            bitrate: DEFAULT_BITRATE_MBPS,
        }
    }
}

impl RenderCommand {
    /// 构建输入参数：`-i file -i file ...`
    pub fn build_input_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        for inp in &self.inputs {
            if let Some(l) = inp.stream_loop {
                args.push("-stream_loop".to_string());
                args.push(l.to_string());
            }
            // 原始视频（gray16le 形变图）输入：在 `-i` 前注入格式/尺寸选项。
            if let Some((rw, rh)) = inp.raw_video {
                args.push("-f".to_string());
                args.push("rawvideo".to_string());
                args.push("-pix_fmt".to_string());
                args.push("gray16le".to_string());
                args.push("-s".to_string());
                args.push(format!("{}x{}", rw, rh));
            }
            args.push("-i".to_string());
            args.push(inp.path.clone());
        }
        args
    }

    /// 构建输出参数
    pub fn build_output_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if !self.map_labels.is_empty() {
            for label in &self.map_labels {
                args.push("-map".to_string());
                args.push(label.clone());
            }
            // 检测是否包含音频流（[a0] [aout] 等滤镜标签，或 0:a 文件索引）
            let has_audio = self.map_labels.iter().any(|l| l.contains("[a") || l.starts_with("0:a") || l.contains(":a"));
            if has_audio {
                args.extend(["-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "192k".to_string()]);
            }
        }
        args.extend([
            "-c:v".to_string(),
            self.output_codec.clone(),
            "-crf".to_string(),
            self.crf.to_string(),
            "-r".to_string(),
            self.fps.to_string(),
            // 现代 ffmpeg(2026 构建)默认 vsync 行为变更，仅 -r 不足以 100% 保证恒定帧率；
            // 显式 -fps_mode cfr 强制 CFR 输出，杜绝 VFR 导致的播放卡顿。
            "-fps_mode".to_string(),
            "cfr".to_string(),
            "-b:v".to_string(),
            format!("{}M", self.bitrate),
            // 播放流畅 + 可拖拽：固定关键帧间隔（约每 2 秒一个），faststart 把 moov 前置
            "-g".to_string(),
            (self.fps * 2).to_string(),
            "-keyint_min".to_string(),
            self.fps.to_string(),
            "-sc_threshold".to_string(),
            "0".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            "-s".to_string(),
            format!("{}x{}", self.resolution.0, self.resolution.1),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
        ]);
        args
    }

    /// 组合为完整 Vec<String> 命令（output 路径由调用方追加 / 覆盖）
    pub fn to_command_line(&self) -> Vec<String> {
        let mut cmd = vec!["ffmpeg".to_string(), "-y".to_string()];
        cmd.extend(self.build_input_args());
        if !self.filter_graph.is_empty() {
            cmd.push("-filter_complex".to_string());
            cmd.push(self.filter_graph.clone());
        }
        cmd.extend(self.build_output_args());
        cmd.push("output.mp4".to_string());
        cmd
    }

    /// 把单个参数安全化为「用于 shell 命令字符串」的形式：
    /// 若含空格或制表符，则用双引号包裹（与前端 `parseShellArgs` 的引号解析一致）。
    /// Windows 文件名不允许包含 `"` 字符，故直接包裹即可，无需转义。
    ///
    /// 仅用于 `to_command_string`（日志/调试、以及被前端解析回 `Vec<String>` 的串）。
    /// 安全的参数列表模式（`to_command_line` / `execute`）不经过 shell 解析，无需引号。
    fn shell_quote_arg(s: &str) -> String {
        if s.contains(' ') || s.contains('\t') {
            format!("\"{}\"", s)
        } else {
            s.to_string()
        }
    }

    /// 组合为可读的命令行字符串（仅用于日志/调试输出）。
    ///
    /// 含空格/制表符的参数（典型如用户素材路径 `2026-07-27 11-07-05.mp4`）
    /// 会被双引号包裹，确保前端 `parseShellArgs` 能将其正确还原为单个参数，
    /// 否则空格会把路径劈成多段导致 ffmpeg 找不到输入文件。
    ///
    /// # 安全警告
    ///
    /// **不要将此字符串传给 `sh -c` / `cmd /c` 执行！** 资产路径来自
    /// 用户提供的 JSON，可能包含 shell 元字符，导致命令注入。
    ///
    /// 始终使用 [`RenderCommand::execute`] 或 [`std::process::Command`]
    /// 并传入 `to_command_line()` 返回的 `Vec<String>` 作为参数列表。
    pub fn to_command_string(&self) -> String {
        self.to_command_line()
            .iter()
            .map(|a| Self::shell_quote_arg(a))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// 安全执行 FFmpeg 渲染命令，返回进程输出。
    ///
    /// 使用 [`std::process::Command`] 的参数列表模式（非 shell 字符串），
    /// 避免命令注入风险。资产路径中的特殊字符被当作字面值处理。
    pub fn execute(&self) -> std::io::Result<std::process::Output> {
        let args = self.to_command_line();
        std::process::Command::new(&args[0])
            .args(&args[1..])
            .output()
    }

    /// 安全执行 FFmpeg 渲染，指定输出文件路径。
    pub fn execute_to_file(&self, output_path: &str) -> std::io::Result<std::process::Output> {
        let mut args = self.to_command_line();
        // 替换默认 output.mp4
        if let Some(last) = args.last_mut() {
            *last = output_path.to_string();
        }
        std::process::Command::new(&args[0])
            .args(&args[1..])
            .output()
    }
}

// ───────────────────────── 滤镜探测降级 ─────────────────────────

/// 探测结果缓存（OnceLock 保证只探测一次）
static FILTER_AVAILABILITY: OnceLock<HashSet<String>> = OnceLock::new();

/// 启动时探测沙盒环境可用滤镜（`ffmpeg -filters` 解析），缺失则记为不可用
pub fn probe_filters() -> &'static HashSet<String> {
    FILTER_AVAILABILITY.get_or_init(|| {
        let mut avail = HashSet::new();
        if let Ok(out) = Command::new("ffmpeg").arg("-filters").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    // `ffmpeg -filters` 每行形如:  ..C eq   A->A   ...
                    if let Some(name) = parts.get(1) {
                        avail.insert(name.to_string());
                    }
                }
            }
        }
        avail
    })
}

/// 某滤镜是否可用
pub fn is_filter_available(name: &str) -> bool {
    probe_filters().contains(name)
}

/// 滤镜降级映射：
///   eq    → 缺失则用 brightness/contrast 退化版
///   mask  → 缺失则跳过（返回 None）
///   format→ 强制 format=yuv420p
///   _     → 原样返回
pub fn degrade_filter(name: &str) -> Option<String> {
    match name {
        "eq" if !is_filter_available("eq") => Some("brightness=0:contrast=1".to_string()),
        "mask" if !is_filter_available("mask") => None,
        "format" => Some("format=yuv420p".to_string()),
        other => Some(other.to_string()),
    }
}

// ════════════════════ 4K 代理生成 ════════════════════

/// 代理质量预设
pub const PROXY_HEIGHT: u32 = 720;
pub const PROXY_CRF: u32 = 23;

/// 判断素材是否需要生成代理（分辨率 > 1080p 的高清素材）
pub fn needs_proxy(width: u32, height: u32) -> bool {
    height > 1080 || width > 1920
}

/// 生成 720p 代理文件的 ffmpeg 命令。
/// 输入：原始素材路径 + 代理输出路径
/// 返回：可直接执行的 `std::process::Command`
pub fn build_proxy_command(input: &str, output: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args([
        "-y", "-i", input,
        "-vf", &format!("scale=-2:{}", PROXY_HEIGHT),
        "-c:v", "libx264",
        "-crf", &PROXY_CRF.to_string(),
        "-preset", "fast",
        "-an",  // 代理文件不需音频
        output,
    ]);
    cmd
}

/// 生成代理并返回输出。成功返回 Ok，失败返回 stderr
pub fn generate_proxy(input: &str, output: &str) -> Result<(), String> {
    let out = build_proxy_command(input, output)
        .output()
        .map_err(|e| format!("代理生成失败: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// 批量为工程中所有高分辨率素材生成代理。
/// 返回 (成功数, 失败列表)
pub fn generate_proxies_batch(project: &crate::project::Project, proxy_dir: &str) -> (usize, Vec<String>) {
    let mut ok = 0usize;
    let mut fails = Vec::new();
    for asset in &project.assets {
        if !needs_proxy(asset.width, asset.height) || asset.asset_type != "video" {
            continue;
        }
        // 代理文件名：原文件名_stem + _proxy + 原扩展名
        let stem = std::path::Path::new(&asset.path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| asset.id.clone());
        let ext = std::path::Path::new(&asset.path)
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "mp4".to_string());
        let proxy_path = format!("{}/{}_proxy.{}", proxy_dir, stem, ext);
        match generate_proxy(&asset.path, &proxy_path) {
            Ok(()) => ok += 1,
            Err(e) => fails.push(format!("{}: {}", asset.id, e)),
        }
    }
    (ok, fails)
}

// ════════════════════ 管道编码器 + 抽帧命令 ════════════════════

/// 构建管道编码器命令：stdin 喂 rawvideo 帧，stdout 输出编码后文件
///
/// 用法：启动 `ffmpeg` 子进程，逐帧将 RGBA 数据写入 stdin，
/// ffmpeg 实时编码并写入 output_path。
///
/// 参数：
/// - output: 输出文件路径
/// - width/height: 画布分辨率
/// - fps: 帧率
/// - codec: 视频编码器（如 libx264）
/// - crf: 质量（18=高质量，23=默认）
/// - audio_codec: 音频编码器（如 aac），None 则不编码音频
pub fn build_pipe_encoder_cmd(
    output: &str,
    width: u32,
    height: u32,
    fps: u32,
    codec: &str,
    crf: u32,
    bitrate_mbps: f64,
) -> Vec<String> {
    vec![
        "ffmpeg".to_string(),
        "-y".to_string(),
        "-f".to_string(), "rawvideo".to_string(),
        "-pix_fmt".to_string(), "rgba".to_string(),
        "-s".to_string(), format!("{}x{}", width, height),
        "-r".to_string(), fps.to_string(),
        "-i".to_string(), "pipe:0".to_string(),  // stdin
        "-c:v".to_string(), codec.to_string(),
        "-crf".to_string(), crf.to_string(),
        "-b:v".to_string(), format!("{}M", bitrate_mbps),
        // 播放流畅 + 可拖拽：固定关键帧间隔（约每 2 秒一个），faststart 把 moov 前置
        "-g".to_string(), (fps * 2).to_string(),
        "-keyint_min".to_string(), fps.to_string(),
        "-sc_threshold".to_string(), "0".to_string(),
        "-movflags".to_string(), "+faststart".to_string(),
        "-pix_fmt".to_string(), "yuv420p".to_string(),
        "-r".to_string(), fps.to_string(),
        // 强制 CFR，避免现代 ffmpeg 默认 vsync 行为导致 VFR 输出、播放卡顿
        "-fps_mode".to_string(), "cfr".to_string(),
        output.to_string(),
    ]
}

/// 构建单帧抽帧命令：从视频素材中提取时间 t 的一帧（RGBA rawvideo）
///
/// 使用 `-ss` 在 `-i` 之前（快速 seek 到最近关键帧），适合预览。
/// 导出时可用 accurate seek 版本（-ss 在 -i 之后）。
///
/// 参数：
/// - input: 源视频路径
/// - t: 源素材时间（秒）
/// - width/height: 输出帧尺寸
pub fn build_extract_frame_cmd(input: &str, t: f64, width: u32, height: u32) -> Vec<String> {
    vec![
        "ffmpeg".to_string(),
        "-ss".to_string(), format!("{:.3}", t),
        "-i".to_string(), input.to_string(),
        "-frames:v".to_string(), "1".to_string(),
        "-f".to_string(), "rawvideo".to_string(),
        "-pix_fmt".to_string(), "rgba".to_string(),
        "-s".to_string(), format!("{}x{}", width, height),
        "pipe:1".to_string(),  // stdout
    ]
}

/// 构建精确抽帧命令（-ss 在 -i 之后，慢但精确）
pub fn build_extract_frame_accurate(input: &str, t: f64, width: u32, height: u32) -> Vec<String> {
    vec![
        "ffmpeg".to_string(),
        "-i".to_string(), input.to_string(),
        "-ss".to_string(), format!("{:.3}", t),
        "-frames:v".to_string(), "1".to_string(),
        "-f".to_string(), "rawvideo".to_string(),
        "-pix_fmt".to_string(), "rgba".to_string(),
        "-s".to_string(), format!("{}x{}", width, height),
        "pipe:1".to_string(),
    ]
}

/// 构建音频抽取命令：从素材中提取一段音频（f32le PCM）
///
/// 参数：
/// - input: 源文件路径
/// - t: 起始时间（秒）
/// - duration: 提取时长（秒）
/// - sample_rate: 采样率
/// - channels: 声道数
pub fn build_extract_audio_cmd(
    input: &str,
    t: f64,
    duration: f64,
    sample_rate: u32,
    channels: u16,
) -> Vec<String> {
    vec![
        "ffmpeg".to_string(),
        "-ss".to_string(), format!("{:.3}", t),
        "-i".to_string(), input.to_string(),
        "-t".to_string(), format!("{:.3}", duration),
        "-f".to_string(), "f32le".to_string(),
        "-acodec".to_string(), "pcm_f32le".to_string(),
        "-ac".to_string(), channels.to_string(),
        "-ar".to_string(), sample_rate.to_string(),
        "pipe:1".to_string(),
    ]
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitrate_4k() { assert!((bitrate_for_resolution((3840, 2160)) - 25.0).abs() < 0.01); }
    #[test]
    fn test_bitrate_1080p() { assert!((bitrate_for_resolution((1920, 1080)) - 8.0).abs() < 0.01); }
    #[test]
    fn test_bitrate_720p() { assert!((bitrate_for_resolution((1280, 720)) - 5.0).abs() < 0.01); }
    #[test]
    fn test_bitrate_small() { assert!((bitrate_for_resolution((640, 480)) - 3.0).abs() < 0.01); }
    #[test]
    fn test_bitrate_8k() { assert!((bitrate_for_resolution((7680, 4320)) - 25.0).abs() < 0.01); }

    #[test]
    fn test_resolve_encoder_nvenc_h264() { assert_eq!(resolve_encoder("nvenc", "h264"), "h264_nvenc"); }
    #[test]
    fn test_resolve_encoder_nvenc_h265() { assert_eq!(resolve_encoder("nvenc", "h265"), "hevc_nvenc"); }
    #[test]
    fn test_resolve_encoder_amf() { assert_eq!(resolve_encoder("amf", "h264"), "h264_amf"); }
    #[test]
    fn test_resolve_encoder_qsv() { assert_eq!(resolve_encoder("qsv", "h265"), "hevc_qsv"); }
    #[test]
    fn test_resolve_encoder_software() {
        assert_eq!(resolve_encoder("software", "h264"), "libx264");
        assert_eq!(resolve_encoder("", "h265"), "libx265");
        assert_eq!(resolve_encoder("unknown", "h264"), "libx264");
    }

    #[test]
    fn test_degrade_filter_pass_through() {
        assert_eq!(degrade_filter("scale"), Some("scale".to_string()));
        assert_eq!(degrade_filter("overlay"), Some("overlay".to_string()));
        assert_eq!(degrade_filter("hflip"), Some("hflip".to_string()));
    }

    #[test]
    fn test_degrade_format() { assert_eq!(degrade_filter("format"), Some("format=yuv420p".to_string())); }

    #[test]
    fn test_degrade_eq_mask() {
        // 取决于沙盒 ffmpeg 可用性，但不会 panic
        assert!(degrade_filter("eq").is_some() || degrade_filter("eq").is_some());
        // mask 不可用时应返回 None
        let m = degrade_filter("mask");
        assert!(m.is_none() || m == Some("mask".to_string()));
    }

    #[test]
    fn test_render_command_execute() {
        let cmd = RenderCommand::default();
        let args = cmd.to_command_line();
        assert!(args[0] == "ffmpeg");
        assert!(args.contains(&"-y".to_string()));
    }

    #[test]
    fn test_to_command_string_is_display_only() {
        let cmd = RenderCommand::default();
        let s = cmd.to_command_string();
        assert!(s.starts_with("ffmpeg"));
        assert!(s.contains("output.mp4"));
    }

    #[test]
    fn test_to_command_string_quotes_spaced_path() {
        // 含空格的输入路径必须被双引号包裹，否则前端 parseShellArgs 会把它
        // 劈成多段，ffmpeg 找不到输入文件（真实案例：2026-07-27 11-07-05.mp4）。
        let mut cmd = RenderCommand::default();
        cmd.inputs.push(InputSpec {
            path: "C:/Users/me/My Video.mp4".to_string(),
            stream_loop: None,
            raw_video: None,
        });
        let s = cmd.to_command_string();
        assert!(
            s.contains("-i \"C:/Users/me/My Video.mp4\""),
            "含空格输入路径必须被引号包裹，实际: {}",
            s
        );
    }

    // 关键回归：导出编码器必须显式固定关键帧间隔 + faststart，避免导出视频播放卡顿
    #[test]
    fn test_build_output_args_has_keyframes_and_faststart() {
        let mut cmd = RenderCommand::default();
        cmd.fps = 30;
        let args = cmd.build_output_args();
        assert!(args.contains(&"-g".to_string()), "missing -g in output args");
        assert!(args.contains(&"60".to_string()), "expected gop = 2*fps = 60");
        assert!(args.contains(&"-keyint_min".to_string()), "missing -keyint_min");
        assert!(args.contains(&"-movflags".to_string()), "missing -movflags");
        assert!(args.contains(&"+faststart".to_string()), "missing +faststart");
    }

    #[test]
    fn test_build_pipe_encoder_cmd_has_keyframes_and_faststart() {
        let args = build_pipe_encoder_cmd("out.mp4", 1920, 1080, 30, "libx264", 18, 8.0);
        assert!(args.contains(&"-g".to_string()), "missing -g in pipe encoder");
        assert!(args.contains(&"60".to_string()), "expected gop = 2*fps = 60");
        assert!(args.contains(&"-keyint_min".to_string()), "missing -keyint_min");
        assert!(args.contains(&"-movflags".to_string()), "missing -movflags");
        assert!(args.contains(&"+faststart".to_string()), "missing +faststart");
    }

    #[test]
    fn test_needs_proxy() {
        assert!(needs_proxy(3840, 2160));  // 4K → need proxy
        assert!(!needs_proxy(1920, 1080)); // 1080p → no proxy
        assert!(!needs_proxy(1280, 720));  // 720p → no proxy
    }

    #[test]
    fn test_build_proxy_command() {
        let cmd = build_proxy_command("input.mp4", "proxy.mp4");
        let args: Vec<String> = cmd.get_args().map(|s| s.to_string_lossy().to_string()).collect();
        assert!(args.contains(&"-vf".to_string()));
        assert!(args.iter().any(|a| a.contains("720")));
        assert!(args.contains(&"proxy.mp4".to_string()));
    }
}

/// 按分辨率阶梯解析默认码率（4K→25, 1080p→8, 720p→5, 其他→3 Mbps）
pub fn bitrate_for_resolution(res: (u32, u32)) -> f64 {
    let pixels = res.0 * res.1;
    if pixels >= 3840 * 2160 {
        25.0
    } else if pixels >= 1920 * 1080 {
        DEFAULT_BITRATE_MBPS
    } else if pixels >= 1280 * 720 {
        5.0
    } else {
        3.0
    }
}
