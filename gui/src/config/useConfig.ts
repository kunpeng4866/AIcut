// AIcut 配置管理Hook — 通过IPC读写配置
import { useState, useCallback, useEffect } from 'react';
import type { AIcutConfig } from './ai_config';
import { getDefaultConfig, validateConfig, isAIConfigured, isASRConfigured, isTTSConfigured } from './ai_config';

// 全局缓存，避免每次渲染重新加载
let cachedConfig: AIcutConfig | null = null;

// 解析IPC返回的JSON字符串，失败则用默认配置
function parseConfig(raw: string): AIcutConfig {
  try {
    const parsed = JSON.parse(raw);
    // 合并默认配置，保证新增字段存在
    const def = getDefaultConfig();
    return {
      ...def,
      ...parsed,
      ai: { ...def.ai, ...parsed.ai },
      asr: { ...def.asr, ...parsed.asr },
      tts: { ...def.tts, ...parsed.tts },
      render: { ...def.render, ...parsed.render },
      plugins: { ...def.plugins, ...parsed.plugins },
      speech: { ...def.speech, ...parsed.speech },
    };
  } catch {
    return getDefaultConfig();
  }
}

// 配置管理Hook
export function useConfig() {
  const [config, setConfig] = useState<AIcutConfig>(cachedConfig || getDefaultConfig());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加载配置（通过IPC从主进程读取）
  const loadConfig = useCallback(async (): Promise<AIcutConfig> => {
    setLoading(true);
    setError(null);
    try {
      const raw = await window.aicut.getConfig();
      const parsed = parseConfig(raw);
      cachedConfig = parsed;
      setConfig(parsed);
      return parsed;
    } catch (e: any) {
      const msg = e?.message || '加载配置失败';
      setError(msg);
      // 失败时回退到默认配置
      const def = getDefaultConfig();
      cachedConfig = def;
      setConfig(def);
      return def;
    } finally {
      setLoading(false);
    }
  }, []);

  // 保存配置（通过IPC写入主进程）
  const saveConfig = useCallback(async (cfg: AIcutConfig): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const json = JSON.stringify(cfg, null, 2);
      const ok = await window.aicut.setConfig(json);
      if (ok) {
        cachedConfig = cfg;
        setConfig(cfg);
      }
      return ok;
    } catch (e: any) {
      setError(e?.message || '保存配置失败');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // 检查AI是否已配置
  const checkAIAvailable = useCallback(async (): Promise<boolean> => {
    const cfg = cachedConfig || await loadConfig();
    return isAIConfigured(cfg);
  }, [loadConfig]);

  // 获取缺失的配置项列表（用于向导提示）
  const getMissingConfig = useCallback((): string[] => {
    const missing: string[] = [];
    if (!isAIConfigured(config)) missing.push('AI大模型');
    if (!isASRConfigured(config)) missing.push('语音识别(ASR)');
    if (!isTTSConfigured(config)) missing.push('文字转语音(TTS)');
    return missing;
  }, [config]);

  // 初始化时加载一次
  useEffect(() => {
    if (!cachedConfig) {
      loadConfig();
    }
  }, [loadConfig]);

  return {
    config,
    loading,
    error,
    loadConfig,
    saveConfig,
    checkAIAvailable,
    getMissingConfig,
    // 直接暴露校验函数
    validate: () => validateConfig(config),
  };
}
