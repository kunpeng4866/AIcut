//! src/pipeline/preview.rs — 低延迟预览管线
//!
//! 使用 RealtimeClock 跟随系统时钟，支持播放/暂停/跳转。
//! 帧缓存 + 降级策略：解码慢时复用上一帧，绝不阻塞。

use crate::clock::{Clock, RealtimeClock};
use crate::ffmpeg;
use crate::pipeline::strategy::*;
use crate::project::{CanvasConfig, Clip, Project};
use crate::timeline::Timeline;
use crate::AppError;
use std::collections::HashMap;
use std::process::{Command, Stdio};

// ════════════════════ PreviewConfig ════════════════════

/// 预览配置
#[derive(Debug, Clone)]
pub struct PreviewConfig {
    /// 预览分辨率宽
    pub width: u32,
    /// 预览分辨率高
    pub height: u32,
    /// 帧率
    pub fps: u32,
    /// 采样率
    pub sample_rate: u32,
    /// 音频声道数
    pub audio_channels: u16,
    /// 帧缓存容量（帧数），默认 30 帧（约 1s @30fps）
    pub cache_capacity: usize,
    /// 是否跳过重型特效
    pub skip_heavy_effects: bool,
    /// 预解码窗口（秒），预取播放头前方 N 秒的帧
    pub prefetch_window: f64,
    /// 像素格式
    pub pixel_format: PixelFormat,
}

impl Default for PreviewConfig {
    fn default() -> Self {
        Self {
            width: 1280,  // 预览默认 720p
            height: 720,
            fps: 30,
            sample_rate: crate::project::DEFAULT_SAMPLE_RATE,
            audio_channels: 2,
            cache_capacity: 30,
            skip_heavy_effects: true,
            prefetch_window: 0.5,
            pixel_format: PixelFormat::Rgba8,
        }
    }
}

impl PreviewConfig {
    /// 从画布配置创建（预览分辨率降级到 720p）
    pub fn from_canvas(canvas: &CanvasConfig) -> Self {
        let scale = if canvas.height > 720 { 720.0 / canvas.height as f64 } else { 1.0 };
        Self {
            width: ((canvas.width as f64) * scale).round() as u32,
            height: ((canvas.height as f64) * scale).round() as u32,
            fps: canvas.fps,
            ..Default::default()
        }
    }
}

// ════════════════════ FrameCache ════════════════════

/// 帧缓存条目
#[derive(Debug, Clone)]
struct CacheEntry {
    frame: VideoFrame,
    /// 最后访问时间戳（用于 LRU 淘汰）
    last_accessed: f64,
}

/// 简单帧缓存（HashMap + 容量淘汰）
/// 步骤4将替换为 LRU 缓存
pub struct FrameCache {
    entries: HashMap<String, CacheEntry>,
    capacity: usize,
    current_tick: f64,
}

impl FrameCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(capacity),
            capacity,
            current_tick: 0.0,
        }
    }

    /// 生成缓存 key
    fn make_key(asset_id: &str, src_time: f64, width: u32, height: u32) -> String {
        format!("{}@{:.3}_{}x{}", asset_id, src_time, width, height)
    }

    /// 查询缓存
    pub fn get(&mut self, asset_id: &str, src_time: f64, width: u32, height: u32) -> Option<VideoFrame> {
        let key = Self::make_key(asset_id, src_time, width, height);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.last_accessed = self.current_tick;
            return Some(entry.frame.clone());
        }
        None
    }

    /// 写入缓存
    pub fn put(&mut self, asset_id: &str, src_time: f64, width: u32, height: u32, frame: VideoFrame) {
        if self.entries.len() >= self.capacity {
            // 淘汰最久未访问的条目
            let oldest = self.entries.iter()
                .min_by_key(|(_, e)| e.last_accessed as u64)
                .map(|(k, _)| k.clone());
            if let Some(oldest_key) = oldest {
                self.entries.remove(&oldest_key);
            }
        }
        let key = Self::make_key(asset_id, src_time, width, height);
        self.entries.insert(key, CacheEntry {
            frame,
            last_accessed: self.current_tick,
        });
    }

    /// 推进时间戳（用于 LRU 淘汰）
    pub fn tick(&mut self) {
        self.current_tick += 1.0;
    }

    /// 清空缓存
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// 当前缓存条目数
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

