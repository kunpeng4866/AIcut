// 导出选项 → FFmpeg 参数 的纯函数（无 electron 依赖，可独立单测）。
// 由 main.ts 的 export:start 调用，也可被测试脚本直接 import 验证。

export interface ExportOptionsParam {
  kind: 'video' | 'audio' | 'subtitle';
  resolution: 'original' | '2160p' | '1080p' | '720p' | '480p';
  format: 'mp4-h264' | 'mp4-h265' | 'mov';
  quality: 'high' | 'medium' | 'low';
  audioFormat: 'mp3' | 'wav' | 'm4a';
  audioQuality: 'high' | 'medium' | 'low';
  subtitleFormat: 'srt' | 'ass' | 'vtt';
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

/**
 * 将引擎渲染命令（含完整音频混合滤镜图）改造为「仅导出音频」。
 * 复用 graph.rs 已生成的音频滤镜图（per-clip 音量/淡入淡出 + amix + alimiter），
 * 仅保留输入文件、-filter_complex、音频 -map，丢弃全部视频/编码/分辨率参数，
 * 追加 -vn 与音频编码器。无需重新实现音频混合逻辑。
 *
 * @throws 当工程无任何音频流（找不到 [a...] 输出标签）时抛 'NO_AUDIO'
 */

/**
 * 从完整 -filter_complex 中抽取「输出标签为音频」的链段，丢弃全部视频节点。
 * 用于音频导出：避免视频滤镜图输出（如 [va1]）悬空未连接导致 ffmpeg 报错。
 */
function extractAudioFilterChain(fc: string): string {
  const segs = fc.split(';');
  const audioSegs = segs.filter((s) => {
    const m = s.trim().match(/\[([^\]]+)\]\s*$/);
    return m ? /^a/.test(m[1]) : false;
  });
  return audioSegs.join(';');
}

export function applyAudioExport(args: string[], options: ExportOptionsParam): string[] {
  const result: string[] = [];

  // 1) 定位音频输出标签：优先从 -map 找 [a...]；兜底从 -filter_complex 里找 [aout]/[a0]
  let audioLabel: string | null = null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-map') {
      const m = args[i + 1].match(/^\[([^\]]+)\]$/);
      if (m && /^a/.test(m[1])) { audioLabel = m[1]; break; }
    }
  }
  if (!audioLabel) {
    const fcIdx = args.indexOf('-filter_complex');
    if (fcIdx >= 0 && fcIdx + 1 < args.length) {
      const m = args[fcIdx + 1].match(/\[a(?:out|\d+)\]/);
      if (m) audioLabel = m[0].slice(1, -1);
    }
  }
  if (!audioLabel) {
    throw new Error('NO_AUDIO');
  }

  // 2) 只保留必要段：输入文件(-i)、-y/-n、音频滤镜链、音频 -map
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-i') {
      if (i + 1 < args.length) { result.push(a, args[i + 1]); i++; }
    } else if (a === '-y' || a === '-n') {
      result.push(a);
    } else if (a === '-filter_complex') {
      // ⚠️ 关键修复：引擎渲染命令的 -filter_complex 同时含【视频滤镜图】与【音频滤镜图】
      // （如 color[base];[0:v]…[va1];[base][va0]overlay…[va1];[0:a]…[a0]）。
      // 若把整个滤镜图都保留、却只 -map [a0] 音频输出，视频输出标签 [va1] 会「悬空未连接」，
      // ffmpeg 报 "Filter 'overlay:default' has output 0 (va1) unconnected / Error binding
      // filtergraph" 导致音频导出失败。因此只抽取【输出标签为音频】的链段（[0:a]…[a0]、
      // amix 链等），彻底丢弃视频节点。
      if (i + 1 < args.length) {
        result.push(a, extractAudioFilterChain(args[i + 1]));
        i++;
      }
    } else if (a === '-map') {
      if (i + 1 < args.length && /^\[a/.test(args[i + 1])) { result.push(a, args[i + 1]); }
      if (i + 1 < args.length) i++;
    }
    // 其余（视频/编码/分辨率/scale/vf/crf 等）全部丢弃
  }

  // 3) 不输出视频
  result.push('-vn');

  // 4) 音频编码器 + 码率
  const acodec =
    options.audioFormat === 'wav' ? 'pcm_s16le'
    : options.audioFormat === 'm4a' ? 'aac'
    : 'libmp3lame';
  result.push('-c:a', acodec);
  if (options.audioFormat !== 'wav') {
    const bitrateMap: Record<string, string> = { high: '320k', medium: '192k', low: '128k' };
    result.push('-b:a', bitrateMap[options.audioQuality] || '192k');
  }

  // 输出路径由调用方在末尾追加
  return result;
}

