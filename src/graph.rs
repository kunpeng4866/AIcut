//! src/graph.rs — 滤镜图构建器
//! FilterGraphBuilder + build_render_command + 公共 API

use crate::ffmpeg;
use crate::project::{Clip, Project, Track};
use crate::types::*;
use std::collections::HashMap;

// ════════════════════ 曲线变速 ════════════════════

use crate::filters::{build_clip_filters, build_filter_spec, build_mask_spec, fmt};

/// 从"速度曲线"构建分段线性 setpts 表达式。
///
/// 输入 curve 的每个关键帧 = (play, speed)，其中 play 为**归一化 [0,1]** 时间域，
/// speed 为**绝对速度倍率**（用户设定值，2.0 = 2×）。与后端 strategy.rs::clip_source_time 同模型：
/// `srcT = src_start + dur * ∫₀^play_i speed(τ) dτ`，整段素材恰好播完由前端 setCurveCommit
/// 反推 dur（`dur = srcDur / ∫₀^1 speed dτ`）保证。
///
/// 控制点 (src_i, play_i*dur)：src_i 为源时间（绝对秒），play_i*dur 为时间线秒，
/// 使源区间 [srcStart, srcEnd] 恰好映射到时间线 [0, dur]。build_piecewise_setpts_from_ctrl
/// 据此拼出与旧代码**完全相同形态**的分段线性 setpts（rate = Δplay_sec / Δsrc = 1 / 平均speed）。
/// 导出与预览一致，任意曲线形状（含局部 speed>1）都不越界定格。
///
/// 若曲线为空或控制点不足，返回 None，调用方回退到线性 speed 的 setpts。
pub fn build_speed_curve_expr(curve: &[crate::project::SpeedPoint], src_start: f64, dur: f64) -> Option<String> {
    if curve.len() < 2 { return None; }
    // 按 play 升序排序；控制点 (src_i, play_i*dur)
    let mut pts: Vec<&crate::project::SpeedPoint> = curve.iter().collect();
    pts.sort_by(|a, b| a.play.partial_cmp(&b.play).unwrap_or(std::cmp::Ordering::Equal));
    let ctrl: Vec<(f64, f64)> = pts.iter().map(|p| {
        let f = crate::pipeline::strategy::speed_integral(curve, p.play, 0.0); // ∫₀^play_i speed dτ（归一化）
        let src = src_start + dur * f;
        (src, p.play * dur)
    }).collect();
    build_piecewise_setpts_from_ctrl(&ctrl)
}

