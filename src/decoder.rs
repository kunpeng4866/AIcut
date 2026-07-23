//! 并行解码池 — FFmpeg 抽帧 + LRU 缓存 + 线程并行预取
//!
//! 离线环境约束：不引 rayon crate，用 std::thread::scope 实现并行。
//! 架构上预留 trait 接口，后续可无缝替换为 rayon + ffmpeg-next。

use std::collections::{HashMap, VecDeque};
use std::process::Command;
use std::sync::Mutex;
use std::thread;

use crate::pipeline::strategy::{PixelFormat, VideoFrame};

// ════════════════════ 类型定义 ════════════════════

/// 解码后的帧（RGBA8，缓存单元）
#[derive(Clone, Debug)]
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    /// RGBA8 像素数据，长度 = width * height * 4
    pub data: Vec<u8>,
    /// 源素材时间（秒）
    pub source_time: f64,
}

impl DecodedFrame {
    /// 创建黑场帧（完全不透明黑色）
    pub fn black(width: u32, height: u32, source_time: f64) -> Self {
        Self {
            width,
            height,
            data: [0, 0, 0, 255].repeat((width as usize) * (height as usize)),
            source_time,
        }
    }

    /// 创建透明帧（全零 alpha）
    pub fn transparent(width: u32, height: u32, source_time: f64) -> Self {
        Self {
            width,
            height,
            data: vec![0; (width as usize) * (height as usize) * 4],
            source_time,
        }
    }

    /// 转为 VideoFrame
    pub fn to_video_frame(&self, timestamp: f64, source_asset_id: &str) -> VideoFrame {
        VideoFrame {
            width: self.width,
            height: self.height,
            format: PixelFormat::Rgba8,
            data: self.data.clone(),
            timestamp,
            source_asset_id: source_asset_id.to_string(),
            source_time: self.source_time,
        }
    }
}

/// 预取请求
#[derive(Clone, Debug)]
pub struct PrefetchRequest {
    pub asset_path: String,
    pub source_time: f64,
    pub width: u32,
    pub height: u32,
}

/// 缓存键：量化到毫秒以提升命中率
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CacheKey {
    asset_path: String,
    /// 源时间量化到毫秒（避免浮点误差导致缓存未命中）
    time_ms: i64,
    width: u32,
    height: u32,
}

impl CacheKey {
    fn new(asset_path: &str, source_time: f64, width: u32, height: u32) -> Self {
        Self {
            asset_path: asset_path.to_string(),
            time_ms: (source_time * 1000.0).round() as i64,
            width,
            height,
        }
    }
}

// ════════════════════ DecoderPool ════════════════════

/// 并行解码池 + LRU 缓存
///
/// - `decode()`: 同步解码单帧（先查缓存，未命中则 FFmpeg 抽帧）
/// - `prefetch()`: 并行预取多帧（std::thread::scope），结果写入缓存
/// - LRU 淘汰策略：容量超限时淘汰最久未访问的条目
pub struct DecoderPool {
    cache: HashMap<CacheKey, DecodedFrame>,
    lru_order: VecDeque<CacheKey>,
    capacity: usize,
    /// true = 精确抽帧（-ss 在 -i 后），false = 快速抽帧（-ss 在 -i 前）
    use_accurate_seek: bool,
}

impl DecoderPool {
    /// 创建解码池，指定缓存容量（帧数）
    pub fn new(capacity: usize) -> Self {
        Self {
            cache: HashMap::new(),
            lru_order: VecDeque::with_capacity(capacity),
            capacity: capacity.max(1),
            use_accurate_seek: false,
        }
    }

    /// 设置是否使用精确 seek（慢但帧位置准确）
    pub fn with_accurate_seek(mut self, accurate: bool) -> Self {
        self.use_accurate_seek = accurate;
        self
    }

    /// 解码指定帧：先查缓存，未命中则调 FFmpeg 抽帧
    ///
    /// - `asset_path`: 源素材路径
    /// - `source_time`: 源素材中的时间（秒）
    /// - `width`/`height`: 目标分辨率
    pub fn decode(
        &mut self,
        asset_path: &str,
        source_time: f64,
        width: u32,
        height: u32,
    ) -> Result<DecodedFrame, String> {
        let key = CacheKey::new(asset_path, source_time, width, height);

        // 1. 查缓存
        if let Some(frame) = self.cache.get(&key).cloned() {
            self.touch_lru(&key);
            return Ok(frame);
        }

        // 2. 缓存未命中 → FFmpeg 抽帧
        let frame = Self::do_decode(asset_path, source_time, width, height, self.use_accurate_seek)?;

        // 3. 写入缓存
        self.put(key, frame.clone());

        Ok(frame)
    }

