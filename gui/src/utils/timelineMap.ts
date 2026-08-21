// timelineMap.ts
// 字幕「素材源时间戳」→ 时间线绝对秒 的映射，与后端 src/subtitle.rs::source_to_timeline
// 及 PreviewCanvas 字幕渲染逐字节一致。TTS 落轨必须用它，否则曲线变速/倒放场景下
// 音频起点会与字幕显示位置错位。
//
// 三类分支（与 Rust 端对齐）：
//   - 曲线变速（time_remap.curve 非空）：二分反解归一化偏移 offNorm，使
//       speedIntegral(curve, offNorm, 0) == (src - src_range.start) / dur
//     再 T = timelineIn + offNorm · dur。曲线是「播放偏移→速度」的分段线性插值，
//     srcT(off) = srcStart + ∫₀^off speed(τ) dτ（梯形积分）。
//   - 倒放（time_remap.reverse，无曲线）：T = timelineIn + dur - (src - srcStart)/speed
//   - 线性（默认）：T = timelineIn + (src - srcStart)/speed
// 注：冻结(freeze)分支在后端 source_to_timeline 中本就被忽略（与导出端一致），
//     故此处不特殊处理冻结，沿用线性公式即可。

import type { ClipConfig, SpeedPointConfig } from '../types';
import { rawSpeedIntegral } from './speedCurve';

/**
 * 速度曲线积分（绝对速度）：把「速度曲线」积分为源素材时间。
 * 与 src/pipeline/strategy.rs::speed_integral 逐字节一致。
 * @param curve 速度点序列（play/speed 分段线性），无需预先排序（内部排序）
 * @param off   归一化播放偏移 [0,1]（与片段绝对时长解耦）
 * @param srcStart 源区间起点（积分基准）
 */
export function speedIntegral(curve: SpeedPointConfig[], off: number, srcStart: number): number {
  if (!curve || curve.length === 0) return srcStart;
  const pts = [...curve].sort((a, b) => a.play - b.play);
  let acc = 0.0;
  const first = pts[0];
  if (off <= first.play) return srcStart + Math.max(0, off) * first.speed;
  acc += first.play * first.speed;
  const last = pts.length - 1;
  for (let i = 1; i <= last; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const span = b.play - a.play;
    if (off <= b.play) {
      const frac = Math.abs(span) < 1e-12 ? 0.0 : (off - a.play) / span;
      const speedOff = a.speed + (b.speed - a.speed) * frac;
      acc += ((a.speed + speedOff) / 2.0) * (off - a.play);
      return srcStart + acc;
    } else if (Math.abs(span) >= 1e-12) {
      acc += ((a.speed + b.speed) / 2.0) * span;
    }
  }
  const lastPt = pts[last];
  if (off > lastPt.play) acc += (off - lastPt.play) * lastPt.speed;
  return srcStart + acc;
}

/**
 * 源素材时间 → 时间线绝对秒（source_to_timeline）。
 * 与 src/subtitle.rs::source_to_timeline 逐字节一致。
 * @param clip 字幕 clip（其 src_range / timelineIn / timelineOut / speed / time_remap 参与计算）
 * @param src  字幕 item.start（素材源时间戳，可能非相对 clip 偏移）
 */
export function sourceToTimeline(clip: ClipConfig, src: number): number {
  const timelineIn = clip.timelineIn;
  const dur = clip.timelineOut - timelineIn;
  const remap = clip.time_remap;
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const srcStart = clip.src_range?.start ?? 0;

  let off: number;
  const curve = remap?.curve;
  if (curve && curve.length > 0) {
    // 曲线变速：二分反解 offNorm，使 speedIntegral(curve, offNorm, 0) == target
    const target = dur > 1e-9 ? (src - srcStart) / dur : 0.0;
    let lo = 0.0;
    let hi = 1.0;
    for (let i = 0; i < 80; i++) {
      const mid = 0.5 * (lo + hi);
      if (speedIntegral(curve, mid, 0.0) < target) lo = mid;
      else hi = mid;
    }
    off = 0.5 * (lo + hi) * dur;
  } else if (remap?.reverse) {
    // 倒放：对称公式
    off = dur - (src - srcStart) / speed;
  } else {
    // 线性
    off = (src - srcStart) / speed;
  }
  return timelineIn + off;
}

