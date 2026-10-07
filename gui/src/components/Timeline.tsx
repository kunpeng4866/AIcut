// AIcut timeline component: a React video editor timeline.
// Renders tracks, a ruler, a playhead and clip items with drag/resize,
// magnetic snapping, cross-track drag, audio waveforms, text/subtitle tracks
// and keyframe markers.

import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';

import { useProjectStore } from '../store/projectStore';

import { useUIStore } from '../store/uiStore';

import { useWaveform } from '../hooks/useWaveform';

import { getClipFadeGain } from '../utils/transitionUtils';

import type { ClipConfig, TrackConfig, AssetConfig } from '../types';


// Convert a filesystem path to an aicut-asset:// URL so it can be loaded by
// PreviewCanvas.tsx and other components without extra plumbing.
const pathToUrl = (path: string): string => {
  if (/^(https?|aicut-asset|blob):/.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  return `aicut-asset:///${normalized}`;
};

// 从文件路径提取文件名（与 MediaPanel.getFilename 一致），用于时间轴片段标签与左侧栏素材名对齐。
const basenameOf = (path: string): string => {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.substring(idx + 1) : path;
};

// Unique id generator for new assets/clips created by separation.
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// Per-track-type accent colors.
const TRACK_COLORS: Record<string, string> = { video: '#0f3460', audio: '#1b4332', text: '#3d2645', sticker: '#4a3a1f', effect: '#2d2d2d' };

// Track-type icon map (single source of truth).
const Gu: Record<string, string> = {
  video: '🎬', audio: '🔊', text: '📝', sticker: '✨', effect: '✨',
};

const TRACK_HEIGHT = 60;
const RULER_HEIGHT = 28;
const SNAP_THRESHOLD_CLIP = 0.5; // clip-to-clip snap threshold in seconds
const BOUNDARY_THRESHOLD = 10; // px from track edge that triggers insert

// 解析「光标落在第 trackIndex 条轨道的 yInTrack 处」应插入到轨道数组的哪个下标。
// 首次拖入(onTrackDrop) 与 已有素材拖动(onMove2) 共用，确保「两轨之间」判定完全一致：
//   上边界(yInTrack < BOUNDARY_THRESHOLD) → 插到该轨之前；下边界 → 插到该轨之后；
//   轨内 → -1（不新建，直接放入已有轨道）；区外(trackIndex 越界) → trackCount（末尾追加）。
const computeDropInsertIndex = (trackIndex: number, yInTrack: number, trackCount: number): number => {
  if (trackIndex < 0 || trackIndex >= trackCount) return trackCount;
  if (yInTrack < BOUNDARY_THRESHOLD) return trackIndex;
  if (yInTrack > TRACK_HEIGHT - BOUNDARY_THRESHOLD) return trackIndex + 1;
  return -1;
};

// Format seconds as M:SS.
const fmt = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const rulerTicks = (duration: number, zoom: number): number[] => {
  const candidates = [1, 2, 5, 10, 30, 60, 120, 300];
  let step = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (c * zoom >= 60) { step = c; break; }
  }
  const ticks: number[] = [];
  for (let t = 0; t <= duration + step; t += step) ticks.push(t);
  return ticks;
};

// snap: compute the snapped timelineIn for a clip, magnetically attracted to
// other clip boundaries and the playhead.
const snapTime = (
  proposedIn: number,
  clipDuration: number,
  clipsOnTrack: ClipConfig[],
  currentClipId: string,
  playhead: number,
  enabled: boolean,
  threshold: number = SNAP_THRESHOLD_CLIP,
): number => {
  if (!enabled) return Math.max(0, proposedIn);
  const candidates: number[] = [0, playhead];
  for (const c of clipsOnTrack) {
    if (c.id === currentClipId) continue;
    candidates.push(c.timelineIn, c.timelineOut);
  }
  let bestIn = proposedIn;
  let bestDist = threshold;
  for (const candidate of candidates) {
    const distStart = Math.abs(proposedIn - candidate);
    if (distStart < bestDist) { bestDist = distStart; bestIn = candidate; }
    const distEnd = Math.abs(proposedIn + clipDuration - candidate);
    if (distEnd < bestDist) { bestDist = distEnd; bestIn = candidate - clipDuration; }
  }
  return Math.max(0, bestIn);
};

// 需要「同轨不重叠」约束的轨道：非主视频轨 + 音频轨。
// 主视频轨走磁吸重排（realignProject）自带顺序排列；文字/贴纸轨允许叠放，故不约束。
const needsNoOverlap = (t: { type: string; isMain?: boolean }): boolean =>
  (t.type === 'video' && !t.isMain) || t.type === 'audio';

// 同轨不重叠：给定期望起点与片段时长，返回**最近的合法位置**。
// 合法 = 落在某个「空隙」内（空隙 = 相邻片段之间，含首段之前与末段之后），即 [g0, g1-dur]。
// 拖到前一段尾部时会被夹在 g0（= 前一段 timelineOut）上贴齐停住，绝不重叠；
// 拖过头越过某段时会跳到相邻的另一个空隙，而不是硬卡死。所有空隙都装不下（轨道已满）时维持原位。
const resolveNoOverlap = (
  proposedIn: number,
  clipDuration: number,
  clipsOnTrack: ClipConfig[],
  currentClipId: string,
  fallbackIn: number,
): number => {
  const others = clipsOnTrack.filter((c) => c.id !== currentClipId);
  if (others.length === 0) return Math.max(0, proposedIn);
  const sorted = [...others].sort((a, b) => a.timelineIn - b.timelineIn);
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.timelineIn > cursor) gaps.push([cursor, c.timelineIn]);
    cursor = Math.max(cursor, c.timelineOut);
  }
  gaps.push([cursor, Number.POSITIVE_INFINITY]); // 末段之后无限长
  const target = Math.max(0, proposedIn);
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [g0, g1] of gaps) {
    const hi = g1 - clipDuration;
    if (hi < g0 - 1e-9) continue; // 该空隙装不下本片段
    const pos = Math.min(Math.max(target, g0), hi);
    const dist = Math.abs(pos - target);
    if (dist < bestDist) { bestDist = dist; best = pos; }
  }
  if (best === null) return Math.max(0, fallbackIn); // 无处可放：维持原位
  return Math.max(0, best);
};

// 同轨不重叠（拉伸边缘版）：**只夹正在拖动的那条边**——左缘向左扩时不得越过
// 「位于片段当前右边界之内」的片段尾部；右缘向右扩时不得越过「越过左边界」的片段头部。
// 必须区分边：若同时套用两侧限制，左缘拖拽会被右侧限制误判为无空间而整段作废。
const clampResizeNoOverlap = (
  clipsOnTrack: ClipConfig[],
  clipId: string,
  newIn: number,
  newOut: number,
  edge: 'left' | 'right',
): { newIn: number; newOut: number } => {
  const others = clipsOnTrack.filter((c) => c.id !== clipId);
  if (edge === 'left') {
    let leftLimit = 0;
    for (const c of others) {
      if (c.timelineIn < newOut - 1e-9 && c.timelineOut > leftLimit) leftLimit = c.timelineOut;
    }
    return { newIn: Math.max(newIn, leftLimit), newOut };
  }
  let rightLimit = Number.POSITIVE_INFINITY;
  for (const c of others) {
    if (c.timelineOut > newIn + 1e-9 && c.timelineIn < rightLimit) rightLimit = c.timelineIn;
  }
  return { newIn, newOut: Math.min(newOut, rightLimit) };
};

const btnStyle: React.CSSProperties = { padding: '2px 8px', background: '#0f3460', color: '#eee', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 };
const iconBtn: React.CSSProperties = { padding: '0 2px', background: 'transparent', color: '#aaa', border: 'none', cursor: 'pointer', fontSize: 12 };
const menuItem: React.CSSProperties = { padding: '4px 8px', cursor: 'pointer', fontSize: 12, color: '#eee' };

// Canvas-based audio waveform renderer. Draws the slice of `peaks` that falls
// within [startTime, endTime] of the total timeline duration.
function WaveformCanvas({ peaks, width, height, startTime, endTime, totalDuration }: {
  peaks: Float32Array;
  width: number;
  height: number;
  startTime: number;
  endTime: number;
  totalDuration: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Scale the backing store for crisp rendering on HiDPI displays.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, width, height);

    // Slice the peaks array to the visible [startTime, endTime] window.
    const startIdx = totalDuration > 0 ? Math.floor((startTime / totalDuration) * peaks.length) : 0;
    const endIdx = totalDuration > 0 ? Math.ceil((endTime / totalDuration) * peaks.length) : peaks.length;
    const visiblePeaks = peaks.slice(startIdx, endIdx);

    if (visiblePeaks.length === 0) return;

    const barWidth = width / visiblePeaks.length;
    const midY = height / 2;

    // 柔和中心轴（淡）
    ctx.strokeStyle = 'rgba(103, 232, 196, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // 波形：细描边 + 圆头，替代生硬矩形条，视觉更柔顺
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(103, 232, 196, 0.9)'; // 柔和青绿 #67e8c4
    ctx.beginPath();
    for (let i = 0; i < visiblePeaks.length; i++) {
      const peak = visiblePeaks[i];
      const barHeight = Math.max(1.5, peak * height * 0.9);
      const x = i * barWidth + barWidth / 2;
      ctx.moveTo(x, midY - barHeight / 2);
      ctx.lineTo(x, midY + barHeight / 2);
    }
    ctx.stroke();
  }, [peaks, width, height, startTime, endTime, totalDuration]);

  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}

