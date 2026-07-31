// AIcut GUI type definitions
import type { SubtitleGenResult } from './aiTypes';

export interface CanvasConfig { width: number; height: number; fps?: number; sample_rate?: number }
export interface AssetConfig { id: string; type: string; path: string; duration?: number; width?: number; height?: number; codec?: string; fps?: number; proxyPath?: string }
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
  effects?: any[]; masks?: MaskConfig[]; filters?: any[]; keyframes?: Record<string, any>;
  text?: TextContent;
  subtitle?: SubtitleContent;
  // 转场：本片段结尾与同轨下一片段之间的过渡（None = 无）
  transition?: TransitionConfig;
  // 音频淡入/淡出（秒）：片段开头从静音渐起到满音量、结尾从满音量渐弱到静音；0 = 无
  audioFadeIn?: number;
  audioFadeOut?: number;
  // 抠像：色度/智能/手动（非破坏式）
  keying?: KeyingConfig;
  // 美颜·皮肤管理（非破坏式，M1）
  beauty?: BeautyConfig;
}
// 转场配置（与后端 Transition 结构对应）
export type TransitionType =
  | 'none'
  | 'fade'
  | 'dissolve'
  | 'slide'
  | 'wipe'
  | 'zoom'
  | 'blur'
  | 'flash';
export type WipeDirection = 'left' | 'right' | 'up' | 'down';
// 缓动曲线：'linear' 易显卡顿；'ease-in-out' 为丝滑默认
export type TransitionEasing = 'linear' | 'ease-in-out';
// 擦除遮罩形状：'linear' 线性推扫；'circle' 圆形展开（转场专用，与下方蒙版 MaskShape 不同）
export type WipeMaskShape = 'linear' | 'circle';

