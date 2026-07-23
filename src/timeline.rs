//! src/timeline.rs — 时间线查询层
//!
//! 高效查询某时刻 t 的活跃片段集合。
//! clips 已按 timeline_in 排序，用 binary_search 快速定位。
//! 避免引入 rangemap crate，用 Vec + binary_search 实现。

use crate::project::{Clip, Project, Track};
use std::collections::HashMap;

// ════════════════════ ClipRef ════════════════════

/// 片段引用：指向 Project 中的片段，附带轨道信息
#[derive(Debug, Clone)]
pub struct ClipRef<'a> {
    pub clip: &'a Clip,
    pub track_id: &'a str,
    pub track_type: &'a str,
    pub track_order: usize,
    /// 片段在已排序数组中的索引
    pub index: usize,
}

/// 已排序的片段索引项（用于 binary_search）
#[derive(Debug, Clone, Copy)]
struct SortedEntry {
    timeline_in: f64,
    timeline_out: f64,
    /// 在扁平化数组中的索引
    flat_index: usize,
}

// ════════════════════ Timeline ════════════════════

/// 时间线查询层：预排序 + binary_search
pub struct Timeline<'a> {
    project: &'a Project,
    /// 按轨道分组的已排序片段索引
    track_entries: HashMap<String, Vec<SortedEntry>>,
    /// 扁平化的片段引用（按轨道顺序 → 片段顺序）
    flat_clips: Vec<ClipRef<'a>>,
    /// 工程总时长
    duration: f64,
}

impl<'a> Timeline<'a> {
    /// 从 Project 构建时间线查询层
    pub fn new(project: &'a Project) -> Self {
        let mut track_entries: HashMap<String, Vec<SortedEntry>> = HashMap::new();
        let mut flat_clips: Vec<ClipRef<'a>> = Vec::new();
        let mut duration = 0.0_f64;

        // 按轨道顺序排序
        let mut tracks: Vec<&Track> = project.tracks.iter().collect();
        tracks.sort_by_key(|t| t.order);

        let mut flat_index = 0usize;
        for track in &tracks {
            let mut entries: Vec<SortedEntry> = Vec::with_capacity(track.clips.len());
            // 片段按 timeline_in 排序（通常已有序，但保险起见再排一次）
            let mut clips_sorted: Vec<&Clip> = track.clips.iter().collect();
            clips_sorted.sort_by(|a, b| a.timeline_in.partial_cmp(&b.timeline_in).unwrap_or(std::cmp::Ordering::Equal));

            for clip in &clips_sorted {
                entries.push(SortedEntry {
                    timeline_in: clip.timeline_in,
                    timeline_out: clip.timeline_out,
                    flat_index,
                });
                flat_clips.push(ClipRef {
                    clip,
                    track_id: &track.id,
                    track_type: &track.track_type,
                    track_order: track.order as usize,
                    index: flat_clips.len(),
                });
                duration = duration.max(clip.timeline_out);
                flat_index += 1;
            }
            track_entries.insert(track.id.clone(), entries);
        }

        Self { project, track_entries, flat_clips, duration }
    }

    /// 工程总时长
    pub fn duration(&self) -> f64 { self.duration }

    /// 轨道数量
    pub fn track_count(&self) -> usize { self.project.tracks.len() }

    /// 片段总数
    pub fn clip_count(&self) -> usize { self.flat_clips.len() }

