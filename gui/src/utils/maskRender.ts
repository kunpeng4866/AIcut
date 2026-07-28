// 蒙版渲染工具：把 clip.masks 解析为「蒙版 alpha」并合成到视频帧。
// 同时服务于两条预览路径：
//  - WebGPU：composeMaskedFrame() 在上传前把「视频帧 × 蒙版 alpha」画到离屏 canvas，再上传纹理（最小侵入式）。
//  - HTML5：buildMaskAlphaCanvas() 生成蒙版 alpha 图，转为 CSS mask-image（含羽化/反转/多蒙版并集）。
import type { MaskConfig, MaskShape } from '../types';

// 各形状默认参数（归一化 0~1）
export function defaultMaskParams(shape: MaskShape): Record<string, number> {
  switch (shape) {
    case 'rect':
      return { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, roundness: 0, feather: 0 };
    case 'circle':
      return { x: 0.5, y: 0.5, radius: 0.3, feather: 0 };
    case 'linear':
      return { x: 0.5, y: 0.5, angle: 0, width: 0.3, feather: 0 };
    case 'mirror':
      return { x: 0.5, y: 0.5, angle: 0, width: 0.3, spread: 0.3, feather: 0 };
    default:
      return { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, roundness: 0, feather: 0 };
  }
}

// 新建一条默认蒙版（默认 rect）
export function createDefaultMask(shape: MaskShape, id: string): MaskConfig {
  return {
    id,
    shape,
    enabled: true,
    invert: false,
    feather: 0,
    params: defaultMaskParams(shape),
  };
}

// 在 ctx 上描出蒙版形状路径（仅 path，不填充/描边）；坐标为归一化 0..1 映射到 w×h。
function tracePath(ctx: CanvasRenderingContext2D, w: number, h: number, mask: MaskConfig): void {
  const p = mask.params || {};
  if (mask.shape === 'rect') {
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const ww = Math.max(1, (p.width ?? 0.5) * w);
    const hh = Math.max(1, (p.height ?? 0.5) * h);
    const rot = ((p.rotation ?? 0) * Math.PI) / 180;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    const r = p.roundness ?? 0; // 0..1 → 圆角半径（相对短边）
    const rad = r > 0 ? Math.min(ww, hh) * r * 0.5 : 0;
    roundRectPath(ctx, -ww / 2, -hh / 2, ww, hh, rad);
  } else if (mask.shape === 'circle') {
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const r = Math.max(1, (p.radius ?? 0.3) * Math.min(w, h));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else if (mask.shape === 'linear' || mask.shape === 'mirror') {
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const ang = ((p.angle ?? 0) * Math.PI) / 180;
    // 旋转坐标系让渐变带方向水平，路径覆盖全幅即可
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.rect(-w, -h, w * 2, h * 2);
  }
}

// 圆角矩形路径（兼容无 ctx.roundRect 的环境）
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 把单个蒙版形状（白色=可见）画到 ctx（已 cleared）。含羽化（模糊）与渐变。
function drawShape(ctx: CanvasRenderingContext2D, w: number, h: number, mask: MaskConfig): void {
  const feather = mask.feather ?? 0;
  if (mask.shape === 'linear' || mask.shape === 'mirror') {
    const p = mask.params || {};
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const ang = ((p.angle ?? 0) * Math.PI) / 180;
    const half = Math.max(1, (p.width ?? 0.3) * Math.min(w, h));
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const gx0 = cx - dx * half, gy0 = cy - dy * half;
    const gx1 = cx + dx * half, gy1 = cy + dy * half;
    const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    if (mask.shape === 'linear') {
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    } else {
      // mirror：中间透明、两端不透明（对称渐变带）
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(255,255,255,1)');
    }
    ctx.save();
    if (feather > 0) ctx.filter = `blur(${Math.max(0.5, feather * Math.min(w, h) * 0.5)}px)`;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return;
  }
  ctx.save();
  if (feather > 0) ctx.filter = `blur(${Math.max(0.5, feather * Math.min(w, h) * 0.5)}px)`;
  ctx.fillStyle = '#fff';
  tracePath(ctx, w, h, mask);
  ctx.fill();
  ctx.restore();
}

// 计算单个蒙版的可见 alpha 画布（白=可见，透明=隐藏），已处理 invert。
function maskShapeAlpha(w: number, h: number, mask: MaskConfig): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d')!;
  if (!mask.invert) {
    drawShape(cx, w, h, mask);
  } else {
    // 反相：先全白，再挖掉形状
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, w, h);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    drawShape(tmp.getContext('2d')!, w, h, mask);
    cx.globalCompositeOperation = 'destination-out';
    cx.drawImage(tmp, 0, 0);
    cx.globalCompositeOperation = 'source-over';
  }
  return c;
}

// 生成蒙版 alpha 画布（归一化坐标系）。多蒙版取并集（lighter 叠加）。无启用蒙版返回 null。
export function buildMaskAlphaCanvas(w: number, h: number, masks: MaskConfig[]): HTMLCanvasElement | null {
  const enabled = masks.filter((m) => m.enabled);
  if (enabled.length === 0) return null;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.globalCompositeOperation = 'lighter';
  for (const m of enabled) {
    ctx.drawImage(maskShapeAlpha(w, h, m), 0, 0);
  }
  ctx.globalCompositeOperation = 'source-over';
  return out;
}

