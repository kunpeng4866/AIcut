// 美颜（Beauty）渲染：把灰度 skin_mask 视频的 luma 作为权重，对皮肤区域做磨皮/美白/清晰/肤色调整。
// 约定与 keying 的 matte 一致：mask 为灰度，luma = 权重（255 = 完全应用，0 = 不应用）。
// 仅做图像处理的预览近似（导出路径使用 ffmpeg 双边滤波等更强算法）。

// 简易可分离 box blur（水平 + 垂直各一遍，边缘 clamp 重复）。radius<=0 时原样返回。
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src;
  const win = radius * 2 + 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  // 水平
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const xi = Math.min(w - 1, Math.max(0, k));
      sum += src[row + xi];
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      const addIdx = Math.min(w - 1, Math.max(0, x + radius + 1));
      const subIdx = Math.min(w - 1, Math.max(0, x - radius));
      sum += src[row + addIdx] - src[row + subIdx];
    }
  }
  // 垂直
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const yi = Math.min(h - 1, Math.max(0, k));
      sum += tmp[yi * w + x];
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      const addIdx = Math.min(h - 1, Math.max(0, y + radius + 1));
      const subIdx = Math.min(h - 1, Math.max(0, y - radius));
      sum += tmp[addIdx * w + x] - tmp[subIdx * w + x];
    }
  }
  return out;
}

// 把 mask 的 luma 采样成与 source 同尺寸的权重数组（mask 尺寸不一致时用最近邻缩放）。
function buildMaskWeights(mask: HTMLCanvasElement, sw: number, sh: number): Float32Array | null {
  const mctx = mask.getContext('2d');
  if (!mctx) return null;
  const mw = mask.width;
  const mh = mask.height;
  if (mw <= 0 || mh <= 0) return null;
  const md = mctx.getImageData(0, 0, mw, mh).data;
  const w = new Float32Array(sw * sh);
  if (mw === sw && mh === sh) {
    for (let p = 0, i = 0; p < w.length; p++, i += 4) w[p] = md[i] / 255;
  } else {
    const sx = mw / sw;
    const sy = mh / sh;
    for (let y = 0; y < sh; y++) {
      const my = Math.min(mh - 1, Math.floor(y * sy));
      for (let x = 0; x < sw; x++) {
        const mx = Math.min(mw - 1, Math.floor(x * sx));
        const mi = (my * mw + mx) * 4;
        w[y * sw + x] = md[mi] / 255;
      }
    }
  }
  return w;
}

// 取当前时刻的 skin_mask 帧（灰度）绘制到离屏 canvas 并返回。
// 与 getMatteFrame 完全对称：隐藏 <video> 按 maskAssetPath 创建、与源视频同步 currentTime、
// 仅在漂移 > 0.05s 时纠正 seek。videoCache/canvasRef 由调用方持有（避免重复创建）。
export function drawBeautyMaskFrame(
  maskAssetPath: string,
  videoCache: { current: Map<string, HTMLVideoElement> },
  canvasRef: { current: HTMLCanvasElement | null },
  srcTime: number,
  srcPaused: boolean,
  srcRate: number,
  targetW: number,
  targetH: number,
): HTMLCanvasElement | null {
  if (!maskAssetPath) return null;
  const path = /^(https?|aicut-asset|blob):/.test(maskAssetPath)
    ? maskAssetPath
    : `aicut-asset:///${maskAssetPath.replace(/\\/g, '/')}`;
  let video = videoCache.current.get(path);
  if (!video) {
    video = document.createElement('video');
    video.src = path;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    videoCache.current.set(path, video);
    video.play().catch(() => {});
  }
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return null;
  if (isFinite(srcRate) && srcRate > 0) video.playbackRate = srcRate;
  if (srcPaused) {
    video.pause();
    if (!video.seeking) video.currentTime = Math.max(0, srcTime);
  } else {
    video.play().catch(() => {});
    if (!video.seeking && Math.abs(video.currentTime - srcTime) > 0.05) {
      video.currentTime = Math.max(0, srcTime);
    }
  }
  let mc = canvasRef.current;
  if (!mc) { mc = document.createElement('canvas'); canvasRef.current = mc; }
  if (mc.width !== targetW) mc.width = targetW;
  if (mc.height !== targetH) mc.height = targetH;
  const mctx = mc.getContext('2d');
  if (!mctx) return null;
  mctx.drawImage(video, 0, 0, targetW, targetH);
  return mc;
}

