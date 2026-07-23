// 历史栈Store — 撤销/重做的状态管理
// 由 projectStore 在修改前调用 pushSnapshot 保存快照
import { create } from 'zustand';
import type { ProjectConfig } from '../types';

interface HistoryState {
  past: ProjectConfig[];      // 历史栈（最近在末尾）
  future: ProjectConfig[];    // 重做栈
  maxHistory: number;         // 最大历史数

  pushSnapshot: (snapshot: ProjectConfig) => void;
  undo: () => ProjectConfig | null;  // 返回要恢复的状态
  redo: () => ProjectConfig | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  maxHistory: 50,

  // 压入快照：清空 future，超过上限时丢弃最旧
  pushSnapshot: (snapshot) => {
    set((state) => {
      const past = [...state.past, snapshot];
      if (past.length > state.maxHistory) past.shift();
      return { past, future: [] };
    });
  },

  // 撤销：从 past 取出末尾，放入 future，返回上一个状态
  undo: () => {
    const { past } = get();
    if (past.length === 0) return null;
    const previous = past[past.length - 1];
    set((state) => ({
      past: state.past.slice(0, -1),
      future: [state.past[state.past.length - 1] ?? previous, ...state.future],
    }));
    // 返回 past 中新的末尾（即要恢复到的状态），若空则返回 null
    const newPast = get().past;
    return newPast.length > 0 ? newPast[newPast.length - 1] : previous;
  },

  // 重做：从 future 取出头部，移回 past，返回要恢复的状态
  redo: () => {
    const { future } = get();
    if (future.length === 0) return null;
    const next = future[0];
    set((state) => ({
      past: [...state.past, state.future[0]],
      future: state.future.slice(1),
    }));
    return next;
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  clear: () => set({ past: [], future: [] }),
}));
