// 预览窗口交互覆盖层：在预览 canvas 上直接拖拽画面，实现
//   移动(x/y) · 缩放(滚轮) · 旋转(rotate 模式) · 自由裁切(crop 模式)
// 所有操作都通过 store.updateClipLive 写入，因此与右侧「画面/基础」面板完全双向联动。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import type { ClipConfig, CropConfig, TransformConfig } from '../types';

type Mode = 'move' | 'rotate' | 'crop';
const HANDLE = 14;          // 句柄像素尺寸
const HANDLE_INSET = 8;     // 句柄中心向裁切框内侧偏移量，避免满幅时句柄压在画布边缘抓不到
const MIN_CROP = 0.02;      // 裁切最小边长(归一化)
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;

interface FitScale { x: number; y: number }

function fit(videoAspect: number, canvasAspect: number): FitScale {
  if (videoAspect > canvasAspect) return { x: 1, y: canvasAspect / videoAspect };
  return { x: videoAspect / canvasAspect, y: 1 };
}

// 归一化源 UV(0..1, y-down) → NDC(-1..1, y-up)，含 fit/scale/rotation/position
function uvToNdc(uvx: number, uvy: number, t: TransformConfig, fs: FitScale): [number, number] {
  const sx = t.scale_x ?? 1, sy = t.scale_y ?? 1;
  const bx = 2 * uvx - 1, by = 1 - 2 * uvy;
  const px = bx * fs.x * sx, py = by * fs.y * sy;
  const r = (t.rotation ?? 0) * Math.PI / 180, cr = Math.cos(r), sr = Math.sin(r);
  const rx = px * cr - py * sr, ry = px * sr + py * cr;
  const ndcX = rx + ((t.x ?? 0.5) * 2 - 1);
  const ndcY = ry + (1 - (t.y ?? 0.5) * 2);
  return [ndcX, ndcY];
}
function ndcToPx(ndcX: number, ndcY: number, fw: number, fh: number): [number, number] {
  return [(ndcX + 1) / 2 * fw, (1 - ndcY) / 2 * fh];
}
// 屏幕像素 → 归一化源 UV（uvToNdc 的逆）
function pxToUv(px: number, py: number, t: TransformConfig, fs: FitScale, fw: number, fh: number): [number, number] {
  const ndcX = px / fw * 2 - 1;
  const ndcY = 1 - py / fh * 2;
  const rx = ndcX - ((t.x ?? 0.5) * 2 - 1);
  const ry = ndcY - (1 - (t.y ?? 0.5) * 2);
  const r = (t.rotation ?? 0) * Math.PI / 180, cr = Math.cos(r), sr = Math.sin(r);
  const px2 = rx * cr + ry * sr;
  const py2 = -rx * sr + ry * cr;
  const bx = px2 / (fs.x * (t.scale_x ?? 1));
  const by = py2 / (fs.y * (t.scale_y ?? 1));
  return [(bx + 1) / 2, (1 - by) / 2];
}

const defaultCrop: CropConfig = { x: 0, y: 0, w: 1, h: 1 };

