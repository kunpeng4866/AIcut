// 视频超清增强面板（SRTab）：启用开关、放大倍数、效果强度、生成超清预览、原图/超分对比。
// 与 KeyingTab / BeautyTab 的区别：SR 是**导出级后处理**（整体提升分辨率），
// 无法进入 WebGPU 时间轴合成（见 src/sr.rs 架构说明），故这里不回写供预览管线消费的 mask 资产，
// 只注册超分产物资产供导出回引，并在本面板内用 srRender.renderSRCompare 做独立对比预览。
// 写入方式沿用现有范式：结构变更（启用/倍数/生成）走 updateClip（改前 pushHistorySnapshot），
//                       参数拖动（强度）走 updateClipLive。
import { useState, useRef, useEffect } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { uid } from '../../utils/clipFactories';
import type { ClipConfig, SRConfig } from '../../types';
import { renderSRCompare } from '../../utils/srRender';

// 复用面板配色（深色 #16213e / #0f3460 边框 / #e94560 强调）
const S = {
  row: { display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' } as const,
  select: { flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, minWidth: 0 } as const,
  btn: { background: '#0f3460', color: '#eee', border: '1px solid #1a1a2e', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' } as const,
  btnActive: { background: '#e94560', color: '#fff', border: '1px solid #e94560' } as const,
  label: { color: '#aaa', fontSize: 11, width: 54, flexShrink: 0 } as const,
  divider: { height: 1, background: '#0f3460', margin: '8px 0' } as const,
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: '#8895b3', fontSize: 11, fontWeight: 600, letterSpacing: 0.3, marginBottom: 8 }}>
      {children}
    </div>
  );
}

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
  const fmt = (v: number) => unit === '%' ? `${Math.round(v * 100)}%` : v.toFixed(2);
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

// 生成按钮：与 KeyingTab / BeautyTab 一致的外观与禁用态
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

