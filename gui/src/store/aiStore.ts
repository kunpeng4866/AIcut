// AI 字幕生成独立 store（zustand），不修改 projectStore.ts
//
// 完整 UI 状态机：isGenerating / result / error / transcript / lang
// 生成入口 generateSubtitles 当前走占位 HTTP 通道（见 TODO），保留与后端对接的能力。

import { create } from 'zustand';
import type { AiState, SubtitleGenResult } from '../aiTypes';

// TODO: 后端 N-API 已暴露 aiGenerateSubtitles，待 electron main 在 window.aicut 上挂载后，
// 将下方 generateSubtitles 内的 fetch 替换为：
//   await window.aicut.aiGenerateSubtitles(transcript, lang)  // 返回 SubtitleOverlay JSON 字符串
// 当前先用占位端点，保证 UI 状态机可独立运行与联调。
const AI_ENDPOINT = '/api/ai/generate-subtitles';

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
      // TODO: 替换为 window.aicut.aiGenerateSubtitles(transcript, lang)
      const resp = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, lang }),
      });
      if (!resp.ok) {
        throw new Error(`AI 生成请求失败: HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as SubtitleGenResult;
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