export default function PreviewTransformOverlay() {
  const project = useProjectStore((s) => s.project);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const selectedTrackId = useUIStore((s) => s.selectedTrackId);
  const selectedClipId = useUIStore((s) => s.selectedClipId);

  const [mode, setMode] = useState<Mode>('move');
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const drag = useRef<{
    type: Mode | 'cropHandle';
    handle?: string;
    startClientX: number; startClientY: number;
    startT: TransformConfig; startCrop: CropConfig;
    centerX: number; centerY: number; startAngle: number; startRotation: number;
  } | null>(null);

  // 当前选中的视频片段（与右侧面板一致）
  const target = useMemo(() => {
    if (!selectedTrackId || !selectedClipId) return null;
    for (const tr of project.tracks) {
      if (tr.id !== selectedTrackId || tr.type !== 'video') continue;
      const c = tr.clips.find((x) => x.id === selectedClipId);
      if (c) return { trackId: tr.id, clip: c };
    }
    return null;
  }, [project, selectedTrackId, selectedClipId]);

  // 素材宽高比 / 画布宽高比
  const aspects = useMemo(() => {
    const asset = target ? project.assets.find((a) => a.id === target.clip.assetId) : null;
    const vw = asset?.width || 1920, vh = asset?.height || 1080;
    const cw = project.canvas.width || 1920, ch = project.canvas.height || 1080;
    return { vA: vw / vh, cA: cw / ch };
  }, [target, project.assets, project.canvas]);

  // 测量覆盖层尺寸（= frame = canvas 显示尺寸）
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 滚轮缩放（始终可用，挂到 frame 父元素上，不拦截点击）
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent || !target) return;
    const onWheel = (e: WheelEvent) => {
      if (!target) return;
      const rect = parent.getBoundingClientRect();
      const lx = e.clientX - rect.left, ly = e.clientY - rect.top;
      if (lx < 0 || ly < 0 || lx > rect.width || ly > rect.height) return;
      const t = target.clip.transform || {};
      const factor = Math.exp(-e.deltaY * 0.0015);
      const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (t.scale_x ?? 1) * factor));
      e.preventDefault();
      pushHistorySnapshot();
      updateClipLive(target.trackId, target.clip.id, { transform: { ...t, scale_x: ns, scale_y: ns } });
    };
    parent.addEventListener('wheel', onWheel, { passive: false });
    return () => parent.removeEventListener('wheel', onWheel);
  }, [target, pushHistorySnapshot, updateClipLive]);

  // 回车确认：裁剪模式下按回车退出裁剪模式（crop 已实时写入 store，此处仅作"确认完成"的明确反馈）。
  useEffect(() => {
    if (mode !== 'crop') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setMode('move');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  // 几何：整帧框(用于移动/旋转) 与 裁切框(8 句柄)
  const geom = useMemo(() => {
    if (!target) return null;
    const fs = fit(aspects.vA, aspects.cA);
    const t = target.clip.transform || {};
    const fw = size.w, fh = size.h;
    const fullUV = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    const fullPx = fullUV.map(([ux, uy]) => {
      const [nx, ny] = uvToNdc(ux, uy, t, fs);
      return ndcToPx(nx, ny, fw, fh);
    });
    // 框中心 + 旋转角(屏幕度)
    const [cxN, cyN] = uvToNdc(0.5, 0.5, t, fs);
    const [cxp, cyp] = ndcToPx(cxN, cyN, fw, fh);
    const [rxN, ryN] = uvToNdc(1, 0.5, t, fs);
    const [rxp, ryp] = ndcToPx(rxN, ryN, fw, fh);
    const angleDeg = Math.atan2(ryp - cyp, rxp - cxp) * 180 / Math.PI;
    // 裁切框顶点(源 UV)
    const crop = target.clip.crop ?? defaultCrop;
    const cornersUV = [
      [crop.x, crop.y], [crop.x + crop.w, crop.y],
      [crop.x + crop.w, crop.y + crop.h], [crop.x, crop.y + crop.h],
    ] as const;
    const cornersPx = cornersUV.map(([ux, uy]) => {
      const [nx, ny] = uvToNdc(ux, uy, t, fs);
      return ndcToPx(nx, ny, fw, fh);
    });
    // 边中点
    const midPx = [
      [(cornersPx[0][0] + cornersPx[1][0]) / 2, (cornersPx[0][1] + cornersPx[1][1]) / 2],
      [(cornersPx[1][0] + cornersPx[2][0]) / 2, (cornersPx[1][1] + cornersPx[2][1]) / 2],
      [(cornersPx[2][0] + cornersPx[3][0]) / 2, (cornersPx[2][1] + cornersPx[3][1]) / 2],
      [(cornersPx[3][0] + cornersPx[0][0]) / 2, (cornersPx[3][1] + cornersPx[0][1]) / 2],
    ];
    return { fs, t, fw, fh, fullPx, cxp, cyp, angleDeg, crop, cornersPx, midPx };
  }, [target, aspects, size]);

  if (!target || !geom) return <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;

  const beginDrag = (e: React.PointerEvent, type: Mode | 'cropHandle', handle?: string) => {
    e.stopPropagation();
    const t = target.clip.transform || {};
    const crop = target.clip.crop ?? defaultCrop;
    const [cxN, cyN] = uvToNdc(0.5, 0.5, t, geom.fs);
    const [cxp, cyp] = ndcToPx(cxN, cyN, geom.fw, geom.fh);
    const startAngle = Math.atan2(-(e.clientY - cyp), e.clientX - cxp);
    // 裁切会话在进入裁剪模式时已压一次快照；移动/旋转仍拖前压。
    if (type !== 'cropHandle') pushHistorySnapshot();
    drag.current = {
      type, handle,
      startClientX: e.clientX, startClientY: e.clientY,
      startT: { ...t }, startCrop: { ...crop },
      centerX: cxp, centerY: cyp, startAngle, startRotation: t.rotation ?? 0,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch (_) { /* 某些环境无指针捕获，忽略 */ }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = target.clip.transform || {};
    const fw = geom.fw, fh = geom.fh;
    if (d.type === 'move') {
      const dx = e.clientX - d.startClientX, dy = e.clientY - d.startClientY;
      const nx = Math.max(-1, Math.min(2, (d.startT.x ?? 0.5) + dx / fw));
      const ny = Math.max(-1, Math.min(2, (d.startT.y ?? 0.5) + dy / fh));
      updateClipLive(target.trackId, target.clip.id, { transform: { ...t, x: nx, y: ny } });
    } else if (d.type === 'rotate') {
      const ang = Math.atan2(-(e.clientY - d.centerY), e.clientX - d.centerX);
      let delta = ang - d.startAngle;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      let rot = (d.startRotation + delta * 180 / Math.PI) % 360;
      if (rot < 0) rot += 360;
      updateClipLive(target.trackId, target.clip.id, { transform: { ...t, rotation: Math.round(rot) } });
    } else if (d.type === 'cropHandle' && d.handle) {
      const [uvx, uvy] = pxToUv(e.clientX - (rootRef.current!.parentElement!.getBoundingClientRect().left),
                                e.clientY - (rootRef.current!.parentElement!.getBoundingClientRect().top),
                                t, geom.fs, fw, fh);
      const c = d.startCrop;
      let { x, y, w, h } = c;
      const right = c.x + c.w, bottom = c.y + c.h;
      const hnd = d.handle;
      if (hnd.includes('l')) { x = Math.max(0, Math.min(uvx, right - MIN_CROP)); w = right - x; }
      if (hnd.includes('r')) { w = Math.max(MIN_CROP, Math.min(uvx - x, 1 - x)); }
      if (hnd.includes('t')) { y = Math.max(0, Math.min(uvy, bottom - MIN_CROP)); h = bottom - y; }
      if (hnd.includes('b')) { h = Math.max(MIN_CROP, Math.min(uvy - y, 1 - y)); }
      if (hnd === 'move') {
        let nx = c.x + (uvx - (c.x + c.w / 2));
        let ny = c.y + (uvy - (c.y + c.h / 2));
        nx = Math.max(0, Math.min(nx, 1 - c.w));
        ny = Math.max(0, Math.min(ny, 1 - c.h));
        x = nx; y = ny;
      }
      updateClipLive(target.trackId, target.clip.id, { crop: { x, y, w, h } });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current) { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch (_) {} }
    drag.current = null;
  };

  // 进入裁剪模式时压一次快照（整次裁剪会话 = 一次撤销）；其余模式直接切换。
  const enterMode = (m: Mode) => {
    if (m === 'crop' && mode !== 'crop') pushHistorySnapshot();
    setMode(m);
  };
  const ToolBtn = ({ m, label }: { m: Mode; label: string }) => (
    <button
      onClick={() => enterMode(m)}
      style={{
        background: mode === m ? '#e94560' : 'rgba(15,52,96,0.92)', color: '#fff',
        border: 'none', borderRadius: 5, padding: '5px 11px', fontSize: 12, cursor: 'pointer',
      }}
    >{label}</button>
  );

  const H = (key: string, x: number, y: number, cursor: string, ix = 0, iy = 0) => (
    <div
      onPointerDown={(e) => beginDrag(e, 'cropHandle', key)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      style={{
        position: 'absolute', left: x + ix - HANDLE / 2, top: y + iy - HANDLE / 2, width: HANDLE, height: HANDLE,
        background: '#fff', border: '2px solid #e94560', borderRadius: 2, cursor, pointerEvents: 'auto',
      }}
    />
  );

  const showFrameBox = mode === 'move' || mode === 'rotate';

  return (
    <div ref={rootRef} data-testid="preview-overlay" data-mode={mode} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20, fontFamily: 'system-ui' }}>
      {/* 工具栏：zIndex 抬高，确保在裁剪框/移动框/句柄之上（否则这些 pointerEvents:auto 的框会覆盖工具栏导致按钮点不到） */}
      <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6, pointerEvents: 'auto', background: 'rgba(0,0,0,0.35)', padding: 4, borderRadius: 8, zIndex: 30 }}>
        <ToolBtn m="move" label="移动" />
        <ToolBtn m="rotate" label="旋转" />
        <ToolBtn m="crop" label="裁剪" />
        <span style={{ color: '#cdd', fontSize: 11, alignSelf: 'center', paddingLeft: 4 }}>
          {mode === 'crop' ? '拖句柄裁切 · 回车确认' : '滚轮缩放'}
        </span>
      </div>

      {/* 整帧变换框（移动/旋转模式）：0 尺寸旋转锚点 + 可交互边框矩形（事件冒泡到边框） */}
      {showFrameBox && (() => {
        const pts = geom.fullPx.map(([px, py]) => [px - geom.cxp, py - geom.cyp]);
        const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
        const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
        return (
          <div style={{ position: 'absolute', left: geom.cxp, top: geom.cyp, width: 0, height: 0, transform: `rotate(${geom.angleDeg}deg)` }}>
            <div
              onPointerDown={(e) => beginDrag(e, mode)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              style={{
                position: 'absolute', left: minX, top: minY, width: maxX - minX, height: maxY - minY,
                border: '1.5px solid #e94560', boxSizing: 'border-box',
                pointerEvents: 'auto', cursor: mode === 'move' ? 'move' : 'grab',
              }}
            >
              {mode === 'rotate' && (
                <div style={{
                  position: 'absolute', left: '50%', top: -HANDLE / 2 - 34,
                  width: HANDLE, height: HANDLE, background: '#fff', border: '2px solid #e94560',
                  borderRadius: '50%', cursor: 'grab', transform: 'translateX(-50%)',
                }} />
              )}
            </div>
          </div>
        );
      })()}

      {/* 裁切模式：暗化外部 + 裁切框 + 8 句柄 */}
      {mode === 'crop' && (
        <>
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} viewBox={`0 0 ${geom.fw} ${geom.fh}`}>
            <path
              d={`M0 0 H${geom.fw} V${geom.fh} H0 Z M${geom.cornersPx[0][0]} ${geom.cornersPx[0][1]} L${geom.cornersPx[3][0]} ${geom.cornersPx[3][1]} L${geom.cornersPx[2][0]} ${geom.cornersPx[2][1]} L${geom.cornersPx[1][0]} ${geom.cornersPx[1][1]} Z`}
              fill="rgba(0,0,0,0.5)" fillRule="evenodd"
            />
          </svg>
          <div
            style={{
              position: 'absolute',
              left: Math.min(geom.cornersPx[0][0], geom.cornersPx[3][0]),
              top: Math.min(geom.cornersPx[0][1], geom.cornersPx[1][1]),
              width: Math.abs(geom.cornersPx[1][0] - geom.cornersPx[3][0]),
              height: Math.abs(geom.cornersPx[2][1] - geom.cornersPx[0][1]),
              border: '1.5px solid #e94560', boxSizing: 'border-box', pointerEvents: 'auto', cursor: 'move',
            }}
            onPointerDown={(e) => beginDrag(e, 'cropHandle', 'move')}
            onPointerMove={onMove}
            onPointerUp={onUp}
          />
          {/* 角（句柄中心向框内偏移 INSET，确保满幅时也完全落在画布内可抓取） */}
          {H('tl', geom.cornersPx[0][0], geom.cornersPx[0][1], 'nwse-resize', HANDLE_INSET, HANDLE_INSET)}
          {H('tr', geom.cornersPx[1][0], geom.cornersPx[1][1], 'nesw-resize', -HANDLE_INSET, HANDLE_INSET)}
          {H('br', geom.cornersPx[2][0], geom.cornersPx[2][1], 'nwse-resize', -HANDLE_INSET, -HANDLE_INSET)}
          {H('bl', geom.cornersPx[3][0], geom.cornersPx[3][1], 'nesw-resize', HANDLE_INSET, -HANDLE_INSET)}
          {/* 边中点 */}
          {H('t', geom.midPx[0][0], geom.midPx[0][1], 'ns-resize', 0, HANDLE_INSET)}
          {H('r', geom.midPx[1][0], geom.midPx[1][1], 'ew-resize', -HANDLE_INSET, 0)}
          {H('b', geom.midPx[2][0], geom.midPx[2][1], 'ns-resize', 0, -HANDLE_INSET)}
          {H('l', geom.midPx[3][0], geom.midPx[3][1], 'ew-resize', HANDLE_INSET, 0)}
        </>
      )}
    </div>
  );
}
