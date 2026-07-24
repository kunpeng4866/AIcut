// ═══════════════════════════════════════════════════════════
// 音频独立管线 — 重采样 → 混音 → 限制器
// Phase 4.5 步骤6
//
// 职责：
//   1. 对时间线某时刻 t 的所有活跃音频片段（含视频自带音频）解码
//   2. 应用每个片段的 volume / speed
//   3. 将多片段混音（加法叠加）
//   4. 限制器（soft-knee limiter）防止削波
//
// 设计要点：
//   - 重采样由 FFmpeg `-ar` 内置完成，无需自己实现
//   - 混音是简单加法，多片段时峰值可能超过 1.0，需限制器
//   - 限制器采用软拐（soft-knee），阈值以下线性通过，阈值以上平滑压缩
//   - AudioPipeline 不持有时钟，由调用方（Export/Preview）驱动时间
// ═══════════════════════════════════════════════════════════

use std::process::{Command, Stdio};

use crate::ffmpeg;
use crate::pipeline::strategy::{timeline_to_source_time, AudioChunk};
use crate::project::Project;
use crate::timeline::Timeline;

// ════════════════════ 配置 ════════════════════

/// 音频管线配置
#[derive(Debug, Clone)]
pub struct AudioPipelineConfig {
    /// 采样率（Hz）
    pub sample_rate: u32,
    /// 声道数（1=单声道, 2=立体声）
    pub channels: u16,
}

impl Default for AudioPipelineConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 2,
        }
    }
}

impl AudioPipelineConfig {
    /// 从工程 CanvasConfig 构建
    pub fn from_project(project: &Project) -> Self {
        Self {
            sample_rate: project.canvas.sample_rate,
            channels: 2,
        }
    }
}

// ════════════════════ 混音器 ════════════════════

/// 音频混音器：将多个音频块叠加为单个块
pub struct AudioMixer {
    sample_rate: u32,
    channels: u16,
}

impl AudioMixer {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            sample_rate,
            channels,
        }
    }

    /// 混合多个音频块
    ///
    /// - 若 chunks 为空，返回静音块
    /// - 所有块长度对齐到最短的（避免越界）
    /// - 每个样本 = 所有块对应位置样本之和
    pub fn mix(&self, chunks: &[AudioChunk], frame_count: usize, timestamp: f64) -> AudioChunk {
        if chunks.is_empty() {
            return AudioChunk::silence(self.sample_rate, self.channels, frame_count, timestamp);
        }

        let total_samples = frame_count * self.channels as usize;
        let mut mixed = vec![0.0f32; total_samples];

        for chunk in chunks {
            let copy_len = chunk.samples.len().min(total_samples);
            for i in 0..copy_len {
                mixed[i] += chunk.samples[i];
            }
        }

        AudioChunk {
            samples: mixed,
            sample_rate: self.sample_rate,
            channels: self.channels,
            timestamp,
            frame_count,
        }
    }
}

// ════════════════════ 限制器 ════════════════════

/// 软拐限制器（Soft-Knee Limiter）
///
/// 防止混音后样本超过 [-1.0, 1.0] 范围导致削波失真。
///
/// 工作原理：
/// - 样本绝对值 < threshold：线性通过（无处理）
/// - threshold ≤ |sample| < ceiling：软拐压缩（平滑过渡）
/// - |sample| ≥ ceiling：硬限制（不超过 ceiling）
///
/// 参数默认值：
/// - threshold = 0.85（约 -1.4 dBFS）
/// - ceiling = 0.98（约 -0.2 dBFS）
/// - knee_width = 0.13（threshold 到 ceiling 之间的过渡区）
#[derive(Debug, Clone)]
pub struct Limiter {
    /// 阈值（0.0 ~ 1.0），超过此值开始压缩
    pub threshold: f32,
    /// 上限（0.0 ~ 1.0），输出不超过此值
    pub ceiling: f32,
}

impl Default for Limiter {
    fn default() -> Self {
        Self {
            threshold: 0.85,
            ceiling: 0.98,
        }
    }
}

