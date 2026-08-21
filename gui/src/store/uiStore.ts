// UI Store — 编辑器界面状态（选中、播放、时间轴、面板）
import { create } from 'zustand';

type LeftPanel = 'media' | 'effects' | 'text' | 'audio' | 'stickers' | 'speech';
// 右侧属性面板的一级 tab key：按素材类型分组（画面/音频/变速/动画/调整/关键帧；文本/字幕；基础/变速/关键帧）
// 'transform'/'filters'/'effects'/'plugins'/'mask'/'keying' 为历史 key，保留以兼容旧持久化状态（不会作为 tab 渲染，会自动回退到分组首个 tab）
export type RightPanel = 'transform' | 'filters' | 'effects' | 'audio' | 'keyframes' | 'text' | 'subtitle' | 'speed' | 'transition' | 'plugins' | 'mask' | 'keying'
  | 'visual' | 'anim' | 'adjust' | 'kf';

interface UIState {
  selectedTrackId: string | null;
  selectedClipId: string | null;
  selectedClipIds: string[];

  currentTime: number;       // 播放头位置（秒）
  isPlaying: boolean;
  duration: number;          // 工程总时长（秒）

  timelineZoom: number;      // 像素/秒
  timelineScroll: number;    // 水平滚动位置（px）
  magneticSnap: boolean;     // 主轨磁吸附开关 — 主轨片段依次左对齐排列（默认开启）
  clipSnap: boolean;         // 其他轨道片段吸附开关 — 头尾边缘0.01秒吸附（默认开启）

  activeLeftPanel: LeftPanel;
  activeRightPanel: RightPanel;
  // 右侧面板顶级切换：属性 / 混音器 / AI（提升为全局，便于时间轴选中片段时自动切到属性）
  rightView: 'props' | 'mixer' | 'ai';
  setRightView: (v: 'props' | 'mixer' | 'ai') => void;

  previewWidth: number;
  previewHeight: number;

  // 口播剪辑：分析后在原素材时间轴上叠加「保留(绿)/删除(红)」标记
  speechOverlay: { assetPath: string; keepSegments: [number, number][]; duration: number } | null;
  setSpeechOverlay: (o: { assetPath: string; keepSegments: [number, number][]; duration: number }) => void;
  // 人工精修：仅更新 keepSegments（拖动边界时每帧调用，纯 UI 状态、不入工程历史）
  setSpeechOverlaySegments: (segs: [number, number][]) => void;
  clearSpeechOverlay: () => void;
  // 删除明细编辑撤销栈：每次离散编辑（改起止/删段）前压当前 keepSegments，可逐步撤销
  speechUndoStack: [number, number][][];
  // 提交一次删除明细编辑：先压栈当前值，再写入新 keepSegments
  commitSpeechSegments: (segs: [number, number][]) => void;
  // 撤销最近一次删除明细编辑
  undoSpeechSegments: () => void;

  // 可拖拽调节的面板尺寸
  leftPanelWidth: number;    // 左面板宽度（默认 280）
  rightPanelWidth: number;   // 右面板宽度（默认 280）
  timelineHeight: number;    // 时间轴高度（默认 220）

  selectClip: (trackId: string, clipId: string, mode?: 'replace' | 'toggle') => void;
  setSelection: (trackId: string | null, ids: string[]) => void;
  clearSelection: () => void;
  setCurrentTime: (t: number) => void;
  togglePlay: () => void;
  setTimelineZoom: (z: number) => void;
  setTimelineScroll: (s: number) => void;
  toggleMagneticSnap: () => void;
  toggleClipSnap: () => void;
  setActiveLeftPanel: (p: LeftPanel) => void;
  setActiveRightPanel: (p: RightPanel) => void;
  setLeftPanelWidth: (w: number) => void;
  setRightPanelWidth: (w: number) => void;
  setTimelineHeight: (h: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedTrackId: null,
  selectedClipId: null,
  selectedClipIds: [],

  currentTime: 0,
  isPlaying: false,
  duration: 0,

  timelineZoom: 50,
  timelineScroll: 0,
  magneticSnap: true,
  clipSnap: true,

  activeLeftPanel: 'media',
  activeRightPanel: 'visual',
  rightView: 'props',
  setRightView: (v) => set({ rightView: v }),

  previewWidth: 1920,
  previewHeight: 1080,

  speechOverlay: null,
  speechUndoStack: [],
  setSpeechOverlay: (o) => set({ speechOverlay: o, speechUndoStack: [] }),
  setSpeechOverlaySegments: (segs) => set((s) => s.speechOverlay ? { speechOverlay: { ...s.speechOverlay, keepSegments: segs } } : {}),
  clearSpeechOverlay: () => set({ speechOverlay: null, speechUndoStack: [] }),
  commitSpeechSegments: (segs) => set((s) => {
    if (!s.speechOverlay) return {};
    const stack = [...s.speechUndoStack, s.speechOverlay.keepSegments];
    if (stack.length > 50) stack.shift();
    return { speechUndoStack: stack, speechOverlay: { ...s.speechOverlay, keepSegments: segs } };
  }),
  undoSpeechSegments: () => set((s) => {
    if (!s.speechOverlay || s.speechUndoStack.length === 0) return {};
    const stack = [...s.speechUndoStack];
    const prev = stack.pop() as [number, number][];
    return { speechUndoStack: stack, speechOverlay: { ...s.speechOverlay, keepSegments: prev } };
  }),

  leftPanelWidth: 280,
  rightPanelWidth: 280,
  timelineHeight: 220,

  selectClip: (trackId, clipId, mode = 'replace') => set((s) => {
    if (mode === 'toggle') {
      const ids = s.selectedClipIds.includes(clipId)
        ? s.selectedClipIds.filter((id) => id !== clipId)
        : [...s.selectedClipIds, clipId];
      return { selectedTrackId: trackId, selectedClipId: clipId, selectedClipIds: ids };
    }
    return { selectedTrackId: trackId, selectedClipId: clipId, selectedClipIds: [clipId] };
  }),
  setSelection: (trackId, ids) => set({
    selectedTrackId: trackId,
    selectedClipId: ids.length ? ids[ids.length - 1] : null,
    selectedClipIds: ids,
  }),
  clearSelection: () => set({ selectedTrackId: null, selectedClipId: null, selectedClipIds: [] }),
  setCurrentTime: (t) => set({ currentTime: Math.max(0, t) }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setTimelineZoom: (z) => set({ timelineZoom: Math.max(5, Math.min(500, z)) }),
  setTimelineScroll: (s) => set({ timelineScroll: Math.max(0, s) }),
  toggleMagneticSnap: () => set((s) => ({ magneticSnap: !s.magneticSnap })),
  toggleClipSnap: () => set((s) => ({ clipSnap: !s.clipSnap })),
  setActiveLeftPanel: (p) => set({ activeLeftPanel: p }),
  setActiveRightPanel: (p) => set({ activeRightPanel: p }),
  setLeftPanelWidth: (w) => set({ leftPanelWidth: Math.max(180, Math.min(500, w)) }),
  setRightPanelWidth: (w) => set({ rightPanelWidth: Math.max(180, Math.min(500, w)) }),
  setTimelineHeight: (h) => set({ timelineHeight: Math.max(120, Math.min(500, h)) }),
}));

// [TEST HOOK] 临时暴露供 Playwright 驱动验证，验证后回退删除
(globalThis as any).__uiStore = useUIStore;
