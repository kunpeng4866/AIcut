// 抠像属性面板（KeyingTab）：启用开关、模式选择、键色（含吸管）、相似度、边缘柔化、溢出抑制、背景合成。
// 三种模式（chroma / smart / manual）共享统一的面板布局、滑块手感与禁用态；吸管取色既可用作键色也可用于背景纯色。
// 写入方式：结构变更（启用/模式/颜色/模型/生成）走 updateClip（拖前 pushHistorySnapshot），
//           参数拖动（阈值/柔化/相似度/溢出）走 updateClipLive。
import { useState, useRef, useEffect } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useAssetStore } from '../../store/assetStore';
import { createDefaultKeying, uid } from '../../utils/clipFactories';
import type { ClipConfig, KeyingConfig, KeyingMode, BackgroundType, KeyingBackground, KeyingProgress } from '../../types';

// 本地 pathToUrl（与 WebGPUPreview/PreviewCanvas 内实现一致，避免循环依赖）
const pathToUrl = (path: string): string => {
  if (/^(https?|aicut-asset|blob):/.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  return `aicut-asset:///${normalized}`;
};

// 复用面板配色（深色 #16213e / #0f3460 边框 / #e94560 强调）
const S = {
  row: { display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' } as const,
  input: { flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, minWidth: 0 } as const,
  btn: { background: '#0f3460', color: '#eee', border: '1px solid #1a1a2e', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' } as const,
  btnActive: { background: '#e94560', color: '#fff', border: '1px solid #e94560' } as const,
  label: { color: '#aaa', fontSize: 11, width: 54, flexShrink: 0 } as const,
  divider: { height: 1, background: '#0f3460', margin: '8px 0' } as const,
};

// 区块标题：统一四块的视觉层级
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: '#8895b3', fontSize: 11, fontWeight: 600, letterSpacing: 0.3, marginBottom: 8 }}>
      {children}
    </div>
  );
}

// 小灰字提示：解释某参数的语义（用于区分 edgeSoftness 在色度/智能模式下的不同含义）
function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: '#6b7794', fontSize: 10, lineHeight: 1.4, marginTop: -4, marginBottom: 6 }}>
      {children}
    </div>
  );
}

