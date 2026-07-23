// AI 字幕生成独立 store（zustand），不修改 projectStore.ts
//
// 完整 UI 状态机：isGenerating / result / error / transcript / lang
// 生成入口 generateSubtitles 当前走占位 HTTP 通道（见 TODO），保留与后端对接的能力。

import { create } from 'zustand';
import type { AiState, SubtitleGenResult } from '../aiTypes';

// 已接入后端：window.aicut.ai.generateSubtitles（electron main → aicut-engine ai subtitles → DeepSeek）

interface AiStore extends AiState {
  setTranscript: (t: string) => void;
  setLang: (l: string) => void;
  generateSubtitles: (transcript: string, lang: string) => Promise<void>;
  clearResult: () => void;
}

export const useAiStore = create<AiStore>((set) => ({
  isGenerating: false,
  result: null,
  error: null,
  transcript: '',
  lang: 'zh',

  setTranscript: (t) => set({ transcript: t }),
  setLang: (l) => set({ lang: l }),

  generateSubtitles: async (transcript, lang) => {
    if (!transcript.trim()) {
      set({ error: '请先粘贴/输入转写文本', isGenerating: false });
      return;
    }
    set({ isGenerating: true, error: null });
    try {
      const resp = await window.aicut.ai.generateSubtitles(transcript, lang);
      if (!resp.success || !resp.data) {
        throw new Error(resp.error || 'AI 生成失败');
      }
      const data = resp.data as SubtitleGenResult;
      if (!data || !Array.isArray(data.items)) {
        throw new Error('返回数据缺少合法的 items 数组');
      }
      set({ result: data, isGenerating: false });
    } catch (e: any) {
      set({ error: e?.message ?? String(e), isGenerating: false });
    }
  },

  clearResult: () => set({ result: null, error: null }),
}));
