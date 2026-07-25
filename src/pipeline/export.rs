//! src/pipeline/export.rs — 高质量导出管线
//!
//! 使用 SteppedClock 按帧步进，绝对不丢帧。
//! 流程：查询 Timeline → 并行解码池抽取各轨道帧 → Compositor 多轨道合成 → FFmpeg 管道编码

use crate::clock::{Clock, SteppedClock};
use crate::compositor::{CompositeLayer, Compositor};
use crate::decoder::{DecoderPool, PrefetchRequest};
use crate::ffmpeg;
use crate::pipeline::strategy::*;
use crate::project::{CanvasConfig, Clip, Project};
use crate::subtitle;
use crate::timeline::Timeline;
use crate::AppError;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

// 音频淡入/淡出增益：相对时间 rt = t - timeline_in。
// rt < fade_in        → 线性 0→1（淡入）；rt > dur - fade_out → 线性 1→0（淡出）；否则 1.0。
// 增益夹 [0, 1]。须与 gui/src/utils/transitionUtils.ts::getClipFadeGain 逐字节一致。
fn fade_gain_at(clip: &Clip, t: f64) -> f32 {
    let dur = clip.timeline_out - clip.timeline_in;
    if dur <= 0.0 {
        return 1.0;
    }
    let mut rt = t - clip.timeline_in;
    rt = rt.max(0.0).min(dur);
    let fi = clip.audio_fade_in;
    let fo = clip.audio_fade_out;
    if fi > 0.0 && rt < fi {
        return ((rt / fi) as f32).max(0.0).min(1.0);
    }
    if fo > 0.0 && rt > dur - fo {
        return (((dur - rt) / fo) as f32).max(0.0).min(1.0);
    }
    1.0
}

// ════════════════════ ExportConfig ════════════════════

/// 导出配置
#[derive(Debug, Clone)]
pub struct ExportConfig {
    /// 输出分辨率宽
    pub width: u32,
    /// 输出分辨率高
    pub height: u32,
    /// 帧率
    pub fps: u32,
    /// 视频编码器（如 libx264, h264_nvenc）
    pub codec: String,
    /// CRF 质量（18=高质量, 23=默认）
    pub crf: u32,
    /// 码率（Mbps）
    pub bitrate_mbps: f64,
    /// 采样率
    pub sample_rate: u32,
    /// 音频声道数
    pub audio_channels: u16,
    /// 是否使用精确 seek（-ss 在 -i 之后，慢但精确）
    pub accurate_seek: bool,
    /// 像素格式
    pub pixel_format: PixelFormat,
}

impl Default for ExportConfig {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            codec: ffmpeg::DEFAULT_CODEC.to_string(),
            crf: ffmpeg::DEFAULT_CRF,
            bitrate_mbps: ffmpeg::DEFAULT_BITRATE_MBPS,
            sample_rate: crate::project::DEFAULT_SAMPLE_RATE,
            audio_channels: 2,
            accurate_seek: false,
            pixel_format: PixelFormat::Rgba8,
        }
    }
}

impl ExportConfig {
    /// 从画布配置创建
    pub fn from_canvas(canvas: &CanvasConfig) -> Self {
        Self {
            width: canvas.width,
            height: canvas.height,
            fps: canvas.fps,
            ..Default::default()
        }
    }
}

// ════════════════════ ExportPipeline ════════════════════

/// 高质量导出管线
///
/// 使用 SteppedClock 按帧步进，每帧严格渲染，零丢帧。
///
/// ```text
/// for frame_idx in 0..total_frames:
///   t = frame_idx / fps
///   ① slice = timeline.clips_at(t)         [O(log n)]
///   ② frames = decoder_pool.decode(slice)  [并行 FFmpeg subprocess]
///   ③ composed = compositor.composite()    [CPU Over 合成]
///   ④ encoder.write(composed)               [pipe stdin]
///   clock.advance()
/// ```
pub struct ExportPipeline<'a> {
    project: &'a Project,
    timeline: Timeline<'a>,
    clock: SteppedClock,
    config: ExportConfig,
    /// 并行解码池（带 LRU 缓存）
    decoder_pool: DecoderPool,
    /// 多轨道合成器
    compositor: Compositor,
    /// 音频源整段预抽缓存：clip_id -> 完整源音频（f32le，按 config.sample_rate / audio_channels 交错）
    /// 导出前一次性抽取每个音源片段的完整段，逐帧混音时直接按时间索引，
    /// 把 FFmpeg 进程数从 O(帧数 × 音源数) 降到 O(音源数)。
    audio_cache: HashMap<String, Vec<f32>>,
}

impl<'a> ExportPipeline<'a> {
    /// 创建导出管线
    pub fn new(project: &'a Project, config: ExportConfig) -> Self {
        let timeline = Timeline::new(project);
        let duration = timeline.duration();
        let clock = SteppedClock::new(config.fps, duration);
        let decoder_pool = DecoderPool::new(32).with_accurate_seek(config.accurate_seek);
        let compositor = Compositor::new(config.width, config.height);
        Self { project, timeline, clock, config, decoder_pool, compositor, audio_cache: HashMap::new() }
    }

    /// 从 Project 的画布配置自动创建
    pub fn from_project(project: &'a Project) -> Self {
        let config = ExportConfig::from_canvas(&project.canvas);
        Self::new(project, config)
    }

    /// 获取配置引用
    pub fn config(&self) -> &ExportConfig { &self.config }

    /// 获取时间线引用
    pub fn timeline(&self) -> &Timeline<'a> { &self.timeline }

    /// 获取时钟引用
    pub fn clock(&self) -> &SteppedClock { &self.clock }

    // ── 帧提取（旧接口，保留向后兼容 + 供 build_extract_cmd 测试使用） ──

