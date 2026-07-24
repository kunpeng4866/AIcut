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
    // 统一走 clip_source_time，保证预览（前端）与导出共用同一映射
    clip_source_time(t, clip).0
}

/// 从时间线时间计算片段源时间 + 是否处于冻结帧
///
/// 统一映射（预览与导出共用）：
/// ```text
/// dur   = clip.timeline_out - clip.timeline_in
/// off   = t - clip.timeline_in                         // 片段内时间线偏移，预期 [0, dur]
/// remap = clip.time_remap
/// if remap.curve 非空:
///     src_dur = clip.src_range.end - clip.src_range.start
///     src_t = speed_integral(curve, off, clip.src_range.start, dur, src_dur)  // 速度曲线积分（按整段归一化）
///     frozen = false
/// else:
///     frozen = false
///     if remap.freeze 存在 且 off ∈ [freeze.start, freeze.start+freeze.duration):
///         src_t = freeze.source_time
///         frozen = true
///     if not frozen:
///         if remap.reverse:
///             src_t = clip.src_range.start + (dur - off) * clip.speed   // 从 [start+span] 倒走到 start
///         else:
///             src_t = clip.src_range.start + off * clip.speed
/// 曲线模式：src_t = speed_integral(curve, off, start, dur, src_dur)（按整段归一化，绝不越界定格）
/// clamp src_t 到 [clip.src_range.start, clip.src_range.end]
/// return (src_t, frozen)
/// ```
///
/// - t: 时间线时间（秒）
/// - clip: 片段引用
/// - 返回: (源素材时间, 是否冻结帧)
pub fn clip_source_time(t: f64, clip: &crate::project::Clip) -> (f64, bool) {
    let dur = clip.timeline_out - clip.timeline_in;
    let off = t - clip.timeline_in;
    let remap = &clip.time_remap;

    let src_dur = clip.src_range.end - clip.src_range.start;
    let (src_t, frozen) = if !remap.curve.is_empty() {
        // curve 权威映射：速度曲线积分（按整段时长归一化，src 单调且恰好消耗整段素材）
        (speed_integral(&remap.curve, off, clip.src_range.start, dur, src_dur), false)
    } else {
        let mut frozen = false;
        let src_t = if let Some(freeze) = &remap.freeze {
            if off >= freeze.start && off < freeze.start + freeze.duration {
                frozen = true;
                freeze.source_time
            } else {
                base_source_time(clip, dur, off, remap.reverse)
            }
        } else {
            base_source_time(clip, dur, off, remap.reverse)
        };
        (src_t, frozen)
    };

    // clamp 到源区间
    let src_t = src_t.clamp(clip.src_range.start, clip.src_range.end);
    (src_t, frozen)
}

/// 线性（正/倒放）基础源时间计算
fn base_source_time(clip: &crate::project::Clip, dur: f64, off: f64, reverse: bool) -> f64 {
    if reverse {
        clip.src_range.start + (dur - off) * clip.speed
    } else {
        clip.src_range.start + off * clip.speed
    }
}

/// 速度曲线原始积分（不含归一化）：返回 ∫₀^off speed(τ) dτ 的梯形积分值（相对 src_start=0）。
/// `speed(τ)` 按 play 分段线性插值。与前端 `rawSpeedIntegral` 逐字节一致。
fn raw_speed_integral(curve: &[crate::project::SpeedPoint], off: f64) -> f64 {
    if curve.is_empty() {
        return 0.0;
    }
    let mut pts: Vec<&crate::project::SpeedPoint> = curve.iter().collect();
    pts.sort_by(|a, b| a.play.partial_cmp(&b.play).unwrap_or(std::cmp::Ordering::Equal));

    let mut acc = 0.0f64;

    let first = pts[0];
    if off <= first.play {
        return (off.max(0.0)) * first.speed;
    }
    acc += first.play * first.speed;

    let last = pts.len() - 1;
    for i in 1..=last {
        let a = pts[i - 1];
        let b = pts[i];
        let span = b.play - a.play;
        if off <= b.play {
            let frac = if span.abs() < 1e-12 { 0.0 } else { (off - a.play) / span };
            let speed_off = a.speed + (b.speed - a.speed) * frac;
            acc += (a.speed + speed_off) / 2.0 * (off - a.play);
            return acc;
        } else if span.abs() >= 1e-12 {
            acc += (a.speed + b.speed) / 2.0 * span;
        }
    }
    let last_pt = pts[last];
    if off > last_pt.play {
        acc += (off - last_pt.play) * last_pt.speed;
    }
    acc
}