    /// 并行预取多个帧（std::thread::scope）
    ///
    /// 每个请求在一个独立线程中解码，完成后串行写入缓存。
    /// 已在缓存中的请求会跳过。
    pub fn prefetch(&mut self, requests: &[PrefetchRequest]) {
        // 筛选出未命中的请求
        let to_fetch: Vec<(CacheKey, &PrefetchRequest)> = requests
            .iter()
            .filter_map(|req| {
                let key = CacheKey::new(&req.asset_path, req.source_time, req.width, req.height);
                if self.cache.contains_key(&key) {
                    None
                } else {
                    Some((key, req))
                }
            })
            .collect();

        if to_fetch.is_empty() {
            return;
        }

        // 并行解码（每个线程独立调 FFmpeg subprocess）
        let use_accurate = self.use_accurate_seek;
        let results: Mutex<Vec<(CacheKey, Result<DecodedFrame, String>)>> = Mutex::new(Vec::new());

        thread::scope(|s| {
            for (key, req) in &to_fetch {
                let results = &results;
                let asset_path = &req.asset_path;
                let source_time = req.source_time;
                let width = req.width;
                let height = req.height;
                let key = key.clone();

                s.spawn(move || {
                    let result =
                        Self::do_decode(asset_path, source_time, width, height, use_accurate);
                    results.lock().unwrap().push((key, result));
                });
            }
        });

        // 串行写入缓存
        let mut guard = results.lock().unwrap();
        for (key, result) in guard.drain(..) {
            if let Ok(frame) = result {
                self.put(key, frame);
            }
            // 解码失败的请求静默跳过（不污染缓存）
        }
    }

    /// 获取当前缓存大小
    pub fn cache_size(&self) -> usize {
        self.cache.len()
    }

    /// 清空缓存
    pub fn clear(&mut self) {
        self.cache.clear();
        self.lru_order.clear();
    }

    // ── 内部方法 ──

    /// 调 FFmpeg 抽取单帧（RGBA rawvideo → stdout → 解析）
    fn do_decode(
        asset_path: &str,
        source_time: f64,
        width: u32,
        height: u32,
        accurate: bool,
    ) -> Result<DecodedFrame, String> {
        let args = if accurate {
            crate::ffmpeg::build_extract_frame_accurate(asset_path, source_time, width, height)
        } else {
            crate::ffmpeg::build_extract_frame_cmd(asset_path, source_time, width, height)
        };

        // args[0] = "ffmpeg"
        let output = Command::new(&args[0])
            .args(&args[1..])
            .output()
            .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg decode failed: {}", stderr.chars().take(500).collect::<String>()));
        }

        let expected_len = (width as usize) * (height as usize) * 4;
        let data = if output.stdout.len() == expected_len {
            output.stdout
        } else if output.stdout.len() > expected_len {
            // FFmpeg 可能输出多余字节，截取前 expected_len
            output.stdout[..expected_len].to_vec()
        } else {
            return Err(format!(
                "ffmpeg output too short: got {} bytes, expected {}",
                output.stdout.len(),
                expected_len
            ));
        };

        Ok(DecodedFrame {
            width,
            height,
            data,
            source_time,
        })
    }

    /// 写入缓存，超限时 LRU 淘汰
    fn put(&mut self, key: CacheKey, frame: DecodedFrame) {
        // 如果键已存在，先移除旧条目
        if self.cache.remove(&key).is_some() {
            self.lru_order.retain(|k| k != &key);
        }

        // LRU 淘汰
        while self.cache.len() >= self.capacity {
            if let Some(oldest) = self.lru_order.pop_front() {
                self.cache.remove(&oldest);
            } else {
                break;
            }
        }

        self.cache.insert(key.clone(), frame);
        self.lru_order.push_back(key);
    }

    /// 标记某键为最近访问（移到 LRU 队尾）
    fn touch_lru(&mut self, key: &CacheKey) {
        if let Some(pos) = self.lru_order.iter().position(|k| k == key) {
            let k = self.lru_order.remove(pos).unwrap();
            self.lru_order.push_back(k);
        }
    }
}

impl Default for DecoderPool {
    fn default() -> Self {
        Self::new(32)
    }
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_quantization() {
        // 相同毫秒的时间应映射到同一缓存键
        let k1 = CacheKey::new("video.mp4", 1.2345, 1920, 1080);
        let k2 = CacheKey::new("video.mp4", 1.2346, 1920, 1080);
        assert_eq!(k1, k2, "times within 1ms should share cache key");

        // 不同毫秒应映射到不同键
        let k3 = CacheKey::new("video.mp4", 1.236, 1920, 1080);
        assert_ne!(k1, k3, "times >1ms apart should have different keys");

        // 不同分辨率应映射到不同键
        let k4 = CacheKey::new("video.mp4", 1.2345, 1280, 720);
        assert_ne!(k1, k4, "different resolutions should have different keys");

        // 不同路径应映射到不同键
        let k5 = CacheKey::new("other.mp4", 1.2345, 1920, 1080);
        assert_ne!(k1, k5, "different paths should have different keys");
    }

