// 美颜（Beauty）渲染：把灰度 skin_mask 视频的 luma 作为权重，对皮肤区域做磨皮/美白/清晰/肤色调整。
// 约定与 keying 的 matte 一致：mask 为灰度，luma = 权重（255 = 完全应用，0 = 不应用）。
// 仅做图像处理的预览近似（导出路径使用 ffmpeg 双边滤波等更强算法）。

import type { BeautyConfig } from '../types';

// 美颜参数（preview/导出共用的最小字段）
export interface BeautyParams {
  smoothing: number;
  whitening: number;
  clarity: number;
  skinTone: string;
}

// 多区域 mask 字段（与后端 BeautyConfig 扩展一致；前端仅消费，不修改类型定义）。
// 当 clip.beauty 带 faceMaskAssetId/neckMaskAssetId/armMaskAssetId 时，预览用合并后的皮肤区域（union）作为美颜权重，
// 使预览与后端导出一致（后端对各区域分别 alphamerge+overlay 施加美颜）。
export type MultiMaskBeauty = BeautyConfig & {
  faceMaskAssetId?: string;
  neckMaskAssetId?: string;
  armMaskAssetId?: string;
  landmarkAssetId?: string;
  parseModel?: string;
};

// 单个区域 mask 的引用（资产 id + 真实文件系统路径）
export interface BeautyMaskRef {
  id: string;
  path: string;
}

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

// 合并多张区域 mask 的权重：对每个像素取各区域 luma 权重的最大值（union，即任一区域标记为皮肤即生效）。
// 权重范围 0..1。masks 为空或全为 null 时返回 null。各 mask 尺寸不一致时按最近邻缩放到源尺寸。
function buildMergedMaskWeights(masks: (HTMLCanvasElement | null)[], sw: number, sh: number): Float32Array | null {
  if (!masks || masks.length === 0) return null;
  const N = sw * sh;
  let merged: Float32Array | null = null;
  let any = false;
  for (const m of masks) {
    if (!m) continue;
    const w = buildMaskWeights(m, sw, sh);
    if (!w) continue; // buildMaskWeights 返回的是新数组，可安全就地修改
    any = true;
    if (!merged) {
      merged = w;
    } else {
      for (let p = 0; p < N; p++) if (w[p] > merged[p]) merged[p] = w[p];
    }
  }
  return any ? merged : null;
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
// 对一帧 source 应用美颜核心逻辑（就地修改 source 的像素），权重由 w 提供（仅 w>0 的皮肤区域生效）。
// 调用方负责构建权重数组（单 mask 或多 mask 合并）。
function applyBeautyCore(source: HTMLCanvasElement, beauty: BeautyParams, w: Float32Array): void {
  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) return;

  const sctx = source.getContext('2d');
  if (!sctx) return;
  const img = sctx.getImageData(0, 0, sw, sh);
  const d = img.data;
  const N = sw * sh;

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
  const tone = beauty.skinTone;
  const hasTone = !!tone && tone !== 'none' && tone !== 'natural';
  const tint = 0.15;
  const tintAmt = 255 * tint;

  for (let p = 0, i = 0; p < N; p++, i += 4) {
    const wp = w[p];
    if (wp <= 0) continue; // 背景/非皮肤区域：保持原像素
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

// 对一帧 source 应用美颜（就地修改 source 的像素，仅在单张 mask 的权重 > 0 的皮肤区域生效）。
// 保持原调用方式向后兼容（调用方仍可用单 maskCanvas）。
export function applyBeauty(
  source: HTMLCanvasElement,
  mask: HTMLCanvasElement | null,
  beauty: BeautyParams,
): void {
  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) return;
  const noEffect =
    !beauty.smoothing && !beauty.whitening && !beauty.clarity &&
    !(!!beauty.skinTone && beauty.skinTone !== 'none' && beauty.skinTone !== 'natural');
  if (!mask || noEffect) return;
  const w = buildMaskWeights(mask, sw, sh);
  if (!w) return;
  applyBeautyCore(source, beauty, w);
}

// 对一帧 source 应用美颜（多区域 mask 合并版）。
// masks 为各区域（脸/脖/臂）的灰度 mask canvas 数组；合并权重取各区域 luma 的 max（union），
// 使预览仅作用于皮肤区域（脸+脖+臂），与后端导出一致。masks 为空/全 null 或未启用效果时直接返回（no-op）。
export function applyBeautyMulti(
  source: HTMLCanvasElement,
  masks: (HTMLCanvasElement | null)[],
  beauty: BeautyParams,
): void {
  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) return;
  const noEffect =
    !beauty.smoothing && !beauty.whitening && !beauty.clarity &&
    !(!!beauty.skinTone && beauty.skinTone !== 'none' && beauty.skinTone !== 'natural');
  if (noEffect) return;
  if (!masks || masks.length === 0) return;
  const w = buildMergedMaskWeights(masks, sw, sh);
  if (!w) return;
  applyBeautyCore(source, beauty, w);
}

