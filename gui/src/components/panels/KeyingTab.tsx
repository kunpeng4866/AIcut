// 抠像属性面板（KeyingTab）：启用开关、模式选择、键色（含吸管）、相似度、边缘柔化、溢出抑制。
// M1 仅 chroma 色度抠图有实际渲染管线；smart/manual 为占位模式（选择器已呈现，预览回退原帧）。
// 写入方式：结构变更（启用/模式/颜色）走 updateClip（拖前 pushHistorySnapshot），参数拖动走 updateClipLive。
import { useProjectStore } from '../../store/projectStore';
import { createDefaultKeying } from '../../utils/clipFactories';
import type { ClipConfig, KeyingConfig, KeyingMode } from '../../types';

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

export default function KeyingTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);

  const keying = clip.keying || null;

  const commit = (next: KeyingConfig | undefined) => updateClip(trackId, clip.id, { keying: next } as Partial<ClipConfig>);
  const commitLive = (next: KeyingConfig) => updateClipLive(trackId, clip.id, { keying: next } as Partial<ClipConfig>);

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
    if (c) setColor(c);
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
      {keying.mode !== 'chroma' && (
        <div style={{ color: '#e9a23b', fontSize: 11, marginBottom: 8 }}>
          M1 仅「色度」模式有实时预览；{MODE_LABEL[keying.mode]} 为占位，预览将回退原帧。
        </div>
      )}

      {/* 键色 + 吸管（仅 chroma 相关） */}
      {keying.mode === 'chroma' && (
        <div style={S.row}>
          <span style={S.label}>键色</span>
          <input type="color" value={keying.color} onChange={(e) => setColor(e.target.value)}
            style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
          <input type="text" value={keying.color} onChange={(e) => setColor(e.target.value)}
            style={{ flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, minWidth: 0 }} />
          <button style={S.btn} onClick={onEyedropper} title="屏幕取色">吸管</button>
        </div>
      )}

      <div style={S.divider} />

      {/* 色度参数 */}
      {keying.mode === 'chroma' && (
        <>
          <ParamSlider label="相似度" value={keying.similarity} min={0} max={1} step={0.01} unit="%" editable
            onChange={(v) => setField({ similarity: v }, true)} onEditStart={pushHistorySnapshot} />
          <ParamSlider label="边缘柔化" value={keying.edgeSoftness} min={0} max={1} step={0.01} unit="%" editable
            onChange={(v) => setField({ edgeSoftness: v }, true)} onEditStart={pushHistorySnapshot} />
          <ParamSlider label="溢出抑制" value={keying.spill} min={0} max={1} step={0.01} unit="%" editable
            onChange={(v) => setField({ spill: v }, true)} onEditStart={pushHistorySnapshot} />
        </>
      )}
    </div>
  );
}