    /// 为单个片段构建 FFmpeg 抽帧命令
    ///
    /// 将时间线时间 t 转换为源素材时间，然后构建抽帧命令
    pub fn build_extract_cmd(&self, clip: &Clip, t: f64) -> Vec<String> {
        let src_t = timeline_to_source_time(t, clip);
        let asset = self.project.asset_by_id(&clip.asset_id);

        // 优先使用素材自身分辨率，无则用画布分辨率
        let (w, h) = asset
            .filter(|a| a.width > 0 && a.height > 0)
            .map(|a| (a.width, a.height))
            .unwrap_or((self.config.width, self.config.height));

        // 应用缩放变换
        let sw = ((w as f64) * clip.transform.scale_x).round() as u32;
        let sh = ((h as f64) * clip.transform.scale_y).round() as u32;
        let (sw, sh) = (sw.max(1), sh.max(1));

        let input_path = asset.map(|a| a.path.as_str()).unwrap_or("");

        if self.config.accurate_seek {
            ffmpeg::build_extract_frame_accurate(input_path, src_t, sw, sh)
        } else {
            ffmpeg::build_extract_frame_cmd(input_path, src_t, sw, sh)
        }
    }

    /// 执行 FFmpeg 抽帧，返回解码后的像素数据（旧接口，保留向后兼容）
    ///
    /// 这是同步阻塞调用，FFmpeg 启动→抽帧→退出。
    /// 单帧延迟约 50-100ms（快速 seek）或 200-500ms（精确 seek）。
    fn extract_frame_raw(&self, clip: &Clip, t: f64) -> Result<Vec<u8>, AppError> {
        let cmd_args = self.build_extract_cmd(clip, t);
        let asset = self.project.asset_by_id(&clip.asset_id);

        let sw = asset
            .filter(|a| a.width > 0 && a.height > 0)
            .map(|a| ((a.width as f64) * clip.transform.scale_x).round() as u32)
            .unwrap_or(((self.config.width as f64) * clip.transform.scale_x).round() as u32);
        let sh = asset
            .filter(|a| a.width > 0 && a.height > 0)
            .map(|a| ((a.height as f64) * clip.transform.scale_y).round() as u32)
            .unwrap_or(((self.config.height as f64) * clip.transform.scale_y).round() as u32);
        let (sw, sh) = (sw.max(1), sh.max(1));

        let expected_size = self.config.pixel_format.frame_size(sw, sh);

        let output = Command::new(&cmd_args[0])
            .args(&cmd_args[1..])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| AppError::Render(format!("FFmpeg 启动失败: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Render(format!("FFmpeg 抽帧失败: {}", stderr.chars().take(500).collect::<String>())));
        }

        if output.stdout.len() < expected_size {
            return Err(AppError::Render(format!(
                "FFmpeg 输出数据不足: 期望 {} 字节, 实际 {} 字节",
                expected_size, output.stdout.len()
            )));
        }

        Ok(output.stdout[..expected_size].to_vec())
    }

    /// 计算片段解码目标尺寸（素材原始分辨率，不应用 clip 缩放，交给 compositor 处理）
    fn clip_decode_size(&self, clip: &Clip) -> (u32, u32) {
        let asset = self.project.asset_by_id(&clip.asset_id);
        asset
            .filter(|a| a.width > 0 && a.height > 0)
            .map(|a| (a.width, a.height))
            .unwrap_or((self.config.width, self.config.height))
    }

    /// 查找同轨中 timeline_in == t 的下一片段（用于转场叠加）
    fn find_next_clip(&self, track_id: &str, t: f64) -> Option<&'a Clip> {
        for track in &self.project.tracks {
            if track.id == track_id {
                for c in &track.clips {
                    if (c.timeline_in - t).abs() < 1e-6 { return Some(c); }
                }
            }
        }
        None
    }

