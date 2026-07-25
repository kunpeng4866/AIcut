// 转场预览计算（与 src/pipeline/export.rs::render_video_frame 的转场逻辑镜像）
// 转场数据模型：clip.transition 挂在"出片段"上，作用于本片段结尾与同轨下一片段之间。
//   transitionType: 'none' | 'fade' | 'dissolve' | 'slide' | 'wipe'
//   duration: 秒（转场窗长度），默认 0.5
//   direction: 'left' | 'right' | 'up' | 'down'（仅 wipe 用，默认 'right'）
// 转场窗：[timelineOut - duration, timelineOut)
import { ClipConfig, TrackConfig, TransitionEasing, MaskShape } from '../types';

// 圆形遮罩（归一化画布坐标，0..1，y-down）；feather 为归一化羽化宽度（0..~0.15）
export interface CircleMask { cx: number; cy: number; r: number; feather: number }
// 出/入片段遮罩：线性矩形（WebGPU 硬裁切）或圆形（归一化圆，WebGPU/HTML5 共用），其余类型 null
export type MaskRect = [number, number, number, number] | CircleMask | null;

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
  // wipe 入片段遮罩：矩形（WebGPU 硬裁切）或圆形，其余类型 null
  maskRect: MaskRect;
  direction: string;
  // 新增类型附加渲染字段（HTML5 / WebGPU 消费）
  transform?: string;   // zoom: scale(...) CSS
  filter?: string;      // blur: blur(...) CSS
  maskImage?: string | null; // feather 软边（HTML5 mask-image 渐变），无羽化时 null
  feather?: number;     // 归一化羽化宽度（0..~0.15），供参考
}

// 出片段在转场窗内的合成信息（预览统一入口）
export interface OutClipTransition {
  opacity: number; // fade/dissolve/slide 淡出(窗外=1)；wipe 恒 1
  clipPath: string | null; // wipe 出片段 CSS clip-path（HTML5）；其余 null
  maskRect: MaskRect; // wipe 出片段遮罩（WebGPU）；其余 null
  transform?: string;   // zoom 等：scale(...) CSS
  filter?: string;      // blur 等：blur(...) CSS
  maskImage?: string | null; // feather 软边（HTML5），无羽化时 null
  feather?: number;     // 归一化羽化宽度（0..~0.15）
}

const DEFAULT_DUR = 0.5;

