// 属性面板 — 右侧面板，含变换/滤镜/特效/音频/关键帧 5 个标签页
import { useState, type ReactNode } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import type { ClipConfig, TransformConfig, TransitionConfig, TransitionType, TimeRemapConfig, FreezeConfig, SpeedPointConfig } from '../types';
import { SpeedCurveEditor } from './SpeedCurveEditor';

type TabKey = 'transform' | 'filters' | 'effects' | 'audio' | 'keyframes' | 'text' | 'subtitle' | 'speed' | 'transition';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'transform', label: '变换' },
  { key: 'filters', label: '滤镜' },
  { key: 'effects', label: '特效' },
  { key: 'audio', label: '音频' },
  { key: 'speed', label: '变速' },
  { key: 'transition', label: '转场' },
  { key: 'text', label: '文字' },
  { key: 'subtitle', label: '字幕' },
  { key: 'keyframes', label: '关键帧' },
];

// 滤镜预设
const FILTER_PRESETS = [
  { type: 'brightness_contrast', label: '亮度对比度', params: { brightness: 1, contrast: 1, saturation: 1 } },
  { type: 'blur', label: '模糊', params: { blur_radius: 5 } },
  { type: 'sharpen', label: '锐化', params: { amount: 0.5 } },
  { type: 'vignette', label: '暗角', params: { angle: 20, distance: 0.5 } },
  { type: 'hue', label: '色调', params: { hue: 0, saturation: 1 } },
];

// 特效预设
const EFFECT_PRESETS = [
  { type: 'flash', label: '闪光', params: { intensity: 0.5, speed: 1 } },
  { type: 'glitch', label: '故障', params: { amount: 0.3, speed: 1 } },
  { type: 'oldfilm', label: '老电影', params: { grain: 0.3, flicker: 0.5, sepia: 0.5 } },
  { type: 'edge', label: '边缘检测', params: { threshold: 0.5 } },
];

const EASINGS = ['线性', '缓入', '缓出', '缓入缓出'];
const KF_PROPS = [
  { key: 'x', label: '位置X' }, { key: 'y', label: '位置Y' },
  { key: 'scale', label: '缩放' }, { key: 'rotation', label: '旋转' },
  { key: 'opacity', label: '不透明度' }, { key: 'volume', label: '音量' },
];
const VOICE_TYPES = ['无', '男声', '女声', '机器人', '萝莉'];

// 扩展 TransformConfig 加镜像字段（运行期支持，类型补声明）
type TransformExt = TransformConfig & { flip_h?: number; flip_v?: number };

// 内联样式集
const S = {
  panel: { height: '100%', display: 'flex', flexDirection: 'column' as const, background: '#16213e', fontFamily: 'system-ui' },
  tabs: { display: 'flex', borderBottom: '1px solid #0f3460' },
  tab: (active: boolean) => ({
    flex: 1, padding: '8px 4px', fontSize: 11, color: active ? '#eee' : '#aaa',
    background: active ? '#1a1a2e' : 'transparent', border: 'none',
    borderBottom: active ? '2px solid #e94560' : '2px solid transparent', cursor: 'pointer',
  }),
  content: { flex: 1, overflow: 'auto', padding: 10, color: '#eee', fontSize: 12 },
  row: { display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' },
  input: { flex: 1, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '4px 6px', fontSize: 11, minWidth: 0 },
  btn: { background: '#0f3460', color: '#eee', border: '1px solid #1a1a2e', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' },
  btnActive: { background: '#e94560', color: '#fff', border: '1px solid #e94560' },
  label: { color: '#aaa', fontSize: 11, width: 60, flexShrink: 0 },
  item: { background: '#0f3460', borderRadius: 4, padding: 8, marginBottom: 6 },
  divider: { height: 1, background: '#0f3460', margin: '8px 0' },
};

// 可复用参数滑块；editable=true 时右侧显示可编辑数值输入框
function ParamSlider({ label, value, min, max, step, unit, editable, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; editable?: boolean; onChange: (v: number) => void;
}) {
  const fmt = (v: number) => unit === '%' ? `${Math.round(v * 100)}%` : unit === '°' ? `${Math.round(v)}°` : v.toFixed(2);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, alignItems: 'center' }}>
        <span style={{ color: '#aaa', fontSize: 11 }}>{label}</span>
        {editable ? (
          <input type="number" value={value} min={min} max={max} step={step}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            style={{ width: 64, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: '2px 4px', fontSize: 11 }} />
        ) : (
          <span style={{ color: '#eee', fontSize: 11 }}>{fmt(value)}</span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#e94560' }} />
    </div>
  );
}

// 切换按钮
function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button style={{ ...S.btn, ...(active ? S.btnActive : {}) }} onClick={onClick}>{children}</button>;
}

