// 共享片段工厂：把"建轨 + 加片段 + 选中"等重复逻辑集中，供左侧面板各组件复用。
// 所有函数直接读/写 project store 与 ui store，调用方无需关心轨道查找细节。
import type { AssetConfig, ClipConfig, KeyingConfig, MaskConfig, TimeRemapConfig } from '../types';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';

// 生成唯一ID
export const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// 解析 SRT 字幕文本为定时条目（兼容空行分隔的块状格式）
export function parseSRT(srt: string): { start: number; end: number; text: string }[] {
  const blocks = srt.trim().split(/\n\s*\n+/);
  const out: { start: number; end: number; text: string }[] = [];
  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    // 找包含 "-->" 的时间轴行
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const times = lines[idx].split('-->');
    const toSec = (t: string): number => {
      const m = t.trim().match(/(?:(\d+):)?(?:(\d+):)?(\d+)[.,](\d+)/);
      if (!m) return 0;
      const h = Number(m[1] || 0), mn = Number(m[2] || 0), s = Number(m[3]), ms = Number(m[4]);
      return h * 3600 + mn * 60 + s + ms / 1000;
    };
    const start = toSec(times[0] || '0');
    const end = toSec(times[1] || '0');
    const text = lines.slice(idx + 1).join('\n');
    if (text) out.push({ start, end, text });
  }
  return out;
}

// 确保存在指定类型的轨道，返回其 id（找不到则新建）
export function ensureTrack(type: 'video' | 'audio' | 'text' | 'sticker' | 'subtitle'): string | null {
  const p = useProjectStore.getState();
  let track = p.project.tracks.find((t) => t.type === type);
  if (!track) {
    const id = p.addTrack(type);
    track = useProjectStore.getState().project.tracks.find((t) => t.id === id);
  }
  return track ? track.id : null;
}

// 往指定类型轨道追加片段并选中（自动建轨）
export function addClipToTrack(type: 'video' | 'audio' | 'text' | 'sticker' | 'subtitle', clip: ClipConfig): void {
  const trackId = ensureTrack(type);
  if (!trackId) return;
  const p = useProjectStore.getState();
  p.addClip(trackId, clip);
  useUIStore.getState().selectClip(trackId, clip.id);
}

// 生成一段文字片段（与之前 Timeline.handleAddText 的结构一致）
export function createTextClip(timelineIn = 0, duration = 5): ClipConfig {
  return {
    id: uid('clip'),
    assetId: '_text',
    src_range: { start: 0, end: duration },
    timelineIn,
    timelineOut: timelineIn + duration,
    text: {
      content: '新文字', fontSize: 48, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, strokeOpacity: 1, textAlign: 'center', x: 0.5, y: 0.5,
      background: { enabled: false, color: '#000000', opacity: 0.9, radius: 0.06, width: 0.19, height: 0.13, offsetX: 0.5, offsetY: 0.5 },
      shadow: { enabled: false, color: '#000000', opacity: 0.9, blur: 0.15, distance: 5, angle: -45 },
    },
  };
}

// 添加一段文字到文字轨并选中
export function addTextClip(): void {
  const p = useProjectStore.getState();
  let track = p.project.tracks.find((t) => t.type === 'text');
  if (!track) {
    const id = p.addTrack('text');
    track = useProjectStore.getState().project.tracks.find((t) => t.id === id);
    if (!track) return;
  }
  const lastEnd = track.clips.length > 0
    ? Math.max(...track.clips.map((c) => c.timelineOut))
    : 0;
  const clip = createTextClip(lastEnd);
  p.addClip(track.id, clip);
  useUIStore.getState().selectClip(track.id, clip.id);
}

// 导入解析后的字幕条目到字幕轨
export function addSubtitleClip(items: { start: number; end: number; text: string }[]): void {
  if (items.length === 0) return;
  const totalDuration = items[items.length - 1].end;
  const clip: ClipConfig = {
    id: uid('clip'),
    assetId: '_subtitle',
    src_range: { start: 0, end: totalDuration },
    timelineIn: 0,
    timelineOut: totalDuration,
    subtitle: { items, fontSize: 24, color: '#ffffff', position: 'bottom', align: 'center' },
  };
  addClipToTrack('subtitle', clip);
}

// 把长字符串按固定字数强切成若干块（只在「无标点可依」或「单句仍超长」时兜底使用）。
function chunkByChars(s: string, maxChars: number): string[] {
  const res: string[] = [];
  const step = Math.max(1, maxChars);
  for (let i = 0; i < s.length; i += step) res.push(s.slice(i, i + step));
  return res.filter(Boolean);
}