// 在已画好（已蒙版）的帧上叠加描边与阴影（预览近似）。
function drawStrokeShadow(ctx: CanvasRenderingContext2D, w: number, h: number, masks: MaskConfig[]): void {
  const enabled = masks.filter((m) => m.enabled);
  const minSide = Math.min(w, h);
  for (const m of enabled) {
    if (m.stroke?.enabled) {
      ctx.save();
      ctx.globalAlpha = clamp01(m.stroke.opacity ?? 1);
      ctx.strokeStyle = m.stroke.color || '#ffffff';
      ctx.lineWidth = Math.max(0.5, (m.stroke.size ?? 0) * minSide);
      if ((m.stroke.blur ?? 0) > 0) ctx.filter = `blur(${Math.max(0.5, (m.stroke.blur as number) * minSide * 0.1)}px)`;
      tracePath(ctx, w, h, m);
      ctx.stroke();
      ctx.restore();
    }
    if (m.shadow?.enabled) {
      ctx.save();
      // 不透明：烘焙进 shadowColor 的 alpha（比依赖 globalAlpha 更稳健、跨浏览器一致）。
      // 注意：shadowColor 自带 alpha，这里 globalAlpha 保持 1，避免双重相乘压暗。
      ctx.globalAlpha = 1;
      ctx.shadowColor = hexToRgba(m.shadow.color || '#000000', clamp01(m.shadow.opacity ?? 1));
      ctx.shadowBlur = Math.max(0, m.shadow.blur ?? 0) * minSide * 0.2;
      const a = ((m.shadow.angle ?? 0) * Math.PI) / 180;
      const dist = Math.max(0, m.shadow.distance ?? 0) * minSide;
      ctx.shadowOffsetX = Math.cos(a) * dist;
      ctx.shadowOffsetY = Math.sin(a) * dist;
      // 透明填充 + 实心阴影：仅显示投影，不遮挡内容
      ctx.fillStyle = 'rgba(0,0,0,0)';
      tracePath(ctx, w, h, m);
      ctx.fill();
      ctx.restore();
    }
  }
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

// 把 #rgb / #rrggbb 颜色按 alpha(0~1) 转 rgba 字符串（供阴影不透明烘焙进颜色使用）。
function hexToRgba(hex: string, alpha: number): string {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${clamp01(alpha)})`;
}

// WebGPU 用：把视频帧（source）与蒙版 alpha 合成，返回含 alpha 的 canvas（白=可见区保留）。
// 无启用蒙版返回 null（调用方回退用原帧）。
export function composeMaskedFrame(
  source: CanvasImageSource,
  vw: number,
  vh: number,
  masks: MaskConfig[],
): HTMLCanvasElement | null {
  const alpha = buildMaskAlphaCanvas(vw, vh, masks);
  if (!alpha) return null;
  const c = document.createElement('canvas');
  c.width = vw; c.height = vh;
  const ctx = c.getContext('2d')!;
  try {
    ctx.drawImage(source, 0, 0, vw, vh);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(alpha, 0, 0, vw, vh);
    ctx.globalCompositeOperation = 'source-over';
    drawStrokeShadow(ctx, vw, vh, masks);
  } catch {
    return null;
  }
  return c;
}

// HTML5 用：把蒙版 alpha 画布转成 CSS mask-image 的 dataURL（含羽化/反转/并集）。返回 null 表示无蒙版。
export function buildMaskImageUrl(masks: MaskConfig[]): string | null {
  const alpha = buildMaskAlphaCanvas(256, 256, masks);
  if (!alpha) return null;
  try {
    return alpha.toDataURL();
  } catch {
    return null;
  }
}

// HTML5 用：把启用蒙版中的阴影合并为一个 CSS drop-shadow 字符串（近似）。无阴影返回 null。
// 不透明：烘焙进颜色的 rgba alpha（修复此前 drop-shadow 颜色用不透明 hex、opacity 失效的问题）。
// 归一化参数按参考显示尺寸换算，保证不同预览尺寸下都有明显响应。
export function buildMaskShadowFilter(masks: MaskConfig[]): string | null {
  const enabled = masks.filter((m) => m.enabled && m.shadow?.enabled);
  if (enabled.length === 0) return null;
  const sh = enabled[0].shadow!;
  const ref = 480; // 参考显示短边（px），使 blur/distance 归一化参数有稳定可见幅度
  const blur = Math.max(0, sh.blur ?? 0) * ref * 0.5;
  const a = ((sh.angle ?? 0) * Math.PI) / 180;
  const dist = Math.max(0, sh.distance ?? 0) * ref;
  const dx = Math.round(Math.cos(a) * dist);
  const dy = Math.round(Math.sin(a) * dist);
  const color = hexToRgba(sh.color || '#000000', clamp01(sh.opacity ?? 1));
  return `drop-shadow(${dx}px ${dy}px ${Math.round(blur)}px ${color})`;
}
