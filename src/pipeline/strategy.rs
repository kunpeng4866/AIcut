//! src/pipeline/strategy.rs — 渲染策略 trait + 核心数据类型
//!
//! RenderStrategy 统一导出/预览两条管线的接口。
//! VideoFrame / AudioChunk 是管线的输入输出数据结构。

use crate::AppError;

// ════════════════════ 像素格式 ════════════════════

/// 像素格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    /// RGBA 8-bit，每像素 4 字节
    Rgba8,
    /// YUV420P，每像素 1.5 字节
    Yuv420p,
}

impl PixelFormat {
    /// 每像素字节数
    pub fn bytes_per_pixel(&self) -> usize {
        match self {
            PixelFormat::Rgba8 => 4,
            PixelFormat::Yuv420p => 1, // 近似（实际 1.5，但 YUV420P 平面存储需特殊处理）
        }
    }

    /// 计算 w×h 帧的字节数
    pub fn frame_size(&self, width: u32, height: u32) -> usize {
        match self {
            PixelFormat::Rgba8 => (width as usize) * (height as usize) * 4,
            PixelFormat::Yuv420p => {
                let y = (width as usize) * (height as usize);
                let u = (width as usize / 2) * (height as usize / 2);
                let v = u;
                y + u + v
            }
        }
    }

    /// FFmpeg pix_fmt 名称
    pub fn ffmpeg_name(&self) -> &'static str {
        match self {
            PixelFormat::Rgba8 => "rgba",
            PixelFormat::Yuv420p => "yuv420p",
        }
    }
}

// ════════════════════ VideoFrame ════════════════════

/// 解码后的视频帧
#[derive(Debug, Clone)]
pub struct VideoFrame {
    /// 帧宽度（像素）
    pub width: u32,
    /// 帧高度（像素）
    pub height: u32,
    /// 像素格式
    pub format: PixelFormat,
    /// 原始像素数据
    pub data: Vec<u8>,
    /// 时间戳（秒，时间线时间）
    pub timestamp: f64,
    /// 源素材 ID（无片段时为空）
    pub source_asset_id: String,
    /// 源素材中的时间（秒）
    pub source_time: f64,
}

impl VideoFrame {
    /// 创建黑色帧（全零数据）
    pub fn black(width: u32, height: u32, format: PixelFormat, timestamp: f64) -> Self {
        let size = format.frame_size(width, height);
        Self {
            width,
            height,
            format,
            data: vec![0u8; size],
            timestamp,
            source_asset_id: String::new(),
            source_time: 0.0,
        }
    }

    /// 创建透明帧（RGBA 全零 alpha=0）
    pub fn transparent(width: u32, height: u32, timestamp: f64) -> Self {
        Self::black(width, height, PixelFormat::Rgba8, timestamp)
    }

    /// 帧数据字节数
    pub fn data_size(&self) -> usize {
        self.data.len()
    }

    /// 是否为空帧（无源素材）
    pub fn is_empty(&self) -> bool {
        self.source_asset_id.is_empty()
    }
}

// ════════════════════ AudioChunk ════════════════════

/// 解码后的音频块
#[derive(Debug, Clone)]
pub struct AudioChunk {
    /// 交错音频样本（f32，[-1.0, 1.0]）
    pub samples: Vec<f32>,
    /// 采样率
    pub sample_rate: u32,
    /// 声道数
    pub channels: u16,
    /// 块起始时间戳（秒，时间线时间）
    pub timestamp: f64,
    /// 样本数（每声道）
    pub frame_count: usize,
}

impl AudioChunk {
    /// 创建静音块
    pub fn silence(sample_rate: u32, channels: u16, frame_count: usize, timestamp: f64) -> Self {
        Self {
            samples: vec![0.0; frame_count * channels as usize],
            sample_rate,
            channels,
            timestamp,
            frame_count,
        }
    }

    /// 块时长（秒）
    pub fn duration(&self) -> f64 {
        self.frame_count as f64 / self.sample_rate as f64
    }

    /// 总样本数（所有声道）
    pub fn total_samples(&self) -> usize {
        self.samples.len()
    }

    /// 是否为静音
    pub fn is_silent(&self) -> bool {
        self.samples.iter().all(|&s| s == 0.0)
    }
}

// ════════════════════ RenderStrategy Trait ════════════════════

