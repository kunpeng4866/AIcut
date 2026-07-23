/**
 * @aicut/engine — 插件/扩展接口（TS 侧）
 *
 * 与 Rust 侧 src/plugin.rs 的 serde 序列化结果一一对齐。
 * 字段命名采用 snake_case（serde 默认），与 packages/engine/src/index.ts
 * 中的 ProjectConfig 风格保持一致。
 *
 * 桥接策略：N-API 优先，CLI 回退（参考 index.ts）。
 *   - N-API 暴露：pluginList / pluginListByType / pluginBuildFilter
 *   - CLI 子命令：aicut-engine plugin list | list-by-type <t> | build <id> <paramsJson>
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// ═══════════════════════════════ 类型定义 ═══════════════════════════════
// Rust enum 经 serde(rename_all = "PascalCase") 序列化为 PascalCase 字符串。

/** 插件类型（对齐 Rust PluginType） */
export type PluginType = 'Filter' | 'Effect' | 'Transition' | 'TextTemplate' | 'Sticker';

/** 参数控件类型（对齐 Rust ParamType） */
export type ParamType = 'Slider' | 'Toggle' | 'Color' | 'Select';

/** 插件暴露的单个参数定义（对齐 Rust ParameterDef） */
export interface ParameterDef {
  key: string;
  label: string;
  param_type: ParamType;
  default: number;
  min: number;
  max: number;
  step?: number | null;
}

/** 插件清单（对齐 Rust PluginManifest） */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  plugin_type: PluginType;
  min_app_version: string;
  parameters: ParameterDef[];
  /** FFmpeg 滤镜模板，`{key}` 占位符由参数实际值替换 */
  filter_spec?: string | null;
  /** WGSL 着色器源码（预览用，可选） */
  shader?: string | null;
  thumbnail?: string | null;
}

// ═══════════════════════════════ 桥接层 ═══════════════════════════════

/** CLI 二进制名（与 index.ts 一致） */
const ENGINE_BIN = 'aicut-engine';

/**
 * 尝试动态加载 N-API 原生模块。失败返回 null，调用方回退到 CLI。
 * 与 index.ts 中 tryLoadNative 行为一致，但此处优先复用其导出（若已加载）。
 */
function tryLoadNative(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./engine-native');
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('@aicut/engine-native');
    } catch {
      return null;
    }
  }
}

/** CLI 调用封装：stdout 作为 trim 后字符串返回 */
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
 * 插件管理器客户端。封装对 Rust 侧 PluginManager 的调用，
 * 调用方不感知 N-API / CLI 切换细节。
 */
export class PluginClient {
  /**
   * 返回所有已加载插件清单。
   * 路径1：N-API pluginList() → PluginManifest[]
   * 路径2：CLI `aicut-engine plugin list`（stdout 为 JSON 数组）
   */
  async list(): Promise<PluginManifest[]> {
    const native = tryLoadNative();
    if (native && typeof native.pluginList === 'function') {
      return native.pluginList() as PluginManifest[];
    }
    const out = await execFilePromise(ENGINE_BIN, ['plugin', 'list']);
    return JSON.parse(out) as PluginManifest[];
  }

  /**
   * 按类型筛选插件。
   * 路径1：N-API pluginListByType(type) → PluginManifest[]
   * 路径2：CLI `aicut-engine plugin list-by-type <type>`
   */
  async listByType(type: PluginType): Promise<PluginManifest[]> {
    const native = tryLoadNative();
    if (native && typeof native.pluginListByType === 'function') {
      return native.pluginListByType(type) as PluginManifest[];
    }
    const out = await execFilePromise(ENGINE_BIN, ['plugin', 'list-by-type', type]);
    return JSON.parse(out) as PluginManifest[];
  }

  /**
   * 生成 FFmpeg 滤镜字符串。将 filter_spec 模板中的 `{key}` 替换为
   * params 中提供的实际值；未提供的参数使用 default；越界值被 clamp。
   *
   * 路径1：N-API pluginBuildFilter(id, paramsJson) → string
   * 路径2：CLI `aicut-engine plugin build <id> <paramsJson>`
   *
   * @param pluginId 插件 id（如 "filter.brightness"）
   * @param params   参数键值（数值类型）
   */
  async buildFilter(
    pluginId: string,
    params: Record<string, number>,
  ): Promise<string> {
    const paramsJson = JSON.stringify(params);
    const native = tryLoadNative();
    if (native && typeof native.pluginBuildFilter === 'function') {
      return native.pluginBuildFilter(pluginId, paramsJson) as string;
    }
    // CLI 子命令接收两个独立参数：插件 id 和参数 JSON
    return execFilePromise(ENGINE_BIN, ['plugin', 'build', pluginId, paramsJson]);
  }

  /**
   * 触发 Rust 侧重新扫描插件目录。
   * 路径1：N-API pluginScan() → number（已加载插件数）
   * 路径2：CLI `aicut-engine plugin scan`
   */
  async scan(): Promise<number> {
    const native = tryLoadNative();
    if (native && typeof native.pluginScan === 'function') {
      return native.pluginScan() as number;
    }
    const out = await execFilePromise(ENGINE_BIN, ['plugin', 'scan']);
    return JSON.parse(out) as number;
  }

  /**
   * 从本地 manifest.json 文件直接解析清单（不经过 Rust）。便于前端在
   * 未构建原生模块时预览插件元信息，或对单个 manifest 做校验。
   * 注意：此方法不做字段必填校验，仅做 JSON 解析。
   */
  async readManifest(manifestPath: string): Promise<PluginManifest> {
    const json = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(json) as PluginManifest;
  }

  /**
   * 读取插件目录下所有 manifest.json（前端本地索引，不依赖 Rust）。
   * 适用于插件市场预览、批量校验等场景。
   *
   * @param pluginDir 插件根目录
   */
  async readAllManifests(pluginDir: string): Promise<PluginManifest[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(pluginDir);
    } catch {
      return [];
    }
    const manifests: PluginManifest[] = [];
    for (const name of entries) {
      const manifestPath = path.join(pluginDir, name, 'manifest.json');
      try {
        const json = await fs.readFile(manifestPath, 'utf8');
        manifests.push(JSON.parse(json) as PluginManifest);
      } catch {
        // 子目录无 manifest 或解析失败：跳过
      }
    }
    return manifests;
  }
}

/** 默认插件目录：项目根下的 plugins/ */
export const DEFAULT_PLUGIN_DIR = path.resolve(
  process.cwd(),
  // 优先使用环境变量覆盖；否则回退到当前工作目录下的 plugins/
  process.env.AICUT_PLUGIN_DIR || 'plugins',
);

/** 单例客户端 */
export const pluginClient = new PluginClient();
