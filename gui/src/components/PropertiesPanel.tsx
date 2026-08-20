// 属性面板 — 右侧面板，按素材类型（文本/字幕/音频/视频图片）分组展示一级 tab，
// 同类型下再分子 tab（如视频「画面」含 基础/抠像/蒙版）。
// 复用既有渲染函数（TransformTab/KeyingTab/MaskTab/AudioTab/SpeedTab/TransitionTab/
// ItemsTab/TextTab/SubtitleTab/KeyframesTab），不改变底层数据模型与后端契约。
import { useState, useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import type { RightPanel } from '../store/uiStore';
import type { ClipConfig, TransformConfig, CropConfig, TransitionConfig, TransitionType, WipeDirection, TransitionEasing, WipeMaskShape, TimeRemapConfig, FreezeConfig, SpeedPointConfig, TextBackground, TextShadow, SubtitleContent } from '../types';
import { SpeedCurveEditor } from './SpeedCurveEditor';
import MaskTab from './panels/MaskTab';
import KeyingTab from './panels/KeyingTab';
import { SUBTITLE_FONTS, SUBTITLE_FONT_GROUPS, SUBTITLE_STYLE_PRESETS, findFontCss, DEFAULT_FONT_ID } from '../utils/subtitleFonts';
import { useSubtitleEditStore } from '../store/subtitleEditStore';

// 插件 manifest 类型（仅前端 UI 使用，不依赖 engine 包）
interface ParameterDef {
  key: string; label: string; param_type: 'Slider' | 'Toggle' | 'Color' | 'Select';
  default: number; min: number; max: number; step?: number; options?: string[];
}
interface PluginManifest {
  id: string; name: string; version: string; author: string; description: string;
  plugin_type: 'Filter' | 'Effect' | 'Transition' | 'TextTemplate' | 'Sticker';
  min_app_version: string; parameters: ParameterDef[];
  filter_spec?: string; shader?: string; thumbnail?: string;
}

// ── 按素材类型分组的属性面板结构 ──
// 一级 tab 依选中素材类型不同而不同；视频/图片的「画面」含二级 tab（基础/抠像/蒙版/美颜美体）。
// key 与 uiStore.RightPanel 对应；历史 key（transform/filters/...）不再作为 tab 渲染，会自动回退分组首个 tab。
type Category = 'text' | 'subtitle' | 'audio' | 'video';
interface SubDef { key: string; label: string; }
interface TabDef { key: RightPanel; label: string; subs?: SubDef[]; }

const PANEL_GROUPS: Record<Category, TabDef[]> = {
  // 视频 / 图片：画面(基础/抠像/蒙版) / 音频 / 变速 / 动画(转场) / 调整(滤镜+特效) / 关键帧
  video: [
    { key: 'visual', label: '画面', subs: [
      { key: 'base', label: '基础' },
      { key: 'keying', label: '抠像' },
      { key: 'mask', label: '蒙版' },
    ]},
    { key: 'audio', label: '音频' },
    { key: 'speed', label: '变速' },
    { key: 'anim', label: '动画' },
    { key: 'adjust', label: '调整' },
    { key: 'kf', label: '关键帧' },
  ],
  // 文本：文本 / 关键帧
  text: [
    { key: 'text', label: '文本' },
    { key: 'kf', label: '关键帧' },
  ],
  // 字幕：字幕 / 关键帧
  subtitle: [
    { key: 'subtitle', label: '字幕' },
    { key: 'kf', label: '关键帧' },
  ],
  // 音频素材：基础 / 变速 / 关键帧（声相/降噪/变声等占位项暂不暴露，避免误导）
  audio: [
    { key: 'audio', label: '基础' },
    { key: 'speed', label: '变速' },
    { key: 'kf', label: '关键帧' },
  ],
};

// 依据 clip 字段与所在轨道类型判定素材分类
function clipCategory(clip: ClipConfig, trackType?: string): Category {
  if (clip.text) return 'text';
  if (clip.subtitle) return 'subtitle';
  if (trackType === 'audio') return 'audio';
  return 'video';
}

// 滤镜/特效预设已改为从 plugins/ 目录的真实插件加载（见下方 ItemsTab），
// 不再使用硬编码预设——那些 kind 在引擎注册表/插件清单中均无实现，添加后预览与导出都不生效。

const EASINGS = ['线性', '缓入', '缓出', '缓入缓出'];
const KF_PROPS = [
  { key: 'x', label: '位置X' }, { key: 'y', label: '位置Y' },
  { key: 'scale', label: '缩放' }, { key: 'rotation', label: '旋转' },
  { key: 'opacity', label: '不透明度' }, { key: 'volume', label: '音量' },
  // 抠像参数：
  //  - similarity / spill 仅 chroma 模式生效
  //  - edgeSoftness 作用于 chroma 边缘羽化 与 smart/manual 蒙版柔化
  //  - threshold 仅 smart/manual 模式生效（matte 阈值）
  { key: 'keying.similarity', label: '抠像·相似度' },
  { key: 'keying.edgeSoftness', label: '抠像·边缘柔化' },
  { key: 'keying.spill', label: '抠像·溢出抑制' },
  { key: 'keying.threshold', label: '抠像·阈值' },
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
  subtabs: { display: 'flex', gap: 4, padding: '6px 8px', borderBottom: '1px solid #0f3460', background: '#101a30' },
  subtab: (active: boolean) => ({
    flex: 1, padding: '4px 2px', fontSize: 11, color: active ? '#fff' : '#9fb0c8',
    background: active ? '#0f3460' : 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer',
  }),
};

// 可复用参数滑块；editable=true 时右侧显示可编辑数值输入框
// onEditStart/onEditEnd：连续拖动的生命周期回调（用于拖前压一次历史快照、拖后收尾）。
// 用 ref 保证一次拖动只触发一次 onEditStart/onEditEnd（避免每帧 onChange 重复触发）。
function ParamSlider({ label, value, min, max, step, unit, editable, format, onChange, onEditStart, onEditEnd }: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; editable?: boolean; format?: (v: number) => string; onChange: (v: number) => void;
  onEditStart?: () => void; onEditEnd?: () => void;
}) {
  const fmt = (v: number) => format ? format(v) : unit === '%' ? `${Math.round(v * 100)}%` : unit === '°' ? `${Math.round(v)}°` : v.toFixed(2);
  const editingRef = useRef(false);
  const begin = () => { if (!editingRef.current) { editingRef.current = true; onEditStart?.(); } };
  const end = () => { if (editingRef.current) { editingRef.current = false; onEditEnd?.(); } };
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
  const updateTransformLive = useProjectStore((s) => s.updateTransformLive);
  const updateClip = useProjectStore((s) => s.updateClip);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const t = (clip.transform || {}) as TransformExt;
  const [lockScale, setLockScale] = useState(true);
  const set = (k: keyof TransformConfig, v: number) => updateTransformLive(trackId, clip.id, k, v);
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
      <ParamSlider label="位置 X" value={t.x ?? 0} min={0} max={1} step={0.01} editable onChange={(v) => set('x', v)} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="位置 Y" value={t.y ?? 0} min={0} max={1} step={0.01} editable onChange={(v) => set('y', v)} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="缩放 X" value={t.scale_x ?? 1} min={0.1} max={5} step={0.01} onChange={(v) => setScale('scale_x', v)} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="缩放 Y" value={t.scale_y ?? 1} min={0.1} max={5} step={0.01} onChange={(v) => setScale('scale_y', v)} onEditStart={pushHistorySnapshot} />
      <div style={S.row}>
        <ToggleBtn active={lockScale} onClick={() => setLockScale(!lockScale)}>锁比</ToggleBtn>
        <span style={{ color: '#aaa', fontSize: 11 }}>等比缩放</span>
      </div>
      <ParamSlider label="旋转" value={t.rotation ?? 0} min={0} max={360} step={1} unit="°" onChange={(v) => set('rotation', v)} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="不透明度" value={t.opacity ?? 1} min={0} max={1} step={0.01} unit="%" onChange={(v) => set('opacity', v)} onEditStart={pushHistorySnapshot} />
      <div style={S.divider} />
      <div style={S.row}>
        <span style={S.label}>镜像</span>
        <ToggleBtn active={!!t.flip_h} onClick={() => toggleFlip('h')}>水平</ToggleBtn>
        <ToggleBtn active={!!t.flip_v} onClick={() => toggleFlip('v')}>垂直</ToggleBtn>
      </div>
      <CropSection clip={clip} trackId={trackId} />
    </div>
  );
}

