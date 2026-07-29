// 共享片段工厂：把"建轨 + 加片段 + 选中"等重复逻辑集中，供左侧面板各组件复用。
// 所有函数直接读/写 project store 与 ui store，调用方无需关心轨道查找细节。
import type { AssetConfig, ClipConfig, KeyingConfig, MaskConfig } from '../types';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';

// 生成唯一ID
export const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// 解析 SRT 字幕文本为定时条目（兼容空行分隔的块状格式）
export function parseSRT(srt: string): { start: number; end: number; text: string }[] {
  const blocks = srt.trim().split(/\n\s*\n+/);
  const out: { start: number; end: number; text: string }[] = [];
  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    // 找包含 "-->" 的时间轴行
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const times = lines[idx].split('-->');
    const toSec = (t: string): number => {
      const m = t.trim().match(/(?:(\d+):)?(?:(\d+):)?(\d+)[.,](\d+)/);
      if (!m) return 0;
      const h = Number(m[1] || 0), mn = Number(m[2] || 0), s = Number(m[3]), ms = Number(m[4]);
      return h * 3600 + mn * 60 + s + ms / 1000;
    };
    const start = toSec(times[0] || '0');
    const end = toSec(times[1] || '0');
    const text = lines.slice(idx + 1).join('\n');
    if (text) out.push({ start, end, text });
  }
  return out;
}

// 确保存在指定类型的轨道，返回其 id（找不到则新建）
export function ensureTrack(type: 'video' | 'audio' | 'text' | 'sticker' | 'subtitle'): string | null {
  const p = useProjectStore.getState();
  let track = p.project.tracks.find((t) => t.type === type);
  if (!track) {
    const id = p.addTrack(type);
    track = useProjectStore.getState().project.tracks.find((t) => t.id === id);
  }
  return track ? track.id : null;
}

// 往指定类型轨道追加片段并选中（自动建轨）
export function addClipToTrack(type: 'video' | 'audio' | 'text' | 'sticker' | 'subtitle', clip: ClipConfig): void {
  const trackId = ensureTrack(type);
  if (!trackId) return;
  const p = useProjectStore.getState();
  p.addClip(trackId, clip);
  useUIStore.getState().selectClip(trackId, clip.id);
}

// 生成一段文字片段（与之前 Timeline.handleAddText 的结构一致）
export function createTextClip(timelineIn = 0, duration = 5): ClipConfig {
  return {
    id: uid('clip'),
    assetId: '_text',
    src_range: { start: 0, end: duration },
    timelineIn,
    timelineOut: timelineIn + duration,
    text: { content: '新文字', fontSize: 48, color: '#ffffff', textAlign: 'center', x: 0.5, y: 0.5 },
  };
}

// 添加一段文字到文字轨并选中
export function addTextClip(): void {
  const p = useProjectStore.getState();
  let track = p.project.tracks.find((t) => t.type === 'text');
  if (!track) {
    const id = p.addTrack('text');
    track = useProjectStore.getState().project.tracks.find((t) => t.id === id);
    if (!track) return;
  }
  const lastEnd = track.clips.length > 0
    ? Math.max(...track.clips.map((c) => c.timelineOut))
    : 0;
  const clip = createTextClip(lastEnd);
  p.addClip(track.id, clip);
  useUIStore.getState().selectClip(track.id, clip.id);
}

// 导入解析后的字幕条目到字幕轨
export function addSubtitleClip(items: { start: number; end: number; text: string }[]): void {
  if (items.length === 0) return;
  const totalDuration = items[items.length - 1].end;
  const clip: ClipConfig = {
    id: uid('clip'),
    assetId: '_subtitle',
    src_range: { start: 0, end: totalDuration },
    timelineIn: 0,
    timelineOut: totalDuration,
    subtitle: { items, fontSize: 24, color: '#ffffff', position: 'bottom' },
  };
  addClipToTrack('subtitle', clip);
}

// 生成一段图片贴纸片段
export function createImageStickerClip(asset: AssetConfig, timelineIn = 0): ClipConfig {
  const dur = asset.duration || 5;
  return {
    id: uid('clip'),
    assetId: asset.id,
    src_range: { start: 0, end: dur },
    timelineIn,
    timelineOut: timelineIn + dur,
    transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    volume: 1, speed: 1,
    effects: [], masks: [] as MaskConfig[], filters: [], keyframes: {},
    keying: undefined,
  };
}

// 生成一段默认抠像配置（M1 仅 chroma 色度抠图可用）
export function createDefaultKeying(): KeyingConfig {
  return {
    enabled: true,
    mode: 'chroma',
    color: '#00ff00',
    similarity: 0.4,
    edgeSoftness: 0.1,
    spill: 0.5,
    model: 'modnet',
    threshold: 0.5,
  };
}
