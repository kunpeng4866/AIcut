//! src/graph.rs — 滤镜图构建器
//! FilterGraphBuilder + build_render_command + 公共 API

use crate::ffmpeg;
use crate::project::{Clip, Project, Track};
use crate::types::*;
use std::collections::HashMap;

// ════════════════════ 曲线变速 ════════════════════

use crate::filters::{build_clip_filters, build_filter_spec, build_mask_spec, fmt};

/// 从 SpeedPoint 数组构建分段线性 setpts 表达式。
pub fn build_speed_curve_expr(points: &[crate::project::SpeedPoint]) -> Option<String> {
    if points.len() < 2 { return None; }
    let last = points.len() - 1;
    let pf = &points[last]; let pn = &points[last - 1];
    let dt_f = pf.src - pn.src; let dp_f = pf.play - pn.play;
    let rate_f = if dt_f.abs() > 1e-6 { dp_f / dt_f } else { 1.0 };
    let offset_f = pf.play - rate_f * pf.src;
    let mut expr = format!("{}*PTS", fmt(rate_f));
    if offset_f.abs() > 1e-6 { expr.push_str(&format!("{:+}", offset_f)); }
    for i in (1..points.len() - 1).rev() {
        let p0 = &points[i - 1]; let p1 = &points[i];
        let dt = p1.src - p0.src; let dp = p1.play - p0.play;
        if dt.abs() < 1e-6 { continue; }
        let rate = dp / dt; let offset = p0.play - rate * p0.src;
        let mut seg = format!("{}*PTS", fmt(rate));
        if offset.abs() > 1e-6 { seg.push_str(&format!("{:+}", offset)); }
        expr = format!("if(lt(T,{}),{},{})", fmt(p1.src), seg, expr);
    }
    Some(expr)
}

// ════════════════════ FilterGraphBuilder ════════════════════

/// 从关键帧轨道采样属性值；无关键帧则回退 base。取 clip 中位时间近似。
fn keyframed(clip: &Clip, path: &str, base: f64) -> f64 {
    clip.keyframes.get(path)
        .map(|t| { let mid = (clip.timeline_in + clip.timeline_out) * 0.5; t.sample(mid) })
        .unwrap_or(base)
}

fn build_clip_chain(c: &Clip, ci: usize, asset_to_idx: &HashMap<String, usize>, w: u32, h: u32, nodes: &mut Vec<String>) -> Option<String> {
    let idx = *asset_to_idx.get(&c.asset_id)?;
    let label = format!("vs{}", ci);
    let chain = build_video_chain(c, idx, w, h, &label);
    nodes.push(chain);
    Some(label)
}

fn build_video_chain(c: &Clip, idx: usize, w: u32, h: u32, label: &str) -> String {
    let sx = keyframed(c, "transform.scaleX", c.transform.scale_x).max(0.01);
    let sy = keyframed(c, "transform.scaleY", c.transform.scale_y).max(0.01);
    let sw = (w as f64 * sx).round() as u32;
    let sh = (h as f64 * sy).round() as u32;
    let mut chain = format!("[{}:v]scale={}:{}", idx, sw, sh);
    // 曲线变速优先，否则线性变速
    if let Some(expr) = build_speed_curve_expr(&c.speed_curve) {
        chain.push_str(&format!(",setpts={}", expr));
    } else if (c.speed - 1.0).abs() > 0.001 {
        chain.push_str(&format!(",setpts={}*PTS", fmt(1.0 / c.speed)));
    }
    let rot = keyframed(c, "transform.rotation", c.transform.rotation);
    if rot.abs() > 0.01 { chain.push_str(&format!(",rotate={}*PI/180", fmt(rot))); }
    let clip_filters = build_clip_filters(c).unwrap_or_default();
    if !clip_filters.is_empty() { chain.push_str(&format!(",{}", clip_filters)); }
    for mask in &c.masks {
        if let Some(s) = build_mask_spec(mask) { chain.push_str(&format!(",{}", s)); }
    }
    let opacity = keyframed(c, "transform.opacity", c.transform.opacity).clamp(0.0, 1.0);
    if opacity < 1.0 { chain.push_str(&format!(",colorchannelmixer=aa={}", fmt(opacity))); }
    chain.push_str(&format!("[{}]", label));
    chain
}