// 查找当前选中片段
function useSelectedClip(): { clip: ClipConfig; trackId: string } | null {
  const project = useProjectStore((s) => s.project);
  const selectedTrackId = useUIStore((s) => s.selectedTrackId);
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  if (!selectedTrackId || !selectedClipId) return null;
  for (const t of project.tracks) {
    if (t.id !== selectedTrackId) continue;
    const clip = t.clips.find((c) => c.id === selectedClipId);
    if (clip) return { clip, trackId: t.id };
  }
  return null;
}

// 变换标签页
function TransformTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateTransform = useProjectStore((s) => s.updateTransform);
  const updateClip = useProjectStore((s) => s.updateClip);
  const t = (clip.transform || {}) as TransformExt;
  const [lockScale, setLockScale] = useState(true);
  const set = (k: keyof TransformConfig, v: number) => updateTransform(trackId, clip.id, k, v);
  const setScale = (axis: 'scale_x' | 'scale_y', v: number) => {
    set(axis, v);
    if (lockScale) set(axis === 'scale_x' ? 'scale_y' : 'scale_x', v);
  };
  const toggleFlip = (axis: 'h' | 'v') => {
    const key = axis === 'h' ? 'flip_h' : 'flip_v';
    updateClip(trackId, clip.id, { transform: { ...t, [key]: t[key] ? 0 : 1 } });
  };
  return (
    <div>
      <ParamSlider label="位置 X" value={t.x ?? 0} min={0} max={1} step={0.01} editable onChange={(v) => set('x', v)} />
      <ParamSlider label="位置 Y" value={t.y ?? 0} min={0} max={1} step={0.01} editable onChange={(v) => set('y', v)} />
      <ParamSlider label="缩放 X" value={t.scale_x ?? 1} min={0.1} max={5} step={0.01} onChange={(v) => setScale('scale_x', v)} />
      <ParamSlider label="缩放 Y" value={t.scale_y ?? 1} min={0.1} max={5} step={0.01} onChange={(v) => setScale('scale_y', v)} />
      <div style={S.row}>
        <ToggleBtn active={lockScale} onClick={() => setLockScale(!lockScale)}>锁比</ToggleBtn>
        <span style={{ color: '#aaa', fontSize: 11 }}>等比缩放</span>
      </div>
      <ParamSlider label="旋转" value={t.rotation ?? 0} min={0} max={360} step={1} unit="°" onChange={(v) => set('rotation', v)} />
      <ParamSlider label="不透明度" value={t.opacity ?? 1} min={0} max={1} step={0.01} unit="%" onChange={(v) => set('opacity', v)} />
      <div style={S.divider} />
      <div style={S.row}>
        <span style={S.label}>镜像</span>
        <ToggleBtn active={!!t.flip_h} onClick={() => toggleFlip('h')}>水平</ToggleBtn>
        <ToggleBtn active={!!t.flip_v} onClick={() => toggleFlip('v')}>垂直</ToggleBtn>
      </div>
    </div>
  );
}