    /// 查询某时刻 t 的所有活跃片段（跨所有轨道）
    pub fn clips_at(&self, t: f64) -> Vec<&ClipRef<'a>> {
        let mut result = Vec::new();
        for entries in self.track_entries.values() {
            if let Some(idx) = self.binary_search_active(entries, t) {
                result.push(&self.flat_clips[idx]);
            }
        }
        result
    }

    /// 查询某轨道在时刻 t 的活跃片段
    pub fn clip_at(&self, track_id: &str, t: f64) -> Option<&ClipRef<'a>> {
        let entries = self.track_entries.get(track_id)?;
        let idx = self.binary_search_active(entries, t)?;
        Some(&self.flat_clips[idx])
    }

    /// 查询某时间范围 [start, end) 内的所有片段
    pub fn clips_in_range(&self, start: f64, end: f64) -> Vec<&ClipRef<'a>> {
        let mut result = Vec::new();
        for clip_ref in &self.flat_clips {
            // 片段与 [start, end) 有交集
            if clip_ref.clip.timeline_out > start && clip_ref.clip.timeline_in < end {
                result.push(clip_ref);
            }
        }
        result
    }

    /// 查询某轨道在某时间范围 [start, end) 内的片段
    pub fn track_clips_in_range(&self, track_id: &str, start: f64, end: f64) -> Vec<&ClipRef<'a>> {
        let entries = match self.track_entries.get(track_id) {
            Some(e) => e,
            None => return Vec::new(),
        };
        let mut result = Vec::new();
        // binary_search 找到第一个可能相交的片段
        let start_idx = entries.partition_point(|e| e.timeline_out <= start);
        for entry in &entries[start_idx..] {
            if entry.timeline_in >= end { break; }
            // 有交集
            if entry.timeline_out > start && entry.timeline_in < end {
                result.push(&self.flat_clips[entry.flat_index]);
            }
        }
        result
    }

    /// 获取所有视频轨道片段（按轨道顺序 → 时间顺序）
    pub fn video_clips(&self) -> Vec<&ClipRef<'a>> {
        self.flat_clips.iter().filter(|c| c.track_type == "video" || c.track_type == "effect").collect()
    }

    /// 获取所有音频轨道片段
    pub fn audio_clips(&self) -> Vec<&ClipRef<'a>> {
        self.flat_clips.iter().filter(|c| c.track_type == "audio").collect()
    }

    /// 获取所有文字轨道片段
    pub fn text_clips(&self) -> Vec<&ClipRef<'a>> {
        self.flat_clips.iter().filter(|c| c.track_type == "text").collect()
    }

    /// 获取所有轨道 ID（按 order 排序）
    pub fn track_ids(&self) -> Vec<&str> {
        let mut tracks: Vec<&Track> = self.project.tracks.iter().collect();
        tracks.sort_by_key(|t| t.order);
        tracks.iter().map(|t| t.id.as_str()).collect()
    }

    // ── 内部：binary_search 查找活跃片段 ──

    /// 在已排序的片段索引中，用 binary_search 找到时刻 t 的活跃片段
    fn binary_search_active(&self, entries: &[SortedEntry], t: f64) -> Option<usize> {
        if entries.is_empty() { return None; }
        // binary_search_by_key 找到第一个 timeline_in > t 的位置
        let pos = entries.partition_point(|e| e.timeline_in <= t);
        // 检查 pos-1 位置（最后一个 timeline_in <= t 的片段）
        if pos > 0 {
            let candidate = &entries[pos - 1];
            if t >= candidate.timeline_in && t < candidate.timeline_out {
                return Some(candidate.flat_index);
            }
        }
        // 也检查 pos 位置（可能 timeline_in == t 的精确匹配）
        if pos < entries.len() {
            let candidate = &entries[pos];
            if t >= candidate.timeline_in && t < candidate.timeline_out {
                return Some(candidate.flat_index);
            }
        }
        None
    }
}

// ════════════════════ 单元测试 ════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{CanvasConfig, Project, Track, Clip, Transform, SpeedPoint, Range};

    fn make_clip(id: &str, in_t: f64, out_t: f64) -> Clip {
        Clip {
            id: id.to_string(),
            asset_id: "a1".to_string(),
            src_range: Range { start: 0.0, end: out_t - in_t },
            timeline_in: in_t,
            timeline_out: out_t,
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
            assets: Vec::new(),
            tracks: vec![
                Track { id: "t1".to_string(), track_type: "video".to_string(), order: 0, clips: vec![
                    make_clip("c1", 0.0, 5.0),
                    make_clip("c2", 5.0, 10.0),
                    make_clip("c3", 10.0, 15.0),
                ], ..Default::default()},
                Track { id: "t2".to_string(), track_type: "audio".to_string(), order: 1, clips: vec![
                    make_clip("a1", 2.0, 8.0),
                ], ..Default::default()},
            ],
        }
    }

    #[test]
    fn test_duration() {
        let p = make_project();
        let tl = Timeline::new(&p);
        assert_eq!(tl.duration(), 15.0);
    }

    #[test]
    fn test_clips_at() {
        let p = make_project();
        let tl = Timeline::new(&p);
        // t=3.0: c1 on t1, a1 on t2
        let clips = tl.clips_at(3.0);
        assert_eq!(clips.len(), 2);
        // t=7.0: c2 on t1, a1 on t2
        let clips = tl.clips_at(7.0);
        assert_eq!(clips.len(), 2);
        // t=12.0: c3 on t1, no audio
        let clips = tl.clips_at(12.0);
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].clip.id, "c3");
    }

    #[test]
    fn test_clip_at_specific_track() {
        let p = make_project();
        let tl = Timeline::new(&p);
        assert_eq!(tl.clip_at("t1", 3.0).unwrap().clip.id, "c1");
        assert_eq!(tl.clip_at("t1", 7.0).unwrap().clip.id, "c2");
        assert_eq!(tl.clip_at("t1", 12.0).unwrap().clip.id, "c3");
        assert!(tl.clip_at("t1", 20.0).is_none());
    }

    #[test]
    fn test_clips_in_range() {
        let p = make_project();
        let tl = Timeline::new(&p);
        // [4.0, 6.0) intersects c1(0-5), c2(5-10), a1(2-8)
        let clips = tl.clips_in_range(4.0, 6.0);
        assert_eq!(clips.len(), 3);
    }

    #[test]
    fn test_track_clips_in_range() {
        let p = make_project();
        let tl = Timeline::new(&p);
        // [4.0, 11.0) intersects c1(0-5), c2(5-10), c3(10-15)
        let clips = tl.track_clips_in_range("t1", 4.0, 11.0);
        assert_eq!(clips.len(), 3);
        // [4.0, 10.0) intersects c1(0-5), c2(5-10) only
        let clips = tl.track_clips_in_range("t1", 4.0, 10.0);
        assert_eq!(clips.len(), 2);
    }

    #[test]
    fn test_video_audio_clips() {
        let p = make_project();
        let tl = Timeline::new(&p);
        assert_eq!(tl.video_clips().len(), 3);
        assert_eq!(tl.audio_clips().len(), 1);
    }
}
