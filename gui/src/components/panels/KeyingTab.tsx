// 抠像属性面板（KeyingTab）：启用开关、模式选择、键色（含吸管）、相似度、边缘柔化、溢出抑制。
// M1 仅 chroma 色度抠图有实际渲染管线；smart 为智能抠像（P1）分支，manual 为画笔手动抠像（P2）。
// 写入方式：结构变更（启用/模式/颜色/模型/生成）走 updateClip（拖前 pushHistorySnapshot），
//           参数拖动（阈值/柔化）走 updateClipLive。
import { useState, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { createDefaultKeying, uid } from '../../utils/clipFactories';
import type { ClipConfig, KeyingConfig, KeyingMode } from '../../types';

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

// 可复用参数滑块（拖动时走 live，拖前压一次历史快照）
function ParamSlider({ label, value, min, max, step, unit, editable, onChange, onEditStart }: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; editable?: boolean; onChange: (v: number) => void; onEditStart?: () => void;
}) {
  const fmt = (v: number) => unit === '%' ? `${Math.round(v * 100)}%` : unit === '°' ? `${Math.round(v)}°` : v.toFixed(2);
  let editing = false;
  const begin = () => { if (!editing) { editing = true; onEditStart?.(); } };
  const end = () => { editing = false; };
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, alignItems: 'center' }}>
        <span style={{ color: '#aaa', fontSize: 11 }}>{label}</span>
        {editable ? (
          <input type="number" value={value} min={min} max={max} step={step}
            onFocus={begin} onBlur={end}
            onChange={(e) => { begin(); onChange(parseFloat(e.target.value) || 0); }}
            style={{ width: 64, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '2px 4px', fontSize: 11 }} />
        ) : (
          <span style={{ color: '#eee', fontSize: 11 }}>{fmt(value)}</span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onPointerDown={begin} onPointerUp={end} onBlur={end}
        onChange={(e) => { begin(); onChange(parseFloat(e.target.value)); }}
        style={{ width: '100%', accentColor: '#e94560' }} />
    </div>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button style={{ ...S.btn, ...(active ? S.btnActive : {}) }} onClick={onClick}>{children}</button>;
}

const MODES: { value: KeyingMode; label: string }[] = [
  { value: 'chroma', label: '色度' },
  { value: 'smart', label: '智能' },
  { value: 'manual', label: '手动' },
];
const MODE_LABEL: Record<KeyingMode, string> = { chroma: '色度', smart: '智能', manual: '手动' };

// 浏览器原生吸管（Chrome/Edge 支持），失败则静默忽略
function pickColorWithEyedropper(): Promise<string | null> {
  const w = window as any;
  if (typeof w.EyeDropper === 'function') {
    try {
      const ed = new w.EyeDropper();
      return ed.open().then((r: any) => r?.sRGBHex ?? null).catch(() => null);
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
function ManualPaintCanvas({ videoPath, canvasRef }: { videoPath: string; canvasRef: React.RefObject<HTMLCanvasElement> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
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
  const clear = () => { const c = canvasRef.current; if (!c) return; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); };

  const btn = (active: boolean) => ({ ...S.btn, ...(active ? S.btnActive : {}) });
  return (
    <div>
      <div style={{ position: 'relative', width: '100%', aspectRatio: String(aspect), background: '#000', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
        <video ref={videoRef} src={videoPath} muted playsInline loop autoPlay
          onLoadedMetadata={setupCanvas}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
        <canvas ref={canvasRef}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', cursor: 'crosshair', touchAction: 'none' }} />
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
        <button style={btn(brush === 'fg')} onClick={() => setBrush('fg')}>前景</button>
        <button style={btn(brush === 'bg')} onClick={() => setBrush('bg')}>背景</button>
        <button style={btn(brush === 'erase')} onClick={() => setBrush('erase')}>橡皮</button>
        <button style={S.btn} onClick={undo}>撤销</button>
        <button style={S.btn} onClick={clear}>清空</button>
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
  const srcAsset = project.assets.find((a: any) => a.id === clip.assetId);

  const commit = (next: KeyingConfig | undefined) => updateClip(trackId, clip.id, { keying: next } as Partial<ClipConfig>);
  const commitLive = (next: KeyingConfig) => updateClipLive(trackId, clip.id, { keying: next } as Partial<ClipConfig>);

  // 智能/手动抠像（P1/P2）专属状态：处理中 + 错误提示
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paintCanvasRef = useRef<HTMLCanvasElement>(null);

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

  // k：P1/P2 新增字段（model/threshold/matteAssetId）尚未并入本仓库 types.ts（归属后端子代理），
  // 此处以局部 any 视图读取，避免改动共享类型契约文件。
  const k = keying as any;

  const setField = (patch: Partial<KeyingConfig>, live = false) => {
    const next = { ...keying, ...patch };
    if (live) commitLive(next);
    else { pushHistorySnapshot(); commit(next); }
  };
  // 智能抠像结构变更：强制 mode:'smart'，patch 含 P1 字段（model/threshold/matteAssetId）
  const setSmartField = (patch: any, live = false) => {
    const next: any = { ...keying, mode: 'smart', ...patch };
    if (live) updateClipLive(trackId, clip.id, { keying: next } as Partial<ClipConfig>);
    else { pushHistorySnapshot(); updateClip(trackId, clip.id, { keying: next } as Partial<ClipConfig>); }
  };
  const toggleEnabled = () => setField({ enabled: !keying.enabled });
  const selectMode = (mode: KeyingMode) => setField({ mode });
  const setColor = (color: string) => setField({ color }, true);
  const onEyedropper = async () => {
    const c = await pickColorWithEyedropper();
    if (c) setColor(c);
  };

  // 共享：matte 阈值 / 边缘柔化滑块（smart 与 manual 复用；预览/导出均依此曲线）
  const MatteAdjust = (
    <div key="matte-adjust">
      <ParamSlider label="阈值" value={k.threshold ?? 0.5} min={0} max={1} step={0.01} unit="%" editable
        onChange={(v) => updateClipLive(trackId, clip.id, { keying: { ...keying, mode: keying.mode, model: k.model ?? 'modnet', threshold: v, matteAssetId: k.matteAssetId } } as any)}
        onEditStart={pushHistorySnapshot} />
      <ParamSlider label="边缘柔化" value={k.edgeSoftness ?? 0} min={0} max={1} step={0.01} unit="%" editable
        onChange={(v) => updateClipLive(trackId, clip.id, { keying: { ...keying, mode: keying.mode, model: k.model ?? 'modnet', edgeSoftness: v, matteAssetId: k.matteAssetId } } as any)}
        onEditStart={pushHistorySnapshot} />
    </div>
  );

  // 智能抠像：取源素材真实路径 → 调 IPC 生成蒙版 → 注册素材 + 回写 keying.matteAssetId
  const runSmartKeying = async () => {
    if (processing) return;
    const store = useProjectStore.getState();
    const asset = store.project.assets.find((a: any) => a.id === clip.assetId);
    if (!asset || !asset.path) {
      alert('找不到源素材路径，无法执行智能抠像');
      return;
    }
    const assetPath = asset.path;            // 真实文件系统路径（非 aicut-asset://）
    const model = k.model ?? 'modnet';
    const threshold = k.threshold ?? 0.5;
    const output = matteOutputPath(assetPath); // 绝对路径 <stem>_matte.mp4
    setError(null);
    setProcessing(true);
    try {
      // 结构变更：先压一次历史快照（生成会 addAsset + updateClip，二者内部亦各压快照）
      pushHistorySnapshot();
      // 与 speech:* 一致的 IPC 契约：handler 返回 { success, data, error } 对象，
      // 不可对返回值再做 JSON.parse（否则会得到 "[object Object]" is not valid JSON）。
      const res: any = await (window as any).aicut.keying.generate(
        assetPath,
        JSON.stringify({ mode: 'matte', model, threshold, fps: asset.fps ?? 30, output })
      );
      if (!res?.success) throw new Error(res?.error || '智能抠像失败');
      const result = (res.data ?? {}) as any;
      if (result.error) throw new Error(result.error);
      const assetId = uid('asset');
      store.addAsset({
        id: assetId, type: 'video', path: result.mattePath,
        duration: result.duration, width: result.width, height: result.height, fps: result.fps,
      });
      store.updateClip(trackId, clip.id, {
        keying: { ...keying, mode: 'smart', model, threshold, matteAssetId: assetId },
      } as any);
    } catch (e: any) {
      console.error('智能抠像失败', e);
      const msg = e?.message || String(e);
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
    const asset = store.project.assets.find((a: any) => a.id === clip.assetId);
    if (!asset || !asset.path) {
      alert('找不到源素材路径，无法执行手动抠像');
      return;
    }
    const assetPath = asset.path;
    const model = k.model ?? 'modnet';
    const threshold = k.threshold ?? 0.5;
    const softness = k.edgeSoftness ?? 0.1;
    // 已有蒙版则在其上修正
    let smartMattePath = '';
    if (k.matteAssetId) {
      const ma = store.project.assets.find((a: any) => a.id === k.matteAssetId);
      if (ma && ma.path) smartMattePath = ma.path;
    }
    const guide = paintCanvasRef.current?.toDataURL('image/png') || '';
    if (!guide) {
      alert('请先在画布上涂抹前景/背景');
      return;
    }
    const base = matteOutputPath(assetPath).replace(/_matte\.mp4$/, '');
    const output = `${base}_manual_matte.mp4`;
    setError(null);
    setProcessing(true);
    try {
      pushHistorySnapshot();
      const res: any = await (window as any).aicut.keying.generate(
        assetPath,
        JSON.stringify({ mode: 'manual', guide, smartMattePath, threshold, softness, fps: asset.fps ?? 30, output })
      );
      if (!res?.success) throw new Error(res?.error || '手动抠像失败');
      const result = (res.data ?? {}) as any;
      if (result.error) throw new Error(result.error);
      const assetId = uid('asset');
      store.addAsset({
        id: assetId, type: 'video', path: result.mattePath,
        duration: result.duration, width: result.width, height: result.height, fps: result.fps,
      });
      store.updateClip(trackId, clip.id, {
        keying: { ...keying, mode: 'manual', model, threshold, edgeSoftness: softness, matteAssetId: assetId },
      } as any);
    } catch (e: any) {
      console.error('手动抠像失败', e);
      const msg = e?.message || String(e);
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
        <button style={{ ...S.btn, marginLeft: 'auto', color: '#e94560' }} onClick={() => { pushHistorySnapshot(); commit(undefined); }}>移除</button>
      </div>

      <div style={S.divider} />

      {/* 模式选择 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {MODES.map((m) => (
          <ToggleBtn key={m.value} active={keying.mode === m.value} onClick={() => selectMode(m.value)}>{m.label}</ToggleBtn>
        ))}
      </div>

      {/* 键色 + 吸管（仅 chroma 相关） */}
      {keying.mode === 'chroma' && (
        <>
          <div style={S.row}>
            <span style={S.label}>键色</span>
            <input type="color" value={keying.color} onChange={(e) => setColor(e.target.value)}
              style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
            <input type="text" value={keying.color} onChange={(e) => setColor(e.target.value)}
              style={{ flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, minWidth: 0 }} />
            <button style={S.btn} onClick={onEyedropper} title="屏幕取色">吸管</button>
          </div>

          <div style={S.divider} />

          {/* 色度参数 */}
          <ParamSlider label="相似度" value={keying.similarity} min={0} max={1} step={0.01} unit="%" editable
            onChange={(v) => setField({ similarity: v }, true)} onEditStart={pushHistorySnapshot} />
          <ParamSlider label="边缘柔化" value={keying.edgeSoftness} min={0} max={1} step={0.01} unit="%" editable
            onChange={(v) => setField({ edgeSoftness: v }, true)} onEditStart={pushHistorySnapshot} />
          <ParamSlider label="溢出抑制" value={keying.spill} min={0} max={1} step={0.01} unit="%" editable
            onChange={(v) => setField({ spill: v }, true)} onEditStart={pushHistorySnapshot} />
        </>
      )}

      {/* 智能抠像（P1）专属 UI */}
      {keying.mode === 'smart' && (
        <div>
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>
            P1 智能抠像：调用本地模型推理蒙版视频，仅预览/导出时应用阈值与柔化曲线。
          </div>

          {/* 模型选择 */}
          <div style={S.row}>
            <span style={S.label}>模型</span>
            <select value={k.model ?? 'modnet'} disabled={processing}
              onChange={(e) => setSmartField({ model: e.target.value })}
              style={{ flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11 }}>
              <option value="modnet">modnet</option>
              <option value="rmbg2" disabled>rmbg2（敬请期待）</option>
            </select>
          </div>

          {k.matteAssetId ? (
            <div style={{ color: '#7CFC9A', fontSize: 11, marginBottom: 8 }}>已生成蒙版，可重新生成</div>
          ) : (
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>尚未生成蒙版，点击下方按钮开始推理</div>
          )}

          {k.matteAssetId && MatteAdjust}

          <button style={{ ...S.btn, width: '100%', background: '#e94560', color: '#fff', border: '1px solid #e94560' }}
            disabled={processing}
            onClick={runSmartKeying}>
            {processing ? '智能抠像处理中…' : (k.matteAssetId ? '重新生成蒙版' : '开始智能抠像')}
          </button>

          {error && (
            <div style={{ color: '#e9a23b', fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>错误：{error}</div>
          )}
        </div>
      )}

      {/* 手动抠像（P2）专属 UI */}
      {keying.mode === 'manual' && (
        <div>
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>
            P2 手动抠像：在画布上涂抹——前景（白）保留、背景（黑）去除；生成后叠加到预览。
            {k.matteAssetId ? '当前基于已有蒙版修正边缘。' : '建议先做智能抠像，再手动修补边缘。'}
          </div>

          {srcAsset?.path && (
            <ManualPaintCanvas videoPath={pathToUrl(srcAsset.path)} canvasRef={paintCanvasRef} />
          )}

          {k.matteAssetId ? (
            <div style={{ color: '#7CFC9A', fontSize: 11, marginBottom: 8 }}>已生成蒙版，可重新涂抹后生成</div>
          ) : (
            <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>尚未生成蒙版，涂抹后点击下方按钮</div>
          )}

          {k.matteAssetId && MatteAdjust}

          <button style={{ ...S.btn, width: '100%', background: '#e94560', color: '#fff', border: '1px solid #e94560' }}
            disabled={processing}
            onClick={runManualKeying}>
            {processing ? '处理中…' : (k.matteAssetId ? '重新生成蒙版' : '生成蒙版')}
          </button>

          {error && (
            <div style={{ color: '#e9a23b', fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>错误：{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