/// 用 (src, play) 控制点（按 src 升序）构建分段线性 setpts 表达式。
/// 结构与旧 build_speed_curve_expr 完全一致：以 `if(lt(T, src_i), seg, ...)` 分层，
/// 每段 `new_PTS = rate*PTS + offset`，其中 rate = (play 变化)/(src 变化)。
fn build_piecewise_setpts_from_ctrl(ctrl: &[(f64, f64)]) -> Option<String> {
    if ctrl.len() < 2 { return None; }
    let last = ctrl.len() - 1;
    let (sf, pf) = ctrl[last]; let (sn, pn) = ctrl[last - 1];
    let dt_f = sf - sn; let dp_f = pf - pn;
    let rate_f = if dt_f.abs() > 1e-6 { dp_f / dt_f } else { 1.0 };
    let offset_f = pf - rate_f * sf;
    let mut expr = format!("{}*PTS", fmt(rate_f));
    if offset_f.abs() > 1e-6 { expr.push_str(&format!("{:+}", offset_f)); }
    for i in (1..ctrl.len() - 1).rev() {
        let (s0, p0) = ctrl[i - 1]; let (s1, p1) = ctrl[i];
        let dt = s1 - s0; let dp = p1 - p0;
        if dt.abs() < 1e-6 { continue; }
        let rate = dp / dt; let offset = p0 - rate * s0;
        let mut seg = format!("{}*PTS", fmt(rate));
        if offset.abs() > 1e-6 { seg.push_str(&format!("{:+}", offset)); }
        expr = format!("if(lt(T,{}),{},{})", fmt(s1), seg, expr);
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

fn build_clip_chain(c: &Clip, ci: usize, asset_to_idx: &HashMap<String, usize>, w: u32, h: u32, nodes: &mut Vec<String>, fps: u32) -> Option<String> {
    let idx = *asset_to_idx.get(&c.asset_id)?;
    let label = format!("vs{}", ci);
    let chain = build_video_chain(c, idx, w, h, &label, fps);
    nodes.push(chain);
    Some(label)
}

fn build_video_chain(c: &Clip, idx: usize, w: u32, h: u32, label: &str, fps: u32) -> String {
    let sx = keyframed(c, "transform.scaleX", c.transform.scale_x).max(0.01);
    let sy = keyframed(c, "transform.scaleY", c.transform.scale_y).max(0.01);
    let sw = (w as f64 * sx).round() as u32;
    let sh = (h as f64 * sy).round() as u32;
    let mut chain = format!("[{}:v]scale={}:{}", idx, sw, sh);
    // 曲线变速优先（time_remap.curve 权威，否则回退 speed_curve），否则线性变速
    let curve = if !c.time_remap.curve.is_empty() { &c.time_remap.curve } else { &c.speed_curve };
    let dur = c.timeline_out - c.timeline_in;
    if let Some(expr) = build_speed_curve_expr(curve, c.src_range.start, dur) {
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
    // 统一输出帧率到画布 fps：xfade/overlay 要求各路输入帧率一致，否则 filter 配置失败
    // （如 24fps 与 30fps 素材直接 xfade 会报 framesync 错误）。放在变换链末尾、打标签前。
    chain.push_str(&format!(",fps={}", fps));
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
                let chain = build_video_chain(c, idx, w, h, &src, project.canvas.fps);
                nodes.push(chain);
                let next_acc = format!("va{}", vci + 1);
                let ox = offset_x(c, w); let oy = offset_y(c, h);
                nodes.push(format!("[{}][{}]overlay=x={}:y={}:shortest=1[{}]", acc, src, ox, oy, next_acc));
                acc = next_acc; vci += 1;
            } else {
                let Some(mut track_acc) = build_clip_chain(clips[0], vci, &asset_to_idx, w, h, &mut nodes, project.canvas.fps) else { vci += 1; continue; };
                vci += 1;
                for ci in 1..clips.len() {
                    let prev = clips[ci - 1]; let curr = clips[ci];
                    let gap = curr.timeline_in - prev.timeline_out;
                    let has_transition = prev.filters.iter().any(|f| f.kind == "transition" && f.enabled)
                        || curr.filters.iter().any(|f| f.kind == "transition" && f.enabled);
                    let Some(curr_label) = build_clip_chain(curr, vci, &asset_to_idx, w, h, &mut nodes, project.canvas.fps) else { vci += 1; continue; };
                    vci += 1;
                    if has_transition && gap <= 0.0 {
                        // 优先用用户设置的转场时长（filters params.duration），否则用两 clip 重叠时长
                        let trans_filter = prev.filters.iter().chain(curr.filters.iter())
                            .find(|f| f.kind == "transition" && f.enabled);
                        let xdur = trans_filter
                            .and_then(|f| f.params.get("duration"))
                            .copied()
                            .filter(|d| *d > 0.0)
                            .map(|d| d.min(5.0).max(0.1))
                            .unwrap_or_else(|| (-gap).min(1.0).max(0.1));
                        let xstyle = trans_filter
                            .and_then(|f| f.params.get("style"))
                            .map(|&s| match s as i32 { 1=>"dissolve",2=>"wipeleft",3=>"wiperight",4=>"wipeup",5=>"wipedown",6=>"slideleft",7=>"slideright",8=>"slideup",9=>"slidedown",_=>"fade"})
                            .unwrap_or("fade");
                        let merged = format!("x{}", vci);
                        // 注意：xfade 滤镜没有 fps 参数（会报 "Option not found"），
                        // 帧率一致由各路视频链末尾的 fps=<canvas.fps> 保证。
                        nodes.push(format!("[{}][{}]xfade=transition={}:duration={}:offset={}[{}]",
                            track_acc, curr_label, xstyle, fmt(xdur),
                            fmt((prev.timeline_out - prev.timeline_in) - xdur), merged));
                        track_acc = merged;
                    } else {
                        let merged = format!("x{}", vci);
                        nodes.push(format!("[{}][{}]concat=n=2:v=1:a=0[{}]", track_acc, curr_label, merged));
                        track_acc = merged;
                    }
                }
                let next_acc = format!("va{}", vci + 1);
                // base 必须被消费：单轨（主轨直接产出）也必须 overlay 到 base，否则 color 滤镜输出孤立导致 filtergraph 绑定失败
                nodes.push(format!("[{}][{}]overlay=x=0:y=0:shortest=1[{}]", acc, track_acc, next_acc));
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