/**
 * 字幕 item 在时间线上的「实际显示起点」（与 PreviewCanvas 逐字节一致，且裁剪进 clip
 * 的活跃窗口 [timelineIn, timelineOut)）。TTS 配音必须落在这里，否则：
 *   - 倒放/曲线变速时 source_to_timeline(item.start) 不等于字幕显示的起点（倒放会把 item
 *     的起点 source 时间映射到时间线末尾），导致配音整体滞后；
 *   - 设了「时间偏移 lead」且 item 起点被 lead 推到 clip 起点之前时，旧写法
 *     source_to_timeline(item.start - lead) 会算出负的 timelineIn，使开场句（如"大家看一下"）
 *     落在时间线原点之前 → 音频片段不可见（"漏掉"）。
 * 本函数直接复刻 PreviewCanvas 的判定：
 *   显示当 (srcT(t) + lead) ∈ [item.start, item.end) 且 t ∈ [timelineIn, timelineOut)。
 *   返回满足条件的最小 t（即显示起点）。冻结(freeze)在字幕路径本就被忽略，此处同样忽略。
 */
export function subtitleItemDisplayStart(
  clip: ClipConfig,
  item: { start: number; end: number },
  lead = 0,
): number {
  const timelineIn = clip.timelineIn;
  const timelineOut = clip.timelineOut;
  const dur = timelineOut - timelineIn;
  const remap = clip.time_remap ?? { reverse: false, freeze: null, curve: [] as SpeedPointConfig[] };
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const srcStart = clip.src_range?.start ?? 0;
  const srcEnd = clip.src_range?.end ?? srcStart + dur;

  const srcTAt = (t: number): number => {
    const off = t - timelineIn;
    if (remap.curve && remap.curve.length > 0) {
      const offNorm = dur > 1e-6 ? off / dur : 0;
      const s = srcStart + dur * rawSpeedIntegral(remap.curve, offNorm);
      return Math.max(srcStart, Math.min(srcEnd, s));
    }
    const s = remap.reverse
      ? srcStart + (dur - off) * speed
      : srcStart + off * speed;
    return s;
  };

  // 细扫时间线，找「显示窗口」起点（monotonic：线性/曲线递增、倒放递减，起点即首个满足条件的 t）。
  const step = Math.max(0.0005, dur / 8000);
  for (let t = timelineIn; t < timelineOut - 1e-9; t += step) {
    const s = srcTAt(t) + lead;
    if (s >= item.start - 1e-9 && s < item.end - 1e-9) return t;
  }
  // 兜底：item 源区间不完全落在本 clip 内时，退化为裁剪后的 source_to_timeline。
  const approx = sourceToTimeline(clip, item.start - lead);
  return Math.max(timelineIn, Math.min(timelineOut, approx));
}

/**
 * 字幕 item 在时间线上的「实际显示末端」（subtitleItemDisplayStart 的对称）。
 * 与 PreviewCanvas 判定一致：返回满足 (srcT(t)+lead)∈[item.start,item.end) 且
 * t∈[timelineIn,timelineOut) 的**最后一个** t（含 step 粒度误差，量级 dur/8000，可忽略）。
 * TTS 用它拿「字幕显示窗口时长」= displayEnd - displayStart，从而让配音 speed = L/窗口
 * 精确填满字幕窗口（不依赖 TTS 语速≈原语速的假设）。
 */
export function subtitleItemDisplayEnd(
  clip: ClipConfig,
  item: { start: number; end: number },
  lead = 0,
): number {
  const timelineIn = clip.timelineIn;
  const timelineOut = clip.timelineOut;
  const dur = timelineOut - timelineIn;
  const remap = clip.time_remap ?? { reverse: false, freeze: null, curve: [] as SpeedPointConfig[] };
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const srcStart = clip.src_range?.start ?? 0;
  const srcEnd = clip.src_range?.end ?? srcStart + dur;

  const srcTAt = (t: number): number => {
    const off = t - timelineIn;
    if (remap.curve && remap.curve.length > 0) {
      const offNorm = dur > 1e-6 ? off / dur : 0;
      const s = srcStart + dur * rawSpeedIntegral(remap.curve, offNorm);
      return Math.max(srcStart, Math.min(srcEnd, s));
    }
    const s = remap.reverse
      ? srcStart + (dur - off) * speed
      : srcStart + off * speed;
    return s;
  };

  const step = Math.max(0.0005, dur / 8000);
  let last = timelineIn;
  for (let t = timelineIn; t < timelineOut - 1e-9; t += step) {
    const s = srcTAt(t) + lead;
    if (s >= item.start - 1e-9 && s < item.end - 1e-9) last = t;
  }
  // 半开区间 [start, end) 的末端：最后一个满足条件的 t 再补一个 step，保证窗口覆盖到 item 结束。
  return Math.min(timelineOut, last + step);
}