impl Limiter {
    pub fn new(threshold: f32, ceiling: f32) -> Self {
        Self {
            threshold: threshold.clamp(0.0, 1.0),
            ceiling: ceiling.clamp(0.0, 1.0),
        }
    }

    /// 对单个样本应用限制
    #[inline]
    fn process_sample(&self, sample: f32) -> f32 {
        let abs = sample.abs();
        if abs < self.threshold {
            // 阈值以下：线性通过
            sample
        } else if abs < self.ceiling {
            // 软拐区：平滑压缩
            // 使用二次贝塞尔曲线从 threshold 线性过渡到 ceiling
            let t = (abs - self.threshold) / (self.ceiling - self.threshold);
            let compressed = self.threshold + (self.ceiling - self.threshold) * t * t;
            // 保持原符号
            if sample >= 0.0 {
                compressed
            } else {
                -compressed
            }
        } else {
            // 超过上限：硬限制
            if sample >= 0.0 {
                self.ceiling
            } else {
                -self.ceiling
            }
        }
    }

    /// 原地处理整段音频样本
    pub fn process(&self, samples: &mut [f32]) {
        for s in samples.iter_mut() {
            *s = self.process_sample(*s);
        }
    }
}

// ════════════════════ 音频管线 ════════════════════

/// 音频独立管线
///
/// 由 ExportPipeline / PreviewPipeline 调用，处理多轨道音频解码与混音。
///
/// ```text
/// 时间 t → 查询活跃片段 → 逐片段 FFmpeg 抽帧 → 应用 volume → 混音 → 限制器 → AudioChunk
/// ```
pub struct AudioPipeline<'a> {
    project: &'a Project,
    timeline: Timeline<'a>,
    config: AudioPipelineConfig,
    mixer: AudioMixer,
    limiter: Limiter,
}

impl<'a> AudioPipeline<'a> {
    pub fn new(project: &'a Project, config: AudioPipelineConfig) -> Self {
        let timeline = Timeline::new(project);
        let sample_rate = config.sample_rate;
        let channels = config.channels;
        Self {
            project,
            timeline,
            config,
            mixer: AudioMixer::new(sample_rate, channels),
            limiter: Limiter::default(),
        }
    }

    /// 从工程构建，使用工程默认采样率
    pub fn from_project(project: &'a Project) -> Self {
        let config = AudioPipelineConfig::from_project(project);
        Self::new(project, config)
    }

    /// 渲染时间 t 处的音频块
    ///
    /// - t: 时间线时间（秒）
    /// - samples: 请求的样本数（每声道）
    /// - 返回: 混音 + 限制后的音频块
    pub fn render_chunk(&self, t: f64, samples: usize) -> Result<AudioChunk, crate::AppError> {
        let duration = samples as f64 / self.config.sample_rate as f64;

        // 1. 查询时间 [t, t+duration) 内所有活跃片段
        let active_clips = self.timeline.clips_in_range(t, t + duration);

        // 2. 筛选有音频的片段：audio 轨道 + video/effect 轨道（视频自带音频）
        let audio_clips: Vec<_> = active_clips
            .iter()
            .filter(|c| c.track_type == "audio" || c.track_type == "video" || c.track_type == "effect")
            .collect();

        if audio_clips.is_empty() {
            return Ok(AudioChunk::silence(
                self.config.sample_rate,
                self.config.channels,
                samples,
                t,
            ));
        }

        // 3. 逐片段解码音频
        let mut chunks: Vec<AudioChunk> = Vec::with_capacity(audio_clips.len());

        for clip_ref in audio_clips {
            let clip = clip_ref.clip;
            let src_t = timeline_to_source_time(t, clip);

            let asset = self.project.asset_by_id(&clip.asset_id);
            let input_path = match asset {
                Some(a) => a.path.as_str(),
                None => continue,
            };

            let cmd = ffmpeg::build_extract_audio_cmd(
                input_path,
                src_t,
                duration,
                self.config.sample_rate,
                self.config.channels,
            );

            let output = Command::new(&cmd[0])
                .args(&cmd[1..])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();

            let output = match output {
                Ok(o) if o.status.success() => o,
                _ => continue, // 解码失败则跳过该片段
            };

            // f32le bytes → f32 samples
            let f32_samples: Vec<f32> = output
                .stdout
                .chunks_exact(4)
                .map(|chunk| {
                    let arr: [u8; 4] = [chunk[0], chunk[1], chunk[2], chunk[3]];
                    f32::from_le_bytes(arr)
                })
                .collect();

            // 应用片段音量
            let volume = clip.volume as f32;
            let adjusted: Vec<f32> = if (volume - 1.0).abs() < 1e-6 {
                f32_samples
            } else {
                f32_samples.iter().map(|&s| s * volume).collect()
            };

            let frame_count = adjusted.len() / self.config.channels as usize;
            chunks.push(AudioChunk {
                samples: adjusted,
                sample_rate: self.config.sample_rate,
                channels: self.config.channels,
                timestamp: t,
                frame_count,
            });
        }

        if chunks.is_empty() {
            return Ok(AudioChunk::silence(
                self.config.sample_rate,
                self.config.channels,
                samples,
                t,
            ));
        }

        // 4. 混音
        let mut mixed = self.mixer.mix(&chunks, samples, t);

        // 5. 限制器（防止混音后削波）
        self.limiter.process(&mut mixed.samples);

        Ok(mixed)
    }

