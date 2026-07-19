//! src/ffmpeg.rs — FFmpeg 命令构建器
//! 对应 TS `ffmpeg.ts`：RenderCommand / FilterChain / buildFFmpegCommand()。
//! 含「滤镜探测降级」机制：启动时探测沙盒可用滤镜，缺失则降级替代。

use std::collections::HashSet;
use std::process::Command;
use std::sync::OnceLock;

/// 1080p30 默认导出码率 (Mbps)
pub const DEFAULT_BITRATE_MBPS: f64 = 8.0;
/// 默认视频编码器
pub const DEFAULT_CODEC: &str = "libx264";
/// 默认 CRF
pub const DEFAULT_CRF: u32 = 18;

/// 硬件编码器映射（自动检测 → ffmpeg 编码器名）
pub const HW_ENCODERS: &[(&str, &str, &str)] = &[
    ("nvenc", "h264_nvenc", "hevc_nvenc"),   // NVIDIA
    ("amf", "h264_amf", "hevc_amf"),          // AMD
    ("qsv", "h264_qsv", "hevc_qsv"),          // Intel QuickSync
];

/// 根据编码器预设名和类型（h264/h265）解析实际 ffmpeg 编码器名
pub fn resolve_encoder(preset: &str, codec_type: &str) -> &'static str {
    if preset.is_empty() || preset == "software" {
        return if codec_type == "h265" { "libx265" } else { DEFAULT_CODEC };
    }
    let is_hevc = codec_type == "h265";
    for (name, h264, hevc) in HW_ENCODERS {
        if *name == preset {
            return if is_hevc { hevc } else { h264 };
        }
    }
    DEFAULT_CODEC
}

/// 单个滤镜节点（FFmpeg filtergraph 中的一个标签化滤镜）
#[derive(Debug, Clone, Default)]
pub struct FilterNode {
    pub label: String,
    pub spec: String,
}

/// 有序滤镜链
#[derive(Debug, Clone, Default)]
pub struct FilterChain {
    pub nodes: Vec<FilterNode>,
}

impl FilterChain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, node: FilterNode) {
        self.nodes.push(node);
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// 序列化为 FFmpeg `-filter_complex` 字符串（节点以 `;` 连接）
    pub fn to_filter_complex(&self) -> String {
        self.nodes
            .iter()
            .map(|n| n.spec.clone())
            .collect::<Vec<_>>()
            .join(";")
    }
}

/// 渲染命令容器
#[derive(Debug, Clone)]
pub struct RenderCommand {
    pub inputs: Vec<String>,
    pub filter_graph: String,
    /// 滤镜图最终输出标签（如 "[vout]"），非空时追加 `-map`
    pub map_label: Option<String>,
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
            map_label: None,
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
            args.push("-i".to_string());
            args.push(inp.clone());
        }
        args
    }

    /// 将 FilterChain 序列化为完整 filter_complex 字符串
    pub fn build_filter_graph(chain: &FilterChain) -> String {
        chain.to_filter_complex()
    }

    /// 构建输出参数：`-c:v libx264 -crf 18 -r 30 -b:v 8M -s WxH -pix_fmt yuv420p`
    pub fn build_output_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(label) = &self.map_label {
            args.push("-map".to_string());
            args.push(label.clone());
        }
        args.extend([
            "-c:v".to_string(),
            self.output_codec.clone(),
            "-crf".to_string(),
            self.crf.to_string(),
            "-r".to_string(),
            self.fps.to_string(),
            "-b:v".to_string(),
            format!("{}M", self.bitrate),
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

    /// 组合为可读的命令行字符串（仅用于日志/调试输出）。
    ///
    /// # 安全警告
    ///
    /// **不要将此字符串传给 `sh -c` / `cmd /c` 执行！** 资产路径来自
    /// 用户提供的 JSON，可能包含 shell 元字符，导致命令注入。
    ///
    /// 始终使用 [`RenderCommand::execute`] 或 [`std::process::Command`]
    /// 并传入 `to_command_line()` 返回的 `Vec<String>` 作为参数列表。
    pub fn to_command_string(&self) -> String {
        self.to_command_line().join(" ")
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
