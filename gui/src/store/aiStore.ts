// AI 字幕生成独立 store（zustand），不修改 projectStore.ts
//
// 完整 UI 状态机：isGenerating / result / error / transcript / lang
// 生成入口 generateSubtitles 当前走占位 HTTP 通道（见 TODO），保留与后端对接的能力。

import { create } from 'zustand';
import type { AiState, SubtitleGenResult } from '../aiTypes';

// 已接入后端：window.aicut.ai.generateSubtitles（electron main → aicut-engine ai subtitles → DeepSeek）

interface AiStore extends AiState {
  isTranscribing: boolean;
  // 存储 ASR 完整结果（含每句精确时间戳），用于"用语音时间戳直接生成字幕"
  asrResult: { text: string; segments: { start: number; end: number; text: string }[] } | null;
  setTranscript: (t: string) => void;
  setLang: (l: string) => void;
  generateSubtitles: (transcript: string, lang: string) => Promise<void>;
  transcribe: (audioPath: string, lang: string) => Promise<void>;
  clearResult: () => void;
}

export const useAiStore = create<AiStore>((set) => ({
  isGenerating: false,
  isTranscribing: false,
  result: null,
  error: null,
  transcript: '',
  lang: 'zh',
  asrResult: null,

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

  // ASR 本地语音转写：把音视频素材的音轨转写成纯文本，回填到 transcript，
  // 复用下方「生成字幕」链路（由 DeepSeek 切分为时间轴字幕）。只改 transcript，不碰 result。
  transcribe: async (audioPath, lang) => {
    if (!audioPath || !audioPath.trim()) {
      set({ error: '请先选择要转写的音频/视频素材', isTranscribing: false });
      return;
    }
    set({ isTranscribing: true, error: null });
    try {
      const resp = await window.aicut.asr.transcribe(audioPath, lang);
      if (!resp.success || !resp.data) throw new Error(resp.error || 'ASR 转写失败');
      // 同时保存完整 ASR 结果（含 segments 时间戳），供"用语音时间戳直接生成字幕"使用
      set({ transcript: resp.data.text, asrResult: resp.data, isTranscribing: false });
    } catch (e: any) {
      set({ error: e?.message ?? String(e), isTranscribing: false });
    }
  },

  clearResult: () => set({ result: null, error: null }),
}));
