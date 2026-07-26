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

// 删除类型 → 中文标签 + 颜色（用于明细列表）
const DETAIL_LABELS: Record<string, { label: string; color: string }> = {
  text_filler:    { label: '语气词',    color: '#fca5a5' },
  isolated_noise: { label: '孤立噪声',  color: '#fca5a5' },
  gap_breath:     { label: '气声/咳嗽', color: '#f0abfc' },
  transient:      { label: '瞬态/咂嘴', color: '#fcd34d' },
  intra_keep:     { label: '段内噪声',  color: '#fca5a5' },
  manual_exclude: { label: '手动排除',  color: '#94a3b8' },
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
  const [keepNonspeech, setKeepNonspeech] = useState(true); // 保留背景音乐/环境音

  // ── assemble 选项 ──
  const [declick, setDeclick] = useState(true);          // 去咔哒声(爆音)
  const [crossfadeMs, setCrossfadeMs] = useState(20);    // 接缝平滑(ms)

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
        keepNonspeech,
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
        crossfadeMs,
        declick,
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

  // 删除区间（保留备用；当前可视化直接用 keepSegments 与 detail）
  const removed = result ? removedSpans(result.keepSegments, result.duration) : [];

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
                  {result.keepSegments.map(([s, e], i) => (
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

              {/* 删除明细（按时间，带起止秒数与类型） */}
              <div style={{ fontSize: 11, color: C.textSub, marginBottom: 4 }}>
                删除明细（按时间，共 {result.detail.length} 段）
              </div>
              <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 10, fontSize: 11 }}>
                {result.detail.length === 0 && (
                  <div style={{ color: C.textSub, padding: '4px 0' }}>无删除区域（保留全部内容）</div>
                )}
                {result.detail.map((d, i) => {
                  const info = DETAIL_LABELS[d.type] || { label: d.type, color: C.removed };
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: info.color, display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ color: C.textMain, minWidth: 62 }}>{info.label}</span>
                      <span style={{ color: C.textSub, fontVariantNumeric: 'tabular-nums' }}>
                        {d.start.toFixed(2)}–{d.end.toFixed(2)}s（{(d.end - d.start).toFixed(2)}s）
                      </span>
                    </div>
                  );
                })}
              </div>

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