// 滤镜/特效标签页（共用）
function ItemsTab({ clip, trackId, kind }: { clip: ClipConfig; trackId: string; kind: 'filters' | 'effects' }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const presets: any[] = kind === 'filters' ? FILTER_PRESETS : EFFECT_PRESETS;
  const items = (clip[kind] as any[]) || [];
  const [showMenu, setShowMenu] = useState(false);
  const zh = kind === 'filters' ? '滤镜' : '特效';
  const add = (preset: any) => {
    updateClip(trackId, clip.id, { [kind]: [...items, { type: preset.type, name: preset.label, enabled: true, params: { ...preset.params } }] } as Partial<ClipConfig>);
    setShowMenu(false);
  };
  const remove = (i: number) => updateClip(trackId, clip.id, { [kind]: items.filter((_, idx) => idx !== i) } as Partial<ClipConfig>);
  const toggle = (i: number) => updateClip(trackId, clip.id, { [kind]: items.map((it, idx) => idx === i ? { ...it, enabled: !it.enabled } : it) } as Partial<ClipConfig>);
  const setParam = (i: number, k: string, v: number) => updateClip(trackId, clip.id, { [kind]: items.map((it, idx) => idx === i ? { ...it, params: { ...it.params, [k]: v } } : it) } as Partial<ClipConfig>);
  return (
    <div>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <button style={S.btn} onClick={() => setShowMenu(!showMenu)}>+ 添加{zh}</button>
        {showMenu && (
          <div style={{ position: 'absolute', top: '100%', left: 0, background: '#1a1a2e', border: '1px solid #0f3460', borderRadius: 4, zIndex: 10, minWidth: 120 }}>
            {presets.map((p) => (
              <div key={p.type} style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 11, color: '#eee' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#0f3460')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => add(p)}>{p.label}</div>
            ))}
          </div>
        )}
      </div>
      {items.length === 0 && <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 20 }}>暂无{zh}</div>}
      {items.map((it, i) => (
        <div key={i} style={S.item}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: '#eee' }}>{it.name}</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <ToggleBtn active={!!it.enabled} onClick={() => toggle(i)}>{it.enabled ? '开' : '关'}</ToggleBtn>
              <button style={S.btn} onClick={() => remove(i)}>×</button>
            </div>
          </div>
          {it.enabled && Object.entries(it.params || {}).map(([k, v]) => (
            <ParamSlider key={k} label={k} value={Number(v)} min={0} max={k.includes('radius') || k === 'amount' || k === 'angle' ? 100 : 2} step={0.01} onChange={(nv) => setParam(i, k, nv)} />
          ))}
        </div>
      ))}
    </div>
  );
}

// 音频标签页
function AudioTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const audio: any = (clip as any).audio || { fadein: 0, fadeout: 0, denoise: false, voice: '无' };
  const set = (k: string, v: any) => updateClip(trackId, clip.id, { audio: { ...audio, [k]: v } } as Partial<ClipConfig>);
  return (
    <div>
      {/* 片段音量：直接映射到后端 clip.volume（导出混音使用） */}
      <ParamSlider label="音量" value={clip.volume ?? 1} min={0} max={2} step={0.01} unit="%" onChange={(v) => updateClip(trackId, clip.id, { volume: v })} />
      <ParamSlider label="声相" value={audio.pan ?? 0} min={-1} max={1} step={0.01} onChange={(v) => set('pan', v)} />
      <div style={S.row}>
        <span style={S.label}>淡入</span>
        <input type="number" style={S.input} value={audio.fadein ?? 0} step={0.1} min={0}
          onChange={(e) => set('fadein', parseFloat(e.target.value) || 0)} />
        <span style={{ color: '#aaa', fontSize: 11 }}>秒</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>淡出</span>
        <input type="number" style={S.input} value={audio.fadeout ?? 0} step={0.1} min={0}
          onChange={(e) => set('fadeout', parseFloat(e.target.value) || 0)} />
        <span style={{ color: '#aaa', fontSize: 11 }}>秒</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>降噪</span>
        <ToggleBtn active={!!audio.denoise} onClick={() => set('denoise', !audio.denoise)}>{audio.denoise ? '开' : '关'}</ToggleBtn>
      </div>
      <div style={S.row}>
        <span style={S.label}>变声</span>
        <select style={S.input} value={audio.voice ?? '无'} onChange={(e) => set('voice', e.target.value)}>
          {VOICE_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
    </div>
  );
}

