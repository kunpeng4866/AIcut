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
    // 蒙版依次串接：每个 mask 通过 geq 把形状外像素 RGB 乘 0（黑色遮罩，叠加在黑色 base 上即透明）。
    // 因此多个 mask 呈「交集(AND)」叠加——像素需同时满足所有 mask 才可见。
    // MVP 导出路径未实现真正的「并集(OR)」；如需并集应改用 alpha 通道 max 合成（见 build_mask_spec 注释）。
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
                // 累积时间线原点 = 本轨首个片段的主时间线起点。xfade 的 offset 是相对
                // 累积视频流时间轴的，而转场窗锚点在出片段（prev）的主时间线
                // [prev.timeline_out - xdur, prev.timeline_out]。两者相减才得到正确的 offset；
                // 错误地用 (prev.timeline_out - prev.timeline_in) 会按"上一段自身时长"偏移，
                // 第 2 个及以后的 xfade 把时间轴算短，多片段工程视频被截断。
                let master_origin = clips[0].timeline_in;
                for ci in 1..clips.len() {
                    let prev = clips[ci - 1]; let curr = clips[ci];
                    let gap = curr.timeline_in - prev.timeline_out;
                    // 转场挂在出片段（prev）的 clip.transition（GUI 写入位置），兼容 filters[kind=transition]
                    let trans_opt = clip_transition(prev).or_else(|| clip_transition(curr));
                    let trans_params = clip_transition_params(prev).or_else(|| clip_transition_params(curr));
                    let has_transition = trans_opt.is_some() && gap <= 0.0;
                    let Some(curr_label) = build_clip_chain(curr, vci, &asset_to_idx, w, h, &mut nodes, project.canvas.fps) else { vci += 1; continue; };
                    vci += 1;
                    if has_transition {
                        let (xstyle, xdur_raw) = trans_opt.unwrap();
                        let xdur = xdur_raw.min(5.0).max(0.1);
                        let merged = format!("x{}", vci);
                        // 注意：xfade 滤镜没有 fps 参数（会报 "Option not found"），
                        // 帧率一致由各路视频链末尾的 fps=<canvas.fps> 保证。
                        // xfade 无 easing 参数，xfade 自带缓动近似，无需额外处理。
                        // offset 相对累积视频流时间轴：转场窗起点（主时间线） - 轨道原点。
                        let offset = (prev.timeline_out - xdur) - master_origin;
                        nodes.push(format!("[{}][{}]xfade=transition={}:duration={}:offset={}[{}]",
                            track_acc, curr_label, xstyle, fmt(xdur),
                            fmt(offset), merged));
                        track_acc = merged.clone();
                        // feather：xfade 的 wipe/circle 无原生软边参数；
                        // feather>0 时在 xfade 输出后追加 gblur（按 feather 折算 sigma）近似软边。
                        if let Some((_, _, _, feather, _, _)) = trans_params {
                            let is_wipe = xstyle.starts_with("wipe") || xstyle == "circleopen";
                            if is_wipe && feather > 0.0 {
                                let sigma = (feather * 0.25).max(0.3);
                                let blurred = format!("xb{}", vci);
                                nodes.push(format!("[{}]gblur=sigma={:.2}[{}]", merged, sigma, blurred));
                                track_acc = blurred;
                            }
                        }
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
    // 音频滤镜图：per-clip 音频流 + 转场 equal-power 交叉淡化
    // 模型与 export.rs::render_audio_chunk / 预览 transitionUtils.audioCrossfadeEnv 一致：
    //   出片段在转场窗 [outT-dur, outT] 乘 cos(progress·π/2)（1→0 淡出）
    //   入片段在同窗乘 sin(progress·π/2)（0→1 淡入）
    //   窗外保持原增益。最后统一 amix(normalize=0) 保留 equal-power 合成，alimiter 限幅防削波。
    // 音频源：有 audio 轨则取 audio 轨片段；否则取 video/effect 轨自带音频（与旧逻辑一致）。
    let mut aout_label = String::new();
    let audio_source_clips: Vec<&Clip> = if !audio_clips.is_empty() {
        audio_clips.clone()
    } else {
        video_clips.iter().map(|(_, c)| *c).collect()
    };
    if !audio_source_clips.is_empty() {
        let mut audio_labels: Vec<String> = Vec::new();
        let mut audio_nodes: Vec<String> = Vec::new();
        for c in &audio_source_clips {
            let trk = project.tracks.iter().find(|t| t.clips.iter().any(|cc| cc.id == c.id));
            let track_vol = trk.map(|t| t.volume).unwrap_or(1.0);
            let idx = match asset_to_idx.get(&c.asset_id) { Some(i) => *i, None => continue };
            let label = format!("a{}", audio_labels.len());
            let envelopes = audio_transition_envelopes(c, trk);
            audio_nodes.push(build_clip_audio_node(c, idx, track_vol, &label, &envelopes));
            audio_labels.push(label);
        }
        if audio_labels.len() == 1 {
            aout_label = format!("[{}]", audio_labels[0]);
        } else if audio_labels.len() > 1 {
            let joined = audio_labels.iter().map(|l| format!("[{}]", l)).collect::<Vec<_>>().join("");
            // normalize=0：保留 equal-power 合成（否则 amix 按输入数归一化会衰减交叉淡化）
            // alimiter：equal-power 峰值可达 √2，限幅到 1.0 防 AAC 削波（对应 export.rs 的 clamp(-1,1)）
            audio_nodes.push(format!("{}amix=inputs={}:normalize=0:duration=longest,alimiter=limit=1:asc=1[aout]", joined, audio_labels.len()));
            aout_label = "[aout]".to_string();
        }
        nodes.extend(audio_nodes);
    }
    cmd.filter_graph = nodes.join(";");
    let mut map_labels: Vec<String> = Vec::new();
    if !vout_label.is_empty() { map_labels.push(vout_label); }
    if !aout_label.is_empty() { map_labels.push(aout_label); }
    if !map_labels.is_empty() { cmd.map_labels = map_labels; }
    cmd
}

/// 将 GUI 的转场类型 + 方向映射为 ffmpeg xfade 的 style 名。
/// xfade 无原生 zoom，用 dissolve 近似（缩放感由预览提供，导出走 dissolve 交叉淡化）；
/// xfade 无 easing 参数，自带缓动近似（注释说明，无额外处理）。
/// wipe + circle 的圆形展开不在此处理（无 mask_shape 入参），由 clip_transition_params 改用 circleopen。
fn transition_style(t: &str, dir: &str) -> String {
    match t {
        "fade" => "fade".to_string(),
        "dissolve" => "dissolve".to_string(),
        "slide" => match dir {
            "left" => "slideleft", "right" => "slideright",
            "up" => "slideup", "down" => "slidedown",
            _ => "slideright",
        }.to_string(),
        "wipe" => match dir {
            "left" => "wipeleft", "right" => "wiperight",
            "up" => "wipeup", "down" => "wipedown",
            _ => "wipeleft",
        }.to_string(),
        // 新增转场：xfade 无原生 zoom，用 dissolve 近似
        "zoom" => "dissolve".to_string(),
        // blur：xfade 支持 hblur 水平模糊过渡
        "blur" => "hblur".to_string(),
        // flash：xfade 支持 fadewhite 白场闪变
        "flash" => "fadewhite".to_string(),
        _ => "fade".to_string(),
    }
}

/// 读取 clip 的转场全部参数（顶层 clip.transition 优先，兼容 filters[kind=transition]）。
/// 返回 (xfade_style, duration, easing, feather, mask_shape, blur_amount)。无激活转场返回 None。
///
/// 注意：GUI（PropertiesPanel）把转场写入顶层 `clip.transition`，导出必须读这里，
/// 否则转场在预览可见、导出却消失（历史 bug）。
///
/// wipe + circle 用 xfade 原生 `circleopen`（圆形展开）；其余新类型在 transition_style 映射。
/// easing / feather / mask_shape / blur_amount 这几个字段 export.rs（逐帧路径）消费；
/// ffmpeg 路径仅 feather 对 wipe/circle 生效（boxblur 软边近似，见 build_render_command）。
fn clip_transition_params(clip: &Clip) -> Option<(String, f64, String, f64, String, f64)> {
    if let Some(tr) = &clip.transition {
        if tr.transition_type != "none" && tr.duration > 0.0 {
            // wipe + circle → circleopen 圆形展开
            let mut style = transition_style(&tr.transition_type, &tr.direction);
            if tr.transition_type == "wipe" && tr.mask_shape == "circle" {
                style = "circleopen".to_string();
            }
            return Some((
                style,
                tr.duration,
                tr.easing.clone(),
                tr.feather,
                tr.mask_shape.clone(),
                tr.blur_amount,
            ));
        }
    }
    if let Some(f) = clip.filters.iter().find(|f| f.kind == "transition" && f.enabled) {
        let style = f.params.get("style")
            .map(|&s| match s as i32 { 1=>"dissolve",2=>"wipeleft",3=>"wiperight",4=>"wipeup",5=>"wipedown",6=>"slideleft",7=>"slideright",8=>"slideup",9=>"slidedown",_=>"fade" })
            .unwrap_or("fade").to_string();
        let dur = f.params.get("duration").copied().filter(|d| *d > 0.0).map(|d| d.min(5.0).max(0.1)).unwrap_or(0.5);
        // 旧 filters 路径无新字段，给合理默认值
        return Some((style, dur, "ease-in-out".to_string(), 10.0, "linear".to_string(), 65.0));
    }
    None
}

/// 读取 clip 的转场信息（顶层 clip.transition 优先，兼容 filters[kind=transition]）。
/// 返回 (xfade_style, duration)。无激活转场返回 None。
/// 注意：GUI（PropertiesPanel）把转场写入顶层 `clip.transition`，导出必须读这里，
/// 否则转场在预览可见、导出却消失（历史 bug）。
/// 兼容保留版，转发到 clip_transition_params。
fn clip_transition(clip: &Clip) -> Option<(String, f64)> {
    clip_transition_params(clip).map(|(s, d, _, _, _, _)| (s, d))
}

/// 读取片段激活转场时长（顶层 `clip.transition` 优先，兼容 `filters[kind=transition]`），
/// 无激活转场返回 None。数值夹到 [0.1, 5.0]（与视频 xfade 的 `xdur` 一致）。
fn clip_transition_duration(clip: &Clip) -> Option<f64> {
    clip_transition(clip).map(|(_, d)| d.min(5.0).max(0.1))
}

/// 返回片段的音频转场包络列表：`(tw0, dur, is_out)`。
/// `is_out=true` → 出片段，cos 淡出；`false` → 入片段，sin 淡入。
/// 判定与视频 xfade 完全一致：自身（或上一片段）有激活转场，且相邻片段 `gap <= 0`（重叠）。
fn audio_transition_envelopes(clip: &Clip, track: Option<&Track>) -> Vec<(f64, f64, bool)> {
    let mut v = Vec::new();
    let Some(trk) = track else { return v; };
    let mut clips: Vec<&Clip> = trk.clips.iter().collect();
    clips.sort_by(|a, b| a.timeline_in.partial_cmp(&b.timeline_in).unwrap_or(std::cmp::Ordering::Equal));
    let pos = match clips.iter().position(|c| c.id == clip.id) { Some(p) => p, None => return v };
    // 出片段：自身有激活转场，且下一片段 gap<=0
    if let Some(dur) = clip_transition_duration(clip) {
        if pos + 1 < clips.len() {
            let next = clips[pos + 1];
            if next.timeline_in - clip.timeline_out <= 0.0 {
                let tw0 = clip.timeline_out - dur;
                v.push((tw0, dur, true));
            }
        }
    }
    // 入片段：上一片段有激活转场指向本片段，且 gap<=0
    if pos > 0 {
        let prev = clips[pos - 1];
        if let Some(dur) = clip_transition_duration(prev) {
            if clip.timeline_in - prev.timeline_out <= 0.0 {
                let tw0 = prev.timeline_out - dur;
                v.push((tw0, dur, false));
            }
        }
    }
    v
}

/// 构建单片段音频滤镜链：
/// `[idx:a]` → atrim(源范围) → asetpts → atempo(变速) → volume(基础增益)
/// → adelay(定位到主时间线) → 转场 equal-power 包络(cos/sin) → `[label]`
///
/// 构建单片段音频滤镜链：
/// `[idx:a]` → atrim(源范围) → asetpts → atempo(变速) → volume(基础增益)
/// → afade(转场 equal-power 包络) → adelay(定位到主时间线) → `[label]`
///
/// 关键：afade 放在 adelay **之前**，在片段自己的干净本地时间轴（asetpts 后固定 [0,dur]）上做淡变，
/// 再用 adelay 把整段平移到主时间线。否则组合图里视频分支(xfade/overlay)会重定基音频 PTS，
/// 导致无 adelay 的片段(如首片段 timeline_in=0)其 afade `st` 指向错误时间轴、淡变错位。
/// afade 的 st 用本地时间 `tw0 - timeline_in`（即转场窗起点相对本片段起点的偏移）。
fn build_clip_audio_node(c: &Clip, idx: usize, track_vol: f64, label: &str, envelopes: &[(f64, f64, bool)]) -> String {
    let src_start = c.src_range.start;
    let src_dur = (c.src_range.end - c.src_range.start).max(0.01);
    // 注意：输入标签 `[idx:a]` 后必须直接接第一个滤镜（atrim），不能加逗号；
    // 逗号仅用于分隔同一条链内的滤镜。错误写法 `[idx:a],atrim=...` 会在标签后产生
    // 空滤镜 → ffmpeg 报 "No such filter: ''"（视频链 build_video_chain 无此逗号，故一直正常）。
    let mut chain = format!("[{}:a]atrim=start={}:duration={}", idx, fmt(src_start), fmt(src_dur));
    chain.push_str(",asetpts=PTS-STARTPTS");
    if (c.speed - 1.0).abs() > 0.001 {
        let tempo = c.speed.clamp(0.5, 2.0);
        chain.push_str(&format!(",atempo={}", fmt(tempo)));
    }
    let vol = keyframed(c, "volume", c.volume).clamp(0.0, 2.0) * track_vol;
    if (vol - 1.0).abs() > 0.01 {
        chain.push_str(&format!(",volume={}", fmt(vol)));
    }
    // 转场 equal-power 包络（afade, curve=qsin）：out=cos 淡出 / in=sin 淡入，与 export.rs / 预览一致。
    // 用本地时间轴 st = tw0 - timeline_in（转场窗起点相对本片段起点），置于 adelay 之前。
    for (tw0, dur, is_out) in envelopes {
        let st_local = (tw0 - c.timeline_in).max(0.0);
        let fade_t = if *is_out { "out" } else { "in" };
        chain.push_str(&format!(",afade=t={}:curve=qsin:st={}:d={}", fade_t, fmt(st_local), fmt(*dur)));
    }
    let delay_ms = (c.timeline_in * 1000.0).round() as i64;
    if delay_ms > 0 {
        chain.push_str(&format!(",adelay={}:all=1", delay_ms));
    }
    chain.push_str(&format!("[{}]", label));
    chain
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
