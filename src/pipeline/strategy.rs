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
///     off_norm = off / dur                            // 归一化 [0,1]，曲线 play 域
///     src_t = src_start + dur * speed_integral(curve, off_norm, 0)  // 绝对速度积分（speed 为用户设定绝对倍率）
///     frozen = speed_at(curve, off_norm) < EPS        // 零速（定格）段 frozen=true（静音，与冻结一致）；speed>0 段出声
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
/// 曲线模式：src_t = src_start + dur * speed_integral(curve, off_norm, 0)（play 归一化绝对积分；整段素材恰好播完由前端按平均速率反推 dur 保证，绝不越界定格）
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

    let (src_t, frozen) = if !remap.curve.is_empty() {
        // curve 权威映射（play 归一化 [0,1]，与片段绝对时长解耦）：
        // srcT = src_start + dur * ∫₀^offNorm speed(τ) dτ，其中 offNorm = off/dur ∈ [0,1]。
        // dur 已由前端 setCurveCommit 按平均速率反推（dur = srcDur / ∫₀^1 speed dτ），
        // 使整段素材恰好播完、绝不越界定格。
        let off_norm = if dur > 1e-9 { off / dur } else { 0.0 };
        let f = speed_integral(&remap.curve, off_norm, 0.0); // ∫₀^offNorm speed dτ（归一化）
        // 零速曲线定格段：瞬时 speed≈0 → frozen=true（定格+静音，与冻结一致）；
        // speed>0 段正常自播放+出声（导出处据此自然静音，与预览对齐）。
        let frozen = speed_at(&remap.curve, off_norm) < 1e-4;
        (clip.src_range.start + dur * f, frozen)
    } else {
        let mut frozen = false;
        let src_t = if let Some(freeze) = &remap.freeze {
            if off >= freeze.start && off < freeze.start + freeze.duration {
                frozen = true;
                freeze.source_time
            } else {
                // 冻结窗口之外：按「有效（非冻结）播放时间」推进源，使退出冻结时
                // 源时间从 freeze.source_time 平滑继续（不再突跳 freeze.duration 秒）。
                // 完整素材在「前端已把 freeze.duration 计入 timelineOut」的延长时间线内恰好播完。
                base_source_time(clip, dur, effective_off(freeze, off), remap.reverse)
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

/// 非冻结段的有效偏移：从片段起点到 `off` 之间、扣除「冻结窗口已流逝时间」后的播放时间。
///
/// 语义：冻结窗口内源时间停滞（frozen），不消耗素材；退出冻结后源时间应从 `freeze.source_time`
/// 平滑继续，而非带着冻结时长一起往前跳。故非冻结段的源推进时间 = `off - 冻结已流逝`。
///
/// - off ≤ start：未进入冻结，流逝 0
/// - off ≥ start+duration：完全越过冻结，流逝 = duration
/// - 区间内：流逝 = off - start
///
/// 与前端 `gui/src/components/PreviewCanvas.tsx::frozenElapsed` 逐字节一致。
fn effective_off(freeze: &crate::project::FreezeConfig, off: f64) -> f64 {
    let elapsed = if off <= freeze.start {
        0.0
    } else if off >= freeze.start + freeze.duration {
        freeze.duration
    } else {
        off - freeze.start
    };
    off - elapsed
}

/// 速度曲线积分（绝对速度）：把"速度曲线"积分为源素材时间。
///
/// 数学：`srcT(off) = src_start + ∫₀^off speed(τ) dτ`，
/// 其中 `speed(τ)` 按 play 分段线性插值（trapezoid 积分）。speed 为绝对速度倍率（用户设定的值）。
/// speed>0 时 srcT 单调推进 → 连续播放；speed=0 段 → 冻结帧（srcT 恒定）。
///
/// 注意：曲线积分要求片段时间线长 dur 由前端 `setCurveCommit` 按曲线平均速率**反向推导**
/// （`newDur = oldDur * srcDur / ∫₀^oldDur speed dτ`），使 `∫₀^dur speed dτ = srcDur`，
/// 即整段素材恰好在 dur 内播完 —— 任意曲线形状（含局部 speed>1）都不会越界被 clamp 定格。
/// 导出（graph.rs::build_speed_curve_expr）用同样的绝对积分拼 setpts，与预览一致。
pub fn speed_integral(curve: &[crate::project::SpeedPoint], off: f64, src_start: f64) -> f64 {
    if curve.is_empty() {
        return src_start;
    }
    let mut pts: Vec<&crate::project::SpeedPoint> = curve.iter().collect();
    pts.sort_by(|a, b| a.play.partial_cmp(&b.play).unwrap_or(std::cmp::Ordering::Equal));

    let mut acc = 0.0f64;

    // 段 [0, pts[0].play]：以 pts[0].speed 为恒定速度（hold 第一段前的速度）
    let first = pts[0];
    if off <= first.play {
        return src_start + (off.max(0.0)) * first.speed;
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
            return src_start + acc;
        } else if span.abs() >= 1e-12 {
            acc += (a.speed + b.speed) / 2.0 * span;
        }
    }

    // off 超过末点 play：以末点 speed 外延
    let last_pt = pts[last];
    if off > last_pt.play {
        acc += (off - last_pt.play) * last_pt.speed;
    }
    src_start + acc
}

/// 曲线在 play 偏移 off 处的「瞬时原始速度」（分段线性插值，非积分）。
///
/// 与前端 `gui/src/utils/speedCurve.ts::rawSpeedAt` 逐字节一致：
/// speed 按 play 分段线性插值；off ≤ 首点.play 返回首点速度；超出末点返回末点速度。
/// 用于识别零速（定格）段：`speed_at(curve, off) < EPS` → 该段冻结+静音（与 freeze 对齐）。
pub fn speed_at(curve: &[crate::project::SpeedPoint], off: f64) -> f64 {
    if curve.is_empty() {
        return 1.0;
    }
    let mut pts: Vec<&crate::project::SpeedPoint> = curve.iter().collect();
    pts.sort_by(|a, b| a.play.partial_cmp(&b.play).unwrap_or(std::cmp::Ordering::Equal));

    if off <= pts[0].play {
        return pts[0].speed;
    }
    for i in 1..pts.len() {
        let a = pts[i - 1];
        let b = pts[i];
        if off <= b.play {
            let span = b.play - a.play;
            let frac = if span.abs() < 1e-12 { 0.0 } else { (off - a.play) / span };
            return a.speed + (b.speed - a.speed) * frac;
        }
    }
    pts[pts.len() - 1].speed
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
            subtitle: None, transition: None, audio_fade_in: 0.0, audio_fade_out: 0.0,
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
            subtitle: None, transition: None, audio_fade_in: 0.0, audio_fade_out: 0.0,
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
        // freeze.start=3, sourceTime=3(=src_start+start*speed，冻结入口连续), duration=2。
        // 修正后：退出冻结时源从 freeze.source_time 平滑继续（不再突跳 2 秒）；
        // 完整素材在「前端计入 freeze.duration 的延长 timelineOut」内播完。
        let remap = TimeRemap {
            reverse: false,
            freeze: Some(FreezeConfig { start: 3.0, source_time: 3.0, duration: 2.0 }),
            curve: Vec::new(),
        };
        // src_range [0,10)，timeline [0,12)（dur=12 = srcDur(10) + freeze(2)）
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 12.0, 1.0, remap);
        // off=4 ∈ [3,5) → src_t = 3.0, frozen
        let (src_t, frozen) = clip_source_time(4.0, &clip);
        assert!((src_t - 3.0).abs() < 1e-9);
        assert!(frozen);
        // off=1（冻结前）→ 有效偏移=1 → src_t = 1.0, not frozen
        let (src_t2, frozen2) = clip_source_time(1.0, &clip);
        assert!((src_t2 - 1.0).abs() < 1e-9);
        assert!(!frozen2);
        // off=5（刚退出冻结）：有效偏移 = 5-2 = 3 → src_t = 3.0（与冻结末尾相同，平滑无跳变）
        let (src_t3, frozen3) = clip_source_time(5.0, &clip);
        assert!((src_t3 - 3.0).abs() < 1e-9);
        assert!(!frozen3);
        // off=6（退出后 1 秒）：有效偏移 = 6-2 = 4 → src_t = 4.0（旧实现会得 6.0，即多跳 2 秒）
        let (src_t4, _) = clip_source_time(6.0, &clip);
        assert!((src_t4 - 4.0).abs() < 1e-9);
        // off=12（末尾）：有效偏移 = 12-2 = 10 → src_t = 10.0 = src_end（整段素材恰好播完）
        let (src_t5, _) = clip_source_time(12.0, &clip);
        assert!((src_t5 - 10.0).abs() < 1e-9);
    }

    #[test]
    fn test_clip_source_time_freeze_reverse() {
        // 倒放 + 冻结：effective_off 同样作用于倒放分支，退出冻结后按倒放映射继续（无额外突跳）。
        let remap = TimeRemap {
            reverse: true,
            freeze: Some(FreezeConfig { start: 3.0, source_time: 7.0, duration: 2.0 }),
            curve: Vec::new(),
        };
        // src_range [0,10)，timeline [0,12)，speed=1。倒放：src = src_start + (dur - effOff)*speed
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 12.0, 1.0, remap);
        // off=4（冻结中）→ src_t = 7.0, frozen
        let (s, f) = clip_source_time(4.0, &clip);
        assert!((s - 7.0).abs() < 1e-9);
        assert!(f);
        // off=5（退出冻结）：有效偏移 = 3 → 倒放 src = 0 + (12 - 3)*1 = 9.0（旧实现会得 0+(12-5)=7.0）
        let (s2, f2) = clip_source_time(5.0, &clip);
        assert!((s2 - 9.0).abs() < 1e-9);
        assert!(!f2);
    }

    #[test]
    fn test_clip_source_time_curve_interp() {
        // 速度曲线（绝对速度，play 归一化 [0,1]，末点必在 play=1）：play=0→speed1, play=1→speed2；src[0,10), dur=4
        // src_t = src_start + dur * ∫₀^offNorm speed dτ，offNorm = off/dur
        let remap = TimeRemap {
            reverse: false,
            freeze: None,
            curve: vec![
                SpeedPoint { play: 0.0, speed: 1.0 },
                SpeedPoint { play: 1.0, speed: 2.0 },
            ],
        };
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 4.0, 1.0, remap);
        // off=0 → offNorm=0 → f=0 → src = 0
        let (s0, _) = clip_source_time(0.0, &clip);
        assert!((s0 - 0.0).abs() < 1e-9);
        // off=1 → offNorm=0.25 → 段[0,1] speed 1→2，f=(1+1.25)/2*0.25=0.28125 → src = 4*0.28125 = 1.125
        let (src_t, frozen) = clip_source_time(1.0, &clip);
        assert!((src_t - 1.125).abs() < 1e-9);
        assert!(!frozen);
        // off=2 → offNorm=0.5 → f=(1+1.5)/2*0.5=0.625 → src = 4*0.625 = 2.5
        let (s3, _) = clip_source_time(2.0, &clip);
        assert!((s3 - 2.5).abs() < 1e-9);
        // off=4(末尾) → offNorm=1 → f=(1+2)/2*1=1.5 → src = 4*1.5 = 6
        // （此处 dur=4 未反推，仅验证归一化映射数学；真实工程由 setCurveCommit 反推 dur 使 ∫₀^1=srcDur/dur）
        let (s4, _) = clip_source_time(4.0, &clip);
        assert!((s4 - 6.0).abs() < 1e-9);
    }

    #[test]
    fn test_clip_source_time_curve_zero_speed_frozen() {
        // 曲线含 speed=0 段（play=0.5 处定格）：该处 frozen=true，speed>0 处 frozen=false
        let remap = TimeRemap {
            reverse: false,
            freeze: None,
            curve: vec![
                SpeedPoint { play: 0.0, speed: 1.0 },
                SpeedPoint { play: 0.5, speed: 0.0 },
                SpeedPoint { play: 1.0, speed: 2.0 },
            ],
        };
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 4.0, 1.0, remap);
        // off=2.0 → offNorm=0.5 → speed 恰好 0 → frozen
        let (_, frozen) = clip_source_time(2.0, &clip);
        assert!(frozen);
        // off=0 → offNorm=0 → speed=1 > 0 → not frozen（回归：speed=1 种子曲线不变）
        let (_, frozen0) = clip_source_time(0.0, &clip);
        assert!(!frozen0);
        // off=0.4 → offNorm=0.1 → speed = 1 + (0-1)*(0.1/0.5) = 0.8 > 0 → not frozen
        let (_, frozen1) = clip_source_time(0.4, &clip);
        assert!(!frozen1);
        // off=3.8 → offNorm=0.95 → speed = 0 + (2-0)*((0.95-0.5)/0.5) = 1.8 > 0 → not frozen
        let (_, frozen2) = clip_source_time(3.8, &clip);
        assert!(!frozen2);
    }

    #[test]
    fn test_clip_source_time_curve_nonzero_speed_not_frozen() {
        // 回归：speed=1 的种子曲线（无零速段）→ 全程 frozen=false，srcT 与旧实现一致
        let remap = TimeRemap {
            reverse: false,
            freeze: None,
            curve: vec![
                SpeedPoint { play: 0.0, speed: 1.0 },
                SpeedPoint { play: 1.0, speed: 1.0 },
            ],
        };
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 4.0, 1.0, remap);
        for &t in &[0.0, 1.0, 2.0, 3.0, 4.0] {
            let (src_t, frozen) = clip_source_time(t, &clip);
            assert!(!frozen, "t={t} 应为非冻结");
            // 恒定 speed=1：src_t = src_start + dur * offNorm = off
            let off = t - clip.timeline_in;
            assert!((src_t - off).abs() < 1e-9, "t={t} src_t 应为 {off}，实际 {src_t}");
        }
    }

    #[test]
    fn test_clip_source_time_curve_overrides_reverse_freeze() {
        // curve 非空时应忽略 reverse/freeze（归一化绝对积分）
        // 速度曲线：play=0→speed1, play=1→speed3；src[0,10), dur=4
        let remap = TimeRemap {
            reverse: true,
            freeze: Some(FreezeConfig { start: 0.0, source_time: 99.0, duration: 100.0 }),
            curve: vec![
                SpeedPoint { play: 0.0, speed: 1.0 },
                SpeedPoint { play: 1.0, speed: 3.0 },
            ],
        };
        let clip = make_clip_with_remap("c1", 0.0, 10.0, 0.0, 4.0, 1.0, remap);
        let (src_t, frozen) = clip_source_time(2.0, &clip);
        // off=2 → offNorm=0.5 → f=(1+2)/2*0.5=0.75 → src = 4*0.75 = 3（忽略 freeze）
        assert!((src_t - 3.0).abs() < 1e-9);
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