// 由源素材真实路径推导超分输出路径：<目录>/<stem>_sr.mp4（绝对路径，Windows 用正斜杠）
// 目录/文件名解析逻辑复制自 KeyingTab.matteOutputPath，仅把后缀换成 _sr.mp4。
function srOutputPath(assetPath: string): string {
  const idx = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
  const dir = idx >= 0 ? assetPath.slice(0, idx + 1) : '';
  const file = idx >= 0 ? assetPath.slice(idx + 1) : assetPath;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${dir}${stem}_sr.mp4`;
}

// 放大倍数（与 python/sr/inference.py 的 scale 语义一致）
const SCALES: { value: number; label: string }[] = [
  { value: 2, label: '2×' },
  { value: 3, label: '3×' },
  { value: 4, label: '4×' },
];

const DEFAULT_SR: SRConfig = { enabled: false, scale: 2, strength: 1.0 };

export default function SRTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const project = useProjectStore((s) => s.project);

  const sr = clip.superResolution || null;
  const srcAsset = project.assets.find((a) => a.id === clip.assetId);
  // 已生成的超分产物（工程重开后也能恢复对比预览）
  const srAsset = sr?.assetId ? project.assets.find((a) => a.id === sr.assetId) : undefined;

  const commit = (next: SRConfig | undefined) => updateClip(trackId, clip.id, { superResolution: next });
  const commitLive = (next: SRConfig) => updateClipLive(trackId, clip.id, { superResolution: next });

  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 本次生成的产物信息（用于展示耗时/分辨率等，生成后才有）
  const [lastResult, setLastResult] = useState<{ width?: number; height?: number; frames?: number; elapsedSec?: number; provider?: string; encoder?: string } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const originalPath = srcAsset?.path ?? '';
  const srPath = srAsset?.path ?? '';

  // 对比预览：两路径齐备时挂载，路径变化或卸载时执行 cleanup（释放两个 video 的解码器）
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !originalPath || !srPath) return;
    const dispose = renderSRCompare(el, originalPath, srPath);
    return dispose;
  }, [originalPath, srPath]);

  // 未启用：一键开启（默认 2× / 强度 1.0）
  if (!sr) {
    return (
      <div>
        <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 12 }}>本片段未启用超清增强</div>
        <button style={{ ...S.btn, width: '100%' }} onClick={() => { pushHistorySnapshot(); commit({ ...DEFAULT_SR }); }}>
          + 开启超清增强
        </button>
      </div>
    );
  }

  const disabled = !sr.enabled; // 整体禁用态：关闭超清增强时所有参数置灰

  const setField = (patch: Partial<SRConfig>, live = false) => {
    const next = { ...sr, ...patch };
    if (live) commitLive(next);
    else { pushHistorySnapshot(); commit(next); }
  };

  const toggleEnabled = () => setField({ enabled: !sr.enabled });

  // 生成超清预览：取源素材真实路径 → 调 IPC 逐帧超分 → 注册产物资产 + 回写 superResolution.assetId
  const runGenerate = async () => {
    if (processing) return;
    const store = useProjectStore.getState();
    const asset = store.project.assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.path) {
      alert('找不到源素材路径，无法生成超清视频');
      return;
    }
    const assetPath = asset.path;              // 真实文件系统路径（非 aicut-asset://）
    const scale = sr.scale ?? 2;
    const strength = sr.strength ?? 1.0;
    const output = srOutputPath(assetPath);    // 绝对路径 <stem>_sr.mp4
    setError(null);
    setProcessing(true);
    try {
      // 结构变更：先压一次历史快照（生成会 addAsset + updateClip，二者内部亦各压快照）
      pushHistorySnapshot();
      // 与 keying:* / beauty:* 一致的 IPC 契约：handler 返回 { success, data, error } 对象，
      // 不可对返回值再做 JSON.parse（否则会得到 "[object Object]" is not valid JSON）。
      // opts 字段名用 snake_case，与 python/sr/bridge.py 的 opts 约定对齐。
      const res = await (window as unknown as { aicut: { sr: { generate(p: string, cfg: string): Promise<{ success?: boolean; error?: string; data?: unknown }> } } }).aicut.sr.generate(
        assetPath,
        JSON.stringify({
          scale,
          strength,
          output_path: output,
          encoder: 'nvenc',
          ...(sr.modelPath ? { model_path: sr.modelPath } : {}),
        })
      );
      if (!res?.success) throw new Error(res?.error || '超清增强失败');
      // bridge.py 返回：{ ok, output_path, frames, width, height, fps, duration, scale, provider, encoder, elapsed_sec, ... }
      const result = (res.data ?? {}) as {
        ok?: boolean; error?: string; output_path?: string;
        frames?: number; width?: number; height?: number; fps?: number; duration?: number;
        provider?: string; encoder?: string; elapsed_sec?: number;
      };
      if (result.error) throw new Error(result.error);
      const outPath = result.output_path || output;
      const assetId = uid('asset');
      store.addAsset({
        id: assetId, type: 'video', path: outPath,
        duration: result.duration, width: result.width, height: result.height, fps: result.fps,
      });
      store.updateClip(trackId, clip.id, {
        superResolution: { ...sr, enabled: true, scale, strength, assetId },
      });
      setLastResult({
        width: result.width, height: result.height, frames: result.frames,
        elapsedSec: result.elapsed_sec, provider: result.provider, encoder: result.encoder,
      });
    } catch (e: unknown) {
      console.error('超清增强失败', e);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      alert('超清增强失败：' + msg);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>启用</span>
        <ToggleBtn active={sr.enabled} onClick={toggleEnabled}>{sr.enabled ? '已开启' : '已关闭'}</ToggleBtn>
        {disabled && <span style={{ color: '#8895b3', fontSize: 10, marginLeft: 4 }}>（参数已锁定）</span>}
        <button style={{ ...S.btn, marginLeft: 'auto', color: '#e94560' }} onClick={() => { pushHistorySnapshot(); commit(undefined); }}>移除</button>
      </div>

      <div style={S.divider} />

      <SectionTitle>超清参数</SectionTitle>
      <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>
        逐帧本地模型推理放大分辨率。属导出级后处理，不参与时间轴实时合成，仅在下方对比预览中查看效果。
      </div>

      <div style={S.row}>
        <span style={S.label}>放大倍数</span>
        <select value={sr.scale} disabled={disabled || processing}
          onChange={(e) => setField({ scale: parseInt(e.target.value, 10) || 2 })}
          style={{ ...S.select, opacity: disabled ? 0.5 : 1 }}>
          {SCALES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      <Hint>输出分辨率 = 源分辨率 × 倍数；倍数越大耗时与显存占用越高</Hint>

      <ParamSlider label="强度" value={sr.strength} min={0} max={1} step={0.01} unit="%" editable disabled={disabled}
        onChange={(v) => setField({ strength: v }, true)} onEditStart={pushHistorySnapshot} />
      <Hint>超分结果与原图（双三次放大）的混合比例，100% = 全量超分</Hint>

      <div style={S.divider} />

      <SectionTitle>生成与对比</SectionTitle>
      {srAsset ? (
        <div style={{ color: '#7CFC9A', fontSize: 11, marginBottom: 8, wordBreak: 'break-all' }}>
          已生成超清视频：{srAsset.path}
        </div>
      ) : (
        <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8 }}>尚未生成超清视频，点击下方按钮开始推理</div>
      )}

      <GenerateButton processing={processing} disabled={disabled || !srcAsset?.path} onClick={runGenerate}>
        {processing ? '超清增强处理中…' : (srAsset ? '重新生成超清视频' : '生成超清预览')}
      </GenerateButton>

      {processing && (
        <div style={{ color: '#8895b3', fontSize: 10, marginTop: 6, lineHeight: 1.4 }}>
          逐帧推理耗时较长（与时长、倍数、显卡相关），请勿关闭窗口。
        </div>
      )}

      {error && (
        <div style={{ color: '#e9a23b', fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>错误：{error}</div>
      )}

      {lastResult && (
        <div style={{ color: '#6b7794', fontSize: 10, marginTop: 8, lineHeight: 1.5 }}>
          输出 {lastResult.width ?? '—'}×{lastResult.height ?? '—'}
          {typeof lastResult.frames === 'number' ? ` · ${lastResult.frames} 帧` : ''}
          {typeof lastResult.elapsedSec === 'number' ? ` · 用时 ${lastResult.elapsedSec}s` : ''}
          {lastResult.provider ? ` · ${lastResult.provider}` : ''}
          {lastResult.encoder ? ` / ${lastResult.encoder}` : ''}
        </div>
      )}

      {originalPath && srPath ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ color: '#8895b3', fontSize: 11, fontWeight: 600, marginBottom: 6 }}>原图 / 超分对比</div>
          <div ref={previewRef} />
        </div>
      ) : (
        <div style={{ color: '#888', fontSize: 11, marginTop: 10 }}>
          生成后可在此左右拖动对比原图与超分效果。
        </div>
      )}
    </div>
  );
}
