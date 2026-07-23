/**
 * packages/engine/src/tts.ts — 火山引擎 TTS TypeScript 接口
 *
 * 类型与 Rust 侧 src/tts.rs 严格对齐。
 * 桥接策略与 index.ts 一致：优先 N-API 原生模块，回退到 CLI（aicut-engine tts）。
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// ════════════════════ 类型定义 ════════════════════

/** TTS 配置（与 gui/src/config/ai_config.ts 的 TTSConfig 对齐） */
export interface TtsConfig {
  appid: string;
  accessToken: string;
  endpoint?: string;       // 默认 https://openspeech.bytedance.com/api/v1/tts
  cluster?: string;        // 默认 volcano_tts
  defaultVoice?: string;   // 默认 BV002_streaming
}

/** TTS 请求参数 */
export interface TtsRequest {
  text: string;
  voiceType?: string;      // 为空则用 defaultVoice
  encoding?: string;       // mp3 / wav / pcm / ogg_opus，默认 mp3
  speedRatio?: number;     // 0.2-3.0，默认 1.0
  volumeRatio?: number;    // 0.1-3.0，默认 1.0
  pitchRatio?: number;     // 0.1-3.0，默认 1.0
}

/** TTS 响应 */
export interface TtsResponse {
  audio: Uint8Array;       // 解码后的音频字节
  encoding: string;
  duration: number;        // 秒，可能为 0
}

/** 可用音色列表 */
export const AVAILABLE_VOICES: ReadonlyArray<readonly [string, string]> = [
  ['BV002_streaming', '通用女声'],
  ['BV700_streaming', '灿灿'],
  ['BV701_streaming', '擎苍'],
];

/** 默认端点 */
export const DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts';
/** 默认集群 */
export const DEFAULT_CLUSTER = 'volcano_tts';

// ════════════════════ 客户端实现 ════════════════════

const ENGINE_BIN = 'aicut-engine';

/** 将 CLI 调用的 stdout 作为 string 返回 */
function execFilePromise(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * 火山引擎 TTS 客户端（TypeScript 侧）
 *
 * 通过调用 Rust CLI `aicut-engine tts` 实现合成。
 * 如未来 N-API 导出 tts 函数，可在此处优先走原生路径。
 */
export class TtsClient {
  private config: TtsConfig;

  constructor(config: TtsConfig) {
    this.config = config;
  }

  /**
   * 合成语音到文件，返回时长（秒）。
   * 调用 CLI: aicut-engine tts --appid ... --token ... --text ... --voice ... --output ...
   */
  async synthesizeToFile(request: TtsRequest, outputPath: string): Promise<number> {
    const args = [
      'tts',
      '--appid', this.config.appid,
      '--token', this.config.accessToken,
      '--text', request.text,
      '--voice', request.voiceType ?? '',
      '--output', outputPath,
    ];
    await execFilePromise(ENGINE_BIN, args);
    // 读取文件大小作为有效性校验
    const stat = await fs.stat(outputPath);
    if (stat.size < 10) {
      throw new Error(`TTS 输出文件过小 (${stat.size} bytes)，可能合成失败`);
    }
    return 0; // CLI 当前不回传精确时长，需 ffprobe 探测
  }

  /**
   * 合成语音到内存，返回音频字节。
   * 内部先写临时文件再读取。
   */
  async synthesize(request: TtsRequest): Promise<TtsResponse> {
    const tmp = path.join(os.tmpdir(), `aicut-tts-${Date.now()}.mp3`);
    try {
      await this.synthesizeToFile(request, tmp);
      const audio = await fs.readFile(tmp);
      return {
        audio: new Uint8Array(audio),
        encoding: request.encoding ?? 'mp3',
        duration: 0,
      };
    } finally {
      await fs.unlink(tmp).catch(() => { /* 临时文件清理失败不致命 */ });
    }
  }
}