// 把 ASR 结果切成「短语短句」字幕行（剪映式断句）。
// ── 核心事实：两种 ASR 模型返回颗粒度完全不同，必须分别处理 ──
//   • Paraformer-realtime-v2（Recognition 接口）：返回【词级】segments，
//     每个词带真实 begin/end_time（bridge._segments_from_sentence 读 words[]）。
//     → 输入是几十个短 segment。用【词间真实停顿】聚合，能还原剪映式短语
//       （此前「好用」的依据就在这里）。
//   • qwen3-asr-flash-realtime（OmniRealtimeConversation）：按 VAD 断句，
//     每条=一整句，无词级时间戳、时间用字节粗推（bridge._recognize_qwen_omni，word_level=false）。
//     → 输入只有几条长 segment（如 16s 音频≈2 句）→ 若不细分就「只分 2 段」。
// ── 算法：自动识别颗粒度（优先用 bridge.word_level 权威标志，否则 avgLen 启发式），两套规则 ──
//   ① 原子化：每段→内容原子(+标点原子)；词级每段一词无标点→直是内容原子(真实时间保留)；
//      句级长段按标点切，标点作断点标记，内容原子按字数比例分配段内时间。
//   ② 词级模式：仅在「真实短语停顿(>自适应边界)」或「句末标点」处断行；逗号仅当有真实停顿/已超长才断
//      （保留「我是男中音张大伟，今天呢」合并为整行，贴近剪映）。
//   ③ 句级模式：逗号即断（用户要求「把逗号也加进去」）+ 句末标点硬断 + 超长无标点则按字数兜底；
//      时间取段内首末原子真实时间（句窗口本身较准，段内轻微漂移可接受）。
//   ④ 行长安全：某短语极长(>HARD_MAX)且无内部停顿→在最大 gap 处兜底断（极少触发）。
//   每行起止=组内首/末原子真实时间→与语音对齐、整行显示、绝不撕裂词语。
const SUB_MAX_CHARS = 18; // 单行软上限（句级超长兜底 / 词级安全网参考）
const SUB_SOFT_COMMA_MAX = 10; // 词级逗号软断字数阈值
const SUB_PAUSE_FLOOR = 0.45; // 短语停顿绝对下限(秒)：低于此绝不视为边界，防 intra-word 误切
const SUB_PAUSE_K = 3.5; // 相对中位数倍数：边界 = max(FLOOR, 中位数×K)
const SUB_HARD_MAX = 30; // 单行硬上限(字)；超此且短语内无大停顿才兜底断

