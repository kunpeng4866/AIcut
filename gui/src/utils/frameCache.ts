// 无依赖的「帧预解码缓存」：用隐藏 <video> 高倍速播放 + requestVideoFrameCallback
// 抓取每一呈现帧为 ImageBitmap，按素材源时间排序缓存。供倒放/冻结等「手动驱动」片段
// 在播放时按源时间直接取帧呈现，绕开每帧 seek 的解码延迟，实现满帧流畅。
//
// 降级策略：浏览器不支持 rVFC / 片段过长 / 帧数超限 → status='unsupported'，调用方回退到现有 seek。

export interface CachedFrame {
  srcTime: number; // 素材源时间（秒）
  bitmap: ImageBitmap;
}

export type FrameCacheStatus = 'idle' | 'decoding' | 'ready' | 'unsupported' | 'error';

const MAX_CLIP_SECONDS = 20; // 超过则不缓存（避免爆内存），回退 seek
const CAPTURE_RATE = 2; // 抓取倍速（≈源帧率的一半密度，兼顾速度与流畅）
const MAX_DIM = 640; // 缓存帧最长边上限（控制内存）
const MAX_FRAMES = 500; // 帧数上限，超出视为过长 → 回退

export function isRVFCSupported(): boolean {
  return typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
}

export class ClipFrameCache {
  status: FrameCacheStatus = 'idle';
  frames: CachedFrame[] = [];
  private video: HTMLVideoElement | null = null;
  private handle = 0;
  private stopped = false;

  async decode(src: string, srcStart: number, srcEnd: number): Promise<void> {
    if (!isRVFCSupported()) { this.status = 'unsupported'; return; }
    if (srcEnd - srcStart > MAX_CLIP_SECONDS || srcEnd <= srcStart) { this.status = 'unsupported'; return; }
    this.status = 'decoding';
    this.stopped = false;

    const video = document.createElement('video');
    this.video = video;
    video.src = src;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';

    // 等元数据拿到尺寸/时长
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) resolve();
      else video.onloadedmetadata = () => resolve();
    });

    const vw = video.videoWidth || MAX_DIM;
    const vh = video.videoHeight || MAX_DIM;
    const scale = Math.min(1, MAX_DIM / Math.max(1, vw, vh));
    const rw = Math.max(1, Math.round(vw * scale));
    const rh = Math.max(1, Math.round(vh * scale));

    let aborted = false;
    await new Promise<void>((resolve) => {
      video.playbackRate = CAPTURE_RATE;
      const p = video.play();
      if (p && typeof (p as any).catch === 'function') (p as any).catch(() => {});
      const step = () => {
        if (this.stopped) { resolve(); return; }
        const t = video.currentTime;
        if (t >= srcEnd || video.ended) { resolve(); return; }
        if (t >= srcStart) {
          if (this.frames.length >= MAX_FRAMES) { this.stopped = true; aborted = true; resolve(); return; }
          createImageBitmap(video, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'low' })
            .then((bmp) => { if (!this.stopped) this.frames.push({ srcTime: t, bitmap: bmp }); })
            .catch(() => {});
        }
        this.handle = (video as any).requestVideoFrameCallback(step);
      };
      this.handle = (video as any).requestVideoFrameCallback(step);
    });

    if (aborted) { this.status = 'unsupported'; this.dispose(); return; }
    if (this.stopped) { this.status = 'error'; this.dispose(); return; }
    this.frames.sort((a, b) => a.srcTime - b.srcTime);
    this.status = 'ready';
  }

  // 取离 srcTime 最近的缓存帧（二分），未就绪返回 null
  getFrame(srcTime: number): ImageBitmap | null {
    if (this.status !== 'ready' || this.frames.length === 0) return null;
    const f = this.frames;
    if (srcTime <= f[0].srcTime) return f[0].bitmap;
    if (srcTime >= f[f.length - 1].srcTime) return f[f.length - 1].bitmap;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid].srcTime < srcTime) lo = mid + 1; else hi = mid;
    }
    const a = f[lo], b = f[lo - 1];
    return (Math.abs(a.srcTime - srcTime) < Math.abs(b.srcTime - srcTime) ? a : b).bitmap;
  }

  dispose(): void {
    this.stopped = true;
    if (this.handle && this.video) {
      try { (this.video as any).cancelVideoFrameCallback(this.handle); } catch { /* noop */ }
    }
    if (this.video) {
      try { this.video.pause(); this.video.removeAttribute('src'); (this.video as any).load?.(); } catch { /* noop */ }
      this.video = null;
    }
    for (const f of this.frames) { try { f.bitmap.close(); } catch { /* noop */ } }
    this.frames = [];
  }
}