// 可复用参数滑块（拖动时走 live，拖前压一次历史快照）；disabled 时整体置灰并禁交互
function ParamSlider({ label, value, min, max, step, unit, editable, disabled, onChange, onEditStart }: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; editable?: boolean; disabled?: boolean; onChange: (v: number) => void; onEditStart?: () => void;
}) {
  const fmt = (v: number) => unit === '%' ? `${Math.round(v * 100)}%` : unit === '°' ? `${Math.round(v)}°` : v.toFixed(2);
  let editing = false;
  const begin = () => { if (!editing && !disabled) { editing = true; onEditStart?.(); } };
  const end = () => { editing = false; };
  const textColor = disabled ? '#666' : '#eee';
  return (
    <div style={{ marginBottom: 8, opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, alignItems: 'center' }}>
        <span style={{ color: disabled ? '#666' : '#aaa', fontSize: 11 }}>{label}</span>
        {editable ? (
          <input type="number" value={value} min={min} max={max} step={step} disabled={disabled}
            onFocus={begin} onBlur={end}
            onChange={(e) => { begin(); onChange(parseFloat(e.target.value) || 0); }}
            style={{ width: 64, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: textColor, padding: '2px 4px', fontSize: 11 }} />
        ) : (
          <span style={{ color: textColor, fontSize: 11 }}>{fmt(value)}</span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        disabled={disabled}
        onPointerDown={begin} onPointerUp={end} onBlur={end}
        onChange={(e) => { begin(); onChange(parseFloat(e.target.value)); }}
        style={{ width: '100%', accentColor: '#e94560', cursor: disabled ? 'not-allowed' : 'pointer' }} />
    </div>
  );
}

function ToggleBtn({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button style={{ ...S.btn, ...(active ? S.btnActive : {}), opacity: disabled ? 0.5 : 1 }} disabled={disabled} onClick={onClick}>{children}</button>;
}

// 颜色行：色块 + 文本输入 + 可选吸管（键色与背景纯色复用，保证两处取色交互一致）
function ColorRow({ label, value, onChange, onPick, disabled }: {
  label: string; value: string; onChange: (v: string) => void; onPick?: () => void; disabled?: boolean;
}) {
  return (
    <div style={S.row}>
      <span style={S.label}>{label}</span>
      <input type="color" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', background: 'transparent', opacity: disabled ? 0.5 : 1 }} />
      <input type="text" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...S.input, opacity: disabled ? 0.5 : 1 }} />
      {onPick && (
        <button style={S.btn} disabled={disabled} onClick={onPick} title="屏幕取色">吸管</button>
      )}
    </div>
  );
}

// 生成按钮：智能/手动抠像共用的一致外观与禁用态
function GenerateButton({ processing, disabled, onClick, children }: {
  processing: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button style={{ ...S.btn, width: '100%', background: '#e94560', color: '#fff', border: '1px solid #e94560', opacity: (disabled || processing) ? 0.6 : 1 }}
      disabled={disabled || processing}
      onClick={onClick}>
      {children}
    </button>
  );
}

// 抠像实时进度条：显示阶段 / 帧 / 速度 / 预计剩余（与 SRTab 同范式）
const KEYING_STAGE_LABEL: Record<string, string> = { load: '模型加载中', infer: '逐帧推理中', done: '完成' };
function keyingProgressPct(p: KeyingProgress | null): number {
  if (!p) return 0;
  if (p.done) return 100;
  if (p.total && p.total > 0 && typeof p.frame === 'number') {
    return Math.min(100, Math.round((p.frame / p.total) * 100));
  }
  return -1; // 总帧未知 → 不确定进度
}
function KeyingProgressBar({ p }: { p: KeyingProgress | null }) {
  if (!p) return null;
  const pct = keyingProgressPct(p);
  const label = (p.stage && KEYING_STAGE_LABEL[p.stage]) || '处理中';
  const detail = [
    typeof p.frame === 'number' && p.total ? `${p.frame}/${p.total} 帧` : (typeof p.frame === 'number' ? `${p.frame} 帧` : ''),
    p.fps ? `${p.fps.toFixed(1)} 帧/秒` : '',
    p.eta_sec && p.eta_sec > 0 ? `预计剩余 ${Math.round(p.eta_sec)} 秒` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#aaa', fontSize: 11, marginBottom: 4 }}>
        <span>{label}{detail ? ` · ${detail}` : ''}</span>
        {pct >= 0 && <span>{pct}%</span>}
      </div>
      <div style={{ height: 4, background: '#0f3460', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          width: pct >= 0 ? `${pct}%` : '100%', height: '100%',
          background: '#e94560', borderRadius: 2,
          ...(pct < 0 ? { animation: 'none', opacity: 0.4 } : {}),
        }} />
      </div>
    </div>
  );
}

const MODES: { value: KeyingMode; label: string }[] = [
  { value: 'chroma', label: '色度' },
  { value: 'smart', label: '智能' },
  { value: 'manual', label: '手动' },
];

// 背景合成类型（P3）
const BG_TYPES: { value: string; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'color', label: '纯色' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
];

// 浏览器原生吸管（Chrome/Edge 支持），失败则静默忽略
function pickColorWithEyedropper(): Promise<string | null> {
  const w = window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } };
  if (typeof w.EyeDropper === 'function') {
    try {
      const ed = new w.EyeDropper();
      return ed.open().then((r) => r?.sRGBHex ?? null).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }
  return Promise.resolve(null);
}

