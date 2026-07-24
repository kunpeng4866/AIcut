// AIcut timeline component: a React video editor timeline.
// Renders tracks, a ruler, a playhead and clip items with drag/resize,
// magnetic snapping, cross-track drag, audio waveforms, text/subtitle tracks
// and keyframe markers.

import React, { useRef, useState, useEffect, useCallback } from 'react';

import { useProjectStore } from '../store/projectStore';

import { useUIStore } from '../store/uiStore';

import { useWaveform } from '../hooks/useWaveform';

import type { ClipConfig, TrackConfig, AssetConfig } from '../types';

// Convert a filesystem path to an aicut-asset:// URL so it can be loaded by
// PreviewCanvas.tsx and other components without extra plumbing.
const pathToUrl = (path: string): string => {
  if (/^(https?|aicut-asset|blob):/.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  return `aicut-asset:///${normalized}`;
};

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

// Parse an SRT string into timed subtitle entries.
function parseSRT(srt: string): { start: number; end: number; text: string }[] {
  const blocks = srt.trim().split(/\n\n+/);
  return blocks.map(block => {
    const lines = block.trim().split('\n');
    const timeLine = lines.find(l => /-->/.test(l));
    if (!timeLine) return null;
    const textLines = lines.filter(l => !/^\d+$/.test(l) && !/-->/.test(l)).filter(Boolean);
    const m = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
    if (!m) return null;
    const toSec = (a: number, b: number, c: number, d: number) => a * 3600 + b * 60 + c + d / 1000;
    return { start: toSec(+m[1], +m[2], +m[3], +m[4]), end: toSec(+m[5], +m[6], +m[7], +m[8]), text: textLines.join('\n').trim() };
  }).filter((x): x is NonNullable<typeof x> => x != null);
}

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

    ctx.fillStyle = '#8fd';
    for (let i = 0; i < visiblePeaks.length; i++) {
      const peak = visiblePeaks[i];
      const barHeight = Math.max(1, peak * height * 0.9);
      const x = i * barWidth;
      ctx.fillRect(x, midY - barHeight / 2, Math.max(1, barWidth - 0.5), barHeight);
    }
  }, [peaks, width, height, startTime, endTime, totalDuration]);

  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}

// Clip item props.
interface ClipItemProps {
  clip: ClipConfig; track: TrackConfig; color: string; selected: boolean; zoom: number;
  magneticSnap: boolean; clipSnap: boolean; playhead: number; clipsOnTrack: ClipConfig[];
  sameTypeTrackIds: string[];
  onSelect: () => void; onSplit: () => void;
  onMove: (newIn: number) => void;
  onMoveToTrack: (destTrackId: string, newIn: number) => void;
  onResize: (newIn: number, newOut: number) => void; onContext: (e: React.MouseEvent) => void;
}

