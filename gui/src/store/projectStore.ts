// 工程 Store：管理当前编辑工程的数据与操作
// 所有修改操作前先 pushSnapshot 到 historyStore，修改后标记 isDirty
// 轨道排序规则：text/sticker/effect (顶) → video (中, 主轨最下) → audio (底)
import { create } from 'zustand';
import type { ProjectConfig, AssetConfig, ClipConfig, TransformConfig, TrackConfig } from '../types';
import { useHistoryStore } from './historyStore';
import { useUIStore } from './uiStore';

const TYPE_PRIORITY: Record<string, number> = {
  text: 0, sticker: 0, effect: 0,
  video: 1,
  audio: 2,
};

export const sortTracks = (tracks: TrackConfig[]): TrackConfig[] => {
  return [...tracks].sort((a, b) => {
    const pa = TYPE_PRIORITY[a.type] ?? 1;
    const pb = TYPE_PRIORITY[b.type] ?? 1;
    if (pa !== pb) return pa - pb;
    // 同类型内：video 主轨排最下
    if (a.type === 'video' && b.type === 'video') {
      if (a.isMain && !b.isMain) return 1;
      if (!a.isMain && b.isMain) return -1;
    }
    return (a.order ?? 0) - (b.order ?? 0);
  });
};

const calcInsertIndex = (tracks: TrackConfig[], type: string): number => {
  const priority = TYPE_PRIORITY[type] ?? 1;
  for (let i = tracks.length - 1; i >= 0; i--) {
    const t = tracks[i];
    const tp = TYPE_PRIORITY[t.type] ?? 1;
    if (tp < priority) return i + 1;
    if (tp > priority) continue;
    if (t.type === 'video' && t.isMain) continue;
    return i + 1;
  }
  return 0;
};

// 主轨左对齐重排：片段按 timelineIn 排序后依次紧贴排列（cursor 累加），时间从 0 起
// 仅在 magneticSnap 开启时调用
const realignMainTrack = (tracks: TrackConfig[]): TrackConfig[] => {
  const mainTrack = tracks.find(t => t.type === 'video' && t.isMain);
  if (!mainTrack || mainTrack.clips.length === 0) return tracks;
  const sorted = [...mainTrack.clips].sort((a, b) => a.timelineIn - b.timelineIn);
  let cursor = 0;
  const realigned = sorted.map(c => {
    const dur = c.timelineOut - c.timelineIn;
    const nc = { ...c, timelineIn: cursor, timelineOut: cursor + dur };
    cursor += dur;
    return nc;
  });
  return tracks.map(t => t.id === mainTrack.id ? { ...t, clips: realigned } : t);
};

// 修改辅助：如 magneticSnap 开启且涉及主轨，自动 realign
const withMainTrackRealign = (p: ProjectConfig): ProjectConfig => {
  if (useUIStore.getState().magneticSnap) {
    return { ...p, tracks: realignMainTrack(p.tracks) };
  }
  return p;
};