function resegmentForCaptions(
  segments: { start: number; end: number; text: string }[],
  maxChars: number = SUB_MAX_CHARS,
  opts?: { wordLevel?: boolean },
): { start: number; end: number; text: string }[] {
  const hasCjk = (s: string) => [...s].some((ch) => ch >= '一' && ch <= '鿿');
  const PUNCT = /[，。！？；：、,.!?;:~\-—…]/;
  const SENT_END = /[。！？!?；;]$/;
  type Atom = { start: number; end: number; text: string; punct: boolean; sentEnd: boolean };

  // ① 原子化
  const atoms: Atom[] = [];
  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    const dur = Math.max(0.05, seg.end - seg.start);
    const pieces = text.match(/[^，。！？；：、,.!?;:~\-—…]+|[，。！？；：、,.!?;:~\-—…]/g) || [text];
    if (pieces.length <= 1) {
      // 单段无内部标点：若超长则按字数硬拆（取真实首末时间子段）
      if ([...text].length > maxChars) {
        const total = [...text].length;
        let acc = 0;
        for (let i = 0; i < total; i += maxChars) {
          const ch = text.slice(i, i + maxChars);
          const f = [...ch].length / total;
          atoms.push({ start: seg.start + acc * dur, end: seg.start + (acc + f) * dur, text: ch, punct: false, sentEnd: false });
          acc += f;
        }
        continue;
      }
      const isPunct = PUNCT.test(text) && [...text].length <= 1;
      atoms.push({ start: seg.start, end: seg.end, text, punct: isPunct, sentEnd: SENT_END.test(text) });
      continue;
    }
    const total = pieces.reduce((a, p) => a + [...p].length, 0) || 1;
    let acc = 0;
    for (const p of pieces) {
      const f = [...p].length / total;
      atoms.push({
        start: seg.start + acc * dur,
        end: seg.start + (acc + f) * dur,
        text: p,
        punct: PUNCT.test(p) && [...p].length <= 1,
        sentEnd: SENT_END.test(p),
      });
      acc += f;
    }
  }
  if (atoms.length === 0) return [];

  // ② 颗粒度判定：优先用 bridge.word_level 权威标志，否则用 avgLen 启发式
  //    （词级：avgLen 很小、segment 很多；句级：avgLen 大、segment 很少）
  const totalChars = segments.reduce((a, s) => a + (s.text ? [...s.text].length : 0), 0);
  const avgLen = totalChars / Math.max(1, segments.length);
  let isWordLevel: boolean;
  if (opts?.wordLevel === true) isWordLevel = true;
  else if (opts?.wordLevel === false) isWordLevel = false;
  else isWordLevel = avgLen <= 6;

  // ③ 自适应停顿阈值（仅词级模式使用）：统计相邻内容原子间真实 gap 的中位数（排除标点原子），
  //    边界 = max(FLOOR, 中位数×K)。相对中位数能自适应说话快慢，且避免把 intra-word 小停顿误判为边界。
  let boundaryGap = SUB_PAUSE_FLOOR;
  if (isWordLevel) {
    const gaps: number[] = [];
    for (let i = 0; i < atoms.length - 1; i++) {
      if (atoms[i].punct || atoms[i + 1].punct) continue;
      const g = atoms[i + 1].start - atoms[i].end;
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    boundaryGap = Math.max(SUB_PAUSE_FLOOR, median * SUB_PAUSE_K);
  }

  // ④ 聚合：按颗粒度走不同断行规则
  const out: { start: number; end: number; text: string }[] = [];
  let buf: Atom[] = [];
  const bufLen = () => buf.reduce((s, b) => s + [...b.text].length, 0);
  const flush = () => {
    if (buf.length === 0) return;
    const joined = buf.map((b) => b.text).join('');
    const text = hasCjk(joined) ? joined : buf.map((b) => b.text).join(' ');
    out.push({ start: buf[0].start, end: buf[buf.length - 1].end, text });
    buf = [];
  };
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.punct) {
      if (a.sentEnd) {
        flush(); // 句末标点：硬断（两种模式一致）
        continue;
      }
      if (isWordLevel) {
        // 词级：逗号软断——仅当逗号处真实停顿超边界 或 已超长才断（保留「张/今天呢」合并）
        const prevEnd = buf.length > 0 ? buf[buf.length - 1].end : null;
        let nextStart: number | null = null;
        for (let j = i + 1; j < atoms.length; j++) {
          if (!atoms[j].punct) { nextStart = atoms[j].start; break; }
        }
        const pauseAcross = prevEnd != null && nextStart != null ? nextStart - prevEnd : 0;
        if (buf.length > 0 && (pauseAcross > boundaryGap || bufLen() > SUB_SOFT_COMMA_MAX)) flush();
      } else {
        // 句级：逗号即断（用户要求「把逗号也加进去」）
        if (buf.length > 0) flush();
      }
      continue;
    }
    if (isWordLevel) {
      // 词级：与上一内容原子的真实停顿决定是否断行
      const prevEnd = buf.length > 0 ? buf[buf.length - 1].end : null;
      const gap = prevEnd != null ? a.start - prevEnd : 0;
      if (buf.length > 0 && gap > boundaryGap) {
        flush(); // 仅真实短语停顿才断
      } else if (buf.length > 0 && bufLen() + [...a.text].length > SUB_HARD_MAX) {
        // 行长安全：超硬上限且本短语内无大停顿 → 在 buf 内最大 gap 处兜底断（不切词）
        let cutAt = 0;
        let best = -1;
        for (let k = 0; k < buf.length - 1; k++) {
          const gk = buf[k + 1].start - buf[k].end;
          if (gk > best) { best = gk; cutAt = k + 1; }
        }
        if (cutAt > 0 && cutAt < buf.length && best > SUB_PAUSE_FLOOR * 0.6) {
          const head = buf.slice(0, cutAt);
          const joinedH = head.map((b) => b.text).join('');
          out.push({ start: head[0].start, end: head[head.length - 1].end, text: hasCjk(joinedH) ? joinedH : head.map((b) => b.text).join(' ') });
          buf = buf.slice(cutAt);
        }
      }
    } else {
      // 句级：无词级停顿信号，仅按行长兜底（正常情况逗号/句末标点已断，此处极少触发）
      if (buf.length > 0 && bufLen() + [...a.text].length > maxChars) flush();
    }
    buf.push(a);
  }
  flush();
  return out;
}