// Clip item props.
interface ClipItemProps {
  clip: ClipConfig; track: TrackConfig; color: string; selected: boolean; zoom: number; onSelect: (additive?: boolean) => void;
  magneticSnap: boolean; clipSnap: boolean; playhead: number; clipsOnTrack: ClipConfig[];
  sameTypeTrackIds: string[];
  onSplit: () => void;
  onMove: (newIn: number) => void;
  onMoveToTrack: (destTrackId: string, newIn: number) => void;
  onResize: (newIn: number, newOut: number) => void; onContext: (e: React.MouseEvent) => void;
  setDragOver: (v: { time: number; trackIndex: number; yInTrack: number } | null) => void;
}

// Transition marker block: rendered at the right junction (timelineOut) of an
// "out clip" that carries an active transition. Spans the transition window
// [timelineOut - duration, timelineOut), drawn as a small rounded block above
// the clip body. Double-click selects the clip and jumps to the right panel's
// 'transition' tab; dragging the right edge adjusts the transition duration.
// 转场时长夹取区间（与共享契约 duration 夹取 [0.1, 3.0] 一致）
const TRANSITION_MIN = 0.1;
const TRANSITION_MAX = 3.0;

const TRANSITION_ICON: Record<string, string> = { fade: '✦', dissolve: '◈', slide: '➜' };

function TransitionMarker({ clip, track, zoom, onOpenPanel }: {
  clip: ClipConfig; track: TrackConfig; zoom: number; onOpenPanel: () => void;
}) {
  const tr = clip.transition!;
  const rawDur = tr.duration;
  const dur = rawDur && rawDur > 0 ? rawDur : 0.5;
  // Position the block over the transition window, in track-local pixel coords
  // (same coordinate system as ClipItem: left = time * zoom inside the relative track).
  const left = (clip.timelineOut - dur) * zoom;
  const width = Math.max(6, dur * zoom);

  // Drag the right edge to change duration (reuses the pxPerSec = zoom paradigm).
  const startResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.locked) return; // locked tracks can't be edited
    const startX = e.clientX;
    const startDur = dur;
    let started = false;
    const onMove = (ev: MouseEvent) => {
      if (!started) { useProjectStore.getState().pushHistorySnapshot(); started = true; }
      const dsec = (ev.clientX - startX) / zoom;
      const nd = Math.min(TRANSITION_MAX, Math.max(TRANSITION_MIN, Math.round((startDur + dsec) * 10) / 10));
      useProjectStore.getState().updateClipLive(track.id, clip.id, { transition: { ...tr, duration: nd } });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      onDoubleClick={(e) => { e.stopPropagation(); onOpenPanel(); }}
      title={`转场: ${tr.transitionType} (${dur.toFixed(1)}s) — 双击编辑，拖右缘改时长`}
      style={{
        position: 'absolute', left, top: 0, width, height: 16, zIndex: 6,
        background: 'rgba(233,69,96,0.85)', borderRadius: 4, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, color: '#fff', userSelect: 'none', pointerEvents: 'auto',
        border: '1px solid #ffd2da',
      }}
    >
      <span style={{ pointerEvents: 'none' }}>{TRANSITION_ICON[tr.transitionType ?? 'none'] || '✦'}</span>
      <div onMouseDown={startResize} style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' }} />
    </div>
  );
}

// Audio fade in/out handles: two draggable points at the clip head (fade-in)
// and tail (fade-out). Drag length = fade duration. The SVG is pointer-events:none
// so the clip body stays draggable; only the handle circles capture pointer events
// (robust against the earlier freeze where a full-area capture intercepted drags).
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// 平滑淡变曲线：按真实增益函数 getClipFadeGain 采样绘制，保证"视觉曲线 == 实际淡变"。
// x0..x1 为淡入/淡出斜坡在片段内的水平区间；yOf 把增益映射到 y 坐标。
function FadeRamp({ clip, dur, x0, x1, width, H, yOf, fill, stroke }: {
  clip: ClipConfig; dur: number; x0: number; x1: number; width: number;
  H: number; yOf: (g: number) => number; fill: string; stroke: string;
}) {
  const N = 28;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const x = x0 + ((x1 - x0) * i) / N;
    const t = clip.timelineIn + (x / width) * dur;
    const g = getClipFadeGain(clip, t);
    pts.push(`${x.toFixed(2)},${yOf(g).toFixed(2)}`);
  }
  const curve = 'M ' + pts.join(' L ');
  const area = `${curve} L ${x1.toFixed(2)},${H} L ${x0.toFixed(2)},${H} Z`;
  return (
    <>
      <path d={area} fill={fill} pointerEvents="none" />
      <path d={curve} fill="none" stroke={stroke} strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
    </>
  );
}

function FadeHandles({ clip, track, zoom, width }: {
  clip: ClipConfig; track: TrackConfig; zoom: number; width: number;
}) {
  // 音频轨与视频轨（视频片段自带音轨）都显示淡入/淡出控制点
  if (track.type !== 'audio' && track.type !== 'video') return null;
  const H = TRACK_HEIGHT - 8;
  const TOP = 5;
  const dur = clip.timelineOut - clip.timelineIn;
  if (dur <= 0) return null;
  const fi = clip.audioFadeIn ?? 0;
  const fo = clip.audioFadeOut ?? 0;
  // gain 1 -> top (y=TOP), gain 0 -> bottom (y=H)
  const yOf = (g: number) => TOP + (1 - g) * (H - TOP);
  const xFi = (fi / dur) * width;          // fade-in handle x (head)
  const xFo = ((dur - fo) / dur) * width;   // fade-out handle x (tail)

  // Fade-in: drag right to increase fade-in duration.
  const startFadeIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.locked) return;
    const startX = e.clientX;
    const startFi = clip.audioFadeIn ?? 0;
    let started = false;
    const onMove = (ev: MouseEvent) => {
      if (!started) { useProjectStore.getState().pushHistorySnapshot(); started = true; }
      const next = clamp(startFi + (ev.clientX - startX) / zoom, 0, dur - fo);
      useProjectStore.getState().updateClipLive(track.id, clip.id, { audioFadeIn: next });
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Fade-out: drag left to increase fade-out duration.
  const startFadeOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.locked) return;
    const startX = e.clientX;
    const startFo = clip.audioFadeOut ?? 0;
    let started = false;
    const onMove = (ev: MouseEvent) => {
      if (!started) { useProjectStore.getState().pushHistorySnapshot(); started = true; }
      const next = clamp(startFo - (ev.clientX - startX) / zoom, 0, dur - fi);
      useProjectStore.getState().updateClipLive(track.id, clip.id, { audioFadeOut: next });
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 双击控制点 = 复位该淡入/淡出为 0
  const resetFadeIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.locked) return;
    useProjectStore.getState().updateClip(track.id, clip.id, { audioFadeIn: 0 });
  };
  const resetFadeOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.locked) return;
    useProjectStore.getState().updateClip(track.id, clip.id, { audioFadeOut: 0 });
  };

  return (
    <svg width={width} height={H}
      style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible', zIndex: 4 }}>
      {/* gain=1 baseline */}
      <line x1={0} y1={yOf(1)} x2={width} y2={yOf(1)} stroke="rgba(255,255,255,0.22)" strokeDasharray="4 4" pointerEvents="none" />
      {/* fade-in ramp (gain 0 -> 1)，平滑曲线 */}
      {fi > 0 && (
        <FadeRamp clip={clip} dur={dur} x0={0} x1={xFi} width={width} H={H}
          yOf={yOf} fill="rgba(74,222,128,0.16)" stroke="#4ade80" />
      )}
      {/* fade-out ramp (gain 1 -> 0)，平滑曲线 */}
      {fo > 0 && (
        <FadeRamp clip={clip} dur={dur} x0={xFo} x1={width} width={width} H={H}
          yOf={yOf} fill="rgba(251,146,60,0.16)" stroke="#fb923c" />
      )}
      {/* fade-in handle (green, always visible) — 拖动改时长，双击复位为 0 */}
      <circle cx={xFi} cy={yOf(1)} r={5} fill="#4ade80" stroke="#0b6" strokeWidth={1}
        style={{ cursor: 'col-resize', pointerEvents: 'auto' }} onMouseDown={startFadeIn} onDoubleClick={resetFadeIn} />
      {/* fade-out handle (orange, always visible) — 拖动改时长，双击复位为 0 */}
      <circle cx={xFo} cy={yOf(1)} r={5} fill="#fb923c" stroke="#a35" strokeWidth={1}
        style={{ cursor: 'col-resize', pointerEvents: 'auto' }} onMouseDown={startFadeOut} onDoubleClick={resetFadeOut} />
    </svg>
  );
}