    /// 按 id 查找轨道
    fn track_by_id(&self, id: &str) -> Option<&'a crate::project::Track> {
        self.project.tracks.iter().find(|t| t.id == id)
    }

    /// 计算声相增益（左, 右）：pan ∈ [-1(全左), 1(全右)]
    fn pan_gains(pan: f32) -> (f32, f32) {
        let p = pan.clamp(-1.0, 1.0);
        if p <= 0.0 { (1.0, 1.0 + p) } else { (1.0 - p, 1.0) }
    }

    /// 是否存在任何可产生音频的轨道（audio / video / effect 且含片段）
    ///
    /// 用于决定是否需要走「视频 + 混音音频 mux」两阶段导出。
    fn any_audio_sources(&self) -> bool {
        self.project.tracks.iter().any(|t| {
            (t.track_type == "audio" || t.track_type == "video" || t.track_type == "effect")
                && !t.clips.is_empty()
        })
    }

    /// 导出前，一次性预抽取所有音频源片段的完整源音频到内存缓存。
    ///
    /// 传统逐帧混音对每个「视频帧 × 音源」都起一次 FFmpeg 进程，长片 = 帧数 × 音轨数 次
    /// 进程创建，极慢。改为：导出开始前对每个音频源片段抽取其完整源音频段
    /// （从 `src_range.start` 起，持续 `(timeline_out - timeline_in) × speed` 秒），
    /// 逐帧混音时直接按时间索引缓存，把进程数从 O(帧数 × 音源数) 降到 O(音源数)。
    ///
    /// 时间索引语义与 `render_audio_chunk` 原逐帧抽取完全一致（含 speed 抽稀），不改变既有混音行为。
    /// 内存代价：每个音源片段完整音频驻留内存（f32le），对典型短片可接受；与逐帧抽相比是一次性的。
    fn build_audio_cache(&mut self) {
        let sample_rate = self.config.sample_rate;
        let channels = self.config.audio_channels;

        // solo 轨判定（决定哪些轨参与混音），与 render_audio_chunk 保持一致
        let any_solo = self.project.tracks.iter().any(|t| {
            (t.track_type == "audio" || t.track_type == "video" || t.track_type == "effect")
                && !t.clips.is_empty()
                && t.solo
        });

        for track in &self.project.tracks {
            if track.track_type != "audio"
                && track.track_type != "video"
                && track.track_type != "effect"
            {
                continue;
            }
            if track.muted {
                continue;
            }
            if any_solo && !track.solo {
                continue;
            }

            for clip in &track.clips {
                // 仅对可能含音频的素材类型预抽（video/audio），跳过 image/text/subtitle 等
                let asset = match self.project.asset_by_id(&clip.asset_id) {
                    Some(a) => a,
                    None => continue,
                };
                if asset.asset_type != "video" && asset.asset_type != "audio" {
                    continue;
                }
                if clip.speed <= 0.0 {
                    continue;
                }
                let total_src = (clip.timeline_out - clip.timeline_in) * clip.speed;
                if total_src <= 0.0 {
                    continue;
                }

                let cmd = ffmpeg::build_extract_audio_cmd(
                    &asset.path,
                    clip.src_range.start,
                    total_src,
                    sample_rate,
                    channels,
                );
                let buf = match Command::new(&cmd[0])
                    .args(&cmd[1..])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                {
                    Ok(o) if o.status.success() => o
                        .stdout
                        .chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect(),
                    // 抽取失败（静音素材 / 无音频流 / 路径不存在）→ 该片段无音频贡献
                    _ => Vec::new(),
                };
                self.audio_cache.insert(clip.id.clone(), buf);
            }
        }
    }

    // ── 完整导出 ──

    /// 执行完整导出
    ///
    /// 启动 FFmpeg 管道编码器，逐帧渲染并写入 stdin。
    /// 这是一次性同步调用，会阻塞直到导出完成。
    /// 执行完整导出
    ///
    /// 两阶段导出：
    /// 1. 视频帧逐帧渲染，写入临时视频文件（`-an`，无音频流）
    /// 2. 同步逐帧混音（`render_audio_chunk`），累加为 f32le 原始音频
    /// 3. 若工程含音频源，用 FFmpeg 将临时视频与混音音频 mux 为最终文件；
    ///    否则直接将临时视频文件作为最终输出（无音频）。
    pub fn run(&mut self, output_path: &str) -> Result<ExportStats, AppError> {
        let total = self.clock.total_frames();
        let has_audio = self.any_audio_sources();

        // 有音频：导出前一次性预抽所有音源片段的完整段，避免逐帧起 FFmpeg 进程
        if has_audio {
            self.build_audio_cache();
        }

        // 视频输出目标：有音频时先渲染到临时文件，最后与音频 mux；否则直接输出
        let video_out = if has_audio {
            // 必须以 .mp4 结尾，否则 FFmpeg 无法从扩展名推断容器格式而立即退出
            format!("{}.aicut_video.mp4", output_path)
        } else {
            output_path.to_string()
        };
        let audio_tmp = format!("{}.aicut_audio", output_path);

        let encoder_cmd = ffmpeg::build_pipe_encoder_cmd(
            &video_out,
            self.config.width,
            self.config.height,
            self.config.fps,
            &self.config.codec,
            self.config.crf,
            self.config.bitrate_mbps,
        );

        // 收集文字/字幕 drawtext 滤镜
        let mut text_filters: Vec<String> = Vec::new();
        let w = self.config.width;
        let h = self.config.height;
        // 内置字体目录（由 Electron 主进程通过 AICUT_FONTS_DIR 传入），用于导出时
        // 将 drawtext 的 fontfile= 指向随包字体，保证预览/导出字体一致。
        let fontfile_dir = std::env::var("AICUT_FONTS_DIR").unwrap_or_default();
        for track in &self.project.tracks {
            if track.visible == false { continue; }  // 隐藏轨不渲染
            for clip in &track.clips {
                if let Some(t) = &clip.text {
                    if let Some(f) = subtitle::build_text_overlay_filter(t, clip.timeline_in, clip.timeline_out, w, h, &fontfile_dir) {
                        text_filters.push(f);
                    }
                }
                if let Some(s) = &clip.subtitle {
                    text_filters.extend(subtitle::build_subtitle_overlay_filters(s, clip.timeline_in, w, h, &fontfile_dir));
                }
            }
        }

        // 在输出文件参数之前插入 -vf（FFmpeg 中 -vf 需位于 -i 之后、输出之前）
        let mut encoder_cmd = encoder_cmd;
        if !text_filters.is_empty() {
            let vf = text_filters.join(",");
            let output = encoder_cmd.pop().expect("encoder_cmd 不应为空");
            encoder_cmd.push("-vf".to_string());
            encoder_cmd.push(vf);
            encoder_cmd.push(output);
        }

        let mut child = Command::new(&encoder_cmd[0])
            .args(&encoder_cmd[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::Render(format!("编码器启动失败: {}", e)))?;

        let stdin = child.stdin.as_mut()
            .ok_or_else(|| AppError::Render("无法获取编码器 stdin".into()))?;

        let mut rendered = 0u64;
        let mut errors = 0u64;
        let mut audio_data: Vec<f32> = Vec::new();
        let sample_rate = self.config.sample_rate;
        let fps = self.config.fps;

        while !self.is_done() {
            let t = self.current_time();

            match self.render_video_frame(t) {
                Ok(frame) => {
                    // 将帧缩放到画布尺寸后写入
                    let canvas_data = if frame.width == self.config.width && frame.height == self.config.height {
                        frame.data
                    } else {
                        // 简单情况：帧尺寸不匹配画布，用黑场填充
                        // 完整的缩放/合成在 compositor.rs (步骤5) 实现
                        let mut canvas = vec![0u8; self.config.pixel_format.frame_size(self.config.width, self.config.height)];
                        // 简单拷贝（如果帧比画布小，左上角对齐）
                        let copy_w = frame.width.min(self.config.width) as usize;
                        let copy_h = frame.height.min(self.config.height) as usize;
                        let bpp = self.config.pixel_format.bytes_per_pixel();
                        for y in 0..copy_h {
                            let src_offset = y * frame.width as usize * bpp;
                            let dst_offset = y * self.config.width as usize * bpp;
                            let copy_len = copy_w * bpp;
                            if src_offset + copy_len <= frame.data.len() && dst_offset + copy_len <= canvas.len() {
                                canvas[dst_offset..dst_offset + copy_len]
                                    .copy_from_slice(&frame.data[src_offset..src_offset + copy_len]);
                            }
                        }
                        canvas
                    };

                    stdin.write_all(&canvas_data)
                        .map_err(|e| AppError::Render(format!("写入编码器失败: {}", e)))?;
                    rendered += 1;
                }
                Err(e) => {
                    // 单帧失败：写黑场，继续导出
                    let black = vec![0u8; self.config.pixel_format.frame_size(self.config.width, self.config.height)];
                    let _ = stdin.write_all(&black);
                    errors += 1;
                    eprintln!("[export] 帧 {} 渲染失败: {}", self.current_frame(), e);
                }
            }

            // 同步渲染该帧对应的混音音频块并累加
            if has_audio {
                let i = self.current_frame();
                let chunk_samples = audio_chunk_samples(i, sample_rate, fps);
                match self.render_audio_chunk(t, chunk_samples) {
                    Ok(chunk) => audio_data.extend_from_slice(&chunk.samples),
                    Err(e) => eprintln!("[export] 音频块 {} 渲染失败: {}", self.current_frame(), e),
                }
            }

            self.advance()?;
        }

        // 关闭 stdin，等待视频编码完成
        drop(child.stdin.take());
        let vout = child.wait_with_output()
            .map_err(|e| AppError::Render(format!("编码器等待失败: {}", e)))?;

        if !vout.status.success() {
            let stderr = String::from_utf8_lossy(&vout.stderr);
            return Err(AppError::Render(format!(
                "视频编码器退出码 {:?}: {}",
                vout.status.code(),
                stderr.chars().take(500).collect::<String>()
            )));
        }

        // 有音频：mux 临时视频 + 混音音频 → 最终输出
        if has_audio {
            // 写出混音后的 f32le 原始音频
            let mut audio_bytes: Vec<u8> = Vec::with_capacity(audio_data.len() * 4);
            for s in &audio_data {
                audio_bytes.extend_from_slice(&s.to_le_bytes());
            }
            fs::write(&audio_tmp, &audio_bytes)
                .map_err(|e| AppError::Render(format!("写入临时音频失败: {}", e)))?;

            let mux_cmd = build_mux_cmd(
                &video_out,
                &audio_tmp,
                sample_rate,
                self.config.audio_channels,
                output_path,
            );
            let mout = Command::new(&mux_cmd[0])
                .args(&mux_cmd[1..])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| AppError::Render(format!("mux 失败: {}", e)))?;

            if !mout.status.success() {
                let stderr = String::from_utf8_lossy(&mout.stderr);
                return Err(AppError::Render(format!(
                    "mux 退出码 {:?}: {}",
                    mout.status.code(),
                    stderr.chars().take(500).collect::<String>()
                )));
            }

            // 清理临时文件
            let _ = fs::remove_file(&video_out);
            let _ = fs::remove_file(&audio_tmp);
        }

        Ok(ExportStats {
            total_frames: total,
            rendered_frames: rendered,
            error_frames: errors,
            duration_secs: self.timeline.duration(),
        })
    }
}

