//! src/graph.rs — 滤镜图构建器
//! FilterGraphBuilder + build_render_command + 公共 API

use crate::ffmpeg;
use crate::ffmpeg::InputSpec;
use crate::project::{Clip, Project, Track};
use crate::types::*;
use std::collections::HashMap;

// ════════════════════ 曲线变速 ════════════════════

use crate::filters::{build_beauty_spec, build_clip_filters, build_filter_spec, build_keying_spec, build_mask_spec, fmt};

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

fn build_clip_chain(c: &Clip, ci: usize, asset_to_idx: &HashMap<String, usize>, matte_map: &HashMap<String, usize>, bg_map: &HashMap<String, usize>, beauty_map: &HashMap<String, usize>, w: u32, h: u32, nodes: &mut Vec<String>, fps: u32) -> Option<String> {
    let idx = *asset_to_idx.get(&c.asset_id)?;
    let label = format!("vs{}", ci);
    let chain = build_video_chain(c, idx, w, h, &label, fps, matte_map, bg_map, beauty_map);
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
fn build_video_chain(c: &Clip, idx: usize, w: u32, h: u32, label: &str, fps: u32, matte_map: &HashMap<String, usize>, bg_map: &HashMap<String, usize>, beauty_map: &HashMap<String, usize>) -> Vec<String> {
    let sx = keyframed(c, "transform.scaleX", c.transform.scale_x).max(0.01);
    let sy = keyframed(c, "transform.scaleY", c.transform.scale_y).max(0.01);
    let sw = (w as f64 * sx).round() as u32;
    let sh = (h as f64 * sy).round() as u32;
    let mut nodes: Vec<String> = Vec::new();

    // 1) 预抠像链：scale + 变速/时间重映射 + rotate + clip_filters，产出 [pre_label]
    let mut pre_label = format!("{}p", label);
    let mut pre = format!("[{}:v]scale={}:{}", idx, sw, sh);
    let curve = if !c.time_remap.curve.is_empty() { &c.time_remap.curve } else { &c.speed_curve };
    let dur = c.timeline_out - c.timeline_in;
    if let Some(expr) = build_speed_curve_expr(curve, c.src_range.start, dur) {
        pre.push_str(&format!(",setpts={}", expr));
    } else if (c.speed - 1.0).abs() > 0.001 {
        pre.push_str(&format!(",setpts={}*PTS", fmt(1.0 / c.speed)));
    }
    let rot = keyframed(c, "transform.rotation", c.transform.rotation);
    if rot.abs() > 0.01 { pre.push_str(&format!(",rotate={}*PI/180", fmt(rot))); }
    let clip_filters = build_clip_filters(c).unwrap_or_default();
    if !clip_filters.is_empty() { pre.push_str(&format!(",{}", clip_filters)); }
    pre.push_str(&format!("[{}]", pre_label));
    nodes.push(pre);

    // 1.5) 美颜·皮肤管理：仅皮肤区域（mask_asset_id 命中的灰度 mask）混合磨皮/美白/清晰/肤色。
    // 与 matte 类似，mask 作为额外输入；先把源 split 成 orig + src_for_beauty，
    // 对 src_for_beauty 施加美颜链，再用 maskedmerge(orig, beauty, mask) 按 mask luma 混合
    // （out = orig*(1-mask) + beauty*mask）。mask 必须缩放到与源一致尺寸（sw×sh），否则
    // maskedmerge 三路分辨率不一致会报 Invalid argument。
    let beauty_idx = c.beauty.as_ref().and_then(|b| {
        if b.enabled {
            b.mask_asset_id.as_ref().and_then(|id| beauty_map.get(id).copied())
        } else { None }
    });
    if let Some(mi) = beauty_idx {
        if let Some(chain) = build_beauty_spec(&c.beauty, w, h) {
            let borig = format!("{}borig", label);
            let bsrc = format!("{}bsrc", label);
            let bbeauty = format!("{}bbeauty", label);
            let bmask = format!("{}bmask", label);
            let beauty_rgba = format!("{}bra", label);
            let bout = format!("{}bout", label);
            // 用 alphamerge 把灰度 mask 的 luma 注入美颜结果的 alpha，
            // 再用 overlay 按 alpha 把「美颜版」混合回「原版」（out = orig*(1-a) + beauty*a）。
            // 注：maskedmerge 在本机 ffmpeg 构建下不按 luma 限制（背景仍被改动），故不用它。
            nodes.push(format!("[{pre}]split=2[{borig}][{bsrc}]", pre = pre_label));
            nodes.push(format!("[{bsrc}]{chain}[{bbeauty}]"));
            nodes.push(format!("[{mi}:v]format=gray,scale={sw}:{sh}[{bmask}]"));
            nodes.push(format!("[{bbeauty}][{bmask}]alphamerge[{beauty_rgba}]"));
            nodes.push(format!("[{borig}][{beauty_rgba}]overlay=format=auto[{bout}]"));
            pre_label = bout;
        }
    }

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
            let half = soft / 2.0;
            let denom = if soft < 1e-3 { 1.0 } else { soft };
            let geq_expr = format!(
                "clip((lum(X,Y)/255-({t}-{h}))/({d}),0,1)*255",
                t = fmt(thr), h = fmt(half), d = fmt(denom)
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
                "[{mi}:v]trim=start_frame={sf}:end_frame={ef},setpts=PTS-STARTPTS,scale={sw}:{sh},geq=lum='{geq_expr}'[{mt}]",
                mi = matte_idx.unwrap(), sf = sf, ef = ef, sw = sw, sh = sh
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
    let opacity = keyframed(c, "transform.opacity", c.transform.opacity).clamp(0.0, 1.0);
    let tail = if opacity < 1.0 {
        format!(",colorchannelmixer=aa={},fps={}", fmt(opacity), fps)
    } else {
        format!(",fps={}", fps)
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
        let half = soft / 2.0;
        // 软化带宽 denom：softness≈0 时退化为硬阈值（denom=1，clip((v-thr)/1) 即 v>=thr?1:0）
        let denom = if soft < 1e-3 { 1.0 } else { soft };
        let geq_expr = format!(
            "clip((lum(X,Y)/255-({t}-{h}))/({d}),0,1)*255",
            t = fmt(thr), h = fmt(half), d = fmt(denom)
        );
        let mt_label = format!("{}mt", label);
        // matte 输入先缩放到与源一致尺寸（灰度 mp4 与源同分辨率；显式 scale 防尺寸偏差），
        // 再用 geq 把 luma 经 threshold/softness 映射为 alpha 层（luma=alpha）。
        nodes.push(format!("[{mi}:v]scale={sw}:{sh},geq=lum='{geq_expr}'[{mt_label}]", sw = sw, sh = sh));
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
                                nodes.push(format!("[{bi}:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}[{bg_label}]"));
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
    nodes
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
    let mut inputs: Vec<InputSpec> = Vec::new();
    for (_, c) in &video_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) { asset_to_idx.insert(a.id.clone(), inputs.len()); inputs.push(InputSpec { path: a.path.clone(), stream_loop: None }); }
        }
    }
    for c in &audio_clips {
        if let Some(a) = project.asset_by_id(&c.asset_id) {
            if !asset_to_idx.contains_key(&a.id) { asset_to_idx.insert(a.id.clone(), inputs.len()); inputs.push(InputSpec { path: a.path.clone(), stream_loop: None }); }
        }
    }
    cmd.inputs = inputs;
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
                            cmd.inputs.push(InputSpec { path: a.path.clone(), stream_loop: None });
                        }
                    }
                }
            }
        }
    }
    // 美颜·皮肤管理：皮肤区域 mask 素材（灰度 mp4）作为额外输入加入导出（独立 -i），
    // 记录其全局输入索引供 build_video_chain 引用 [idx:v]，与 matte 同一条 maskedmerge 路径。
    let mut beauty_map: HashMap<String, usize> = HashMap::new();
    for (_, c) in &video_clips {
        if let Some(b) = &c.beauty {
            if b.enabled {
                if let Some(id) = &b.mask_asset_id {
                    if !beauty_map.contains_key(id) {
                        if let Some(a) = project.asset_by_id(id) {
                            beauty_map.insert(id.clone(), cmd.inputs.len());
                            cmd.inputs.push(InputSpec { path: a.path.clone(), stream_loop: None });
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
                                cmd.inputs.push(InputSpec { path: a.path.clone(), stream_loop: Some(-1) });
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
        nodes.push(format!("color=c=black:s={}x{}[base]", w, h));
        let mut acc = "base".to_string();
        let mut vci = 0usize;
        for (track_order, clips) in &video_tracks {
            if clips.is_empty() { continue; }
            if clips.len() == 1 {
                let c = clips[0];
                let idx = match asset_to_idx.get(&c.asset_id) { Some(i) => *i, None => { vci += 1; continue; } };
                let src = format!("vs{}", vci);
                let chain = build_video_chain(c, idx, w, h, &src, project.canvas.fps, &matte_map, &bg_map, &beauty_map);
                nodes.extend(chain);
                let next_acc = format!("va{}", vci + 1);
                let ox = offset_x(c, w); let oy = offset_y(c, h);
                nodes.push(format!("[{}][{}]overlay=x={}:y={}:shortest=1[{}]", acc, src, ox, oy, next_acc));
                acc = next_acc; vci += 1;
            } else {
                let Some(mut track_acc) = build_clip_chain(clips[0], vci, &asset_to_idx, &matte_map, &bg_map, &beauty_map, w, h, &mut nodes, project.canvas.fps) else { vci += 1; continue; };
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
                    let Some(curr_label) = build_clip_chain(curr, vci, &asset_to_idx, &matte_map, &bg_map, &beauty_map, w, h, &mut nodes, project.canvas.fps) else { vci += 1; continue; };
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
