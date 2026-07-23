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
use std::io::Write;
use std::process::{Command, Stdio};

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
}

impl<'a> ExportPipeline<'a> {
    /// 创建导出管线
    pub fn new(project: &'a Project, config: ExportConfig) -> Self {
        let timeline = Timeline::new(project);
        let duration = timeline.duration();
        let clock = SteppedClock::new(config.fps, duration);
        let decoder_pool = DecoderPool::new(32).with_accurate_seek(config.accurate_seek);
        let compositor = Compositor::new(config.width, config.height);
        Self { project, timeline, clock, config, decoder_pool, compositor }
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

    // ── 完整导出 ──

    /// 执行完整导出
    ///
    /// 启动 FFmpeg 管道编码器，逐帧渲染并写入 stdin。
    /// 这是一次性同步调用，会阻塞直到导出完成。
    pub fn run(&mut self, output_path: &str) -> Result<ExportStats, AppError> {
        let encoder_cmd = ffmpeg::build_pipe_encoder_cmd(
            output_path,
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
        for track in &self.project.tracks {
            if track.visible == false { continue; }  // 隐藏轨不渲染
            for clip in &track.clips {
                if let Some(t) = &clip.text {
                    if let Some(f) = subtitle::build_text_overlay_filter(t, clip.timeline_in, clip.timeline_out, w, h) {
                        text_filters.push(f);
                    }
                }
                if let Some(s) = &clip.subtitle {
                    text_filters.extend(subtitle::build_subtitle_overlay_filters(s, clip.timeline_in, w, h));
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

        let total = self.clock.total_frames();
        let mut rendered = 0u64;
        let mut errors = 0u64;

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

            self.advance()?;
        }

        // 关闭 stdin，等待编码器完成
        drop(child.stdin.take());
        let output = child.wait_with_output()
            .map_err(|e| AppError::Render(format!("编码器等待失败: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Render(format!(
                "编码器退出码 {:?}: {}",
                output.status.code(),
                stderr.chars().take(500).collect::<String>()
            )));
        }

        Ok(ExportStats {
            total_frames: total,
            rendered_frames: rendered,
            error_frames: errors,
            duration_secs: self.timeline.duration(),
        })
    }
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

        // 1. 构建并行预取请求（用素材原始分辨率解码，缩放交给 compositor）
        let prefetch_reqs: Vec<PrefetchRequest> = video_clips.iter()
            .map(|cr| {
                let clip = cr.clip;
                let src_t = timeline_to_source_time(t, clip);
                let (w, h) = self.clip_decode_size(clip);
                let asset = self.project.asset_by_id(&clip.asset_id);
                let asset_path = asset.map(|a| a.path.as_str()).unwrap_or("").to_string();
                PrefetchRequest {
                    asset_path,
                    source_time: src_t,
                    width: w,
                    height: h,
                }
            })
            .collect();

        // 2. 并行预取（std::thread::scope 内部并行调 FFmpeg）
        self.decoder_pool.prefetch(&prefetch_reqs);

        // 3. 逐层解码（命中缓存）并构建合成层
        let mut layers: Vec<CompositeLayer> = Vec::with_capacity(video_clips.len());
        for (cr, req) in video_clips.iter().zip(prefetch_reqs.iter()) {
            let clip = cr.clip;
            let frame = self.decoder_pool
                .decode(&req.asset_path, req.source_time, req.width, req.height)
                .map_err(|e| AppError::Render(format!("解码失败 ({}): {}", clip.asset_id, e)))?;

            layers.push(CompositeLayer {
                frame: frame.to_video_frame(t, &clip.asset_id),
                transform: clip.transform.clone(),
            });
        }

        // 4. 多轨道 Over 合成（输出画布尺寸的 RGBA 帧）
        let composed = self.compositor.composite(&layers);

        Ok(composed)
    }

    fn render_audio_chunk(&mut self, t: f64, samples: usize) -> Result<AudioChunk, AppError> {
        // 查询当前时刻的活跃音频片段
        let active_clips = self.timeline.clips_at(t);

        // 优先音频片段，其次视频片段（视频自带音频）
        let clip = active_clips
            .iter()
            .find(|c| c.track_type == "audio")
            .or_else(|| active_clips.iter().find(|c| c.track_type == "video" || c.track_type == "effect"))
            .map(|cr| cr.clip);

        let clip = match clip {
            Some(c) => c,
            None => return Ok(AudioChunk::silence(
                self.config.sample_rate, self.config.audio_channels, samples, t,
            )),
        };

        let src_t = timeline_to_source_time(t, clip);
        let duration = samples as f64 / self.config.sample_rate as f64;

        let asset = self.project.asset_by_id(&clip.asset_id);
        let input_path = asset.map(|a| a.path.as_str()).unwrap_or("");

        let cmd = ffmpeg::build_extract_audio_cmd(
            input_path, src_t, duration,
            self.config.sample_rate, self.config.audio_channels,
        );

        let output = Command::new(&cmd[0])
            .args(&cmd[1..])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| AppError::Render(format!("FFmpeg 音频抽取失败: {}", e)))?;

        if !output.status.success() {
            return Ok(AudioChunk::silence(
                self.config.sample_rate, self.config.audio_channels, samples, t,
            ));
        }

        // f32le → f32 样本
        let bytes = output.stdout;
        let f32_samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| {
                let arr: [u8; 4] = [chunk[0], chunk[1], chunk[2], chunk[3]];
                f32::from_le_bytes(arr)
            })
            .collect();

        // 应用音量
        let volume = clip.volume as f32;
        let adjusted: Vec<f32> = f32_samples.iter().map(|&s| s * volume).collect();

        Ok(AudioChunk {
            samples: adjusted,
            sample_rate: self.config.sample_rate,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Asset, CanvasConfig, Clip, Range, Track, Transform};
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
            text: None,
            subtitle: None,
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
}