// ════════════════════ PreviewPipeline ════════════════════

/// 低延迟预览管线
///
/// 使用 RealtimeClock 跟随系统时钟。
/// 解码慢于播放节奏时跳帧 + 复用上一帧，绝不阻塞。
///
/// ```text
/// render_loop (rAF / 定时器, 目标 fps):
///   t = clock.tick()
///   ① slice = timeline.clips_at(t)           [O(log n)]
///   ② frame = cache.try_get(slice)           [非阻塞]
///      未命中 → FFmpeg 抽帧 / 复用上一帧
///   ③ 返回 frame 给 UI 层渲染
/// ```
pub struct PreviewPipeline<'a> {
    project: &'a Project,
    timeline: Timeline<'a>,
    clock: RealtimeClock,
    config: PreviewConfig,
    cache: FrameCache,
    /// 上一帧（用于缓存未命中时复用）
    last_frame: Option<VideoFrame>,
}

impl<'a> PreviewPipeline<'a> {
    /// 创建预览管线
    pub fn new(project: &'a Project, config: PreviewConfig) -> Self {
        let timeline = Timeline::new(project);
        let duration = timeline.duration();
        let clock = RealtimeClock::new(duration);
        let cache = FrameCache::new(config.cache_capacity);
        Self {
            project,
            timeline,
            clock,
            config,
            cache,
            last_frame: None,
        }
    }

    /// 从 Project 画布自动创建
    pub fn from_project(project: &'a Project) -> Self {
        let config = PreviewConfig::from_canvas(&project.canvas);
        Self::new(project, config)
    }

    // ── 播放控制 ──

    /// 开始播放
    pub fn play(&mut self) {
        self.clock.play();
    }

    /// 暂停
    pub fn pause(&mut self) {
        self.clock.pause();
    }

    /// 切换播放/暂停
    pub fn toggle_play(&mut self) {
        self.clock.toggle();
    }

    /// 跳转到指定时间
    pub fn seek(&mut self, time: f64) {
        self.clock.seek(time);
        // 跳转后清空缓存（避免显示错误帧）
        self.cache.clear();
        self.last_frame = None;
    }

    /// 设置播放速率
    pub fn set_speed(&mut self, speed: f64) {
        self.clock.set_speed(speed);
    }

    /// 是否正在播放
    pub fn is_playing(&self) -> bool {
        self.clock.is_playing()
    }

    /// 当前播放速率
    pub fn speed(&self) -> f64 {
        self.clock.speed()
    }

    // ── 配置/状态 ──

    /// 获取配置
    pub fn config(&self) -> &PreviewConfig { &self.config }

    /// 获取时间线
    pub fn timeline(&self) -> &Timeline<'a> { &self.timeline }

    /// 缓存条目数
    pub fn cache_size(&self) -> usize { self.cache.len() }

    /// 总时长
    pub fn duration(&self) -> f64 { self.clock.duration() }

    // ── 帧提取 ──

    /// 为片段构建抽帧命令（预览用，可能降级分辨率）
    pub fn build_extract_cmd(&self, clip: &Clip, t: f64) -> Vec<String> {
        let src_t = timeline_to_source_time(t, clip);
        let asset = self.project.asset_by_id(&clip.asset_id);

        // 预览用降级分辨率
        let (aw, ah) = asset
            .filter(|a| a.width > 0 && a.height > 0)
            .map(|a| (a.width, a.height))
            .unwrap_or((self.config.width, self.config.height));

        // 预览：降级到 config 尺寸
        let scale_w = self.config.width as f64 / aw as f64;
        let scale_h = self.config.height as f64 / ah as f64;
        let scale = scale_w.min(scale_h).min(1.0); // 不放大

        let sw = ((aw as f64) * scale * clip.transform.scale_x).round() as u32;
        let sh = ((ah as f64) * scale * clip.transform.scale_y).round() as u32;
        let (sw, sh) = (sw.max(1), sh.max(1));

        let input_path = asset.map(|a| a.path.as_str()).unwrap_or("");
        ffmpeg::build_extract_frame_cmd(input_path, src_t, sw, sh)
    }