fn offset_x(c: &Clip, w: u32) -> i64 {
    let x = keyframed(c, "transform.x", c.transform.x);
    ((x - 0.5) * w as f64).round() as i64
}

fn offset_y(c: &Clip, h: u32) -> i64 {
    let y = keyframed(c, "transform.y", c.transform.y);
    ((0.5 - y) * h as f64).round() as i64
}

pub struct FilterGraphBuilder;

impl FilterGraphBuilder {
    pub fn build(project: &Project) -> ffmpeg::RenderCommand { build_render_command(project) }
}

/// 核心：构建 RenderCommand
pub fn build_render_command(project: &Project) -> ffmpeg::RenderCommand {
    let mut cmd = ffmpeg::RenderCommand::default();
    let (w, h) = (project.canvas.width, project.canvas.height);
    cmd.resolution = (w, h);
    cmd.fps = project.canvas.fps;
    cmd.bitrate = ffmpeg::bitrate_for_resolution((w, h));
    let mut sorted: Vec<&Track> = project.tracks.iter().collect();
    sorted.sort_by_key(|t| t.order);
    let mut video_clips: Vec<(usize, &Clip)> = Vec::new();
    let mut audio_clips: Vec<&Clip> = Vec::new();
    for t in &sorted {
        for c in &t.clips {
            if t.track_type == "audio" { audio_clips.push(c); }
            else { video_clips.push((t.order as usize, c)); }
        }
    }
    let mut asset_to_idx: HashMap<String, usize> = HashMap::new();
    let mut inputs: Vec<String> = Vec::new();
    for (_, c) in &video_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) { asset_to_idx.insert(a.id.clone(), inputs.len()); inputs.push(a.path.clone()); }
        }
    }
    for c in &audio_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) { asset_to_idx.insert(a.id.clone(), inputs.len()); inputs.push(a.path.clone()); }
        }
    }
    cmd.inputs = inputs;
    let mut nodes: Vec<String> = Vec::new();
    // 视频滤镜图: 按轨道分组
    let video_tracks: Vec<(usize, Vec<&Clip>)> = {
        let mut groups: HashMap<usize, Vec<&Clip>> = HashMap::new();
        for (order, c) in &video_clips { groups.entry(*order).or_default().push(c); }
        let mut entries: Vec<_> = groups.into_iter().collect();
        entries.sort_by_key(|(k, _)| *k);
        entries
    };
    let mut vout_label = String::new();
    if !video_tracks.is_empty() {
        nodes.push(format!("color=c=black:s={}x{}[base]", w, h));
        let mut acc = "base".to_string();
        let mut vci = 0usize;
        for (track_order, clips) in &video_tracks {
            if clips.is_empty() { continue; }
            if clips.len() == 1 {
                let c = clips[0];
                let idx = match asset_to_idx.get(&c.asset_id) { Some(i) => *i, None => { vci += 1; continue; } };
                let src = format!("vs{}", vci);
                let chain = build_video_chain(c, idx, w, h, &src);
                nodes.push(chain);
                let next_acc = format!("va{}", vci + 1);
                let ox = offset_x(c, w); let oy = offset_y(c, h);
                nodes.push(format!("[{}][{}]overlay=x={}:y={}:shortest=1[{}]", acc, src, ox, oy, next_acc));
                acc = next_acc; vci += 1;
            } else {
                let Some(mut track_acc) = build_clip_chain(clips[0], vci, &asset_to_idx, w, h, &mut nodes) else { vci += 1; continue; };
                vci += 1;
                for ci in 1..clips.len() {
                    let prev = clips[ci - 1]; let curr = clips[ci];
                    let gap = curr.timeline_in - prev.timeline_out;
                    let has_transition = prev.filters.iter().any(|f| f.kind == "transition" && f.enabled)
                        || curr.filters.iter().any(|f| f.kind == "transition" && f.enabled);
                    let Some(curr_label) = build_clip_chain(curr, vci, &asset_to_idx, w, h, &mut nodes) else { vci += 1; continue; };
                    vci += 1;
                    if has_transition && gap <= 0.0 {
                        let xdur = (-gap).min(1.0).max(0.1);
                        let xstyle = prev.filters.iter().chain(curr.filters.iter())
                            .find(|f| f.kind == "transition" && f.enabled)
                            .and_then(|f| f.params.get("style"))
                            .map(|&s| match s as i32 { 1=>"dissolve",2=>"wipeleft",3=>"wiperight",4=>"wipeup",5=>"wipedown",6=>"slideleft",7=>"slideright",8=>"slideup",9=>"slidedown",_=>"fade"})
                            .unwrap_or("fade");
                        let merged = format!("x{}", vci);
                        nodes.push(format!("[{}][{}]xfade=transition={}:duration={}:offset={}:fps={}[{}]",
                            track_acc, curr_label, xstyle, fmt(xdur),
                            fmt((prev.timeline_out - prev.timeline_in) - xdur), project.canvas.fps, merged));
                        track_acc = merged;
                    } else {
                        let merged = format!("x{}", vci);
                        nodes.push(format!("[{}][{}]concat=n=2:v=1:a=0[{}]", track_acc, curr_label, merged));
                        track_acc = merged;
                    }
                }
                let next_acc = format!("va{}", vci + 1);
                if *track_order == 0 && acc == "base" { nodes.push(format!("[{}]null[{}]", track_acc, next_acc)); }
                else { nodes.push(format!("[{}][{}]overlay=x=0:y=0:shortest=1[{}]", acc, track_acc, next_acc)); }
                acc = next_acc;
            }
        }
        vout_label = format!("[{}]", acc);
    }
    // 音频滤镜图
    let mut aout_label = String::new();
    if !audio_clips.is_empty() {
        let mut audio_parts: Vec<String> = Vec::new();
        for (ai, c) in audio_clips.iter().enumerate() {
            let idx = match asset_to_idx.get(&c.asset_id) { Some(i) => *i, None => continue, };
            let alabel = format!("a{}", ai);
            let mut achain = format!("[{}:a]", idx);
            let vol = keyframed(c, "volume", c.volume).clamp(0.0, 2.0);
            if (vol - 1.0).abs() > 0.01 { achain.push_str(&format!("volume={}", fmt(vol))); }
            else { achain.push_str("anull"); }
            if (c.speed - 1.0).abs() > 0.001 { let tempo = c.speed.clamp(0.5, 2.0); achain.push_str(&format!(",atempo={}", fmt(tempo))); }
            for f in &c.filters {
                if !f.enabled { continue; }
                if let Some(s) = build_filter_spec(&f.kind, &f.params) {
                    if f.kind == "denoise" || f.kind == "equalizer" { achain.push_str(&format!(",{}", s)); }
                }
            }
            achain.push_str(&format!("[{}]", alabel));
            audio_parts.push(achain);
        }
        if audio_parts.len() == 1 { aout_label = format!("[a0]"); }
        else {
            let mut mix_inputs = Vec::new();
            for ai in 0..audio_parts.len() { mix_inputs.push(format!("[a{}]", ai)); }
            audio_parts.push(format!("{}amix=inputs={}:duration=first[aout]", mix_inputs.join(""), mix_inputs.len()));
            aout_label = "[aout]".to_string();
        }
        nodes.extend(audio_parts);
    } else if !video_clips.is_empty() {
        // 无显式音频轨道时，自动从第一个视频输入提取音频
        aout_label = "[0:a]".to_string();
    }
    cmd.filter_graph = nodes.join(";");
    let map_label = format!("{}{}", vout_label, aout_label);
    if !map_label.is_empty() { cmd.map_label = Some(map_label); }
    cmd
}

/// 解析工程 JSON → 构建 FFmpeg 命令字符串
pub fn render_project_json(json: &str) -> anyhow::Result<String> {
    let project: Project = serde_json::from_str(json).map_err(|e| anyhow::anyhow!("工程 JSON 解析失败: {}", e))?;
    let cmd = build_render_command(&project);
    Ok(cmd.to_command_string())
}

/// 解析工程 JSON → 构建 RenderCommand（含缓存）
pub fn render_project(json: &str) -> anyhow::Result<ffmpeg::RenderCommand> {
    let project: Project = serde_json::from_str(json).map_err(|e| anyhow::anyhow!("工程 JSON 解析失败: {}", e))?;
    Ok(build_render_command(&project))
}

/// 可用滤镜预置名列表
pub fn get_preset_list() -> Vec<String> { crate::preset::preset_names() }

/// 版本字符串
pub fn engine_version() -> String { format!("aicut-engine {}", env!("CARGO_PKG_VERSION")) }