// 自由裁切：归一化源空间 {x,y,w,h}（0..1），与预览窗口裁切操作双向联动。
function CropSection({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const crop = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
  const setCrop = (p: Partial<CropConfig>) => {
    const next = { ...crop, ...p };
    next.w = Math.max(0.02, Math.min(next.w, 1 - next.x));
    next.h = Math.max(0.02, Math.min(next.h, 1 - next.y));
    updateClipLive(trackId, clip.id, { crop: next });
  };
  const reset = () => { pushHistorySnapshot(); updateClip(trackId, clip.id, { crop: { x: 0, y: 0, w: 1, h: 1 } }); };
  const pct = (v: number) => Math.round(v * 100);
  const num = (e: React.ChangeEvent<HTMLInputElement>) => Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)) / 100;
  const inp = (label: string, val: number, on: (v: number) => void) => (
    <label style={{ flex: 1, fontSize: 11, color: '#bbb' }}>
      {label}
      <input type="number" min={0} max={100} value={pct(val)} onFocus={pushHistorySnapshot}
        onChange={(e) => on(num(e))} style={{ ...S.input, marginTop: 2 }} />
    </label>
  );
  return (
    <div style={{ marginTop: 8 }}>
      <div style={S.row}>
        <span style={S.label}>裁剪</span>
        <button onClick={reset} style={{ ...S.btn, fontSize: 11 }}>重置</button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {inp('X %', crop.x, (v) => setCrop({ x: Math.min(v, 1 - crop.w) }))}
        {inp('Y %', crop.y, (v) => setCrop({ y: Math.min(v, 1 - crop.h) }))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {inp('宽 %', crop.w, (v) => setCrop({ w: v }))}
        {inp('高 %', crop.h, (v) => setCrop({ h: v }))}
      </div>
    </div>
  );
}

