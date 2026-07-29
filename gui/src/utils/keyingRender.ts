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