/// 速度曲线积分：把"速度曲线"积分为源素材时间，并按整段时间线时长归一化，
/// 保证 [0,dur] 恰好消耗整段素材 [src_start, src_start+src_dur]——
/// 任意曲线形状（含局部 speed>1）都不会越界被 clamp 定格，源素材始终播完。
///
/// 数学：`srcT(off) = src_start + rawIntegral(off) * (src_dur / rawIntegral(dur))`
/// 其中 `rawIntegral` 是 speed 按 play 分段线性的梯形积分。
///
/// 性质：
/// - 曲线为常数 speed=c 时：rawIntegral(dur)=c*dur，K=src_dur/(c*dur)，退化为匀速，
///   等效整体速度 = src_dur/dur（与标量 speed 无关，整体速度由时间线长决定）。
/// - 曲线为变速形状时：各段按相对比例分配速度，但整体精确消耗 src_dur，绝不定格。
/// - 全 0 速度（冻结整段）→ 停在 src_start。
pub fn speed_integral(curve: &[crate::project::SpeedPoint], off: f64, src_start: f64, dur: f64, src_dur: f64) -> f64 {
    if curve.is_empty() {
        return src_start;
    }
    let total_raw = raw_speed_integral(curve, dur);
    if total_raw.abs() < 1e-9 {
        // 全 0 速度 → 冻结在起点
        return src_start;
    }
    let k = src_dur / total_raw;
    src_start + raw_speed_integral(curve, off) * k
}

