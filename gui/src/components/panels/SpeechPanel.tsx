// SpeechPanel —— 口播剪辑面板（speech auto-editing）
//
// 交互流程（镜像 AIPanel 的素材选择逻辑 + MediaPanel 的落轨逻辑）：
//   1) 从时间轴选中一个视频/音频片段
//   2) 调整编辑选项 → 点「分析」调用 window.aicut.speech.analyze
//   3) 展示压缩统计 + 保留/删除时间轴可视化
//   4) 点「生成清洗片段」调用 window.aicut.speech.assemble → 落轨（原片段保留）

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { ClipConfig, SpeechEditOptions, SpeechEditResult, SpeechAssembleOptions } from '../../types';
import { useConfigStore } from '../../store/configStore';
import { useAssetStore } from '../../store/assetStore';
import { upsertPreviewOnTrack as upsertPreviewTrack } from '../../utils/speechPreviewTrack';

// 口播高精度强制对齐权重 Qwen3-ForcedAligner（1.8G，>500M），随用随下（一键补全）。
// 缺省不随包；分析/批量前若未下载则引导用户补全。其余口播权重（DFN3/PANNs）<500M 已随包内置。
const QWEN3FA_IDS = [
  'qwen3fa-model', 'qwen3fa-config', 'qwen3fa-genconfig', 'qwen3fa-tokenizer',
  'qwen3fa-vocab', 'qwen3fa-merges', 'qwen3fa-chattmpl', 'qwen3fa-preproc', 'qwen3fa-readme',
];

// 生成唯一ID（与 MediaPanel.tsx 同款实现）
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// 颜色（与 App.tsx 主题一致）
const C = {
  textMain: '#eee',
  textSub: '#aaa',
  accent: '#e94560',
  control: '#0f3460',
  panel: '#16213e',
  border: '#0f3460',
  keep: '#67e8c4',
  removed: '#fca5a5',
};

// 三预设：轻量 / 标准 / 激进（标准 = 面板全套默认）
type PresetKey = 'light' | 'standard' | 'aggressive';
type PresetValues = {
  modelSize: SpeechEditOptions['modelSize'];
  useDemucs: boolean;
  vadThreshold: number;
  minGap: number;
  wordPad: number;
  denoise: boolean;
  denoiseQuality: 'standard' | 'high';
  deess: boolean;
  normalize: boolean;
  fillers: boolean;
  keepNonspeech: boolean;
  trimSilence: boolean;
  sedEvents: boolean;
  sedThreshold: number;
  respiroBreath: boolean;
  stutterDetect: boolean;
  stutterThreshold: number;
  crossfadeMs: number;
  declick: boolean;
  maskSoften: boolean;
  maskSoftenFloor: number;
  isolateGapSec: number;
};
const PRESETS: Record<PresetKey, PresetValues> = {
  light: {
    modelSize: 'base', useDemucs: false, vadThreshold: 0.3, minGap: 0.1, wordPad: 0.02,
    denoise: true, denoiseQuality: 'standard', deess: false, normalize: false, fillers: true,
    keepNonspeech: false, trimSilence: true, sedEvents: true, sedThreshold: 0.4,
    respiroBreath: false, stutterDetect: true, stutterThreshold: 0.4, crossfadeMs: 20, declick: true, maskSoften: true, maskSoftenFloor: 0.5, isolateGapSec: 0.35,
  },
  standard: {
    modelSize: 'base', useDemucs: false, vadThreshold: 0.25, minGap: 0.18, wordPad: 0.04,
    denoise: true, denoiseQuality: 'standard', deess: false, normalize: false, fillers: true,
    keepNonspeech: true, trimSilence: true, sedEvents: true, sedThreshold: 0.5,
    respiroBreath: true, stutterDetect: true, stutterThreshold: 0.5, crossfadeMs: 20, declick: true, maskSoften: true, maskSoftenFloor: 0.5, isolateGapSec: 0.3,
  },
  aggressive: {
    modelSize: 'small', useDemucs: false, vadThreshold: 0.25, minGap: 0.18, wordPad: 0.06,
    denoise: true, denoiseQuality: 'high', deess: true, normalize: true, fillers: true,
    keepNonspeech: true, trimSilence: true, sedEvents: true, sedThreshold: 0.6,
    respiroBreath: true, stutterDetect: true, stutterThreshold: 0.6, crossfadeMs: 30, declick: true, maskSoften: true, maskSoftenFloor: 0.5, isolateGapSec: 0.25,
  },
};

// 由 keepSegments 求补集，得到「被删除」区间 [start,end]
const removedSpans = (keep: [number, number][], duration: number): [number, number][] => {
  const sorted = [...keep].sort((a, b) => a[0] - b[0]);
  const spans: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of sorted) {
    if (s > cursor) spans.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < duration) spans.push([cursor, duration]);
  return spans;
};

// 调整某个删除区间的起/止（patch.start / patch.end），返回新的 keepSegments
// 删除区间 d 的左侧保留段 end == d[0]、右侧保留段 start == d[1]；
// 改 d[0] → 两侧保留段边界都移到新值；改 d[1] 同理；首尾删除段只有一侧保留段。
const patchDeletion = (
  keep: [number, number][],
  duration: number,
  delIndex: number,
  patch: { start?: number; end?: number },
): [number, number][] => {
  const sorted = [...keep].sort((a, b) => a[0] - b[0]);
  const dels = removedSpans(sorted, duration);
  const d = dels[delIndex];
  if (!d) return keep;
  let ns = patch.start !== undefined ? patch.start : d[0];
  let ne = patch.end !== undefined ? patch.end : d[1];
  ns = Math.max(0, Math.min(ns, ne - 0.001));
  ne = Math.min(duration, Math.max(ne, ns + 0.001));
  const newKeep = sorted.map((s) => [s[0], s[1]] as [number, number]);
  const val = patch.start !== undefined ? ns : ne;
  const leftKeep = newKeep.find((k) => Math.abs(k[1] - d[0]) < 1e-6);
  const rightKeep = newKeep.find((k) => Math.abs(k[0] - d[1]) < 1e-6);
  if (leftKeep) leftKeep[1] = val;
  if (rightKeep) rightKeep[0] = val;
  return newKeep;
};