// ── 字幕导出（纯 JS，直接从工程 JSON 生成，不依赖 ffmpeg） ──

interface SubtitleEntry { start: number; end: number; text: string; }

/** 收集工程内所有字幕片段（clip.subtitle.items），按绝对时间排序 */
export function collectSubtitleEntries(project: any): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  for (const track of project?.tracks || []) {
    for (const clip of track.clips || []) {
      const sub = clip.subtitle;
      if (sub && Array.isArray(sub.items)) {
        // 与预览端 PreviewCanvas.activeTextOverlays 严格对称：
        // 预览用 clipSourceTime 反解「绝对时间轴位置」t，使 srcT + lead ∈ [i.start, i.end) 命中字幕，
        //   srcT = src_range.start + (t - timelineIn) * speed
        // 反解得绝对位置 t = timelineIn + (i.start - lead - src_range.start) / speed。
        // 旧实现只写 timelineIn + i.start，忽略了 src_range.start / speed / lead，
        // 导致 ASR 字幕（src_range.start≠0）、变速、提前量场景下导出与预览错位。
        const timelineIn = clip.timelineIn || 0;
        const srcStart = (clip.src_range && clip.src_range.start) || 0;
        const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
        const lead = sub.timeOffset || 0; // 与预览 clipSourceTime + lead 对称
        const hasRemap = !!(
          clip.time_remap &&
          (clip.time_remap.curve?.length || clip.time_remap.reverse || clip.time_remap.freeze)
        );
        for (const it of sub.items) {
          let start: number;
          let end: number;
          if (hasRemap) {
            // 含变速曲线/倒放/冻结：线性反解不精确，回退为「时间轴坐标原样」
            // （与旧行为一致；曲线段字幕极少单独导出，烧录由 Rust source_to_timeline 权威处理）。
            start = timelineIn + (it.start || 0);
            end = timelineIn + (it.end || 0);
          } else {
            start = timelineIn + ((it.start || 0) - lead - srcStart) / speed;
            end = timelineIn + ((it.end || 0) - lead - srcStart) / speed;
          }
          entries.push({ start, end, text: it.text || '' });
        }
      }
    }
  }
  entries.sort((a, b) => a.start - b.start);
  return entries;
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');
function fmtSrtTime(sec: number): string {
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
}
function fmtVttTime(sec: number): string {
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms).padStart(3, '0')}`;
}
function fmtAssTime(sec: number): string {
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${h}:${pad2(m)}:${pad2(s)}.${String(cs).padStart(2, '0')}`;
}

export function buildSubtitleExport(project: any, format: 'srt' | 'ass' | 'vtt'): string {
  const items = collectSubtitleEntries(project);
  if (format === 'vtt') {
    const body = items.map((it, i) => {
      const text = it.text.split('\n').map((l: string) => l).join('\n');
      return `${i + 1}\n${fmtVttTime(it.start)} --> ${fmtVttTime(it.end)}\n${text}`;
    }).join('\n\n');
    return `WEBVTT\n\n${body}\n`;
  }
  if (format === 'ass') {
    const events = items.map((it, i) => {
      const text = it.text.replace(/\n/g, '\\N');
      return `${i + 1},${fmtAssTime(it.start)},${fmtAssTime(it.end)},Default,,0,0,0,,${text}`;
    }).join('\n');
    const header =
      '[Script Info]\nScriptType: v4.00+\nPlayResX: 384\nPlayResY: 288\n\n' +
      '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, ' +
      'Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
      'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
      'Style: Default,Arial,48,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\n\n' +
      '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    return `${header}${events}\n`;
  }
  // srt
  const body = items.map((it, i) => {
    const text = it.text.split('\n').map((l: string) => l).join('\n');
    return `${i + 1}\n${fmtSrtTime(it.start)} --> ${fmtSrtTime(it.end)}\n${text}`;
  }).join('\n\n');
  return `${body}\n`;
}