/// 计算片段在时间线上的活跃时间范围
pub fn clip_active_range(clip: &crate::project::Clip) -> (f64, f64) {
    (clip.timeline_in, clip.timeline_out)
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Clip, FreezeConfig, Range, SpeedPoint, TimeRemap, Transform};
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
            time_remap: TimeRemap { reverse: false, freeze: None, curve: Vec::new() },
            text: None,
            subtitle: None, transition: None,
        }
    }

    /// 构造带 time_remap 的片段（供 clip_source_time 测试）
    fn make_clip_with_remap(
        id: &str, src_start: f64, src_end: f64, tl_in: f64, tl_out: f64, speed: f64,
        remap: TimeRemap,
    ) -> Clip {
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
            time_remap: remap,
            text: None,
            subtitle: None, transition: None,
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

    // ── clip_source_time 统一映射测试 ──

    #[test]
    fn test_clip_source_time_forward_linear() {
        // src [10,20), timeline [0,4), dur=4, speed=2, off=1 → 10 + 1*2 = 12
        let remap = TimeRemap { reverse: false, freeze: None, curve: Vec::new() };
        let clip = make_clip_with_remap("c1", 10.0, 20.0, 0.0, 4.0, 2.0, remap);
        let (src_t, frozen) = clip_source_time(1.0, &clip);
        assert!((src_t - 12.0).abs() < 1e-9);
        assert!(!frozen);
    }

    #[test]
    fn test_clip_source_time_reverse() {
        // reverse, speed=1, dur=4, off=1 → src_start + (4-1)*1 = src_start+3 = 13
        let remap = TimeRemap { reverse: true, freeze: None, curve: Vec::new() };
        let clip = make_clip_with_remap("c1", 10.0, 20.0, 0.0, 4.0, 1.0, remap);
        let (src_t, frozen) = clip_source_time(1.0, &clip);
        assert!((src_t - 13.0).abs() < 1e-9);
        assert!(!frozen);
    }

    #[test]
    fn test_clip_source_time_freeze() {
        let remap = TimeRemap {
            reverse: false,
            freeze: Some(FreezeConfig { start: 0.0, source_time: 5.0, duration: 2.0 }),
            curve: Vec::new(),
        };
        // src_range [0,20) 包含 source_time=5.0，避免被 clamp
        let clip = make_clip_with_remap("c1", 0.0, 20.0, 0.0, 4.0, 1.0, remap);
        // off=1 ∈ [0,2) → src_t = 5.0, frozen
        let (src_t, frozen) = clip_source_time(1.0, &clip);
        assert!((src_t - 5.0).abs() < 1e-9);
        assert!(frozen);
        // off=3 ∉ [0,2) → 正常正向 0 + 3*1 = 3, not frozen
        let (src_t2, frozen2) = clip_source_time(3.0, &clip);
        assert!((src_t2 - 3.0).abs() < 1e-9);
        assert!(!frozen2);
    }

    #[test]
    fn test_clip_source_time_curve_interp() {
        // 速度曲线：play=0→speed1, play=2→speed2；src[0,10), dur=4, src_dur=10
        // 归一化：total_raw = ∫₀^4 = (1+2)/2*2 + (4-2)*2 = 3+4 = 7；K = 10/7
        let remap = TimeRemap {
            reverse: false,
            freeze: None,
            curve: vec![
                SpeedPoint { play: 0.0, speed: 1.0 },
                SpeedPoint { play: 2.0, speed: 2.0 },
            ],
        };
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 4.0, 1.0, remap);
        // off=0 → src = 0
        let (s0, _) = clip_source_time(0.0, &clip);
        assert!((s0 - 0.0).abs() < 1e-9);
        // off=1 → raw=1.25，归一化 src = 1.25 * 10/7 ≈ 1.7857
        let (src_t, frozen) = clip_source_time(1.0, &clip);
        assert!((src_t - 1.25 * 10.0 / 7.0).abs() < 1e-9);
        assert!(!frozen);
        // off=3 → raw=5，归一化 src = 5 * 10/7 ≈ 7.1429（不再越界定格）
        let (s3, _) = clip_source_time(3.0, &clip);
        assert!((s3 - 5.0 * 10.0 / 7.0).abs() < 1e-9);
        // off=4(末尾) → raw=7，归一化 src = 7*10/7 = 10 = src_end（整段素材恰好播完）
        let (s4, _) = clip_source_time(4.0, &clip);
        assert!((s4 - 10.0).abs() < 1e-9);
    }

    #[test]
    fn test_clip_source_time_curve_overrides_reverse_freeze() {
        // curve 非空时应忽略 reverse/freeze
        // 速度曲线：play=0→speed1, play=4→speed3；src[0,10), dur=4, src_dur=10
        // 归一化：total_raw = (1+3)/2*4 = 8；K = 10/8 = 1.25
        let remap = TimeRemap {
            reverse: true,
            freeze: Some(FreezeConfig { start: 0.0, source_time: 99.0, duration: 100.0 }),
            curve: vec![
                SpeedPoint { play: 0.0, speed: 1.0 },
                SpeedPoint { play: 4.0, speed: 3.0 },
            ],
        };
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 4.0, 1.0, remap);
        let (src_t, frozen) = clip_source_time(2.0, &clip);
        // 段[0,4] speed 1→3，off=2 处 raw=3，归一化 src = 3 * 1.25 = 3.75（忽略 freeze）
        assert!((src_t - 3.75).abs() < 1e-9);
        assert!(!frozen);
    }

    #[test]
    fn test_clip_source_time_clamp() {
        // 倒放 off=4 (末尾) → 10 + 0 = 10；但令 src_range.end 较小也无妨；这里测越界 clamp
        let remap = TimeRemap { reverse: false, freeze: None, curve: Vec::new() };
        // off 远超出 dur：src = 10 + 100*1 = 110，但 clamp 到 end=20
        let clip = make_clip_with_remap("c1", 10.0, 20.0, 0.0, 4.0, 1.0, remap);
        let (src_t, _) = clip_source_time(100.0, &clip);
        assert!((src_t - 20.0).abs() < 1e-9);
    }
}
