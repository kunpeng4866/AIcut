// AIcut AI配置系统 — 类型定义与工具函数
// 所有配置通过Electron主进程IPC读写，前端不直接操作文件系统

// AI大模型配置（用于AI剪辑建议、脚本生成等）
export interface AIProviderConfig {
  provider: 'none' | 'deepseek' | 'openai' | 'local' | 'custom';
  apiKey: string;
  endpoint: string;
  model: string;
}

// ASR（语音识别）配置（用于语音转字幕）
// provider = 'bailian' 走阿里云百炼（DashScope）云端转写，其余走 whisper.cpp 本地兜底
export interface ASRConfig {
  provider: 'none' | 'whisper-local' | 'whisper-api' | 'custom' | 'bailian';
  modelPath: string;  // 本地模型路径
  apiKey: string;     // API模式的key
  endpoint: string;
  enginePath?: string;  // whisper-cli 可执行文件路径（留空则用引擎侧默认值）
  model?: string;       // 云端模型名，如 paraformer-v1 / paraformer-realtime-v2 / fun-asr-realtime
}

// TTS（文字转语音）配置（用于配音生成）
export interface TTSConfig {
  provider: 'none' | 'volcano' | 'edge-tts' | 'custom';
  appId: string;
  accessToken: string;
  endpoint: string;
  defaultVoice: string;
}

// 渲染设置
export interface RenderConfig {
  ffmpegPath: string;  // 空则用系统PATH
  defaultResolution: string;
  defaultFps: number;
  defaultBitrate: number;
}

// 插件设置
export interface PluginConfig {
  vfxDirectory: string;  // 特效插件目录
  enabledPlugins: string[];
}

// 顶层配置
export interface AIcutConfig {
  version: string;
  ai: AIProviderConfig;
  asr: ASRConfig;
  tts: TTSConfig;
  render: RenderConfig;
  plugins: PluginConfig;
}

// 生成默认配置
export function getDefaultConfig(): AIcutConfig {
  return {
    version: '1.0.0',
    ai: {
      provider: 'none',
      apiKey: '',
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    },
    asr: {
      provider: 'bailian',
      modelPath: '',
      apiKey: '',
      endpoint: '',
      enginePath: '',
      model: 'paraformer-realtime-v2',
    },
    tts: {
      provider: 'none',
      appId: '',
      accessToken: '',
      endpoint: '',
      defaultVoice: '',
    },
    render: {
      ffmpegPath: '',
      defaultResolution: '1920x1080',
      defaultFps: 30,
      defaultBitrate: 8000,
    },
    plugins: {
      vfxDirectory: '',
      enabledPlugins: [],
    },
  };
}

// 校验配置完整性
export function validateConfig(config: AIcutConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['配置为空'] };
  }
  if (!config.version) errors.push('缺少版本号');
  if (!config.ai) errors.push('缺少AI配置');
  if (!config.asr) errors.push('缺少ASR配置');
  if (!config.tts) errors.push('缺少TTS配置');
  if (!config.render) errors.push('缺少渲染配置');
  if (!config.plugins) errors.push('缺少插件配置');
  // 渲染参数校验
  if (config.render?.defaultFps && config.render.defaultFps <= 0) {
    errors.push('帧率必须大于0');
  }
  if (config.render?.defaultBitrate && config.render.defaultBitrate <= 0) {
    errors.push('码率必须大于0');
  }
  return { valid: errors.length === 0, errors };
}

// 检查AI大模型是否已配置可用
export function isAIConfigured(config: AIcutConfig): boolean {
  const ai = config?.ai;
  if (!ai || ai.provider === 'none') return false;
  // local模式不需要apiKey
  if (ai.provider === 'local') return !!ai.endpoint;
  return !!ai.apiKey;
}

// 检查ASR是否已配置可用
export function isASRConfigured(config: AIcutConfig): boolean {
  const asr = config?.asr;
  if (!asr || asr.provider === 'none') return false;
  if (asr.provider === 'whisper-local') return !!asr.modelPath;
  if (asr.provider === 'whisper-api') return !!asr.apiKey;
  if (asr.provider === 'bailian') return !!asr.apiKey;
  return true; // custom
}

// 检查TTS是否已配置可用
export function isTTSConfigured(config: AIcutConfig): boolean {
  const tts = config?.tts;
  if (!tts || tts.provider === 'none') return false;
  if (tts.provider === 'edge-tts') return true; // 免费无需配置
  if (tts.provider === 'volcano') return !!tts.appId && !!tts.accessToken;
  return true; // custom
}