// 滤镜/特效标签页（共用）：从已加载插件中按 plugin_type 分流，添加到 clip.filters。
// 预览（HTML5 css_filter / WebGPU shader）与导出（filter_spec）均读取 clip.filters，故统一写入此字段。
function ItemsTab({ clip, trackId, kind }: { clip: ClipConfig; trackId: string; kind: 'filters' | 'effects' }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [showMenu, setShowMenu] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const raw = await (window as any).aicut?.listPlugins();
        const list: PluginManifest[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list)) setPlugins(list);
      } catch { /* 插件不可用则列表为空 */ }
    })();
  }, []);

  const wantType = kind === 'filters' ? 'Filter' : 'Effect';
  const presets = plugins.filter((p) => p.plugin_type === wantType);
  // 仅展示由本类插件产生的 filters（依据 manifest.id 匹配 kind）
  const filters: any[] = (clip.filters as any[]) || [];
  const items = filters.filter((it) => presets.some((p) => p.id === it.kind));
  const installedIds = new Set(items.map((it) => it.kind));
  const available = presets.filter((p) => !installedIds.has(p.id));
  const pluginByKind: Record<string, PluginManifest> = {};
  for (const p of presets) pluginByKind[p.id] = p;
  const zh = kind === 'filters' ? '滤镜' : '特效';

  const add = (p: PluginManifest) => {
    const params: Record<string, number> = {};
    for (const pd of p.parameters) params[pd.key] = pd.default;
    updateClip(trackId, clip.id, { filters: [...filters, { kind: p.id, name: p.name, enabled: true, params }] } as Partial<ClipConfig>);
    setShowMenu(false);
  };
  // 用 kind+name 精确匹配目标实例，避免重排导致的索引错位
  const remove = (i: number) => {
    const target = items[i];
    updateClip(trackId, clip.id, { filters: filters.filter((it) => !(it.kind === target.kind && it.name === target.name)) } as Partial<ClipConfig>);
  };
  const toggle = (i: number) => {
    const target = items[i];
    updateClip(trackId, clip.id, { filters: filters.map((it) => (it.kind === target.kind && it.name === target.name ? { ...it, enabled: !it.enabled } : it)) } as Partial<ClipConfig>);
  };
  const setParam = (i: number, k: string, v: number) => {
    const target = items[i];
    updateClipLive(trackId, clip.id, { filters: filters.map((it) => (it.kind === target.kind && it.name === target.name ? { ...it, params: { ...it.params, [k]: v } } : it)) } as Partial<ClipConfig>);
  };

  return (
    <div>
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <button style={S.btn} onClick={() => setShowMenu(!showMenu)}>+ 添加{zh}</button>
        {showMenu && (
          <div style={{ position: 'absolute', top: '100%', left: 0, background: '#1a1a2e', border: '1px solid #0f3460', borderRadius: 4, zIndex: 10, minWidth: 120 }}>
            {available.length === 0 && <div style={{ padding: '6px 10px', fontSize: 11, color: '#aaa' }}>暂无可用{zh}插件</div>}
            {available.map((p) => (
              <div key={p.id} style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 11, color: '#eee' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#0f3460')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => add(p)}>{p.name}</div>
            ))}
          </div>
        )}
      </div>
      {items.length === 0 && <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 20 }}>暂无{zh}</div>}
      {items.map((it, i) => {
        const pm = pluginByKind[it.kind];
        return (
          <div key={i} style={S.item}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: '#eee' }}>{it.name}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <ToggleBtn active={!!it.enabled} onClick={() => toggle(i)}>{it.enabled ? '开' : '关'}</ToggleBtn>
                <button style={S.btn} onClick={() => remove(i)}>×</button>
              </div>
            </div>
            {it.enabled && pm && pm.parameters.map((pd: any) => (
              <ParamSlider key={pd.key} label={pd.label} value={Number(it.params?.[pd.key] ?? pd.default)}
                min={pd.min} max={pd.max} step={pd.step || 0.01}
                onChange={(nv) => setParam(i, pd.key, nv)} onEditStart={pushHistorySnapshot} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// 插件标签页：浏览已发现插件并应用到当前片段
function PluginsTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const raw = await (window as any).aicut?.listPlugins();
        const list: PluginManifest[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(list)) {
          setPlugins(list);
          if (list.length === 0) setError('未发现插件：请在仓库 plugins/ 目录放置 manifest.json（重启应用生效）');
        } else {
          setPlugins([]);
          setError('插件清单格式异常');
        }
      } catch {
        setPlugins([]);
        setError('插件服务不可用，请重启应用（Electron 主进程需重新编译）');
      } finally { setLoading(false); }
    })();
  }, []);

  const items: any[] = (clip.filters as any[]) || [];
  // 仅展示由插件产生的 filters（依据 manifest.id 匹配 kind）
  const pluginItems = items.filter((it) => plugins.some((p) => p.id === it.kind));
  const installedIds = new Set(pluginItems.map((it) => it.kind));
  const available = plugins.filter((p) => !installedIds.has(p.id));

  const [showMenu, setShowMenu] = useState(false);

  const addPlugin = (p: PluginManifest) => {
    const params: Record<string, number> = {};
    for (const pd of p.parameters) params[pd.key] = pd.default;
    updateClip(trackId, clip.id, { filters: [...items, { kind: p.id, name: p.name, enabled: true, params }] } as Partial<ClipConfig>);
    setShowMenu(false);
  };
  // 用 kind+name 精确匹配目标实例，避免重排导致的索引错位
  const remove = (i: number) => updateClip(trackId, clip.id, { filters: pluginItems.filter((_, idx) => idx !== i) } as Partial<ClipConfig>);
  const toggle = (i: number) => updateClip(trackId, clip.id, { filters: items.map((it) => (it.kind === pluginItems[i].kind && it.name === pluginItems[i].name ? { ...it, enabled: !it.enabled } : it)) } as Partial<ClipConfig>);
  const setParam = (i: number, k: string, v: number) => {
    const target = pluginItems[i];
    updateClipLive(trackId, clip.id, { filters: items.map((it) => (it.kind === target.kind && it.name === target.name ? { ...it, params: { ...it.params, [k]: v } } : it)) } as Partial<ClipConfig>);
  };

  // Color 约定：以 0xRRGGBB 整数（f64）存入 params；下面做 f64<->hex 转换
  const f64ToHex = (v: number) => '#' + ((Math.round(v) & 0xffffff).toString(16).padStart(6, '0'));
  const hexToF64 = (hex: string) => parseInt(hex.slice(1), 16);

  return (
    <div>
      {error && <div style={{ color: '#e94560', fontSize: 11, padding: '6px 0' }}>⚠ {error}</div>}
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <button style={S.btn} onClick={() => setShowMenu(!showMenu)}>+ 添加插件</button>
        {showMenu && (
          <div style={{ position: 'absolute', top: '100%', left: 0, background: '#1a1a2e', border: '1px solid #0f3460', borderRadius: 4, zIndex: 10, minWidth: 160, maxHeight: 240, overflow: 'auto' }}>
            {available.length === 0
              ? <div style={{ padding: '6px 10px', fontSize: 11, color: '#aaa' }}>没有可添加的插件</div>
              : available.map((p) => (
                <div key={p.id} style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 11, color: '#eee' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#0f3460')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  onClick={() => addPlugin(p)}>{p.name}</div>
              ))}
          </div>
        )}
      </div>

      {loading && <div style={{ color: '#aaa', fontSize: 11, padding: 8 }}>加载插件…</div>}
      {!loading && pluginItems.length === 0 && (
        <div style={{ color: '#aaa', fontSize: 11, textAlign: 'center', padding: 20 }}>暂无插件（在 plugins/ 目录放置 manifest.json 即可）</div>
      )}

      {pluginItems.map((it, i) => {
        const p = plugins.find((pp) => pp.id === it.kind);
        if (!p) return null; // 不是插件实例
        const params: Record<string, number> = it.params || {};
        return (
          <div key={i} style={S.item}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: '#eee' }}>{it.name}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <ToggleBtn active={!!it.enabled} onClick={() => toggle(i)}>{it.enabled ? '开' : '关'}</ToggleBtn>
                <button style={S.btn} onClick={() => remove(i)}>×</button>
              </div>
            </div>
            {it.enabled && p.parameters.map((pd) => {
              const value = Number(params[pd.key] ?? pd.default);
              if (pd.param_type === 'Slider') {
                return (
                  <ParamSlider key={pd.key} label={pd.label} value={value} min={pd.min} max={pd.max}
                    step={pd.step ?? 0.01} editable onChange={(v) => setParam(i, pd.key, v)} onEditStart={pushHistorySnapshot} />
                );
              } else if (pd.param_type === 'Toggle') {
                return (
                  <div key={pd.key} style={S.row}>
                    <span style={S.label}>{pd.label}</span>
                    <ToggleBtn active={!!value} onClick={() => setParam(i, pd.key, value ? 0 : 1)}>{value ? '开' : '关'}</ToggleBtn>
                  </div>
                );
              } else if (pd.param_type === 'Color') {
                return (
                  <div key={pd.key} style={S.row}>
                    <span style={S.label}>{pd.label}</span>
                    <input type="color" value={f64ToHex(value)}
                      onChange={(e) => setParam(i, pd.key, hexToF64(e.target.value))}
                      style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
                  </div>
                );
              } else { // Select：value 为选项索引（f64）
                const opts = pd.options ?? [];
                return (
                  <div key={pd.key} style={S.row}>
                    <span style={S.label}>{pd.label}</span>
                    <select style={S.input} value={Math.round(value)} onChange={(e) => setParam(i, pd.key, parseInt(e.target.value, 10) || 0)}>
                      {opts.map((o, oi) => <option key={oi} value={oi}>{o}</option>)}
                    </select>
                  </div>
                );
              }
            })}
          </div>
        );
      })}
    </div>
  );
}

