// 配置 Store — 管理 AIcutConfig（AI/ASR/TTS/渲染/插件）
// 通过 window.aicut.getConfig() / setConfig() 与主进程 IPC 交互
import { create } from 'zustand';
import type { AIcutConfig } from '../config/ai_config';
import { getDefaultConfig } from '../config/ai_config';

interface ConfigState {
  config: AIcutConfig | null;
  isLoaded: boolean;
  showConfigWizard: boolean;  // 配置向导弹窗显隐

  loadConfig: () => Promise<void>;
  updateConfig: (updates: Partial<AIcutConfig>) => Promise<void>;
  setShowConfigWizard: (show: boolean) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoaded: false,
  showConfigWizard: false,

  // 从主进程读取配置 JSON；失败则用默认配置并弹出向导
  loadConfig: async () => {
    try {
      const raw = await window.aicut.getConfig();
      const parsed = JSON.parse(raw) as AIcutConfig;
      set({ config: parsed, isLoaded: true });
    } catch {
      set({ config: getDefaultConfig(), isLoaded: true, showConfigWizard: true });
    }
  },

  // 部分更新配置：合并后写回主进程
  updateConfig: async (updates) => {
    const current = get().config ?? getDefaultConfig();
    const merged: AIcutConfig = {
      ...current,
      ...updates,
      ai: { ...current.ai, ...(updates.ai ?? {}) },
      asr: { ...current.asr, ...(updates.asr ?? {}) },
      tts: { ...current.tts, ...(updates.tts ?? {}) },
      render: { ...current.render, ...(updates.render ?? {}) },
      plugins: { ...current.plugins, ...(updates.plugins ?? {}) },
    };
    set({ config: merged });
    try {
      await window.aicut.setConfig(JSON.stringify(merged));
    } catch (e) {
      console.error('写入配置失败:', e);
    }
  },

  setShowConfigWizard: (show) => set({ showConfigWizard: show }),
}));