// 把「{start,end,text} 行」按参考片段对齐，逐句构建字幕 clip 追加到指定轨道，返回追加条数。
// 对齐数学（与剪映一致、「一句一片段」）：
//   clip.src_range.start = relStart；item.start = relStart；timelineIn = refIn + relStart/speed
// 故预览(PreviewCanvas.clipSourceTime)与导出(subtitle.rs.source_to_timeline)均逐句精准对齐。
function buildSubtitleClips(
  lines: { start: number; end: number; text: string }[],
  refClip: ClipConfig | undefined,
  trackId: string,
): number {
  const p = useProjectStore.getState();
  const refStart = refClip?.src_range.start ?? 0;
  const refEnd = refClip ? refClip.src_range.end : lines[lines.length - 1].end;
  const refDur = refEnd - refStart;
  const refTimelineIn = refClip?.timelineIn ?? 0;
  const speed = refClip?.speed ?? 1;
  const timeRemap = refClip?.time_remap ?? undefined;

  let count = 0;
  for (const line of lines) {
    if (!line.text) continue;
    // 先 clamp 到参考片段源区间 [0, refDur] 再判有效，避免 refClip.src_range.start != 0 时
    // 早期句子 relEnd<=0 被整句 continue 丢弃（问题2：开头语音丢失的成因之一）。
    let relStart = Math.max(0, Math.min(refDur, line.start - refStart));
    let relEnd = Math.max(0, Math.min(refDur, line.end - refStart));
    if (relEnd <= relStart) continue;
    const clip: ClipConfig = {
      id: uid('clip'),
      assetId: '_subtitle',
      src_range: { start: relStart, end: relEnd },
      timelineIn: refTimelineIn + relStart / speed,
      timelineOut: refTimelineIn + relEnd / speed,
      // 同步参考片段的变速/时间重映射，保证字幕与音频逐帧对齐
      speed,
      time_remap: timeRemap,
      subtitle: { items: [{ start: relStart, end: relEnd, text: line.text }], fontSize: 24, color: '#ffffff', position: 'bottom', align: 'center' },
    };
    p.addClip(trackId, clip);
    count++;
  }
  return count;
}

// 语音转写(ASR)结果 → 字幕轨，并与参考音/视频片段对齐。
// resegmentForCaptions 把 ASR 结果切成「语义/韵律短句」字幕行（按颗粒度自动选停顿聚合或标点断句，
// 每行起止取组内真实时间），再逐句构建 clip —— 整行作为完整语义单元一次性显示、且与语音对齐。
// opts.wordLevel：bridge 返回的权威标志（paraformer 词级=true / qwen3 句级=false），用于精确区分两套规则；
//   缺省时由 resegmentForCaptions 按 avgLen 启发式自动判定。
// 复用已存在的 subtitle 轨（不再每次新建），多次转写落在同一轨、可复制后自行整理。
export function createSubtitleClipFromAsr(
  segments: { start: number; end: number; text: string }[],
  refClip?: ClipConfig,
  opts?: { wordLevel?: boolean; preGrouped?: boolean },
): number {
  if (!segments || segments.length === 0) return 0;
  // 桥已预分组（双路融合产出的剪映式短语，时间已词级精确对齐）→ 直接消费，不再重切
  const lines = opts?.preGrouped
    ? segments.map((s) => ({ start: s.start, end: s.end, text: s.text }))
    : resegmentForCaptions(segments, 18, opts?.wordLevel !== undefined ? { wordLevel: opts.wordLevel } : undefined);
  if (lines.length === 0) return 0;
  const trackId = ensureTrack('subtitle');
  if (!trackId) return 0;
  const count = buildSubtitleClips(lines, refClip, trackId);
  if (count === 0) return 0;
  // 选中第一条，便于右侧立即编辑
  const firstClip = useProjectStore.getState().project.tracks.find((t) => t.id === trackId)?.clips[0];
  if (firstClip) useUIStore.getState().selectClip(trackId, firstClip.id);
  return count;
}

// 翻译选中字幕片段 → 时间轴「新」字幕轨（与源语言轨分离，译文放新轨道）。
// 直接克隆源片段（timelineIn/Out、src_range、speed、time_remap 全部保持），仅把 subtitle.items 的文本换成译文，
// 故译文与源字幕、进而与音频严格同刻对齐，不经过任何重估时长。
export function createTranslatedClipFromClip(sourceClip: ClipConfig, translatedTexts: string[]): number {
  const p = useProjectStore.getState();
  const srcItems = sourceClip.subtitle?.items ?? [];
  if (srcItems.length === 0 || translatedTexts.length === 0) return 0;
  const items = srcItems.map((it, i) => ({ ...it, text: translatedTexts[i] ?? it.text }));
  const newClip: ClipConfig = {
    ...JSON.parse(JSON.stringify(sourceClip)),
    id: uid('clip'),
    subtitle: { ...(sourceClip.subtitle ?? { fontSize: 24, color: '#ffffff', position: 'bottom' }), items },
  };
  const trackId = p.addTrack('subtitle');
  p.addClip(trackId, newClip);
  useUIStore.getState().selectClip(trackId, newClip.id);
  return items.length;
}