interface ProjectState {
  project: ProjectConfig;
  isDirty: boolean;
  filePath: string | null;
  setProject: (p: ProjectConfig) => void;
  newProject: () => void;
  loadProject: (path: string) => Promise<void>;
  saveProject: (path?: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  addAsset: (asset: AssetConfig) => void;
  removeAsset: (id: string) => void;
  addTrack: (type: 'video' | 'audio' | 'text' | 'sticker' | 'subtitle') => string;  // 返回新轨 id
  insertTrackAt: (index: number, type: 'video' | 'audio' | 'text' | 'sticker' | 'subtitle') => string;
  removeTrack: (id: string) => void;
  toggleTrackLock: (id: string) => void;
  toggleTrackVisible: (id: string) => void;
  toggleTrackMute: (id: string) => void;
  toggleTrackSolo: (id: string) => void;
  updateTrackVolume: (id: string, volume: number) => void;
  updateTrackPan: (id: string, pan: number) => void;
  addClip: (trackId: string, clip: ClipConfig) => void;
  removeClip: (trackId: string, clipId: string) => void;
  updateClip: (trackId: string, clipId: string, updates: Partial<ClipConfig>) => void;
  setSpeed: (trackId: string, clipId: string, speed: number) => void;
  splitClip: (trackId: string, clipId: string, time: number) => void;
  moveClip: (trackId: string, clipId: string, newTimelineIn: number, skipRealign?: boolean) => void;
  moveClipToTrack: (srcTrackId: string, clipId: string, destTrackId: string, newTimelineIn: number) => void;
  updateTransform: (trackId: string, clipId: string, key: keyof TransformConfig, value: number) => void;
  getMainVideoTrack: () => TrackConfig | undefined;
}

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const clone = (p: ProjectConfig): ProjectConfig => JSON.parse(JSON.stringify(p));

export const useProjectStore = create<ProjectState>((set, get) => {
  // 修改辅助：先存快照，再应用变更并标记 isDirty
  const mutate = (fn: (p: ProjectConfig) => ProjectConfig) => {
    useHistoryStore.getState().pushSnapshot(clone(get().project));
    set({ project: fn(get().project), isDirty: true });
  };
  // 更新指定轨道内片段
  const mapTrackClips = (p: ProjectConfig, trackId: string, fn: (clips: ClipConfig[]) => ClipConfig[]) => ({
    ...p, tracks: p.tracks.map((t) => t.id === trackId ? { ...t, clips: fn(t.clips) } : t),
  });

  return {
    project: { canvas: { width: 1920, height: 1080, fps: 30 }, assets: [], tracks: [{ id: uid('track'), type: 'video', order: 0, clips: [], locked: false, visible: true, muted: false, solo: false, isMain: true, volume: 1, pan: 0 }] },
    isDirty: false,
    filePath: null,
    setProject: (p) => {
      // 确保加载的工程有主视频轨
      const tracks = sortTracks(p.tracks);
      if (!tracks.some(t => t.type === 'video' && t.isMain)) {
        const mainIdx = tracks.findIndex(t => t.type === 'video');
        if (mainIdx >= 0) tracks[mainIdx] = { ...tracks[mainIdx], isMain: true };
      }
      set({ project: { ...p, tracks }, isDirty: false });
    },
    newProject: () => {
      useHistoryStore.getState().clear();
      set({
        project: {
          version: '1.0.0', canvas: { width: 1920, height: 1080, fps: 30 },
          assets: [],
          tracks: [{ id: uid('track'), type: 'video', order: 0, clips: [], locked: false, visible: true, muted: false, solo: false, isMain: true, volume: 1, pan: 0 }],
        },
        isDirty: false, filePath: null,
      });
    },
    loadProject: async (path) => {
      const raw = await window.aicut.loadProject(path);
      useHistoryStore.getState().clear();
      const parsed = JSON.parse(raw);
      // 确保加载的工程有主视频轨
      const tracks = sortTracks(parsed.tracks || []);
      if (!tracks.some(t => t.type === 'video' && t.isMain)) {
        const mainIdx = tracks.findIndex(t => t.type === 'video');
        if (mainIdx >= 0) tracks[mainIdx] = { ...tracks[mainIdx], isMain: true };
        else tracks.push({ id: uid('track'), type: 'video', order: 0, clips: [], locked: false, visible: true, muted: false, solo: false, isMain: true, volume: 1, pan: 0 });
      }
      set({ project: { ...parsed, tracks }, isDirty: false, filePath: path });
    },
    saveProject: async (path) => {
      const target = path ?? get().filePath;
      if (!target) throw new Error('未指定保存路径');
      await window.aicut.saveProject(target, JSON.stringify(get().project, null, 2));
      set({ isDirty: false, filePath: target });
    },
    undo: () => {
      const snapshot = useHistoryStore.getState().undo();
      if (snapshot) {
        const tracks = sortTracks(snapshot.tracks);
        set({ project: { ...snapshot, tracks }, isDirty: true });
      }
    },
    redo: () => {
      const snapshot = useHistoryStore.getState().redo();
      if (snapshot) {
        const tracks = sortTracks(snapshot.tracks);
        set({ project: { ...snapshot, tracks }, isDirty: true });
      }
    },
    addAsset: (asset) => mutate((p) => ({ ...p, assets: [...p.assets, asset] })),
    removeAsset: (id) => mutate((p) => ({ ...p, assets: p.assets.filter((a) => a.id !== id) })),
    addTrack: (type) => {
      const newId = uid('track');
      mutate((p) => {
        const insertAt = calcInsertIndex(p.tracks, type);
        const newTrack: TrackConfig = { id: newId, type, order: p.tracks.length, clips: [], locked: false, visible: true, muted: false, solo: false, volume: 1, pan: 0 };
        const tracks = [...p.tracks.slice(0, insertAt), newTrack, ...p.tracks.slice(insertAt)];
        return { ...p, tracks };
      });
      return newId;
    },
    insertTrackAt: (index, type) => {
      const newId = uid('track');
      mutate((p) => {
        const clamped = Math.max(0, Math.min(index, p.tracks.length));
        const newTrack: TrackConfig = { id: newId, type, order: p.tracks.length, clips: [], locked: false, visible: true, muted: false, solo: false, volume: 1, pan: 0 };
        const tracks = sortTracks([...p.tracks.slice(0, clamped), newTrack, ...p.tracks.slice(clamped)]);
        return { ...p, tracks };
      });
      return newId;
    },
    removeTrack: (id) => mutate((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== id) })),
    toggleTrackLock: (id) => mutate((p) => ({ ...p, tracks: p.tracks.map((t) => t.id === id ? { ...t, locked: !t.locked } : t) })),
    toggleTrackVisible: (id) => mutate((p) => ({ ...p, tracks: p.tracks.map((t) => t.id === id ? { ...t, visible: !t.visible } : t) })),
    toggleTrackMute: (id) => mutate((p) => ({ ...p, tracks: p.tracks.map((t) => t.id === id ? { ...t, muted: !t.muted } : t) })),
    toggleTrackSolo: (id) => mutate((p) => ({ ...p, tracks: p.tracks.map((t) => t.id === id ? { ...t, solo: !t.solo } : t) })),
    updateTrackVolume: (id, volume) => mutate((p) => ({ ...p, tracks: p.tracks.map((t) => t.id === id ? { ...t, volume } : t) })),
    updateTrackPan: (id, pan) => mutate((p) => ({ ...p, tracks: p.tracks.map((t) => t.id === id ? { ...t, pan } : t) })),
    addClip: (trackId, clip) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => [...clips, clip]));
    }),
    removeClip: (trackId, clipId) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => clips.filter((c) => c.id !== clipId)));
    }),
    updateClip: (trackId, clipId, updates) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => clips.map((c) => c.id === clipId ? { ...c, ...updates } : c)));
    }),
    // 改变播放速度：无曲线时同步缩放片段时长（新时长 = 源时长 / speed），并按同轨后续片段做 ripple 避免重叠；
    // 有曲线时：曲线为相对速度形状，整体速度由时间线长决定 → 缩放曲线所有关键帧的 play 位置 + 片段时长（保持曲线形状），并 ripple。
    // 这样"速度滑块"在有无曲线时都能整体变速，且归一化积分保证素材始终播完、绝不定格。
    setSpeed: (trackId, clipId, speed) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      const sp = Math.max(0.1, Math.min(8, speed));
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => {
        const target = clips.find((c) => c.id === clipId);
        if (!target) return clips;
        const remap = target.time_remap;
        const hasCurve = !!(remap && remap.curve && remap.curve.length > 0);
        const srcDur = target.src_range.end - target.src_range.start;
        const newDur = srcDur / sp;
        const oldDur = target.timelineOut - target.timelineIn;
        const delta = newDur - oldDur;
        if (hasCurve) {
          const scale = oldDur > 1e-6 ? newDur / oldDur : 1;
          return clips.map((cl) => {
            if (cl.id === clipId) {
              const r = cl.time_remap;
              const newCurve = r?.curve ? r.curve.map((pt) => ({ ...pt, play: pt.play * scale })) : r?.curve;
              return { ...cl, speed: sp, timelineOut: cl.timelineIn + newDur, time_remap: r ? { ...r, curve: newCurve } : r };
            }
            if (cl.timelineIn > target.timelineIn) return { ...cl, timelineIn: cl.timelineIn + delta, timelineOut: cl.timelineOut + delta };
            return cl;
          });
        }
        return clips.map((cl) => {
          if (cl.id === clipId) return { ...cl, speed: sp, timelineOut: cl.timelineIn + newDur };
          if (cl.timelineIn > target.timelineIn) return { ...cl, timelineIn: cl.timelineIn + delta, timelineOut: cl.timelineOut + delta };
          return cl;
        });
      }));
    }),
    // 在 time 处将片段一分为二：前段 timelineIn..time，后段 time..timelineOut，src_range 同步切分
    splitClip: (trackId, clipId, time) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => clips.flatMap((c) => {
        if (c.id !== clipId || time <= c.timelineIn || time >= c.timelineOut) return [c];
        const offset = time - c.timelineIn;
        return [
          { ...c, timelineOut: time, src_range: { start: c.src_range.start, end: c.src_range.start + offset } },
          { ...c, id: uid('clip'), timelineIn: time, src_range: { start: c.src_range.start + offset, end: c.src_range.end } },
        ];
      })));
    }),
    moveClip: (trackId, clipId, newTimelineIn, skipRealign) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      const updated = mapTrackClips(p, trackId, (clips) => clips.map((c) => {
        if (c.id !== clipId) return c;
        const dur = c.timelineOut - c.timelineIn;
        return { ...c, timelineIn: Math.max(0, newTimelineIn), timelineOut: Math.max(0, newTimelineIn) + dur };
      }));
      return skipRealign ? updated : withMainTrackRealign(updated);
    }),
    // 跨轨道移动片段：从 srcTrack 移到 destTrack
    moveClipToTrack: (srcTrackId, clipId, destTrackId, newTimelineIn) => mutate((p) => {
      const srcTrack = p.tracks.find(t => t.id === srcTrackId);
      const destTrack = p.tracks.find(t => t.id === destTrackId);
      if (!srcTrack || !destTrack) return p;
      if (srcTrack.locked || destTrack.locked) return p;
      const clip = srcTrack.clips.find(c => c.id === clipId);
      if (!clip) return p;
      const dur = clip.timelineOut - clip.timelineIn;
      const movedClip = { ...clip, timelineIn: Math.max(0, newTimelineIn), timelineOut: Math.max(0, newTimelineIn) + dur };
      // 从源轨道移除，添加到目标轨道
      const updated: ProjectConfig = {
        ...p,
        tracks: p.tracks.map(t => {
          if (t.id === srcTrackId) return { ...t, clips: t.clips.filter(c => c.id !== clipId) };
          if (t.id === destTrackId) return { ...t, clips: [...t.clips, movedClip] };
          return t;
        }),
      };
      return withMainTrackRealign(updated);
    }),
    updateTransform: (trackId, clipId, key, value) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      return mapTrackClips(p, trackId, (clips) => clips.map((c) => c.id === clipId ? { ...c, transform: { ...c.transform, [key]: value } } : c));
    }),
    getMainVideoTrack: () => {
      const tracks = get().project.tracks;
      return tracks.find(t => t.type === 'video' && t.isMain) ?? tracks.find(t => t.type === 'video');
    },
  };
});
