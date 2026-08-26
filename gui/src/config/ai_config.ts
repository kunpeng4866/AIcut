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
  model?: string;       // 云端模型名，如 qwen3-asr-flash-realtime / paraformer-realtime-v2 / fun-asr-realtime
}

// TTS（文字转语音）配置（用于配音生成）
// provider:
//   'none'    未配置
//   'volcano' 火山引擎（appId=火山AppID，accessToken=火山Access Token）
//   'cosyvoice' 阿里云百炼 CosyVoice（appId=DashScope API Key，token 引擎忽略）
export interface TTSConfig {
  provider: 'none' | 'volcano' | 'cosyvoice';
  appId: string;
  accessToken: string;
  endpoint: string;
  defaultVoice: string;
  model?: string; // 百炼模型，cosyvoice 默认 'cosyvoice-v3.5-plus'
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

// 补全资产（一键补全）设置
export interface AssetsConfig {
  cdnBaseUrl: string;  // CDN 基础地址（末尾带 /），下载 python 运行时与模型权重
}

// 口播剪辑偏好（跨会话记忆，由 SpeechPanel 读写 config.speech）
export interface SpeechEditPrefs {
  preset?: 'light' | 'standard' | 'aggressive'; // 轻量/标准/激进 预设
  modelSize?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  useDemucs?: boolean;
  vadThreshold?: number;
  minGap?: number;
  wordPad?: number;
  denoise?: boolean;
  denoiseQuality?: 'standard' | 'high';
  deess?: boolean;
  normalize?: boolean;
  fillers?: boolean;
  keepNonspeech?: boolean;
  trimSilence?: boolean;
  sedEvents?: boolean;
  sedThreshold?: number;
  respiroBreath?: boolean;
  stutterDetect?: boolean;
  stutterThreshold?: number;
  crossfadeMs?: number;
  declick?: boolean;
  maskSoften?: boolean;        // DFN3 mask 软化开关（高 SNR 保留干净语音），默认 true
  maskSoftenFloor?: number;    // 软化增益阈值 0.3~0.9，默认 0.5（UI 可调，微调听感）
}

// 与 electron/assets-manifest.ts 的 DEFAULT_CDN_BASE 保持一致。
// 渲染层不能 import electron 目录（tsconfig 分离），故在此镜像同一常量；
// 改动其中一处必须同步另一处，否则「未配置」判定会错位。
export const DEFAULT_CDN_PLACEHOLDER = 'https://REPLACE_WITH_YOUR_CDN_BASE/';

// 顶层配置
export interface AIcutConfig {
  version: string;
  ai: AIProviderConfig;
  asr: ASRConfig;
  tts: TTSConfig;
  render: RenderConfig;
  plugins: PluginConfig;
  assets: AssetsConfig;
  speech: SpeechEditPrefs;
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
      model: 'qwen-audio-3.0-asr-flash-streaming',
    },
    tts: {
      provider: 'none',
      appId: '',
      accessToken: '',
      endpoint: '',
      defaultVoice: '',
      model: 'cosyvoice-v3.5-plus',
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
    assets: {
      cdnBaseUrl: '',
    },
    speech: {
      preset: 'standard',
      modelSize: 'base',
      useDemucs: false,
      vadThreshold: 0.25,
      minGap: 0.18,
      wordPad: 0.04,
      denoise: true,
      denoiseQuality: 'standard',
      deess: false,
      normalize: false,
      fillers: true,
      keepNonspeech: true,
      trimSilence: true,
      sedEvents: true,
      sedThreshold: 0.5,
      respiroBreath: true,
      stutterDetect: true,
      stutterThreshold: 0.5,
      crossfadeMs: 20,
      declick: true,
      maskSoften: true,
      maskSoftenFloor: 0.5,
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
  if (tts.provider === 'volcano') return !!tts.appId && !!tts.accessToken;
  if (tts.provider === 'cosyvoice') return !!tts.appId; // DashScope Key
  return false;
}