// 文字标签页
function TextTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const t = clip.text || { content: '', fontSize: 48, color: '#ffffff', textAlign: 'center' as const, x: 0.5, y: 0.5 };
  const set = (k: string, v: any) => updateClip(trackId, clip.id, { text: { ...t, [k]: v } } as Partial<ClipConfig>);
  return (
    <div style={{ padding: 8 }}>
      <div style={{ marginBottom: 8 }}>
        <div style={S.label}>文字内容</div>
        <textarea value={t.content} onChange={(e) => set('content', e.target.value)}
          style={{ width: '100%', height: 60, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: 4, fontSize: 12, resize: 'vertical' }} />
      </div>
      <ParamSlider label="字号" value={t.fontSize ?? 48} min={8} max={200} step={1} onChange={(v) => set('fontSize', v)} />
      <div style={S.row}>
        <span style={S.label}>颜色</span>
        <input type="color" value={t.color ?? '#ffffff'} onChange={(e) => set('color', e.target.value)}
          style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
      </div>
      <div style={S.row}>
        <span style={S.label}>对齐</span>
        {(['left', 'center', 'right'] as const).map(a => (
          <ToggleBtn key={a} active={(t.textAlign ?? 'center') === a} onClick={() => set('textAlign', a)}>
            {a === 'left' ? '左' : a === 'center' ? '中' : '右'}
          </ToggleBtn>
        ))}
      </div>
      <ParamSlider label="位置 X" value={t.x ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => set('x', v)} />
      <ParamSlider label="位置 Y" value={t.y ?? 0.5} min={0} max={1} step={0.01} onChange={(v) => set('y', v)} />
    </div>
  );
}

// 字幕标签页
function SubtitleTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const s = clip.subtitle || { items: [], fontSize: 24, color: '#ffffff', position: 'bottom' as const };
  const setStyle = (k: string, v: any) => updateClip(trackId, clip.id, { subtitle: { ...s, [k]: v } } as Partial<ClipConfig>);
  return (
    <div style={{ padding: 8 }}>
      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>共 {s.items.length} 条字幕</div>
      {s.items.slice(0, 5).map((item, i) => (
        <div key={i} style={{ marginBottom: 4, padding: 4, background: '#0f3460', borderRadius: 4 }}>
          <div style={{ fontSize: 10, color: '#888' }}>{item.start.toFixed(1)}s - {item.end.toFixed(1)}s</div>
          <div style={{ fontSize: 11, color: '#eee' }}>{item.text}</div>
        </div>
      ))}
      <div style={{ height: 1, background: '#0f3460', margin: '8px 0' }} />
      <ParamSlider label="字号" value={s.fontSize ?? 24} min={12} max={80} step={1} onChange={(v) => setStyle('fontSize', v)} />
      <div style={S.row}>
        <span style={S.label}>颜色</span>
        <input type="color" value={s.color ?? '#ffffff'} onChange={(e) => setStyle('color', e.target.value)}
          style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
      </div>
      <div style={S.row}>
        <span style={S.label}>位置</span>
        {(['bottom', 'center', 'top'] as const).map(p => (
          <ToggleBtn key={p} active={(s.position ?? 'bottom') === p} onClick={() => setStyle('position', p)}>
            {p === 'bottom' ? '底部' : p === 'center' ? '居中' : '顶部'}
          </ToggleBtn>
        ))}
      </div>
    </div>
  );
}

// 缓动曲线 SVG 预览
function EasingCurve({ kfs }: { kfs: any[] }) {
  const w = 200, h = 60;
  const pts = kfs.map((k, i) => {
    const x = (i / Math.max(1, kfs.length - 1)) * w;
    const v = typeof k.value === 'number' ? Math.max(0, Math.min(1, k.value)) : 0;
    return `${x},${h - v * h}`;
  }).join(' ');
  return (
    <svg width={w} height={h} style={{ background: '#0f3460', borderRadius: 4, display: 'block', marginTop: 8 }}>
      <polyline points={pts} fill="none" stroke="#e94560" strokeWidth="2" />
    </svg>
  );
}

