/**
 * @aicut/engine — TypeScript 桥接层
 *
 * 桥接策略（双路径，napi 优先 / CLI 回退）：
 *   1. 优先尝试 `require('@aicut/engine-native')`，即 Rust 引擎经 N-API 编译出的
 *      `.node` 原生模块（render / getPresetList / getVersion）。
 *   2. 若该原生模块不可用（如本沙箱网络被劫持、napi-rs 无法下载），则回退到调用
 *      Rust CLI 二进制 `aicut-engine`（由 src/main.rs 构建），通过 child_process
 *      传参 project JSON、读 stdout 得到结果。
 *
 * ⚠️ 降级原因：本沙箱无法下载 napi-rs，故 Node.js 不能直接 require('.node')。
 *    待网络可用，恢复 N-API 步骤见 E:\AIcut\docs\Phase4_进度.md 的「关于 N-API 绑定」。
 *
 * 真实环境使用：在 packages/engine 下执行 `npm i && npm run build`（需已构建
 *   出 aicut-engine 二进制，或在 @aicut/engine-native 可用时无需 CLI）。
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// ═══════════════════════════════ 类型定义 ═══════════════════════════════
// 字段命名严格对齐 src/project.rs 的 serde 重命名（assetId / timelineIn /
// timelineOut / type），保证 JSON 在 Rust 端可被正确反序列化。

/** 画布配置（导出分辨率 / 帧率 / 采样率） */
export interface CanvasConfig {
  width: number;
  height: number;
  /** 默认 30 */
  fps?: number;
  /** 默认 48000 */
  sample_rate?: number;
}

/** 素材描述 */
export interface AssetConfig {
  id: string;
  /** serde rename "type" */
  type: string;
  path: string;
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
}

/** 2D 变换（归一化 0-1，原点左下角） */
export interface TransformConfig {
  x?: number;
  y?: number;
  scale_x?: number;
  scale_y?: number;
  rotation?: number;
  opacity?: number;
}

/** 时间范围（秒，浮点） */
export interface RangeConfig {
  start: number;
  end: number;
}

/** 缓动：命名字符串或自定义三次贝塞尔控制点 (x1,y1,x2,y2) */
export type EasingConfig = 'Linear' | 'EaseIn' | 'EaseOut' | 'EaseInOut' | [number, number, number, number];

export interface KeyframeConfig {
  time: number;
  value: number;
  easing?: EasingConfig;
}

export interface KeyframeTrackConfig {
  keyframes?: KeyframeConfig[];
}

/** 片段级特效 */
export interface EffectConfig {
  kind: string;
  params?: Record<string, number>;
  enabled?: boolean;
}

/** 蒙版 */
export interface MaskConfig {
  shape: string;
  params?: Record<string, number>;
  invert?: boolean;
  feather?: number;
}

/** 抠像（与 gui/src/types.ts KeyingConfig 逐字对应，后端 serde 同名） */
export interface KeyingConfig {
  enabled: boolean;
  mode: 'chroma' | 'smart' | 'manual';
  color: string;        // '#rrggbb' 小写
  similarity: number;   // 0..1
  edgeSoftness: number; // 0..1
  spill: number;        // 0..1
  // ── P1 智能抠像（与后端统一契约）──
  model?: 'modnet' | 'rmbg2';
  threshold?: number;
  matteAssetId?: string;
}

/** 滤镜实例（来自 Clip.filters） */
export interface FilterInstanceConfig {
  kind: string;
  params?: Record<string, number>;
  enabled?: boolean;
}

/** 片段：素材引用 + 源/时间线范围 + 变换 + 效果/蒙版/滤镜/关键帧 */
export interface ClipConfig {
  id: string;
  /** serde rename "assetId" */
  assetId: string;
  src_range: RangeConfig;
  /** serde rename "timelineIn" */
  timelineIn: number;
  /** serde rename "timelineOut" */
  timelineOut: number;
  transform?: TransformConfig;
  volume?: number;
  speed?: number;
  effects?: EffectConfig[];
  masks?: MaskConfig[];
  keying?: KeyingConfig;
  filters?: FilterInstanceConfig[];
  keyframes?: Record<string, KeyframeTrackConfig>;
}

/** 轨道：按 order 排序的多片段容器 */
export interface TrackConfig {
  id: string;
  /** serde rename "type" */
  type: string;
  order?: number;
  clips: ClipConfig[];
}

/** AIcut 工程配置（顶层） */
export interface ProjectConfig {
  /** 默认 "1.0" */
  version?: string;
  canvas: CanvasConfig;
  assets: AssetConfig[];
  tracks: TrackConfig[];
}

/** 渲染结果：FFmpeg 命令行字符串 */
export interface RenderResult {
  command: string;
}

/** 滤镜预置元信息（name 即 getPresetList 返回项） */
export interface FilterPreset {
  name: string;
  display: string;
}

// ═══════════════════════════════ 桥接实现 ═══════════════════════════════

/** CLI 二进制名（需在 PATH 中，或由构建流程放置到已知位置） */
const ENGINE_BIN = 'aicut-engine';

/**
 * 尝试动态加载 N-API 原生模块。捕获任何失败（模块缺失 / 版本不符），返回 null
 * 以便调用方回退到 CLI 路径。用动态 require 避免模块缺失阻断整个包加载。
 */
function tryLoadNative(): any | null {
  // 优先本地编译的原生模块（cargo build 产出的 cdylib 重命名为 aicut_engine.node 后放置于本目录）
  try {
    // @ts-ignore - 本地 .node 桥接模块
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./engine-native');
  } catch {
    // 回退到发布态 npm 包（若已在 @aicut/engine-native 安装）
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('@aicut/engine-native');
    } catch {
      return null;
    }
  }
}

/** 将 CLI 调用的 stdout 作为 trim 后的字符串返回 */
function execFilePromise(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      },
    );
  });
}

/**
 * 渲染工程 → 返回 FFmpeg 命令字符串。
 * 路径1：N-API 原生模块 render(JSON.stringify(project))
 * 路径2：CLI 回退，写入临时 project JSON，调用 `aicut-engine render`，读 stdout
 */
export async function renderProject(project: ProjectConfig): Promise<RenderResult> {
  const native = tryLoadNative();
  if (native && typeof native.render === 'function') {
    const command = native.render(JSON.stringify(project));
    return { command };
  }

  const tmp = path.join(
    os.tmpdir(),
    `aicut-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  await fs.writeFile(tmp, JSON.stringify(project), 'utf8');
  try {
    const command = await execFilePromise(ENGINE_BIN, ['render', tmp]);
    return { command };
  } finally {
    await fs.unlink(tmp).catch(() => {
      /* 临时文件清理失败不致命 */
    });
  }
}

/**
 * 返回可用滤镜预置名列表。
 * 路径1：N-API getPresetList() → string[]
 * 路径2：CLI `aicut-engine presets`（stdout 为 JSON 数组）
 */
export async function getPresetList(): Promise<string[]> {
  const native = tryLoadNative();
  if (native && typeof native.getPresetList === 'function') {
    return native.getPresetList();
  }
  const out = await execFilePromise(ENGINE_BIN, ['presets']);
  return JSON.parse(out) as string[];
}

/**
 * 返回引擎版本字符串。
 * 路径1：N-API getVersion() → string
 * 路径2：CLI `aicut-engine version`
 */
export async function getVersion(): Promise<string> {
  const native = tryLoadNative();
  if (native && typeof native.getVersion === 'function') {
    return native.getVersion();
  }
  return execFilePromise(ENGINE_BIN, ['version']);
}
