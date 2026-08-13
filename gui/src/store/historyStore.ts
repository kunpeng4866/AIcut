// 历史栈Store — 撤销/重做的状态管理
// 由 projectStore 在修改前调用 pushSnapshot 保存快照
import { create } from 'zustand';
import type { ProjectConfig } from '../types';

interface HistoryState {
  past: ProjectConfig[];      // 历史栈（最近在末尾）
  future: ProjectConfig[];    // 重做栈
  maxHistory: number;         // 最大历史数

  pushSnapshot: (snapshot: ProjectConfig) => void;
  undo: (current: ProjectConfig) => ProjectConfig | null;  // 返回要恢复的状态
  redo: (current: ProjectConfig) => ProjectConfig | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  maxHistory: 50,

  // 压入快照：清空 future（新分支使旧重做失效），超过上限时丢弃最旧
  pushSnapshot: (snapshot) => {
    set((state) => {
      const past = [...state.past, snapshot];
      if (past.length > state.maxHistory) past.shift();
      return { past, future: [] };
    });
  },

  // 撤销：past 末尾是要恢复到的状态；把"当前状态"压入 future 供 redo 还原
  // 注意：current 必须是调用时刻的实时工程状态（由 projectStore 传入）
  undo: (current) => {
    const { past } = get();
    if (past.length === 0) return null;
    const previous = past[past.length - 1]; // 上一次修改前的快照 = 撤销后应当恢复的状态
    set((state) => ({
      past: state.past.slice(0, -1),
      future: [current, ...state.future],
    }));
    return previous;
  },

  // 重做：future 头部是要恢复到的状态；把"当前状态"压回 past 供再次 undo
  redo: (current) => {
    const { future } = get();
    if (future.length === 0) return null;
    const next = future[0];
    set((state) => ({
      past: [...state.past, current],
      future: state.future.slice(1),
    }));
    return next;
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  clear: () => set({ past: [], future: [] }),
}));