    #[test]
    fn test_lru_eviction() {
        let mut pool = DecoderPool::new(3);

        // 填入 3 帧
        let f1 = DecodedFrame::black(100, 100, 0.0);
        let f2 = DecodedFrame::black(100, 100, 1.0);
        let f3 = DecodedFrame::black(100, 100, 2.0);

        pool.put(CacheKey::new("a.mp4", 0.0, 100, 100), f1);
        pool.put(CacheKey::new("a.mp4", 1.0, 100, 100), f2);
        pool.put(CacheKey::new("a.mp4", 2.0, 100, 100), f3);

        assert_eq!(pool.cache_size(), 3);

        // 访问第一帧（使其成为最近使用）
        let key1 = CacheKey::new("a.mp4", 0.0, 100, 100);
        pool.touch_lru(&key1);

        // 插入第 4 帧 → 应淘汰第二帧（最久未使用）
        let f4 = DecodedFrame::black(100, 100, 3.0);
        pool.put(CacheKey::new("a.mp4", 3.0, 100, 100), f4);

        assert_eq!(pool.cache_size(), 3);
        assert!(pool.cache.contains_key(&CacheKey::new("a.mp4", 0.0, 100, 100)), "touched frame should survive");
        assert!(!pool.cache.contains_key(&CacheKey::new("a.mp4", 1.0, 100, 100)), "LRU victim should be evicted");
        assert!(pool.cache.contains_key(&CacheKey::new("a.mp4", 2.0, 100, 100)));
        assert!(pool.cache.contains_key(&CacheKey::new("a.mp4", 3.0, 100, 100)));
    }

    #[test]
    fn test_black_frame() {
        let frame = DecodedFrame::black(4, 2, 0.0);
        assert_eq!(frame.width, 4);
        assert_eq!(frame.height, 2);
        assert_eq!(frame.data.len(), 4 * 2 * 4);
        // 每个像素应为 (0, 0, 0, 255)
        for chunk in frame.data.chunks_exact(4) {
            assert_eq!(chunk, &[0, 0, 0, 255]);
        }
    }

    #[test]
    fn test_transparent_frame() {
        let frame = DecodedFrame::transparent(2, 2, 0.0);
        assert_eq!(frame.data.len(), 2 * 2 * 4);
        // 每个像素应为 (0, 0, 0, 0)
        for chunk in frame.data.chunks_exact(4) {
            assert_eq!(chunk, &[0, 0, 0, 0]);
        }
    }

    #[test]
    fn test_to_video_frame() {
        let frame = DecodedFrame::black(10, 10, 1.5);
        let vf = frame.to_video_frame(2.0, "asset-001");
        assert_eq!(vf.width, 10);
        assert_eq!(vf.height, 10);
        assert_eq!(vf.format, PixelFormat::Rgba8);
        assert_eq!(vf.timestamp, 2.0);
        assert_eq!(vf.source_asset_id, "asset-001");
        assert_eq!(vf.source_time, 1.5);
    }

    #[test]
    fn test_clear_cache() {
        let mut pool = DecoderPool::new(5);
        pool.put(
            CacheKey::new("a.mp4", 0.0, 100, 100),
            DecodedFrame::black(100, 100, 0.0),
        );
        assert_eq!(pool.cache_size(), 1);

        pool.clear();
        assert_eq!(pool.cache_size(), 0);
    }

    #[test]
    fn test_prefetch_filters_cached() {
        // prefetch 应跳过已在缓存中的请求
        let mut pool = DecoderPool::new(10);

        // 预填入缓存（用一个无法解码的假路径，但先手动 put）
        let key = CacheKey::new("fake.mp4", 0.0, 10, 10);
        pool.put(key, DecodedFrame::black(10, 10, 0.0));

        let requests = vec![PrefetchRequest {
            asset_path: "fake.mp4".to_string(),
            source_time: 0.0,
            width: 10,
            height: 10,
        }];

        // prefetch 应跳过（已在缓存），不触发 FFmpeg
        pool.prefetch(&requests);
        assert_eq!(pool.cache_size(), 1, "cached request should be skipped");
    }

    #[test]
    fn test_default_capacity() {
        let pool = DecoderPool::default();
        assert_eq!(pool.capacity, 32);
        assert_eq!(pool.cache_size(), 0);
    }

    #[test]
    fn test_put_overwrite() {
        let mut pool = DecoderPool::new(5);
        let key = CacheKey::new("a.mp4", 0.0, 10, 10);

        pool.put(key.clone(), DecodedFrame::black(10, 10, 0.0));
        assert_eq!(pool.cache_size(), 1);

        // 同键再 put 应覆盖，不增加大小
        pool.put(key.clone(), DecodedFrame::transparent(10, 10, 0.0));
        assert_eq!(pool.cache_size(), 1);

        // 验证内容被覆盖
        let frame = pool.cache.get(&key).unwrap();
        assert_eq!(frame.data[3], 0, "should be transparent after overwrite");
    }
}