// 口播剪辑：绿(保留)/红(删除) 交界处的悬停边界标记，可左右拖动精修。
// 容器 pointer-events:none，仅此细标记可捕获交互。拖动只更新 speechOverlay.keepSegments（UI 状态，不入工程快照）。
function SpeechBoundaryMarker({ x, t, orig, end, min, max, pxPerSec }: { x: number; t: number; orig: number; end: 'start' | 'end'; min: number; max: number; pxPerSec: number }) {
  const [hover, setHover] = useState(false);
  const setSegs = useUIStore((s) => s.setSpeechOverlaySegments);
  const dragRef = useRef<{ startX: number; t0: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation(); // 防止触发片段整体拖动 startDrag
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, t0: t };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    let tn = dragRef.current.t0 + (e.clientX - dragRef.current.startX) / pxPerSec;
    tn = Math.max(min, Math.min(max, tn)); // 钳制：不越过相邻段、不反向
    tn = Math.round(tn * 1000) / 1000; // 1ms 量化
    const cur = useUIStore.getState().speechOverlay?.keepSegments;
    if (!cur) return;
    const next = cur.map((sg, i) => (i === orig ? (end === 'start' ? [tn, sg[1]] : [sg[0], tn]) : sg)) as [number, number][];
    setSegs(next);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={`${t.toFixed(2)}s`}
      style={{
        position: 'absolute', left: x, top: 0, width: 10, height: '100%',
        transform: 'translateX(-5px)', pointerEvents: 'auto', cursor: 'ew-resize', zIndex: 6,
      }}
    >
      {/* 细竖线（可见），命中区为外侧 10px 整列 */}
      <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: '100%', transform: 'translateX(-1px)', background: 'rgba(255,255,255,0.75)' }} />
      {hover && (
        <div style={{
          position: 'absolute', top: 2, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.85)', color: '#fff', fontSize: 10, lineHeight: '14px',
          padding: '1px 5px', borderRadius: 3, whiteSpace: 'nowrap', zIndex: 12, pointerEvents: 'none',
        }}>
          {t.toFixed(2)}s
        </div>
      )}
    </div>
  );
}

