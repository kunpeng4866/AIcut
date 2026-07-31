// 导出选项 → FFmpeg 参数 的纯函数（无 electron 依赖，可独立单测）。
// 由 main.ts 的 export:start 调用，也可被测试脚本直接 import 验证。

export interface ExportOptionsParam {
  resolution: 'original' | '2160p' | '1080p' | '720p' | '480p';
  format: 'mp4-h264' | 'mp4-h265' | 'mov';
  quality: 'high' | 'medium' | 'low';
}

/** 简单的 shell 参数解析（处理引号） */
export function parseShellArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
    } else if (ch === '"') {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/** 将导出选项应用到 FFmpeg 参数（分辨率/编码器/CRF） */
export function applyExportOptions(args: string[], options: ExportOptionsParam): string[] {
  const result = [...args];

  // 分辨率：统一缩放输出高度。
  // 注意：引擎生成的命令若已含 -filter_complex（简单/转场工程走 graph.rs），
  // 不能再叠加简单 -vf（ffmpeg 禁止同一流既走 complex 又走 simple 滤镜），
  // 否则报 "Simple and complex filtering cannot be used together"。
  // 因此：有 -filter_complex 时把 scale 合并进滤镜图末尾节点；否则才用 -vf。
  if (options.resolution !== 'original') {
    const heights: Record<string, number> = { '2160p': 2160, '1080p': 1080, '720p': 720, '480p': 480 };
    const h = heights[options.resolution];
    if (h === undefined) {
      // 防御：未知分辨率（多见于主进程构建与渲染层下拉项不匹配，例如旧 dist-electron
      // 仍用不含 2160p 的 heights 表）不要注入 scale=-2:undefined，否则 ffmpeg 直接报
      // "Invalid argument" 导致导出失败。退回保持原画布尺寸导出，并给出明确告警。
      console.warn(`[export] 未知分辨率 "${options.resolution}"，跳过缩放，保持原画布尺寸导出`);
    } else {
    const scaleFilter = `scale=-2:${h}`;
    // 清除引擎带出的 -s WxH：它会在编码端再次约束尺寸，与上面的 scale 滤镜冲突
    // （ffmpeg 会自动插入 scale 把滤镜图输出尺寸拉回 -s 指定的尺寸，导致选 4K/720p
    // 实际仍输出画布原始尺寸）。选具体分辨率时由 scale 滤镜作为唯一尺寸来源。
    const sIdx = result.indexOf('-s');
    if (sIdx >= 0 && sIdx + 1 < result.length) {
      result.splice(sIdx, 2);
    }
    const fcIdx = result.indexOf('-filter_complex');
    if (fcIdx >= 0 && fcIdx + 1 < result.length) {
      // 合并 scale 进 filter_complex，但必须作用于【视频】输出标签，而非图中最后一个标签。
      // 历史 bug：音频 [aout]/[a0] 常位于滤镜图末尾，若对其施加 scale 会报
      //   "Media type mismatch: audio output -> scale(video) input"
      // 因此显式定位视频输出标签：优先取 -map 中首个非音频标签；兜底取图中末个非音频输出标签。
      const fc = result[fcIdx + 1];
      const isAudioLabel = (l: string) => /^\[a/.test(l); // [a0] [a1] [aout] ...
      const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let videoLabel: string | null = null;
      // 1) 从 -map 推断视频输出标签（视频 map 通常在音频 map 之前；音频标签以 [a 开头）
      for (let i = 0; i < result.length - 1; i++) {
        if (result[i] === '-map') {
          const m = result[i + 1].match(/\[([^\]]+)\]/);
          if (m && !isAudioLabel('[' + m[1] + ']')) { videoLabel = m[1]; break; }
        }
      }
      // 2) 兜底：取 filter_complex 中最后一个【输出】位置且非音频的标签
      if (!videoLabel) {
        const outs = [...fc.matchAll(/\[([^\]]+)\]\s*(?=\s*;|\s*$)/g)];
        for (let k = outs.length - 1; k >= 0; k--) {
          if (!isAudioLabel('[' + outs[k][1] + ']')) { videoLabel = outs[k][1]; break; }
        }
      }
      if (videoLabel) {
        const scaledLabel = '__scaled__';
        // 仅替换 videoLabel 作为【输出标签】的位置（其后为 ; 或字符串结尾），
        // 避免误改它作为后续滤镜输入引用的位置。
        const outRe = new RegExp('\\[' + escapeRe(videoLabel) + '\\]\\s*(?=\\s*;|\\s*$)');
        if (outRe.test(fc)) {
          result[fcIdx + 1] = fc.replace(outRe, '[' + videoLabel + '];[' + videoLabel + ']' + scaleFilter + '[' + scaledLabel + ']');
          // 同步更新 -map 对该视频输出标签的引用
          for (let i = 0; i < result.length - 1; i++) {
            if (result[i] === '-map' && result[i + 1].includes('[' + videoLabel + ']')) {
              result[i + 1] = result[i + 1].split('[' + videoLabel + ']').join('[' + scaledLabel + ']');
            }
          }
        }
      }
      // 无视频输出（纯音频工程）：无需缩放，不注入 scale
    } else {
      // 无 filter_complex：简单路径，直接用 -vf
      const vfIdx = result.indexOf('-vf');
      if (vfIdx >= 0 && vfIdx + 1 < result.length) {
        result[vfIdx + 1] = `${result[vfIdx + 1]},${scaleFilter}`;
      } else {
        result.splice(result.length - 1, 0, '-vf', scaleFilter);
      }
    }
    }
  }

  // 4K 超清：码率跟随分辨率档（引擎按画布分辨率设的 8M 对 4K 偏低），覆盖为固定 25M。
  // 同时移除 -crf：引擎默认带 -crf，libx264 会优先走 CRF 模式忽略 -b:v，
  // 导致 4K 实际码率不足。4K 用 ABR 固定码率保证清晰度。
  if (options.resolution === '2160p') {
    const bvIdx = result.indexOf('-b:v');
    if (bvIdx >= 0 && bvIdx + 1 < result.length) {
      result[bvIdx + 1] = '25M';
    } else {
      result.splice(result.length - 1, 0, '-b:v', '25M');
    }
    const crfIdx = result.indexOf('-crf');
    if (crfIdx >= 0) result.splice(crfIdx, 2);
  }

  // 格式 / 编码器
  const codecMap: Record<string, string> = {
    'mp4-h264': 'libx264',
    'mp4-h265': 'libx265',
    'mov': 'libx264',
  };
  const codec = codecMap[options.format] || 'libx264';
  const cvIdx = result.indexOf('-c:v');
  if (cvIdx >= 0 && cvIdx + 1 < result.length) {
    result[cvIdx + 1] = codec;
  } else {
    result.splice(result.length - 1, 0, '-c:v', codec);
  }

  // 质量 / CRF（4K 已用固定 25M 码率，跳过 CRF 避免覆盖 ABR）
  if (options.resolution !== '2160p') {
    const crfMap: Record<string, number> = { high: 18, medium: 23, low: 28 };
    const crf = crfMap[options.quality] ?? 23;
    const crfIdx = result.indexOf('-crf');
    if (crfIdx >= 0 && crfIdx + 1 < result.length) {
      result[crfIdx + 1] = String(crf);
    } else {
      result.splice(result.length - 1, 0, '-crf', String(crf));
    }
  }

  // MOV 容器需要 -movflags +faststart
  if (options.format === 'mov') {
    result.splice(result.length - 1, 0, '-movflags', '+faststart');
  }

  return result;
}