// 关键帧标签页
function KeyframesTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const currentTime = useUIStore((s) => s.currentTime);
  const [prop, setProp] = useState('x');
  const kfs: any[] = ((clip.keyframes || {})[prop] as any[]) || [];
  const setKfs = (next: any[]) => updateClip(trackId, clip.id, { keyframes: { ...(clip.keyframes || {}), [prop]: next } } as Partial<ClipConfig>);
  const add = () => setKfs([...kfs, { time: currentTime, value: 0, easing: '线性' }].sort((a, b) => a.time - b.time));
  const remove = (i: number) => setKfs(kfs.filter((_, idx) => idx !== i));
  const setEasing = (i: number, e: string) => setKfs(kfs.map((k, idx) => idx === i ? { ...k, easing: e } : k));
  const setValue = (i: number, v: number) => setKfs(kfs.map((k, idx) => idx === i ? { ...k, value: v } : k));
  const dur = Math.max(0.001, clip.timelineOut - clip.timelineIn);
  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>属性</span>
        <select style={S.input} value={prop} onChange={(e) => setProp(e.target.value)}>
          {KF_PROPS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>
      {/* 关键帧时间轴小图 */}
      <div style={{ position: 'relative', height: 30, background: '#0f3460', borderRadius: 4, marginBottom: 8 }}>
        <div style={{ position: 'absolute', left: `${(currentTime / dur) * 100}%`, top: 0, bottom: 0, width: 1, background: '#e94560' }} />
        {kfs.map((k, i) => (
          <div key={i} style={{ position: 'absolute', left: `${(k.time / dur) * 100}%`, top: 10, width: 10, height: 10, background: '#e94560', borderRadius: '50%', transform: 'translateX(-50%)' }} />
        ))}
      </div>
      <button style={{ ...S.btn, width: '100%', marginBottom: 8 }} onClick={add}>+ 在播放头添加关键帧</button>
      {kfs.map((k, i) => (
        <div key={i} style={{ ...S.item, display: 'flex', gap: 4, alignItems: 'center', padding: 4 }}>
          <span style={{ color: '#aaa', fontSize: 11, width: 40 }}>{k.time.toFixed(2)}s</span>
          <input type="number" style={{ ...S.input, flex: 0, width: 50 }} value={k.value} step={0.01}
            onChange={(e) => setValue(i, parseFloat(e.target.value) || 0)} />
          <select style={S.input} value={k.easing} onChange={(e) => setEasing(i, e.target.value)}>
            {EASINGS.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <button style={S.btn} onClick={() => remove(i)}>×</button>
        </div>
      ))}
      {kfs.length >= 2 && <EasingCurve kfs={kfs} />}
    </div>
  );
}