// 整轨翻译：把选中片段所在字幕轨「全部」片段翻译成一条新字幕轨（问题3）。
// sourceClips：同轨、按时间轴排序的所有源片段；translatedItemsList[i] 是第 i 个源片段的译文 items
// （按 item 顺序，与源 1:1 对应）。逐源片段克隆（timelineIn/Out、src_range、speed、time_remap 全部保持），
// 仅替换 subtitle.items 文本 → 译文与源字幕、音频严格同刻对齐，数量/顺序一一对应。
export function createTranslatedTrack(
  sourceClips: ClipConfig[],
  translatedItemsList: string[][],
): number {
  const p = useProjectStore.getState();
  if (!sourceClips.length) return 0;
  const trackId = p.addTrack('subtitle');
  let count = 0;
  sourceClips.forEach((src, i) => {
    const srcItems = src.subtitle?.items ?? [];
    const translated = translatedItemsList[i] ?? [];
    const items = srcItems.map((it, j) => ({
      ...it,
      text: (translated[j] ?? it.text).trim() || it.text,
    }));
    const newClip: ClipConfig = {
      ...JSON.parse(JSON.stringify(src)),
      id: uid('clip'),
      subtitle: { ...(src.subtitle ?? { fontSize: 24, color: '#ffffff', position: 'bottom' }), items },
    };
    p.addClip(trackId, newClip);
    count++;
  });
  if (count > 0) {
    const first = useProjectStore.getState().project.tracks.find((t) => t.id === trackId)?.clips[0];
    if (first) useUIStore.getState().selectClip(trackId, first.id);
  }
  return count;
}

// 生成一段图片贴纸片段
export function createImageStickerClip(asset: AssetConfig, timelineIn = 0): ClipConfig {
  const dur = asset.duration || 5;
  return {
    id: uid('clip'),
    assetId: asset.id,
    src_range: { start: 0, end: dur },
    timelineIn,
    timelineOut: timelineIn + dur,
    transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    volume: 1, speed: 1,
    effects: [], masks: [] as MaskConfig[], filters: [], keyframes: {},
    keying: undefined,
  };
}

// 生成一段音频片段（用于 TTS 配音、导入音频等落到音频轨）。
// 默认 duration 取素材时长，timelineIn 默认 0；volume 默认 1。
// speed / timeRemap：可选继承「字幕/参考片段」的变速，使音频在时间轴上经历与字幕完全相同的
// 变速（加速/减速/倒放/曲线）。不传则 speed=1（原速）。timelineOut = timelineIn + srcDur/speed，
// 与字幕 clip 的构建公式（buildSubtitleClips：timelineOut = refIn + relEnd/speed）严格一致。
export function createAudioClip(
  asset: AssetConfig,
  opts?: { timelineIn?: number; duration?: number; volume?: number; speed?: number; timeRemap?: TimeRemapConfig },
): ClipConfig {
  const dur = opts?.duration ?? asset.duration ?? 5;
  const inT = opts?.timelineIn ?? 0;
  const speed = opts?.speed && opts.speed > 0 ? opts.speed : 1;
  const timeRemap = opts?.timeRemap
    ? { ...opts.timeRemap, curve: opts.timeRemap.curve ? [...opts.timeRemap.curve] : undefined, freeze: opts.timeRemap.freeze ? { ...opts.timeRemap.freeze } : null }
    : undefined;
  return {
    id: uid('clip'),
    assetId: asset.id,
    src_range: { start: 0, end: dur },
    timelineIn: inT,
    timelineOut: inT + dur / speed,
    transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    volume: opts?.volume ?? 1,
    speed,
    time_remap: timeRemap,
    effects: [],
    masks: [],
    filters: [],
    keyframes: {},
  };
}

// 生成一段默认抠像配置（M1 仅 chroma 色度抠图可用）
export function createDefaultKeying(): KeyingConfig {
  return {
    enabled: true,
    mode: 'chroma',
    color: '#00ff00',
    similarity: 0.4,
    edgeSoftness: 0.1,
    spill: 0.5,
    model: 'modnet',
    threshold: 0.5,
  };
}