// ── 音频导出辅助（模块级自由函数） ──

/// 计算第 `frame_index` 帧对应的音频样本数（每声道，无累积漂移）
///
/// 用整数样本边界避免逐帧取整误差：第 i 帧覆盖样本
/// `[round(i·sr/fps), round((i+1)·sr/fps))`，长度即为返回值。
fn audio_chunk_samples(frame_index: u64, sample_rate: u32, fps: u32) -> usize {
    if fps == 0 { return 0; }
    let sr = sample_rate as f64;
    let f = fps as f64;
    let start = (frame_index as f64 * sr / f).round() as usize;
    let end = ((frame_index + 1) as f64 * sr / f).round() as usize;
    end.saturating_sub(start)
}

/// 构建 mux 命令：将无音频的临时视频与 f32le 原始音频合成为最终文件
///
/// 顺序要求：`-f f32le -ar -ac` 等输入选项必须位于对应 `-i` 之前。
fn build_mux_cmd(
    video_in: &str,
    audio_in: &str,
    sample_rate: u32,
    channels: u16,
    output: &str,
) -> Vec<String> {
    vec![
        "ffmpeg".to_string(),
        "-y".to_string(),
        "-i".to_string(), video_in.to_string(),
        "-f".to_string(), "f32le".to_string(),
        "-ar".to_string(), sample_rate.to_string(),
        "-ac".to_string(), channels.to_string(),
        "-i".to_string(), audio_in.to_string(),
        "-c:v".to_string(), "copy".to_string(),
        "-c:a".to_string(), "aac".to_string(),
        "-b:a".to_string(), "192k".to_string(),
        output.to_string(),
    ]
}

// ════════════════════ ExportStats ════════════════════

/// 导出统计信息
#[derive(Debug, Clone)]
pub struct ExportStats {
    /// 总帧数
    pub total_frames: u64,
    /// 成功渲染帧数
    pub rendered_frames: u64,
    /// 失败帧数
    pub error_frames: u64,
    /// 时间线总时长（秒）
    pub duration_secs: f64,
}

impl ExportStats {
    /// 成功率
    pub fn success_rate(&self) -> f64 {
        if self.total_frames == 0 { return 1.0; }
        self.rendered_frames as f64 / self.total_frames as f64
    }
}

