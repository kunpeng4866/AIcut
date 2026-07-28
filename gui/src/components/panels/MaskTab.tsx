// 蒙版属性面板（MaskTab）：增删/排序蒙版、切换形状、编辑几何参数、反转、描边、阴影。
// 写入方式：结构变更走 updateClip（拖前 pushHistorySnapshot），参数拖动走 updateClipLive（live 系，避免每帧深拷贝）。
import { useState } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { uid } from '../../utils/clipFactories';
import { createDefaultMask, defaultMaskParams } from '../../utils/maskRender';
import type { ClipConfig, MaskConfig, MaskShape, MaskStroke, MaskShadow } from '../../types';

// 复用面板配色（深色 #16213e / #0f3460 边框 / #e94560 强调）
const S = {
  row: { display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' } as const,
  input: { flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, minWidth: 0 } as const,
  btn: { background: '#0f3460', color: '#eee', border: '1px solid #1a1a2e', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' } as const,
  btnActive: { background: '#e94560', color: '#fff', border: '1px solid #e94560' } as const,
  label: { color: '#aaa', fontSize: 11, width: 54, flexShrink: 0 } as const,
  item: { background: '#0f3460', borderRadius: 4, padding: 8, marginBottom: 6 } as const,
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

const SHAPES: { value: MaskShape; label: string }[] = [
  { value: 'rect', label: '矩形' },
  { value: 'circle', label: '圆形' },
  { value: 'linear', label: '线性' },
  { value: 'mirror', label: '镜面' },
];

const SHAPE_LABEL: Record<MaskShape, string> = { rect: '矩形', circle: '圆形', linear: '线性', mirror: '镜面' };

export default function MaskTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const masks = clip.masks || [];
  const [selectedId, setSelectedId] = useState<string | null>(masks[0]?.id ?? null);

  const commit = (next: MaskConfig[]) => updateClip(trackId, clip.id, { masks: next } as Partial<ClipConfig>);
  const commitLive = (next: MaskConfig[]) => updateClipLive(trackId, clip.id, { masks: next } as Partial<ClipConfig>);

  const addMask = () => {
    // MVP 收敛为单蒙版：多蒙版并集导出留 v2（避免预览并集/导出交集不一致）
    if (masks.length > 0) {
      alert('MVP 暂仅支持单个蒙版（多蒙版并集将于后续版本支持）');
      return;
    }
    const m = createDefaultMask('rect', uid('mask'));
    pushHistorySnapshot();
    const next = [m];
    commit(next);
    setSelectedId(m.id);
  };
  const removeMask = (id: string) => {
    pushHistorySnapshot();
    commit(masks.filter((m) => m.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const toggleEnabled = (id: string) => {
    pushHistorySnapshot();
    commit(masks.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)));
  };
  const selectShape = (id: string, shape: MaskShape) => {
    pushHistorySnapshot();
    commit(masks.map((m) => (m.id === id ? { ...m, shape, params: defaultMaskParams(shape) } : m)));
  };
  const setParam = (id: string, key: string, value: number) => {
    commitLive(masks.map((m) => (m.id === id ? { ...m, params: { ...m.params, [key]: value } } : m)));
  };
  const toggleInvert = (id: string) => {
    pushHistorySnapshot();
    commit(masks.map((m) => (m.id === id ? { ...m, invert: !m.invert } : m)));
  };
  // 描边 / 阴影 子对象更新
  const setStroke = (id: string, patch: Partial<MaskStroke>) => {
    commitLive(masks.map((m) => (m.id === id ? { ...m, stroke: { ...defaultStroke(), ...m.stroke, ...patch } } : m)));
  };
  const setShadow = (id: string, patch: Partial<MaskShadow>) => {
    commitLive(masks.map((m) => (m.id === id ? { ...m, shadow: { ...defaultShadow(), ...m.shadow, ...patch } } : m)));
  };

  const selected = masks.find((m) => m.id === selectedId) || null;

  return (
    <div>
      {/* 蒙版列表 */}
      <div style={{ marginBottom: 8 }}>
        {masks.length === 0 && <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 12 }}>暂无蒙版</div>}
        {masks.map((m, i) => (
          <div key={m.id} style={{ ...S.item, ...(selectedId === m.id ? { border: '1px solid #e94560' } : {}) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#eee', cursor: 'pointer' }} onClick={() => setSelectedId(m.id)}>
                #{i + 1} · {SHAPE_LABEL[m.shape]}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <ToggleBtn active={!!m.enabled} onClick={() => toggleEnabled(m.id)}>{m.enabled ? '开' : '关'}</ToggleBtn>
                <button style={S.btn} onClick={() => removeMask(m.id)}>×</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <button style={{ ...S.btn, width: '100%', marginBottom: 10 }} onClick={addMask}>+ 添加蒙版</button>

      {/* 选中蒙版编辑 */}
      {selected ? (
        <div>
          <div style={S.divider} />
          {/* 形状选择栏 */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {SHAPES.map((s) => (
              <ToggleBtn key={s.value} active={selected.shape === s.value} onClick={() => selectShape(selected.id, s.value)}>
                {s.label}
              </ToggleBtn>
            ))}
          </div>

          {/* 几何参数 */}
          <GeomParams mask={selected} onParam={(k, v) => setParam(selected.id, k, v)} onEditStart={pushHistorySnapshot} />

          {/* 反转 */}
          <div style={S.row}>
            <span style={S.label}>反转</span>
            <ToggleBtn active={selected.invert} onClick={() => toggleInvert(selected.id)}>{selected.invert ? '已反转' : '正常'}</ToggleBtn>
          </div>

          <div style={S.divider} />

          {/* 描边 */}
          <StrokeEditor mask={selected} onPatch={(p) => setStroke(selected.id, p)} />
          <div style={S.divider} />
          {/* 阴影 */}
          <ShadowEditor mask={selected} onPatch={(p) => setShadow(selected.id, p)} />
        </div>
      ) : (
        <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 12 }}>选择上方蒙版以编辑参数</div>
      )}
    </div>
  );
}

// 描边 / 阴影 默认值
function defaultStroke(): MaskStroke {
  return { enabled: false, color: '#ffffff', size: 0.02, opacity: 1, blur: 0 };
}
function defaultShadow(): MaskShadow {
  // 预览背景为纯黑 (#000)，纯黑阴影在黑底上不可见，因此默认使用灰蓝色光晕。
  // 用户仍可手动改为 #000000，此时在黑色预览背景下会融入背景（属预期）。
  return { enabled: false, color: '#7a8a9a', opacity: 0.75, blur: 0.05, distance: 0.05, angle: 135 };
}

// 几何参数（按形状显示）
function GeomParams({ mask, onParam, onEditStart }: { mask: MaskConfig; onParam: (k: string, v: number) => void; onEditStart: () => void }) {
  const p = mask.params || {};
  const num = (k: string, d = 0) => p[k] ?? d;
  if (mask.shape === 'rect') {
    return (
      <div>
        <ParamSlider label="X" value={num('x', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('x', v)} onEditStart={onEditStart} />
        <ParamSlider label="Y" value={num('y', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('y', v)} onEditStart={onEditStart} />
        <ParamSlider label="宽度" value={num('width', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('width', v)} onEditStart={onEditStart} />
        <ParamSlider label="高度" value={num('height', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('height', v)} onEditStart={onEditStart} />
        <ParamSlider label="旋转" value={num('rotation', 0)} min={-180} max={180} step={1} unit="°" editable onChange={(v) => onParam('rotation', v)} onEditStart={onEditStart} />
        <ParamSlider label="圆角" value={num('roundness', 0)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('roundness', v)} onEditStart={onEditStart} />
        <ParamSlider label="羽化" value={num('feather', 0)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('feather', v)} onEditStart={onEditStart} />
      </div>
    );
  }
  if (mask.shape === 'circle') {
    return (
      <div>
        <ParamSlider label="X" value={num('x', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('x', v)} onEditStart={onEditStart} />
        <ParamSlider label="Y" value={num('y', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('y', v)} onEditStart={onEditStart} />
        <ParamSlider label="半径" value={num('radius', 0.3)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('radius', v)} onEditStart={onEditStart} />
        <ParamSlider label="羽化" value={num('feather', 0)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('feather', v)} onEditStart={onEditStart} />
      </div>
    );
  }
  // linear / mirror
  return (
    <div>
      <ParamSlider label="X" value={num('x', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('x', v)} onEditStart={onEditStart} />
      <ParamSlider label="Y" value={num('y', 0.5)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('y', v)} onEditStart={onEditStart} />
      <ParamSlider label="角度" value={num('angle', 0)} min={-180} max={180} step={1} unit="°" editable onChange={(v) => onParam('angle', v)} onEditStart={onEditStart} />
      <ParamSlider label="宽度" value={num('width', 0.3)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('width', v)} onEditStart={onEditStart} />
      {mask.shape === 'mirror' && (
        <ParamSlider label="扩散" value={num('spread', 0.3)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('spread', v)} onEditStart={onEditStart} />
      )}
      <ParamSlider label="羽化" value={num('feather', 0)} min={0} max={1} step={0.01} editable onChange={(v) => onParam('feather', v)} onEditStart={onEditStart} />
    </div>
  );
}

function StrokeEditor({ mask, onPatch }: { mask: MaskConfig; onPatch: (p: Partial<MaskStroke>) => void }) {
  const st = mask.stroke || defaultStroke();
  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>描边</span>
        <ToggleBtn active={st.enabled} onClick={() => onPatch({ enabled: !st.enabled })}>{st.enabled ? '开' : '关'}</ToggleBtn>
      </div>
      {st.enabled && (
        <>
          <div style={S.row}>
            <span style={S.label}>颜色</span>
            <input type="color" value={st.color} onChange={(e) => onPatch({ color: e.target.value })}
              style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
          </div>
          <ParamSlider label="大小" value={st.size} min={0} max={0.1} step={0.002} editable onChange={(v) => onPatch({ size: v })} />
          <ParamSlider label="不透明" value={st.opacity} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => onPatch({ opacity: v })} />
          <ParamSlider label="模糊" value={st.blur} min={0} max={1} step={0.01} editable onChange={(v) => onPatch({ blur: v })} />
        </>
      )}
    </div>
  );
}

function ShadowEditor({ mask, onPatch }: { mask: MaskConfig; onPatch: (p: Partial<MaskShadow>) => void }) {
  const sh = mask.shadow || defaultShadow();
  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>阴影</span>
        <ToggleBtn active={sh.enabled} onClick={() => onPatch({ enabled: !sh.enabled })}>{sh.enabled ? '开' : '关'}</ToggleBtn>
      </div>
      {sh.enabled && (
        <>
          <div style={S.row}>
            <span style={S.label}>颜色</span>
            <input type="color" value={sh.color} onChange={(e) => onPatch({ color: e.target.value })}
              style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
          </div>
          <ParamSlider label="不透明" value={sh.opacity} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => onPatch({ opacity: v })} />
          <ParamSlider label="模糊" value={sh.blur} min={0} max={1} step={0.01} editable onChange={(v) => onPatch({ blur: v })} />
          <ParamSlider label="距离" value={sh.distance} min={0} max={1} step={0.01} editable onChange={(v) => onPatch({ distance: v })} />
          <ParamSlider label="角度" value={sh.angle} min={-180} max={180} step={1} unit="°" editable onChange={(v) => onPatch({ angle: v })} />
        </>
      )}
    </div>
  );
}