// ── 蒙版（Mask）数据模型（前后端统一）──
// shape 取值与后端 Mask.shape 完全一致
// 几何/旋转契约（前后端一致）：
//   polygon params: { x, y, radius, sides, rotation }
//   star    params: { x, y, radius, innerRatio, sides, rotation }
//   x,y 中心归一化 0..1；radius 相对 min(W,H)；sides≥3 整数；rotation 角度(度)
//   innerRatio 星形内/外半径比 0..1
//   rotation=0 时第一个顶点指向正上方；正角度=顺时针（与后端 filters.rs 极坐标 SDF 顶点相位 ang+PI/2 对齐）
export type MaskShape = 'rect' | 'circle' | 'linear' | 'mirror' | 'polygon' | 'star' | 'heart' | 'text';
// 描边
export interface MaskStroke {
  enabled: boolean;
  color: string;
  size: number;      // 归一化 0~1（相对帧短边）
  opacity: number;   // 0~1
  blur: number;      // 归一化 0~1
}
// 阴影
export interface MaskShadow {
  enabled: boolean;
  color: string;
  opacity: number;   // 0~1
  blur: number;      // 归一化 0~1
  distance: number;  // 归一化 0~1
  angle: number;     // 角度（度）
}
// 单条蒙版
export interface MaskConfig {
  id: string;
  shape: MaskShape;
  enabled: boolean;
  invert: boolean;
  feather: number;   // 羽化：归一化 0~1（预览按帧短边换算像素）
  params: Record<string, number>; // 形状参数（归一化 0~1）
  text?: string;                 // 文字蒙版内容（params 只能放数字，文字单独字段）
  stroke?: MaskStroke;
  shadow?: MaskShadow;
}
// ── 抠像（Keying）数据模型（前后端统一，与后端 Keying 结构对应）──
export type KeyingMode = 'chroma' | 'smart' | 'manual';
// 背景合成：抠出主体后，在透明区背后铺一层背景（纯色 / 图片 / 视频）。
export type BackgroundType = 'none' | 'color' | 'image' | 'video';
export interface KeyingBackground {
  type: BackgroundType;  // 背景类型（默认 'none' 即不铺背景）
  color?: string;       // type==='color' 时生效，'#rrggbb' 小写
  assetId?: string;     // type==='image'|'video' 时生效，引用 project.assets 里的背景素材
}
export interface KeyingConfig {
  enabled: boolean;
  mode: KeyingMode;
  color: string;        // '#rrggbb' 小写
  similarity: number;   // 0..1 键色相似度阈值
  edgeSoftness: number; // 0..1 边缘柔化宽度
  spill: number;        // 0..1 溢出（键色反光）抑制强度
  // ── P1 智能抠像（与后端统一契约）──
  model?: 'modnet' | 'rmbg2';  // 智能抠像模型（默认 modnet）
  threshold?: number;          // 0..1 前景/背景阈值（matte 二值化参考）
  matteAssetId?: string;       // 已生成的 matte 资产 id（导出时回引）
  // ── 背景合成（P3）──
  background?: KeyingBackground;
}
// ── 美颜·皮肤管理（Beauty）数据模型（前后端统一）──
// 仅做皮肤管理（磨皮/美白/清晰/肤色），不做美体/五官塑形/美妆。
// M1 全部为传统图像处理，不依赖 AI 模型；M3 高阶（匀肤/祛斑/黑眼圈）为自研模型，本期不实现。
export type SkinTone = 'none' | 'cool' | 'natural' | 'warm' | 'wheat' | 'bronze';
export interface BeautyConfig {
  enabled: boolean;
  // M1 基础参数（0~100，前端滑块；导出/预览映射为滤镜强度）
  smoothing: number;   // 磨皮
  whitening: number;   // 美白
  clarity: number;     // 清晰
  // 肤色预设（单选，不参与 0~100 映射）
  skinTone: SkinTone;
  // 预计算资产（点「生成蒙版」后由后端回写）
  maskAssetId?: string;   // 自研皮肤分割产出的灰度 skin_mask.mp4 资产 id
}
export interface TransitionConfig {
  transitionType?: TransitionType; // 默认 'none'
  duration?: number;               // 秒，默认 0.5，夹取 0.1–3.0
  direction?: WipeDirection;       // slide / wipe 方向，默认 'right'
  easing?: TransitionEasing;       // 缓动，默认 'ease-in-out'
  feather?: number;                // 遮罩羽化 0–30（像素感），默认 10
  blurAmount?: number;             // 模糊过渡强度 0–100，默认 65
  maskShape?: WipeMaskShape;       // wipe 遮罩形状，默认 'linear'
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
export type ExportResolution = 'original' | '2160p' | '1080p' | '720p' | '480p';
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

// ── 口播剪辑（speech auto-editing） ──
// 输入选项：与 Python bridge / Rust speech_analyze 的 --opts JSON 字段对齐
export interface SpeechEditOptions {
  modelSize?: 'tiny' | 'base' | 'small' | 'medium' | 'large'; // whisper 尺寸，默认 base
  useDemucs: boolean;        // 声源分离降噪
  vadThreshold: number;      // VAD 灵敏度 0~1，默认 0.25
  minGap: number;            // 最小停顿(秒)，默认 0.18
  wordPad: number;           // 词边界 padding(秒)，默认 0.04
  denoise: boolean;          // 去齿音/响度归一（降噪增强）
  deess: boolean;            // 去齿音
  normalize: boolean;        // 响度归一(LUFS)
  fillers: boolean;          // 删语气词废话
  keepNonspeech?: boolean;   // 保留背景音乐/环境音（默认 true：只删静音/语气词/气声/瞬态，不动音乐；false=紧凑模式，连非人声一起丢）
  trimSilence?: boolean;     // 修剪首尾静音（默认 true：删开头/结尾的低能量静音段）
  exclude?: [number, number][]; // 手动排除区间(秒) [start,end]
}

// 输出：与 W1 决策层 keep_segments + detail 对齐
export interface SpeechEditWord { word: string; start: number; end: number }
export interface SpeechEditDetailItem { type: string; start: number; end: number }
export interface SpeechEditResult {
  duration: number;                       // 原媒体时长(秒)
  sampleRate: number;                     // 采样率
  words: SpeechEditWord[];                // 逐词时间戳
  keepSegments: [number, number][];       // ★ 核心编辑方案（相对原媒体的保留秒区间）
  detail: SpeechEditDetailItem[];         // 删除原因分类
  totalRemovedSec: number;                // 删除总时长
  ratio: number;                          // 压缩比例 0~1
  separated?: boolean;                    // 是否成功做了声源分离（人声/伴奏各自独立）
  vocalPath?: string;                     // 分离出的人声 stem 路径（separated 时存在）
  accompPath?: string;                    // 分离出的伴奏 stem 路径（separated 时存在）
  musicSegments?: [number, number][];     // 非语音但含音乐/环境音的区间（秒），assemble 时作为「纯伴奏桥接段」保留，gap 音乐不丢
}

// assemble（生成清洗文件）的输出
export interface SpeechAssembleResult {
  outputPath: string;   // 新生成文件绝对路径
  duration: number;     // 新文件时长(秒)
  ok: boolean;
}

// assemble 的 --opts JSON 字段
export interface SpeechAssembleOptions {
  keepSegments: [number, number][];
  outputPath: string;
  crossfadeMs?: number; // 段间过渡(ms)，默认 20（assemble 用 ffmpeg acrossfade/xfade 做交叉淡化，消除硬切接缝的卡顿）
  declick?: boolean;    // 去咔哒声（ffmpeg adeclick 滤镜，去除叠在人声里的爆音/咔哒）
  deess?: boolean;      // 去齿音（ffmpeg highshelf 近似）
  normalize?: boolean;  // 响度归一（ffmpeg loudnorm）
  separated?: boolean;  // 是否使用分离 stem 重组（cleaned 人声 + 原伴奏混回，音乐不丢）
  vocalPath?: string;   // 人声 stem 路径（separated 时提供）
  accompPath?: string;  // 伴奏 stem 路径（separated 时提供）
  musicSegments?: [number, number][]; // 纯伴奏桥接段（separated 时与 keepSegments 交替拼接，gap 音乐不丢）
}

export interface SpeechAPI {
  // analyze: 输入媒体路径 + 选项 JSON → 返回编辑方案
  analyze: (input: string, optsJson: string) => Promise<{ success: boolean; data?: SpeechEditResult; error?: string }>;
  // assemble: 输入媒体路径 + {keepSegments, outputPath, crossfadeMs} JSON → 生成新文件
  assemble: (input: string, optsJson: string) => Promise<{ success: boolean; data?: SpeechAssembleResult; error?: string }>;
  // separate: 输入媒体路径 + {mode, keep?, trackType?} JSON → 音频分离(av) / 声音分离(vocal)
  separate: (input: string, optsJson: string) => Promise<{ success: boolean; data?: any; error?: string }>;
}

declare global { interface Window { aicut: AicutAPI } }
export interface AicutAPI {
  // 引擎
  render(json: string): Promise<{ success: boolean; command?: string; error?: string }>;
  probe(path: string): Promise<{ success: boolean; info?: MediaInfo; error?: string }>;
  // 4K 源素材生成 720p 代理（仅当宽或高 > 1080 时）；返回代理路径，无需代理返回 ''
  ensureProxy(path: string, width: number, height: number): Promise<string>;
  getPresets(): Promise<string[]>;
  getVersion(): Promise<string>;
  validate(json: string): Promise<{ valid: boolean; errors?: string[] }>;
  // 文件
  openFiles(): Promise<string[]>;
  openProject(): Promise<string[]>;
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
  // 口播剪辑
  speech: SpeechAPI;
  // 美颜·皮肤管理
  beauty: { generate(input: string, optsJson: string): Promise<{ success: boolean; data?: any; error?: string }> };
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
  // 内置字体目录（随包分发字体文件所在路径，dev=仓库/public/fonts，打包=resources/fonts）
  getFontsDir(): Promise<string>;
}