// 对一帧 source 应用美颜（就地修改 source 的像素，仅在 mask 权重 > 0 的皮肤区域生效）。
// mask 为 null 或所有参数均为 0 且 skinTone==='none' 时直接返回（no-op）。
export function applyBeauty(
  source: HTMLCanvasElement,
  mask: HTMLCanvasElement | null,
  beauty: { smoothing: number; whitening: number; clarity: number; skinTone: string },
): void {
  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) return;

  const tone = beauty.skinTone;
  const hasTone = !!tone && tone !== 'none' && tone !== 'natural';
  const noEffect =
    !beauty.smoothing && !beauty.whitening && !beauty.clarity && !hasTone;
  if (!mask || noEffect) return;

  const sctx = source.getContext('2d');
  if (!sctx) return;
  const img = sctx.getImageData(0, 0, sw, sh);
  const d = img.data;
  const N = sw * sh;

  const w = buildMaskWeights(mask, sw, sh);
  if (!w) return;

  // 拆通道到 Float32，便于浮点混合（避免每像素对象分配）
  const R = new Float32Array(N);
  const G = new Float32Array(N);
  const B = new Float32Array(N);
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    R[p] = d[i];
    G[p] = d[i + 1];
    B[p] = d[i + 2];
  }

  // 磨皮：可分离模糊（半径 0..8），与原图按 s 混合
  const rSmooth = Math.round((beauty.smoothing / 100) * 8);
  const sR = rSmooth > 0 ? boxBlur(R, sw, sh, rSmooth) : null;
  const sG = rSmooth > 0 ? boxBlur(G, sw, sh, rSmooth) : null;
  const sB = rSmooth > 0 ? boxBlur(B, sw, sh, rSmooth) : null;
  const s = (beauty.smoothing / 100) * 0.85;

  // 美白：亮度/饱和度
  const bright = (beauty.whitening / 100) * 0.25;
  const sat = 1 - (beauty.whitening / 100) * 0.15;
  const bright255 = bright * 255;

  // 清晰：unsharp，小半径模糊
  const amount = (beauty.clarity / 100) * 1.5;
  const cR = beauty.clarity ? boxBlur(R, sw, sh, 1) : null;
  const cG = beauty.clarity ? boxBlur(G, sw, sh, 1) : null;
  const cB = beauty.clarity ? boxBlur(B, sw, sh, 1) : null;

  // 肤色：轻微通道 tint（强度系数 0.15）
  const tint = 0.15;
  const tintAmt = 255 * tint;

  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const wp = w[p];
    if (wp <= 0) continue; // 背景区域：保持原像素
    let r = R[p];
    let g = G[p];
    let bl = B[p];

    // 磨皮
    if (s > 0 && sR && sG && sB) {
      r += (sR[p] - r) * s;
      g += (sG[p] - g) * s;
      bl += (sB[p] - bl) * s;
    }

    // 美白：YUV-ish（先过亮/饱和）
    if (bright255 !== 0 || sat !== 1) {
      r = (r - 128) * sat + 128 + bright255;
      g = (g - 128) * sat + 128 + bright255;
      bl = (bl - 128) * sat + 128 + bright255;
    }

    // 清晰：unsharp
    if (amount > 0 && cR && cG && cB) {
      r += amount * (r - cR[p]);
      g += amount * (g - cG[p]);
      bl += amount * (bl - cB[p]);
    }

    // 肤色 tint
    if (hasTone) {
      if (tone === 'cool') { bl += tintAmt; r -= tintAmt; }
      else if (tone === 'warm') { r += tintAmt; bl -= tintAmt; }
      else if (tone === 'wheat' || tone === 'bronze') { r += tintAmt; g += tintAmt; bl -= tintAmt; }
    }

    // 与 mask 权重合成（Uint8ClampedArray 自动 clamp 0..255）
    d[i] = r * wp + R[p] * (1 - wp);
    d[i + 1] = g * wp + G[p] * (1 - wp);
    d[i + 2] = bl * wp + B[p] * (1 - wp);
  }

  sctx.putImageData(img, 0, 0);
}