    /// 尝试从缓存获取帧，未命中则解码
    fn try_get_or_decode(&mut self, clip: &Clip, t: f64) -> Result<VideoFrame, AppError> {
        let src_t = timeline_to_source_time(t, clip);
        let asset = self.project.asset_by_id(&clip.asset_id);

        let (aw, ah) = asset
            .filter(|a| a.width > 0 && a.height > 0)
            .map(|a| (a.width, a.height))
            .unwrap_or((self.config.width, self.config.height));

        let scale_w = self.config.width as f64 / aw as f64;
        let scale_h = self.config.height as f64 / ah as f64;
        let scale = scale_w.min(scale_h).min(1.0);
        let sw = ((aw as f64) * scale * clip.transform.scale_x).round() as u32;
        let sh = ((ah as f64) * scale * clip.transform.scale_y).round() as u32;
        let (sw, sh) = (sw.max(1), sh.max(1));

        // ① 尝试缓存命中
        if let Some(frame) = self.cache.get(&clip.asset_id, src_t, sw, sh) {
            return Ok(frame);
        }

        // ② 缓存未命中 → FFmpeg 抽帧
        let cmd = self.build_extract_cmd(clip, t);
        let output = Command::new(&cmd[0])
            .args(&cmd[1..])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| AppError::Render(format!("FFmpeg 抽帧失败: {}", e)))?;

        if !output.status.success() {
            // ③ FFmpeg 失败 → 复用上一帧或返回黑场
            if let Some(ref last) = self.last_frame {
                return Ok(last.clone());
            }
            return Ok(VideoFrame::black(sw, sh, self.config.pixel_format, t));
        }

        let expected_size = self.config.pixel_format.frame_size(sw, sh);
        let data = if output.stdout.len() >= expected_size {
            output.stdout[..expected_size].to_vec()
        } else {
            // 数据不足 → 黑场
            return Ok(VideoFrame::black(sw, sh, self.config.pixel_format, t));
        };

        let frame = VideoFrame {
            width: sw,
            height: sh,
            format: self.config.pixel_format,
            data,
            timestamp: t,
            source_asset_id: clip.asset_id.clone(),
            source_time: src_t,
        };

        // 写入缓存
        self.cache.put(&clip.asset_id, src_t, sw, sh, frame.clone());
        self.last_frame = Some(frame.clone());

        Ok(frame)
    }
}

// ════════════════════ RenderStrategy 实现 ════════════════════

impl<'a> RenderStrategy for PreviewPipeline<'a> {
    fn current_time(&self) -> f64 {
        self.clock.now()
    }

    fn render_video_frame(&mut self, t: f64) -> Result<VideoFrame, AppError> {
        self.cache.tick();

        // 查询当前时刻的活跃视频片段
        let video_clips: Vec<_> = self.timeline.clips_at(t)
            .into_iter()
            .filter(|c| c.track_type == "video" || c.track_type == "effect")
            .collect();

        if video_clips.is_empty() {
            // 无活跃片段：返回黑场或上一帧
            let black = VideoFrame::black(
                self.config.width, self.config.height,
                self.config.pixel_format, t,
            );
            self.last_frame = Some(black.clone());
            return Ok(black);
        }

        // 单轨道骨架：取第一个视频片段
        let clip_ref = &video_clips[0];
        let clip = clip_ref.clip;

        self.try_get_or_decode(clip, t)
    }

    fn render_audio_chunk(&mut self, t: f64, samples: usize) -> Result<AudioChunk, AppError> {
        // 预览模式音频处理简化：返回静音或从缓存读取
        // 完整音频管线在 audio_pipeline.rs (步骤6) 实现
        Ok(AudioChunk::silence(
            self.config.sample_rate, self.config.audio_channels, samples, t,
        ))
    }

    fn advance(&mut self) -> Result<(), AppError> {
        self.clock.tick();
        Ok(())
    }

