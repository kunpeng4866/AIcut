//! src/keyframe.rs — 关键帧插值系统
//! Easing 函数、贝塞尔求值、KeyframeTrack 采样逻辑。

use crate::types::*;

impl Easing {
    /// 将命名缓动映射为贝塞尔控制点；Bezier 直接返回自身
    pub fn as_bezier(&self) -> (f64, f64, f64, f64) {
        match self {
            Easing::Linear => (0.0, 0.0, 1.0, 1.0),
            Easing::EaseIn => (0.42, 0.0, 1.0, 1.0),
            Easing::EaseOut => (0.0, 0.0, 0.58, 1.0),
            Easing::EaseInOut => (0.42, 0.0, 0.58, 1.0),
            Easing::Bezier(x1, y1, x2, y2) => (*x1, *y1, *x2, *y2),
        }
    }
}

/// 三次贝塞尔求值：给定时间进度 x∈[0,1]，返回值进度 y
fn cubic_bezier(p1x: f64, p1y: f64, p2x: f64, p2y: f64, x: f64) -> f64 {
    if x <= 0.0 { return 0.0; }
    if x >= 1.0 { return 1.0; }
    let bx = |t: f64| 3.0 * (1.0 - t).powi(2) * t * p1x + 3.0 * (1.0 - t) * t.powi(2) * p2x + t.powi(3);
    let by = |t: f64| 3.0 * (1.0 - t).powi(2) * t * p1y + 3.0 * (1.0 - t) * t.powi(2) * p2y + t.powi(3);
    let dx = |t: f64| {
        let u = 1.0 - t;
        3.0 * u * u * p1x + 6.0 * u * t * (p2x - p1x) + 3.0 * t * t * (1.0 - p2x)
    };
    let mut t = x;
    for _ in 0..8 {
        let x_err = bx(t) - x;
        let d = dx(t);
        if d.abs() < 1e-6 { break; }
        t -= x_err / d;
        t = t.clamp(0.0, 1.0);
    }
    by(t)
}

/// 应用缓动到线性进度 p∈[0,1]
pub fn apply_easing(e: Easing, p: f64) -> f64 {
    let (x1, y1, x2, y2) = e.as_bezier();
    cubic_bezier(x1, y1, x2, y2, p.clamp(0.0, 1.0))
}

impl KeyframeTrack {
    pub fn new() -> Self { Self::default() }

    pub fn is_empty(&self) -> bool { self.keyframes.is_empty() }

    /// 在时刻 t 插值得到属性值。无关键帧返回 0.0
    pub fn sample(&self, t: f64) -> f64 {
        let kfs = &self.keyframes;
        if kfs.is_empty() { return 0.0; }
        if kfs.len() == 1 || t <= kfs[0].time { return kfs[0].value; }
        let last = kfs.len() - 1;
        if t >= kfs[last].time { return kfs[last].value; }
        let mut lo = 0usize;
        let mut hi = last;
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if kfs[mid].time <= t { lo = mid; } else { hi = mid; }
        }
        let a = &kfs[lo];
        let b = &kfs[hi];
        let denom = (b.time - a.time).max(1e-9);
        let p = (t - a.time) / denom;
        let pe = apply_easing(b.easing, p);
        a.value + (b.value - a.value) * pe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_easing_bezier_linear() {
        let (x1, y1, x2, y2) = Easing::Linear.as_bezier();
        assert_eq!((x1, y1, x2, y2), (0.0, 0.0, 1.0, 1.0));
    }

    #[test]
    fn test_cubic_bezier_boundaries() {
        for e in &[Easing::Linear, Easing::EaseIn, Easing::EaseOut, Easing::EaseInOut] {
            let y0 = apply_easing(*e, 0.0);
            let y1 = apply_easing(*e, 1.0);
            assert!((y0 - 0.0).abs() < 0.001, "{:?} at 0: {}", e, y0);
            assert!((y1 - 1.0).abs() < 0.001, "{:?} at 1: {}", e, y1);
        }
    }

    #[test]
    fn test_easing_monotonic() {
        for e in &[Easing::Linear, Easing::EaseIn, Easing::EaseOut, Easing::EaseInOut] {
            let mut prev = 0.0;
            for i in 1..=20 {
                let x = i as f64 / 20.0;
                let y = apply_easing(*e, x);
                assert!(y >= prev - 0.001, "{:?} non-monotonic at x={}", e, x);
                prev = y;
            }
        }
    }

    #[test]
    fn test_keyframe_single() {
        let track = KeyframeTrack { keyframes: vec![Keyframe { time: 0.0, value: 42.0, easing: Easing::Linear }] };
        assert!((track.sample(0.0) - 42.0).abs() < 0.001);
        assert!((track.sample(5.0) - 42.0).abs() < 0.001);
    }

    #[test]
    fn test_keyframe_linear_interpolation() {
        let track = KeyframeTrack {
            keyframes: vec![
                Keyframe { time: 0.0, value: 0.0, easing: Easing::Linear },
                Keyframe { time: 2.0, value: 100.0, easing: Easing::Linear },
            ],
        };
        assert!((track.sample(1.0) - 50.0).abs() < 0.01);
    }

    #[test]
    fn test_keyframe_binary_search() {
        let kfs: Vec<Keyframe> = (0..10).map(|i| Keyframe { time: i as f64, value: (i * 10) as f64, easing: Easing::Linear }).collect();
        let track = KeyframeTrack { keyframes: kfs };
        assert!((track.sample(4.5) - 45.0).abs() < 0.01);
        assert!((track.sample(-1.0) - 0.0).abs() < 0.01);
        assert!((track.sample(99.0) - 90.0).abs() < 0.01);
    }

    #[test]
    fn test_keyframe_empty_track() {
        let track = KeyframeTrack::new();
        assert!(track.is_empty());
        assert!((track.sample(5.0) - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_keyframe_ease_out() {
        let track = KeyframeTrack {
            keyframes: vec![
                Keyframe { time: 0.0, value: 0.0, easing: Easing::Linear },
                Keyframe { time: 2.0, value: 100.0, easing: Easing::EaseOut },
            ],
        };
        let mid = track.sample(1.0);
        assert!(mid > 50.0, "EaseOut 中点应 > 50，实际: {}", mid);
    }
}
