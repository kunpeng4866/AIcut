// 抠像（Keying）渲染：M1 仅实现 chroma 色度抠图。
// 把 source 按 KeyingConfig 做 RGB 距离抠像，输出带 alpha 的 canvas（透明区露出下层）。
// 逻辑镜像 maskRender.ts 的 composeMaskedFrame：离屏合成 → 像素处理 → 返回 canvas。
import type { KeyingConfig } from '../types';

// 对一帧 source 应用 chroma key，返回带透明通道的 canvas；不满足条件时返回 null（调用方回退原帧）。
export function applyKeying(
  source: CanvasImageSource,
  vw: number,
  vh: number,
  keying: KeyingConfig,
): HTMLCanvasElement | null {
  if (!keying || !keying.enabled || keying.mode !== 'chroma') return null;

  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, vw, vh);

  const img = ctx.getImageData(0, 0, vw, vh);
  const d = img.data;
  const kr = parseInt(keying.color.slice(1, 3), 16);
  const kg = parseInt(keying.color.slice(3, 5), 16);
  const kb = parseInt(keying.color.slice(5, 7), 16);
  const maxDist = Math.sqrt(3) * 255;
  const sim = keying.similarity;
  const es = Math.max(1e-4, keying.edgeSoftness);
  const spill = keying.spill;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const dist = Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) / maxDist;

    // 透明(alpha)计算：≤similarity 完全抠除；≥similarity+edgeSoftness 完全保留；中间线性羽化
    let a: number;
    if (dist <= sim) a = 0;
    else if (dist >= sim + es) a = 255;
    else a = ((dist - sim) / es) * 255;

    // 溢出抑制：对保留像素，降低与键色同主通道的溢光
    if (a > 0 && spill > 0) {
      const kc = Math.max(kr, kg, kb);
      let nr = r;
      let ng = g;
      let nb = b;
      if (kc === kg) {
        const red = spill * Math.max(0, g - Math.max(r, b));
        ng = Math.max(0, g - red);
      } else if (kc === kr) {
        const red = spill * Math.max(0, r - Math.max(g, b));
        nr = Math.max(0, r - red);
      } else {
        const red = spill * Math.max(0, b - Math.max(r, g));
        nb = Math.max(0, b - red);
      }
      d[i] = nr;
      d[i + 1] = ng;
      d[i + 2] = nb;
    }

    d[i + 3] = a;
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 从关键帧轨道采样某属性在全局时间 t 的值（线性插值，匹配 Rust KeyframeTrack::sample 的线性段）。
// track: clip.keyframes[prop]（数组 [{time,value,easing}]）；无轨道/不足 1 帧时回退 base。
// 用线性（‘线性’缓动≈恒等，是实际行为；Rust 仅 Linear 被中文标签命中，其余回退 Linear）。
export function sampleKeyframe(track: any, t: number, base: number): number {
  if (!Array.isArray(track) || track.length === 0) return base;
  const kfs = track.slice().sort((a: any, b: any) => a.time - b.time);
  if (kfs.length === 1) return typeof kfs[0].value === 'number' ? kfs[0].value : base;
  if (t <= kfs[0].time) return typeof kfs[0].value === 'number' ? kfs[0].value : base;
  const last = kfs[kfs.length - 1];
  if (t >= last.time) return typeof last.value === 'number' ? last.value : base;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const f = span > 0 ? (t - a.time) / span : 0;
      const va = typeof a.value === 'number' ? a.value : base;
      const vb = typeof b.value === 'number' ? b.value : base;
      return va + (vb - va) * f;
    }
  }
  return base;
}

// smoothstep 曲线（GLSL 语义）：edge0==edge1 时退化为硬阶跃
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 智能抠像（smart mode）预览合成：把灰度 matte 视频的 luma 作为 alpha 叠加到源视频。
// matte 约定：luma = matte 值（0=背景,255=前景）。
// source: 当前源帧；matteCanvas: 已绘制好当前帧 matte 的 canvas（灰度，尺寸 vw×vh）；
// threshold:0..1；softness:0..1（边缘柔化带宽）。返回带 alpha 的 canvas；不满足时返回 null。
export function applyMatte(
  source: CanvasImageSource,
  matteCanvas: HTMLCanvasElement,
  threshold: number,
  softness: number,
): HTMLCanvasElement | null {
  if (!matteCanvas || matteCanvas.width <= 0 || matteCanvas.height <= 0) return null;

  const vw = matteCanvas.width;
  const vh = matteCanvas.height;

  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, vw, vh);

  const img = ctx.getImageData(0, 0, vw, vh);
  const d = img.data;

  const mctx = matteCanvas.getContext('2d');
  if (!mctx) return null;
  const matteImg = mctx.getImageData(0, 0, vw, vh);
  const m = matteImg.data;

  const lo = threshold - softness * 0.5;
  const hi = threshold + softness * 0.5;

  for (let i = 0; i < d.length; i += 4) {
    // matte 为灰度，取 R 通道即 luma（matte/255）
    const mv = m[i] / 255;
    let a: number;
    if (softness <= 0) {
      a = mv >= threshold ? 255 : 0; // 硬阈值
    } else {
      a = smoothstep(lo, hi, mv) * 255;
    }
    d[i + 3] = a;
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 背景合成（P3）：把带 alpha 的 keyed 帧（已抠像）合成到背景之上。
// bg 支持三类：
//   - 颜色串 '#rrggbb'：铺纯色底
//   - 已就绪的图片/视频/画布元素（CanvasImageSource）：铺满绘制
//   - null / 空：不铺背景，直接返回 keyed（透明区露出下层）
// 返回新 canvas（底色 + keyed 叠加）；bg 未就绪时退化为仅 keyed（调用方回退透明）。
export function compositeBackground(
  keyed: HTMLCanvasElement,
  bg: string | CanvasImageSource | null | undefined,
  vw: number,
  vh: number,
): HTMLCanvasElement {
  if (!bg) return keyed;
  const canvas = document.createElement('canvas');
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return keyed;
  if (typeof bg === 'string') {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, vw, vh);
  } else {
    try {
      ctx.drawImage(bg as CanvasImageSource, 0, 0, vw, vh);
    } catch {
      /* 背景元素尚未就绪：退回透明底（仅画 keyed） */
    }
  }
  ctx.drawImage(keyed, 0, 0);
  return canvas;
}
