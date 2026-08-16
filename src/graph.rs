//! src/graph.rs — 滤镜图构建器
//! FilterGraphBuilder + build_render_command + 公共 API

use crate::ffmpeg;
use crate::ffmpeg::InputSpec;
use crate::project::{Clip, Project, Track};
use crate::subtitle;
use crate::types::*;
use std::collections::{HashMap, HashSet};
use std::process::Command;

// ════════════════════ 曲线变速 ════════════════════

use crate::filters::{build_clip_filters, build_filter_spec, build_keying_spec, build_mask_spec, fmt};

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

/// 从关键帧轨道采样属性值；无关键帧则回退 base。取 clip 中位时间近似（静态回退用）。
/// 兼容前端键名：依次尝试 `transform.X` 与 `X` 两种前缀；scaleX/scaleY 额外兼容前端
/// 单一 `scale` 键（前端 `KF_PROPS` 写 `scale` 同时驱动两轴，后端拆分 scaleX/scaleY，#6 修复）。
fn keyframed(clip: &Clip, path: &str, base: f64) -> f64 {
    if let Some(tr) = clip.keyframes.get(path) {
        let mid = (clip.timeline_in + clip.timeline_out) * 0.5;
        return tr.sample(mid);
    }
    let alt = if let Some(s) = path.strip_prefix("transform.") { s.to_string() } else { format!("transform.{}", path) };
    if let Some(tr) = clip.keyframes.get(&alt) {
        let mid = (clip.timeline_in + clip.timeline_out) * 0.5;
        return tr.sample(mid);
    }
    if path == "transform.scaleX" || path == "transform.scaleY" {
        if let Some(tr) = clip.keyframes.get("scale") {
            let mid = (clip.timeline_in + clip.timeline_out) * 0.5;
            return tr.sample(mid);
        }
    }
    base
}

/// 取属性动画表达式：依次尝试候选键名，命中轨道则烘焙为 ffmpeg 时间表达式（局部 t）；
/// 无命中返回 None（调用方回退静态值）。
fn kf_factor(clip: &Clip, candidates: &[&str], timeline_in: f64) -> Option<String> {
    for c in candidates {
        if let Some(tr) = clip.keyframes.get(*c) {
            return build_kf_expr(tr, timeline_in);
        }
    }
    None
}

/// 把关键帧轨道烘焙为 ffmpeg 时间表达式（局部时间 t，单位秒）。
/// 关键帧时间为**全局时间线**时刻，这里统一减去 `timeline_in` 换算为 clip 局部时间，
/// 与 filtergraph 内各滤镜的 `t`（clip 局部时间轴）对齐。
/// 节点策略：直接以关键帧时刻为节点（保证精确命中各关键帧值）；线性段只取端点（表达式
/// 内本就是线性插值，无需细分），缓动段按 8 等分细分采样 `sample()`（Rust 侧已含缓动曲线）
/// 以分段线性近似曲线形状。整体构造 `if(lt(t,p),v0+(v1-v0)*(t-p0)/(p1-p0),…)` 链，
/// 使导出与预览逐帧采样一致（#6 修复：此前 keyframed 只取中点→静态，关键帧形同虚设）。
fn build_kf_expr(track: &KeyframeTrack, timeline_in: f64) -> Option<String> {
    if track.is_empty() { return None; }
    let mut kfs: Vec<&Keyframe> = track.keyframes.iter().collect();
    kfs.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    let tmin = kfs[0].time;
    let tmax = kfs[kfs.len() - 1].time;
    if !(tmax > tmin) {
        return Some(fmt(kfs[0].value));
    }
    // 收集节点（局部时间, 值）：线性段仅端点；缓动段 8 等分细分以近似曲线。
    let mut nodes: Vec<(f64, f64)> = Vec::new();
    nodes.push((kfs[0].time - timeline_in, kfs[0].value));
    for w in kfs.windows(2) {
        let a = w[0];
        let b = w[1];
        if !matches!(b.easing, Easing::Linear) {
            let sub = 8u32;
            for i in 1..sub {
                let f = i as f64 / sub as f64;
                let gt = a.time + (b.time - a.time) * f;
                nodes.push((gt - timeline_in, track.sample(gt)));
            }
        }
        nodes.push((b.time - timeline_in, b.value));
    }
    let (first_p, first_v) = nodes[0];
    // 从后往前嵌套：t < p1 段内插值，否则落入外层（更晚时段 / 末值）。
    let mut expr = fmt(nodes[nodes.len() - 1].1);
    for i in (0..nodes.len() - 1).rev() {
        let (p0, v0) = nodes[i];
        let (p1, v1) = nodes[i + 1];
        let denom = (p1 - p0).max(1e-9);
        let seg = format!("({}+({}-{})*(t-{})/{})", fmt(v0), fmt(v1), fmt(v0), fmt(p0), fmt(denom));
        expr = format!("if(lt(t,{}),{},{})", fmt(p1), seg, expr);
    }
    // t 早于首个关键帧时钳到首值，避免线性外推偏离。
    if first_p > 0.0 {
        expr = format!("if(lt(t,{}),{},{})", fmt(first_p), fmt(first_v), expr);
    }
    Some(expr)
}

/// 采样单个抠像关键帧属性在全局时间 t 的值；无轨道回退 base。
fn sample_keying(clip: &Clip, prop: &str, base: f64, t: f64) -> f64 {
    clip.keyframes.get(prop).map(|tr| tr.sample(t)).unwrap_or(base)
}

/// 是否 chroma 抠像且 similarity/edgeSoftness/spill 中存在关键帧。
fn is_chroma_keyframed(c: &Clip) -> bool {
    let Some(k) = &c.keying else { return false; };
    if !k.enabled || k.mode != "chroma" { return false; }
    ["keying.similarity", "keying.edgeSoftness", "keying.spill"]
        .iter()
        .any(|p| c.keyframes.contains_key(*p))
}

/// 是否 smart/manual 抠像且 threshold/edgeSoftness 中存在关键帧。
fn is_matte_keyframed(c: &Clip) -> bool {
    let Some(k) = &c.keying else { return false; };
    if !k.enabled || !(k.mode == "smart" || k.mode == "manual") { return false; }
    ["keying.threshold", "keying.edgeSoftness"]
        .iter()
        .any(|p| c.keyframes.contains_key(*p))
}