// 判断两段保留区间数组是否逐段相等（用于识别用户是否手动精修过时间轴）。
// 若手动改过，analyze 时计算的 keepSegmentsOut（输出时间轴）与当前 keepSegments 索引已不对齐，
// 此时不应下发 keepSegmentsOut，避免 Rust 按错误的输出偏移拼接。
const segsEqual = (a?: [number, number][], b?: [number, number][]): boolean => {
  if (!a || !b || a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x[0] - y[0]);
  const sb = [...b].sort((x, y) => x[0] - y[0]);
  return sa.every((s, i) => Math.abs(s[0] - sb[i][0]) < 1e-4 && Math.abs(s[1] - sb[i][1]) < 1e-4);
};

// 删除某个删除区间（把该区间并入保留：相邻保留段合并 / 延长到首尾）
const deleteDeletion = (
  keep: [number, number][],
  duration: number,
  delIndex: number,
): [number, number][] => {
  const sorted = [...keep].sort((a, b) => a[0] - b[0]);
  const dels = removedSpans(sorted, duration);
  const d = dels[delIndex];
  if (!d) return keep;
  // 先在 newKeep（全新副本）里查找并就地合并，再过滤；不可在 sorted(原始引用)上查，否则
  // 既会误改 store 原数组，又因副本≠原引用导致 filter 永不命中 → 返回与输入相同的值（按钮无反应）
  const newKeep = sorted.map((s) => [s[0], s[1]] as [number, number]);
  const leftKeep = newKeep.find((k) => Math.abs(k[1] - d[0]) < 1e-6);
  const rightKeep = newKeep.find((k) => Math.abs(k[0] - d[1]) < 1e-6);
  if (leftKeep && rightKeep) {
    leftKeep[1] = rightKeep[1];
    return newKeep.filter((k) => k !== rightKeep);
  }
  if (leftKeep && !rightKeep) { leftKeep[1] = duration; return newKeep; }
  if (!leftKeep && rightKeep) { rightKeep[0] = 0; return newKeep; }
  return newKeep;
};

// 新增一个删除区间 [start,end]：从保留段中切掉该区间（重叠的保留段拆分/裁剪）。
// 新增的删除段会出现在「片段审核」列表，并拥有与 AI 原始删除段完全相同的操作权限（微调/捕获/改为保留）。
const addDeletion = (
  keep: [number, number][],
  duration: number,
  start: number,
  end: number,
): [number, number][] => {
  const s = Math.max(0, Math.min(duration, Math.min(start, end)));
  const e = Math.max(0, Math.min(duration, Math.max(start, end)));
  if (e - s < 1e-4) return keep; // 区间过短忽略
  const sorted = [...keep].sort((a, b) => a[0] - b[0]).map((k) => [k[0], k[1]] as [number, number]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    if (b <= s || a >= e) { out.push([a, b]); continue; } // 不重叠，原样保留
    if (a < s) out.push([a, s]); // 左段保留
    if (b > e) out.push([e, b]); // 右段保留（中间重叠部分被删除）
  }
  return out;
};

