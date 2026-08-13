// 字幕统一/独立编辑状态
// "应用到所有字幕" toggle：默认勾选 → 改一个文字块的所有同轨道文字块同步变化
import { create } from 'zustand';

interface SubtitleEditState {
  applyToAll: boolean;
  toggleApplyToAll: () => void;
  setApplyToAll: (v: boolean) => void;
}

export const useSubtitleEditStore = create<SubtitleEditState>((set) => ({
  applyToAll: true,
  toggleApplyToAll: () => set((s) => ({ applyToAll: !s.applyToAll })),
  setApplyToAll: (v) => set({ applyToAll: v }),
}));
