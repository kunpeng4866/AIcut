// UI Store — 编辑器界面状态（选中、播放、时间轴、面板）
import { create } from 'zustand';

type LeftPanel = 'media' | 'effects' | 'text' | 'audio' | 'stickers';
type RightPanel = 'transform' | 'filters' | 'effects' | 'audio' | 'keyframes' | 'text' | 'subtitle' | 'speed' | 'transition' | 'plugins';

interface UIState {
  selectedTrackId: string | null;
  selectedClipId: string | null;

  currentTime: number;       // 播放头位置（秒）
  isPlaying: boolean;
  duration: number;          // 工程总时长（秒）

  timelineZoom: number;      // 像素/秒
  timelineScroll: number;    // 水平滚动位置（px）
  magneticSnap: boolean;     // 主轨磁吸附开关 — 主轨片段依次左对齐排列（默认开启）
  clipSnap: boolean;         // 其他轨道片段吸附开关 — 头尾边缘0.01秒吸附（默认开启）

  activeLeftPanel: LeftPanel;
  activeRightPanel: RightPanel;

  previewWidth: number;
  previewHeight: number;

  // 可拖拽调节的面板尺寸
  leftPanelWidth: number;    // 左面板宽度（默认 280）
  rightPanelWidth: number;   // 右面板宽度（默认 280）
  timelineHeight: number;    // 时间轴高度（默认 220）

  selectClip: (trackId: string, clipId: string) => void;
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

  currentTime: 0,
  isPlaying: false,
  duration: 0,

  timelineZoom: 50,
  timelineScroll: 0,
  magneticSnap: true,
  clipSnap: true,

  activeLeftPanel: 'media',
  activeRightPanel: 'transform',

  previewWidth: 1920,
  previewHeight: 1080,

  leftPanelWidth: 280,
  rightPanelWidth: 280,
  timelineHeight: 220,

  selectClip: (trackId, clipId) => set({ selectedTrackId: trackId, selectedClipId: clipId }),
  clearSelection: () => set({ selectedTrackId: null, selectedClipId: null }),
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