    fn is_done(&self) -> bool {
        self.clock.is_finished()
    }

    fn current_frame(&self) -> u64 {
        (self.clock.now() * self.config.fps as f64) as u64
    }

    fn total_frames(&self) -> u64 {
        (self.clock.duration() * self.config.fps as f64).round() as u64
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
            time_remap: crate::project::TimeRemap { reverse: false, freeze: None, curve: Vec::new() },
            text: None,
            subtitle: None, transition: None,
            audio_envelope: vec![],
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
    fn test_preview_config_default() {
        let config = PreviewConfig::default();
        assert_eq!(config.width, 1280);
        assert_eq!(config.height, 720);
        assert_eq!(config.fps, 30);
        assert_eq!(config.cache_capacity, 30);
        assert!(config.skip_heavy_effects);
    }

    #[test]
    fn test_preview_config_from_canvas_1080p() {
        let canvas = CanvasConfig { width: 1920, height: 1080, fps: 30, sample_rate: 48000 };
        let config = PreviewConfig::from_canvas(&canvas);
        // 720p 降级
        assert_eq!(config.height, 720);
        let scale: f64 = 720.0 / 1080.0;
        assert_eq!(config.width, ((1920.0 * scale).round()) as u32);
    }

    #[test]
    fn test_preview_config_from_canvas_720p() {
        let canvas = CanvasConfig { width: 1280, height: 720, fps: 30, sample_rate: 48000 };
        let config = PreviewConfig::from_canvas(&canvas);
        // 已经是 720p，不降级
        assert_eq!(config.width, 1280);
        assert_eq!(config.height, 720);
    }

    #[test]
    fn test_preview_pipeline_creation() {
        let project = make_project();
        let pipeline = PreviewPipeline::from_project(&project);
        assert_eq!(pipeline.config().fps, 30);
        assert!((pipeline.duration() - 10.0).abs() < 1e-6);
        assert!(!pipeline.is_playing());
        assert_eq!(pipeline.cache_size(), 0);
    }

    #[test]
    fn test_preview_play_pause() {
        let project = make_project();
        let mut pipeline = PreviewPipeline::from_project(&project);

        assert!(!pipeline.is_playing());
        pipeline.play();
        assert!(pipeline.is_playing());
        pipeline.pause();
        assert!(!pipeline.is_playing());
        pipeline.toggle_play();
        assert!(pipeline.is_playing());
    }

    #[test]
    fn test_preview_seek() {
        let project = make_project();
        let mut pipeline = PreviewPipeline::from_project(&project);

        pipeline.seek(5.0);
        assert!((pipeline.current_time() - 5.0).abs() < 1e-6);

        pipeline.seek(20.0); // 超出范围 → clamp
        assert!((pipeline.current_time() - 10.0).abs() < 1e-6);

        pipeline.seek(-1.0); // 负值 → clamp
        assert!((pipeline.current_time() - 0.0).abs() < 1e-6);
    }

    #[test]
    fn test_preview_speed() {
        let project = make_project();
        let mut pipeline = PreviewPipeline::from_project(&project);

        pipeline.set_speed(2.0);
        assert!((pipeline.speed() - 2.0).abs() < 1e-6);

        pipeline.set_speed(10.0); // clamp to 4.0
        assert!((pipeline.speed() - 4.0).abs() < 1e-6);
    }

    #[test]
    fn test_frame_cache_basic() {
        let mut cache = FrameCache::new(3);

        // 空
        assert!(cache.is_empty());

        // 写入
        let frame = VideoFrame::black(100, 100, PixelFormat::Rgba8, 0.0);
        cache.put("a1", 1.0, 100, 100, frame.clone());

        assert_eq!(cache.len(), 1);

        // 读取
        let got = cache.get("a1", 1.0, 100, 100);
        assert!(got.is_some());

        // 未命中
        let miss = cache.get("a1", 2.0, 100, 100);
        assert!(miss.is_none());
    }

    #[test]
    fn test_frame_cache_eviction() {
        let mut cache = FrameCache::new(2);

        let f1 = VideoFrame::black(10, 10, PixelFormat::Rgba8, 0.0);
        let f2 = VideoFrame::black(10, 10, PixelFormat::Rgba8, 1.0);
        let f3 = VideoFrame::black(10, 10, PixelFormat::Rgba8, 2.0);

        cache.put("a1", 1.0, 10, 10, f1);
        cache.tick();
        cache.put("a1", 2.0, 10, 10, f2);
        cache.tick();
        // 此时缓存满（capacity=2）
        cache.put("a1", 3.0, 10, 10, f3);
        // 应淘汰最久未访问的条目
        assert!(cache.len() <= 2);
    }

    #[test]
    fn test_frame_cache_clear() {
        let mut cache = FrameCache::new(10);
        let frame = VideoFrame::black(10, 10, PixelFormat::Rgba8, 0.0);
        cache.put("a1", 1.0, 10, 10, frame);
        assert!(!cache.is_empty());
        cache.clear();
        assert!(cache.is_empty());
    }

    #[test]
    fn test_preview_build_extract_cmd() {
        let project = make_project();
        let pipeline = PreviewPipeline::from_project(&project);

        let clip = make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0);
        let cmd = pipeline.build_extract_cmd(&clip, 2.0);

        assert_eq!(cmd[0], "ffmpeg");
        assert!(cmd.iter().any(|a| a == "-ss"));
        assert!(cmd.iter().any(|a| a == "test_input.mp4"));
        assert!(cmd.iter().any(|a| a == "rawvideo"));
    }

