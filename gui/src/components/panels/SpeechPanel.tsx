// SpeechPanel —— 口播剪辑面板（speech auto-editing）
//
// 交互流程（镜像 AIPanel 的素材选择逻辑 + MediaPanel 的落轨逻辑）：
//   1) 从时间轴选中一个视频/音频片段
//   2) 调整编辑选项 → 点「分析」调用 window.aicut.speech.analyze
//   3) 展示压缩统计 + 保留/删除时间轴可视化
//   4) 点「生成清洗片段」调用 window.aicut.speech.assemble → 落轨（原片段保留）

import React, { useState } from 'react';
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

export default function SpeechPanel() {
  // ── 选中素材（镜像 AIPanel 逻辑）──
  const assets = useProjectStore((s) => s.project.assets);
  const selectedClipId = useUIStore((s) => s.selectedClipId);
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
  const [useDemucs, setUseDemucs] = useState(true);       // 声源分离降噪
  const [vadThreshold, setVadThreshold] = useState(0.25);  // VAD 灵敏度
  const [minGap, setMinGap] = useState(0.18);             // 最小停顿
  const [wordPad, setWordPad] = useState(0.04);           // 词边界 padding
  const [fillers, setFillers] = useState(true);           // 删语气词
  const [deess, setDeess] = useState(false);              // 去齿音
  const [normalize, setNormalize] = useState(false);      // 响度归一

  // ── 结果 / 状态 ──
  const [result, setResult] = useState<SpeechEditResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
      };
      const res = await window.aicut.speech.analyze(selectedAsset.path, JSON.stringify(opts));
      if (res.success && res.data) {
        setResult(res.data);
        setError(null);
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
        keepSegments: result.keepSegments,
        outputPath,
        crossfadeMs: 0,
        deess,
        normalize,
      };
      const res2 = await window.aicut.speech.assemble(original.path, JSON.stringify(asmOpts));
      if (res2.success && res2.data) {
        const asset = {
          id: uid('asset'),
          type: original.type, // 'video' | 'audio'
          path: res2.data.outputPath,
          duration: res2.data.duration,
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

  // 删除区间（用于可视化）
  const removed = result ? removedSpans(result.keepSegments, result.duration) : [];

  // detail 按类型计数
  const detailCounts = result
    ? result.detail.reduce<Record<string, number>>((acc, d) => {
        acc[d.type] = (acc[d.type] || 0) + 1;
        return acc;
      }, {})
    : {};

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

            {/* 滑块：VAD 灵敏度 */}
            <SliderRow label="VAD 灵敏度" value={vadThreshold} min={0.05} max={0.6} step={0.05}
              onChange={setVadThreshold} display={vadThreshold.toFixed(2)} />
            {/* 滑块：最小停顿 */}
            <SliderRow label="最小停顿(s)" value={minGap} min={0.05} max={0.6} step={0.01}
              onChange={setMinGap} display={minGap.toFixed(2)} />
            {/* 滑块：词边界 padding */}
            <SliderRow label="词边界(s)" value={wordPad} min={0} max={0.2} step={0.01}
              onChange={setWordPad} display={wordPad.toFixed(2)} />
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

          {error && (
            <div style={{ color: '#ff6b6b', marginBottom: 8, fontSize: 12 }}>错误：{error}</div>
          )}

          {/* 结果预览 */}
          {result && (
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10 }}>
              {/* 统计 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12 }}>
                <span>原时长 <b>{result.duration.toFixed(2)}s</b></span>
                <span style={{ color: C.removed }}>删除 <b>{result.totalRemovedSec.toFixed(2)}s</b></span>
                <span style={{ color: C.keep }}>压缩 {(result.ratio * 100).toFixed(0)}%</span>
              </div>

              {/* 时间轴可视化 */}
              <div style={{
                position: 'relative', width: '100%', height: 24, borderRadius: 6, overflow: 'hidden',
                background: C.removed, marginBottom: 6,
              }}>
                {result.keepSegments.map(([s, e], i) => (
                  <div key={i} style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: `${(s / result.duration) * 100}%`,
                    width: `${((e - s) / result.duration) * 100}%`,
                    background: C.keep, borderRadius: 4,
                  }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: C.textSub, marginBottom: 8 }}>
                <span><span style={{ display: 'inline-block', width: 10, height: 10, background: C.keep, borderRadius: 2, marginRight: 4 }} />保留</span>
                <span><span style={{ display: 'inline-block', width: 10, height: 10, background: C.removed, borderRadius: 2, marginRight: 4 }} />删除</span>
              </div>

              {/* 删除类型计数 */}
              {Object.keys(detailCounts).length > 0 && (
                <div style={{ fontSize: 11, color: C.textSub, marginBottom: 8 }}>
                  删除明细：{Object.entries(detailCounts).map(([k, v]) => `${k} ×${v}`).join('，')}
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