/// 渲染策略 trait：统一导出/预览两条管线
///
/// 生命周期：
/// ```text
/// loop {
///     let t = strategy.current_time();
///     let frame = strategy.render_video_frame(t)?;
///     let audio = strategy.render_audio_chunk(t, block_size)?;
///     // ... 使用 frame / audio ...
///     strategy.advance()?;
///     if strategy.is_done() { break; }
/// }
/// ```
pub trait RenderStrategy {
    /// 当前时间（秒）
    fn current_time(&self) -> f64;

    /// 渲染一帧视频画面
    ///
    /// - t: 时间线时间（秒）
    /// - 返回: 该时刻的合成视频帧（无片段时返回黑场）
    fn render_video_frame(&mut self, t: f64) -> Result<VideoFrame, AppError>;

    /// 渲染一段音频
    ///
    /// - t: 时间线时间（秒）
    /// - samples: 请求的样本数（每声道）
    /// - 返回: 该时段的混音音频块
    fn render_audio_chunk(&mut self, t: f64, samples: usize) -> Result<AudioChunk, AppError>;

    /// 推进时钟到下一帧
    fn advance(&mut self) -> Result<(), AppError>;

    /// 是否已结束
    fn is_done(&self) -> bool;

    /// 当前帧号
    fn current_frame(&self) -> u64;

    /// 总帧数
    fn total_frames(&self) -> u64;

    /// 渲染进度（0.0 ~ 1.0）
    fn progress(&self) -> f64 {
        if self.total_frames() == 0 {
            return 0.0;
        }
        (self.current_frame() as f64 / self.total_frames() as f64).min(1.0)
    }
}

// ════════════════════ 源时间计算 ════════════════════

/// 从时间线时间计算源素材时间
///
/// 转换公式：`src_t = clip.src_range.start + (t - clip.timeline_in) * clip.speed`
///
/// - t: 时间线时间
/// - clip: 片段引用
/// - 返回: 源素材中的时间（秒）
pub fn timeline_to_source_time(t: f64, clip: &crate::project::Clip) -> f64 {
    let offset = t - clip.timeline_in;
    clip.src_range.start + offset * clip.speed
}

