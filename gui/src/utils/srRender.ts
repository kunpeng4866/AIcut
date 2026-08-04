// 超清增强（Super Resolution）对比预览。
// 与 keyingRender / beautyRender 不同：SR 是**导出级后处理**，会整体改变分辨率，
// 无法进入 WebGPU 时间轴合成（见 src/sr.rs 架构说明）。因此这里不做逐帧像素处理，
// 只用两个 <video> 元素叠放 + clip-path 滑块做「原图 vs 超分」左右对比。
//
// 播放同步：以「原图」为主时钟，rAF 内把超分视频对齐到主时钟（偏差 > SYNC_TOLERANCE 才 seek），
// 避免每帧强制赋值 currentTime 造成的抖动。

// 本地 pathToUrl（与 KeyingTab / WebGPUPreview / PreviewCanvas 内实现一致，避免循环依赖）。
// 真实文件系统路径统一走 aicut-asset:// 自定义协议（主进程已注册，pathname 解析忽略查询串）。
const pathToUrl = (path: string): string => {
  if (/^(https?|aicut-asset|blob|file):/.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  return `aicut-asset:///${normalized}`;
};

// 主/从视频时间偏差超过该值（秒）才做一次 seek 对齐
const SYNC_TOLERANCE = 0.08;

const px = (v: number) => `${v}px`;

/**
 * 在 container 内渲染「原图 vs 超分」滑块对比预览。
 *
 * @param container   宿主元素（内容会被清空后重建）
 * @param originalPath 原始素材路径（真实文件系统路径或已是可播放 URL）
 * @param srPath       超分产物路径（同上）
 * @returns cleanup 函数：停止 rAF、暂停并释放两个 video、清空 container
 */
export function renderSRCompare(
  container: HTMLElement,
  originalPath: string,
  srPath: string,
): () => void {
  container.innerHTML = '';

  // ── 舞台：两个视频等尺寸叠放，超分层用 clip-path 按比例裁切露出 ──
  const stage = document.createElement('div');
  stage.style.cssText = [
    'position:relative', 'width:100%', 'aspect-ratio:16/9',
    'background:#000', 'border-radius:4px', 'overflow:hidden',
    'margin-bottom:8px', 'user-select:none',
  ].join(';');

  const mkVideo = (src: string): HTMLVideoElement => {
    const v = document.createElement('video');
    v.src = pathToUrl(src);
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.style.cssText = [
      'position:absolute', 'inset:0', 'width:100%', 'height:100%',
      'object-fit:contain', 'pointer-events:none',
    ].join(';');
    return v;
  };

  const origVideo = mkVideo(originalPath);   // 主时钟
  const srVideo = mkVideo(srPath);           // 从时钟

  // 超分层包一层容器：clip-path 作用在容器上，避免影响 video 自身的 object-fit 计算
  const srLayer = document.createElement('div');
  srLayer.style.cssText = 'position:absolute;inset:0;clip-path:inset(0 0 0 50%)';
  srLayer.appendChild(srVideo);

  // 分割线（跟随滑块位置）
  const divider = document.createElement('div');
  divider.style.cssText = [
    'position:absolute', 'top:0', 'bottom:0', 'left:50%', 'width:2px',
    'background:#e94560', 'pointer-events:none', 'box-shadow:0 0 4px rgba(233,69,96,0.8)',
  ].join(';');

  const mkTag = (text: string, side: 'left' | 'right'): HTMLDivElement => {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = [
      'position:absolute', 'top:6px', `${side}:6px`,
      'background:rgba(15,52,96,0.85)', 'color:#eee', 'font-size:10px',
      'padding:2px 6px', 'border-radius:3px', 'pointer-events:none',
    ].join(';');
    return t;
  };

  stage.appendChild(origVideo);
  stage.appendChild(srLayer);
  stage.appendChild(divider);
  stage.appendChild(mkTag('原图', 'left'));
  stage.appendChild(mkTag('超分', 'right'));

  // ── 控制条：分割位置滑块 + 播放/暂停 + 从头播 ──
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';

  const btnStyle = [
    'background:#0f3460', 'color:#eee', 'border:1px solid #1a1a2e',
    'border-radius:4px', 'padding:4px 8px', 'font-size:11px', 'cursor:pointer',
  ].join(';');

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.textContent = '播放';
  playBtn.style.cssText = btnStyle;

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = '回到开头';
  resetBtn.style.cssText = btnStyle;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = '50';
  slider.style.cssText = 'flex:1;accent-color:#e94560;cursor:ew-resize';

  controls.appendChild(playBtn);
  controls.appendChild(resetBtn);
  controls.appendChild(slider);

  // 分辨率信息（元数据就绪后填充，直观体现「放大了多少」）
  const info = document.createElement('div');
  info.style.cssText = 'color:#6b7794;font-size:10px;line-height:1.4';
  info.textContent = '加载中…';

  container.appendChild(stage);
  container.appendChild(controls);
  container.appendChild(info);

  // ── 交互 ──
  const applySplit = (pct: number) => {
    const p = Math.min(100, Math.max(0, pct));
    srLayer.style.clipPath = `inset(0 0 0 ${p}%)`;
    divider.style.left = `${p}%`;
  };
  const onSlider = () => applySplit(parseFloat(slider.value) || 0);
  slider.addEventListener('input', onSlider);

  // 在舞台上直接拖动也能移动分割线（比只用滑块更顺手）
  let dragging = false;
  const splitFromEvent = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    if (r.width <= 0) return;
    const pct = ((e.clientX - r.left) / r.width) * 100;
    slider.value = String(Math.round(Math.min(100, Math.max(0, pct))));
    onSlider();
  };
  const onStageDown = (e: PointerEvent) => {
    dragging = true;
    stage.setPointerCapture?.(e.pointerId);
    splitFromEvent(e);
  };
  const onStageMove = (e: PointerEvent) => { if (dragging) splitFromEvent(e); };
  const onStageUp = () => { dragging = false; };
  stage.style.cursor = 'ew-resize';
  stage.addEventListener('pointerdown', onStageDown);
  stage.addEventListener('pointermove', onStageMove);
  stage.addEventListener('pointerup', onStageUp);
  stage.addEventListener('pointerleave', onStageUp);

  const onPlayBtn = () => {
    if (origVideo.paused) {
      void origVideo.play().catch(() => { /* 自动播放被拒时忽略 */ });
      void srVideo.play().catch(() => { /* 从时钟播放失败不影响对比 */ });
      playBtn.textContent = '暂停';
    } else {
      origVideo.pause();
      srVideo.pause();
      playBtn.textContent = '播放';
    }
  };
  playBtn.addEventListener('click', onPlayBtn);

  const onResetBtn = () => {
    origVideo.currentTime = 0;
    srVideo.currentTime = 0;
  };
  resetBtn.addEventListener('click', onResetBtn);

  // 元数据就绪后：按原始宽高比修正舞台比例，并展示两侧分辨率
  const updateInfo = () => {
    if (origVideo.videoWidth > 0 && origVideo.videoHeight > 0) {
      stage.style.aspectRatio = `${origVideo.videoWidth}/${origVideo.videoHeight}`;
    }
    const o = origVideo.videoWidth > 0 ? `${origVideo.videoWidth}×${origVideo.videoHeight}` : '—';
    const s = srVideo.videoWidth > 0 ? `${srVideo.videoWidth}×${srVideo.videoHeight}` : '—';
    info.textContent = `原图 ${o}  →  超分 ${s}   （拖动画面或滑块移动分割线）`;
  };
  origVideo.addEventListener('loadedmetadata', updateInfo);
  srVideo.addEventListener('loadedmetadata', updateInfo);

  // ── 播放同步：原图为主时钟，超分只在偏差过大时对齐 ──
  let rafId = 0;
  const tick = () => {
    const drift = srVideo.currentTime - origVideo.currentTime;
    if (Number.isFinite(drift) && Math.abs(drift) > SYNC_TOLERANCE && srVideo.readyState >= 1) {
      srVideo.currentTime = origVideo.currentTime;
    }
    // 主时钟被外部暂停/播放时保持从时钟一致
    if (!origVideo.paused && srVideo.paused) void srVideo.play().catch(() => { /* ignore */ });
    if (origVideo.paused && !srVideo.paused) srVideo.pause();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  applySplit(50);
  // stage 高度由 aspect-ratio 决定，这里只兜底一个最小高度，避免元数据未就绪时塌陷
  stage.style.minHeight = px(120);

  // ── cleanup ──
  return () => {
    cancelAnimationFrame(rafId);
    slider.removeEventListener('input', onSlider);
    stage.removeEventListener('pointerdown', onStageDown);
    stage.removeEventListener('pointermove', onStageMove);
    stage.removeEventListener('pointerup', onStageUp);
    stage.removeEventListener('pointerleave', onStageUp);
    playBtn.removeEventListener('click', onPlayBtn);
    resetBtn.removeEventListener('click', onResetBtn);
    origVideo.removeEventListener('loadedmetadata', updateInfo);
    srVideo.removeEventListener('loadedmetadata', updateInfo);
    for (const v of [origVideo, srVideo]) {
      v.pause();
      v.removeAttribute('src');
      v.load(); // 释放解码器资源，避免面板反复切换时句柄泄漏
    }
    container.innerHTML = '';
  };
}