function ClipItem({ clip, track, color, selected, zoom, magneticSnap, clipSnap, playhead, clipsOnTrack, sameTypeTrackIds, onSelect, onSplit, onMove, onMoveToTrack, onResize, onContext, setDragOver }: ClipItemProps) {
  const left = clip.timelineIn * zoom;
  const width = Math.max(4, (clip.timelineOut - clip.timelineIn) * zoom);
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);

  // Resolve the asset so we can build the audio URL / waveform peaks.
  const asset = useProjectStore((s) => s.project.assets.find(a => a.id === clip.assetId));
  const isAudio = track.type === 'audio';
  const audioUrl = isAudio && asset?.path ? pathToUrl(asset.path) : null;
  const { peaks: wavePeaks, loading: waveLoading } = useWaveform(audioUrl, isAudio ? clip.assetId : null);
  const totalDuration = asset?.duration || clip.src_range.end;

  // 口播剪辑叠加（客户 #3）：speechOverlay 与当前片段同源时绘制绿(保留)/红(删除) 标记。
  const speechOverlay = useUIStore((s) => s.speechOverlay);
  const showOverlay = speechOverlay && asset?.path === speechOverlay.assetPath;

  // 把 keepSegments(源媒体绝对秒，与 src_range 同基准) 映射到片段渲染宽度内的 px。
  // 与 WaveformCanvas 共用同一宽度基准 width，保证和波形对齐。
  const overlayBlocks = (() => {
    const MIN = 0.05; // 单段最短 50ms，防拖成 0 或反向
    const empty = {
      keeps: [] as { left: number; w: number; s: number }[],
      reds: [] as { left: number; w: number }[],
      bounds: [] as { x: number; t: number; seg: number; end: 'start' | 'end'; min: number; max: number; orig: number }[],
    };
    if (!showOverlay || !speechOverlay) return empty;
    const srcStart = clip.src_range.start;
    const srcEnd = clip.src_range.end;
    const srcLen = srcEnd - srcStart || 1;
    const toFrac = (sec: number) => clamp((sec - srcStart) / srcLen, 0, 1);
    const keepsSorted = speechOverlay.keepSegments.map((sg, i) => ({ sg, i })).sort((a, b) => a.sg[0] - b.sg[0]);
    const keeps: { left: number; w: number; s: number }[] = [];
    const reds: { left: number; w: number }[] = [];
    const bounds: { x: number; t: number; seg: number; end: 'start' | 'end'; min: number; max: number; orig: number }[] = [];
    let cursor = srcStart;
    keepsSorted.forEach((item, idx) => {
      const [s, e] = item.sg;
      const orig = item.i;
      const fs = toFrac(s);
      const fe = toFrac(e);
      keeps.push({ left: fs * width, w: (fe - fs) * width, s });
      bounds.push({ x: fs * width, t: s, seg: idx, end: 'start', min: idx > 0 ? keepsSorted[idx - 1].sg[1] : srcStart, max: e - MIN, orig });
      bounds.push({ x: fe * width, t: e, seg: idx, end: 'end', min: s + MIN, max: idx < keepsSorted.length - 1 ? keepsSorted[idx + 1].sg[0] : srcEnd, orig });
      if (s > cursor) {
        const rs = toFrac(cursor);
        reds.push({ left: rs * width, w: (toFrac(s) - rs) * width });
      }
      cursor = Math.max(cursor, e);
    });
    if (cursor < srcEnd) {
      const rs = toFrac(cursor);
      reds.push({ left: rs * width, w: (toFrac(srcEnd) - rs) * width });
    }
    return { keeps, reds, bounds };
  })();

  // Begin a move / left-resize / right-resize drag operation.
  const startDrag = (e: React.MouseEvent, mode: 'move' | 'left' | 'right') => {
    e.stopPropagation();
    onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
    if (track.locked) return; // locked tracks can't be edited
    let startX = e.clientX;
    let startIn = clip.timelineIn;
    const startOut = clip.timelineOut;
    let started = false; // 首次移动才压一次历史快照（一次拖动=一次撤销），避免每帧克隆整工程
    const originTrackId = track.id; // 记录起点轨道，拖后若变空则移除（主轨除外）
    // 本次拖动过程中片段「曾停留过」的所有轨道（含起点），收尾时统一清理空轨（主轨与当前承载轨除外）。
    const visitedTrackIds = new Set<string>([originTrackId]);
    // 悬停在「两条轨道之间」时记录待建轨的下标；松手才真正建轨并把素材放入（与初次拖入一致：显示绿色线条，松手落位）。
    let pendingInsertIdx: number | null = null;

    // 把插入下标夹紧到「同类型轨道分组」范围内，确保不破坏文字/视频/音频的相对位置（需求③）。
    const clampToGroup = (index: number, type: string): number => {
      const tracks = useProjectStore.getState().project.tracks;
      const groupIdxs = tracks.map((t, i) => (t.type === type ? i : -1)).filter((i) => i >= 0);
      if (groupIdxs.length === 0) return -1; // 该类型尚无轨道：由调用方回退到按类型分组的插入
      const lo = groupIdxs[0];
      let hi = groupIdxs[groupIdxs.length - 1] + 1;
      // 主视频轨永远位于所有视频轨的最下面：video 新轨只能插到主轨之前（上方），禁止插到主轨之下。
      if (type === 'video') {
        const mainIdx = tracks.findIndex(t => t.type === 'video' && t.isMain);
        if (mainIdx >= 0) hi = Math.min(hi, mainIdx);
      }
      return Math.max(lo, Math.min(index, hi));
    };

    const onMove2 = (ev: MouseEvent) => {
      if (!started) { useProjectStore.getState().pushHistorySnapshot(); started = true; }
      const dt = (ev.clientX - startX) / zoom;
      if (mode === 'move') {
        const newIn = Math.max(0, startIn + dt);
        // 实时定位片段当前所在轨道（跨轨后 src 会变，不能再用闭包里的 track.id）
        const state = useProjectStore.getState();
        const clipTrack = state.project.tracks.find(t => t.clips.some(c => c.id === clip.id));
        if (!clipTrack) return;
        visitedTrackIds.add(clipTrack.id);

        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const trackEl = el?.closest('[data-track-id]') as HTMLElement | null;
        const hoverTrackId = trackEl?.dataset.trackId || null;

        // 与 onTrackDrop 同源的落点判定：命中轨道的 DOM 下标 + 轨道内 Y => 「两轨之间」插入下标。
        // 轨道在 DOM 中平铺无间隙，拖动时 elementFromPoint 永远命中某条轨道，故用 yInTrack 边界阈值识别「轨道之间」。
        const lanes = Array.from(document.querySelectorAll('[data-track-id]')) as HTMLElement[];
        const trackIndex = trackEl ? lanes.indexOf(trackEl) : -1;
        let yInTrack = -1;
        if (trackEl) {
          const r = trackEl.getBoundingClientRect();
          yInTrack = ev.clientY - r.top;
        }
        const insertIdx = computeDropInsertIndex(trackIndex, yInTrack, lanes.length); // -1=轨内；否则=插入下标

        // 复用初次拖入的绿色指示线：把落点写回 dragOver，轨道层据此画绿线（与 onTrackDrop 同源）。
        setDragOver({ time: newIn, trackIndex, yInTrack });

        if (insertIdx >= 0) {
          // 悬停在「两条轨道之间」(或分组上下边缘)：显示绿色线条，不立即建轨，松手时才建轨并放入素材（与初次拖入一致）。
          pendingInsertIdx = clampToGroup(insertIdx, clipTrack.type);
          // 素材暂留在当前轨道、仅水平跟随光标，等待松手落位。
          useProjectStore.getState().moveClipLive(clipTrack.id, clip.id, newIn);
          setDragTrackId(null);
        } else if (hoverTrackId) {
          const ht = state.project.tracks.find(t => t.id === hoverTrackId);
          if (ht && ht.type === clipTrack.type && !ht.locked) {
            // 命中同类型未锁轨道内部：直接移入（保留「放到已有轨道」行为，素材跟随到该轨）
            pendingInsertIdx = null;
            setDragTrackId(hoverTrackId);
            // 非主视频轨 / 音频轨：拖动过程中即夹到空隙里 —— 往前拖顶到前一段尾部就贴齐停住，绝不重叠。
            const cdur = clip.timelineOut - clip.timelineIn;
            const destIn = needsNoOverlap(ht)
              ? resolveNoOverlap(newIn, cdur, ht.clips, clip.id, newIn)
              : newIn;
            useProjectStore.getState().moveClipToTrackLive(clipTrack.id, clip.id, hoverTrackId, destIn);
          } else {
            // 类型不符/锁定：在同类分组边界处显示绿线，松手建轨承载（保持素材不丢失）
            pendingInsertIdx = clampToGroup(trackIndex, clipTrack.type);
            useProjectStore.getState().moveClipLive(clipTrack.id, clip.id, newIn);
            setDragTrackId(null);
          }
        } else {
          // 轨道区外（理论不会命中，因轨道平铺无间隙）：末尾显示绿线，松手建轨承载
          pendingInsertIdx = clampToGroup(lanes.length, clipTrack.type);
          useProjectStore.getState().moveClipLive(clipTrack.id, clip.id, newIn);
          setDragTrackId(null);
        }
        const updated = useProjectStore.getState().project.tracks
          .find(t => t.clips.some(c => c.id === clip.id))?.clips.find(c => c.id === clip.id);
        if (updated) { startIn = updated.timelineIn; }
        startX = ev.clientX;
      } else if (mode === 'left') {
        onResize(Math.min(startIn + dt, startOut - 0.1), startOut);
      } else {
        onResize(startIn, Math.max(startIn + 0.1, startOut + dt));
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove2);
      window.removeEventListener('mouseup', onUp);
      setDragTrackId(null);
      setDragOver(null); // 清除绿色指示线
      // After a move, realign the main track / snap on the destination track.
      if (mode === 'move') {
        const { realignProject, removeEmptyTrack } = useProjectStore.getState();
        const clipTrack = useProjectStore.getState().project.tracks.find(t => t.clips.some(c => c.id === clip.id));
        if (clipTrack) {
          const c = clipTrack.clips.find(c => c.id === clip.id);
          if (c) {
            // 非主视频轨 / 音频轨收尾：①夹进空隙（同轨不重叠）②「片段吸附」开启时贴到相邻片段边缘，
            // ③再夹一次（吸附候选里含其他片段内沿，可能落到重叠位，必须兜住）。
            const settleNonMain = (trackId: string, clipsNow: ClipConfig[], fallbackIn: number) => {
              const cdur = c.timelineOut - c.timelineIn;
              let pos = resolveNoOverlap(fallbackIn, cdur, clipsNow, clip.id, fallbackIn);
              pos = snapTime(pos, cdur, clipsNow, clip.id, playhead, clipSnap);
              pos = resolveNoOverlap(pos, cdur, clipsNow, clip.id, fallbackIn);
              if (Math.abs(pos - fallbackIn) > 0.001) {
                useProjectStore.getState().updateClipLive(trackId, clip.id, { timelineIn: pos, timelineOut: pos + cdur });
              }
            };
            if (pendingInsertIdx !== null && pendingInsertIdx >= 0) {
              // 延迟建轨：在松手处新建一条同类型轨道并把素材放入（与初次拖入一致：绿线 → 松手建轨）。
              const newId = useProjectStore.getState().addTrackLiveAt(pendingInsertIdx, clipTrack.type);
              useProjectStore.getState().moveClipToTrackLive(clipTrack.id, clip.id, newId, c.timelineIn);
              const destTrack = useProjectStore.getState().project.tracks.find(t => t.id === newId);
              if (destTrack) {
                if (destTrack.isMain) {
                  realignProject();
                } else if (destTrack.type === 'video' || destTrack.type === 'audio') {
                  settleNonMain(destTrack.id, destTrack.clips, c.timelineIn);
                }
              }
            } else if (clipTrack.isMain) {
              // 主轨：拖后一次性磁吸重排（拖动过程不重排，避免主轨被吸附抖动）
              realignProject();
            } else if (clipTrack.type === 'video' || clipTrack.type === 'audio') {
              // Video (non-main) / Audio：不重叠 + 拖后吸附到相邻片段边缘
              settleNonMain(clipTrack.id, clipTrack.clips, c.timelineIn);
            }
          }
        }
        // 拖动收尾：清理因本次拖动而变空的轨道（起点轨 + 过程中曾停留过的轨），主视频轨与当前承载轨除外。
        // 手动「+ 添加轨道」建的空轨不在 visitedTrackIds 内，不受影响。
        const finalTrack = useProjectStore.getState().project.tracks.find(t => t.clips.some(c => c.id === clip.id));
        for (const id of visitedTrackIds) {
          if (id === finalTrack?.id) continue; // 承载片段的轨道不删
          removeEmptyTrack(id);
        }
      }
    };

    window.addEventListener('mousemove', onMove2);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      style={{
        position: 'absolute', left, top: 4, width, height: 'calc(100% - 8px)',
        background: color, borderRadius: 4, overflow: 'hidden', userSelect: 'none',
        border: selected ? '2px solid #e94560' : dragTrackId ? '2px solid #4caf50' : '1px solid rgba(255,255,255,0.1)',
        cursor: track.locked ? 'not-allowed' : 'grab',
        opacity: dragTrackId ? 0.7 : 1,
      }}
      onMouseDown={(e) => startDrag(e, 'move')}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={onSplit}
      onContextMenu={onContext}
    >
      {/* Video thumbnail strip */}
      {track.type === 'video' && (
        <div style={{ display: 'flex', height: '100%', opacity: 0.5 }}>
          {Array.from({ length: Math.max(2, Math.floor(width / 30)) }).map((_, i) => (
            <div key={i} style={{ flex: 1, background: `hsl(${i * 30}, 40%, 30%)` }} />
          ))}
        </div>
      )}
      {track.type === 'audio' && (
        <div style={{ display: 'flex', alignItems: 'center', height: '100%', overflow: 'hidden' }}>
          {waveLoading ? (
            <span style={{ color: '#8fd', fontSize: 10, padding: '0 8px' }}>加载波形…</span>
          ) : wavePeaks ? (
            <WaveformCanvas peaks={wavePeaks} width={width} height={TRACK_HEIGHT - 8}
              startTime={clip.src_range.start} endTime={clip.src_range.end}
              totalDuration={totalDuration} />
          ) : (
            // Fallback faux-waveform when peaks are unavailable.
            <div style={{ display: 'flex', alignItems: 'center', height: '100%', gap: '2px' }}>
              {Array.from({ length: Math.max(5, Math.floor(width / 4)) }).map((_, i) => (
                <div key={i} style={{ width: 2, height: `${30 + Math.abs(Math.sin(i * 0.7)) * 50}%`, background: 'rgba(103, 232, 196, 0.85)', borderRadius: 1, margin: '0 0.5px' }} />
              ))}
            </div>
          )}
        </div>
      )}
      <FadeHandles clip={clip} track={track} zoom={zoom} width={width} />
      {/* 口播剪辑叠加：绿=保留 / 红=删除；容器不拦截交互，仅边界标记可悬停 */}
      {showOverlay && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
          {overlayBlocks.reds.map((r, i) => (
            <div key={`ov-r-${i}`} style={{ position: 'absolute', top: 0, height: '100%', left: r.left, width: Math.max(0, r.w), background: 'rgba(233,69,96,0.45)' }} />
          ))}
          {overlayBlocks.keeps.map((k, i) => (
            <div key={`ov-k-${i}`} style={{ position: 'absolute', top: 0, height: '100%', left: k.left, width: Math.max(0, k.w), background: 'rgba(60,200,100,0.45)' }} />
          ))}
          {overlayBlocks.bounds.map((b, i) => (
            <SpeechBoundaryMarker key={`ov-b-${i}`} x={b.x} t={b.t} orig={b.orig} end={b.end} min={b.min} max={b.max} pxPerSec={zoom} />
          ))}
        </div>
      )}
      <span style={{ position: 'absolute', top: 2, left: 8, fontSize: 11, color: '#eee', pointerEvents: 'none' }}>
        {clip.subtitle
          ? (clip.subtitle.items[0]?.text || '字幕')
          : (asset ? basenameOf(asset.path) : clip.assetId)}
      </span>
      {/* 蒙版标记：带启用蒙版的片段右上角显示图标 */}
      {clip.masks && clip.masks.some((m) => m.enabled) && (
        <span
          title="该片段含蒙版"
          style={{ position: 'absolute', top: 2, right: 6, fontSize: 11, color: '#4caf50', pointerEvents: 'none', zIndex: 6 }}
        >🔲</span>
      )}
      {clip.text && (
        <span style={{ position: 'absolute', top: 18, left: 8, right: 8, fontSize: 10, color: '#ccc', pointerEvents: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {clip.text.content}
        </span>
      )}
      {/* Keyframe diamond markers */}
      {clip.keyframes && Object.keys(clip.keyframes).length > 0 && (() => {
        const dur = clip.timelineOut - clip.timelineIn;
        const allKfs = Object.values(clip.keyframes).flatMap(kt => (kt as any).keyframes || []);
        const uniqueKfTimes = [...new Set(allKfs.map((kf: any) => kf.time as number))];
        return (
          <div style={{ position: 'absolute', bottom: 4, left: 0, right: 0, height: 8, pointerEvents: 'none' }}>
            {uniqueKfTimes.map((t, i) => {
              const x = ((t - clip.timelineIn) / dur) * width;
              return (
                <div key={i} style={{ position: 'absolute', left: x - 4, top: 0, width: 8, height: 8, background: '#ff9800', clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' }} />
              );
            })}
          </div>
        );
      })()}
      {/* Resize handles */}
      <div onMouseDown={(e) => startDrag(e, 'left')} style={{ position: 'absolute', left: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' }} />
      <div onMouseDown={(e) => startDrag(e, 'right')} style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'ew-resize' }} />
    </div>
  );
}

export default function Timeline() {
  const { project, addTrack, insertTrackAt, addTrackLiveAt, addClip, removeClip, removeTrack, copyClips, pasteClips, splitClip, updateClipLive, moveClipLive, moveClipToTrackLive, realignProject, removeEmptyTrack, toggleTrackLock, toggleTrackVisible, toggleTrackMute, toggleTrackSolo, getMainVideoTrack } = useProjectStore();
  const { selectedTrackId, selectedClipId, selectedClipIds, currentTime, timelineZoom, magneticSnap, clipSnap, selectClip, setSelection, clearSelection, setCurrentTime, setTimelineZoom, toggleMagneticSnap, toggleClipSnap, setActiveRightPanel, setRightView, speechOverlay } = useUIStore();
  // 框选（rubber-band）临时状态：仅作用于单条轨道
  const [marquee, setMarquee] = useState<{ trackId: string; left: number; width: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 左侧轨道控制列与右侧轨道区共享同一条垂直滚动：左侧自身不出现滚动条，
  // 仅镜像右侧的 scrollTop，确保控制按钮与轨道行始终对齐（避免两侧各滚各的）。
  const leftRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; trackId: string; clipId: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [subMenu, setSubMenu] = useState<{ x: number; y: number } | null>(null);
  const [separating, setSeparating] = useState(false);
  const subMenuRef = useRef<HTMLDivElement>(null);
  const [subMenuPos, setSubMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 轨道头部右键菜单（删除空轨）
  const [trackMenu, setTrackMenu] = useState<{ x: number; y: number; trackId: string } | null>(null);
  const trackMenuRef = useRef<HTMLDivElement>(null);
  const [trackMenuPos, setTrackMenuPos] = useState<{ x: number; y: number } | null>(null);

  // 二级子菜单（声音分离 ▸）同样 clamp 进视口：向右/向下展开可能超出右/下边界
  useLayoutEffect(() => {
    if (!subMenu || !subMenuRef.current) { setSubMenuPos(null); return; }
    const rect = subMenuRef.current.getBoundingClientRect();
    const m = 8;
    let x = subMenu.x;
    let y = subMenu.y;
    if (x + rect.width > window.innerWidth - m) x = Math.max(m, window.innerWidth - rect.width - m);
    if (y + rect.height > window.innerHeight - m) y = Math.max(m, window.innerHeight - rect.height - m);
    if (x < m) x = m;
    if (y < m) y = m;
    setSubMenuPos({ x, y });
  }, [subMenu, menu]);

  // 点击菜单外任意位置（仅左键）关闭所有弹出菜单，修复“点别处菜单不消失”
  useEffect(() => {
    if (!menu && !subMenu && !trackMenu) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;  // 仅左键；右键由各 onContext 自行处理
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (subMenuRef.current?.contains(t)) return;
      if (trackMenuRef.current?.contains(t)) return;
      setMenu(null); setSubMenu(null); setTrackMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu, subMenu, trackMenu]);
  const [dragOver, setDragOver] = useState<{ time: number; trackIndex: number; yInTrack: number } | null>(null);

  // 渲染过滤：主视频轨永远保留，其余无素材轨道不渲染（空轨自动消失）。
  // 拖拽建轨/落点判定均基于此可见列表，保证「素材拖到空白处自动建轨」的下标与渲染一致。
  const visibleTracks = project.tracks.filter((t) => t.isMain || t.clips.length > 0);

  // Timeline duration is at least 30s.
  const duration = Math.max(30, ...project.tracks.flatMap(t => t.clips.map(c => c.timelineOut)), 0);
  const ticks = rulerTicks(duration, timelineZoom);
  const playheadX = currentTime * timelineZoom;

  // Click on the ruler to seek.
  const onRulerClick = useCallback((e: React.MouseEvent) => {
    const el = scrollRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = (e.clientX - rect.left + el.scrollLeft) / timelineZoom;
    setCurrentTime(Math.max(0, t));
  }, [timelineZoom, setCurrentTime]);

  // Drag the playhead.
  const onPlayheadDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startT = currentTime;
    const onMove = (ev: MouseEvent) => setCurrentTime(Math.max(0, startT + (ev.clientX - startX) / timelineZoom));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Ctrl/Cmd + wheel to zoom.
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setTimelineZoom(timelineZoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }
  };

  // 右侧轨道区滚动时，把左侧控制列的 scrollTop 同步过去，保持两侧垂直对齐。
  const onTrackScroll = useCallback(() => {
    const el = scrollRef.current;
    const left = leftRef.current;
    if (el && left) left.scrollTop = el.scrollTop;
  }, []);

  // Map an asset type to the track type it belongs on.
  const assetToTrackType = (assetType: string): 'video' | 'audio' => {
    return assetType === 'audio' ? 'audio' : 'video';
  };

  // Compute the drop position { time, trackIndex, yInTrack } from a drag event.
  const calcDropPos = (e: React.DragEvent): { time: number; trackIndex: number; yInTrack: number } | null => {
    const el = scrollRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    const y = e.clientY - rect.top + el.scrollTop;
    const time = Math.max(0, x / timelineZoom);
    const trackIndex = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
    const yInTrack = (y - RULER_HEIGHT) - trackIndex * TRACK_HEIGHT;
    return { time, trackIndex: Math.max(0, trackIndex), yInTrack };
  };

  const onTrackDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/json')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const pos = calcDropPos(e);
    if (pos && pos.trackIndex >= 0) {
      setDragOver((prev) => {
        if (prev && Math.abs(prev.time - pos.time) < 0.05 && prev.trackIndex === pos.trackIndex) return prev;
        return pos;
      });
    }
  };

  const onTrackDragLeave = (e: React.DragEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (e.clientX <= rect.left || e.clientX >= rect.right || e.clientY <= rect.top || e.clientY >= rect.bottom) {
      setDragOver(null);
    }
  };

  // Find the magnetic insert time (gap) for a clip dropped on a track.
  const calcMagnetInsertTime = (clips: ClipConfig[], dropTime: number): number => {
    if (clips.length === 0) return 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const mid = (c.timelineIn + c.timelineOut) / 2;
      if (dropTime < mid) {
        if (i === 0) return c.timelineIn - 0.1;
        return (clips[i - 1].timelineIn + c.timelineIn) / 2;
      }
    }
    return clips[clips.length - 1].timelineOut;
  };

  const onTrackDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);

    const data = e.dataTransfer.getData('application/json');
    if (!data) return;

    let asset: AssetConfig;
    try {
      asset = JSON.parse(data);
    } catch {
      return;
    }

    const pos = calcDropPos(e);
    if (!pos) return;

    const targetTrackType = assetToTrackType(asset.type);
    const { time, trackIndex, yInTrack } = pos;

    // 与已有素材拖动(onMove2)共用同一套「两轨之间」判定：computeDropInsertIndex。
    // >=0 => 两轨之间(上/下边界)或区外末尾，需插入/追加一条新轨；-1 => 落在已有轨道内部。
    const insertIdx = computeDropInsertIndex(trackIndex, yInTrack, visibleTracks.length);

    let targetTrack: TrackConfig | undefined;
    let dropTime = time;

    if (insertIdx >= 0) {
      // 两轨之间（上/下边界）或区外末尾：插入/追加一条同类型新轨承载该素材。
      const newId = insertIdx >= visibleTracks.length
        ? addTrack(targetTrackType)
        : insertTrackAt(insertIdx, targetTrackType);
      targetTrack = useProjectStore.getState().project.tracks.find(t => t.id === newId);
    } else {
      // Dropped inside an existing track.
      if (targetTrackType === 'video' && magneticSnap) {
        const mainTrack = getMainVideoTrack();
        if (mainTrack && !mainTrack.locked) {
          targetTrack = mainTrack;
          dropTime = calcMagnetInsertTime(mainTrack.clips, time);
        }
      }
      if (!targetTrack) {
        const hoverTrack = visibleTracks[trackIndex];
        if (hoverTrack && hoverTrack.type === targetTrackType && !hoverTrack.locked) {
          targetTrack = hoverTrack;
          const clipDur = asset.duration || 5;
          // 非主视频轨 / 音频轨：新片段落点同样不得与已有片段重叠（夹进空隙 → 吸附 → 再夹一次）。
          if (needsNoOverlap(hoverTrack)) {
            dropTime = resolveNoOverlap(time, clipDur, hoverTrack.clips, '', time);
          }
          dropTime = snapTime(dropTime, clipDur, hoverTrack.clips, '', currentTime, clipSnap);
          if (needsNoOverlap(hoverTrack)) {
            dropTime = resolveNoOverlap(dropTime, clipDur, hoverTrack.clips, '', time);
          }
        } else {
          const newId = addTrack(targetTrackType);
          targetTrack = useProjectStore.getState().project.tracks.find(t => t.id === newId);
        }
      }
    }

    if (!targetTrack) return;

    const clipDuration = asset.duration || 5;
    const clip: ClipConfig = {
      id: `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      assetId: asset.id,
      src_range: { start: 0, end: clipDuration },
      timelineIn: dropTime,
      timelineOut: dropTime + clipDuration,
      transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      volume: 1,
      speed: 1,
      effects: [],
      masks: [],
      filters: [],
      keyframes: {},
    };

    addClip(targetTrack.id, clip);
    selectClip(targetTrack.id, clip.id);
  };

  // Context menu for a clip.
  const onClipContext = (e: React.MouseEvent, trackId: string, clipId: string) => {
    e.preventDefault();
    selectClip(trackId, clipId);
    setMenu({ x: e.clientX, y: e.clientY, trackId, clipId });
  };

  // 右键菜单定位：渲染后用真实尺寸 clamp 进视口，避免底部/右侧超出被裁掉（复制、删除点不到）
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) { setMenuPos(null); return; }
    const rect = menuRef.current.getBoundingClientRect();
    const m = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + rect.width > window.innerWidth - m) x = Math.max(m, window.innerWidth - rect.width - m);
    if (y + rect.height > window.innerHeight - m) y = Math.max(m, window.innerHeight - rect.height - m);
    if (x < m) x = m;
    if (y < m) y = m;
    setMenuPos({ x, y });
  }, [menu]);

  // 轨道右键菜单定位（删除空轨）：同样 clamp 进视口
  useLayoutEffect(() => {
    if (!trackMenu || !trackMenuRef.current) { setTrackMenuPos(null); return; }
    const rect = trackMenuRef.current.getBoundingClientRect();
    const m = 8;
    let x = trackMenu.x;
    let y = trackMenu.y;
    if (x + rect.width > window.innerWidth - m) x = Math.max(m, window.innerWidth - rect.width - m);
    if (y + rect.height > window.innerHeight - m) y = Math.max(m, window.innerHeight - rect.height - m);
    if (x < m) x = m;
    if (y < m) y = m;
    setTrackMenuPos({ x, y });
  }, [trackMenu]);

  // 音频分离（av）：把视频片段拆成「仅视频」素材 + 一条「仅音频」轨道片段。
  async function handleSeparateAV(trackId: string, clipId: string) {
    const st = useProjectStore.getState();
    const project = st.project;
    const track = project.tracks.find(t => t.id === trackId);
    if (!track) return;
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip) return;
    const asset = project.assets.find(a => a.id === clip.assetId);
    if (!asset) return;
    setSeparating(true);
    try {
      const res: any = await window.aicut.speech.separate(
        asset.path, JSON.stringify({ mode: 'av', trackType: 'video', duration: asset.duration })
      );
      if (!res?.success) throw new Error(res?.error || '分离失败');
      const d = res.data;
      const dur = d.duration || asset.duration || 5;
      // 视频-only 素材，替换原片段挂载
      const vidId = uid('asset');
      st.addAsset({ id: vidId, type: 'video', path: d.videoOnlyPath, duration: dur,
                    width: asset.width, height: asset.height, codec: asset.codec, fps: asset.fps });
      st.updateClip(trackId, clipId, { assetId: vidId });
      // 音频-only 素材 + 对齐的新音频片段
      const audId = uid('asset');
      st.addAsset({ id: audId, type: 'audio', path: d.audioOnlyPath, duration: dur });
      const audioTrack = useProjectStore.getState().project.tracks.find(t => t.type === 'audio');
      const atId = audioTrack ? audioTrack.id : useProjectStore.getState().addTrack('audio');
      st.addClip(atId, {
        id: uid('clip'), assetId: audId,
        src_range: { start: clip.src_range.start, end: clip.src_range.end },
        timelineIn: clip.timelineIn, timelineOut: clip.timelineOut,
        transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
        volume: 1, speed: 1, effects: [], masks: [], filters: [], keyframes: {},
      });
      setMenu(null); setSubMenu(null);
    } catch (e: any) {
      console.error('音频分离失败', e);
      alert('音频分离失败：' + (e?.message || e));
    } finally {
      setSeparating(false);
    }
  }

  // 声音分离（vocal）：视频轨替换为人声/伴奏 stem；音频轨则替换并钳制片段长度。
  async function handleVocalSplit(trackId: string, clipId: string, keep: 'vocals' | 'accomp') {
    const st = useProjectStore.getState();
    const project = st.project;
    const track = project.tracks.find(t => t.id === trackId);
    if (!track) return;
    const clip = track.clips.find(c => c.id === clipId);
    if (!clip) return;
    const asset = project.assets.find(a => a.id === clip.assetId);
    if (!asset) return;
    setSeparating(true);
    try {
      const res: any = await window.aicut.speech.separate(
        asset.path, JSON.stringify({ mode: 'vocal', keep, trackType: track.type, duration: asset.duration })
      );
      if (!res?.success) throw new Error(res?.error || '分离失败');
      const d = res.data;
      const dur = d.duration || asset.duration || 5;
      if (track.type === 'video') {
        const vidId = uid('asset');
        st.addAsset({ id: vidId, type: 'video', path: d.resultPath, duration: dur,
                      width: asset.width, height: asset.height, codec: asset.codec, fps: asset.fps });
        st.updateClip(trackId, clipId, { assetId: vidId });
      } else {
        const audId = uid('asset');
        st.addAsset({ id: audId, type: 'audio', path: d.resultPath, duration: dur });
        // 人声/伴奏 stem 时长可能略短于原音频，钳制片段长度避免越界
        const usedDur = Math.min(clip.timelineOut - clip.timelineIn, dur);
        st.updateClip(trackId, clipId, {
          assetId: audId,
          src_range: { start: 0, end: usedDur },
          timelineOut: clip.timelineIn + usedDur,
        });
      }
      setMenu(null); setSubMenu(null);
    } catch (e: any) {
      console.error('声音分离失败', e);
      alert('声音分离失败：' + (e?.message || e));
    } finally {
      setSeparating(false);
    }
  }

  // Close any open menu on outside click.
  useEffect(() => {
    const close = () => { setMenu(null); setSubMenu(null); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  // Undo / redo shortcuts: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
  // 复制/粘贴：Ctrl+C / Ctrl+V（粘贴位置=播放头）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 焦点落在输入框/下拉/可编辑区域时放行，交给浏览器处理（复制粘贴/撤销文本），避免拦截。
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const ui = useUIStore.getState();
      // Delete / Backspace：删除所有选中的片段（一次撤销）
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!ui.selectedClipIds.length) return;
        e.preventDefault();
        const proj = useProjectStore.getState();
        proj.pushHistorySnapshot();
        for (const id of ui.selectedClipIds) {
          const tr = proj.project.tracks.find(tk => tk.clips.some(c => c.id === id));
          if (tr && !tr.locked) proj.removeClip(tr.id, id);
        }
        ui.clearSelection();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); useProjectStore.getState().undo(); }
      else if (e.key === 'z' && e.shiftKey) { e.preventDefault(); useProjectStore.getState().redo(); }
      else if (e.key === 'y') { e.preventDefault(); useProjectStore.getState().redo(); }
      else if (e.key === 'c') {
        if (!ui.selectedClipIds.length) return;
        e.preventDefault();
        const proj = useProjectStore.getState();
        useProjectStore.getState().copyClips(ui.selectedClipIds.map((id) => {
          const tr = proj.project.tracks.find(tk => tk.clips.some(c => c.id === id))!;
          return { trackId: tr.id, clipId: id };
        }));
      }
      else if (e.key === 'v') {
        e.preventDefault();
        useProjectStore.getState().pasteClips(ui.currentTime);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Duplicate a clip right after itself.
  const duplicateClip = (trackId: string, clipId: string) => {
    const track = project.tracks.find(t => t.id === trackId);
    if (!track || track.locked) return;
    const c = track.clips.find(c => c.id === clipId);
    if (!c) return;
    const dur = c.timelineOut - c.timelineIn;
    useProjectStore.getState().addClip(trackId, {
      ...c, id: `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      timelineIn: c.timelineOut + 0.1, timelineOut: c.timelineOut + 0.1 + dur,
    });
  };

  // 同轨框选（rubber-band）：在轨道空白处左键拖拽，选中该轨道内与框相交的所有片段。
  // 仅作用于单条轨道（用户需求：同一轨道多选）。点击片段本身不触发（ClipItem 已 stopPropagation，且本函数守卫 e.target===currentTarget）。
  const onTrackMouseDown = (e: React.MouseEvent, track: TrackConfig) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return; // 点在片段上则交给片段自己的拖拽
    if (track.locked) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const startX = e.clientX;
    clearSelection();
    const onMove = (ev: MouseEvent) => {
      const l = Math.min(startX, ev.clientX) - rect.left;
      const r = Math.max(startX, ev.clientX) - rect.left;
      setMarquee({ trackId: track.id, left: l, width: Math.max(0, r - l) });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const mLeft = Math.min(startX, ev.clientX) - rect.left;
      const mRight = Math.max(startX, ev.clientX) - rect.left;
      const ids = track.clips
        .filter((c) => {
          const cl = c.timelineIn * timelineZoom;
          const cr = c.timelineOut * timelineZoom;
          return cr > mLeft && cl < mRight; // 与框水平相交即选中
        })
        .map((c) => c.id);
      setMarquee(null);
      if (ids.length) useUIStore.getState().setSelection(track.id, ids);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Whether any track is in solo mode (used for the indicator badge).
  const hasSoloTrack = project.tracks.some(t => t.solo);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1a1a2e', color: '#eee', fontFamily: 'system-ui', fontSize: 12 }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: '#16213e', borderBottom: '1px solid #0f3460' }}>
        <span style={{ fontSize: 11, color: '#aaa' }}>缩放</span>
        <input type="range" min={10} max={200} value={timelineZoom}
          onChange={(e) => setTimelineZoom(Number(e.target.value))} style={{ width: 100 }} />
        <button onClick={() => {
          if (!selectedTrackId || !selectedClipId) return;
          const track = useProjectStore.getState().project.tracks.find(t => t.id === selectedTrackId);
          if (track?.locked) return;
          splitClip(selectedTrackId, selectedClipId, currentTime);
        }} style={btnStyle}>分割</button>
        <button onClick={() => {
          const ui = useUIStore.getState();
          if (!ui.selectedClipIds.length) return;
          const proj = useProjectStore.getState();
          proj.pushHistorySnapshot();
          for (const id of ui.selectedClipIds) {
            const tr = proj.project.tracks.find(tk => tk.clips.some(c => c.id === id));
            if (tr && !tr.locked) proj.removeClip(tr.id, id);
          }
          ui.clearSelection();
        }} style={btnStyle}>删除</button>
        <button onClick={() => {
          const ui = useUIStore.getState();
          if (!ui.selectedClipIds.length) return;
          const proj = useProjectStore.getState();
          proj.copyClips(ui.selectedClipIds.map((id) => {
            const tr = proj.project.tracks.find(tk => tk.clips.some(c => c.id === id))!;
            return { trackId: tr.id, clipId: id };
          }));
        }} style={btnStyle}>复制</button>
        <button onClick={() => { useProjectStore.getState().pasteClips(currentTime); }} style={btnStyle}>粘贴</button>
        {/* Magnetic snap toggle */}
        <button onClick={toggleMagneticSnap} style={{
          ...btnStyle,
          background: magneticSnap ? '#1b4332' : '#333',
          border: magneticSnap ? '1px solid #4caf50' : '1px solid #555',
        }} title="磁吸：拖放时自动吸附到片段间隙">
          磁吸 {magneticSnap ? 'ON' : 'OFF'}
        </button>
        {/* Clip-edge snap toggle */}
        <button onClick={toggleClipSnap} style={{
          ...btnStyle,
          background: clipSnap ? '#1b4332' : '#333',
          border: clipSnap ? '1px solid #4caf50' : '1px solid #555',
        }} title="片段吸附：靠近其他片段边缘时吸附 (0.5s)">
          片段吸附 {clipSnap ? 'ON' : 'OFF'}
        </button>
        {hasSoloTrack && (
          <span style={{ color: '#ff9800', fontSize: 11, fontWeight: 600 }}>独奏已启用</span>
        )}
        <span style={{ marginLeft: 'auto', color: '#e94560', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(currentTime)} / {fmt(duration)}
        </span>
      </div>

      {/* Track headers + track area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left column: track headers — 自身不滚动(overflow hidden)，由右侧滚动镜像同步 */}
        <div ref={leftRef} style={{ width: 130, flexShrink: 0, background: '#16213e', borderRight: '1px solid #0f3460', overflow: 'hidden' }}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid #0f3460' }} />
          {visibleTracks.map(t => (
            <div key={t.id} data-track-header-id={t.id} style={{
              height: TRACK_HEIGHT, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '0 6px', borderBottom: '1px solid rgba(255,255,255,0.05)',
              background: t.locked ? 'rgba(233,69,96,0.15)' : 'transparent',
              opacity: t.visible === false ? 0.4 : 1,
            }}
              onContextMenu={(e) => { e.preventDefault(); setTrackMenu({ x: e.clientX, y: e.clientY, trackId: t.id }); }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span style={{ fontSize: 11 }}>{Gu[t.type] || '🎬'}</span>
                <span style={{ fontSize: 10, color: '#aaa' }}>{t.type}</span>
                {t.isMain && <span style={{ fontSize: 9, color: '#e94560', fontWeight: 700, background: 'rgba(233,69,96,0.2)', padding: '0 3px', borderRadius: 2 }}>主</span>}
                {t.locked && <span style={{ fontSize: 9, color: '#e94560', fontWeight: 600 }}>锁</span>}
              </div>
              <div style={{ display: 'flex', gap: 1, marginTop: 2 }}>
                <button onClick={() => toggleTrackLock(t.id)} style={{ ...iconBtn, color: t.locked ? '#e94560' : '#aaa', fontWeight: 400 }} title={t.locked ? '解锁轨道' : '锁定轨道'}>{t.locked ? '🔒' : '🔓'}</button>
                <button onClick={() => toggleTrackVisible(t.id)} style={{ ...iconBtn, color: t.visible !== false ? '#aaa' : '#555' }} title="显示/隐藏轨道">{t.visible !== false ? '👁' : '🚫'}</button>
                <button onClick={() => toggleTrackMute(t.id)} style={{ ...iconBtn, color: t.muted ? '#ff9800' : '#aaa' }} title="静音/取消静音">{t.muted ? '🔇' : '🔊'}</button>
                <button onClick={() => toggleTrackSolo(t.id)} style={{ ...iconBtn, color: t.solo ? '#4caf50' : '#aaa' }} title="独奏此轨道">{t.solo ? '⭐' : '☆'}</button>
              </div>
            </div>
          ))}
          <div style={{ height: 28 }} />
          {/* 口播剪辑图例（绿=保留 / 红=删除），低调放左侧 */}
          {speechOverlay && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 6px', fontSize: 10, color: '#ccc', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 9, height: 9, background: 'rgba(60,200,100,0.7)', borderRadius: 2, display: 'inline-block' }} />保留</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><span style={{ width: 9, height: 9, background: 'rgba(233,69,96,0.7)', borderRadius: 2, display: 'inline-block' }} />删除</span>
            </div>
          )}
        </div>

        {/* Right column: scrollable timeline track area */}
        <div ref={scrollRef} data-timeline-track-area onWheel={onWheel} onScroll={onTrackScroll} onClick={() => clearSelection()}
          onDragOver={onTrackDragOver} onDrop={onTrackDrop} onDragLeave={onTrackDragLeave}
          style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', position: 'relative' }}>
          <div style={{ width: duration * timelineZoom, position: 'relative', minHeight: '100%' }}>

            {/* Ruler */}
            <div onClick={onRulerClick} style={{ position: 'sticky', top: 0, zIndex: 3, height: RULER_HEIGHT, background: '#16213e', borderBottom: '1px solid #0f3460', cursor: 'pointer' }}>
              {ticks.map(t => (
                <div key={t} style={{ position: 'absolute', left: t * timelineZoom, top: 0, height: '100%' }}>
                  <div style={{ width: 1, height: 8, background: '#aaa' }} />
                  <span style={{ position: 'absolute', top: 10, left: 3, fontSize: 10, color: '#aaa', whiteSpace: 'nowrap' }}>{fmt(t)}</span>
                </div>
              ))}
            </div>

            {/* Tracks */}
            {visibleTracks.map((track, idx) => {
              // Same-type, unlocked tracks that this clip could be dropped onto.
              const sameTypeTrackIds = visibleTracks
                .filter(t => t.type === track.type && !t.locked && t.id !== track.id)
                .map(t => t.id);

              // Whether to draw a green insert line at this track's top/bottom edge.
              const showInsertLine = dragOver && (
                (dragOver.trackIndex === idx && dragOver.yInTrack < BOUNDARY_THRESHOLD) ||
                (dragOver.trackIndex === idx && dragOver.yInTrack > TRACK_HEIGHT - BOUNDARY_THRESHOLD)
              );

              return (
                <div key={track.id} data-track-id={track.id} style={{
                  height: TRACK_HEIGHT, position: 'relative',
                  background: dragOver && dragOver.trackIndex === idx && dragOver.yInTrack >= BOUNDARY_THRESHOLD && dragOver.yInTrack <= TRACK_HEIGHT - BOUNDARY_THRESHOLD
                    ? 'rgba(233, 69, 96, 0.12)'
                    : track.visible === false ? 'rgba(0,0,0,0.3)' : 'transparent',
                  transition: 'background 0.15s',
                  borderTop: showInsertLine && dragOver!.yInTrack < BOUNDARY_THRESHOLD ? '2px solid #4caf50' : '1px solid rgba(255,255,255,0.05)',
                  borderBottom: showInsertLine && dragOver!.yInTrack > TRACK_HEIGHT - BOUNDARY_THRESHOLD ? '2px solid #4caf50' : '1px solid rgba(255,255,255,0.05)',
                }}
                  onMouseDown={(e) => onTrackMouseDown(e, track)}
                  onClick={(e) => e.stopPropagation()}>

                  {track.clips.map(clip => (
                    <React.Fragment key={clip.id}>
                      <ClipItem clip={clip} track={track} color={TRACK_COLORS[track.type] || '#0f3460'}
                        selected={selectedClipIds.includes(clip.id)} zoom={timelineZoom}
                        magneticSnap={magneticSnap} clipSnap={clipSnap} playhead={currentTime} clipsOnTrack={track.clips}
                        sameTypeTrackIds={sameTypeTrackIds}
                        onSelect={(additive) => { selectClip(track.id, clip.id, additive ? 'toggle' : 'replace'); setRightView('props'); }}
                        onSplit={() => splitClip(track.id, clip.id, currentTime)}
                        onMove={(newIn) => moveClipLive(track.id, clip.id, newIn)}
                        onMoveToTrack={(destTrackId, newIn) => moveClipToTrackLive(track.id, clip.id, destTrackId, newIn)}
                        onResize={(newIn, newOut) => {
                          // 非主视频轨 / 音频轨：拉伸边缘同样不得压到相邻片段（顶到前一段尾部/后一段头部即停）
                          if (needsNoOverlap(track)) {
                            // 判定被拖动的是哪条边：两种拉伸互斥，另一条边恒等于当前值
                            const edge: 'left' | 'right' =
                              Math.abs(newIn - clip.timelineIn) > 1e-6 ? 'left' : 'right';
                            const r = clampResizeNoOverlap(track.clips, clip.id, newIn, newOut, edge);
                            if (r.newOut - r.newIn < 0.1) return; // 夹到无空间：忽略本次拉伸
                            updateClipLive(track.id, clip.id, { timelineIn: r.newIn, timelineOut: r.newOut });
                            return;
                          }
                          updateClipLive(track.id, clip.id, { timelineIn: newIn, timelineOut: newOut });
                        }}
                        onContext={(e) => onClipContext(e, track.id, clip.id)}
                        setDragOver={setDragOver} />
                      {clip.transition && (clip.transition.transitionType ?? 'none') !== 'none' && (clip.transition.duration ?? 0) > 0 && (
                        <TransitionMarker
                          clip={clip}
                          track={track}
                          zoom={timelineZoom}
                          onOpenPanel={() => { selectClip(track.id, clip.id); setActiveRightPanel('anim'); }}
                        />
                      )}
                    </React.Fragment>
                  ))}
                  {/* 框选矩形（仅作用于当前轨道） */}
                  {marquee && marquee.trackId === track.id && (
                    <div style={{
                      position: 'absolute', left: marquee.left, top: 0, width: marquee.width, height: TRACK_HEIGHT,
                      background: 'rgba(76,175,80,0.22)', border: '1px solid #4caf50',
                      pointerEvents: 'none', zIndex: 5,
                    }} />
                  )}
                </div>
              );
            })}

            {/* Drop indicator line */}
            {dragOver && (
              <div style={{
                position: 'absolute', left: dragOver.time * timelineZoom, top: RULER_HEIGHT, bottom: 0,
                width: 2, background: '#e94560', zIndex: 5, pointerEvents: 'none',
                boxShadow: '0 0 8px rgba(233, 69, 96, 0.8)',
              }}>
                <div style={{
                  position: 'absolute', top: -2, left: -20, width: 42, height: 16,
                  background: '#e94560', borderRadius: 3, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 600,
                }}>
                  {fmt(dragOver.time)}
                </div>
              </div>
            )}

            {/* Playhead */}
            <div onMouseDown={onPlayheadDown} style={{ position: 'absolute', top: 0, left: playheadX, height: '100%', width: 2, background: '#e94560', zIndex: 4, cursor: 'ew-resize' }}>
              <div style={{ position: 'absolute', top: 0, left: -5, width: 12, height: 12, background: '#e94560', borderRadius: 2 }} />
            </div>
          </div>
        </div>
      </div>

      {/* Clip context menu */}
      {menu && (() => {
        const menuTrack = useProjectStore.getState().project.tracks.find(t => t.id === menu.trackId);
        const isLocked = menuTrack?.locked;
        const trackType = menuTrack?.type;
        const dis = (locked: boolean) => ({ ...menuItem, opacity: (locked || separating) ? 0.4 : 1, cursor: (locked || separating) ? 'not-allowed' : 'pointer' });
        return (
          <div ref={menuRef} onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: menuPos ? menuPos.x : menu.x, top: menuPos ? menuPos.y : menu.y, zIndex: 1000, background: '#16213e', border: '1px solid #0f3460', borderRadius: 4, padding: 4, minWidth: 120 }}>
            {trackType === 'video' && (
              <div onClick={() => { if (!isLocked && !separating) { handleSeparateAV(menu.trackId, menu.clipId); } setMenu(null); }} style={dis(!!isLocked)}>
                {separating ? '分离中…' : '音频分离'}
              </div>
            )}
            {(trackType === 'video' || trackType === 'audio') && (
              <div onClick={() => { if (!separating) { setSubMenu({ x: menu.x + 150, y: menu.y }); } }} style={dis(false)}>声音分离 ▸</div>
            )}
            <div onClick={() => { if (!isLocked) { splitClip(menu.trackId, menu.clipId, currentTime); } setMenu(null); }} style={dis(!!isLocked)}>分割</div>
            <div onClick={() => { duplicateClip(menu.trackId, menu.clipId); setMenu(null); }} style={dis(!!isLocked)}>复制</div>
            <div onClick={() => { if (!isLocked) { removeClip(menu.trackId, menu.clipId); } setMenu(null); }} style={dis(!!isLocked)}>删除</div>
          </div>
        );
      })()}

      {/* Clip context sub-menu: 声音分离（二级子菜单） */}
      {subMenu && menu && (() => {
        const menuTrack = useProjectStore.getState().project.tracks.find(t => t.id === (menu?.trackId ?? ''));
        const isLocked = menuTrack?.locked;
        const subDis = (locked: boolean) => ({ ...menuItem, opacity: (locked || separating) ? 0.4 : 1, cursor: (locked || separating) ? 'not-allowed' : 'pointer' });
        return (
          <div ref={subMenuRef} onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: subMenuPos ? subMenuPos.x : subMenu.x, top: subMenuPos ? subMenuPos.y : subMenu.y, zIndex: 1001, background: '#16213e', border: '1px solid #0f3460', borderRadius: 4, padding: 4, minWidth: 120 }}>
            <div onClick={() => { if (!separating) { handleVocalSplit(menu!.trackId, menu!.clipId, 'vocals'); setSubMenu(null); setMenu(null); } }} style={subDis(false)}>
              {separating ? '处理中…' : '仅保留人声'}
            </div>
            <div onClick={() => { if (!separating) { handleVocalSplit(menu!.trackId, menu!.clipId, 'accomp'); setSubMenu(null); setMenu(null); } }} style={subDis(false)}>
              {separating ? '处理中…' : '仅保留背景声'}
            </div>
          </div>
        );
      })()}

      {/* Track context menu: 右键轨道头部删除空轨 */}
      {trackMenu && (() => {
        const tr = useProjectStore.getState().project.tracks.find((x) => x.id === trackMenu.trackId);
        const isEmpty = !tr || tr.clips.length === 0;
        const isMain = !!tr?.isMain;
        const canDelete = isEmpty && !isMain;
        return (
          <div ref={trackMenuRef} onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: trackMenuPos ? trackMenuPos.x : trackMenu.x, top: trackMenuPos ? trackMenuPos.y : trackMenu.y, zIndex: 1000, background: '#16213e', border: '1px solid #0f3460', borderRadius: 4, padding: 4, minWidth: 130 }}>
            <div
              onClick={() => { if (canDelete) removeTrack(trackMenu.trackId); setTrackMenu(null); }}
              style={{ ...menuItem, opacity: canDelete ? 1 : 0.4, cursor: canDelete ? 'pointer' : 'not-allowed' }}
              title={isMain ? '主视频轨永远保留，不可删除' : (!isEmpty ? '请先移走轨道内的素材再删除' : '删除此空轨道')}
            >
              删除轨道{isMain ? '（主轨）' : (!isEmpty ? '（非空）' : '')}
            </div>
          </div>
        );
      })()}

    </div>
  );
}