/// 计算片段在时间线上的活跃时间范围
pub fn clip_active_range(clip: &crate::project::Clip) -> (f64, f64) {
    (clip.timeline_in, clip.timeline_out)
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Clip, Range, Transform};
    use std::collections::HashMap;

    fn make_clip(id: &str, src_start: f64, src_end: f64, tl_in: f64, tl_out: f64, speed: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: "a1".to_string(),
            src_range: Range { start: src_start, end: src_end },
            timeline_in: tl_in,
            timeline_out: tl_out,
            transform: Transform { x: 0.5, y: 0.5, scale_x: 1.0, scale_y: 1.0, rotation: 0.0, opacity: 1.0 },
            volume: 1.0,
            speed,
            effects: Vec::new(),
            masks: Vec::new(),
            filters: Vec::new(),
            keyframes: HashMap::new(),
            speed_curve: Vec::new(),
        }
    }

    #[test]
    fn test_pixel_format_rgba8_size() {
        assert_eq!(PixelFormat::Rgba8.frame_size(1920, 1080), 1920 * 1080 * 4);
        assert_eq!(PixelFormat::Rgba8.bytes_per_pixel(), 4);
    }

    #[test]
    fn test_pixel_format_yuv420p_size() {
        // YUV420P: Y(w*h) + U(w/2*h/2) + V(w/2*h/2)
        let size = PixelFormat::Yuv420p.frame_size(1920, 1080);
        assert_eq!(size, 1920 * 1080 + 960 * 540 + 960 * 540);
    }

    #[test]
    fn test_pixel_format_ffmpeg_name() {
        assert_eq!(PixelFormat::Rgba8.ffmpeg_name(), "rgba");
        assert_eq!(PixelFormat::Yuv420p.ffmpeg_name(), "yuv420p");
    }

    #[test]
    fn test_video_frame_black() {
        let frame = VideoFrame::black(1920, 1080, PixelFormat::Rgba8, 1.5);
        assert_eq!(frame.width, 1920);
        assert_eq!(frame.height, 1080);
        assert_eq!(frame.data.len(), 1920 * 1080 * 4);
        assert!(frame.data.iter().all(|&b| b == 0));
        assert!(frame.is_empty());
        assert_eq!(frame.timestamp, 1.5);
    }

    #[test]
    fn test_video_frame_transparent() {
        let frame = VideoFrame::transparent(100, 100, 2.0);
        assert_eq!(frame.format, PixelFormat::Rgba8);
        assert_eq!(frame.data.len(), 100 * 100 * 4);
        assert!(frame.is_empty());
    }

    #[test]
    fn test_audio_chunk_silence() {
        let chunk = AudioChunk::silence(48000, 2, 1024, 0.0);
        assert_eq!(chunk.sample_rate, 48000);
        assert_eq!(chunk.channels, 2);
        assert_eq!(chunk.frame_count, 1024);
        assert_eq!(chunk.samples.len(), 1024 * 2);
        assert!(chunk.is_silent());
        assert!((chunk.duration() - 1024.0 / 48000.0).abs() < 1e-6);
    }

    #[test]
    fn test_audio_chunk_duration() {
        let chunk = AudioChunk::silence(48000, 2, 48000, 0.0);
        assert!((chunk.duration() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_timeline_to_source_time_normal() {
        // clip: src [10, 20), timeline [5, 15), speed=1.0
        let clip = make_clip("c1", 10.0, 20.0, 5.0, 15.0, 1.0);
        // t=5.0 → src_t = 10 + (5-5)*1 = 10
        assert!((timeline_to_source_time(5.0, &clip) - 10.0).abs() < 1e-6);
        // t=10.0 → src_t = 10 + (10-5)*1 = 15
        assert!((timeline_to_source_time(10.0, &clip) - 15.0).abs() < 1e-6);
        // t=15.0 → src_t = 10 + (15-5)*1 = 20
        assert!((timeline_to_source_time(15.0, &clip) - 20.0).abs() < 1e-6);
    }

    #[test]
    fn test_timeline_to_source_time_speed_2x() {
        // clip: src [0, 5), timeline [0, 2.5), speed=2.0
        let clip = make_clip("c1", 0.0, 5.0, 0.0, 2.5, 2.0);
        // t=0 → src_t = 0 + (0-0)*2 = 0
        assert!((timeline_to_source_time(0.0, &clip) - 0.0).abs() < 1e-6);
        // t=1.0 → src_t = 0 + (1-0)*2 = 2
        assert!((timeline_to_source_time(1.0, &clip) - 2.0).abs() < 1e-6);
        // t=2.5 → src_t = 0 + (2.5-0)*2 = 5
        assert!((timeline_to_source_time(2.5, &clip) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn test_timeline_to_source_time_half_speed() {
        // clip: src [0, 5), timeline [0, 10), speed=0.5
        let clip = make_clip("c1", 0.0, 5.0, 0.0, 10.0, 0.5);
        // t=0 → src_t = 0
        // t=5 → src_t = 0 + 5*0.5 = 2.5
        // t=10 → src_t = 0 + 10*0.5 = 5
        assert!((timeline_to_source_time(0.0, &clip) - 0.0).abs() < 1e-6);
        assert!((timeline_to_source_time(5.0, &clip) - 2.5).abs() < 1e-6);
        assert!((timeline_to_source_time(10.0, &clip) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn test_clip_active_range() {
        let clip = make_clip("c1", 0.0, 5.0, 3.0, 8.0, 1.0);
        let (start, end) = clip_active_range(&clip);
        assert!((start - 3.0).abs() < 1e-6);
        assert!((end - 8.0).abs() < 1e-6);
    }

    #[test]
    fn test_render_strategy_progress() {
        // 测试 progress 默认实现
        struct MockStrategy { frame: u64, total: u64 }
        impl RenderStrategy for MockStrategy {
            fn current_time(&self) -> f64 { self.frame as f64 / 30.0 }
            fn render_video_frame(&mut self, _t: f64) -> Result<VideoFrame, AppError> {
                Ok(VideoFrame::black(1, 1, PixelFormat::Rgba8, _t))
            }
            fn render_audio_chunk(&mut self, _t: f64, _s: usize) -> Result<AudioChunk, AppError> {
                Ok(AudioChunk::silence(48000, 2, _s, _t))
            }
            fn advance(&mut self) -> Result<(), AppError> { self.frame += 1; Ok(()) }
            fn is_done(&self) -> bool { self.frame >= self.total }
            fn current_frame(&self) -> u64 { self.frame }
            fn total_frames(&self) -> u64 { self.total }
        }

        let mut s = MockStrategy { frame: 0, total: 100 };
        assert!((s.progress() - 0.0).abs() < 1e-6);
        s.frame = 50;
        assert!((s.progress() - 0.5).abs() < 1e-6);
        s.frame = 100;
        assert!((s.progress() - 1.0).abs() < 1e-6);
    }
}
