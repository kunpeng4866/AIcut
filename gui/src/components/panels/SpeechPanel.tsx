// SpeechPanel —— 口播剪辑面板（speech auto-editing）
//
// 交互流程（镜像 AIPanel 的素材选择逻辑 + MediaPanel 的落轨逻辑）：
//   1) 从时间轴选中一个视频/音频片段
//   2) 调整编辑选项 → 点「分析」调用 window.aicut.speech.analyze
//   3) 展示压缩统计 + 保留/删除时间轴可视化
//   4) 点「生成清洗片段」调用 window.aicut.speech.assemble → 落轨（原片段保留）

import React, { useState, useEffect, useMemo } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { ClipConfig, SpeechEditOptions, SpeechEditResult, SpeechAssembleOptions } from '../../types';

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
  const leftKeep = sorted.find((k) => Math.abs(k[1] - d[0]) < 1e-6);
  const rightKeep = sorted.find((k) => Math.abs(k[0] - d[1]) < 1e-6);
  const newKeep = sorted.map((s) => [s[0], s[1]] as [number, number]);
  if (leftKeep && rightKeep) {
    leftKeep[1] = rightKeep[1];
    return newKeep.filter((k) => k !== rightKeep);
  }
  if (leftKeep && !rightKeep) { leftKeep[1] = duration; return newKeep; }
  if (!leftKeep && rightKeep) { rightKeep[0] = 0; return newKeep; }
  return newKeep;
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

  // ── 选项（本地状态，带默认值）──
  const [modelSize, setModelSize] = useState<SpeechEditOptions['modelSize']>('base');
  const [useDemucs, setUseDemucs] = useState(false);      // 声源分离（默认关：口播清洗直接用原素材音频，避免 Demucs 误分配导致静音；需保留背景音乐时手动开启）
  const [vadThreshold, setVadThreshold] = useState(0.25);  // VAD 灵敏度
  const [minGap, setMinGap] = useState(0.18);             // 最小停顿
  const [wordPad, setWordPad] = useState(0.04);           // 词边界 padding
  const [fillers, setFillers] = useState(true);           // 删语气词
  const [deess, setDeess] = useState(false);              // 去齿音
  const [normalize, setNormalize] = useState(false);      // 响度归一
  const [keepNonspeech, setKeepNonspeech] = useState(true); // 保留背景音乐/环境音
  const [trimSilence, setTrimSilence] = useState(true);      // 修剪首尾静音

  // ── assemble 选项 ──
  const [declick, setDeclick] = useState(true);          // 去咔哒声(爆音)
  const [crossfadeMs, setCrossfadeMs] = useState(20);    // 接缝平滑(ms)

  // ── 结果 / 状态 ──
  const [result, setResult] = useState<SpeechEditResult | null>(null);
  // 实时片段：用户在时间轴拖动精修后的值优先（speechOverlay），否则回退到分析原始值
  const liveKeepSegments = speechOverlay?.keepSegments ?? result?.keepSegments ?? [];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
  const [draft, setDraft] = useState<[number, number][]>(removed);
  useEffect(() => { setDraft(removed); }, [JSON.stringify(removed)]);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

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
  const handleDeleteSegment = (i: number) => {
    if (!result) return;
    const newKeep = deleteDeletion(liveKeepSegments, result.duration, i);
    commitSpeechSegments(newKeep);
  };
  const handlePreview = async () => {
    if (!selectedAsset || !result) return;
    setPreviewBusy(true); setMsg(null);
    try {
      const outputPath = selectedAsset.path.replace(/\.[^.]+$/, '_preview.mp4');
      const asmOpts: SpeechAssembleOptions = {
        keepSegments: liveKeepSegments,
        outputPath,
        crossfadeMs,
        declick,
        deess,
        normalize,
        ...('separated' in result && result.separated
          ? { separated: true, vocalPath: result.vocalPath, accompPath: result.accompPath, musicSegments: result.musicSegments }
          : {}),
      };
      const res = await window.aicut.speech.assemble(selectedAsset.path, JSON.stringify(asmOpts));
      if (res.success && res.data) setPreviewUrl(res.data.outputPath);
      else setMsg(res.error || '试听生成失败');
    } finally {
      setPreviewBusy(false);
    }
  };

  const numInput: React.CSSProperties = { width: 74, background: '#0b1a2e', color: C.textMain, border: `1px solid ${C.border}`, borderRadius: 3, padding: '2px 4px', fontSize: 11 };
  const miniBtn: React.CSSProperties = { fontSize: 11, padding: '2px 6px', background: C.control, color: C.textMain, border: `1px solid ${C.border}`, borderRadius: 3, cursor: 'pointer' };

  // ── 分析 ──
  const handleAnalyze = async () => {
    if (!selectedAsset) return;
    setLoading(true);
    setError(null);
    setMsg(null);
    try {
      const opts: SpeechEditOptions = {
        modelSize,
        useDemucs,
        vadThreshold,
        minGap,
        wordPad,
        denoise: false,
        deess,
        normalize,
        fillers,
        keepNonspeech,
        trimSilence,
      };
      const res = await window.aicut.speech.analyze(selectedAsset.path, JSON.stringify(opts));
      if (res.success && res.data) {
        setResult(res.data);
        setError(null);
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
    if (!selectedAsset || !result) return;
    setError(null);
    setMsg(null);
    try {
      const original = selectedAsset;
      const outputPath = original.path.replace(/\.[^.]+$/, '_speechcut.mp4'); // 写到源文件旁边
      const asmOpts: SpeechAssembleOptions = {
        keepSegments: liveKeepSegments,
        outputPath,
        crossfadeMs,
        declick,
        deess,
        normalize,
        ...('separated' in result && result.separated
          ? { separated: true, vocalPath: result.vocalPath, accompPath: result.accompPath, musicSegments: result.musicSegments }
          : {}),
      };
      const res2 = await window.aicut.speech.assemble(original.path, JSON.stringify(asmOpts));
      if (res2.success && res2.data) {
        clearSpeechOverlay();
        const asset = {
          id: uid('asset'),
          type: original.type, // 'video' | 'audio'
          path: res2.data.outputPath,
          duration: res2.data.duration,
          fps: original.fps,
        };
        useProjectStore.getState().addAsset(asset);
        const track = useProjectStore.getState().getMainVideoTrack();
        if (track) {
          const lastClip = track.clips[track.clips.length - 1];
          const start = lastClip ? lastClip.timelineOut : 0;
          const duration = res2.data.duration || asset.duration || 5;
          const clip: ClipConfig = {
            id: uid('clip'),
            assetId: asset.id,
            src_range: { start: 0, end: duration },
            timelineIn: start,
            timelineOut: start + duration,
            transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
            volume: 1,
            speed: 1,
            effects: [],
            masks: [],
            filters: [],
            keyframes: {},
          };
          useProjectStore.getState().addClip(track.id, clip);
        }
        setMsg('已生成清洗片段并加入时间轴（原片段保留，可对比）。');
      } else {
        setError(res2.error || '生成失败');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
            {/* 模型尺寸 */}
            <label style={{ display: 'block', marginBottom: 4, opacity: 0.85 }}>识别模型</label>
            <select
              value={modelSize}
              onChange={(e) => setModelSize(e.target.value as SpeechEditOptions['modelSize'])}
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
              <input type="checkbox" checked={useDemucs} onChange={(e) => setUseDemucs(e.target.checked)} />
              声源分离降噪
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={fillers} onChange={(e) => setFillers(e.target.checked)} />
              删语气词（嗯/啊/那个…）
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={deess} onChange={(e) => setDeess(e.target.checked)} />
              去齿音
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
              响度归一
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={keepNonspeech} onChange={(e) => setKeepNonspeech(e.target.checked)} />
              保留背景音乐/环境音
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={trimSilence} onChange={(e) => setTrimSilence(e.target.checked)} />
              修剪首尾静音
            </label>

            {/* 滑块：VAD 灵敏度 */}
            <SliderRow label="VAD 灵敏度" value={vadThreshold} min={0.05} max={0.6} step={0.05}
              onChange={setVadThreshold} display={vadThreshold.toFixed(2)} />
            {/* 滑块：最小停顿 */}
            <SliderRow label="最小停顿(s)" value={minGap} min={0.05} max={0.6} step={0.01}
              onChange={setMinGap} display={minGap.toFixed(2)} />
            {/* 滑块：词边界 padding */}
            <SliderRow label="词边界(s)" value={wordPad} min={0} max={0.2} step={0.01}
              onChange={setWordPad} display={wordPad.toFixed(2)} />

            {/* 滑块：接缝平滑（assemble 用 crossfadeMs） */}
            <SliderRow label="接缝平滑(ms)" value={crossfadeMs} min={0} max={100} step={5}
              onChange={setCrossfadeMs} display={String(crossfadeMs)} />

            {/* 复选框：去咔哒声（assemble） */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={declick} onChange={(e) => setDeclick(e.target.checked)} />
              去咔哒声(爆音)
            </label>
          </div>

          {/* 分析按钮 */}
          <button
            onClick={handleAnalyze}
            disabled={loading}
            style={{
              width: '100%', padding: '8px 10px', marginBottom: 8,
              background: loading ? '#555' : C.accent, color: '#fff',
              border: 'none', borderRadius: 4, cursor: loading ? 'default' : 'pointer', fontSize: 13,
            }}
          >
            {loading ? '分析中…（whisper 首次可能较慢）' : '分析'}
          </button>

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
                {/* 时间轴条（红底=删除，绿块=保留） */}
                <div style={{ position: 'relative', flex: 1, height: 32, borderRadius: 6, overflow: 'hidden', background: C.removed }}>
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
              </div>
              <div style={{ fontSize: 10, color: C.textSub, marginBottom: 8, lineHeight: 1.5 }}>
                上条为原始媒体的「保留(绿)/删除(红)」分布，可对照判断是否误删、删得是否精确。
              </div>

              {/* 删除明细（可编辑：调起止 / 捕获逐帧时间 / 删除此段） */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: C.textSub }}>删除明细（共 {removed.length} 段，可编辑）</span>
                <button
                  onClick={undoSpeechSegments}
                  disabled={speechUndoStack.length === 0}
                  style={{ fontSize: 11, padding: '2px 8px', background: speechUndoStack.length ? C.panel : '#333', color: speechUndoStack.length ? C.textMain : '#777', border: `1px solid ${C.border}`, borderRadius: 4, cursor: speechUndoStack.length ? 'pointer' : 'default' }}
                >
                  撤销{speechUndoStack.length > 0 ? `(${speechUndoStack.length})` : ''}
                </button>
              </div>
              <div style={{ maxHeight: 190, overflowY: 'auto', marginBottom: 10, fontSize: 11 }}>
                {removed.length === 0 && (
                  <div style={{ color: C.textSub, padding: '4px 0' }}>无删除区域（保留全部内容）</div>
                )}
                {removed.map((d, i) => {
                  const fps = selectedAsset?.fps ?? 30;
                  const fmt = (t: number) => `${t.toFixed(3)}s（帧${Math.round(t * fps)}）`;
                  const dv = draft[i] ?? d;
                  return (
                    <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: C.removed, display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ color: C.textMain, minWidth: 56 }}>删除段 {i + 1}</span>
                        <span style={{ color: C.textSub, fontVariantNumeric: 'tabular-nums' }}>{fmt(d[0])} – {fmt(d[1])}（{(d[1] - d[0]).toFixed(3)}s）</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <span style={{ color: C.textSub }}>起</span>
                        <input type="number" step={0.001} value={dv[0]} onChange={(e) => updateDraft(i, 'start', parseFloat(e.target.value))} onBlur={() => commitDraft(i)} style={numInput} />
                        <button onClick={() => captureTo(i, 'start')} title="用预览播放头（已映射回源时间）设为起点" style={miniBtn}>捕获</button>
                        <span style={{ color: C.textSub }}>止</span>
                        <input type="number" step={0.001} value={dv[1]} onChange={(e) => updateDraft(i, 'end', parseFloat(e.target.value))} onBlur={() => commitDraft(i)} style={numInput} />
                        <button onClick={() => captureTo(i, 'end')} title="用预览播放头设为终点" style={miniBtn}>捕获</button>
                        <button onClick={() => handleDeleteSegment(i)} title="删除此删除段（把该区间并入保留）" style={{ ...miniBtn, color: '#ff8a8a' }}>删段</button>
                      </div>
                    </div>
                  );
                })}
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
                  <audio controls src={previewUrl} style={{ width: '100%' }} />
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
