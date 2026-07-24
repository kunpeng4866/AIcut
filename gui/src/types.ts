// AIcut GUI type definitions
import type { SubtitleGenResult } from './aiTypes';

export interface CanvasConfig { width: number; height: number; fps?: number; sample_rate?: number }
export interface AssetConfig { id: string; type: string; path: string; duration?: number; width?: number; height?: number; codec?: string }
export interface TransformConfig { x?: number; y?: number; scale_x?: number; scale_y?: number; rotation?: number; opacity?: number }
export interface RangeConfig { start: number; end: number }
// 文字片段内容
export interface TextContent {
  content: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  textAlign?: 'left' | 'center' | 'right';
  x?: number;
  y?: number;
  rotation?: number;
  opacity?: number;
}

// 字幕片段内容
export interface SubtitleItem {
  start: number;   // 相对 clip.timelineIn 的偏移（秒）
  end: number;     // 结束偏移
  text: string;
}
export interface SubtitleContent {
  items: SubtitleItem[];
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  position?: 'bottom' | 'top' | 'center';
}

// ── 时间重映射（与后端 clip_source_time 一致） ──
export interface FreezeConfig { start: number; sourceTime: number; duration: number; }
export interface SpeedPointConfig { play: number; speed: number; }
export interface TimeRemapConfig { reverse?: boolean; freeze?: FreezeConfig | null; curve?: SpeedPointConfig[]; }

export interface ClipConfig {
  id: string; assetId: string; src_range: RangeConfig; timelineIn: number; timelineOut: number;
  transform?: TransformConfig; volume?: number; speed?: number;
  time_remap?: TimeRemapConfig;
  effects?: any[]; masks?: any[]; filters?: any[]; keyframes?: Record<string, any>;
  text?: TextContent;
  subtitle?: SubtitleContent;
  // 转场：本片段结尾与同轨下一片段之间的过渡（None = 无）
  transition?: TransitionConfig;
  // 音频淡入/淡出（秒）：片段开头从静音渐起到满音量、结尾从满音量渐弱到静音；0 = 无
  audioFadeIn?: number;
  audioFadeOut?: number;
}
// 转场配置（与后端 Transition 结构对应）
export type TransitionType = 'none' | 'fade' | 'dissolve' | 'slide' | 'wipe';
export type WipeDirection = 'left' | 'right' | 'up' | 'down';
export interface TransitionConfig {
  transitionType?: TransitionType; // 默认 'none'
  duration?: number;               // 秒，默认 0.5
  direction?: WipeDirection;       // wipe 方向，默认 'right'
}
export interface TrackConfig {
  id: string; type: string; order?: number; clips: ClipConfig[];
  locked?: boolean; visible?: boolean; muted?: boolean; solo?: boolean; isMain?: boolean;
  // 混音器：轨道音量 0.0–2.0（1.0 = 原始音量）
  volume?: number;
  // 混音器：声相 -1.0(全左) – 1.0(全右)（0.0 = 居中）
  pan?: number;
}
export interface ProjectConfig { version?: string; canvas: CanvasConfig; assets: AssetConfig[]; tracks: TrackConfig[] }
export interface MediaInfo { path: string; media_type: string; duration: number; width: number; height: number; codec: string; fps: number }
export interface RenderResult { command: string }

// ── 导出选项 ──
export type ExportResolution = 'original' | '1080p' | '720p' | '480p';
export type ExportFormat = 'mp4-h264' | 'mp4-h265' | 'mov';
export type ExportQuality = 'high' | 'medium' | 'low';

export interface ExportOptions {
  resolution: ExportResolution;
  format: ExportFormat;
  quality: ExportQuality;
}

export interface ExportAPI {
  start: (project: ProjectConfig, outputPath: string, options: ExportOptions) => Promise<{ success: boolean; error?: string }>;
  onProgress: (callback: (progress: number) => void) => void;
  onDone: (callback: () => void) => void;
  onError: (callback: (err: string) => void) => void;
  cancel: () => Promise<void>;
  openFolder: (filePath: string) => Promise<void>;
}

// ── AI 自动字幕 ──
export interface AiAPI {
  // 由 DeepSeek 将 ASR 转写文本切分为时间轴字幕，返回 SubtitleGenResult JSON
  generateSubtitles: (transcript: string, lang: string) => Promise<{ success: boolean; data?: SubtitleGenResult; error?: string }>;
}

// ── ASR 本地语音转写（whisper.cpp） ──
export interface AsrAPI {
  // 本地 whisper.cpp 转写，返回 { text, segments }
  transcribe: (audioPath: string, lang: string) => Promise<{
    success: boolean;
    data?: { text: string; segments: { start: number; end: number; text: string }[] };
    error?: string;
  }>;
}

declare global { interface Window { aicut: AicutAPI } }
export interface AicutAPI {
  // 引擎
  render(json: string): Promise<{ success: boolean; command?: string; error?: string }>;
  probe(path: string): Promise<{ success: boolean; info?: MediaInfo; error?: string }>;
  getPresets(): Promise<string[]>;
  getVersion(): Promise<string>;
  validate(json: string): Promise<{ valid: boolean; errors?: string[] }>;
  // 文件
  openFiles(): Promise<string[]>;
  saveProject(path: string, content: string): Promise<boolean>;
  loadProject(path: string): Promise<string>;
  openSaveDialog(defaultName?: string): Promise<string | null>;
  // AI配置
  getConfig(): Promise<string>;
  setConfig(json: string): Promise<boolean>;
  // TTS 语音合成
  ttsSynthesize(text: string, voice: string, outputPath: string): Promise<{ success: boolean; audioPath?: string; error?: string }>;
  ttsVoices(): Promise<string>;
  // AI 自动字幕
  ai: AiAPI;
  // ASR 本地语音转写
  asr: AsrAPI;
  // 插件
  listPlugins(): Promise<string>;
  scanPlugins(): Promise<number>;
  buildPluginFilter(pluginId: string, params: string): Promise<string>;
  // 导出（旧 API，保留兼容）
  exportVideo(command: string, outputPath: string): Promise<{ success: boolean; error?: string }>;
  openExportDialog(defaultName?: string): Promise<string | null>;
  // 导出（新 API，带进度）
  export: ExportAPI;
  // 草稿
  saveDraft(name: string, content: string): Promise<boolean>;
  loadDraft(name: string): Promise<string>;
  listDrafts(): Promise<string[]>;
  deleteDraft(name: string): Promise<boolean>;
}