// 对一帧 source 施加 warp 形变（瘦脸/大眼），就地修改 source 像素。
// warpX / warpY 为 gray16le 解码后的绝对像素坐标（row-major，长度 = mapW*mapH，
// 与后端 warp.generate_warp_maps 约定一致：xmap[y][x] = 输出像素 (x,y) 应采样的源帧 x 坐标）。
// 恒等（thinFace=bigEye=0）时 xmap==xs、ymap==ys，逐像素等于原图（本实现在该条件下精确还原）。
// 预览分辨率（srcW×srcH）与源分辨率（mapW×mapH）通常一致；为稳健，把预览坐标映射到形变图索引
// 取绝对源坐标，再映射回预览尺寸采样：out[y][x] = src[ sy ][ sx ]。
export function applyWarp(
  source: HTMLCanvasElement,
  warpX: Float32Array,
  warpY: Float32Array,
  mapW: number,
  mapH: number,
): void {
  const srcW = source.width;
  const srcH = source.height;
  if (!srcW || !srcH || mapW <= 1 || mapH <= 1) return;
  if (warpX.length < mapW * mapH || warpY.length < mapW * mapH) return;
  const sctx = source.getContext('2d');
  if (!sctx) return;
  const img = sctx.getImageData(0, 0, srcW, srcH);
  const d = img.data;
  // 备份整幅原图：目标像素 (x,y) 要从源坐标 (sx,sy) 采样，必须读原像素而非已写结果。
  const src = new Uint8ClampedArray(d);
  // 预览坐标 ↔ 形变图索引 / 源坐标 的比例（分辨率一致时均为 1，恒等逐像素还原）
  const toMapX = srcW > 1 ? (mapW - 1) / (srcW - 1) : 0;
  const toMapY = srcH > 1 ? (mapH - 1) / (srcH - 1) : 0;
  const toCanvasX = mapW > 1 ? (srcW - 1) / (mapW - 1) : 0;
  const toCanvasY = mapH > 1 ? (srcH - 1) / (mapH - 1) : 0;
  for (let y = 0; y < srcH; y++) {
    const my = Math.min(mapH - 1, Math.max(0, Math.round(y * toMapY)));
    for (let x = 0; x < srcW; x++) {
      const mx = Math.min(mapW - 1, Math.max(0, Math.round(x * toMapX)));
      const mi = my * mapW + mx;
      const sxa = warpX[mi]; // 绝对源 x 坐标（0..mapW-1）
      const sya = warpY[mi]; // 绝对源 y 坐标（0..mapH-1）
      let sx = Math.round(sxa * toCanvasX);
      let sy = Math.round(sya * toCanvasY);
      sx = Math.min(srcW - 1, Math.max(0, sx));
      sy = Math.min(srcH - 1, Math.max(0, sy));
      const si = (sy * srcW + sx) * 4;
      const di = (y * srcW + x) * 4;
      d[di] = src[si];
      d[di + 1] = src[si + 1];
      d[di + 2] = src[si + 2];
      d[di + 3] = src[si + 3];
    }
  }
  sctx.putImageData(img, 0, 0);
}

// 从 clip.beauty（多区域或单 mask）解析需要作用的 mask 资产引用列表（优先脸/脖/臂 union，回退单 maskAssetId）。
// assets 为工程资产列表（只需 id 与 path 字段）。返回按 face→neck→arm 顺序的引用数组（已去重、剔除无路径项）。
export function resolveBeautyMaskRefs(
  beauty: MultiMaskBeauty | undefined,
  assets: ReadonlyArray<{ id: string; path: string }>,
): BeautyMaskRef[] {
  const refs: BeautyMaskRef[] = [];
  if (!beauty) return refs;
  const push = (id?: string) => {
    if (!id) return;
    const a = assets.find((x) => x.id === id);
    if (a && a.path) refs.push({ id: a.id, path: a.path });
  };
  push(beauty.faceMaskAssetId);
  push(beauty.neckMaskAssetId);
  push(beauty.armMaskAssetId);
  // 回退：仅有旧的单 maskAssetId（兼容历史工程）
  if (refs.length === 0) push(beauty.maskAssetId);
  return refs;
}

// 取一组 mask 资产在当前时刻的帧 canvas（每个资产 id 独立离屏 canvas，避免互相覆盖）。
// 未就绪（视频未加载）的资产返回 null，被跳过。videoCache 按 url 缓存隐藏 <video>，canvasCache 按资产 id 缓存离屏 canvas。
export function getBeautyMaskCanvases(
  refs: BeautyMaskRef[],
  videoCache: { current: Map<string, HTMLVideoElement> },
  canvasCache: { current: Map<string, HTMLCanvasElement> },
  srcTime: number,
  srcPaused: boolean,
  srcRate: number,
  targetW: number,
  targetH: number,
): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  if (!refs || refs.length === 0) return out;
  for (const r of refs) {
    let c = canvasCache.current.get(r.id);
    if (!c) {
      c = document.createElement('canvas');
      canvasCache.current.set(r.id, c);
    }
    const frame = drawBeautyMaskFrame(r.path, videoCache, { current: c }, srcTime, srcPaused, srcRate, targetW, targetH);
    if (frame) out.push(frame);
  }
  return out;
}
