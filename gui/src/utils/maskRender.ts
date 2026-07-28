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
    case 'polygon':
      return { x: 0.5, y: 0.5, radius: 0.3, sides: 6, rotation: 0, feather: 0 };
    case 'star':
      return { x: 0.5, y: 0.5, radius: 0.3, innerRatio: 0.5, sides: 5, rotation: 0, feather: 0 };
    case 'heart':
      return { x: 0.5, y: 0.5, radius: 0.3, rotation: 0, feather: 0 };
    case 'text':
      return { x: 0.5, y: 0.5, size: 0.15, rotation: 0, feather: 0 };
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
    const m = Math.min(w, h);
    const ww = Math.max(1, (p.width ?? 0.5) * m);
    const hh = Math.max(1, (p.height ?? 0.5) * m);
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
  } else if (mask.shape === 'polygon' || mask.shape === 'star') {
    // 顶点角度：phi_k = -PI/2 + rotRad + k*seg
    //   canvas atan2 中 -PI/2 指向正上方；rotRad=rotation*PI/180，正角度=顺时针。
    //   与后端 filters.rs 极坐标 SDF 顶点相位 ang+PI/2 对齐（rotation=0 顶点在正上方）。
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const m = Math.min(w, h);
    const R = Math.max(1, (p.radius ?? 0.3) * m);
    const sides = Math.max(3, Math.round(p.sides ?? (mask.shape === 'star' ? 5 : 6)));
    const rotRad = ((p.rotation ?? 0) * Math.PI) / 180;
    const seg = (Math.PI * 2) / sides;
    ctx.beginPath();
    if (mask.shape === 'star') {
      const Rin = Math.max(1, (p.innerRatio ?? 0.5) * R);
      for (let k = 0; k < sides; k++) {
        const phi = -Math.PI / 2 + rotRad + k * seg;
        const ox = cx + R * Math.cos(phi);
        const oy = cy + R * Math.sin(phi);
        const pin = phi + seg / 2;
        const ix = cx + Rin * Math.cos(pin);
        const iy = cy + Rin * Math.sin(pin);
        if (k === 0) ctx.moveTo(ox, oy);
        else ctx.lineTo(ox, oy);
        ctx.lineTo(ix, iy);
      }
      ctx.closePath();
    } else {
      for (let k = 0; k < sides; k++) {
        const phi = -Math.PI / 2 + rotRad + k * seg;
        const px = cx + R * Math.cos(phi);
        const py = cy + R * Math.sin(phi);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  } else if (mask.shape === 'heart') {
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const m = Math.min(w, h);
    const R = Math.max(1, (p.radius ?? 0.3) * m);
    const rotRad = ((p.rotation ?? 0) * Math.PI) / 180;
    ctx.translate(cx, cy);
    ctx.rotate(rotRad);
    ctx.beginPath();
    // 经典心形参数方程（顶点朝上）：x=16sin³t, y=13cos t-5cos2t-2cos3t-cos4t
    // Canvas y 轴向下，参数方程 y 向上，故 py 取负使心形顶点朝上。
    const N = 64;
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * Math.PI * 2;
      const hx = 16 * Math.pow(Math.sin(t), 3);
      const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      const px = (hx / 17) * R;
      const py = -(hy / 17) * R;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
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

// 把单个蒙版形状（白色=可见）画到 ctx（已 cleared）。含羽化与渐变。
// 剪映式蒙版羽化：各向同性高斯模糊，以短边 min(w,h) 为归一化基准。
//   circle      → 解析式径向渐变（r-fp/2→r+fp/2），无需 temp canvas
//   linear/mirror → 羽化折叠进渐变半宽，渐变本质已是软边
//   其余形状    → 两阶段 temp canvas：绘纯白形状 → 各向同性 blur → 合成
function drawShape(ctx: CanvasRenderingContext2D, w: number, h: number, mask: MaskConfig): void {
  const feather = mask.params?.feather ?? mask.feather ?? 0;
  const minSide = Math.min(w, h);           // 统一短边归一化

  // ── text ──
  if (mask.shape === 'text') {
    const text = mask.text || '';
    if (!text) return;
    const p = mask.params || {};
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const fs = Math.max(4, (p.size ?? 0.15) * minSide);
    const rotRad = ((p.rotation ?? 0) * Math.PI) / 180;

    if (feather > 0.005 && feather * minSide > 0.5) {
      const fp = feather * minSide;
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tc = tmp.getContext('2d')!;
      tc.save();
      tc.translate(cx, cy);
      tc.rotate(rotRad);
      tc.fillStyle = '#fff';
      tc.textAlign = 'center';
      tc.textBaseline = 'middle';
      tc.font = `${fs}px sans-serif`;
      tc.fillText(text, 0, 0);
      tc.restore();
      ctx.save();
      ctx.filter = `blur(${Math.max(0.5, fp / 2)}px)`;
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    } else {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotRad);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${fs}px sans-serif`;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    return;
  }

  // ── linear / mirror：羽化折叠进渐变半宽 ──
  if (mask.shape === 'linear' || mask.shape === 'mirror') {
    const p = mask.params || {};
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const ang = ((p.angle ?? 0) * Math.PI) / 180;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    // 羽化增大渐变宽度：半宽 = (width + feather) * minSide
    const half = Math.max(1, ((p.width ?? 0.3) + feather) * minSide);
    const gx0 = cx - dx * half, gy0 = cy - dy * half;
    const gx1 = cx + dx * half, gy1 = cy + dy * half;
    const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    if (mask.shape === 'linear') {
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    } else {
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(255,255,255,1)');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  // ── circle：解析式径向渐变 ──
  if (mask.shape === 'circle') {
    const cx = (mask.params?.x ?? 0.5) * w;
    const cy = (mask.params?.y ?? 0.5) * h;
    const r = Math.max(1, (mask.params?.radius ?? 0.3) * minSide);

    if (feather > 0.005 && feather * minSide > 0.5) {
      const fp = feather * minSide;                      // 羽化总宽度
      const innerR = Math.max(0.5, r - fp / 2);          // 内边界（alpha=1）
      const outerR = r + fp / 2;                          // 外边界（alpha=0）
      const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
    return;
  }

  // ── rect / polygon / star / heart：两阶段 temp canvas + 各向同性模糊 ──
  // 剪映方式：先绘纯白形状到 temp canvas，再以各向同性高斯模糊合成到目标 ctx。
  // 此方法保证 blur 作用于完整像素空间，不受画布宽高比或形状位置影响。
  if (feather > 0.005 && feather * minSide > 0.5) {
    const fp = feather * minSide;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tc = tmp.getContext('2d')!;
    tc.fillStyle = '#fff';
    tracePath(tc, w, h, mask);          // Step 1: 绘纯白形状
    tc.fill();
    ctx.save();
    ctx.filter = `blur(${Math.max(0.5, fp / 2)}px)`; // Step 2: 各向同性模糊
    ctx.drawImage(tmp, 0, 0);                         // Step 3: 合成
    ctx.restore();
    return;
  }

  // ── 无羽化：直接绘制 ──
  ctx.save();
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

// 填充蒙版形状（含文字）。文字走 fillText 路径，其余走 tracePath → fill。
function fillMaskShape(ctx: CanvasRenderingContext2D, w: number, h: number, mask: MaskConfig): void {
  if (mask.shape === 'text') {
    const text = mask.text || '';
    if (!text) return;
    const p = mask.params || {};
    const feather = mask.params?.feather ?? mask.feather ?? 0;
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const m = Math.min(w, h);
    const fs = Math.max(4, (p.size ?? 0.15) * m);
    const rotRad = ((p.rotation ?? 0) * Math.PI) / 180;
    ctx.save();
    if (feather > 0) ctx.filter = `blur(${Math.max(0.5, feather * m * 0.5)}px)`;
    ctx.translate(cx, cy);
    ctx.rotate(rotRad);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${fs}px sans-serif`;
    ctx.fillText(text, 0, 0);
    ctx.restore();
    return;
  }
  tracePath(ctx, w, h, mask);
  ctx.fill();
}

// 描边蒙版形状（含文字）。文字走 strokeText 路径，其余走 tracePath → stroke。
function strokeMaskShape(ctx: CanvasRenderingContext2D, w: number, h: number, mask: MaskConfig): void {
  if (mask.shape === 'text') {
    const text = mask.text || '';
    if (!text) return;
    const p = mask.params || {};
    const feather = mask.params?.feather ?? mask.feather ?? 0;
    const cx = (p.x ?? 0.5) * w;
    const cy = (p.y ?? 0.5) * h;
    const m = Math.min(w, h);
    const fs = Math.max(4, (p.size ?? 0.15) * m);
    const rotRad = ((p.rotation ?? 0) * Math.PI) / 180;
    ctx.save();
    if (feather > 0) ctx.filter = `blur(${Math.max(0.5, feather * m * 0.5)}px)`;
    ctx.translate(cx, cy);
    ctx.rotate(rotRad);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${fs}px sans-serif`;
    ctx.strokeText(text, 0, 0);
    ctx.restore();
    return;
  }
  tracePath(ctx, w, h, mask);
  ctx.stroke();
}

// 构建阴影层：用 fill() 画填充形状 + blur，产生外发光光晕（不是环）。
// 返回独立 canvas，由调用方在内容【后面】合成，使阴影只出现在形状外侧。
function buildShadowLayer(w: number, h: number, masks: MaskConfig[]): HTMLCanvasElement | null {
  const enabled = masks.filter((m) => m.enabled && m.shadow?.enabled);
  if (enabled.length === 0) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const minSide = Math.min(w, h);
  for (const m of enabled) {
    const sh = m.shadow!;
    ctx.save();
    const shadowOpacity = clamp01(sh.opacity ?? 1);
    const shadowColor = sh.color || '#000000';
    const blurPx = Math.max(2, (sh.blur ?? 0.05) * minSide * 0.5);
    const a = ((sh.angle ?? 0) * Math.PI) / 180;
    const dist = Math.max(0, sh.distance ?? 0) * minSide;
    const dx = Math.cos(a) * dist;
    const dy = Math.sin(a) * dist;
    // fill() 画完整形状 + blur → 模糊的填充轮廓 = 外发光光晕
    // （旧方案用 stroke() 画轮廓线 → 产生白环/细线条，已废弃）
    ctx.translate(dx, dy);
    ctx.filter = `blur(${blurPx}px)`;
    ctx.globalAlpha = shadowOpacity;
    ctx.fillStyle = shadowColor;
    fillMaskShape(ctx, w, h, m);
    ctx.restore();
  }
  return c;
}

// 在已画好的帧上叠加描边（阴影由 buildShadowLayer + composeMaskedFrame 单独处理）。
function drawStrokeOnly(ctx: CanvasRenderingContext2D, w: number, h: number, masks: MaskConfig[]): void {
  const enabled = masks.filter((m) => m.enabled);
  const minSide = Math.min(w, h);
  for (const m of enabled) {
    if (m.stroke?.enabled) {
      ctx.save();
      ctx.globalAlpha = clamp01(m.stroke.opacity ?? 1);
      ctx.strokeStyle = m.stroke.color || '#ffffff';
      ctx.lineWidth = Math.max(0.5, (m.stroke.size ?? 0) * minSide);
      if ((m.stroke.blur ?? 0) > 0) ctx.filter = `blur(${Math.max(0.5, (m.stroke.blur as number) * minSide * 0.1)}px)`;
      strokeMaskShape(ctx, w, h, m);
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
    // 1. 阴影层画在最底（fill+blur = 外发光光晕，不是环）
    const shadowLayer = buildShadowLayer(vw, vh, masks);
    if (shadowLayer) ctx.drawImage(shadowLayer, 0, 0);

    // 2. 蒙版视频画在上面（覆盖形状内部的阴影，只留外侧光晕）
    const masked = document.createElement('canvas');
    masked.width = vw; masked.height = vh;
    const mctx = masked.getContext('2d')!;
    mctx.drawImage(source, 0, 0, vw, vh);
    mctx.globalCompositeOperation = 'destination-in';
    mctx.drawImage(alpha, 0, 0, vw, vh);
    mctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(masked, 0, 0);

    // 3. 描边画在最上
    drawStrokeOnly(ctx, vw, vh, masks);
  } catch {
    return null;
  }

  return c;
}

// HTML5 用：把蒙版 alpha 画布转成 CSS mask-image 的 dataURL（含羽化/反转/并集）。返回 null 表示无蒙版。
// aspectW/aspectH：视频素材的原始宽高（如 1920×1088）。传入后蒙版 canvas 按此比例创建，
// 避免固定 256×256 方形 canvas 在 CSS maskSize:'100% 100%' 下被拉伸导致圆形变椭圆。
// 不传时回退 256×256（向前兼容）。
export function buildMaskImageUrl(masks: MaskConfig[], aspectW?: number, aspectH?: number): string | null {
  const bw = 256;
  const bh = (aspectW && aspectH && aspectW > 0 && aspectH > 0)
    ? Math.max(1, Math.round(bw * (aspectH / aspectW)))
    : bw;
  const alpha = buildMaskAlphaCanvas(bw, bh, masks);
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