function ClipItem({ clip, track, color, selected, zoom, magneticSnap, clipSnap, playhead, clipsOnTrack, sameTypeTrackIds, onSelect, onSplit, onMove, onMoveToTrack, onResize, onContext }: ClipItemProps) {
  const left = clip.timelineIn * zoom;
  const width = Math.max(4, (clip.timelineOut - clip.timelineIn) * zoom);
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);

  // Resolve the asset so we can build the audio URL / waveform peaks.
  const asset = useProjectStore((s) => s.project.assets.find(a => a.id === clip.assetId));
  const isAudio = track.type === 'audio';
  const audioUrl = isAudio && asset?.path ? pathToUrl(asset.path) : null;
  const { peaks: wavePeaks, loading: waveLoading } = useWaveform(audioUrl, isAudio ? clip.assetId : null);
  const totalDuration = asset?.duration || clip.src_range.end;

  // Begin a move / left-resize / right-resize drag operation.
  const startDrag = (e: React.MouseEvent, mode: 'move' | 'left' | 'right') => {
    e.stopPropagation();
    onSelect();
    if (track.locked) return; // locked tracks can't be edited
    let startX = e.clientX;
    let startIn = clip.timelineIn;
    const startOut = clip.timelineOut;

    const onMove2 = (ev: MouseEvent) => {
      const dt = (ev.clientX - startX) / zoom;
      if (mode === 'move') {
        const newIn = Math.max(0, startIn + dt);
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const trackEl = el?.closest('[data-track-id]') as HTMLElement | null;
        const hoverTrackId = trackEl?.dataset.trackId || null;
        if (hoverTrackId && hoverTrackId !== track.id && sameTypeTrackIds.includes(hoverTrackId)) {
          // Cross-track move to a same-type, unlocked track.
          setDragTrackId(hoverTrackId);
          onMoveToTrack(hoverTrackId, newIn);
          const updated = useProjectStore.getState().project.tracks
            .find(t => t.id === hoverTrackId)?.clips.find(c => c.id === clip.id);
          if (updated) { startIn = updated.timelineIn; }
          startX = ev.clientX;
        } else {
          // Normal move on the same track.
          setDragTrackId(null);
          onMove(newIn);
          const updated = useProjectStore.getState().project.tracks
            .find(t => t.id === track.id)?.clips.find(c => c.id === clip.id);
          if (updated) { startIn = updated.timelineIn; }
          startX = ev.clientX;
        }
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
      // After a move, realign the main track / snap on the destination track.
      if (mode === 'move') {
        const { project, moveClip } = useProjectStore.getState();
        const clipTrack = project.tracks.find(t => t.clips.some(c => c.id === clip.id));
        if (clipTrack) {
          const c = clipTrack.clips.find(c => c.id === clip.id);
          if (c) {
            if (clipTrack.isMain) {
              // Main track: moveClip without realign already keeps things tidy.
              moveClip(clipTrack.id, clip.id, c.timelineIn);
            } else if (clipTrack.type === 'video') {
              // Video (non-main): snap to 0.5s grid after drop.
              const dur = c.timelineOut - c.timelineIn;
              const snapped = snapTime(c.timelineIn, dur, clipTrack.clips, clip.id, playhead, clipSnap);
              if (Math.abs(snapped - c.timelineIn) > 0.001) {
                moveClip(clipTrack.id, clip.id, snapped);
              }
            }
          }
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
            <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
              {Array.from({ length: Math.max(5, Math.floor(width / 3)) }).map((_, i) => (
                <div key={i} style={{ width: 1, height: `${30 + Math.abs(Math.sin(i * 0.7)) * 50}%`, background: '#8fd', margin: '0 1px' }} />
              ))}
            </div>
          )}
        </div>
      )}
      <span style={{ position: 'absolute', top: 2, left: 8, fontSize: 11, color: '#eee', pointerEvents: 'none' }}>
        {clip.assetId}
      </span>
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
  const { project, addTrack, insertTrackAt, addClip, removeClip, splitClip, moveClip, moveClipToTrack, updateClip, toggleTrackLock, toggleTrackVisible, toggleTrackMute, toggleTrackSolo, getMainVideoTrack } = useProjectStore();
  const { selectedTrackId, selectedClipId, currentTime, timelineZoom, magneticSnap, clipSnap, selectClip, clearSelection, setCurrentTime, setTimelineZoom, toggleMagneticSnap, toggleClipSnap } = useUIStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; trackId: string; clipId: string } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState<{ time: number; trackIndex: number; yInTrack: number } | null>(null);

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

    // Near the top/bottom boundary => insert a new track above/below.
    // Blank area (no track under cursor) => use main video track or add one.
    const isNearTopBoundary = yInTrack < BOUNDARY_THRESHOLD;
    const isNearBottomBoundary = yInTrack > TRACK_HEIGHT - BOUNDARY_THRESHOLD;
    const isBlankArea = trackIndex < 0 || trackIndex >= project.tracks.length;

    let targetTrack: TrackConfig | undefined;
    let dropTime = time;

    if (isBlankArea) {
      // Outside the track stack: prefer the main video track, else add a track.
      if (targetTrackType === 'video') {
        const mainTrack = getMainVideoTrack();
        if (mainTrack && !mainTrack.locked) {
          targetTrack = mainTrack;
          if (magneticSnap) {
            dropTime = calcMagnetInsertTime(mainTrack.clips, time);
          } else {
            const clipDur = asset.duration || 5;
            dropTime = snapTime(time, clipDur, mainTrack.clips, '', currentTime, clipSnap);
          }
        }
      }
      if (!targetTrack) {
        const newId = addTrack(targetTrackType);
        targetTrack = useProjectStore.getState().project.tracks.find(t => t.id === newId);
      }
    } else if (isNearTopBoundary || isNearBottomBoundary) {
      // Insert a brand new track at the boundary.
      const insertIdx = isNearTopBoundary ? trackIndex : trackIndex + 1;
      const newId = insertTrackAt(insertIdx, targetTrackType);
      targetTrack = useProjectStore.getState().project.tracks.find(t => t.id === newId);
    } else {
      // Dropped inside an existing track.
      if (targetTrackType === 'video' && magneticSnap) {
        const mainTrack = getMainVideoTrack();
        if (mainTrack && !mainTrack.locked) {
          targetTrack = mainTrack;
          dropTime = calcMagnetInsertTime(mainTrack.clips, time);
        }
      } else {
        const hoverTrack = project.tracks[trackIndex];
        if (hoverTrack && hoverTrack.type === targetTrackType && !hoverTrack.locked) {
          targetTrack = hoverTrack;
          const clipDur = asset.duration || 5;
          dropTime = snapTime(time, clipDur, hoverTrack.clips, '', currentTime, clipSnap);
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

  // Close any open menu on outside click.
  useEffect(() => {
    const close = () => { setMenu(null); setAddMenu(null); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  // Undo / redo shortcuts: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); useProjectStore.getState().undo(); }
      else if (e.key === 'z' && e.shiftKey) { e.preventDefault(); useProjectStore.getState().redo(); }
      else if (e.key === 'y') { e.preventDefault(); useProjectStore.getState().redo(); }
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

  // Add a new text clip (creating a text track if needed).
  const handleAddText = () => {
    const p = useProjectStore.getState();
    let textTrack = p.project.tracks.find((t: TrackConfig) => t.type === 'text');
    if (!textTrack) {
      const newId = p.addTrack('text');
      textTrack = useProjectStore.getState().project.tracks.find(t => t.id === newId);
      if (!textTrack) return;
    }
    const lastEnd = textTrack.clips.length > 0
      ? Math.max(...textTrack.clips.map((c: ClipConfig) => c.timelineOut))
      : 0;
    const clipId = `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    p.addClip(textTrack.id, {
      id: clipId, assetId: '_text',
      src_range: { start: 0, end: 5 },
      timelineIn: lastEnd, timelineOut: lastEnd + 5,
      text: { content: '双击编辑文字', fontSize: 48, color: '#ffffff', textAlign: 'center' as const, x: 0.5, y: 0.5 },
    });
    selectClip(textTrack.id, clipId);
  };

  // Import an SRT/ASS/VTT subtitle file into a subtitle track.
  const handleImportSubtitle = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.srt,.ass,.vtt';
    input.onchange = async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      const items = parseSRT(text);
      if (items.length === 0) return;
      const p = useProjectStore.getState();
      let subTrack = p.project.tracks.find((t: { type: string }) => t.type === 'subtitle');
      if (!subTrack) {
        const newId = p.addTrack('subtitle');
        subTrack = useProjectStore.getState().project.tracks.find((t: TrackConfig) => t.id === newId);
        if (!subTrack) return;
      }
      const totalDuration = items[items.length - 1].end;
      const clipId = `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      p.addClip(subTrack.id, {
        id: clipId, assetId: '_subtitle',
        src_range: { start: 0, end: totalDuration },
        timelineIn: 0, timelineOut: totalDuration,
        subtitle: { items, fontSize: 24, color: '#ffffff', position: 'bottom' as const },
      });
      selectClip(subTrack.id, clipId);
    };
    input.click();
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
          if (!selectedTrackId || !selectedClipId) return;
          const track = useProjectStore.getState().project.tracks.find(t => t.id === selectedTrackId);
          if (track?.locked) return;
          removeClip(selectedTrackId, selectedClipId);
        }} style={btnStyle}>删除</button>
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
        <div style={{ width: 1, height: 20, background: '#0f3460', margin: '0 4px' }} />
        <button onClick={handleAddText} style={{ ...btnStyle, background: '#3d2b1b' }} title="添加文字/标题片段到文字轨">文字</button>
        <button onClick={handleImportSubtitle} style={{ ...btnStyle, background: '#1b3d3d' }}>CC 字幕</button>
        {hasSoloTrack && (
          <span style={{ color: '#ff9800', fontSize: 11, fontWeight: 600 }}>独奏已启用</span>
        )}
        <span style={{ marginLeft: 'auto', color: '#e94560', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(currentTime)} / {fmt(duration)}
        </span>
      </div>

      {/* Track headers + track area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left column: track headers */}
        <div style={{ width: 130, flexShrink: 0, background: '#16213e', borderRight: '1px solid #0f3460', overflowY: 'auto' }}>
          <div style={{ height: RULER_HEIGHT, borderBottom: '1px solid #0f3460' }} />
          {project.tracks.map(t => (
            <div key={t.id} data-track-header-id={t.id} style={{
              height: TRACK_HEIGHT, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '0 6px', borderBottom: '1px solid rgba(255,255,255,0.05)',
              background: t.locked ? 'rgba(233,69,96,0.15)' : 'transparent',
              opacity: t.visible === false ? 0.4 : 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span style={{ fontSize: 11 }}>{Gu[t.type] || '🎬'}</span>
                <span style={{ fontSize: 10, color: '#aaa' }}>{t.type}</span>
                {t.isMain && <span style={{ fontSize: 9, color: '#e94560', fontWeight: 700, background: 'rgba(233,69,96,0.2)', padding: '0 3px', borderRadius: 2 }}>主</span>}
                {t.locked && <span style={{ fontSize: 9, color: '#e94560', fontWeight: 600 }}>锁</span>}
              </div>
              <div style={{ display: 'flex', gap: 1, marginTop: 2 }}>
                <button onClick={() => toggleTrackLock(t.id)} style={{ ...iconBtn, color: t.locked ? '#e94560' : '#aaa', fontWeight: t.locked ? 700 : 400 }} title={t.locked ? '解锁轨道' : '锁定轨道'}>{t.locked ? '锁' : '开'}</button>
                <button onClick={() => toggleTrackVisible(t.id)} style={{ ...iconBtn, color: t.visible !== false ? '#aaa' : '#555' }} title="显示/隐藏轨道">{t.visible !== false ? '显' : '隐'}</button>
                <button onClick={() => toggleTrackMute(t.id)} style={{ ...iconBtn, color: t.muted ? '#ff9800' : '#aaa' }} title="静音/取消静音">{t.muted ? '静' : '音'}</button>
                <button onClick={() => toggleTrackSolo(t.id)} style={{ ...iconBtn, color: t.solo ? '#4caf50' : '#aaa' }} title="独奏此轨道">独</button>
              </div>
            </div>
          ))}
          <div style={{ height: 28 }} />
        </div>

        {/* Right column: scrollable timeline track area */}
        <div ref={scrollRef} data-timeline-track-area onWheel={onWheel} onClick={() => clearSelection()}
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
            {project.tracks.map((track, idx) => {
              // Same-type, unlocked tracks that this clip could be dropped onto.
              const sameTypeTrackIds = project.tracks
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
                }}>

                  {track.clips.map(clip => (
                    <ClipItem key={clip.id} clip={clip} track={track} color={TRACK_COLORS[track.type] || '#0f3460'}
                      selected={selectedClipId === clip.id} zoom={timelineZoom}
                      magneticSnap={magneticSnap} clipSnap={clipSnap} playhead={currentTime} clipsOnTrack={track.clips}
                      sameTypeTrackIds={sameTypeTrackIds}
                      onSelect={() => selectClip(track.id, clip.id)}
                      onSplit={() => splitClip(track.id, clip.id, currentTime)}
                      onMove={(newIn) => moveClip(track.id, clip.id, newIn, true)}
                      onMoveToTrack={(destTrackId, newIn) => moveClipToTrack(track.id, clip.id, destTrackId, newIn)}
                      onResize={(newIn, newOut) => updateClip(track.id, clip.id, { timelineIn: newIn, timelineOut: newOut })}
                      onContext={(e) => onClipContext(e, track.id, clip.id)} />
                  ))}
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

      {/* Add-track button */}
      <div style={{ padding: '4px 8px', background: '#16213e', borderTop: '1px solid #0f3460' }}>
        <button onClick={(e) => { e.stopPropagation(); setAddMenu({ x: e.clientX, y: e.clientY - 120 }); }} style={btnStyle}>+ 添加轨道</button>
      </div>

      {/* Clip context menu */}
      {menu && (() => {
        const menuTrack = useProjectStore.getState().project.tracks.find(t => t.id === menu.trackId);
        const isLocked = menuTrack?.locked;
        return (
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 100, background: '#16213e', border: '1px solid #0f3460', borderRadius: 4, padding: 4, minWidth: 120 }}>
            <div onClick={() => { if (!isLocked) { splitClip(menu.trackId, menu.clipId, currentTime); } setMenu(null); }} style={{ ...menuItem, opacity: isLocked ? 0.4 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}>分割</div>
            <div onClick={() => { duplicateClip(menu.trackId, menu.clipId); setMenu(null); }} style={{ ...menuItem, opacity: isLocked ? 0.4 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}>复制</div>
            <div onClick={() => { if (!isLocked) { removeClip(menu.trackId, menu.clipId); } setMenu(null); }} style={{ ...menuItem, opacity: isLocked ? 0.4 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}>删除</div>
          </div>
        );
      })()}

      {/* Add-track menu */}
      {addMenu && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', left: addMenu.x, top: addMenu.y, zIndex: 100, background: '#16213e', border: '1px solid #0f3460', borderRadius: 4, padding: 4, minWidth: 120 }}>
          {(['video', 'audio', 'text', 'sticker'] as const).map(type => (
            <div key={type} onClick={() => { addTrack(type); setAddMenu(null); }} style={menuItem}>
              {Gu[type]} {type}
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