// 音频标签页
function AudioTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const audio: any = (clip as any).audio || { pan: 0, denoise: false, voice: '无' };
  const dur = Math.max(0, clip.timelineOut - clip.timelineIn);
  const set = (k: string, v: any) => updateClipLive(trackId, clip.id, { audio: { ...audio, [k]: v } } as Partial<ClipConfig>);
  // 淡入/淡出绑定到顶层 audioFadeIn/audioFadeOut（与 Timeline 控制点、预览、导出同一真相源），并夹在 [0, 片段时长]
  const setFade = (key: 'audioFadeIn' | 'audioFadeOut', raw: number) => {
    const v = isNaN(raw) ? 0 : Math.min(Math.max(0, raw), dur);
    updateClipLive(trackId, clip.id, { [key]: v } as Partial<ClipConfig>);
  };
  return (
    <div>
      {/* 片段音量：直接映射到后端 clip.volume（导出混音使用）。拖动走 live（不每帧深拷贝），拖前压一次快照 */}
      <ParamSlider label="音量" value={clip.volume ?? 1} min={0} max={2} step={0.01} unit="%" onChange={(v) => updateClipLive(trackId, clip.id, { volume: v })} onEditStart={pushHistorySnapshot} />
      <ParamSlider label="声相" value={audio.pan ?? 0} min={-1} max={1} step={0.01} onChange={(v) => set('pan', v)} onEditStart={pushHistorySnapshot} />
      <div style={S.row}>
        <span style={S.label}>淡入</span>
        <input type="number" style={S.input} value={clip.audioFadeIn ?? 0} step={0.1} min={0} max={dur}
          onFocus={pushHistorySnapshot} onChange={(e) => setFade('audioFadeIn', parseFloat(e.target.value))} />
        <span style={{ color: '#aaa', fontSize: 11 }}>秒</span>
      </div>
      <div style={S.row}>
        <span style={S.label}>淡出</span>
        <input type="number" style={S.input} value={clip.audioFadeOut ?? 0} step={0.1} min={0} max={dur}
          onFocus={pushHistorySnapshot} onChange={(e) => setFade('audioFadeOut', parseFloat(e.target.value))} />
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

// 字体下拉（按分组 optgroup 渲染）
function FontSelect({ value, onChange }: { value?: string; onChange: (id: string) => void }) {
  const current = value || DEFAULT_FONT_ID;
  return (
    <select value={current} onChange={(e) => onChange(e.target.value)}
      style={{ width: '100%', background: '#0f3460', color: '#eee', border: '1px solid #1a1a2e', borderRadius: 4, padding: '5px 6px', fontSize: 12 }}>
      {SUBTITLE_FONT_GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {SUBTITLE_FONTS.filter((f) => f.group === g).map((f) => (
            <option key={f.id} value={f.id}>{f.label}{f.note ? `（${f.note}）` : ''}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// 字幕样式预设行（点击应用到当前片段）
function StylePresetRow({ onApply }: { onApply: (p: typeof SUBTITLE_STYLE_PRESETS[number]) => void }) {
  return (
    <div>
      <div style={{ color: '#aaa', fontSize: 11, margin: '6px 0 4px' }}>样式预设（点击应用）</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {SUBTITLE_STYLE_PRESETS.map((p) => (
          <button key={p.key} onClick={() => onApply(p)}
            style={{ ...S.btn, fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              fontWeight: 'bold', fontSize: 13, color: p.color,
              WebkitTextStroke: `${Math.min(1, p.strokeWidth)}px ${p.strokeColor}`,
            }}>字</span>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// 小工具：hex -> rgba
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2) || 'ff', 16);
  const g = parseInt(h.slice(2, 4) || 'ff', 16);
  const b = parseInt(h.slice(4, 6) || 'ff', 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

// 文字标签页
function TextTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const { applyToAll, toggleApplyToAll } = useSubtitleEditStore();
  const t = clip.text || { content: '', fontSize: 48, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, strokeOpacity: 1, textAlign: 'center' as const, x: 0.5, y: 0.5 };
  const defaultBg: TextBackground = { enabled: false, color: '#000000', opacity: 0.9, radius: 0.06, width: 0.19, height: 0.13, offsetX: 0.5, offsetY: 0.5 };
  const defaultSh: TextShadow = { enabled: false, color: '#000000', opacity: 0.9, blur: 0.15, distance: 5, angle: -45 };
  const bg: TextBackground = { ...defaultBg, ...t.background };
  const sh: TextShadow = { ...defaultSh, ...t.shadow };

  // 统一编辑：改一个文字块 → 同轨道所有文字块同步变化（仅限样式属性，不含 content）
  const set = (k: string, v: any) => {
    if (applyToAll && k !== 'content') {
      const tracks = useProjectStore.getState().project.tracks;
      const track = tracks.find((tr) => tr.id === trackId);
      if (track) {
        track.clips.forEach((c) => {
          const ct = c.text || { content: '' };
          updateClip(trackId, c.id, { text: { ...ct, [k]: v } } as Partial<ClipConfig>);
        });
        return;
      }
    }
    updateClip(trackId, clip.id, { text: { ...t, [k]: v } } as Partial<ClipConfig>);
  };

  // 样式预设 → 同轨道统一应用
  const applyStylePreset = (p: typeof SUBTITLE_STYLE_PRESETS[number]) => {
    if (applyToAll) {
      const tracks = useProjectStore.getState().project.tracks;
      const track = tracks.find((tr) => tr.id === trackId);
      if (track) {
        track.clips.forEach((c) => {
          const ct = c.text || { content: '' };
          updateClip(trackId, c.id, { text: { ...ct, fontFamily: p.fontId, color: p.color, strokeColor: p.strokeColor, strokeWidth: p.strokeWidth, strokeOpacity: p.strokeOpacity ?? 1, fontWeight: p.fontWeight } } as Partial<ClipConfig>);
        });
        return;
      }
    }
    updateClip(trackId, clip.id, { text: { ...t, fontFamily: p.fontId, color: p.color, strokeColor: p.strokeColor, strokeWidth: p.strokeWidth, strokeOpacity: p.strokeOpacity ?? 1, fontWeight: p.fontWeight } } as Partial<ClipConfig>);
  };

  return (
    <div style={{ padding: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, padding: '6px 8px', background: '#0f3460', borderRadius: 4, cursor: 'pointer', userSelect: 'none' }}>
        <input type="checkbox" checked={applyToAll} onChange={toggleApplyToAll} style={{ cursor: 'pointer' }} />
        <span style={{ fontSize: 12, color: '#ccc' }}>应用到所在轨道的所有字幕</span>
      </label>
      <div style={{ marginBottom: 8 }}>
        <div style={S.label}>文字内容</div>
        <textarea autoFocus value={t.content} onChange={(e) => set('content', e.target.value)}
          style={{ width: '100%', height: 60, background: '#0f3460', border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee', padding: 4, fontSize: 12, resize: 'vertical' }} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={S.label}>字体</div>
        <FontSelect value={t.fontFamily} onChange={(id) => set('fontFamily', id)} />
      </div>
      <StylePresetRow onApply={applyStylePreset} />
      <ParamSlider label="字号" value={t.fontSize ?? 48} min={8} max={200} step={1} editable onChange={(v) => set('fontSize', v)} />
      <div style={S.row}>
        <span style={S.label}>颜色</span>
        <input type="color" value={t.color ?? '#ffffff'} onChange={(e) => set('color', e.target.value)}
          style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
      </div>
      <div style={S.row}>
        <span style={S.label}>描边色</span>
        <input type="color" value={t.strokeColor ?? '#000000'} onChange={(e) => set('strokeColor', e.target.value)}
          style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
      </div>
      <ParamSlider label="粗细" value={t.strokeWidth ?? 0} min={0} max={18} step={0.5} editable onChange={(v) => set('strokeWidth', v)} />
      <ParamSlider label="描边不透明度" value={t.strokeOpacity ?? 1} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => set('strokeOpacity', v)} />
      <div style={S.row}>
        <span style={S.label}>对齐</span>
        {(['left', 'center', 'right'] as const).map(a => (
          <ToggleBtn key={a} active={(t.textAlign ?? 'center') === a} onClick={() => set('textAlign', a)}>
            {a === 'left' ? '左' : a === 'center' ? '中' : '右'}
          </ToggleBtn>
        ))}
      </div>
      <ParamSlider label="位置 X" value={t.x ?? 0.5} min={0} max={1} step={0.01} editable onChange={(v) => set('x', v)} />
      <ParamSlider label="位置 Y" value={t.y ?? 0.5} min={0} max={1} step={0.01} editable onChange={(v) => set('y', v)} />

      <div style={S.divider} />

      {/* 背景 */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ color: '#eee', fontSize: 12, fontWeight: 600 }}>背景</span>
          <ToggleBtn active={bg.enabled} onClick={() => set('background', { ...bg, enabled: !bg.enabled })}>{bg.enabled ? '开' : '关'}</ToggleBtn>
        </div>
        {bg.enabled && (
          <>
            <div style={S.row}>
              <span style={S.label}>颜色</span>
              <input type="color" value={bg.color} onChange={(e) => set('background', { ...bg, color: e.target.value })}
                style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
            </div>
            <ParamSlider label="不透明度" value={bg.opacity} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => set('background', { ...bg, opacity: v })} />
            <ParamSlider label="圆角" value={bg.radius} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => set('background', { ...bg, radius: v })} />
            <ParamSlider label="宽度" value={bg.width} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => set('background', { ...bg, width: v })} />
            <ParamSlider label="高度" value={bg.height} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => set('background', { ...bg, height: v })} />
            <ParamSlider label="左右偏移" value={bg.offsetX} min={-0.5} max={0.5} step={0.01} editable
              format={(v) => `${Math.round((v + 0.5) * 100)}%`}
              onChange={(v) => set('background', { ...bg, offsetX: v })} />
            <ParamSlider label="上下偏移" value={bg.offsetY} min={-0.5} max={0.5} step={0.01} editable
              format={(v) => `${Math.round((v + 0.5) * 100)}%`}
              onChange={(v) => set('background', { ...bg, offsetY: v })} />
          </>
        )}
      </div>

      <div style={S.divider} />

      {/* 阴影 */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ color: '#eee', fontSize: 12, fontWeight: 600 }}>阴影</span>
          <ToggleBtn active={sh.enabled} onClick={() => set('shadow', { ...sh, enabled: !sh.enabled })}>{sh.enabled ? '开' : '关'}</ToggleBtn>
        </div>
        {sh.enabled && (
          <>
            <div style={S.row}>
              <span style={S.label}>颜色</span>
              <input type="color" value={sh.color} onChange={(e) => set('shadow', { ...sh, color: e.target.value })}
                style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
            </div>
            <ParamSlider label="不透明度" value={sh.opacity} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => set('shadow', { ...sh, opacity: v })} />
            <ParamSlider label="模糊度" value={sh.blur} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => set('shadow', { ...sh, blur: v })} />
            <ParamSlider label="距离" value={sh.distance} min={0} max={100} step={1} editable onChange={(v) => set('shadow', { ...sh, distance: v })} />
            <ParamSlider label="角度" value={sh.angle} min={-180} max={180} step={1} unit="°" editable onChange={(v) => set('shadow', { ...sh, angle: v })} />
          </>
        )}
      </div>
    </div>
  );
}

// 字幕标签页（两级编辑：① 整轨统一样式 ② 本句字/词级文字编辑）
function SubtitleTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const { applyToAll, toggleApplyToAll } = useSubtitleEditStore();
  const s: SubtitleContent = clip.subtitle || { items: [] as any[], fontFamily: undefined, fontSize: 24, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, strokeOpacity: 1, position: 'bottom' as const };
  const items: { start: number; end: number; text: string }[] = s.items || [];
  // 自由定位显示值（与预览回退逻辑一致）：posX/posY 优先，否则由 position/align 推导
  const curPosX = s.posX ?? (s.align === 'left' ? 0.12 : s.align === 'right' ? 0.88 : 0.5);
  const curPosY = s.posY ?? (s.position === 'top' ? 0.15 : s.position === 'center' ? 0.5 : 0.85);

  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  // 背景 / 阴影默认值（与 TextTab 一致）
  const bgDefault: TextBackground = { enabled: false, color: '#000000', opacity: 0.9, radius: 0.06, width: 0.19, height: 0.13, offsetX: 0.5, offsetY: 0.5 };
  const shDefault: TextShadow = { enabled: false, color: '#000000', opacity: 0.9, blur: 0.15, distance: 5, angle: -45 };
  const bg = { ...bgDefault, ...(s.background || {}) };
  const sh = { ...shDefault, ...(s.shadow || {}) };
  // 嵌套字段（背景/阴影）合并写入；applyToAll 时同步整轨
  const patchSubtitle = (patch: Partial<SubtitleContent>) => {
    if (applyToAll) {
      const track = useProjectStore.getState().project.tracks.find((t) => t.id === trackId);
      if (track) {
        track.clips.forEach((c) => {
          if (c.subtitle) updateClip(trackId, c.id, { subtitle: { ...c.subtitle, ...patch } } as Partial<ClipConfig>);
        });
        return;
      }
    }
    updateClip(trackId, clip.id, { subtitle: { ...s, ...patch } } as Partial<ClipConfig>);
  };
  const setBg = (partial: Partial<TextBackground>) => patchSubtitle({ background: { ...bgDefault, ...(s.background || {}), ...partial } });
  const setSh = (partial: Partial<TextShadow>) => patchSubtitle({ shadow: { ...shDefault, ...(s.shadow || {}), ...partial } });

  // ① 整轨统一样式写入：applyToAll 时把同名样式字段同步到「同轨道所有字幕 clip」（不含文字内容）
  const setStyle = (k: string, v: any) => {
    if (applyToAll) {
      const track = useProjectStore.getState().project.tracks.find((t) => t.id === trackId);
      if (track) {
        track.clips.forEach((c) => {
          if (c.subtitle) updateClip(trackId, c.id, { subtitle: { ...c.subtitle, [k]: v } } as Partial<ClipConfig>);
        });
        return;
      }
    }
    updateClip(trackId, clip.id, { subtitle: { ...s, [k]: v } } as Partial<ClipConfig>);
  };
  const applyPreset = (p: typeof SUBTITLE_STYLE_PRESETS[number]) => {
    const patch = { fontFamily: p.fontId, color: p.color, strokeColor: p.strokeColor, strokeWidth: p.strokeWidth, strokeOpacity: p.strokeOpacity ?? 1 };
    if (applyToAll) {
      const track = useProjectStore.getState().project.tracks.find((t) => t.id === trackId);
      if (track) {
        track.clips.forEach((c) => {
          if (c.subtitle) updateClip(trackId, c.id, { subtitle: { ...c.subtitle, ...patch } } as Partial<ClipConfig>);
        });
        return;
      }
    }
    updateClip(trackId, clip.id, { subtitle: { ...s, ...patch } } as Partial<ClipConfig>);
  };

  // ② 本句字/词级文字编辑：始终只改当前 clip（对应「具体的某个字或词组」）
  const setItems = (next: typeof items) => updateClip(trackId, clip.id, { subtitle: { ...s, items: next } } as Partial<ClipConfig>);
  const updateItem = (i: number, patch: Partial<{ start: number; end: number; text: string }>) =>
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const deleteItem = (i: number) => setItems(items.filter((_, idx) => idx !== i));
  const addItem = () => {
    const lastEnd = items.length ? items[items.length - 1].end : 0;
    setItems([...items, { start: lastEnd, end: lastEnd + 2, text: '新字幕' }]);
  };

  // 文字框：撑满可用宽度（修复右侧留白过大）
  const textareaStyle: CSSProperties = {
    width: '100%', boxSizing: 'border-box', background: '#0f3460',
    border: '1px solid #1a1a2e', borderRadius: 4, color: '#eee',
    padding: '6px 8px', fontSize: 12, resize: 'vertical', minWidth: 0,
  };

  return (
    <div style={{ padding: 8 }}>
      {/* 两级编辑开关 */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, padding: '6px 8px', background: '#0f3460', borderRadius: 4, cursor: 'pointer', userSelect: 'none' }}>
        <input type="checkbox" checked={applyToAll} onChange={toggleApplyToAll} style={{ cursor: 'pointer' }} />
        <span style={{ fontSize: 12, color: '#ccc' }}>样式应用到本轨道所有字幕</span>
      </label>

      {/* ① 整轨统一样式 */}
      <div style={{ ...S.item, marginBottom: 10, border: '1px solid #1a1a2e' }}>
        <div style={{ fontSize: 12, color: '#7fd1ff', marginBottom: 8, fontWeight: 600 }}>① 统一样式（{applyToAll ? '整轨' : '仅本句'}）</div>
        <div style={{ marginBottom: 8 }}>
          <div style={S.label}>字体</div>
          <FontSelect value={s.fontFamily} onChange={(id) => setStyle('fontFamily', id)} />
        </div>
        <StylePresetRow onApply={applyPreset} />
        <ParamSlider label="字号" value={s.fontSize ?? 24} min={12} max={120} step={1} editable onChange={(v) => setStyle('fontSize', v)} />
        <div style={S.row}>
          <span style={S.label}>颜色</span>
          <input type="color" value={s.color ?? '#ffffff'} onChange={(e) => setStyle('color', e.target.value)}
            style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
        </div>
        <div style={S.row}>
          <span style={S.label}>描边色</span>
          <input type="color" value={s.strokeColor ?? '#000000'} onChange={(e) => setStyle('strokeColor', e.target.value)}
            style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
        </div>
        <ParamSlider label="粗细" value={s.strokeWidth ?? 0} min={0} max={18} step={0.5} editable onChange={(v) => setStyle('strokeWidth', v)} />
        <ParamSlider label="描边不透明度" value={s.strokeOpacity ?? 1} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => setStyle('strokeOpacity', v)} />
        {/* 自由定位：X/Y 归一化坐标（0..100%，画布中心=50%），支持滑杆 + 数值输入 + 预览拖拽 */}
        <ParamSlider label="水平位置 X" value={Math.round(curPosX * 100)} min={0} max={100} step={1} unit="%" editable
          onChange={(v) => patchSubtitle({ posX: v / 100 })} onEditStart={pushHistorySnapshot} />
        <ParamSlider label="垂直位置 Y" value={Math.round(curPosY * 100)} min={0} max={100} step={1} unit="%" editable
          onChange={(v) => patchSubtitle({ posY: v / 100 })} onEditStart={pushHistorySnapshot} />
        {/* 快捷预设：写 posX/posY，等效于旧的上中下/左右（兼容旧档） */}
        <div style={S.row}>
          <span style={S.label}>快捷</span>
          <ToggleBtn active={false} onClick={() => patchSubtitle({ posX: 0.5, posY: 0.85 })}>底部</ToggleBtn>
          <ToggleBtn active={false} onClick={() => patchSubtitle({ posX: 0.5, posY: 0.5 })}>居中</ToggleBtn>
          <ToggleBtn active={false} onClick={() => patchSubtitle({ posX: 0.5, posY: 0.15 })}>顶部</ToggleBtn>
          <ToggleBtn active={false} onClick={() => patchSubtitle({ posX: 0.12 })}>左</ToggleBtn>
          <ToggleBtn active={false} onClick={() => patchSubtitle({ posX: 0.5 })}>中</ToggleBtn>
          <ToggleBtn active={false} onClick={() => patchSubtitle({ posX: 0.88 })}>右</ToggleBtn>
        </div>
        <ParamSlider label="时间偏移" value={s.timeOffset ?? 0} min={-2} max={2} step={0.05} unit="s" editable
          format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}s`}
          onChange={(v) => patchSubtitle({ timeOffset: v })} onEditStart={pushHistorySnapshot} />

        {/* 背景 */}
        <div style={S.divider} />
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#eee', fontSize: 12, fontWeight: 600 }}>背景</span>
            <ToggleBtn active={bg.enabled} onClick={() => setBg({ enabled: !bg.enabled })}>{bg.enabled ? '开' : '关'}</ToggleBtn>
          </div>
          {bg.enabled && (<>
            <div style={S.row}>
              <span style={S.label}>颜色</span>
              <input type="color" value={bg.color} onChange={(e) => setBg({ color: e.target.value })}
                style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
            </div>
            <ParamSlider label="不透明度" value={bg.opacity} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => setBg({ opacity: v })} />
            <ParamSlider label="宽度" value={bg.width} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => setBg({ width: v })} />
            <ParamSlider label="高度" value={bg.height} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => setBg({ height: v })} />
            <ParamSlider label="圆角" value={bg.radius} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => setBg({ radius: v })} />
            <ParamSlider label="左右偏移" value={bg.offsetX} min={-0.5} max={0.5} step={0.01} editable
              format={(v) => `${Math.round((v + 0.5) * 100)}%`} onChange={(v) => setBg({ offsetX: v })} />
            <ParamSlider label="上下偏移" value={bg.offsetY} min={-0.5} max={0.5} step={0.01} editable
              format={(v) => `${Math.round((v + 0.5) * 100)}%`} onChange={(v) => setBg({ offsetY: v })} />
          </>)}
        </div>

        {/* 阴影 */}
        <div style={S.divider} />
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#eee', fontSize: 12, fontWeight: 600 }}>阴影</span>
            <ToggleBtn active={sh.enabled} onClick={() => setSh({ enabled: !sh.enabled })}>{sh.enabled ? '开' : '关'}</ToggleBtn>
          </div>
          {sh.enabled && (<>
            <div style={S.row}>
              <span style={S.label}>颜色</span>
              <input type="color" value={sh.color} onChange={(e) => setSh({ color: e.target.value })}
                style={{ width: 40, height: 28, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent' }} />
            </div>
            <ParamSlider label="不透明度" value={sh.opacity} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => setSh({ opacity: v })} />
            <ParamSlider label="模糊度" value={sh.blur} min={0} max={1} step={0.01} unit="%" editable onChange={(v) => setSh({ blur: v })} />
            <ParamSlider label="距离" value={sh.distance} min={0} max={100} step={1} editable onChange={(v) => setSh({ distance: v })} />
            <ParamSlider label="角度" value={sh.angle} min={-180} max={180} step={1} unit="°" editable onChange={(v) => setSh({ angle: v })} />
          </>)}
        </div>
      </div>

      {/* ② 本句字/词级文字编辑 */}
      <div style={{ fontSize: 12, color: '#7fd1ff', marginBottom: 4, fontWeight: 600 }}>② 本句文字（逐字 / 词编辑）</div>
      <div style={{ fontSize: 11, color: '#889', marginBottom: 8, lineHeight: 1.5 }}>选中本轨道上的某条字幕片段即显示其文字，可在下方改错字、增删词（仅影响本句，不改动整轨样式）。</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: '#aaa' }}>共 {items.length} 条</span>
        <button style={S.btn} onClick={addItem}>+ 添加字幕条</button>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 8 }}>
        {items.length === 0 && <div style={{ fontSize: 11, color: '#888' }}>暂无字幕条，点上方「+ 添加字幕条」</div>}
        {items.map((item, i) => (
          <div key={i} style={{ ...S.item, border: '1px solid #1a1a2e', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
              <input
                type="number" step="0.1" value={Number(item.start.toFixed(2))}
                onChange={(e) => updateItem(i, { start: Math.max(0, Number(e.target.value)) })}
                style={{ ...S.input, width: 62 }}
                title="开始时间(秒)"
              />
              <span style={{ color: '#888', fontSize: 11 }}>→</span>
              <input
                type="number" step="0.1" value={Number(item.end.toFixed(2))}
                onChange={(e) => updateItem(i, { end: Math.max(Number(item.start) + 0.1, Number(e.target.value)) })}
                style={{ ...S.input, width: 62 }}
                title="结束时间(秒)"
              />
              <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => deleteItem(i)}>删除</button>
            </div>
            <textarea
              value={item.text}
              onChange={(e) => updateItem(i, { text: e.target.value })}
              rows={2}
              style={textareaStyle}
              placeholder="字幕文字（可改具体字 / 词）"
            />
          </div>
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
  // 抠像属性新增关键帧时，默认取当前 keying 参数值（避免相似性默认 0=全抠的灾难初值）
  const kfField = prop.startsWith('keying.')
    ? (prop.slice('keying.'.length) as 'similarity' | 'edgeSoftness' | 'spill' | 'threshold')
    : null;
  // 抠像属性新增关键帧时，默认取当前参数值（避免相似性默认 0=全抠的灾难初值；threshold 默认 0.5）
  const addValue = kfField && clip.keying
    ? ((clip.keying as any)[kfField] ?? (kfField === 'threshold' ? 0.5 : 0))
    : 0;
  const add = () => setKfs([...kfs, { time: currentTime, value: addValue, easing: '线性' }].sort((a, b) => a.time - b.time));
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
  const setSpeedLive = useProjectStore((s) => s.setSpeedLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const setCurveLive = useProjectStore((s) => s.setCurveLive);
  const setCurveCommit = useProjectStore((s) => s.setCurveCommit);
  const setFreezeCommit = useProjectStore((s) => s.setFreezeCommit);
  const speed = clip.speed ?? 1;
  const dur = clip.timelineOut - clip.timelineIn;
  const srcDur = clip.src_range.end - clip.src_range.start;
  const setSpeed = (v: number) => setSpeedLive(trackId, clip.id, v);

  const remap: TimeRemapConfig = clip.time_remap ?? { reverse: false, freeze: null, curve: [] as SpeedPointConfig[] };
  const reverse = remap.reverse ?? false;
  const freeze: FreezeConfig | null = remap.freeze ?? null;
  const curve: SpeedPointConfig[] = remap.curve ?? [];
  const hasCurve = curve.length > 0;

  const toggleReverse = () => updateClip(trackId, clip.id, { time_remap: { ...remap, reverse: !reverse } });
  // 冻结开关/字段走 setFreezeCommit：自动把 freeze.duration 计入 timelineOut 并 ripple 同轨后续片段，
  // 与后端 effective_off 配套，使退出冻结平滑无跳变、整段素材恰好播完。
  const setFreezeEnabled = (on: boolean) =>
    setFreezeCommit(trackId, clip.id, on ? { start: 0, sourceTime: 0, duration: 1 } : null);
  const setFreezeField = (k: keyof FreezeConfig, v: number) =>
    setFreezeCommit(trackId, clip.id, { ...freeze!, [k]: v });
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
      <ParamSlider label="播放速度" value={speed} min={0.25} max={4} step={0.05} unit="x" editable onChange={setSpeed} onEditStart={pushHistorySnapshot} />
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
  { value: 'wipe', label: '擦除' },
];
// 由预设对象构造写入 transition 的字段；只写 preset 中存在的字段，缺失字段传 undefined 由 store omit
function buildPresetTransition(p: { type: TransitionType; duration: number; direction?: WipeDirection; easing?: TransitionEasing; feather?: number; blurAmount?: number; maskShape?: WipeMaskShape }) {
  return {
    transitionType: p.type,
    duration: p.duration,
    direction: p.direction,
    easing: p.easing ?? 'ease-in-out',
    feather: p.feather,
    blurAmount: p.blurAmount,
    maskShape: p.maskShape,
  };
}

// 转场预设库（覆盖市场调研 Top10「丝滑主力」；每项带 easing 落实自然出厂默认）
const TRANSITION_PRESETS: {
  key: string; label: string; type: TransitionType; duration: number;
  direction?: WipeDirection; easing: TransitionEasing; feather?: number;
  blurAmount?: number; maskShape?: WipeMaskShape;
}[] = [
  { key: 'none', label: '硬切', type: 'none', duration: 0, easing: 'ease-in-out' },
  { key: 'dissolve', label: '交叉溶解', type: 'dissolve', duration: 0.5, easing: 'ease-in-out' },
  { key: 'fade', label: '淡出黑场', type: 'fade', duration: 1.0, easing: 'ease-in-out' },
  { key: 'slideR', label: '向右滑动', type: 'slide', duration: 0.4, direction: 'right', easing: 'ease-in-out' },
  { key: 'slideL', label: '向左滑动', type: 'slide', duration: 0.4, direction: 'left', easing: 'ease-in-out' },
  { key: 'slideU', label: '向上滑动', type: 'slide', duration: 0.4, direction: 'up', easing: 'ease-in-out' },
  { key: 'slideD', label: '向下滑动', type: 'slide', duration: 0.4, direction: 'down', easing: 'ease-in-out' },
  { key: 'zoom', label: '缩放推进', type: 'zoom', duration: 0.4, easing: 'ease-in-out' },
  { key: 'wipeR', label: '线性擦除·右', type: 'wipe', duration: 0.8, direction: 'right', easing: 'ease-in-out', feather: 10, maskShape: 'linear' },
  { key: 'wipeL', label: '线性擦除·左', type: 'wipe', duration: 0.8, direction: 'left', easing: 'ease-in-out', feather: 10, maskShape: 'linear' },
  { key: 'wipeCircle', label: '圆形擦除', type: 'wipe', duration: 0.8, easing: 'ease-in-out', feather: 10, maskShape: 'circle' },
  { key: 'blur', label: '模糊过渡', type: 'blur', duration: 0.4, easing: 'ease-in-out', blurAmount: 65 },
  { key: 'flash', label: '闪白', type: 'flash', duration: 0.2, easing: 'ease-in-out' },
];
function TransitionTab({ clip, trackId }: { clip: ClipConfig; trackId: string }) {
  const updateClip = useProjectStore((s) => s.updateClip);
  const updateClipLive = useProjectStore((s) => s.updateClipLive);
  const pushHistorySnapshot = useProjectStore((s) => s.pushHistorySnapshot);
  const project = useProjectStore((s) => s.project);
  const tr: TransitionConfig = clip.transition || { transitionType: 'none', duration: 0.5 };
  const [activePreset, setActivePreset] = useState<typeof TRANSITION_PRESETS[number] | null>(null);
  const setType = (t: TransitionType) => updateClip(trackId, clip.id, { transition: { ...tr, transitionType: t } });
  const setDur = (d: number) => updateClipLive(trackId, clip.id, { transition: { ...tr, duration: d } });
  const setDir = (d: WipeDirection) => updateClip(trackId, clip.id, { transition: { ...tr, direction: d } });
  // 复用现有相邻片段判定：同轨内某片段存在「下一片段起点 ≈ 本片段终点」即视为相邻出片段
  const applyToAll = () => {
    const base = activePreset ? buildPresetTransition(activePreset) : { ...tr };
    for (const track of project.tracks.filter((t) => t.type === 'video' || t.type === 'audio')) {
      for (const c of track.clips) {
        const hasNext = track.clips.some((n) => n.id !== c.id && n.timelineIn >= c.timelineOut - 1e-4);
        if (hasNext) updateClip(track.id, c.id, { transition: base });
      }
    }
  };
  return (
    <div>
      {/* 克制引导：提示用户克制使用转场，落实自然观感的出厂默认 */}
      <div style={{ background: 'rgba(15,52,96,0.6)', border: '1px solid #0f3460', borderRadius: 4, padding: '6px 8px', fontSize: 11, color: '#cfd8e8', lineHeight: 1.5, marginBottom: 10 }}>
        💡 丝滑法则：整片转场种类 ≤ 3 种；每 10 秒 ≤ 1 个转场。缓动默认 ease-in-out、遮罩默认羽化，已是自然观感。
      </div>
      <div style={S.row}>
        <span style={S.label}>类型</span>
        <select style={S.input} value={tr.transitionType ?? 'none'} onChange={(e) => setType(e.target.value as TransitionType)}>
          {TRANSITION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <ParamSlider label="时长" value={tr.duration ?? 0.5} min={0.1} max={3} step={0.1} unit="s" editable onChange={setDur} onEditStart={pushHistorySnapshot} />
      {tr.transitionType === 'wipe' && (
        <div style={S.row}>
          <span style={S.label}>方向</span>
          <select style={S.input} value={tr.direction ?? 'right'} onChange={(e) => setDir(e.target.value as WipeDirection)}>
            <option value="right">向右</option>
            <option value="left">向左</option>
            <option value="up">向上</option>
            <option value="down">向下</option>
          </select>
        </div>
      )}
      <div style={{ margin: '10px 0' }}>
        <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>常用预设（点击应用到当前片段）</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TRANSITION_PRESETS.map((p) => (
            <button key={p.key} style={{ ...S.btn, fontSize: 11, padding: '4px 8px' }}
              onClick={() => { setActivePreset(p); updateClip(trackId, clip.id, { transition: buildPresetTransition(p) }); }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <button style={{ ...S.btn, fontSize: 11, marginTop: 6 }} onClick={applyToAll}>
        应用到全部相邻片段
      </button>
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
  const project = useProjectStore((s) => s.project);
  const selTrack = sel ? project.tracks.find((t) => t.id === sel.trackId) : undefined;
  // 按素材类型取分组 tab；当前激活的一级 tab 不在分组内则回退到首个
  const category: Category = sel ? clipCategory(sel.clip, selTrack?.type) : 'video';
  const groups = PANEL_GROUPS[category];
  const tab = groups.find((g) => g.key === activeTab) ?? groups[0];
  const subs = tab.subs;
  const [sub, setSub] = useState(subs ? subs[0].key : '');
  const effSub = subs ? (subs.find((s) => s.key === sub) ? sub : subs[0].key) : '';

  // 渲染当前一级 tab（及其二级 tab）对应的内容
  const renderContent = () => {
    const { clip, trackId } = sel!;
    if (tab.key === 'visual') {
      if (effSub === 'keying') return <KeyingTab clip={clip} trackId={trackId} />;
      if (effSub === 'mask') return <MaskTab clip={clip} trackId={trackId} />;
      return <TransformTab clip={clip} trackId={trackId} />; // base
    }
    if (tab.key === 'audio') return <AudioTab clip={clip} trackId={trackId} />;
    if (tab.key === 'speed') return <SpeedTab clip={clip} trackId={trackId} />;
    if (tab.key === 'anim') return <TransitionTab clip={clip} trackId={trackId} />;
    if (tab.key === 'adjust') return (
      <div>
        <div style={{ color: '#aaa', fontSize: 11, margin: '2px 0 6px' }}>滤镜</div>
        <ItemsTab clip={clip} trackId={trackId} kind="filters" />
        <div style={S.divider} />
        <div style={{ color: '#aaa', fontSize: 11, margin: '2px 0 6px' }}>特效</div>
        <ItemsTab clip={clip} trackId={trackId} kind="effects" />
      </div>
    );
    if (tab.key === 'kf') return <KeyframesTab clip={clip} trackId={trackId} />;
    if (tab.key === 'text') return <TextTab clip={clip} trackId={trackId} />;
    if (tab.key === 'subtitle') return <SubtitleTab clip={clip} trackId={trackId} />;
    return <TransformTab clip={clip} trackId={trackId} />;
  };

  return (
    <div style={S.panel}>
      <div style={S.tabs}>
        {groups.map((g) => (
          <button key={g.key} style={S.tab(activeTab === g.key)} onClick={() => setActiveTab(g.key)}>{g.label}</button>
        ))}
      </div>
      {subs && (
        <div style={S.subtabs}>
          {subs.map((s) => (
            <button key={s.key} style={S.subtab(effSub === s.key)} onClick={() => setSub(s.key)}>{s.label}</button>
          ))}
        </div>
      )}
      <div style={S.content}>
        {!sel ? <ProjectInfo /> : renderContent()}
      </div>
    </div>
  );
}
