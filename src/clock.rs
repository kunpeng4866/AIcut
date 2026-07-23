//! src/clock.rs — 渲染时钟
//!
//! 两种时钟策略：
//! - SteppedClock：导出用，按帧步进，精确控制每一帧的时间
//! - RealtimeClock：预览用，跟随系统时钟，支持暂停/跳转

use std::time::{Duration, Instant};

// ════════════════════ Clock Trait ════════════════════

/// 渲染时钟 trait：统一导出/预览两条管线的时间源
pub trait Clock {
    /// 当前时间（秒）
    fn now(&self) -> f64;
    /// 总时长（秒）
    fn duration(&self) -> f64;
    /// 是否已到结尾
    fn is_finished(&self) -> bool { self.now() >= self.duration() }
    /// 重置到起点
    fn reset(&mut self);
}

// ════════════════════ SteppedClock（导出） ════════════════════

/// 步进时钟：按帧步进，用于高质量导出
/// 每次调用 advance() 前进一帧（1/fps 秒）
pub struct SteppedClock {
    /// 当前帧索引（从 0 开始）
    frame: u64,
    /// 帧率
    fps: f64,
    /// 总时长（秒）
    duration: f64,
}

impl SteppedClock {
    /// 创建步进时钟
    /// - fps: 帧率（如 30.0）
    /// - duration: 总时长（秒）
    pub fn new(fps: u32, duration: f64) -> Self {
        Self { frame: 0, fps: fps as f64, duration }
    }

    /// 前进一帧，返回新的时间
    pub fn advance(&mut self) -> f64 {
        self.frame += 1;
        self.now()
    }

    /// 当前帧索引
    pub fn frame_index(&self) -> u64 { self.frame }

    /// 总帧数
    pub fn total_frames(&self) -> u64 {
        (self.duration * self.fps).round() as u64
    }

    /// 跳转到指定帧
    pub fn seek_to_frame(&mut self, frame: u64) {
        self.frame = frame;
    }

    /// 帧间隔（秒）
    pub fn frame_interval(&self) -> f64 {
        1.0 / self.fps
    }
}

impl Clock for SteppedClock {
    fn now(&self) -> f64 {
        self.frame as f64 / self.fps
    }
    fn duration(&self) -> f64 { self.duration }
    fn reset(&mut self) { self.frame = 0; }
    fn is_finished(&self) -> bool {
        self.now() >= self.duration
    }
}

// ════════════════════ RealtimeClock（预览） ════════════════════

/// 实时时钟：跟随系统时钟，用于低延迟预览
/// 支持播放/暂停/跳转
pub struct RealtimeClock {
    /// 当前播放时间（秒）
    current_time: f64,
    /// 总时长（秒）
    duration: f64,
    /// 是否正在播放
    is_playing: bool,
    /// 上次 tick 的系统时间
    last_tick: Option<Instant>,
    /// 播放速率（1.0 = 正常，0.5 = 半速，2.0 = 双速）
    speed: f64,
}

impl RealtimeClock {
    pub fn new(duration: f64) -> Self {
        Self {
            current_time: 0.0,
            duration,
            is_playing: false,
            last_tick: None,
            speed: 1.0,
        }
    }

    /// 开始播放
    pub fn play(&mut self) {
        self.is_playing = true;
        self.last_tick = Some(Instant::now());
    }

    /// 暂停
    pub fn pause(&mut self) {
        self.is_playing = false;
        self.last_tick = None;
    }

    /// 切换播放/暂停
    pub fn toggle(&mut self) {
        if self.is_playing { self.pause(); } else { self.play(); }
    }

    /// 跳转到指定时间
    pub fn seek(&mut self, time: f64) {
        self.current_time = time.clamp(0.0, self.duration);
        if self.is_playing {
            self.last_tick = Some(Instant::now());
        }
    }

    /// 设置播放速率
    pub fn set_speed(&mut self, speed: f64) {
        self.speed = speed.clamp(0.1, 4.0);
        if self.is_playing {
            self.last_tick = Some(Instant::now());
        }
    }

    /// 是否正在播放
    pub fn is_playing(&self) -> bool { self.is_playing }