// ════════════════════ RenderStrategy 实现 ════════════════════

impl<'a> RenderStrategy for ExportPipeline<'a> {
    fn current_time(&self) -> f64 {
        self.clock.now()
    }

    fn render_video_frame(&mut self, t: f64) -> Result<VideoFrame, AppError> {
        // 查询当前时刻的活跃视频片段
        let mut video_clips: Vec<_> = self.timeline.clips_at(t)
            .into_iter()
            .filter(|c| c.track_type == "video" || c.track_type == "effect")
            .collect();

        if video_clips.is_empty() {
            // 无活跃片段：返回黑场
            return Ok(VideoFrame::black(
                self.config.width, self.config.height,
                self.config.pixel_format, t,
            ));
        }

        // 按 track_order 排序（从底到顶），track_order 小的在下层
        video_clips.sort_by_key(|c| c.track_order);

        // ── 转场检测 ──
        // 对处于转场区的 active clip，记录其淡出 opacity，并收集同轨下一 clip
        let mut fade_out: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
        let mut out_mask: std::collections::HashMap<&str, (f32, f32, f32, f32)> = std::collections::HashMap::new();
        // (入片段, progress, duration, 类型, 方向)
        let mut extra_next: Vec<(&Clip, f64, f64, String, String)> = Vec::new();
        for cr in &video_clips {
            if let Some(tr) = &cr.clip.transition {
                if tr.transition_type != "none" && tr.duration > 0.0 {
                    let trans_start = cr.clip.timeline_out - tr.duration;
                    if t >= trans_start && t < cr.clip.timeline_out {
                        let progress = ((t - trans_start) / tr.duration).max(0.0).min(1.0);
                        let tt = tr.transition_type.clone();
                        let dir = tr.direction.clone();
                        if tt == "wipe" {
                            // wipe：出片段满不透明，仅按方向矩形裁剪（与 transitionUtils.wipeRects 一致）
                            let (out_rect, _in_rect) = wipe_rects(&dir, progress);
                            out_mask.insert(cr.clip.id.as_str(), out_rect);
                        } else {
                            fade_out.insert(cr.clip.id.as_str(), 1.0 - progress);
                        }
                        if let Some(next) = self.find_next_clip(cr.track_id, cr.clip.timeline_out) {
                            extra_next.push((next, progress, tr.duration, tt, dir));
                        }
                    }
                }
            }
        }

        // 入片段「虚拟 timeline_in」映射：key=入片段 id，value=转场窗起点（out_t - dur）。
        // 转场让入片段提前 dur 秒显示，其源时间应从转场窗起点起算而非真实 timeline_in（=out_t），
        // 保证转场窗内（progress 0→1 对应入片段 0→dur*speed）与窗后（从 dur*speed 继续）连续，
        // 避免窗后跳回开头导致导出视频中入片段开头重复。
        let mut incoming_virtual_in: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
        for cr in &video_clips {
            if let Some(tr) = &cr.clip.transition {
                if tr.transition_type != "none" && tr.duration > 0.0 {
                    if let Some(next) = self.find_next_clip(cr.track_id, cr.clip.timeline_out) {
                        incoming_virtual_in.insert(next.id.as_str(), cr.clip.timeline_out - tr.duration);
                    }
                }
            }
        }

        // 1. 构建并行预取请求（active clips 用 timeline 时间；转场后 clip 用转场进度对应源时间）
        let mut prefetch_reqs: Vec<PrefetchRequest> = video_clips.iter().map(|cr| {
            let clip = cr.clip;
            // 若为刚结束转场的入片段，用虚拟 timeline_in（转场窗起点）保证窗后源位置连续衔接。
            let virtual_in = incoming_virtual_in.get(clip.id.as_str()).copied();
            // 统一映射：预览与导出共用同一套 clip_source_time（frozen 不影响取哪帧）
            let src_t = clip_source_time_with_in(t, clip, virtual_in).0;
            let (w, h) = self.clip_decode_size(clip);
            let asset = self.project.asset_by_id(&clip.asset_id);
            let asset_path = asset.map(|a| a.path.as_str()).unwrap_or("").to_string();
            PrefetchRequest { asset_path, source_time: src_t, width: w, height: h }
        }).collect();
        for (next, progress, dur, _tt, _dir) in &extra_next {
            // 转场窗内入片段源时间：用虚拟 timeline_in（转场窗起点 = next.timeline_in - dur）
            // 从窗起点起算，progress·dur 对应入片段已播放的时长。
            // local_t = (next.timeline_in - dur) + progress·dur，progress=0→虚拟起点（off=0→src_range.start），
            // progress=1→next.timeline_in（off=dur→src_range.start + dur·speed），与窗后（虚拟 timeline_in）连续。
            let virtual_in = incoming_virtual_in.get(next.id.as_str()).copied().unwrap_or(next.timeline_in - *dur);
            let local_t = virtual_in + *progress * *dur;
            let src_t = clip_source_time_with_in(local_t, next, Some(virtual_in)).0;
            let (w, h) = self.clip_decode_size(next);
            let asset = self.project.asset_by_id(&next.asset_id);
            let asset_path = asset.map(|a| a.path.as_str()).unwrap_or("").to_string();
            prefetch_reqs.push(PrefetchRequest { asset_path, source_time: src_t, width: w, height: h });
        }

        // 2. 并行预取（std::thread::scope 内部并行调 FFmpeg）
        self.decoder_pool.prefetch(&prefetch_reqs);

        // 3. 逐层解码（active clips）
        let mut layers: Vec<CompositeLayer> = Vec::with_capacity(video_clips.len() + extra_next.len());
        for (cr, req) in video_clips.iter().zip(prefetch_reqs.iter()) {
            let clip = cr.clip;
            let frame = self.decoder_pool
                .decode(&req.asset_path, req.source_time, req.width, req.height)
                .map_err(|e| AppError::Render(format!("解码失败 ({}): {}", clip.asset_id, e)))?;
            let mut tf = clip.transform.clone();
            if let Some(o) = fade_out.get(cr.clip.id.as_str()) { tf.opacity *= o; }
            let reveal = out_mask.get(cr.clip.id.as_str()).copied();
            layers.push(CompositeLayer { frame: frame.to_video_frame(t, &clip.asset_id), transform: tf, reveal_mask: reveal });
        }
        // 额外层：转场后 clip（叠加在顶层，淡入/滑入/wipe 揭示）
        for ((next, progress, _dur, tt, dir), req) in extra_next.iter().zip(prefetch_reqs.iter().skip(video_clips.len())) {
            let frame = self.decoder_pool
                .decode(&req.asset_path, req.source_time, req.width, req.height)
                .map_err(|e| AppError::Render(format!("解码失败 ({}): {}", next.asset_id, e)))?;
            let mut tf = next.transform.clone();
            let reveal = match tt.as_str() {
                "slide" => { tf.x = 1.5 - *progress; tf.opacity *= *progress; None } // 从右侧滑入（简化）
                "wipe" => { tf.opacity *= 1.0; Some(wipe_rects(dir, *progress).1) } // 入片段矩形揭示
                _ => { tf.opacity *= *progress; None } // fade / dissolve 用 opacity 交叉淡化
            };
            layers.push(CompositeLayer { frame: frame.to_video_frame(t, &next.asset_id), transform: tf, reveal_mask: reveal });
        }

        // 4. 多轨道 Over 合成（输出画布尺寸的 RGBA 帧）
        let composed = self.compositor.composite(&layers);

        Ok(composed)
    }