function transitionOf(clip: ClipConfig) {
  const tr = clip.transition;
  if (!tr || tr.transitionType === undefined || tr.transitionType === 'none') return null;
  const dur = tr.duration && tr.duration > 0 ? tr.duration : DEFAULT_DUR;
  const dir = (tr.direction as string) || 'right';
  const easing = (tr.easing as TransitionEasing) || 'ease-in-out';
  const feather = tr.feather === undefined ? 10 : Math.max(0, Math.min(30, tr.feather));
  const blurAmount = tr.blurAmount === undefined ? 65 : Math.max(0, Math.min(100, tr.blurAmount));
  const maskShape = (tr.maskShape as MaskShape) || 'linear';
  return { type: tr.transitionType, dur, dir, easing, feather, blurAmount, maskShape };
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

// 缓动曲线：linear 原样返回；undefined 按 ease-in-out 处理（丝滑默认）
export function applyEasing(easing: TransitionEasing | undefined, p: number): number {
  if (easing === 'linear') return p;
  if (p < 0.5) return 2 * p * p;
  return 1 - Math.pow(-2 * p + 2, 2) / 2;
}

// 羽化（0–30）→ 归一化软边宽度（0–~0.15，相对画布宽/高）
function normFeather(feather: number): number {
  return Math.max(0, Math.min(1, feather / 30)) * 0.15;
}

// 圆形遮罩（归一化）：半径随 progress 0→1 由 0 增至 0.75（即 75% 参考半径），中心 (0.5,0.5)
export function circleRects(p: number, feather = 10): CircleMask {
  const c = Math.max(0, Math.min(1, p));
  return { cx: 0.5, cy: 0.5, r: c * 0.75, feather: normFeather(feather) };
}

// 线性 wipe 羽化 CSS mask（HTML5 用）：可见 range 内不透明，边界按 feather 软边
function wipeFeatherMask(direction: string, p: number, fw: number, forIncoming: boolean): string {
  const horiz = direction === 'left' || direction === 'right';
  const axis = horiz ? 'to right' : 'to bottom';
  let a: number, b: number;
  if (direction === 'right' || direction === 'down') { a = 0; b = p; }
  else { a = 1 - p; b = 1; }
  const a0 = Math.max(0, (a - fw) * 100), a1 = Math.min(100, (a + fw) * 100);
  const b0 = Math.max(0, (b - fw) * 100), b1 = Math.min(100, (b + fw) * 100);
  const O = forIncoming ? 1 : 0; // 可见区 alpha（incoming 内可见、out 外可见）
  const T = forIncoming ? 0 : 1; // 外部 alpha
  return `linear-gradient(${axis}, rgba(0,0,0,${T}) 0%, rgba(0,0,0,${T}) ${a0}%, rgba(0,0,0,${O}) ${a1}%, rgba(0,0,0,${O}) ${b0}%, rgba(0,0,0,${T}) ${b1}%, rgba(0,0,0,${T}) 100%)`;
}

// 圆形羽化 CSS mask（HTML5 用）：圆内不透明、圆外透明，边界按 feather 软边
function circleFeatherMask(r: number, fw: number): string {
  const r0 = Math.max(0, (r - fw) * 100);
  const r1 = Math.min(100, (r + fw) * 100);
  return `radial-gradient(circle at 50% 50%, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${r0}%, rgba(0,0,0,0) ${r1}%, rgba(0,0,0,0) 100%)`;
}

// 出片段在转场窗内的不透明度：窗外 = 1（无影响），窗内 fade/dissolve = 1 - progress 淡出；wipe/slide = 1。
export function computeOutClipOpacity(outClip: ClipConfig, currentTime: number): number {
  return getOutClipTransition(outClip, currentTime).opacity;
}

// 出片段转场合成信息（opacity + clipPath + maskRect + transform/filter），预览 HTML5/WebGPU 统一消费
export function getOutClipTransition(outClip: ClipConfig, currentTime: number): OutClipTransition {
  const tr = transitionOf(outClip);
  if (!tr) return { opacity: 1, clipPath: null, maskRect: null };
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return { opacity: 1, clipPath: null, maskRect: null };
  const progress = (currentTime - (outT - tr.dur)) / tr.dur; // 0 -> 1
  const ep = applyEasing(tr.easing, progress);
  switch (tr.type) {
    case 'fade':
    case 'dissolve':
      return { opacity: 1 - ep, clipPath: null, maskRect: null };
    case 'slide':
      return { opacity: 1, clipPath: null, maskRect: null };
    case 'zoom':
      // 出片段放大淡出：scale(1 → 1.12)
      return { opacity: 1 - ep, transform: `scale(${1 + 0.12 * ep})`, clipPath: null, maskRect: null };
    case 'blur':
      // 出片段模糊淡出：blur(0 → blurAmount/100*40 px)
      return { opacity: 1 - ep, filter: `blur(${(tr.blurAmount / 100) * 40 * ep}px)`, clipPath: null, maskRect: null };
    case 'flash':
      // 闪白由独立 overlay 处理（见 getFlashOverlay），出片段仅淡出
      return { opacity: 1 - ep, clipPath: null, maskRect: null };
    case 'wipe':
      if (tr.maskShape === 'circle') {
        // 圆形揭示：出片段保持全幅，圆形由入片段层（clipPath circle）盖住出片段
        return { opacity: 1, clipPath: null, maskRect: null };
      }
      // 线性 wipe：出片段裁到剩余矩形；feather>0 时附软边 mask（HTML5 优先用 maskImage）
      {
        const { outRect } = wipeRects(tr.dir, ep);
        const fw = normFeather(tr.feather);
        const res: OutClipTransition = {
          opacity: 1,
          clipPath: rectToClipPath(outRect),
          maskRect: outRect,
          feather: fw,
        };
        if (fw > 0) res.maskImage = wipeFeatherMask(tr.dir, ep, fw, false);
        return res;
      }
    default:
      return { opacity: 1 - ep, clipPath: null, maskRect: null };
  }
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

  const ep = applyEasing(tr.easing, progress);
  let offsetX = 0;
  let offsetY = 0;
  let opacity = ep;
  let clipPath: string | null = null;
  let maskRect: MaskRect = null;
  let transform: string | undefined;
  let filter: string | undefined;
  let maskImage: string | null = null;
  let feather: number | undefined;
  if (tr.type === 'slide') {
    // 从右侧滑入：起始在最右外（1 个舞台宽），结束归位（0）
    offsetX = 1 - ep;
  } else if (tr.type === 'zoom') {
    // 入片段放大归位：scale(0.88 → 1.0) + 淡入
    transform = `scale(${0.88 + 0.12 * ep})`;
    opacity = ep;
  } else if (tr.type === 'blur') {
    // 入片段清晰淡入（模糊只作用于出片段）
    opacity = ep;
  } else if (tr.type === 'flash') {
    // 入片段直接淡入（闪白由独立 overlay 处理）
    opacity = ep;
  } else if (tr.type === 'wipe') {
    // wipe：入片段与出片段都满不透明，仅靠 clip-path/mask 揭示
    opacity = 1;
    if (tr.maskShape === 'circle') {
      // 圆形揭示：入片段按 circle() clip-path 盖住出片段（出片段保持全幅）
      const cr = circleRects(ep, tr.feather);
      clipPath = `circle(${ep * 75}% at 50% 50%)`;
      maskRect = cr;
      const fw = normFeather(tr.feather);
      if (fw > 0) maskImage = circleFeatherMask(cr.r, fw);
    } else {
      const { inRect } = wipeRects(tr.dir, ep);
      clipPath = rectToClipPath(inRect);
      maskRect = inRect;
      const fw = normFeather(tr.feather);
      feather = fw;
      if (fw > 0) maskImage = wipeFeatherMask(tr.dir, ep, fw, true);
    }
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
    transform,
    filter,
    maskImage,
    feather,
  };
}

// flash 转场白场 overlay（独立全幅白色 div，叠在转场层之上）：仅 flash 类型在转场窗内返回峰值在中点的不透明度
export function getFlashOverlay(outClip: ClipConfig, currentTime: number): { opacity: number } | null {
  const tr = transitionOf(outClip);
  if (!tr || tr.type !== 'flash') return null;
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return null;
  const progress = (currentTime - (outT - tr.dur)) / tr.dur;
  const ep = applyEasing(tr.easing, progress);
  return { opacity: Math.sin(ep * Math.PI) }; // 窗中点 ep=0.5 → sin(π/2)=1 白场峰值
}

// ── 音频交叉淡化 ──
// 任何非 none 转场对音频都退化为 equal-power 交叉淡化（wipe/slide 等视觉类型对音频同理）。
// 出片段在转场窗内音频 gain = cos(progress·π/2)（1→0）；入片段 = sin(progress·π/2)（0→1）。

// equal-power 交叉淡化包络：progress 0→1 时 out 1→0、in 0→1
export function audioCrossfadeEnv(progress: number): { outEnv: number; inEnv: number } {
  const p = Math.max(0, Math.min(1, progress));
  return { outEnv: Math.cos(p * Math.PI / 2), inEnv: Math.sin(p * Math.PI / 2) };
}

// 出片段在转场窗内的音频包络（1 = 无影响）。预览统一入口，给"出片段"媒体元素乘此系数。
export function getOutClipAudioEnv(outClip: ClipConfig, currentTime: number): number {
  const tr = transitionOf(outClip);
  if (!tr) return 1;
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return 1;
  const progress = (currentTime - (outT - tr.dur)) / tr.dur;
  return audioCrossfadeEnv(progress).outEnv;
}

// 给定出片段所在轨，返回转场窗内的入片段（音频交叉淡化用）。返回 { inClip, progress } 或 null。
// 入片段在转场窗内（currentTime < in.timelineIn）尚未"活跃"，预览需单独渲染并定位其音频。
export function getIncomingAudioTransitionLayer(
  track: TrackConfig,
  outClip: ClipConfig,
  currentTime: number,
): { inClip: ClipConfig; progress: number } | null {
  const tr = transitionOf(outClip);
  if (!tr) return null;
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return null;
  const progress = (currentTime - (outT - tr.dur)) / tr.dur;
  const next = [...track.clips]
    .filter((c) => c.id !== outClip.id && c.timelineIn >= outT - 1e-4)
    .sort((a, b) => a.timelineIn - b.timelineIn)[0];
  if (!next) return null;
  return { inClip: next, progress };
}

// ── 音频淡入/淡出增益 ──
// clip.audioFadeIn / clip.audioFadeOut：片段开头/结尾的淡入/淡出时长（秒），0 = 无。
// 相对时间 rt = currentTime - clip.timelineIn：
//   rt < fadeIn        → raised-cosine 0→1（淡入，sin）
//   rt > dur - fadeOut → raised-cosine 1→0（淡出，cos）
// 否则 1.0。增益夹 [0, 1]。
// 采用 raised-cosine（两端切线为 0）而非线性斜坡：既消除线性增益突变带来的咔哒声，
// 也让时间轴上画出的淡变曲线天然平滑。须与 src/pipeline/export.rs::fade_gain_at 一致。

export function getClipFadeGain(clip: ClipConfig, currentTime: number): number {
  const dur = clip.timelineOut - clip.timelineIn;
  if (dur <= 0) return 1;
  let rt = currentTime - clip.timelineIn;
  rt = Math.max(0, Math.min(dur, rt));
  const fi = clip.audioFadeIn ?? 0;
  const fo = clip.audioFadeOut ?? 0;
  if (fi > 0 && rt < fi) {
    const p = Math.max(0, Math.min(1, rt / fi));
    return Math.sin((Math.PI / 2) * p);
  }
  if (fo > 0 && rt > dur - fo) {
    // 淡出：rt 从 dur-fo(满音量,p=0) → dur(静音,p=1)，逐步降低。
    const p = Math.max(0, Math.min(1, (rt - (dur - fo)) / fo));
    return Math.cos((Math.PI / 2) * p);
  }
  return 1;
}