// 由源素材真实路径推导智能抠像输出路径：<目录>/<stem>_matte.mp4（绝对路径，Windows 用正斜杠）
function matteOutputPath(assetPath: string): string {
  const idx = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
  const dir = idx >= 0 ? assetPath.slice(0, idx + 1) : '';
  const file = idx >= 0 ? assetPath.slice(idx + 1) : assetPath;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${dir}${stem}_matte.mp4`;
}

// ───────────────────────── P2 手动抠像：画笔涂鸦画布 ─────────────────────────
// 约定（与 python/keying/core.py generate_manual_matte 对齐）：
//   前景涂抹 = 不透明白色 (R=255,A=255)；背景涂抹 = 不透明黑色 (R=0,A=255)；未涂抹 = A=0 透明。
type Brush = 'fg' | 'bg' | 'erase';
function ManualPaintCanvas({ videoPath, canvasRef, videoRef, currentFrame, fps, frameCount, onFrameChange, savedGuide, onCapture, onClearFrame, guidesRef }: {
  videoPath?: string; canvasRef: React.RefObject<HTMLCanvasElement>; videoRef: React.RefObject<HTMLVideoElement>;
  currentFrame: number; fps: number; frameCount: number; onFrameChange: (f: number) => void;
  savedGuide: string | null; onCapture: (f: number, url: string) => void; onClearFrame: (f: number) => void;
  guidesRef: React.MutableRefObject<Map<number, string>>;
}) {
  const [brush, setBrush] = useState<Brush>('fg');
  const [brushSize, setBrushSize] = useState(22);
  const [aspect, setAspect] = useState(16 / 9);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const undoStack = useRef<string[]>([]);

  const setupCanvas = () => {
    const c = canvasRef.current; const v = videoRef.current;
    if (!c || !v || !v.videoWidth) return;
    const nw = v.videoWidth, nh = v.videoHeight;
    const scale = Math.min(1, 480 / Math.max(nw, nh));
    c.width = Math.max(1, Math.round(nw * scale));
    c.height = Math.max(1, Math.round(nh * scale));
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    if (savedGuide) {
      const img = new Image();
      img.onload = () => c.getContext('2d')?.drawImage(img, 0, 0);
      img.src = savedGuide;
    }
    setAspect(nw / nh);
  };
  const pos = (e: ReactPointerEvent) => {
    const c = canvasRef.current!; const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * c.width, y: (e.clientY - r.top) / r.height * c.height };
  };
  const stroke = (x: number, y: number) => {
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (brush === 'erase') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = 'rgba(0,0,0,1)'; }
    else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = brush === 'fg' ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,1)'; }
    ctx.lineWidth = brushSize;
    ctx.beginPath();
    if (last.current) ctx.moveTo(last.current.x, last.current.y);
    else { ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.lineTo(x, y); ctx.stroke();
    last.current = { x, y };
  };
  const pushUndo = () => { const c = canvasRef.current; if (!c) return; undoStack.current.push(c.toDataURL()); if (undoStack.current.length > 12) undoStack.current.shift(); };
  const onDown = (e: ReactPointerEvent) => { (e.target as Element).setPointerCapture?.(e.pointerId); drawing.current = true; pushUndo(); last.current = null; const p = pos(e); stroke(p.x, p.y); };
  const onMove = (e: ReactPointerEvent) => { if (!drawing.current) return; const p = pos(e); stroke(p.x, p.y); };
  const onUp = () => { drawing.current = false; last.current = null; };
  const undo = () => { const c = canvasRef.current; if (!c) return; const d = undoStack.current.pop(); if (!d) return; const img = new Image(); img.onload = () => { const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0); }; img.src = d; };

  // 逐帧 refine：切换 currentFrame 时 seek 视频到对应时间，并把本帧已存的 guide 还原（无则清空）
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.currentTime = currentFrame / fps;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (savedGuide) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = savedGuide;
    }
  }, [currentFrame, fps, savedGuide, videoRef, canvasRef]);

  const btn = (active: boolean) => ({ ...S.btn, ...(active ? S.btnActive : {}) });
  const maxFrame = Math.max(0, frameCount - 1);
  return (
    <div>
      {videoPath ? (
        <div style={{ position: 'relative', width: '100%', aspectRatio: String(aspect), background: '#000', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          <video ref={videoRef} src={videoPath} muted playsInline
            onLoadedMetadata={setupCanvas}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', zIndex: 1, pointerEvents: 'none' }} />
          <canvas ref={canvasRef}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', cursor: 'crosshair', touchAction: 'none', zIndex: 2, pointerEvents: 'auto' }} />
        </div>
      ) : (
        <div style={{ width: '100%', aspectRatio: '16 / 9', background: '#0f0f1a', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e9a23b', fontSize: 11, textAlign: 'center', padding: 12, marginBottom: 8 }}>
          源视频不可用，无法在画布上涂抹（请确认素材已正确导入且路径有效）
        </div>
      )}

      {/* 帧导航 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
        <button style={S.btn} disabled={currentFrame <= 0 || frameCount <= 1} onClick={() => onFrameChange(Math.max(0, currentFrame - 1))}>上一帧</button>
        <input type="range" min={0} max={maxFrame} step={1} value={currentFrame}
          onChange={(e) => onFrameChange(parseInt(e.target.value) || 0)}
          style={{ flex: 1, accentColor: '#e94560' }} />
        <button style={S.btn} disabled={currentFrame >= maxFrame || frameCount <= 1} onClick={() => onFrameChange(Math.min(maxFrame, currentFrame + 1))}>下一帧</button>
      </div>
      <div style={{ color: '#aaa', fontSize: 11, marginBottom: 6 }}>
        帧 {currentFrame} / {maxFrame}{savedGuide ? '   ● 已涂' : ''}
      </div>
      {guidesRef.current.size > 0 && (
        <div style={{ color: '#8895b3', fontSize: 10, marginBottom: 6, lineHeight: 1.4 }}>
          已采集 {guidesRef.current.size} 帧：{Array.from(guidesRef.current.keys()).sort((a, b) => a - b).join(', ')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
        <button style={S.btn} onClick={() => onCapture(currentFrame, canvasRef.current?.toDataURL('image/png') || '')}>捕获当前帧</button>
        <button style={S.btn} disabled={!savedGuide} onClick={() => onClearFrame(currentFrame)}>清空当前帧</button>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
        <button style={btn(brush === 'fg')} onClick={() => setBrush('fg')}>前景</button>
        <button style={btn(brush === 'bg')} onClick={() => setBrush('bg')}>背景</button>
        <button style={btn(brush === 'erase')} onClick={() => setBrush('erase')}>橡皮</button>
        <button style={S.btn} onClick={undo}>撤销</button>
      </div>
      <div style={{ ...S.row, marginBottom: 8 }}>
        <span style={S.label}>笔刷</span>
        <input type="range" min={4} max={80} step={1} value={brushSize}
          onChange={(e) => setBrushSize(parseInt(e.target.value) || 22)}
          style={{ flex: 1, accentColor: '#e94560' }} />
        <span style={{ color: '#eee', fontSize: 11, width: 28 }}>{brushSize}</span>
      </div>
    </div>
  );
}

export default function KeyingTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const project = useProjectStore((s) => s.project);

  const keying = clip.keying || null;
  const srcAsset = project.assets.find((a) => a.id === clip.assetId);

  const commit = (next: KeyingConfig | undefined) => updateClip(trackId, clip.id, { keying: next });
  const commitLive = (next: KeyingConfig) => updateClipLive(trackId, clip.id, { keying: next });

  // 智能/手动抠像（P1/P2）专属状态：处理中 + 错误提示 + 实时进度
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<KeyingProgress | null>(null);
  const paintCanvasRef = useRef<HTMLCanvasElement>(null);

  // 订阅抠像进度/错误事件（与 SRTab 同范式：挂载时注册，组件生命周期内持续生效）
  useEffect(() => {
    window.aicut.keying.onProgress((p: KeyingProgress) => setProgress(p));
    window.aicut.keying.onError((err: string) => setError(err));
  }, []);

  // 逐帧 refine（前端）：按帧采集 guide 并打包成 guides 数组
  const guidesRef = useRef<Map<number, string>>(new Map()); // frameIndex -> dataURL
  const [currentFrame, setCurrentFrame] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [guidesVersion, setGuidesVersion] = useState(0); // 触发已采集帧提示刷新
  const videoRef = useRef<HTMLVideoElement>(null);
  const fps = srcAsset?.fps ?? 30;

  // 拿到视频元数据后计算总帧数
  useEffect(() => {
    const dur = srcAsset?.duration ?? 0;
    setFrameCount(Math.max(1, Math.round(dur * (srcAsset?.fps ?? 30))));
  }, [srcAsset?.duration, srcAsset?.fps, srcAsset?.id]);

  const handleCapture = (f: number, url: string) => { guidesRef.current.set(f, url); setGuidesVersion((v) => v + 1); };
  const handleClearFrame = (f: number) => {
    guidesRef.current.delete(f);
    const c = paintCanvasRef.current;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setGuidesVersion((v) => v + 1);
  };

  // 未启用：提供一键开启（用默认 chroma 配置）
  if (!keying) {
    return (
      <div>
        <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 12 }}>本片段未启用抠像</div>
        <button style={{ ...S.btn, width: '100%' }} onClick={() => { pushHistorySnapshot(); commit(createDefaultKeying()); }}>
          + 开启抠像
        </button>
      </div>
    );
  }

  const disabled = !keying.enabled; // 整体禁用态：关闭抠像时所有参数置灰

  const setField = (patch: Partial<KeyingConfig>, live = false) => {
    const next = { ...keying, ...patch };
    if (live) commitLive(next);
    else { pushHistorySnapshot(); commit(next); }
  };

  const toggleEnabled = () => setField({ enabled: !keying.enabled });
  const selectMode = (mode: KeyingMode) => setField({ mode });
  const setColor = (color: string) => setField({ color }, true);
  const onEyedropper = async () => {
    const c = await pickColorWithEyedropper();
    if (c) setField({ color: c });
  };

  // ── 背景合成（P3）：抠出主体后，在透明区背后铺背景 ──
  const bg = keying.background;
  const bgType = bg?.type || 'none';
  const bgColor = bg?.color || '#000000';
  const bgAssetId = bg?.assetId;
  const bgAsset = bgAssetId ? project.assets.find((a) => a.id === bgAssetId) : undefined;
  const setBgType = (type: BackgroundType) => {
    const cur: KeyingBackground = bg || { type: 'none' };
    pushHistorySnapshot();
    commit({ ...keying, background: { ...cur, type } });
  };
  const setBgColor = (color: string) => {
    const cur: KeyingBackground = bg || { type: 'none' };
    pushHistorySnapshot();
    commit({ ...keying, background: { ...cur, type: (cur.type || 'color') as 'color', color } });
  };
  const pickBgColor = async () => {
    const c = await pickColorWithEyedropper();
    if (c) setBgColor(c);
  };
  const pickBackground = async () => {
    if (processing) return;
    const type = bgType === 'image' ? 'image' : 'video';
    const paths: string[] = await (window as unknown as { aicut: { openFiles(): Promise<string[]> } }).aicut.openFiles();
    if (!paths || paths.length === 0) return;
    const path = paths[0];
    let info: { duration?: number; width?: number; height?: number; codec?: string; fps?: number } = {};
    try {
      const probe = (window as unknown as { aicut: { probe(p: string): Promise<{ info?: typeof info }> } }).aicut.probe(path);
      info = (await probe)?.info || {};
    } catch { /* 探测失败用默认值 */ }
    const store = useProjectStore.getState();
    const assetId = uid('asset');
    store.addAsset({
      id: assetId, type, path,
      duration: info.duration || 5, width: info.width || 1920, height: info.height || 1080,
      codec: info.codec || 'h264', fps: info.fps || 30,
    });
    const cur: KeyingBackground = bg || { type: 'none' };
    pushHistorySnapshot();
    commit({ ...keying, background: { ...cur, type, assetId, color: cur.color || '#000000' } });
  };

  // 共享：matte 阈值 / 边缘柔化滑块（smart 与 manual 复用；预览/导出均依此曲线）
  // 注意：此处 edgeSoftness 作用于「已生成蒙版」的软硬过渡，与色度模式的边缘柔化语义不同（见下方 Hint）。
  const MatteAdjust = (
    <div key="matte-adjust">
      <ParamSlider label="阈值" value={keying.threshold ?? 0.5} min={0} max={1} step={0.01} unit="%" editable disabled={disabled}
        onChange={(v) => setField({ threshold: v }, true)} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="边缘柔化" value={keying.edgeSoftness ?? 0} min={0} max={1} step={0.01} unit="%" editable disabled={disabled}
        onChange={(v) => setField({ edgeSoftness: v }, true)} onEditStart={pushHistorySnapshot} />
      <Hint>柔化蒙版（前景/背景）边缘过渡带宽</Hint>
    </div>
  );

  // 智能抠像：取源素材真实路径 → 调 IPC 生成蒙版 → 注册素材 + 回写 keying.matteAssetId
  const runSmartKeying = async () => {
    if (processing) return;
    const store = useProjectStore.getState();
    const asset = store.project.assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.path) {
      alert('找不到源素材路径，无法执行智能抠像');
      return;
    }
    // 一键补全：缺失 Python 运行时 / 模型时引导下载，用户取消则中止
    if (!(await useAssetStore.getState().ensureAssets(['python', 'modnet', 'rmbg2']))) return;
    const assetPath = asset.path;            // 真实文件系统路径（非 aicut-asset://）
    const model = keying.model ?? 'modnet';
    const threshold = keying.threshold ?? 0.5;
    const output = matteOutputPath(assetPath); // 绝对路径 <stem>_matte.mp4
    setError(null);
    setProgress(null);
    setProcessing(true);
    try {
      // 结构变更：先压一次历史快照（生成会 addAsset + updateClip，二者内部亦各压快照）
      pushHistorySnapshot();
      // 与 speech:* 一致的 IPC 契约：handler 返回 { success, data, error } 对象，
      // 不可对返回值再做 JSON.parse（否则会得到 "[object Object]" is not valid JSON）。
      const res = await window.aicut.keying.generate(
        assetPath,
        JSON.stringify({ mode: 'matte', model, threshold, fps: asset.fps ?? 30, output })
      );
      if (!res?.success) throw new Error(res?.error || '智能抠像失败');
      const result = (res.data ?? {}) as { error?: string; mattePath: string; duration: number; width: number; height: number; fps: number };
      if (result.error) throw new Error(result.error);
      const assetId = uid('asset');
      store.addAsset({
        id: assetId, type: 'video', path: result.mattePath,
        duration: result.duration, width: result.width, height: result.height, fps: result.fps,
      });
      store.updateClip(trackId, clip.id, {
        keying: { ...keying, mode: 'smart', model, threshold, edgeSoftness: 1.0, matteAssetId: assetId },
      });
    } catch (e: unknown) {
      console.error('智能抠像失败', e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      alert('智能抠像失败：' + msg);
    } finally {
      setProcessing(false);
    }
  };

  // 手动抠像：取画布 guide（data URL）→ 调 IPC 生成蒙版（可基于已有智能蒙版修正）
  const runManualKeying = async () => {
    if (processing) return;
    const store = useProjectStore.getState();
    const asset = store.project.assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.path) {
      alert('找不到源素材路径，无法执行手动抠像');
      return;
    }
    // 一键补全：缺失 Python 运行时 / 模型时引导下载，用户取消则中止
    if (!(await useAssetStore.getState().ensureAssets(['python', 'modnet', 'rmbg2']))) return;
    const assetPath = asset.path;
    const model = keying.model ?? 'modnet';
    const threshold = keying.threshold ?? 0.5;
    const softness = keying.edgeSoftness ?? 1.0;
    // 已有蒙版则在其上修正
    let smartMattePath = '';
    if (keying.matteAssetId) {
      const ma = store.project.assets.find((a) => a.id === keying.matteAssetId);
      if (ma && ma.path) smartMattePath = ma.path;
    }
    const guides = Array.from(guidesRef.current.entries()).map(([frame, dataUrl]) => ({ frame, dataUrl }));
    if (guides.length === 0) {
      alert('请至少在当前帧涂抹并点击「捕获当前帧」');
      return;
    }
    const base = matteOutputPath(assetPath).replace(/_matte\.mp4$/, '');
    const output = `${base}_manual_matte.mp4`;
    setError(null);
    setProgress(null);
    setProcessing(true);
    try {
      pushHistorySnapshot();
      const res = await window.aicut.keying.generate(
        assetPath,
        JSON.stringify({ mode: 'manual', guides, smartMattePath, threshold, softness, fps: asset.fps ?? 30, output })
      );
      if (!res?.success) throw new Error(res?.error || '手动抠像失败');
      const result = (res.data ?? {}) as { error?: string; mattePath: string; duration: number; width: number; height: number; fps: number };
      if (result.error) throw new Error(result.error);
      const assetId = uid('asset');
      store.addAsset({
        id: assetId, type: 'video', path: result.mattePath,
        duration: result.duration, width: result.width, height: result.height, fps: result.fps,
      });
      store.updateClip(trackId, clip.id, {
        keying: { ...keying, mode: 'manual', model, threshold, edgeSoftness: softness, matteAssetId: assetId },
      });
    } catch (e: unknown) {
      console.error('手动抠像失败', e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      alert('手动抠像失败：' + msg);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>启用</span>
        <ToggleBtn active={keying.enabled} onClick={toggleEnabled}>{keying.enabled ? '已开启' : '已关闭'}</ToggleBtn>
        {disabled && <span style={{ color: '#8895b3', fontSize: 10, marginLeft: 4 }}>（参数已锁定）</span>}
        <button style={{ ...S.btn, marginLeft: 'auto', color: '#e94560' }} onClick={() => { pushHistorySnapshot(); commit(undefined); }}>移除</button>
      </div>

      <div style={S.divider} />

      {/* 模式选择 */}
      <SectionTitle>抠像模式</SectionTitle>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {MODES.map((m) => (
          <ToggleBtn key={m.value} active={keying.mode === m.value} onClick={() => selectMode(m.value)}>{m.label}</ToggleBtn>
        ))}
      </div>

      {/* 色度参数 */}
      {keying.mode === 'chroma' && (
        <div>
          <SectionTitle>键色与吸管</SectionTitle>
          <ColorRow label="键色" value={keying.color} onChange={setColor} onPick={onEyedropper} disabled={disabled} />

          <div style={S.divider} />

          <SectionTitle>色度参数</SectionTitle>
          <ParamSlider label="相似度" value={keying.similarity} min={0} max={1} step={0.01} unit="%" editable disabled={disabled}
            onChange={(v) => setField({ similarity: v }, true)} onEditStart={pushHistorySnapshot} />
          <ParamSlider label="边缘柔化" value={keying.edgeSoftness} min={0} max={1} step={0.01} unit="%" editable disabled={disabled}
            onChange={(v) => setField({ edgeSoftness: v }, true)} onEditStart={pushHistorySnapshot} />
          <Hint>按颜色距离羽化抠像边缘的宽度</Hint>
          <ParamSlider label="溢出抑制" value={keying.spill} min={0} max={1} step={0.01} unit="%" editable disabled={disabled}
            onChange={(v) => setField({ spill: v }, true)} onEditStart={pushHistorySnapshot} />
        </div>
      )}

      {/* 智能抠像（P1）专属 UI */}
      {keying.mode === 'smart' && (
        <div>
          <SectionTitle>智能抠像</SectionTitle>
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>
            调用本地模型推理蒙版视频，仅预览/导出时应用阈值与柔化曲线。
          </div>

          <div style={S.row}>
            <span style={S.label}>模型</span>
            <select value={keying.model ?? 'modnet'} disabled={disabled || processing}
              onChange={(e) => setField({ model: e.target.value as 'modnet' | 'rmbg2' })}
              style={{ flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, opacity: disabled ? 0.5 : 1 }}>
              <option value="modnet">modnet（MODNet）</option>
              <option value="rmbg2">rmbg2（BRIA RMBG-2.0）</option>
            </select>
          </div>

          {keying.matteAssetId ? (
            <div style={{ color: '#7CFC9A', fontSize: 11, marginBottom: 8 }}>已生成蒙版，可重新生成</div>
          ) : (
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>尚未生成蒙版，点击下方按钮开始推理</div>
          )}

          {keying.matteAssetId && MatteAdjust}

          {processing && <KeyingProgressBar p={progress} />}

          <GenerateButton processing={processing} disabled={disabled} onClick={runSmartKeying}>
            {processing ? '智能抠像处理中…' : (keying.matteAssetId ? '重新生成蒙版' : '开始智能抠像')}
          </GenerateButton>

          {error && (
            <div style={{ color: '#e9a23b', fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>错误：{error}</div>
          )}
        </div>
      )}

      {/* 手动抠像（P2）专属 UI */}
      {keying.mode === 'manual' && (
        <div>
          <SectionTitle>手动抠像</SectionTitle>
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>
            在画布上涂抹——前景（白）保留、背景（黑）去除；生成后叠加到预览。
            {keying.matteAssetId ? '当前基于已有蒙版修正边缘。' : '建议先做智能抠像，再手动修补边缘。'}
          </div>

          <ManualPaintCanvas
            videoPath={srcAsset?.path ? pathToUrl(srcAsset.path) : undefined}
            canvasRef={paintCanvasRef}
            videoRef={videoRef}
            currentFrame={currentFrame}
            fps={fps}
            frameCount={frameCount}
            onFrameChange={setCurrentFrame}
            savedGuide={guidesRef.current.get(currentFrame) ?? null}
            onCapture={handleCapture}
            onClearFrame={handleClearFrame}
            guidesRef={guidesRef}
          />

          {keying.matteAssetId ? (
            <div style={{ color: '#7CFC9A', fontSize: 11, marginBottom: 8 }}>已生成蒙版，可重新涂抹后生成</div>
          ) : (
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>尚未生成蒙版，涂抹后点击下方按钮</div>
          )}

          {keying.matteAssetId && MatteAdjust}

          {processing && <KeyingProgressBar p={progress} />}

          <GenerateButton processing={processing} disabled={disabled} onClick={runManualKeying}>
            {processing ? '处理中…' : (keying.matteAssetId ? '重新生成蒙版' : '生成蒙版')}
          </GenerateButton>

          {error && (
            <div style={{ color: '#e9a23b', fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>错误：{error}</div>
          )}
        </div>
      )}

      <div style={S.divider} />

      {/* 背景合成（P3） */}
      <SectionTitle>背景合成</SectionTitle>
      <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>
        抠出主体后，在透明区背后铺背景（纯色 / 图片 / 视频）。
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
        {BG_TYPES.map((b) => (
          <ToggleBtn key={b.value} active={bgType === b.value} disabled={disabled} onClick={() => setBgType(b.value as BackgroundType)}>{b.label}</ToggleBtn>
        ))}
      </div>

      {bgType === 'color' && (
        <ColorRow label="颜色" value={bgColor} onChange={setBgColor} onPick={pickBgColor} disabled={disabled} />
      )}

      {(bgType === 'image' || bgType === 'video') && (
        <div>
          <button style={{ ...S.btn, width: '100%', opacity: disabled ? 0.5 : 1 }} onClick={pickBackground} disabled={disabled || processing}>
            {bgAssetId ? '重新选择背景素材' : `选择背景${bgType === 'image' ? '图片' : '视频'}`}
          </button>
          {bgAsset && (
            <div style={{ fontSize: 11, color: '#7CFC9A', marginTop: 6, wordBreak: 'break-all' }}>
              已选：{bgAsset.path}
            </div>
          )}
        </div>
      )}

      {bgType === 'none' && (
        <div style={{ fontSize: 11, color: '#888' }}>未启用背景（透明区显示下层或棋盘格）</div>
      )}
    </div>
  );
}