    fn render_audio_chunk(&mut self, t: f64, samples: usize) -> Result<AudioChunk, AppError> {
        let active = self.timeline.clips_at(t);

        // 收集音频源（audio 轨 + video/effect 轨自带音频）及其轨道 id
        let mut sources: Vec<(&Clip, &str)> = Vec::new();
        let mut any_solo = false;
        for cr in &active {
            if cr.track_type == "audio" || cr.track_type == "video" || cr.track_type == "effect" {
                sources.push((cr.clip, cr.track_id));
                if let Some(tr) = self.track_by_id(cr.track_id) {
                    if tr.solo { any_solo = true; }
                }
            }
        }

        // muted / solo 过滤
        sources.retain(|(_clip, tid)| {
            if let Some(tr) = self.track_by_id(tid) {
                if tr.muted { return false; }
                if any_solo && !tr.solo { return false; }
            }
            true
        });

        // —— 音频交叉淡化：构建出片段包络 out_env 与入片段 extra_in ——
        let mut out_env: HashMap<&str, f32> = HashMap::new();
        // (in_clip, track_id, in_env, src_offset_seconds)
        let mut extra_in: Vec<(&Clip, &str, f32, f64)> = Vec::new();
        for (clip, tid) in &sources {
            if let Some(tr) = &clip.transition {
                if tr.transition_type != "none" && tr.duration > 0.0 {
                    let out_t = clip.timeline_out;
                    if t >= out_t - tr.duration && t < out_t {
                        let progress = ((t - (out_t - tr.duration)) / tr.duration).clamp(0.0, 1.0);
                        let out_e = (progress * std::f64::consts::FRAC_PI_2).cos() as f32; // equal-power 出
                        let in_e = (progress * std::f64::consts::FRAC_PI_2).sin() as f32;  // equal-power 入
                        out_env.insert(clip.id.as_str(), out_e);
                        if let Some(next) = self.find_next_clip(tid, out_t) {
                            let src_offset = if next.timeline_in < out_t - 1e-6 {
                                // 重叠：用 clip_source_time 偏移
                                clip_source_time(t, next).0 - next.src_range.start
                            } else {
                                // 相邻：progress * duration * speed
                                progress * tr.duration * next.speed
                            };
                            extra_in.push((next, tid, in_e, src_offset));
                        }
                    }
                }
            }
        }

        let channels = self.config.audio_channels as usize;
        let sample_rate = self.config.sample_rate;
        let mut mixed: Vec<f32> = vec![0.0; samples * channels.max(1)];

        let sr = sample_rate as f64;
        for (clip, tid) in &sources {
            let track = self.track_by_id(tid);
            let track_vol = track.map(|tr| tr.volume).unwrap_or(1.0) as f32;
            let track_pan = track.map(|tr| tr.pan).unwrap_or(0.0) as f32;
            let env = out_env.get(clip.id.as_str()).copied().unwrap_or(1.0) * fade_gain_at(clip, t);
            let gain = clip.volume as f32 * track_vol * env;
            let (l_gain, r_gain) = Self::pan_gains(track_pan);

            // 从整段预抽缓存按时间索引（替代逐帧起 FFmpeg 进程）
            let cached = match self.audio_cache.get(&clip.id) {
                Some(b) if !b.is_empty() => b,
                _ => continue, // 无缓存（静音/无音频/抽取失败）→ 该片段无贡献
            };
            let (src_t, frozen) = clip_source_time(t, clip);
            // 冻结帧：若仍按 src_t 索引音频缓存会重复同一采样产生直流音，故该 clip 贡献静音
            if frozen {
                continue;
            }
            let base_idx = ((src_t - clip.src_range.start) * sr).round() as isize;
            let ch = channels.max(1);
            for i in 0..samples {
                let s_idx = base_idx + i as isize;
                if s_idx < 0 {
                    continue;
                }
                let s_idx = s_idx as usize;
                for c in 0..ch {
                    let out_gain = if ch == 1 {
                        gain
                    } else if c == 0 {
                        gain * l_gain
                    } else {
                        gain * r_gain
                    };
                    let src_val = cached.get(s_idx * ch + c).copied().unwrap_or(0.0);
                    let idx = i * ch + c;
                    if idx < mixed.len() {
                        mixed[idx] += src_val * out_gain;
                    }
                }
            }
        }

        // —— 音频交叉淡化：入片段镜像混音（in_env 包络 + src_offset）——
        for (in_clip, tid, in_e, src_offset) in &extra_in {
            let track = self.track_by_id(tid);
            let track_vol = track.map(|tr| tr.volume).unwrap_or(1.0) as f32;
            let track_pan = track.map(|tr| tr.pan).unwrap_or(0.0) as f32;
            let gain = in_clip.volume as f32 * track_vol * (*in_e) * fade_gain_at(in_clip, t);
            let (l_gain, r_gain) = Self::pan_gains(track_pan);
            let cached = match self.audio_cache.get(&in_clip.id) {
                Some(b) if !b.is_empty() => b,
                _ => continue,
            };
            let base_idx = (*src_offset * sr).round() as isize;
            let ch = channels.max(1);
            for i in 0..samples {
                let s_idx = base_idx + i as isize;
                if s_idx < 0 { continue; }
                let s_idx = s_idx as usize;
                for c in 0..ch {
                    let out_gain = if ch == 1 {
                        gain
                    } else if c == 0 {
                        gain * l_gain
                    } else {
                        gain * r_gain
                    };
                    let src_val = cached.get(s_idx * ch + c).copied().unwrap_or(0.0);
                    let idx = i * ch + c;
                    if idx < mixed.len() {
                        mixed[idx] += src_val * out_gain;
                    }
                }
            }
        }

        // 限幅到 [-1, 1] 防止削波
        for s in mixed.iter_mut() { *s = s.clamp(-1.0, 1.0); }

        Ok(AudioChunk {
            samples: mixed,
            sample_rate,
            channels: self.config.audio_channels,
            timestamp: t,
            frame_count: samples,
        })
    }