/// 把打了关键帧的抠像参数按时间线切分为若干段；返回 (本地开始, 本地结束, 该段有效 KeyingConfig)。
/// 采样范围覆盖所有模式相关参数（chroma: similarity/edgeSoftness/spill；smart/manual: threshold/edgeSoftness），
/// 无关模式的参数无轨道时回退原值，对其它模式无副作用。
fn keying_segments(c: &Clip) -> Vec<(f64, f64, KeyingConfig)> {
    let mut times: Vec<f64> = Vec::new();
    for key in ["keying.similarity", "keying.edgeSoftness", "keying.spill", "keying.threshold"] {
        if let Some(track) = c.keyframes.get(key) {
            for kf in &track.keyframes {
                if kf.time > c.timeline_in && kf.time < c.timeline_out {
                    times.push(kf.time);
                }
            }
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    times.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    let mut boundaries = vec![c.timeline_in];
    boundaries.extend(times);
    boundaries.push(c.timeline_out);
    let mut out = Vec::new();
    for w in boundaries.windows(2) {
        let (g0, g1) = (w[0], w[1]);
        if g1 - g0 < 1e-6 { continue; }
        let mid = (g0 + g1) * 0.5;
        let mut k = c.keying.clone().unwrap();
        k.similarity = sample_keying(c, "keying.similarity", k.similarity, mid);
        k.edge_softness = sample_keying(c, "keying.edgeSoftness", k.edge_softness, mid);
        k.spill = sample_keying(c, "keying.spill", k.spill, mid);
        k.threshold = Some(sample_keying(c, "keying.threshold", k.threshold.unwrap_or(0.5), mid));
        out.push((g0 - c.timeline_in, g1 - c.timeline_in, k));
    }
    out
}

fn build_clip_chain(c: &Clip, ci: usize, asset_to_idx: &HashMap<String, usize>, matte_map: &HashMap<String, usize>, bg_map: &HashMap<String, usize>, w: u32, h: u32, nodes: &mut Vec<String>, fps: u32) -> Option<String> {
    let base_dur = (c.timeline_out - c.timeline_in).max(0.1);
    let input = resolve_clip_input(c, ci, asset_to_idx, w, h, fps, nodes, base_dur)?;
    let label = format!("vs{}", ci);
    let (chain, _, _) = build_video_chain(c, &input, w, h, &label, fps, matte_map, bg_map, None, None);
    nodes.extend(chain);
    Some(label)
}

/// 构建单个 clip 的视频滤镜图，返回**多条**滤镜图语句（以 `;` 连接）。
/// 普通情况只有一条（核心变换链 + 蒙版 + opacity + fps）；文字蒙版会产出额外的
/// drawtext 蒙版流语句与 alphamerge 合成语句。最终语句产出 `[label]` 视频流。
///
/// `matte_map`：智能抠像(smart)用 matte 素材 → 全局输入索引（由 build_render_command 收集）。
/// 若 clip 启用 smart 抠像且 matte_asset_id 命中，则把该 matte 输入作为额外 alpha 源，
/// 经 threshold 曲线映射为 alpha 后与源视频 alphamerge（替代 chromakey 的 YUV→alpha 手段）。
/// 解析 clip 的视频输入标签：
/// - 有真实素材 → `[idx:v]`；
/// - 无素材但带 text/subtitle（前端用哨兵 assetId='_text'/'_subtitle'，无对应素材）→ 合成
///   透明底色流作为 drawtext 画布（overlay 时透出底层视频，避免"导出后一个字没有" #1）；
/// - 否则返回 None（跳过，如孤立的哨兵 clip）。
/// `base_dur`：合成底色流时长。单 clip 文字轨 overlay 用 shortest=1，底色流需近无限长
/// 以免截断主时间线；多 clip 文字轨走 concat/xfade，需等于片段真实时长。
fn resolve_clip_input(
    c: &Clip,
    vci: usize,
    asset_to_idx: &HashMap<String, usize>,
    w: u32,
    h: u32,
    fps: u32,
    nodes: &mut Vec<String>,
    base_dur: f64,
) -> Option<String> {
    if let Some(i) = asset_to_idx.get(&c.asset_id) {
        return Some(format!("[{}:v]", i));
    }
    if c.text.is_some() || c.subtitle.is_some() {
        let base = format!("vb{}", vci);
        // 透明黑底：overlay 时透出底层视频。drawtext 的 enable 控制字幕实际出现的时段。
        // 关键修复：color 源必须显式指定帧率 = 工程帧率（canvas.fps）。否则 color 默认 25fps，
        // 与 30fps 主视频 overlay 时需靠尾部 `fps=canvas.fps` 重新上采样，25→30 帧率错配在部分
        // 解码器/PotPlayer 上会在结尾产生 1 帧定格（卡顿），且仅在带字幕时出现（无字幕不触发）。
        nodes.push(format!("color=c=black@0:s={}x{}:r={}:d={},format=rgba[{}]", w, h, fps, fmt(base_dur), base));
        return Some(format!("[{}]", base));
    }
    None
}

/// 构建单个 clip 的视频滤镜图，返回 (滤镜图语句列表, 最终输出宽度, 最终输出高度)。
/// 最终输出宽高用于 overlay 居中计算。当单片段路径显式传入 target_w/h 且 clip 含静态
/// 旋转时，返回 AABB 外接矩形尺寸，使旋转后的完整画面（四角透明）都能被渲染，与 WebGPU
/// 预览一致；多片段 concat 路径传 None/None，保持输入尺寸不变，避免 concat 分辨率协商失败。
fn build_video_chain(c: &Clip, input: &str, w: u32, h: u32, label: &str, fps: u32, matte_map: &HashMap<String, usize>, bg_map: &HashMap<String, usize>, target_w: Option<u32>, target_h: Option<u32>) -> (Vec<String>, u32, u32) {
    let sx = keyframed(c, "transform.scaleX", c.transform.scale_x).max(0.01);
    let sy = keyframed(c, "transform.scaleY", c.transform.scale_y).max(0.01);
    // 目标尺寸：单片段路径显式传入（已做 contain 适配 + 用户缩放）时优先使用；
    // 多片段轨路径传 None，退回旧的按画布比例缩放（保证 concat/xfade 各输入同尺寸）。
    let base_w = target_w.unwrap_or(w);
    let base_h = target_h.unwrap_or(h);
    let sw = target_w.unwrap_or_else(|| (w as f64 * sx).round() as u32);
    let sh = target_h.unwrap_or_else(|| (h as f64 * sy).round() as u32);
    // 默认输出尺寸 = 缩放后尺寸；含静态旋转且走单片段 overlay 路径时再扩展为 AABB。
    let mut out_w = sw;
    let mut out_h = sh;
    let has_explicit_target = target_w.is_some() && target_h.is_some();
    // 关键帧动画：scale 走 eval=frame 时间表达式（前端 `scale` 键同时驱动两轴，#6 修复）。
    let sx_a = kf_factor(c, &["transform.scaleX", "scaleX", "scale"], c.timeline_in);
    let sy_a = kf_factor(c, &["transform.scaleY", "scaleY", "scale"], c.timeline_in);
    let mut nodes: Vec<String> = Vec::new();

    // 1) 预抠像链：scale + 变速/时间重映射 + rotate + clip_filters，产出 [pre_label]
    let mut pre_label = format!("{}p", label);
    let mut pre = match (&sx_a, &sy_a) {
        (Some(ex), Some(ey)) => format!(
            "{}scale=w='trunc(({})*{}/2)*2':h='trunc(({})*{}/2)*2':eval=frame",
            input, ex, base_w, ey, base_h
        ),
        (Some(ex), None) => format!(
            "{}scale=w='trunc(({})*{}/2)*2':h={}:eval=frame",
            input, ex, base_w, sh
        ),
        (None, Some(ey)) => format!(
            "{}scale=w={}:h='trunc(({})*{}/2)*2':eval=frame",
            input, sw, ey, base_h
        ),
        (None, None) => format!("{}scale={}:{}", input, sw, sh),
    };
    let curve = if !c.time_remap.curve.is_empty() { &c.time_remap.curve } else { &c.speed_curve };
    let dur = c.timeline_out - c.timeline_in;
    if let Some(expr) = build_speed_curve_expr(curve, c.src_range.start, dur) {
        pre.push_str(&format!(",setpts={}", expr));
    } else if (c.speed - 1.0).abs() > 0.001 {
        pre.push_str(&format!(",setpts={}*PTS", fmt(1.0 / c.speed)));
    }
    let rot_a = kf_factor(c, &["transform.rotation", "rotation"], c.timeline_in);
    if let Some(re) = rot_a {
        // 关键帧旋转：rotate 的 a 表达式逐帧求值（支持 t），#6 修复。
        // 关键帧暂保持输入尺寸输出，避免 AABB 随时间变化导致 overlay 偏移复杂化。
        pre.push_str(&format!(",rotate=a='({})*PI/180'", re));
    } else {
        let rot = keyframed(c, "transform.rotation", c.transform.rotation);
        if rot.abs() > 0.01 {
            if has_explicit_target {
                // 静态旋转 + 单片段 overlay 路径：扩展为 AABB 外接矩形，四角透明，
                // 使旋转后的完整画面（视觉上矩形→菱形）与 WebGPU 预览一致，避免八角形。
                let rad = rot * std::f64::consts::PI / 180.0;
                let abs_cos = rad.cos().abs();
                let abs_sin = rad.sin().abs();
                out_w = (sw as f64 * abs_cos + sh as f64 * abs_sin).round().max(1.0) as u32;
                out_h = (sw as f64 * abs_sin + sh as f64 * abs_cos).round().max(1.0) as u32;
                pre.push_str(&format!(",rotate={}*PI/180:ow={}:oh={}:c=none", fmt(rot), out_w, out_h));
            } else {
                pre.push_str(&format!(",rotate={}*PI/180", fmt(rot)));
            }
        }
    }
    let clip_filters = build_clip_filters(c).unwrap_or_default();
    if !clip_filters.is_empty() { pre.push_str(&format!(",{}", clip_filters)); }
    // 字幕/文字叠加层烧录：GUI 导出走本路径（render→graph.rs），必须把 clip.text /
    // clip.subtitle 烤进视频，否则预览可见、导出成片丢失（#1 P0）。
    // 复用 subtitle 模块的 drawtext 构造函数。字幕/文字 clip 无真实素材，resolve_clip_input
    // 为其合成透明底色流（color=c=black@0，PTS 从 0 起），该底色流 overlay 到主时间线 base
    // 时两输入 PTS 对齐（都从 0 起），故 drawtext 的 enable 直接用**绝对时间线窗口**：
    // text → timeline_in~timeline_out；subtitle → subtitle_item_timeline 把源时间戳逆映射为
    // 时间线绝对秒。t 即全局 PTS，无需 setpts 偏移。仅当片段确含 text/subtitle 时才改此链。
    if dur > 0.0 {
        let fontfile_dir = std::env::var("AICUT_FONTS_DIR").unwrap_or_default();
        if let Some(t) = &c.text {
            if let Some(f) = subtitle::build_text_overlay_filter(t, c.timeline_in, c.timeline_out, w, h, &fontfile_dir) {
                pre.push_str(&format!(",{}", f));
            }
        }
        if let Some(s) = &c.subtitle {
            for f in subtitle::build_subtitle_overlay_filters_for_clip(s, c, w, h, &fontfile_dir) {
                pre.push_str(&format!(",{}", f));
            }
        }
    }
    // 镜像翻转：GUI 把 transform.flip_h/flip_v 写进 transform（0/1），Rust Transform 现已反序列化该字段。
    // 在预链末尾施加 hflip/vflip（yuv/rgba 均可，置于缩放/旋转/文字之后、抠像之前）。
    // 此前该字段在 Rust 侧不存在 → 镜像在预览/导出均无效果（# 镜像无效）。
    if c.transform.flip_h > 0.5 { pre.push_str(",hflip"); }
    if c.transform.flip_v > 0.5 { pre.push_str(",vflip"); }
    // clip 级同步翻转：内容若开启镜像，抠像 matte 视频与背景图片/视频必须同步翻转，
    // 否则它们（前景剪影 / 背景画面）与已翻转的内容画面对不齐。预览（WebGPU/HTML5）是把
    // 「内容+matte+背景」整帧一起翻转，导出侧需对各输入显式翻转对齐。
    let mut clip_flip = String::new();
    if c.transform.flip_h > 0.5 { clip_flip.push_str(",hflip"); }
    if c.transform.flip_v > 0.5 { clip_flip.push_str(",vflip"); }
    pre.push_str(&format!("[{}]", pre_label));
    nodes.push(pre);

    // 2) 抠像：chroma 用 chromakey（作用于 YUV）；smart/manual 用 matte alphamerge。
    // 若相关参数（chroma: similarity/edgeSoftness/spill；smart/manual: threshold/edgeSoftness）
    // 存在关键帧，则按关键帧边界切段、每段烘焙采样值（分段 + split 防止 ffmpeg 分辨率协商 -22）。
    let keyed_label = format!("{}k", label);

    // 智能/手动抠像 matte 输入索引（smart / manual 模式 + matte_asset_id 命中时 Some；
    // 两者都走 matte 视频 alphamerge，与模式无关）
    let matte_idx = c.keying.as_ref().and_then(|k| {
        if k.enabled && (k.mode == "smart" || k.mode == "manual") {
            k.matte_asset_id.as_ref().and_then(|id| matte_map.get(id).copied())
        } else { None }
    });
    // smart/manual 抠像且 threshold/edgeSoftness 关键帧已就绪（matte 必须存在），
    // 命中时抠像在下方按段烘焙，需跳过后续静态 matte alphamerge 块。
    let matte_keyframed = is_matte_keyframed(c) && matte_idx.is_some();

    if is_chroma_keyframed(c) {
        let segs = keying_segments(c);
        let n = segs.len();
        // 关键修复：ffmpeg 的 filtergraph 中，单个带标签的输出（如缩放后的 [pre]）被多条
        // trim 链同时引用时，scale/transform 只会传播到第一条分支，其余分支会回退到原始分辨率
        // （实测 640x360 vs 1280x720 导致 concat 报 -22 Invalid argument）。改用 split=N 把
        // 已缩放的流扇出为 N 路独立副本，每段各自 trim+chromakey，避免分辨率协商错乱。
        let split_outs: Vec<String> = (0..n).map(|i| format!("{}sp{}", label, i)).collect();
        nodes.push(format!(
            "[{pre}]split={n}{outs}",
            pre = pre_label, n = n,
            outs = split_outs.iter().map(|o| format!("[{}]", o)).collect::<String>()
        ));
        let mut seg_labels: Vec<String> = Vec::new();
        for (i, (s0, s1, kcfg)) in segs.iter().enumerate() {
            let seg_label = format!("{}s{}", label, i);
            seg_labels.push(seg_label.clone());
            // 帧精确边界：秒级 trim 在 concat 边界因浮点精度会错分边界帧（重复上一帧），
            // 改用 start_frame/end_frame 确保各段帧区间干净衔接。
            let sf = ((*s0) * (fps as f64)).round() as i64;
            let mut ef = ((*s1) * (fps as f64)).round() as i64;
            if ef <= sf { ef = sf + 1; }
            let kcfg = kcfg.clone();
            let kf = build_keying_spec(&Some(kcfg), w, h).unwrap().filter.unwrap();
            nodes.push(format!(
                "[{pre}]trim=start_frame={sf}:end_frame={ef},setpts=PTS-STARTPTS,{kf}[{seg}]",
                pre = split_outs[i], sf = sf, ef = ef, kf = kf, seg = seg_label
            ));
        }
        let inputs = seg_labels.iter().map(|s| format!("[{}]", s)).collect::<String>();
        nodes.push(format!("{}concat=n={}:v=1:a=0[{}]", inputs, seg_labels.len(), keyed_label));
    } else if matte_keyframed {
        let segs = keying_segments(c); // 每段烘焙 threshold/edgeSoftness
        let n = segs.len();
        // 同 chroma：split=N 扇出独立副本，避免单标签被多条 trim 引用时的分辨率协商 -22
        let split_outs: Vec<String> = (0..n).map(|i| format!("{}sp{}", label, i)).collect();
        nodes.push(format!(
            "[{pre}]split={n}{outs}",
            pre = pre_label, n = n,
            outs = split_outs.iter().map(|o| format!("[{}]", o)).collect::<String>()
        ));
        let mut seg_labels: Vec<String> = Vec::new();
        for (i, (s0, s1, kcfg)) in segs.iter().enumerate() {
            let seg_label = format!("{}s{}", label, i);
            seg_labels.push(seg_label.clone());
            let thr = kcfg.threshold.unwrap_or(0.5);
            let soft = kcfg.edge_softness;
            // 保留软 matte：下游不再用窄带阈值把 MODNet/RMBG-2.0 的软 alpha 压成硬切。
            // alpha = clip((v - thr) * gain + 0.5, 0, 1)；gain 随 edgeSoftness 趋近 1（完全
            // 保留模型天然软梯度），edgeSoftness→0 时 gain 增大→边缘更硬（用户可调锐化）。
            let s = soft.clamp(0.0, 1.0);
            let gain = 1.0 + (1.0 - s) * 2.0;
            let geq_expr = format!(
                "clip((lum(X,Y)/255-({t}))*{g}+0.5,0,1)*255",
                t = fmt(thr), g = fmt(gain)
            );
            let mt = format!("{}mt{}", label, i);
            // 帧精确边界：用 start_frame/end_frame 替代秒级 trim，避免 ffmpeg 在 concat 边界
            // 因浮点精度把边界帧错分（实测段1 首帧重复了段0 末帧）。s0/s1 为 clip 相对秒，
            // 乘 fps 取整即得该段在源/matte 流中的帧区间。
            let sf = ((*s0) * (fps as f64)).round() as i64;
            let mut ef = ((*s1) * (fps as f64)).round() as i64;
            if ef <= sf { ef = sf + 1; }
            // 关键修复：matte 必须与本段源同步到同一时间窗口。源被 trim+setpts 重定时到
            // [0,seg_dur]，若 matte 仍引用完整流，alphamerge 会按时间戳对齐到 matte 的
            // [0,seg_dur] 而非正确的 [s0,s1]，导致逐帧变化的真实 matte（rmbg/modnet）在
            // 段边界之后严重时间错位（实测段1 较静态参考 PSNR 仅 ~30dB）。此处对 matte 同样
            // trim+setpts，使其与源段严格对齐。
            nodes.push(format!(
                "[{mi}:v]trim=start_frame={sf}:end_frame={ef},setpts=PTS-STARTPTS,scale={sw}:{sh},geq=lum='{geq_expr}'{clip_flip}[{mt}]",
                mi = matte_idx.unwrap(), sf = sf, ef = ef, sw = sw, sh = sh, clip_flip = clip_flip
            ));
            // trim+setpts 后的源再 alphamerge 时，必须显式转成 yuva420p，否则 ffmpeg 会
            // 丢失/损坏 alpha，导致背景色偏色（实测变成粉色）。
            let seg_pre = format!("{}sa{}", label, i);
            nodes.push(format!(
                "[{pre}]trim=start_frame={sf}:end_frame={ef},setpts=PTS-STARTPTS,format=yuva420p[{seg_pre}]",
                pre = split_outs[i], sf = sf, ef = ef, seg_pre = seg_pre
            ));
            nodes.push(format!(
                "[{seg_pre}][{mt}]alphamerge[{seg}]",
                seg_pre = seg_pre, mt = mt, seg = seg_label
            ));
        }
        let inputs = seg_labels.iter().map(|s| format!("[{}]", s)).collect::<String>();
        nodes.push(format!("{}concat=n={}:v=1:a=0[{}]", inputs, seg_labels.len(), keyed_label));
    } else if let Some(kf) = build_keying_spec(&c.keying, w, h).and_then(|s| s.filter) {
        nodes.push(format!("[{pre}]{kf}[{keyed}]", pre = pre_label, kf = kf, keyed = keyed_label));
    } else {
        nodes.push(format!("[{pre}]null[{keyed}]", pre = pre_label, keyed = keyed_label));
    }
    let core = format!("[{}]", keyed_label);
    // opacity + fps 作为尾部统一施加（在蒙版/matte 合成之后），保证各路输入帧率一致、透明度正确。
    // 关键帧不透明度：colorchannelmixer 的 aa 走 eval=frame 时间表达式（#6 修复）。
    // 注意：colorchannelmixer 的 aa（alpha 系数）只有在流带 alpha 通道时才生效；YUV 流没有 alpha
    // 平面，aa 会被静默忽略 → 导出后不透明度无任何变化（# 不透明度无效）。故透明度 < 1 时先
    // format=yuva420p 建立 alpha 平面，再乘 alpha；关键帧路径同理。
    let op_a = kf_factor(c, &["transform.opacity", "opacity"], c.timeline_in);
    let tail = if let Some(oe) = op_a {
        format!(",format=yuva420p,colorchannelmixer=aa='({})':eval=frame,fps={}", oe, fps)
    } else {
        let opacity = keyframed(c, "transform.opacity", c.transform.opacity).clamp(0.0, 1.0);
        if opacity < 1.0 {
            format!(",format=yuva420p,colorchannelmixer=aa={},fps={}", fmt(opacity), fps)
        } else {
            format!(",fps={}", fps)
        }
    };
    // 蒙版：geq 形状（heart/circle/...）走单输入 geq；文字(text) 走独立 drawtext 流 + alphamerge。
    // 中间标签 mlabel = 蒙版合成后、matte 合成前、尾部之前的视频流。
    let mlabel = format!("{}m", label);
    let mspec = build_mask_spec(&c.masks, w, h, fps, dur);
    let mut pre_tail = mlabel.clone();
    match mspec {
        None => {
            // 无蒙版：核心链直接产出 mlabel（core 现在是一个标签，需要 null 过滤器桥接输出标签）
            nodes.push(format!("{}null[{}]", core, mlabel));
        }
        Some(spec) => {
            if spec.image_masks.is_empty() {
                // 纯 geq 形状（heart/star/...）或装饰：单语句兼容旧行为
                match &spec.geq {
                    Some(g) => nodes.push(format!("{},{}[{}]", core, g, mlabel)),
                    None => nodes.push(format!("{}[{}]", core, mlabel)),
                }
            } else {
                // 多语句：主视频(可选 geq) → 中间标签 vid → 逐张 alphamerge → 尾部 opacity/fps → label
                let vid = mlabel.clone();
                match &spec.geq {
                    Some(g) => nodes.push(format!("{},{}[{}]", core, g, vid)),
                    None => {
                        // 纯文字蒙版：主视频先转 RGBA，才能与 RGBA 文字蒙版流 alphamerge
                        nodes.push(format!("{},format=rgba[{}]", core, vid));
                    }
                }
                let mut cur = vid.clone();
                for (i, im) in spec.image_masks.iter().enumerate() {
                    // 该蒙版流的自包含滤镜图语句（内部定义出 im.label，如 tx0）
                    nodes.push(im.statement.clone());
                    let out = format!("{}k{}", label, i);
                    nodes.push(format!("[{cur}][{lbl}]alphamerge[{out}]",
                        cur = cur, lbl = im.label, out = out));
                    cur = out;
                }
                pre_tail = cur;
            }
        }
    }
    // 智能抠像：把 matte（灰度视频）映射为 alpha 并 alphamerge 到源。
    // matte luma = 抠像值（0=背景,255=前景）；经 threshold/softness 曲线映射为 0..255 再作 alpha。
    // 顺序：在 mask 合成之后、opacity/fps 之前（与 chroma 的 alpha 合成点一致）。
    // 静态 matte alphamerge（未打关键帧的 smart/manual）；打关键帧时已在上方分段烘焙，跳过。
    if !matte_keyframed {
        if let Some(mi) = matte_idx {
        let k = c.keying.as_ref().unwrap();
        let thr = k.threshold.unwrap_or(0.5);
        let soft = k.edge_softness;
        // 保留软 matte（与关键帧路径一致）：直接用模型天然软 alpha，仅按 threshold 平移
        // 水平、按 edgeSoftness 微调锐度，不再用窄带把软边压成硬切。
        let s = soft.clamp(0.0, 1.0);
        let gain = 1.0 + (1.0 - s) * 2.0;
        let geq_expr = format!(
            "clip((lum(X,Y)/255-({t}))*{g}+0.5,0,1)*255",
            t = fmt(thr), g = fmt(gain)
        );
        let mt_label = format!("{}mt", label);
        // matte 输入先缩放到与源一致尺寸（灰度 mp4 与源同分辨率；显式 scale 防尺寸偏差），
        // 再用 geq 把 luma 经 threshold/softness 映射为 alpha 层（luma=alpha）。
        nodes.push(format!("[{mi}:v]scale={sw}:{sh},geq=lum='{geq_expr}'{clip_flip}[{mt_label}]", sw = sw, sh = sh, clip_flip = clip_flip));
        let va = format!("{}va", label);
        // alphamerge 取第二个输入（matte）的 luma 作为 alpha；源(可能 RGBA/YUV)叠加 alpha → 透明视频。
        nodes.push(format!("[{pre_tail}][{mt_label}]alphamerge[{va}]"));
        pre_tail = va;
        }
    }
    // 背景合成（P3）：把 keyed（带 alpha）垫到背景之上，再接尾部 opacity/fps。
    // 背景可为纯色（内部 color 滤镜源）或图片/视频（额外 -i，已收集到 bg_map）。
    // 顺序：在 mask/matte 合成之后、opacity/fps 之前（与 alpha 合成点一致）。
    if let Some(k) = c.keying.as_ref() {
        if k.enabled {
            if let Some(bg) = k.background.as_ref() {
                if bg.bg_type != "none" {
                    let bg_label = format!("{}bg", label);
                    match bg.bg_type.as_str() {
                        "color" => {
                            let hex = bg.color.trim_start_matches('#');
                            nodes.push(format!("color=c=0x{}:s={}x{}:r={}[{}]", hex, w, h, fps, bg_label));
                            let bgout = format!("{}bgout", label);
                            // 背景 color 源是无限长，必须 shortest=1 否则 overlay 会一直等待导致 ffmpeg 卡死
                            nodes.push(format!("[{bg_label}][{pre_tail}]overlay=shortest=1[{bgout}]"));
                            pre_tail = bgout;
                        }
                        "image" | "video" => {
                            if let Some(bi) = bg.asset_id.as_ref().and_then(|id| bg_map.get(id).copied()) {
                                // 背景 cover：放大到覆盖画布再裁剪溢出区域，避免直接 scale 拉伸比例失真
                                // （scale=W:H 会把非等比素材压变形；force_original_aspect_ratio=increase
                                // 保证最小边填满，crop 裁掉多余部分）。
                                nodes.push(format!("[{bi}:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}{clip_flip}[{bg_label}]", clip_flip = clip_flip));
                                let bgout = format!("{}bgout", label);
                                nodes.push(format!("[{bg_label}][{pre_tail}]overlay=shortest=1[{bgout}]"));
                                pre_tail = bgout;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    // 尾部：opacity + fps（tail 以逗号开头，pre_tail 是标签，标签后直接接滤镜不能留逗号）。
    nodes.push(format!("[{pre_tail}]{}[{label}]", tail.trim_start_matches(',')));
    (nodes, out_w, out_h)
}

/// contain 适配：把源视频等比缩进画布（留黑边、不变形、不裁切），返回适配后尺寸。
/// 与 WebGPU 预览 WGSL 的 contain 逻辑一致：源更宽 → 宽度撑满、上下留边；
/// 源更高 → 高度撑满、左右留边。源尺寸缺失时回退画布尺寸。
fn contain_fit_size(src_w: u32, src_h: u32, canvas_w: u32, canvas_h: u32) -> (u32, u32) {
    if src_w == 0 || src_h == 0 { return (canvas_w, canvas_h); }
    let src_aspect = src_w as f64 / src_h as f64;
    let canvas_aspect = canvas_w as f64 / canvas_h as f64;
    if src_aspect > canvas_aspect {
        // 源更宽：宽度撑满画布，高度按比例（上下黑边）
        let h = (canvas_w as f64 / src_aspect).round().max(2.0) as u32;
        (canvas_w, h)
    } else {
        // 源更高：高度撑满画布，宽度按比例（左右黑边）
        let w = (canvas_h as f64 * src_aspect).round().max(2.0) as u32;
        (w, canvas_h)
    }
}

/// 计算 clip 在画布上的水平偏移（像素）：把 out_w 宽度的 clip 居中到 transform.x 指定的中心。
/// 关键帧位置 X 走 overlay 的 x 时间表达式（#6 修复）。
fn offset_x(c: &Clip, w: u32, out_w: u32) -> String {
    if let Some(e) = kf_factor(c, &["transform.x", "x"], c.timeline_in) {
        return format!("'(({})*{}-{})'", e, w, out_w as f64 / 2.0);
    }
    let x = keyframed(c, "transform.x", c.transform.x);
    format!("{}", (x * w as f64 - out_w as f64 / 2.0).round() as i64)
}

/// 计算 clip 在画布上的垂直偏移（像素）：把 out_h 高度的 clip 居中到 transform.y 指定的中心。
/// 与 WebGPU 预览 WGSL 一致：clipY = 1 - transform.y*2，即 transform.y=0 → 顶部、=1 → 底部，
/// 增大 y 向下移动。overlay 的 y 原点在顶部，故 overlay_y = transform.y*h - out_h/2（增大 y 向下）。
/// 旧逻辑写成 (1-y)*h 恰好与预览相反 → 导出后位置上下颠倒（# 位置Y 反了）。
fn offset_y(c: &Clip, h: u32, out_h: u32) -> String {
    if let Some(e) = kf_factor(c, &["transform.y", "y"], c.timeline_in) {
        return format!("'({}*{}-{})'", e, h, out_h as f64 / 2.0);
    }
    let y = keyframed(c, "transform.y", c.transform.y);
    format!("{}", (y * h as f64 - out_h as f64 / 2.0).round() as i64)
}

pub struct FilterGraphBuilder;

impl FilterGraphBuilder {
    pub fn build(project: &Project) -> ffmpeg::RenderCommand { build_render_command(project) }
}

/// 探测输入文件是否含有音轨。
///
/// 用于音频回退：无音轨的视频片段（如 AI 口播生成的静音 speech 视频）不应被当作音源，
/// 否则会生成 `[idx:a]` 指向不存在的流，导致 ffmpeg 报
/// "Stream specifier 'N:a' matches no streams" → 导出失败。
///
/// 探测失败（ffprobe 缺失 / 路径异常 / 非本地文件）时保守返回 `true`，
/// 保持原行为（不跳过），避免误删本应有音频的素材。
fn input_has_audio(path: &str) -> bool {
    if let Ok(out) = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            path,
        ])
        .output()
    {
        if out.status.success() {
            return !String::from_utf8_lossy(&out.stdout).trim().is_empty();
        }
    }
    true
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
    let mut max_timeline_out: f64 = 0.0;
    for t in &sorted {
        for c in &t.clips {
            if t.track_type == "audio" { audio_clips.push(c); }
            else { video_clips.push((t.order as usize, c)); }
            if c.timeline_out > max_timeline_out { max_timeline_out = c.timeline_out; }
        }
    }
    if max_timeline_out > 0.001 {
        cmd.duration = Some(max_timeline_out);
    }
    let mut asset_to_idx: HashMap<String, usize> = HashMap::new();
    let mut inputs: Vec<InputSpec> = Vec::new();
    for (_, c) in &video_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) { asset_to_idx.insert(a.id.clone(), inputs.len()); inputs.push(InputSpec { path: a.path.clone(), stream_loop: None, raw_video: None }); }
        }
    }
    for c in &audio_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) { asset_to_idx.insert(a.id.clone(), inputs.len()); inputs.push(InputSpec { path: a.path.clone(), stream_loop: None, raw_video: None }); }
        }
    }
    cmd.inputs = inputs;
    // 预探测每个输入文件是否含音轨，供下方音频节点构建时跳过无音轨素材。
    // 修复：无音轨视频（如静音 speech 叠加）被回退当音源 → `[idx:a]` 指向不存在的流 → 导出失败。
    let audio_input_idx: HashSet<usize> = (0..cmd.inputs.len())
        .filter(|&i| input_has_audio(&cmd.inputs[i].path))
        .collect();
    // 智能/手动抠像(smart/manual)的 matte 素材：作为额外输入加入本次导出（独立 -i），
    // 记录其全局输入索引供 build_video_chain 引用 [idx:v]。两者共用同一条 alphamerge 路径。
    let mut matte_map: HashMap<String, usize> = HashMap::new();
    for (_, c) in &video_clips {
        if let Some(k) = &c.keying {
            if k.enabled && (k.mode == "smart" || k.mode == "manual") {
                if let Some(id) = &k.matte_asset_id {
                    if !matte_map.contains_key(id) {
                        if let Some(a) = project.asset_by_id(id) {
                            matte_map.insert(id.clone(), cmd.inputs.len());
                            cmd.inputs.push(InputSpec { path: a.path.clone(), stream_loop: None, raw_video: None });
                        }
                    }
                }
            }
        }
    }
    // 背景合成（P3）：背景图片/视频作为额外输入加入导出（独立 -i），记录全局输入索引供 build_video_chain 引用。
    let mut bg_map: HashMap<String, usize> = HashMap::new();
    for (_, c) in &video_clips {
        if let Some(k) = &c.keying {
            if k.enabled {
                if let Some(bg) = &k.background {
                    if bg.bg_type == "image" || bg.bg_type == "video" {
                        if let Some(id) = &bg.asset_id {
                            if !bg_map.contains_key(id) {
                                if let Some(a) = project.asset_by_id(id) {
                                bg_map.insert(id.clone(), cmd.inputs.len());
                                // 背景图片/视频：stream_loop=-1 无限循环，配合 overlay=shortest=1
                                // 在前景结束时终止，从而撑满整个前景时长（修复背景比源短时截断）。
                                cmd.inputs.push(InputSpec { path: a.path.clone(), stream_loop: Some(-1), raw_video: None });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
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
        // 底色流时长 = 工程时间轴长度，使最终输出严格对齐到 timeline_out 最大值，
        // 避免视频比音轨短导致末尾定格（卡顿）。
        let timeline_dur = cmd.duration.unwrap_or(1e9).max(0.1);
        nodes.push(format!("color=c=black:s={}x{}:d={}[base]", w, h, fmt(timeline_dur)));
        let mut acc = "base".to_string();
        let mut vci = 0usize;
        for (track_order, clips) in &video_tracks {
            if clips.is_empty() { continue; }
            if clips.len() == 1 {
                let c = clips[0];
                let src = format!("vs{}", vci);
                let Some(input) = resolve_clip_input(c, vci, &asset_to_idx, w, h, project.canvas.fps, &mut nodes, 1e9) else { vci += 1; continue; };
                // contain 适配：预览对每个视频 clip 先按源宽高比等比缩进画布（留黑边），
                // 再乘用户缩放。导出此前直接按画布尺寸缩放（比例失真 + 叠加错位），
                // 与预览不一致（# 问题②：窄素材被拉伸铺满、与预览看到的不同）。
                // 此处复刻预览逻辑：先 contain 到画布，再乘 transform.scale。
                let asset = project.asset_by_id(&c.asset_id);
                let (cfit_w, cfit_h) = contain_fit_size(
                    asset.map(|a| a.width).unwrap_or(0),
                    asset.map(|a| a.height).unwrap_or(0),
                    w, h,
                );
                let sx = keyframed(c, "transform.scaleX", c.transform.scale_x).max(0.01);
                let sy = keyframed(c, "transform.scaleY", c.transform.scale_y).max(0.01);
                let sw = (cfit_w as f64 * sx).round().max(2.0) as u32;
                let sh = (cfit_h as f64 * sy).round().max(2.0) as u32;
                let (chain, out_w, out_h) = build_video_chain(c, &input, w, h, &src, project.canvas.fps, &matte_map, &bg_map, Some(sw), Some(sh));
                nodes.extend(chain);
                let next_acc = format!("va{}", vci + 1);
                // 居中叠加：把旋转后的实际输出尺寸 out_w×out_h 中心对齐到 transform.(x,y)
                // 指定的画布中心。若含静态旋转，out_w/h 已是 AABB 外接矩形，保证四角透明
                // 的完整菱形与 WebGPU 预览一致；无旋转时 out_w/h = sw/sh。
                let ox = offset_x(c, w, out_w); let oy = offset_y(c, h, out_h);
                // 不再 shortest=1：底色已固定为工程时长并铺满整个时间轴，
                // 视频/文字轨结束后透出黑色底色，避免末帧冻结造成卡顿。
                // eof_action=pass：从输入（视频轨）结束时透传主输入（黑场 base），
                // 而不是默认 repeat（复用视频最后一帧 → 末帧定格卡顿）。
                nodes.push(format!("[{}][{}]overlay=x={}:y={}:eof_action=pass[{}]", acc, src, ox, oy, next_acc));
                acc = next_acc; vci += 1;
            } else {
                let Some(mut track_acc) = build_clip_chain(clips[0], vci, &asset_to_idx, &matte_map, &bg_map, w, h, &mut nodes, project.canvas.fps) else { vci += 1; continue; };
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
                    let Some(curr_label) = build_clip_chain(curr, vci, &asset_to_idx, &matte_map, &bg_map, w, h, &mut nodes, project.canvas.fps) else { vci += 1; continue; };
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
                        // 关键修复（#5）：gblur 必须加 enable 时间门控，仅作用于转场窗
                        // [offset, offset+xdur]。否则 gblur 会糊住整条 merged 流，而 merged 被赋回
                        // track_acc、成为后续所有 xfade/concat 的输入 → 成片从该转场起**永久失焦**，
                        // 且转场越多叠加越重。enable=false 时 gblur 透传原帧（保持清晰）。
                        if let Some((_, _, _, feather, _, _)) = trans_params {
                            let is_wipe = xstyle.starts_with("wipe") || xstyle == "circleopen";
                            if is_wipe && feather > 0.0 {
                                let sigma = (feather * 0.25).max(0.3);
                                let blurred = format!("xb{}", vci);
                                let trans_start = offset;
                                let trans_end = offset + xdur;
                                nodes.push(format!(
                                    "[{}]gblur=sigma={:.2}:enable='between(t,{},{})'[{}]",
                                    merged, sigma, fmt(trans_start), fmt(trans_end), blurred
                                ));
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
                // base 必须被消费：单轨（主轨直接产出）也必须 overlay 到 base，否则 color 滤镜输出孤立导致 filtergraph 绑定失败。
                // 底色时长 = 工程时间轴长度，输出时长由底色决定，避免音轨 outlast 视频。
                // eof_action=pass：视频轨结束后透传黑场 base，避免复用最后一帧造成末帧定格。
                nodes.push(format!("[{}][{}]overlay=x=0:y=0:eof_action=pass[{}]", acc, track_acc, next_acc));
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
    // 音频源：混合「视频轨自带音轨 + 独立音频轨」。
    // 旧逻辑：存在音频轨时只用音频轨片段，整体丢弃视频自带音轨 → 导出后视频无声、
    // 仅背景音（与预览不一致，# 问题①）。修正为混合全部音轨，仅跳过被静音 / 非独奏 /
    // 隐藏的视频轨（与预览 trackHasAudio 一致）。
    let has_solo = project.tracks.iter().any(|t| t.solo);
    let track_audible = |t: &Track| -> bool {
        if t.muted { return false; }
        if has_solo && !t.solo { return false; }
        if t.track_type == "video" && t.visible == false { return false; }
        true
    };
    let mut aout_label = String::new();
    let mut audio_source_clips: Vec<&Clip> = Vec::new();
    for (_, c) in &video_clips {
        if let Some(t) = project.tracks.iter().find(|t| t.clips.iter().any(|cc| cc.id == c.id)) {
            if track_audible(t) { audio_source_clips.push(c); }
        }
    }
    for c in &audio_clips {
        if let Some(t) = project.tracks.iter().find(|t| t.clips.iter().any(|cc| cc.id == c.id)) {
            if track_audible(t) { audio_source_clips.push(c); }
        }
    }
    if !audio_source_clips.is_empty() {
        let mut audio_labels: Vec<String> = Vec::new();
        let mut audio_nodes: Vec<String> = Vec::new();
        for c in &audio_source_clips {
            let trk = project.tracks.iter().find(|t| t.clips.iter().any(|cc| cc.id == c.id));
            let track_vol = trk.map(|t| t.volume).unwrap_or(1.0);
            let idx = match asset_to_idx.get(&c.asset_id) { Some(i) => *i, None => continue };
            // 跳过无音轨的输入：避免为无声视频（如 speech 叠加）生成 `[idx:a]` 指向不存在的流。
            if !audio_input_idx.contains(&idx) { continue; }
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
    // 关键帧音量：volume 走 eval=frame 时间表达式（#6 修复）。否则回退静态增益。
    if let Some(ve) = kf_factor(c, &["volume"], c.timeline_in) {
        chain.push_str(&format!(",volume='({})*{}':eval=frame", ve, fmt(track_vol)));
    } else {
        let vol = c.volume.clamp(0.0, 2.0) * track_vol;
        if (vol - 1.0).abs() > 0.01 {
            chain.push_str(&format!(",volume={}", fmt(vol)));
        }
    }
    // 转场 equal-power 包络（afade, curve=qsin）：out=cos 淡出 / in=sin 淡入，与 export.rs / 预览一致。
    // 用本地时间轴 st = tw0 - timeline_in（转场窗起点相对本片段起点），置于 adelay 之前。
    for (tw0, dur, is_out) in envelopes {
        let st_local = (tw0 - c.timeline_in).max(0.0);
        let fade_t = if *is_out { "out" } else { "in" };
        chain.push_str(&format!(",afade=t={}:curve=qsin:st={}:d={}", fade_t, fmt(st_local), fmt(*dur)));
    }
    // 音频滤镜（降噪/均衡器）：此前 graph.rs 音频路径未应用 clip.filters，预览有、导出无。
    // 仅映射音频类滤镜（denoise→afftdn, equalizer→equalizer），视频类滤镜（flip/curves/chromakey）
    // 不作用于音频流；复用 build_filter_spec 的参数解析与默认值，置于 volume/afade 之后、adelay 之前。
    for f in &c.filters {
        if !f.enabled { continue; }
        match f.kind.as_str() {
            "denoise" | "equalizer" => {
                if let Some(s) = build_filter_spec(&f.kind, &f.params) {
                    chain.push_str(&format!(",{}", s));
                }
            }
            _ => {}
        }
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