    /// 播放速率
    pub fn speed(&self) -> f64 { self.speed }

    /// Tick：推进时间，应在每帧渲染前调用
    /// 返回当前时间
    pub fn tick(&mut self) -> f64 {
        if !self.is_playing {
            return self.current_time;
        }
        if let Some(last) = self.last_tick {
            let elapsed = last.elapsed().as_secs_f64() * self.speed;
            self.current_time = (self.current_time + elapsed).min(self.duration);
            // 到达结尾自动暂停
            if self.current_time >= self.duration {
                self.is_playing = false;
                self.last_tick = None;
            }
        }
        self.last_tick = Some(Instant::now());
        self.current_time
    }
}

impl Clock for RealtimeClock {
    fn now(&self) -> f64 { self.current_time }
    fn duration(&self) -> f64 { self.duration }
    fn reset(&mut self) {
        self.current_time = 0.0;
        self.last_tick = None;
    }
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stepped_clock() {
        let mut clock = SteppedClock::new(30, 3.0);
        assert_eq!(clock.now(), 0.0);
        assert_eq!(clock.frame_index(), 0);
        assert_eq!(clock.total_frames(), 90); // 3.0 * 30

        clock.advance();
        assert!((clock.now() - 1.0/30.0).abs() < 1e-6);
        assert_eq!(clock.frame_index(), 1);

        // 跳转到最后一帧
        clock.seek_to_frame(89);
        assert!(!clock.is_finished());
        clock.advance();
        assert!(clock.is_finished());
    }

    #[test]
    fn test_stepped_clock_frame_interval() {
        let clock = SteppedClock::new(60, 1.0);
        assert!((clock.frame_interval() - 1.0/60.0).abs() < 1e-6);
    }

    #[test]
    fn test_realtime_clock_basic() {
        let mut clock = RealtimeClock::new(10.0);
        assert_eq!(clock.now(), 0.0);
        assert!(!clock.is_playing());

        clock.play();
        assert!(clock.is_playing());

        clock.pause();
        assert!(!clock.is_playing());
    }

    #[test]
    fn test_realtime_clock_seek() {
        let mut clock = RealtimeClock::new(10.0);
        clock.seek(5.0);
        assert_eq!(clock.now(), 5.0);

        // 超出范围被 clamp
        clock.seek(20.0);
        assert_eq!(clock.now(), 10.0);

        clock.seek(-1.0);
        assert_eq!(clock.now(), 0.0);
    }

    #[test]
    fn test_realtime_clock_speed() {
        let mut clock = RealtimeClock::new(10.0);
        clock.set_speed(2.0);
        assert_eq!(clock.speed(), 2.0);

        clock.set_speed(10.0); // clamp to 4.0
        assert_eq!(clock.speed(), 4.0);

        clock.set_speed(0.0); // clamp to 0.1
        assert!((clock.speed() - 0.1).abs() < 1e-6);
    }

    #[test]
    fn test_realtime_clock_tick() {
        let mut clock = RealtimeClock::new(10.0);
        // 未播放时 tick 不前进
        clock.tick();
        assert_eq!(clock.now(), 0.0);

        // 播放后 tick 前进（时间很短，但应 > 0）
        clock.play();
        std::thread::sleep(Duration::from_millis(10));
        clock.tick();
        assert!(clock.now() > 0.0);
    }

    #[test]
    fn test_realtime_clock_auto_pause_at_end() {
        let mut clock = RealtimeClock::new(0.05); // 50ms 总时长
        clock.play();
        std::thread::sleep(Duration::from_millis(60));
        clock.tick();
        assert!(!clock.is_playing()); // 到达结尾自动暂停
        assert!(clock.now() >= 0.05);
    }

    #[test]
    fn test_clock_reset() {
        let mut stepped = SteppedClock::new(30, 3.0);
        stepped.advance();
        stepped.advance();
        assert!(stepped.now() > 0.0);
        stepped.reset();
        assert_eq!(stepped.now(), 0.0);

        let mut realtime = RealtimeClock::new(10.0);
        realtime.seek(5.0);
        realtime.reset();
        assert_eq!(realtime.now(), 0.0);
    }
}