    fn advance(&mut self) -> Result<(), AppError> {
        self.clock.advance();
        Ok(())
    }

    fn is_done(&self) -> bool {
        self.clock.is_finished()
    }

    fn current_frame(&self) -> u64 {
        self.clock.frame_index()
    }

    fn total_frames(&self) -> u64 {
        self.clock.total_frames()
    }
}

// ════════════════════ 单元测试 ════════════════════

/// wipe 遮罩矩形（归一化 x0,y0,x1,y1，y-down）：返回 (出片段矩形, 入片段矩形)
/// 与 gui/src/utils/transitionUtils.ts::wipeRects 完全一致。
fn wipe_rects(direction: &str, p: f64) -> ((f32, f32, f32, f32), (f32, f32, f32, f32)) {
    let c = p.max(0.0).min(1.0) as f32;
    match direction {
        "left" => ((0.0, 0.0, 1.0 - c, 1.0), (1.0 - c, 0.0, 1.0, 1.0)),
        "up" => ((0.0, 0.0, 1.0, 1.0 - c), (0.0, 1.0 - c, 1.0, 1.0)),
        "down" => ((0.0, c, 1.0, 1.0), (0.0, 0.0, 1.0, c)),
        _ => ((c, 0.0, 1.0, 1.0), (0.0, 0.0, c, 1.0)), // right
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Asset, CanvasConfig, Clip, Range, TimeRemap, Track, Transform};
    use std::collections::HashMap;

    fn make_clip(id: &str, asset_id: &str, src_start: f64, src_end: f64, tl_in: f64, tl_out: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            src_range: Range { start: src_start, end: src_end },
            timeline_in: tl_in,
            timeline_out: tl_out,
            transform: Transform { x: 0.5, y: 0.5, scale_x: 1.0, scale_y: 1.0, rotation: 0.0, opacity: 1.0 },
            volume: 1.0,
            speed: 1.0,
            effects: Vec::new(),
            masks: Vec::new(),
            filters: Vec::new(),
            keyframes: HashMap::new(),
            speed_curve: Vec::new(),
            time_remap: TimeRemap { reverse: false, freeze: None, curve: Vec::new() },
            text: None,
            subtitle: None,
            transition: None,
            audio_fade_in: 0.0, audio_fade_out: 0.0,
        }
    }

    fn make_project() -> Project {
        Project {
            version: "1.0".to_string(),
            canvas: CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
            assets: vec![
                Asset {
                    id: "a1".to_string(),
                    asset_type: "video".to_string(),
                    path: "test_input.mp4".to_string(),
                    duration: 10.0,
                    width: 1920,
                    height: 1080,
                    codec: "h264".to_string(),
                },
            ],
            tracks: vec![
                Track {
                    id: "t1".to_string(),
                    track_type: "video".to_string(),
                    order: 0,
                    clips: vec![
                        make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0),
                        make_clip("c2", "a1", 5.0, 10.0, 5.0, 10.0),
                    ],
                    ..Default::default()
                },
            ],
        }
    }

    #[test]
    fn test_export_config_default() {
        let config = ExportConfig::default();
        assert_eq!(config.width, 1920);
        assert_eq!(config.height, 1080);
        assert_eq!(config.fps, 30);
        assert_eq!(config.codec, "libx264");
        assert_eq!(config.crf, 18);
    }

    #[test]
    fn test_export_config_from_canvas() {
        let canvas = CanvasConfig { width: 1080, height: 1920, fps: 60, sample_rate: 48000 };
        let config = ExportConfig::from_canvas(&canvas);
        assert_eq!(config.width, 1080);
        assert_eq!(config.height, 1920);
        assert_eq!(config.fps, 60);
    }

    #[test]
    fn test_export_pipeline_creation() {
        let project = make_project();
        let pipeline = ExportPipeline::from_project(&project);
        assert_eq!(pipeline.config().width, 1920);
        assert_eq!(pipeline.config().fps, 30);
        assert_eq!(pipeline.timeline().duration(), 10.0);
        assert_eq!(pipeline.clock().total_frames(), 300); // 10.0 * 30
        assert!(!pipeline.is_done());
        assert_eq!(pipeline.current_frame(), 0);
        assert_eq!(pipeline.total_frames(), 300);
    }

    #[test]
    fn test_export_pipeline_progress() {
        let project = make_project();
        let mut pipeline = ExportPipeline::from_project(&project);
        assert!((pipeline.progress() - 0.0).abs() < 1e-6);

        // 推进 150 帧（一半）
        for _ in 0..150 {
            pipeline.advance().unwrap();
        }
        assert!((pipeline.progress() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_export_pipeline_is_done() {
        let project = make_project();
        let mut pipeline = ExportPipeline::from_project(&project);

        // 推进到最后一帧
        for _ in 0..300 {
            pipeline.advance().unwrap();
        }
        assert!(pipeline.is_done());
        assert!((pipeline.progress() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_build_extract_cmd() {
        let project = make_project();
        let pipeline = ExportPipeline::from_project(&project);

        let clip = make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0);
        let cmd = pipeline.build_extract_cmd(&clip, 2.0);

        assert_eq!(cmd[0], "ffmpeg");
        // 验证包含 -ss 参数
        assert!(cmd.iter().any(|a| a == "-ss"));
        // 验证包含源路径
        assert!(cmd.iter().any(|a| a == "test_input.mp4"));
        // 验证包含 rawvideo 输出
        assert!(cmd.iter().any(|a| a == "rawvideo"));
        // 验证包含 pix_fmt
        assert!(cmd.iter().any(|a| a == "rgba"));
    }

    #[test]
    fn test_build_extract_cmd_with_speed() {
        let project = make_project();
        let pipeline = ExportPipeline::from_project(&project);

        let mut clip = make_clip("c1", "a1", 0.0, 10.0, 0.0, 5.0);
        clip.speed = 2.0; // 2x speed

        let cmd = pipeline.build_extract_cmd(&clip, 1.0);
        // src_t = 0 + (1.0 - 0.0) * 2.0 = 2.0
        let ss_idx = cmd.iter().position(|a| a == "-ss").unwrap();
        let ss_val: f64 = cmd[ss_idx + 1].parse().unwrap();
        assert!((ss_val - 2.0).abs() < 0.01);
    }

    #[test]
    fn test_build_extract_cmd_with_scale() {
        let project = make_project();
        let pipeline = ExportPipeline::from_project(&project);

        let mut clip = make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0);
        clip.transform.scale_x = 0.5;
        clip.transform.scale_y = 0.5;

        let cmd = pipeline.build_extract_cmd(&clip, 0.0);
        // 应包含 960x540 的尺寸
        let s_idx = cmd.iter().position(|a| a == "-s").unwrap();
        assert_eq!(cmd[s_idx + 1], "960x540");
    }

    #[test]
    fn test_render_video_frame_no_clip() {
        let project = make_project();
        let mut pipeline = ExportPipeline::from_project(&project);

        // t=8.0 有片段（c2 在 5-10）
        // 但 t=10.5 在范围外
        // 先跳过到 t=10.5
        pipeline.clock.seek_to_frame(315); // 10.5 * 30 = 315
        let result = pipeline.render_video_frame(10.5);
        assert!(result.is_ok());
        let frame = result.unwrap();
        assert!(frame.is_empty()); // 无活跃片段 → 黑场
        assert_eq!(frame.width, 1920);
        assert_eq!(frame.height, 1080);
    }

    #[test]
    fn test_render_stats_success_rate() {
        let stats = ExportStats {
            total_frames: 100,
            rendered_frames: 95,
            error_frames: 5,
            duration_secs: 3.33,
        };
        assert!((stats.success_rate() - 0.95).abs() < 1e-6);
    }

    #[test]
    fn test_current_time_matches_frame() {
        let project = make_project();
        let pipeline = ExportPipeline::from_project(&project);

        assert!((pipeline.current_time() - 0.0).abs() < 1e-6);

        let mut pipeline = pipeline;
        pipeline.advance().unwrap();
        assert!((pipeline.current_time() - 1.0 / 30.0).abs() < 1e-6);

        pipeline.advance().unwrap();
        assert!((pipeline.current_time() - 2.0 / 30.0).abs() < 1e-6);
    }

    #[test]
    fn test_empty_project() {
        let project = Project {
            version: "1.0".to_string(),
            canvas: CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
            assets: vec![],
            tracks: vec![],
        };
        let pipeline = ExportPipeline::from_project(&project);
        assert_eq!(pipeline.total_frames(), 0);
        assert!(pipeline.is_done()); // 0 帧 → 立即完成
        assert!((pipeline.progress() - 0.0).abs() < 1e-6); // 无帧可渲染 → 0%
    }

    #[test]
    fn test_find_next_clip() {
        let project = Project {
            version: "1.0".to_string(),
            canvas: CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
            assets: vec![Asset {
                id: "a1".to_string(), asset_type: "video".to_string(), path: "test_input.mp4".to_string(),
                duration: 10.0, width: 1920, height: 1080, codec: "h264".to_string(),
            }],
            tracks: vec![Track {
                id: "t1".to_string(), track_type: "video".to_string(), order: 0,
                clips: vec![
                    make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0),
                    make_clip("c2", "a1", 5.0, 10.0, 5.0, 10.0),
                ],
                ..Default::default()
            }],
        };
        let pipeline = ExportPipeline::from_project(&project);
        let next = pipeline.find_next_clip("t1", 5.0);
        assert!(next.is_some());
        assert_eq!(next.unwrap().id, "c2");
        assert!(pipeline.find_next_clip("t1", 10.0).is_none());
    }
}