export default function SpeechPanel() {
  // ── 选中素材（镜像 AIPanel 逻辑）──
  const assets = useProjectStore((s) => s.project.assets);
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  const setSpeechOverlay = useUIStore((s) => s.setSpeechOverlay);
  const clearSpeechOverlay = useUIStore((s) => s.clearSpeechOverlay);
  const speechOverlay = useUIStore((s) => s.speechOverlay);
  const selectedAsset = (() => {
    if (!selectedClipId) return null;
    const clip = useProjectStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === selectedClipId);
    const sa = clip ? assets.find((a) => a.id === clip.assetId) : null;
    return sa && (sa.type === 'audio' || sa.type === 'video') ? sa : null;
  })();

  // ── 偏好记忆（useConfigStore 持久化）──
  const speechPrefs = useConfigStore((s) => s.config?.speech);
  // 组件内持久化 helper（非 hook）：把当前选项补丁写回 config.speech
  const persistSpeech = (patch: Record<string, unknown>) => {
    const cur = useConfigStore.getState().config?.speech ?? {};
    useConfigStore.getState().updateConfig({ speech: { ...cur, ...patch } });
  };
  // 统一 set 某个选项并持久化（避免逐个 onChange 重复写）
  const setOpt = <K extends keyof typeof PRESETS.standard>(
    setter: (v: (typeof PRESETS.standard)[K]) => void,
    key: K,
    v: (typeof PRESETS.standard)[K],
  ) => {
    setter(v);
    persistSpeech({ [key]: v } as Record<string, unknown>);
  };
  // 当前高亮预设：本地点击态优先，否则读回持久化的 preset
  const storedPreset = speechPrefs ? (speechPrefs as Record<string, unknown>).preset : undefined;
  const [presetActive, setPresetActive] = useState<PresetKey | null>(null);
  const activePreset = presetActive ?? (storedPreset as PresetKey | undefined) ?? null;

  // ── 选项（本地状态；默认值取偏好记忆，回退到标准预设）──
  const [modelSize, setModelSize] = useState<SpeechEditOptions['modelSize']>(speechPrefs?.modelSize ?? PRESETS.standard.modelSize);
  const [useDemucs, setUseDemucs] = useState(speechPrefs?.useDemucs ?? PRESETS.standard.useDemucs);      // 声源分离（默认关：口播清洗直接用原素材音频，避免 Demucs 误分配导致静音；需保留背景音乐时手动开启）
  const [vadThreshold, setVadThreshold] = useState(speechPrefs?.vadThreshold ?? PRESETS.standard.vadThreshold);  // VAD 灵敏度
  const [minGap, setMinGap] = useState(speechPrefs?.minGap ?? PRESETS.standard.minGap);             // 最小停顿
  const [wordPad, setWordPad] = useState(speechPrefs?.wordPad ?? PRESETS.standard.wordPad);           // 词边界 padding
  const [denoise, setDenoise] = useState(speechPrefs?.denoise ?? PRESETS.standard.denoise);             // AI 降噪
  const [denoiseQuality, setDenoiseQuality] = useState<'standard' | 'high'>(speechPrefs?.denoiseQuality ?? PRESETS.standard.denoiseQuality);
  const [stutterDetect, setStutterDetect] = useState(speechPrefs?.stutterDetect ?? PRESETS.standard.stutterDetect); // 结巴/卡顿检测
  const [stutterThreshold, setStutterThreshold] = useState(speechPrefs?.stutterThreshold ?? PRESETS.standard.stutterThreshold); // 结巴阈值
  const [fillers, setFillers] = useState(speechPrefs?.fillers ?? PRESETS.standard.fillers);           // 删语气词
  const [deess, setDeess] = useState(speechPrefs?.deess ?? PRESETS.standard.deess);              // 去齿音
  const [normalize, setNormalize] = useState(speechPrefs?.normalize ?? PRESETS.standard.normalize);      // 响度归一
  const [keepNonspeech, setKeepNonspeech] = useState(speechPrefs?.keepNonspeech ?? PRESETS.standard.keepNonspeech); // 保留背景音乐/环境音
  const [trimSilence, setTrimSilence] = useState(speechPrefs?.trimSilence ?? PRESETS.standard.trimSilence);      // 修剪首尾静音
  const [sedEvents, setSedEvents] = useState(speechPrefs?.sedEvents ?? PRESETS.standard.sedEvents);          // 副语言/非语音事件检测(PANNs SED)
  const [respiroBreath, setRespiroBreath] = useState(speechPrefs?.respiroBreath ?? PRESETS.standard.respiroBreath);  // 呼吸专项检测(Respiro)
  const [sedThreshold, setSedThreshold] = useState(speechPrefs?.sedThreshold ?? PRESETS.standard.sedThreshold);     // 副语言事件阈值 0~1
  const [maskSoften, setMaskSoften] = useState(speechPrefs?.maskSoften ?? PRESETS.standard.maskSoften);             // DFN3 mask 软化开关
  const [maskSoftenFloor, setMaskSoftenFloor] = useState(speechPrefs?.maskSoftenFloor ?? PRESETS.standard.maskSoftenFloor); // 软化增益阈值（听感微调）
  const [isolateGapSec, setIsolateGapSec] = useState(speechPrefs?.isolateGapSec ?? PRESETS.standard.isolateGapSec);     // 孤立间隙阈值(秒)：洞两侧距最近语音均≥此值才判「语音孤岛」可删

  // ── assemble 选项 ──
  const [declick, setDeclick] = useState(speechPrefs?.declick ?? PRESETS.standard.declick);          // 去咔哒声(爆音)
  const [crossfadeMs, setCrossfadeMs] = useState(speechPrefs?.crossfadeMs ?? PRESETS.standard.crossfadeMs);    // 接缝平滑(ms)

  // 用当前面板选项生成 analyze 用的 opts（修复原 denoise 硬编码 false 的 bug）
  const buildOpts = (): SpeechEditOptions => ({
    modelSize,
    useDemucs,
    vadThreshold,
    minGap,
    wordPad,
    denoise,
    denoiseQuality,
    deess,
    normalize,
    fillers,
    keepNonspeech,
    trimSilence,
    sedEvents,
    sedThreshold,
    respiroBreath,
    stutterDetect,
    stutterThreshold,
    maskSoften,
    maskSoftenFloor,
    isolateGapSec,
  });

  // 应用预设：一次性 set 所有状态并持久化
  const applyPreset = (key: PresetKey) => {
    const p = PRESETS[key];
    setModelSize(p.modelSize);
    setUseDemucs(p.useDemucs);
    setVadThreshold(p.vadThreshold);
    setMinGap(p.minGap);
    setWordPad(p.wordPad);
    setDenoise(p.denoise);
    setDenoiseQuality(p.denoiseQuality);
    setStutterDetect(p.stutterDetect);
    setStutterThreshold(p.stutterThreshold);
    setDeess(p.deess);
    setNormalize(p.normalize);
    setFillers(p.fillers);
    setKeepNonspeech(p.keepNonspeech);
    setTrimSilence(p.trimSilence);
    setSedEvents(p.sedEvents);
    setSedThreshold(p.sedThreshold);
    setRespiroBreath(p.respiroBreath);
    setMaskSoften(p.maskSoften);
    setMaskSoftenFloor(p.maskSoftenFloor);
    setIsolateGapSec(p.isolateGapSec);
    setCrossfadeMs(p.crossfadeMs);
    setDeclick(p.declick);
    persistSpeech({ ...p, preset: key });
    setPresetActive(key);
  };

  // ── 结果 / 状态 ──
  const [result, setResult] = useState<SpeechEditResult | null>(null);
  // 实时片段：用户在时间轴拖动精修后的值优先（speechOverlay），否则回退到分析原始值
  const liveKeepSegments = speechOverlay?.keepSegments ?? result?.keepSegments ?? [];
  // 暂停压缩输出时间轴（keepSegmentsOut）：仅当用户未手动精修时间轴时下发——
  // 手动改过会让 keepSegments 与 analyze 时计算的 keepSegmentsOut 索引错位，此时回退到「间隙全删」。
  const editedTimeline = !segsEqual(speechOverlay?.keepSegments, result?.keepSegments);
  const liveKeepSegmentsOut = (!editedTimeline && result?.keepSegmentsOut && result.keepSegmentsOut.length === liveKeepSegments.length)
    ? result.keepSegmentsOut
    : undefined;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // ── 时间轴全量批量处理 ──
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchItems, setBatchItems] = useState<{ name: string; status: 'pending' | 'ok' | 'fail'; msg: string }[]>([]);

  // ── 删除明细编辑 / 试听 / 撤销 ──
  const currentTime = useUIStore((s) => s.currentTime);
  const commitSpeechSegments = useUIStore((s) => s.commitSpeechSegments);
  const undoSpeechSegments = useUIStore((s) => s.undoSpeechSegments);
  const speechUndoStack = useUIStore((s) => s.speechUndoStack);
  const tracks = useProjectStore((s) => s.project.tracks);

  const removed = useMemo(
    () => (result ? removedSpans(liveKeepSegments, result.duration) : []),
    [result, liveKeepSegments],
  );
  // 保留段（按时间排序，供审核列表与 keep→delete 转换用）
  const keepSorted = useMemo(
    () => (result ? [...liveKeepSegments].sort((a, b) => a[0] - b[0]) : []),
    [result, liveKeepSegments],
  );
  // 统一审核列表：保留段 + 删除段按时间合并，每段带原始下标
  const segs = useMemo(() => {
    const list: { type: 'keep' | 'del'; range: [number, number]; keepIdx?: number; delIdx?: number }[] = [];
    keepSorted.forEach((k, ki) => list.push({ type: 'keep', range: k, keepIdx: ki }));
    removed.forEach((d, di) => list.push({ type: 'del', range: d, delIdx: di }));
    list.sort((a, b) => a.range[0] - b.range[0]);
    return list;
  }, [keepSorted, removed]);
  const [draft, setDraft] = useState<[number, number][]>(removed);
  useEffect(() => { setDraft(removed); }, [JSON.stringify(removed)]);
  // 新增删除片段的临时输入（起/止 + 捕获自逐帧播放头）
  const [newDelStart, setNewDelStart] = useState<number>(0);
  const [newDelEnd, setNewDelEnd] = useState<number>(0);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  // 试听片段在时间轴上的落位（新音频轨）：{clipId, trackId}；null=尚未生成过
  const previewClipRef = useRef<{ clipId: string; trackId: string } | null>(null);
  // 本次分析锁定的素材：试听/生成/落轨以它为准，与时间轴选中态解耦
  // （用户取消时间轴选中/点了别处后，试听仍应工作——此前 selectedAsset 变 null 导致静默无操作）
  const [analyzedAsset, setAnalyzedAsset] = useState<{ id: string; type: 'video' | 'audio'; path: string; duration?: number; fps?: number } | null>(null);
  // 有效操作素材：分析锁定优先，回退到当前选中素材
  const effectiveAsset = analyzedAsset
    ?? (selectedAsset as { id: string; type: 'video' | 'audio'; path: string; duration: number; fps?: number } | null);
  // 是否已生成过试听：此后每次手动调整 keepSegments 自动重渲试听（用户要求②）
  const previewAutoRef = useRef(false);

  // 把预览播放头(时间轴时间)映射回选中素材的源时间（供「捕获」按钮取逐帧时间）
  const captureSourceTime = (): number => {
    if (!selectedAsset || !result) return currentTime;
    const clip = tracks.flatMap((t) => t.clips).find((c) => c.assetId === selectedAsset.id);
    let t = currentTime;
    if (clip) t = currentTime - clip.timelineIn + clip.src_range.start;
    return Math.max(0, Math.min(result.duration, t));
  };
  const updateDraft = (i: number, which: 'start' | 'end', val: number) =>
    setDraft((prev) => prev.map((r, idx) => (idx === i ? (which === 'start' ? [val, r[1]] : [r[0], val]) : r)));
  const commitDraft = (i: number) => {
    if (!result) return;
    const dr = draft[i];
    if (!dr || !isFinite(dr[0]) || !isFinite(dr[1])) return;
    const newKeep = patchDeletion(liveKeepSegments, result.duration, i, { start: dr[0], end: dr[1] });
    commitSpeechSegments(newKeep);
  };
  const captureTo = (i: number, which: 'start' | 'end') => {
    if (!result) return;
    const t = captureSourceTime();
    setDraft((prev) => prev.map((r, idx) => (idx === i ? (which === 'start' ? [t, r[1]] : [r[0], t]) : r)));
    const newKeep = patchDeletion(liveKeepSegments, result.duration, i, which === 'start' ? { start: t } : { end: t });
    commitSpeechSegments(newKeep);
  };
  // 删除段 → 改为保留（AI 误删时纠正：把该删除区间并入保留）
  const handleConvertDeleteToKeep = (delIdx: number) => {
    if (!result) return;
    const newKeep = deleteDeletion(liveKeepSegments, result.duration, delIdx);
    commitSpeechSegments(newKeep);
  };
  // 新增一个删除片段：从保留段中切掉 [start,end] 区间（重叠保留段拆分/裁剪）。
  // 新增的删除段会出现在「片段审核」列表里，并拥有与 AI 原始删除段完全相同的操作权限（微调/捕获/改为保留）。
  const handleAddDeletion = () => {
    if (!result) return;
    const s = Math.min(newDelStart, newDelEnd);
    const e = Math.max(newDelStart, newDelEnd);
    if (!(e - s > 1e-4)) { setMsg('新增删除片段需起止不同且区间有效'); return; }
    const newKeep = addDeletion(liveKeepSegments, result.duration, s, e);
    if (newKeep.length === 0) { setMsg('不能把全部内容都改为删除，至少保留一段'); return; }
    commitSpeechSegments(newKeep);
    setMsg(`已新增删除片段 ${s.toFixed(3)}s – ${e.toFixed(3)}s（可继续添加下一段）`);
    // 关键：添加后清空输入框，避免再次点击时复用已被删除的同一区间导致「没反应」
    setNewDelStart(0);
    setNewDelEnd(0);
  };
  const captureNewStart = () => setNewDelStart(captureSourceTime());
  const captureNewEnd = () => setNewDelEnd(captureSourceTime());

  // ── 试听片段落轨：在「新音频轨」上创建/替换清洗试听片段 ──
  // 位置对齐源素材片段的 timelineIn → 播放头移动时，源轨与试听轨同步发声，
  // 便于对照判断删除位置与 AI 分析结果（用户要求①）。
  // 已存在试听片段时只替换其资产/时长（同 clipId）→ 不产生重复堆积（用户要求③的基础）。

  // 落轨逻辑在 utils/speechPreviewTrack.ts（可测模块）；此处仅注入依赖
  const upsertPreviewOnTrack = async (assetPath: string, dur: number, isFinal = false) => {
    if (!effectiveAsset) { setMsg('试听/生成失败：请先在时间轴选中要清洗的素材片段，再重新点「分析」'); return { ok: false }; }
    return upsertPreviewTrack({
      getStore: useProjectStore.getState,
      selectedAsset: effectiveAsset,
      extractAudio: (s, d) => window.aicut.media.extractAudio(s, d),
      previewRef: previewClipRef,
      onMessage: (m) => setMsg(m),
    }, assetPath, dur, isFinal);
  };

  const handlePreview = async () => {
    if (!effectiveAsset || !result) {
      setMsg(!result ? '请先点「分析」完成分析，再试听' : '未找到要清洗的素材，请重新分析');
      return;
    }
    setPreviewBusy(true); setMsg(null);
    try {
      const outputPath = effectiveAsset.path.replace(/\.[^.]+$/, '_preview.mp4');
      const asmOpts: SpeechAssembleOptions = {
        keepSegments: liveKeepSegments,
        keepSegmentsOut: liveKeepSegmentsOut,
        outputPath,
        crossfadeMs,
        declick,
        deess,
        normalize,
        videoSync: true, // Mode Ⅱ：视频按与音频相同源区间同步切（默认；item ④ 实现）
        enhancedAudioPath: result.enhancedAudioPath,
        ...('separated' in result && result.separated
          ? { separated: true, vocalPath: result.vocalPath, accompPath: result.accompPath, musicSegments: result.musicSegments }
          : {}),
      };
      const res = await window.aicut.speech.assemble(effectiveAsset.path, JSON.stringify(asmOpts));
      if (res.success && res.data) {
        // 修复「试听缓存」：预览输出文件名固定为 *_preview.mp4，第二次点击时
        // setPreviewUrl 设置的是完全相同的字符串 → 浏览器不重载、继续播首次
        // 解码的旧缓冲。这里改用 aicut-asset:// URL 并附加时间戳查询串（协议
        // 处理器按 pathname 解析、忽略查询串 → 命中同一文件但视为不同资源），
        // 同时用 previewNonce 作 <audio> 的 key 强制整元素重挂载，双重保险。
        const raw = String(res.data.outputPath).replace(/\\/g, '/');
        const assetUrl = /^(https?|aicut-asset|blob):/.test(raw)
          ? raw
          : `aicut-asset:///${raw}?v=${Date.now()}`;
        setPreviewUrl(assetUrl);
        setPreviewNonce((n) => n + 1);
        // 用户要求①：试听片段同步落到时间轴新音频轨（与源素材对齐）
        previewAutoRef.current = true; // 此后手动调整自动重渲试听
        const up = await upsertPreviewOnTrack(String(res.data.outputPath), Number(res.data.duration) || 0);
        if (!up.ok) setMsg(`试听片段落轨失败：${up.error || '未知原因'}（内嵌播放器仍可试听）`);
        else if (up.trackId) {
          const idx = useProjectStore.getState().project.tracks.findIndex((t) => t.id === up.trackId);
          document.querySelector(`[data-track-id="${up.trackId}"]`)?.scrollIntoView({ block: 'center' });
          setMsg(`试听片段已放到时间轴第 ${idx + 1} 条轨（源素材轨下方，源轨已自动静音以便对照）`);
        }
      } else setMsg(res.error || '试听生成失败');
    } catch (e) {
      setMsg(`试听异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreviewBusy(false);
    }
  };

  // 用户要求②：生成过一次试听后，手动调整 keepSegments 自动重渲试听片段
  // （700ms 防抖；编辑瞬间先失效内嵌旧试听，杜绝「改了但听到的还是旧结果」）
  useEffect(() => {
    if (!previewAutoRef.current) return;
    setPreviewUrl(null);
    const t = setTimeout(() => { if (!previewBusy) void handlePreview(); }, 700);
    return () => clearTimeout(t);
  }, [JSON.stringify(liveKeepSegments)]);

  const numInput: React.CSSProperties = { width: 74, background: '#0b1a2e', color: C.textMain, border: `1px solid ${C.border}`, borderRadius: 3, padding: '2px 4px', fontSize: 11 };
  const miniBtn: React.CSSProperties = { fontSize: 11, padding: '2px 6px', background: C.control, color: C.textMain, border: `1px solid ${C.border}`, borderRadius: 3, cursor: 'pointer' };

  // ── 分析 ──
  const handleAnalyze = async () => {
    if (!selectedAsset) return;
    setLoading(true);
    setError(null);
    setMsg(null);
    try {
      // 一键补全：高精度强制对齐权重 Qwen3-ForcedAligner（1.8G, >500M）随用随下；其余口播权重已随包。
      if (!(await useAssetStore.getState().ensureAssets(QWEN3FA_IDS))) {
        setLoading(false);
        return;
      }
      const opts = buildOpts();
      const res = await window.aicut.speech.analyze(selectedAsset.path, JSON.stringify(opts));
      if (res.success && res.data) {
        setResult(res.data);
        setError(null);
        setAnalyzedAsset({ id: selectedAsset.id, type: selectedAsset.type as 'video' | 'audio', path: selectedAsset.path, duration: selectedAsset.duration, fps: selectedAsset.fps ?? undefined });   // 锁定本次分析的素材：后续试听/生成不再依赖时间轴选中态
        setSpeechOverlay({
          assetPath: selectedAsset.path,
          keepSegments: res.data.keepSegments,
          duration: res.data.duration,
        });
      } else {
        setResult(null);
        setError(res.error || '分析失败');
      }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // ── 生成清洗片段并落轨（镜像 MediaPanel.handleAddToTimeline）──
  const handleAssemble = async () => {
    if (!effectiveAsset || !result) {
      setMsg(!result ? '请先点「分析」完成分析，再生成' : '未找到要清洗的素材，请重新分析');
      return;
    }
    setError(null);
    setMsg(null);
    try {
      const original = effectiveAsset;
      const outputPath = original.path.replace(/\.[^.]+$/, '_speechcut.mp4'); // 写到源文件旁边
      const asmOpts: SpeechAssembleOptions = {
        keepSegments: liveKeepSegments,
        keepSegmentsOut: liveKeepSegmentsOut,
        outputPath,
        crossfadeMs,
        declick,
        deess,
        normalize,
        videoSync: true, // Mode Ⅱ：视频按与音频相同源区间同步切（默认；item ④ 实现）
        enhancedAudioPath: result.enhancedAudioPath,
        ...('separated' in result && result.separated
          ? { separated: true, vocalPath: result.vocalPath, accompPath: result.accompPath, musicSegments: result.musicSegments }
          : {}),
      };
      const res2 = await window.aicut.speech.assemble(original.path, JSON.stringify(asmOpts));
      if (res2.success && res2.data) {
        const finalDur = Number(res2.data.duration) || 0;
        // 统一落位：无论是否生成过试听，最终清洗片段都在「独立新轨」上——
        // 已有试听片段则【替换】它（同 clipId、位置不变）；没有则在该轨新建。
        // 原始素材所在轨道永远不动，源片段保留供对比（用户硬性要求）。
        const up2 = await upsertPreviewOnTrack(String(res2.data.outputPath), finalDur, true);
        if (!up2.ok) { setError(`落轨失败：${up2.error || '未知原因'}`); return; }
        if (up2.trackId) {
          const idx = useProjectStore.getState().project.tracks.findIndex((t) => t.id === up2.trackId);
          document.querySelector(`[data-track-id="${up2.trackId}"]`)?.scrollIntoView({ block: 'center' });
        }
        setMsg('已生成最终清洗片段（独立轨，覆盖试听片段；原始素材保留，可对比）。建议标记仍保留，可继续微调后再次生成。');
      } else {
        setError(res2.error || '生成失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── 时间轴全量批量：串行对每段音/视频素材做 analyze → assemble 并落轨 ──
  const handleBatch = async () => {
    if (batchRunning) return;
    const allClips = useProjectStore.getState().project.tracks.flatMap((t) => t.clips);
    const seen = new Set<string>();
    const targets: typeof assets = [];
    for (const c of allClips) {
      const a = assets.find((x) => x.id === c.assetId);
      if (!a) continue;
      if (a.type !== 'audio' && a.type !== 'video') continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      targets.push(a);
    }
    if (targets.length === 0) {
      setMsg('时间轴没有可批量处理的视频/音频素材');
      return;
    }
    setBatchRunning(true);
    if (!(await useAssetStore.getState().ensureAssets(QWEN3FA_IDS))) {
      setBatchRunning(false);
      setMsg('已取消：缺少口播高精度对齐权重（Qwen3-ForcedAligner），请在「AI组件」中补全后重试');
      return;
    }
    setBatchTotal(targets.length);
    setBatchItems(
      targets.map((a) => ({ name: (a.path.split(/[\\/]/).pop() || a.path), status: 'pending' as const, msg: '' })),
    );
    setMsg(null);
    try {
      for (let idx = 0; idx < targets.length; idx++) {
      const a = targets[idx];
      try {
        const opts = buildOpts();
        const res = await window.aicut.speech.analyze(a.path, JSON.stringify(opts));
        if (!res.success || !res.data) throw new Error(res.error || '分析失败');
        const outputPath = a.path.replace(/\.[^.]+$/, '_speechcut.mp4'); // 写到源文件旁边
        const asmOpts: SpeechAssembleOptions = {
          keepSegments: res.data.keepSegments,
          keepSegmentsOut: res.data.keepSegmentsOut,
          outputPath,
          crossfadeMs,
          declick,
          deess,
          normalize,
          videoSync: true,
          enhancedAudioPath: res.data.enhancedAudioPath,
          ...('separated' in res.data && res.data.separated
            ? { separated: true, vocalPath: res.data.vocalPath, accompPath: res.data.accompPath, musicSegments: res.data.musicSegments }
            : {}),
        };
        const res2 = await window.aicut.speech.assemble(a.path, JSON.stringify(asmOpts));
        if (!res2.success || !res2.data) throw new Error(res2.error || '生成失败');
        // 硬约束统一：批量产物同样落「独立新轨」（绝不落在源素材所在轨道），
        // 并自动静音源轨进入对照模式；每段素材各自一条新轨，互不覆盖。
        await upsertPreviewOnTrack(String(res2.data.outputPath), Number(res2.data.duration) || 0, true);
        // 批量场景下每段素材需要独立轨道：重置引用，让下一段强制新建
        previewClipRef.current = null;
        setBatchItems((prev) => prev.map((it, i) => (i === idx ? { ...it, status: 'ok', msg: '已生成' } : it)));
      } catch (e) {
        setBatchItems((prev) => prev.map((it, i) => (i === idx ? { ...it, status: 'fail', msg: e instanceof Error ? e.message : String(e) } : it)));
      }
    }
    } finally {
      setBatchRunning(false);
    }
    setMsg(`批量处理完成：共 ${targets.length} 段素材（见下方明细）。`);
  };

  return (
    <div style={{ padding: 12, color: C.textMain, fontSize: 13, height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>口播剪辑（自动去口癖/静音）</h3>

      {!selectedAsset ? (
        <div style={{
          padding: 12, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6,
          color: C.textSub, fontSize: 12, lineHeight: 1.6,
        }}>
          请在时间轴选中一段视频或音频片段，然后点「分析」。
        </div>
      ) : (
        <>
          {/* 当前选中素材 */}
          <div style={{ fontSize: 11, color: C.textSub, marginBottom: 8 }}>
            当前素材：<span style={{ color: C.textMain }}>{selectedAsset.path}</span>
          </div>

          {/* 选项区 */}
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, marginBottom: 10 }}>
            {/* 三预设：轻量 / 标准 / 激进（当前预设高亮） */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {(['light', 'standard', 'aggressive'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => applyPreset(k)}
                  style={{
                    flex: 1, padding: '5px 0', fontSize: 12, cursor: 'pointer',
                    background: activePreset === k ? C.accent : C.control,
                    color: activePreset === k ? '#fff' : C.textMain,
                    border: `1px solid ${C.border}`, borderRadius: 4,
                  }}
                >
                  {k === 'light' ? '轻量' : k === 'standard' ? '标准' : '激进'}
                </button>
              ))}
            </div>

            {/* 模型尺寸 */}
            <label style={{ display: 'block', marginBottom: 4, opacity: 0.85 }}>识别模型</label>
            <select
              value={modelSize}
              onChange={(e) => setOpt(setModelSize, 'modelSize', e.target.value as SpeechEditOptions['modelSize'])}
              style={{ width: '100%', marginBottom: 10, padding: 4, background: C.control, color: C.textMain, border: 'none', borderRadius: 4 }}
            >
              <option value="tiny">tiny（最快）</option>
              <option value="base">base</option>
              <option value="small">small</option>
              <option value="medium">medium</option>
              <option value="large">large（最准）</option>
            </select>

            {/* 复选框 */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={useDemucs} onChange={(e) => setOpt(setUseDemucs, 'useDemucs', e.target.checked)} />
              声源分离降噪
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={denoise} onChange={(e) => setOpt(setDenoise, 'denoise', e.target.checked)} />
              AI 降噪
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              降噪质量
              <select value={denoiseQuality} onChange={(e) => setOpt(setDenoiseQuality, 'denoiseQuality', e.target.value as 'standard' | 'high')} style={{ background: C.control, color: C.textMain, border: 'none', borderRadius: 4, padding: '2px 4px' }}>
                <option value="standard">标准</option>
                <option value="high">高</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={maskSoften} onChange={(e) => setOpt(setMaskSoften, 'maskSoften', e.target.checked)} />
              DFN3 高 SNR 软化（保留干净语音）
            </label>
            <SliderRow label="软化阈值" value={maskSoftenFloor} min={0.3} max={0.9} step={0.05}
              onChange={(v) => setOpt(setMaskSoftenFloor, 'maskSoftenFloor', v)} display={maskSoftenFloor.toFixed(2)} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={stutterDetect} onChange={(e) => setOpt(setStutterDetect, 'stutterDetect', e.target.checked)} />
              结巴/卡顿检测
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={fillers} onChange={(e) => setOpt(setFillers, 'fillers', e.target.checked)} />
              删语气词（嗯/啊/那个…）
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={deess} onChange={(e) => setOpt(setDeess, 'deess', e.target.checked)} />
              去齿音
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={normalize} onChange={(e) => setOpt(setNormalize, 'normalize', e.target.checked)} />
              响度归一
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={keepNonspeech} onChange={(e) => setOpt(setKeepNonspeech, 'keepNonspeech', e.target.checked)} />
              保留背景音乐/环境音
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={trimSilence} onChange={(e) => setOpt(setTrimSilence, 'trimSilence', e.target.checked)} />
              修剪首尾静音
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={sedEvents} onChange={(e) => setOpt(setSedEvents, 'sedEvents', e.target.checked)} />
              副语言事件检测（笑声/叹息/咳嗽/呼吸…）
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={respiroBreath} onChange={(e) => setOpt(setRespiroBreath, 'respiroBreath', e.target.checked)} />
              呼吸专项检测（温和去气声）
            </label>

            {/* 滑块：VAD 灵敏度 */}
            <SliderRow label="VAD 灵敏度" value={vadThreshold} min={0.05} max={0.6} step={0.05}
              onChange={(v) => setOpt(setVadThreshold, 'vadThreshold', v)} display={vadThreshold.toFixed(2)} />
            {/* 滑块：最小停顿 */}
            <SliderRow label="最小停顿(s)" value={minGap} min={0.05} max={0.6} step={0.01}
              onChange={(v) => setOpt(setMinGap, 'minGap', v)} display={minGap.toFixed(2)} />
            {/* 滑块：词边界 padding */}
            <SliderRow label="词边界(s)" value={wordPad} min={0} max={0.2} step={0.01}
              onChange={(v) => setOpt(setWordPad, 'wordPad', v)} display={wordPad.toFixed(2)} />
            {/* 滑块：副语言事件阈值 */}
            <SliderRow label="副语言阈值" value={sedThreshold} min={0.1} max={0.9} step={0.05}
              onChange={(v) => setOpt(setSedThreshold, 'sedThreshold', v)} display={sedThreshold.toFixed(2)} />
            {/* 滑块：结巴阈值 */}
            <SliderRow label="结巴阈值" value={stutterThreshold} min={0.1} max={0.9} step={0.05}
              onChange={(v) => setOpt(setStutterThreshold, 'stutterThreshold', v)} display={stutterThreshold.toFixed(2)} />
            {/* 滑块：孤立间隙阈值（删/不删判据：洞两侧距最近语音均 ≥ 此值才判「语音孤岛」可删；越大越保守） */}
            <SliderRow label="孤立间隙(s)·越大越保守" value={isolateGapSec} min={0.1} max={0.6} step={0.05}
              onChange={(v) => setOpt(setIsolateGapSec, 'isolateGapSec', v)} display={isolateGapSec.toFixed(2)} />

            {/* 滑块：接缝平滑（assemble 用 crossfadeMs） */}
            <SliderRow label="接缝平滑(ms)" value={crossfadeMs} min={0} max={100} step={5}
              onChange={(v) => setOpt(setCrossfadeMs, 'crossfadeMs', v)} display={String(crossfadeMs)} />

            {/* 复选框：去咔哒声（assemble） */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={declick} onChange={(e) => setOpt(setDeclick, 'declick', e.target.checked)} />
              去咔哒声(爆音)
            </label>
          </div>

          {/* 分析 / 批量处理 按钮 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button
              onClick={handleAnalyze}
              disabled={loading || batchRunning}
              style={{
                flex: 1, padding: '8px 10px',
                background: loading ? '#555' : C.accent, color: '#fff',
                border: 'none', borderRadius: 4, cursor: (loading || batchRunning) ? 'default' : 'pointer', fontSize: 13,
              }}
            >
              {loading ? '分析中…（whisper 首次可能较慢）' : '分析'}
            </button>
            <button
              onClick={handleBatch}
              disabled={batchRunning}
              style={{
                flex: 1, padding: '8px 10px',
                background: batchRunning ? '#555' : C.control, color: C.textMain,
                border: `1px solid ${C.border}`, borderRadius: 4, cursor: batchRunning ? 'default' : 'pointer', fontSize: 13,
              }}
            >
              {batchRunning ? '批量处理中…' : '批量处理时间轴'}
            </button>
          </div>

          {/* 批量处理进度明细 */}
          {batchItems.length > 0 && (
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, marginBottom: 8, fontSize: 11 }}>
              <div style={{ color: C.textSub, marginBottom: 4 }}>批量处理进度：{batchItems.filter((i) => i.status === 'ok').length}/{batchTotal}</div>
              {batchItems.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: it.status === 'ok' ? C.keep : it.status === 'fail' ? '#ff6b6b' : C.textSub }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{it.name}</span>
                  <span>{it.status === 'ok' ? '✓' : it.status === 'fail' ? `✗ ${it.msg}` : '…'}</span>
                </div>
              ))}
            </div>
          )}

          {result && (
            <button
              onClick={clearSpeechOverlay}
              style={{
                width: '100%', padding: '8px 10px', marginBottom: 8,
                background: C.panel, color: C.textSub,
                border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              清除标记
            </button>
          )}

          {error && (
            <div style={{ color: '#ff6b6b', marginBottom: 8, fontSize: 12 }}>错误：{error}</div>
          )}

          {/* 结果预览 */}
          {result && (
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10 }}>
              {/* 统计 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: 12 }}>
                <span>原时长 <b>{result.duration.toFixed(2)}s</b></span>
                <span style={{ color: C.removed }}>删除 <b>{result.totalRemovedSec.toFixed(2)}s</b></span>
                <span style={{ color: C.keep }}>压缩 {(result.ratio * 100).toFixed(0)}%</span>
              </div>

              {/* 保留/删除 可视化：左图例 + 全时长时间轴 */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                {/* 左图例（按你要求放左侧） */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: C.textSub, justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, background: C.keep, borderRadius: 2, display: 'inline-block' }} />保留
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, background: C.removed, borderRadius: 2, display: 'inline-block' }} />删除
                  </span>
                </div>
                {/* 右侧：时间轴条 + 能量曲线（与条同比例对齐） */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* 时间轴条（红底=删除，绿块=保留） */}
                  <div style={{ position: 'relative', height: 32, borderRadius: 6, overflow: 'hidden', background: C.removed }}>
                    {liveKeepSegments.map(([s, e], i) => (
                      <div key={i} title={`保留 ${s.toFixed(2)}–${e.toFixed(2)}s`} style={{
                        position: 'absolute', top: 0, bottom: 0,
                        left: `${(s / result.duration) * 100}%`,
                        width: `${((e - s) / result.duration) * 100}%`,
                        background: C.keep, borderRadius: 3,
                      }} />
                    ))}
                    {/* 10% 刻度参考线 */}
                    {Array.from({ length: 9 }, (_, i) => (
                      <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(i + 1) * 10}%`, width: 1, background: 'rgba(0,0,0,0.28)' }} />
                    ))}
                  </div>
                  {/* 能量曲线叠加：归一化到最大值后映射高度，与上方条按 duration 同比例对齐 */}
                  {result.energyCurve && result.energyCurve.length > 1 && (() => {
                    const ec = result.energyCurve as number[];
                    const max = Math.max(...ec, 1e-6);
                    const pts = ec.map((v, i) => `${i},${100 - (v / max) * 100}`).join(' ');
                    return (
                      <svg
                        width="100%" height={30} viewBox={`0 0 ${ec.length} 100`}
                        preserveAspectRatio="none"
                        style={{ display: 'block', marginTop: 2 }}
                      >
                        <polyline points={pts} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      </svg>
                    );
                  })()}
                </div>
              </div>
              <div style={{ fontSize: 10, color: C.textSub, marginBottom: 8, lineHeight: 1.5 }}>
                上条为原始媒体的「保留(绿)/删除(红)」分布。审核时可：① 调整删除段起止（或「捕获」逐帧播放头时间）；② 把 AI 误删的段「改为保留」；③ 用下方「新增删除片段」手动增加一个删除区间（拥有与原始删除段完全相同的操作权限：微调/捕获/改为保留）。
              </div>

              {/* 片段审核：保留段(绿)+删除段(红) 按时间合并，可互转性质；删除段可微调范围 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: C.textSub }}>片段审核（共 {segs.length} 段，可改性质/范围）</span>
                <button
                  onClick={undoSpeechSegments}
                  disabled={speechUndoStack.length === 0}
                  style={{ fontSize: 11, padding: '2px 8px', background: speechUndoStack.length ? C.panel : '#333', color: speechUndoStack.length ? C.textMain : '#777', border: `1px solid ${C.border}`, borderRadius: 4, cursor: speechUndoStack.length ? 'pointer' : 'default' }}
                >
                  撤销{speechUndoStack.length > 0 ? `(${speechUndoStack.length})` : ''}
                </button>
              </div>
              <div style={{ maxHeight: 210, overflowY: 'auto', marginBottom: 10, fontSize: 11 }}>
                {segs.map((s, i) => {
                  const fps = selectedAsset?.fps ?? 30;
                  const fmt = (t: number) => `${t.toFixed(3)}s（帧${Math.round(t * fps)}）`;
                  const isKeep = s.type === 'keep';
                  const color = isKeep ? C.keep : C.removed;
                  const dv = !isKeep && s.delIdx !== undefined ? (draft[s.delIdx] ?? s.range) : s.range;
                  return (
                    <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ color: C.textMain, minWidth: 56 }}>{isKeep ? '保留段' : `删除段 ${(s.delIdx ?? 0) + 1}`}</span>
                        <span style={{ color: C.textSub, fontVariantNumeric: 'tabular-nums' }}>{fmt(s.range[0])} – {fmt(s.range[1])}（{(s.range[1] - s.range[0]).toFixed(3)}s）</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        {!isKeep && (
                          <>
                            <span style={{ color: C.textSub }}>起</span>
                            <input type="number" step={0.001} value={dv[0]} onChange={(e) => s.delIdx !== undefined && updateDraft(s.delIdx, 'start', parseFloat(e.target.value) || 0)} onBlur={() => s.delIdx !== undefined && commitDraft(s.delIdx)} style={numInput} />
                            <button onClick={() => s.delIdx !== undefined && captureTo(s.delIdx, 'start')} title="用预览播放头（已映射回源时间）设为起点" style={miniBtn}>捕获</button>
                            <span style={{ color: C.textSub }}>止</span>
                            <input type="number" step={0.001} value={dv[1]} onChange={(e) => s.delIdx !== undefined && updateDraft(s.delIdx, 'end', parseFloat(e.target.value) || 0)} onBlur={() => s.delIdx !== undefined && commitDraft(s.delIdx)} style={numInput} />
                            <button onClick={() => s.delIdx !== undefined && captureTo(s.delIdx, 'end')} title="用预览播放头设为终点" style={miniBtn}>捕获</button>
                            <button onClick={() => s.delIdx !== undefined && handleConvertDeleteToKeep(s.delIdx)} title="这段其实要保留：把删除段改回保留" style={{ ...miniBtn, color: C.keep }}>改为保留</button>
                          </>
                        )}
                        {isKeep && (
                          <span style={{ color: C.textSub, fontSize: 10 }}>（保留段可经下方新增删除片段来裁剪）</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 新增删除片段：手动增加一个删除区间，拥有与原始删除段相同权限 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 6, padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <span style={{ fontSize: 11, color: C.textSub, marginRight: 2 }}>新增删除片段：</span>
                <span style={{ color: C.textSub }}>起</span>
                <input type="number" step={0.001} value={newDelStart} onChange={(e) => setNewDelStart(parseFloat(e.target.value) || 0)} style={numInput} />
                <button onClick={captureNewStart} title="用预览播放头（映射回源时间）设为起点" style={miniBtn}>捕获</button>
                <span style={{ color: C.textSub }}>止</span>
                <input type="number" step={0.001} value={newDelEnd} onChange={(e) => setNewDelEnd(parseFloat(e.target.value) || 0)} style={numInput} />
                <button onClick={captureNewEnd} title="用预览播放头设为终点" style={miniBtn}>捕获</button>
                <button onClick={handleAddDeletion} style={{ ...miniBtn, color: '#ff8a8a' }}>添加删除段</button>
              </div>

              {/* 试听（生成临时清洗片段并内嵌播放） */}
              <button
                onClick={handlePreview}
                disabled={previewBusy}
                style={{
                  width: '100%', padding: '8px 10px', marginBottom: 8, background: C.control, color: C.textMain,
                  border: `1px solid ${C.border}`, borderRadius: 4, cursor: previewBusy ? 'default' : 'pointer', fontSize: 13,
                }}
              >
                {previewBusy ? '生成试听中…' : '试听清洗结果'}
              </button>
              {previewUrl && (
                <div style={{ marginBottom: 8 }}>
                  <audio key={previewNonce} controls src={previewUrl} style={{ width: '100%' }} />
                </div>
              )}

              {/* 生成清洗片段 */}
              <button
                onClick={handleAssemble}
                style={{
                  width: '100%', padding: '8px 10px', background: C.keep, color: '#06281f',
                  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >
                生成清洗片段
              </button>
            </div>
          )}

          {msg && (
            <div style={{ color: C.keep, marginTop: 8, fontSize: 12 }}>{msg}</div>
          )}
        </>
      )}
    </div>
  );
}

// 滑块行小组件
function SliderRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
        <span>{props.label}</span>
        <span style={{ color: C.textSub }}>{props.display}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  );
}