// 变速标签页（含倒放 / 冻结帧 / 时间重映射曲线）
function SpeedTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const setSpeedAction = useProjectStore((s) => s.setSpeed);
  const setCurveLive = useProjectStore((s) => s.setCurveLive);
  const setCurveCommit = useProjectStore((s) => s.setCurveCommit);
  const speed = clip.speed ?? 1;
  const dur = clip.timelineOut - clip.timelineIn;
  const srcDur = clip.src_range.end - clip.src_range.start;
  const setSpeed = (v: number) => setSpeedAction(trackId, clip.id, v);

  const remap: TimeRemapConfig = clip.time_remap ?? { reverse: false, freeze: null, curve: [] as SpeedPointConfig[] };
  const reverse = remap.reverse ?? false;
  const freeze: FreezeConfig | null = remap.freeze ?? null;
  const curve: SpeedPointConfig[] = remap.curve ?? [];
  const hasCurve = curve.length > 0;

  const toggleReverse = () => updateClip(trackId, clip.id, { time_remap: { ...remap, reverse: !reverse } });
  const setFreezeEnabled = (on: boolean) =>
    updateClip(trackId, clip.id, { time_remap: { ...remap, freeze: on ? { start: 0, sourceTime: 0, duration: 1 } : null } });
  const setFreezeField = (k: keyof FreezeConfig, v: number) =>
    updateClip(trackId, clip.id, { time_remap: { ...remap, freeze: { ...freeze!, [k]: v } } });
  // 拖拽过程（onChange）只更新曲线，避免时长抖动；提交（onCommit/增删/数字输入）才反推时长
  const setCurve = (next: SpeedPointConfig[]) => setCurveLive(trackId, clip.id, next);
  const commitCurve = (next: SpeedPointConfig[]) => setCurveCommit(trackId, clip.id, next);
  const addKey = () => {
    if (curve.length === 0) {
      // 种子：归一化 [0,1] 的 1x 基线（play 0→1，speed 1→1），避免空曲线导致的静止画面
      commitCurve([
        { play: 0, speed: 1 },
        { play: 1, speed: 1 },
      ]);
    } else {
      const last = curve[curve.length - 1];
      const newPlay = Math.min(1, last.play + 1 / (curve.length + 1));
      commitCurve([...curve, { play: newPlay, speed: 1 }]);
    }
  };
  const removeKey = (i: number) => commitCurve(curve.filter((_, idx) => idx !== i));
  const setKey = (i: number, k: keyof SpeedPointConfig, v: number) =>
    commitCurve(curve.map((p, idx) => idx === i ? { ...p, [k]: v } : p));

  return (
    <div>
      <ParamSlider label="播放速度" value={speed} min={0.25} max={4} step={0.05} unit="x" editable onChange={setSpeed} />
      <div style={{ color: '#aaa', fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
        速度作用于时间线→素材映射：&gt;1 快放（片段变短），&lt;1 慢放（片段变长）。当前片段时长 {dur.toFixed(2)}s，源时长 {srcDur.toFixed(2)}s。
      </div>

      <div style={S.divider} />

      {/* 倒放 */}
      <div style={S.row}>
        <span style={S.label}>倒放</span>
        <ToggleBtn active={reverse} onClick={toggleReverse}>{reverse ? '已倒放' : '正放'}</ToggleBtn>
      </div>

      {/* 冻结帧 */}
      <div style={S.row}>
        <span style={S.label}>冻结帧</span>
        <ToggleBtn active={!!freeze} onClick={() => setFreezeEnabled(!freeze)}>{freeze ? '启用' : '关闭'}</ToggleBtn>
      </div>
      {freeze && (
        <div style={{ paddingLeft: 8, borderLeft: '2px solid #0f3460' }}>
          <div style={S.row}>
            <span style={S.label}>起始</span>
            <input type="number" style={S.input} value={freeze.start} step={0.1} min={0}
              onChange={(e) => setFreezeField('start', parseFloat(e.target.value) || 0)} />
            <span style={{ color: '#aaa', fontSize: 11 }}>s</span>
          </div>
          <div style={S.row}>
            <span style={S.label}>源时间</span>
            <input type="number" style={S.input} value={freeze.sourceTime} step={0.1} min={0}
              onChange={(e) => setFreezeField('sourceTime', parseFloat(e.target.value) || 0)} />
            <span style={{ color: '#aaa', fontSize: 11 }}>s</span>
          </div>
          <div style={S.row}>
            <span style={S.label}>时长</span>
            <input type="number" style={S.input} value={freeze.duration} step={0.1} min={0}
              onChange={(e) => setFreezeField('duration', parseFloat(e.target.value) || 0)} />
            <span style={{ color: '#aaa', fontSize: 11 }}>s</span>
          </div>
        </div>
      )}

      <div style={S.divider} />

      {/* 时间重映射曲线 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ color: '#eee', fontSize: 11 }}>时间重映射曲线</span>
        <button style={S.btn} onClick={addKey}>+ 添加关键帧</button>
      </div>
      <SpeedCurveEditor clip={clip} curve={curve} freeze={freeze} reverse={reverse} onChange={setCurve} onCommit={commitCurve} />
      {curve.length === 0 && <div style={{ color: '#aaa', fontSize: 11, marginBottom: 6 }}>暂无关键帧（使用线性 speed 映射）</div>}
      {curve.map((pt, i) => (
        <div key={i} style={{ ...S.item, display: 'flex', gap: 4, alignItems: 'center', padding: 4, marginBottom: 4 }}>
          <span style={{ color: '#aaa', fontSize: 10, width: 28 }}>play</span>
          <input type="number" style={{ ...S.input, flex: 1 }} value={+(pt.play * dur).toFixed(3)} step={0.1}
            onChange={(e) => setKey(i, 'play', Math.max(0, Math.min(1, (parseFloat(e.target.value) || 0) / (dur || 1))))} />
          <span style={{ color: '#aaa', fontSize: 10, width: 24 }}>速度</span>
          <input type="number" style={{ ...S.input, flex: 1 }} value={pt.speed} step={0.1} min={0}
            onChange={(e) => setKey(i, 'speed', Math.max(0, parseFloat(e.target.value) || 0))} />
          <button style={S.btn} onClick={() => removeKey(i)}>×</button>
        </div>
      ))}

      <div style={{ color: '#888', fontSize: 10, marginTop: 6, lineHeight: 1.5 }}>
        曲线为速度曲线：每段斜率=该时刻速度倍率，speed&gt;0 连续播放，speed=0=该段冻结。曲线非空时倒放/冻结被忽略。
      </div>
    </div>
  );
}

// 转场标签页
const TRANSITION_TYPES: { value: TransitionType; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'dissolve', label: '交叉溶解' },
  { value: 'slide', label: '滑动' },
];
function TransitionTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const tr: TransitionConfig = clip.transition || { transitionType: 'none', duration: 0.5 };
  const setType = (t: TransitionType) => updateClip(trackId, clip.id, { transition: { ...tr, transitionType: t } });
  const setDur = (d: number) => updateClip(trackId, clip.id, { transition: { ...tr, duration: d } });
  return (
    <div>
      <div style={S.row}>
        <span style={S.label}>类型</span>
        <select style={S.input} value={tr.transitionType ?? 'none'} onChange={(e) => setType(e.target.value as TransitionType)}>
          {TRANSITION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <ParamSlider label="时长" value={tr.duration ?? 0.5} min={0.1} max={3} step={0.1} unit="s" editable onChange={setDur} />
      <div style={{ color: '#aaa', fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
        转场作用于本片段结尾与同轨下一片段之间（导出时合成交叉淡化 / 滑动）。
      </div>
    </div>
  );
}

// 工程信息（未选中片段时显示）
function ProjectInfo() {
  const project = useProjectStore((s) => s.project);
  const totalDur = Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => c.timelineOut)));
  const clipCount = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <div>
      <div style={{ fontSize: 13, color: '#eee', marginBottom: 10 }}>工程信息</div>
      <div style={S.item}>画布尺寸: {project.canvas.width} × {project.canvas.height}</div>
      <div style={S.item}>帧率: {project.canvas.fps ?? 30} fps</div>
      <div style={S.item}>素材数量: {project.assets.length}</div>
      <div style={S.item}>片段数量: {clipCount}</div>
      <div style={S.item}>总时长: {totalDur.toFixed(2)} 秒</div>
    </div>
  );
}

// 主组件
export default function PropertiesPanel() {
  const activeTab = useUIStore((s) => s.activeRightPanel);
  const setActiveTab = useUIStore((s) => s.setActiveRightPanel);
  const sel = useSelectedClip();
  return (
    <div style={S.panel}>
      <div style={S.tabs}>
        {TABS.map((t) => (
          <button key={t.key} style={S.tab(activeTab === t.key)} onClick={() => setActiveTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div style={S.content}>
        {!sel ? <ProjectInfo /> : (
          activeTab === 'transform' ? <TransformTab clip={sel.clip} trackId={sel.trackId} /> :
          activeTab === 'filters' ? <ItemsTab clip={sel.clip} trackId={sel.trackId} kind="filters" /> :
          activeTab === 'effects' ? <ItemsTab clip={sel.clip} trackId={sel.trackId} kind="effects" /> :
          activeTab === 'audio' ? <AudioTab clip={sel.clip} trackId={sel.trackId} /> :
          activeTab === 'speed' ? <SpeedTab clip={sel.clip} trackId={sel.trackId} /> :
          activeTab === 'transition' ? <TransitionTab clip={sel.clip} trackId={sel.trackId} /> :
          activeTab === 'text' ? <TextTab clip={sel.clip} trackId={sel.trackId} /> :
          activeTab === 'subtitle' ? <SubtitleTab clip={sel.clip} trackId={sel.trackId} /> :
          <KeyframesTab clip={sel.clip} trackId={sel.trackId} />
        )}
      </div>
    </div>
  );
}