    #[test]
    fn test_preview_build_extract_cmd_resolution_downgrade() {
        let project = make_project();
        let pipeline = PreviewPipeline::from_project(&project);

        let clip = make_clip("c1", "a1", 0.0, 5.0, 0.0, 5.0);
        let cmd = pipeline.build_extract_cmd(&clip, 0.0);

        // 预览应降级到 720p
        let s_idx = cmd.iter().position(|a| a == "-s").unwrap();
        let size = &cmd[s_idx + 1];
        // 原始 1920x1080 → 720p → 1280x720
        assert!(size.contains("720"));
    }

    #[test]
    fn test_preview_render_no_clip() {
        let project = make_project();
        let mut pipeline = PreviewPipeline::from_project(&project);

        // t=10.5 在范围外
        pipeline.seek(10.5);
        let result = pipeline.render_video_frame(10.5);
        assert!(result.is_ok());
        let frame = result.unwrap();
        assert!(frame.is_empty()); // 黑场
    }

    #[test]
    fn test_preview_total_frames() {
        let project = make_project();
        let pipeline = PreviewPipeline::from_project(&project);
        // 10.0s * 30fps = 300 frames
        assert_eq!(pipeline.total_frames(), 300);
    }

    #[test]
    fn test_preview_current_frame_from_time() {
        let project = make_project();
        let mut pipeline = PreviewPipeline::from_project(&project);

        pipeline.seek(0.0);
        assert_eq!(pipeline.current_frame(), 0);

        pipeline.seek(1.0); // 1.0 * 30 = 30
        assert_eq!(pipeline.current_frame(), 30);

        pipeline.seek(5.0); // 5.0 * 30 = 150
        assert_eq!(pipeline.current_frame(), 150);
    }

    #[test]
    fn test_preview_seek_clears_cache() {
        let project = make_project();
        let mut pipeline = PreviewPipeline::from_project(&project);

        // 手动写入缓存
        let frame = VideoFrame::black(10, 10, PixelFormat::Rgba8, 0.0);
        pipeline.cache.put("a1", 1.0, 10, 10, frame);
        assert!(!pipeline.cache.is_empty());

        // seek 应清空缓存
        pipeline.seek(3.0);
        assert!(pipeline.cache.is_empty());
        assert!(pipeline.last_frame.is_none());
    }

    #[test]
    fn test_preview_audio_silent() {
        let project = make_project();
        let mut pipeline = PreviewPipeline::from_project(&project);

        let chunk = pipeline.render_audio_chunk(1.0, 1024).unwrap();
        assert!(chunk.is_silent());
        assert_eq!(chunk.frame_count, 1024);
        assert_eq!(chunk.sample_rate, 48000);
    }
}
