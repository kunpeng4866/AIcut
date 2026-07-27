// 工程 Store：管理当前编辑工程的数据与操作
// 所有修改操作前先 pushSnapshot 到 historyStore，修改后标记 isDirty
// 轨道排序规则：text/sticker/effect (顶) → video (中, 主轨最下) → audio (底)
import { create } from 'zustand';
import type { ProjectConfig, AssetConfig, ClipConfig, TransformConfig, TrackConfig, SpeedPointConfig, FreezeConfig } from '../types';
import { useHistoryStore } from './historyStore';
import { useUIStore } from './uiStore';
import { rawSpeedIntegral } from '../utils/speedCurve';

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
  // 设置工程画布尺寸（即画幅比例）。离散动作（下拉选择），走 mutate 压一次快照即可。
  setCanvasSize: (width: number, height: number) => void;
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
  // 轨道音量/声相连续拖动实时版（不深拷贝、不压快照）；拖前用 pushHistorySnapshot 存一份
  updateTrackVolumeLive: (id: string, volume: number) => void;
  updateTrackPanLive: (id: string, pan: number) => void;
  addClip: (trackId: string, clip: ClipConfig) => void;
  removeClip: (trackId: string, clipId: string) => void;
  updateClip: (trackId: string, clipId: string, updates: Partial<ClipConfig>) => void;
  setSpeed: (trackId: string, clipId: string, speed: number) => void;
  // 曲线编辑（拖拽过程）：仅更新曲线，不改时长、不做磁吸重排（避免 X 轴抖动与历史快照爆炸）
  setCurveLive: (trackId: string, clipId: string, curve: SpeedPointConfig[]) => void;
  // 曲线编辑提交（拖拽结束 / 增删 / 数字输入）：按曲线平均速率反向推导片段时长，
  // 使 ∫₀^dur speed dτ = srcDur（整段素材恰好播完），并 ripple 同轨后续片段。
  setCurveCommit: (trackId: string, clipId: string, curve: SpeedPointConfig[]) => void;
  // 冻结帧提交：把冻结时长计入片段时长（timelineOut = 基础时长 srcDur/speed + freeze.duration），
  // 并 ripple 同轨后续片段。与后端 strategy.rs::effective_off 配套——退出冻结平滑无跳变、整段素材播完。
  setFreezeCommit: (trackId: string, clipId: string, freeze: FreezeConfig | null) => void;
  splitClip: (trackId: string, clipId: string, time: number) => void;
  moveClip: (trackId: string, clipId: string, newTimelineIn: number, skipRealign?: boolean) => void;
  moveClipToTrack: (srcTrackId: string, clipId: string, destTrackId: string, newTimelineIn: number) => void;
  updateTransform: (trackId: string, clipId: string, key: keyof TransformConfig, value: number) => void;
  // —— 以下为「连续拖动」专用实时方法：不深拷贝整个工程、不压历史快照、不做磁吸重排，
  // 避免每帧 O(整工程) 深拷贝导致主线程卡死、WebGPU 渲染循环饿死而黑屏。
  // 配合 pushHistorySnapshot（拖前存一份）+ realignProject（拖后一次重排）实现「一次拖动=一次撤销」。
  updateClipLive: (trackId: string, clipId: string, updates: Partial<ClipConfig>) => void;
  updateTransformLive: (trackId: string, clipId: string, key: keyof TransformConfig, value: number) => void;
  setSpeedLive: (trackId: string, clipId: string, speed: number) => void;
  moveClipLive: (trackId: string, clipId: string, newTimelineIn: number) => void;
  moveClipToTrackLive: (srcTrackId: string, clipId: string, destTrackId: string, newTimelineIn: number) => void;
  // 拖前调用一次：把当前工程压入历史快照（用于撤销），拖中实时更新不重复压。
  pushHistorySnapshot: () => void;
  // 拖后调用一次：按磁吸规则把主轨重排（连续拖动过程不做重排，避免抖动与开销）。
  realignProject: () => void;
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
    setCanvasSize: (width, height) => mutate((p) => ({
      ...p,
      canvas: { ...p.canvas, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) },
    })),
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
    removeAsset: (id) => mutate((p) => ({
      ...p,
      assets: p.assets.filter((a) => a.id !== id),
      // 一并清理引用该素材的时间轴片段，避免孤儿引用导致预览/导出异常
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.assetId !== id) })),
    })),
    // 轨道数量不限制（设计上曾写“先不要少于10个”作最低建议，现已放开）：
    // 加轨/插轨均直接写入，无 MAX_TRACKS 上限判断。
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
    updateTrackVolumeLive: (id, volume) => set((state) => ({ project: { ...state.project, tracks: state.project.tracks.map((t) => t.id === id ? { ...t, volume } : t) }, isDirty: true })),
    updateTrackPanLive: (id, pan) => set((state) => ({ project: { ...state.project, tracks: state.project.tracks.map((t) => t.id === id ? { ...t, pan } : t) }, isDirty: true })),
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
    // 改变播放速度：曲线优先（绝对速度模型）。
    // 无曲线：线性变速，新时长 = 源时长 / speed，并按同轨后续片段 ripple 避免重叠。
    // 有曲线：全局速度滑块 = 曲线绝对速度的全局乘数（保持曲线相对形状），乘到各关键帧 speed 后
    //         再按平均速率反推时长（∫₀^dur speed dτ = srcDur），并 ripple。
    setSpeed: (trackId, clipId, speed) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      const sp = Math.max(0.1, Math.min(8, speed));
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => {
        const target = clips.find((c) => c.id === clipId);
        if (!target) return clips;
        const remap = target.time_remap;
        const hasCurve = !!(remap && remap.curve && remap.curve.length >= 2);
        const srcDur = target.src_range.end - target.src_range.start;
        const oldDur = target.timelineOut - target.timelineIn;
        if (hasCurve) {
          // 曲线存在：全局速度=曲线绝对速度的全局乘数（保持相对形状），再按归一化平均速度反推时长
          const oldSp = Math.max(0.001, target.speed ?? 1);
          const ratio = sp / oldSp;
          const scaled = remap!.curve!.map((pt) => ({ ...pt, speed: pt.speed * ratio }));
          const f1 = rawSpeedIntegral(scaled, 1);
          const newDur = f1 > 1e-9 ? srcDur / f1 : oldDur;
          const delta = newDur - oldDur;
          return clips.map((cl) => {
            if (cl.id === clipId) return { ...cl, speed: sp, timelineOut: cl.timelineIn + newDur, time_remap: { ...cl.time_remap, curve: scaled } };
            if (cl.timelineIn > target.timelineIn) return { ...cl, timelineIn: cl.timelineIn + delta, timelineOut: cl.timelineOut + delta };
            return cl;
          });
        }
        // 无曲线：线性变速，新时长 = 源时长 / speed + 冻结时长（冻结存在时计入，曲线优先故其不含冻结）
        const freezeDur = target.time_remap?.freeze ? target.time_remap.freeze.duration : 0;
        const newDur = srcDur / sp + freezeDur;
        const delta = newDur - oldDur;
        return clips.map((cl) => {
          if (cl.id === clipId) return { ...cl, speed: sp, timelineOut: cl.timelineIn + newDur };
          if (cl.timelineIn > target.timelineIn) return { ...cl, timelineIn: cl.timelineIn + delta, timelineOut: cl.timelineOut + delta };
          return cl;
        });
      }));
    }),
    // 曲线编辑（拖拽过程）：仅更新曲线，不改时长、不做磁吸重排（避免 X 轴抖动），且不压历史快照
    // （历史快照在 setCurveCommit 提交时统一压一次）。
    setCurveLive: (trackId, clipId, curve) => set((state) => {
      const tracks = state.project.tracks.map((t) => t.id === trackId ? {
        ...t,
        clips: t.clips.map((c) => c.id === clipId ? { ...c, time_remap: { ...c.time_remap, curve } } : c),
      } : t);
      return { project: { ...state.project, tracks }, isDirty: true };
    }),
    // 曲线编辑提交：曲线 play 为「归一化 [0,1]」域（与片段绝对时长解耦）。
    // 反推片段时长使 ∫₀^1 speed dτ = srcDur/dur（整段素材恰好播完）：
    //   f1 = ∫₀^1 speed dτ（归一化平均速度），newDur = srcDur / f1。
    // 关键：只改 timelineOut（片段时长），绝不重缩放关键帧的 play —— 因此拖动某个关键帧的
    // 左右/高低位置，其它关键帧位置保持不变，仅整段时长随之伸缩，符合直觉且流畅。
    setCurveCommit: (trackId, clipId, curve) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => {
        const target = clips.find((c) => c.id === clipId);
        if (!target) return clips;
        // 不足两点：曲线无意义，清空回退线性映射（不动时长）
        if (curve.length < 2) {
          return clips.map((cl) => cl.id === clipId ? { ...cl, time_remap: { ...cl.time_remap, curve: [] } } : cl);
        }
        const srcDur = target.src_range.end - target.src_range.start;
        const oldDur = target.timelineOut - target.timelineIn;
        const f1 = rawSpeedIntegral(curve, 1); // ∫₀^1 speed dτ（归一化平均速度）
        if (f1 < 1e-9) {
          // 全 0 速度 → 冻结态，无法在有限时长播完整段；保持当前时长仅存曲线
          return clips.map((cl) => cl.id === clipId ? { ...cl, time_remap: { ...cl.time_remap, curve } } : cl);
        }
        const newDur = srcDur / f1;
        const delta = newDur - oldDur;
        return clips.map((cl) => {
          if (cl.id === clipId) return { ...cl, timelineOut: cl.timelineIn + newDur, time_remap: { ...cl.time_remap, curve } };
          if (cl.timelineIn > target.timelineIn) return { ...cl, timelineIn: cl.timelineIn + delta, timelineOut: cl.timelineOut + delta };
          return cl;
        });
      }));
    }),
    // 冻结帧提交：把冻结时长计入片段时长，并 ripple 同轨后续片段（与 setSpeed/setCurveCommit 同构）。
    // 配套后端 strategy.rs::effective_off：退出冻结时源从 freeze.sourceTime 平滑继续，
    // timelineOut 延长 freeze.duration 后整段素材恰好播完（不再在退出冻结处突跳）。
    // 曲线优先：若片段同时含曲线则引擎忽略冻结，冻结时长不计入 timelineOut。
    setFreezeCommit: (trackId, clipId, freeze) => mutate((p) => {
      if (p.tracks.find(t => t.id === trackId)?.locked) return p;
      return withMainTrackRealign(mapTrackClips(p, trackId, (clips) => {
        const target = clips.find((c) => c.id === clipId);
        if (!target) return clips;
        const srcDur = target.src_range.end - target.src_range.start;
        const speed = target.speed ?? 1;
        const oldDur = target.timelineOut - target.timelineIn;
        const hasCurve = !!(target.time_remap?.curve && target.time_remap.curve.length >= 2);
        const freezeDur = (!hasCurve && freeze) ? freeze.duration : 0;
        const newDur = srcDur / speed + freezeDur;   // 基础时长 + 冻结时长
        const delta = newDur - oldDur;
        return clips.map((cl) => {
          if (cl.id === clipId) return { ...cl, timelineOut: cl.timelineIn + newDur, time_remap: { ...cl.time_remap, freeze } };
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
    // —— 连续拖动实时方法（不深拷贝、不压快照、不磁吸重排）——
    updateClipLive: (trackId, clipId, updates) => set((state) => {
      if (state.project.tracks.find(t => t.id === trackId)?.locked) return state;
      const tracks = state.project.tracks.map((t) => t.id === trackId
        ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, ...updates } : c) }
        : t);
      return { project: { ...state.project, tracks }, isDirty: true };
    }),
    updateTransformLive: (trackId, clipId, key, value) => set((state) => {
      if (state.project.tracks.find(t => t.id === trackId)?.locked) return state;
      const tracks = state.project.tracks.map((t) => t.id === trackId
        ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, transform: { ...c.transform, [key]: value } } : c) }
        : t);
      return { project: { ...state.project, tracks }, isDirty: true };
    }),
    setSpeedLive: (trackId, clipId, speed) => set((state) => {
      if (state.project.tracks.find(t => t.id === trackId)?.locked) return state;
      const sp = Math.max(0.1, Math.min(8, speed));
      const p = state.project;
      const updated = mapTrackClips(p, trackId, (clips) => {
        const target = clips.find((c) => c.id === clipId);
        if (!target) return clips;
        const remap = target.time_remap;
        const hasCurve = !!(remap && remap.curve && remap.curve.length >= 2);
        const srcDur = target.src_range.end - target.src_range.start;
        const oldDur = target.timelineOut - target.timelineIn;
        if (hasCurve) {
          const oldSp = Math.max(0.001, target.speed ?? 1);
          const ratio = sp / oldSp;
          const scaled = remap!.curve!.map((pt) => ({ ...pt, speed: pt.speed * ratio }));
          const f1 = rawSpeedIntegral(scaled, 1);
          const newDur = f1 > 1e-9 ? srcDur / f1 : oldDur;
          const delta = newDur - oldDur;
          return clips.map((cl) => {
            if (cl.id === clipId) return { ...cl, speed: sp, timelineOut: cl.timelineIn + newDur, time_remap: { ...cl.time_remap, curve: scaled } };
            if (cl.timelineIn > target.timelineIn) return { ...cl, timelineIn: cl.timelineIn + delta, timelineOut: cl.timelineOut + delta };
            return cl;
          });
        }
        const freezeDur = target.time_remap?.freeze ? target.time_remap.freeze.duration : 0;
        const newDur = srcDur / sp + freezeDur;
        const delta = newDur - oldDur;
        return clips.map((cl) => {
          if (cl.id === clipId) return { ...cl, speed: sp, timelineOut: cl.timelineIn + newDur };
          if (cl.timelineIn > target.timelineIn) return { ...cl, timelineIn: cl.timelineIn + delta, timelineOut: cl.timelineOut + delta };
          return cl;
        });
      });
      return { project: withMainTrackRealign(updated), isDirty: true };
    }),
    // 连续拖动「移动」：仅改本片段 timelineIn/Out，不磁吸重排（重排在拖后 realignProject 一次完成）
    moveClipLive: (trackId, clipId, newTimelineIn) => set((state) => {
      if (state.project.tracks.find(t => t.id === trackId)?.locked) return state;
      const updated = mapTrackClips(state.project, trackId, (clips) => clips.map((c) => {
        if (c.id !== clipId) return c;
        const dur = c.timelineOut - c.timelineIn;
        return { ...c, timelineIn: Math.max(0, newTimelineIn), timelineOut: Math.max(0, newTimelineIn) + dur };
      }));
      return { project: updated, isDirty: true };
    }),
    moveClipToTrackLive: (srcTrackId, clipId, destTrackId, newTimelineIn) => set((state) => {
      const srcTrack = state.project.tracks.find((t) => t.id === srcTrackId);
      const destTrack = state.project.tracks.find((t) => t.id === destTrackId);
      if (!srcTrack || !destTrack || srcTrack.locked || destTrack.locked) return state;
      const clip = srcTrack.clips.find((c) => c.id === clipId);
      if (!clip) return state;
      const dur = clip.timelineOut - clip.timelineIn;
      const movedClip = { ...clip, timelineIn: Math.max(0, newTimelineIn), timelineOut: Math.max(0, newTimelineIn) + dur };
      const tracks = state.project.tracks.map((t) => {
        if (t.id === srcTrackId) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
        if (t.id === destTrackId) return { ...t, clips: [...t.clips, movedClip] };
        return t;
      });
      return { project: { ...state.project, tracks }, isDirty: true };
    }),
    pushHistorySnapshot: () => useHistoryStore.getState().pushSnapshot(clone(get().project)),
    realignProject: () => set((state) => ({ project: withMainTrackRealign(state.project), isDirty: true })),
    getMainVideoTrack: () => {
      const tracks = get().project.tracks;
      return tracks.find(t => t.type === 'video' && t.isMain) ?? tracks.find(t => t.type === 'video');
    },
  };
});