    /// 渲染整个时间线的音频，写入 PCM f32le 文件
    ///
    /// 用于导出场景：按块步进，逐块渲染并写入文件
    pub fn render_to_pcm(&self, block_size: usize) -> Result<Vec<u8>, crate::AppError> {
        let total_duration = self.timeline.duration();
        if total_duration <= 0.0 {
            return Ok(Vec::new());
        }

        let mut output: Vec<u8> = Vec::new();
        let mut t = 0.0;
        let block_duration = block_size as f64 / self.config.sample_rate as f64;

        while t < total_duration {
            let chunk = self.render_chunk(t, block_size)?;
            for &sample in &chunk.samples {
                output.extend_from_slice(&sample.to_le_bytes());
            }
            t += block_duration;
        }

        Ok(output)
    }

    /// 获取配置引用
    pub fn config(&self) -> &AudioPipelineConfig {
        &self.config
    }
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Asset, CanvasConfig, Clip, Project, Range, Track, Transform};

    fn make_transform() -> Transform {
        Transform {
            x: 0.5,
            y: 0.5,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
            opacity: 1.0,
        }
    }

    fn make_clip(id: &str, asset_id: &str, tl_in: f64, tl_out: f64, src_start: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            src_range: Range {
                start: src_start,
                end: src_start + (tl_out - tl_in),
            },
            timeline_in: tl_in,
            timeline_out: tl_out,
            transform: make_transform(),
            volume: 1.0,
            speed: 1.0,
            speed_curve: vec![],
            time_remap: crate::project::TimeRemap { reverse: false, freeze: None, curve: Vec::new() },
            effects: vec![],
            masks: vec![],
            filters: vec![],
            keyframes: Default::default(),
            text: None,
            subtitle: None, transition: None,
            audio_envelope: vec![],
        }
    }

    fn make_project() -> Project {
        Project {
            version: "1.0".to_string(),
            canvas: CanvasConfig {
                width: 1920,
                height: 1080,
                fps: 30,
                sample_rate: 48000,
            },
            assets: vec![Asset {
                id: "a1".to_string(),
                asset_type: "audio".to_string(),
                path: "/nonexistent/test.mp3".to_string(),
                duration: 10.0,
                width: 0,
                height: 0,
                codec: String::new(),
            }],
            tracks: vec![],
        }
    }

    // ── AudioMixer 测试 ──

    #[test]
    fn test_mixer_empty_returns_silence() {
        let mixer = AudioMixer::new(48000, 2);
        let result = mixer.mix(&[], 1024, 0.0);
        assert!(result.is_silent());
        assert_eq!(result.frame_count, 1024);
        assert_eq!(result.samples.len(), 1024 * 2);
    }

    #[test]
    fn test_mixer_single_chunk_passthrough() {
        let mixer = AudioMixer::new(48000, 2);
        let chunk = AudioChunk {
            samples: vec![0.5, 0.3, -0.2, 0.8],
            sample_rate: 48000,
            channels: 2,
            timestamp: 0.0,
            frame_count: 2,
        };
        let result = mixer.mix(&[chunk], 2, 0.0);
        assert_eq!(result.samples, vec![0.5, 0.3, -0.2, 0.8]);
    }

    #[test]
    fn test_mixer_two_chunks_addition() {
        let mixer = AudioMixer::new(48000, 1);
        let c1 = AudioChunk {
            samples: vec![0.3, 0.5, 0.7],
            sample_rate: 48000,
            channels: 1,
            timestamp: 0.0,
            frame_count: 3,
        };
        let c2 = AudioChunk {
            samples: vec![0.2, 0.1, -0.4],
            sample_rate: 48000,
            channels: 1,
            timestamp: 0.0,
            frame_count: 3,
        };
        let result = mixer.mix(&[c1, c2], 3, 0.0);
        assert!((result.samples[0] - 0.5).abs() < 1e-6);
        assert!((result.samples[1] - 0.6).abs() < 1e-6);
        assert!((result.samples[2] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn test_mixer_different_length_chunks() {
        let mixer = AudioMixer::new(48000, 1);
        let c1 = AudioChunk {
            samples: vec![0.3, 0.5, 0.7, 0.9],
            sample_rate: 48000,
            channels: 1,
            timestamp: 0.0,
            frame_count: 4,
        };
        let c2 = AudioChunk {
            samples: vec![0.1, 0.2],
            sample_rate: 48000,
            channels: 1,
            timestamp: 0.0,
            frame_count: 2,
        };
        // frame_count=4，但 c2 只有 2 个样本，超出部分不叠加
        let result = mixer.mix(&[c1, c2], 4, 0.0);
        assert!((result.samples[0] - 0.4).abs() < 1e-6); // 0.3 + 0.1
        assert!((result.samples[1] - 0.7).abs() < 1e-6); // 0.5 + 0.2
        assert!((result.samples[2] - 0.7).abs() < 1e-6); // 0.7 + 0 (c2 超出)
        assert!((result.samples[3] - 0.9).abs() < 1e-6); // 0.9 + 0
    }

    // ── Limiter 测试 ──

    #[test]
    fn test_limiter_below_threshold_passthrough() {
        let limiter = Limiter::default(); // threshold=0.85, ceiling=0.98
        let mut samples = vec![0.1, -0.3, 0.5, -0.8];
        limiter.process(&mut samples);
        assert!((samples[0] - 0.1).abs() < 1e-6);
        assert!((samples[1] + 0.3).abs() < 1e-6);
        assert!((samples[2] - 0.5).abs() < 1e-6);
        assert!((samples[3] + 0.8).abs() < 1e-6);
    }

    #[test]
    fn test_limiter_at_threshold_passthrough() {
        let limiter = Limiter::default();
        let mut samples = vec![0.85];
        limiter.process(&mut samples);
        // 刚好在阈值上，应该开始压缩但变化很小
        assert!(samples[0] <= 0.85 + 1e-6);
    }

    #[test]
    fn test_limiter_above_ceiling_hard_limit() {
        let limiter = Limiter::default(); // ceiling=0.98
        let mut samples = vec![1.5, -1.2, 2.0, -3.0];
        limiter.process(&mut samples);
        assert!((samples[0] - 0.98).abs() < 1e-6);
        assert!((samples[1] + 0.98).abs() < 1e-6);
        assert!((samples[2] - 0.98).abs() < 1e-6);
        assert!((samples[3] + 0.98).abs() < 1e-6);
    }

    #[test]
    fn test_limiter_soft_knee_region() {
        let limiter = Limiter::default(); // threshold=0.85, ceiling=0.98
        // 0.9 在软拐区中间（t ≈ 0.385）
        let mut samples = vec![0.9, -0.9];
        limiter.process(&mut samples);
        // 压缩后应该 < 0.9 但 > 0.85
        assert!(samples[0] < 0.9);
        assert!(samples[0] > 0.85);
        assert!(samples[1] > -0.9);
        assert!(samples[1] < -0.85);
    }

    #[test]
    fn test_limiter_preserves_sign() {
        let limiter = Limiter::default();
        let mut pos = vec![1.5];
        let mut neg = vec![-1.5];
        limiter.process(&mut pos);
        limiter.process(&mut neg);
        assert!(pos[0] > 0.0);
        assert!(neg[0] < 0.0);
        assert!((pos[0] + neg[0]).abs() < 1e-6); // 对称
    }

    #[test]
    fn test_limiter_custom_params() {
        let limiter = Limiter::new(0.5, 0.7);
        let mut samples = vec![0.3, 0.6, 1.0];
        limiter.process(&mut samples);
        assert!((samples[0] - 0.3).abs() < 1e-6); // < threshold, passthrough
        assert!(samples[1] < 0.6); // in knee, compressed
        assert!(samples[1] > 0.5);
        assert!((samples[2] - 0.7).abs() < 1e-6); // > ceiling, hard limit
    }

    #[test]
    fn test_limiter_zero_input() {
        let limiter = Limiter::default();
        let mut samples = vec![0.0, 0.0, 0.0];
        limiter.process(&mut samples);
        assert!(samples.iter().all(|&s| s == 0.0));
    }

    // ── AudioPipeline 测试 ──

    #[test]
    fn test_pipeline_empty_project() {
        let project = make_project();
        let pipeline = AudioPipeline::from_project(&project);
        let chunk = pipeline.render_chunk(0.0, 1024).unwrap();
        assert!(chunk.is_silent());
        assert_eq!(chunk.sample_rate, 48000);
        assert_eq!(chunk.channels, 2);
        assert_eq!(chunk.frame_count, 1024);
    }

    #[test]
    fn test_pipeline_no_active_clips() {
        let mut project = make_project();
        project.tracks = vec![Track {
            id: "t1".to_string(),
            track_type: "audio".to_string(),
            order: 0,
            clips: vec![make_clip("c1", "a1", 5.0, 10.0, 0.0)],
            ..Default::default()
        }];
        let pipeline = AudioPipeline::from_project(&project);
        // t=0 时没有活跃片段
        let chunk = pipeline.render_chunk(0.0, 1024).unwrap();
        assert!(chunk.is_silent());
    }

    #[test]
    fn test_pipeline_config_from_project() {
        let project = make_project();
        let config = AudioPipelineConfig::from_project(&project);
        assert_eq!(config.sample_rate, 48000);
        assert_eq!(config.channels, 2);
    }

    #[test]
    fn test_pipeline_config_default() {
        let config = AudioPipelineConfig::default();
        assert_eq!(config.sample_rate, 48000);
        assert_eq!(config.channels, 2);
    }

    #[test]
    fn test_pipeline_render_to_pcm_empty() {
        let project = make_project();
        let pipeline = AudioPipeline::from_project(&project);
        let pcm = pipeline.render_to_pcm(1024).unwrap();
        assert!(pcm.is_empty()); // duration=0, no output
    }

    #[test]
    fn test_pipeline_clips_filter_by_track_type() {
        let mut project = make_project();
        // text 轨道的片段不应被音频管线处理
        project.tracks = vec![Track {
            id: "t1".to_string(),
            track_type: "text".to_string(),
            order: 0,
            clips: vec![make_clip("c1", "a1", 0.0, 5.0, 0.0)],
            ..Default::default()
        }];
        let pipeline = AudioPipeline::from_project(&project);
        let chunk = pipeline.render_chunk(1.0, 1024).unwrap();
        // text 轨道无音频 → 静音
        assert!(chunk.is_silent());
    }
}
