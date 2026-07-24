// 转场预览计算（与 src/pipeline/export.rs::render_video_frame 的转场逻辑镜像）
// 转场数据模型：clip.transition 挂在"出片段"上，作用于本片段结尾与同轨下一片段之间。
//   transitionType: 'none' | 'fade' | 'dissolve' | 'slide' | 'wipe'
//   duration: 秒（转场窗长度），默认 0.5
//   direction: 'left' | 'right' | 'up' | 'down'（仅 wipe 用，默认 'right'）
// 转场窗：[timelineOut - duration, timelineOut)
import { ClipConfig, TrackConfig } from '../types';

export interface TransitionPreviewLayer {
  clip: ClipConfig; // 入片段（同轨下一片段，在转场窗内被提前叠到出片段上方）
  trackId: string;
  opacity: number; // 入片段在当前时刻的不透明度（fade/dissolve/slide: 0→1；wipe: 恒 1）
  // 归一化偏移：相对舞台宽/高，0..1。slide 时从右侧外（1）滑入归位（0）。
  offsetX: number;
  offsetY: number;
  zIndex: number;
  // wipe 入片段 CSS clip-path（HTML5 用），其余类型 null
  clipPath: string | null;
  // wipe 入片段遮罩矩形（归一化 x0,y0,x1,y1，y-down），WebGPU 用；其余类型 null
  maskRect: [number, number, number, number] | null;
  direction: string;
}

// 出片段在转场窗内的合成信息（预览统一入口）
export interface OutClipTransition {
  opacity: number; // fade/dissolve/slide 淡出(窗外=1)；wipe 恒 1
  clipPath: string | null; // wipe 出片段 CSS clip-path（HTML5）；其余 null
  maskRect: [number, number, number, number] | null; // wipe 出片段遮罩（WebGPU）；其余 null
}

const DEFAULT_DUR = 0.5;

function transitionOf(clip: ClipConfig) {
  const tr = clip.transition;
  if (!tr || tr.transitionType === undefined || tr.transitionType === 'none') return null;
  const dur = tr.duration && tr.duration > 0 ? tr.duration : DEFAULT_DUR;
  const dir = (tr.direction as string) || 'right';
  return { type: tr.transitionType, dur, dir };
}

// wipe 几何（归一化矩形 x0,y0,x1,y1，y-down）：返回 [出片段矩形, 入片段矩形]
// 约定（与 export.rs::wipe_rects 一致）：
//   right: 入片段从左向右揭示 → 入=[0,0,p,1]，出=[p,0,1,1]
//   left : 入片段从右向左揭示 → 入=[1-p,0,1,1]，出=[0,0,1-p,1]
//   up   : 入片段从下向上揭示 → 入=[0,1-p,1,1]，出=[0,0,1,1-p]
//   down : 入片段从上向下揭示 → 入=[0,0,1,p]，出=[0,p,1,1]
export function wipeRects(direction: string, p: number): { outRect: [number, number, number, number]; inRect: [number, number, number, number] } {
  const c = Math.max(0, Math.min(1, p));
  switch (direction) {
    case 'left':
      return { outRect: [0, 0, 1 - c, 1], inRect: [1 - c, 0, 1, 1] };
    case 'up':
      return { outRect: [0, 0, 1, 1 - c], inRect: [0, 1 - c, 1, 1] };
    case 'down':
      return { outRect: [0, c, 1, 1], inRect: [0, 0, 1, c] };
    case 'right':
    default:
      return { outRect: [c, 0, 1, 1], inRect: [0, 0, c, 1] };
  }
}

// 归一化矩形 → CSS inset(top right bottom left)
function rectToClipPath(r: [number, number, number, number]): string {
  const t = (r[1] * 100).toFixed(2);
  const rt = ((1 - r[2]) * 100).toFixed(2);
  const b = ((1 - r[3]) * 100).toFixed(2);
  const l = (r[0] * 100).toFixed(2);
  return `inset(${t}% ${rt}% ${b}% ${l}%)`;
}

// 出片段在转场窗内的不透明度：窗外 = 1（无影响），窗内 fade/dissolve = 1 - progress 淡出；wipe/slide = 1。
export function computeOutClipOpacity(outClip: ClipConfig, currentTime: number): number {
  return getOutClipTransition(outClip, currentTime).opacity;
}

// 出片段转场合成信息（opacity + clipPath + maskRect），预览 HTML5/WebGPU 统一消费
export function getOutClipTransition(outClip: ClipConfig, currentTime: number): OutClipTransition {
  const tr = transitionOf(outClip);
  if (!tr) return { opacity: 1, clipPath: null, maskRect: null };
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return { opacity: 1, clipPath: null, maskRect: null };
  const progress = (currentTime - (outT - tr.dur)) / tr.dur; // 0 -> 1
  if (tr.type === 'wipe') {
    const { outRect } = wipeRects(tr.dir, progress);
    return { opacity: 1, clipPath: rectToClipPath(outRect), maskRect: outRect };
  }
  return { opacity: 1 - progress, clipPath: null, maskRect: null };
}

// 给定某轨在 currentTime 的"出片段"（当前活跃片段），计算转场附加的入片段层。
// 返回 null = 不在转场窗 / 无转场 / 找不到同轨下一片段。
export function getIncomingTransitionLayer(
  track: TrackConfig,
  outClip: ClipConfig,
  currentTime: number,
): TransitionPreviewLayer | null {
  const tr = transitionOf(outClip);
  if (!tr) return null;
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return null;
  const progress = (currentTime - (outT - tr.dur)) / tr.dur; // 0 -> 1
  // 同轨下一片段：timelineIn 最接近 outT（邻接）的那个
  const next = [...track.clips]
    .filter((c) => c.id !== outClip.id && c.timelineIn >= outT - 1e-4)
    .sort((a, b) => a.timelineIn - b.timelineIn)[0];
  if (!next) return null;

  let offsetX = 0;
  let offsetY = 0;
  let opacity = progress;
  let clipPath: string | null = null;
  let maskRect: [number, number, number, number] | null = null;
  if (tr.type === 'slide') {
    // 从右侧滑入：起始在最右外（1 个舞台宽），结束归位（0）
    offsetX = 1 - progress;
  } else if (tr.type === 'wipe') {
    // wipe：入片段与出片段都满不透明，仅靠 clip-path/mask 揭示
    opacity = 1;
    const { inRect } = wipeRects(tr.dir, progress);
    clipPath = rectToClipPath(inRect);
    maskRect = inRect;
  }
  // fade 与 dissolve 在预览中等价：纯 opacity 交叉（导出侧 dissolve 也是 opacity 交叉）
  return {
    clip: next,
    trackId: track.id,
    opacity,
    offsetX,
    offsetY,
    zIndex: 102, // 盖在出片段之上
    clipPath,
    maskRect,
    direction: tr.dir,
  };
}
