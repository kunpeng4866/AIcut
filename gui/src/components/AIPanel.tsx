// AIPanel —— AI 自动字幕生成面板（独立新增组件）
//
// 在主布局中加入 <AIPanel/> 即可挂载；本组件不依赖、不修改任何其他文件。
//
// 交互流程：
//   1) 文本域粘贴/输入 ASR 转写文本（或素材选择占位）→ 点击「生成字幕」
//   2) 显示生成的字幕条目预览（时间区间 + 文本）
//   3) 点击「应用到选中片段」把结果写入当前选中 clip 的 subtitle
//
// 与 projectStore 的解耦：组件不 import/修改 projectStore，而是通过可选 prop 回调 onApply
// 把结果交回上层（见 TODO）。

import React from 'react';
import { useAiStore } from '../store/aiStore';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import type { SubtitleGenResult } from '../aiTypes';

// 从素材路径取文件名作展示（AssetConfig 无 name 字段，统一用 basename）
const nameOf = (p: string): string => p.split(/[\\/]/).pop() || p;

interface AIPanelProps {
  // 由父组件（或主布局）传入：把生成结果写入「当前选中 clip」的 subtitle 字段。
  // 返回展示给用户的提示文案（成功或警告）；若返回空串则使用默认文案。
  onApply?: (result: SubtitleGenResult) => string;
}

export const AIPanel: React.FC<AIPanelProps> = ({ onApply }) => {
  const {
    transcript,
    lang,
    isGenerating,
    isTranscribing,
    result,
    error,
    asrResult,
    setTranscript,
    setLang,
    generateSubtitles,
    transcribe,
    clearResult,
  } = useAiStore();

  // 素材列表（音频/视频有音轨，图片/文字无，不列出）
  const assets = useProjectStore((s) => s.project.assets);
  const selectedClipId = useUIStore((s) => s.selectedClipId);

  const mediaAssets = assets.filter((a) => a.type === 'audio' || a.type === 'video');

  // 反查「当前选中片段」所用素材，若不在列表里（如视频）也补上，方便直接转写选中片段
  const selectedAsset = (() => {
    if (!selectedClipId) return null;
    const clip = useProjectStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === selectedClipId);
    const sa = clip ? assets.find((a) => a.id === clip.assetId) : null;
    return sa && (sa.type === 'audio' || sa.type === 'video') ? sa : null;
  })();

  // 合并去重（按 asset.id）
  const asrOptions = (() => {
    const map = new Map<string, (typeof assets)[number]>();
    mediaAssets.forEach((a) => map.set(a.id, a));
    if (selectedAsset) map.set(selectedAsset.id, selectedAsset);
    return Array.from(map.values());
  })();

  const [asrPath, setAsrPath] = React.useState('');
  const [asrDone, setAsrDone] = React.useState(false);

  // 默认选中：选中片段素材 > 第一个可转写素材
  React.useEffect(() => {
    if (asrPath) return;
    const init = selectedAsset ? selectedAsset.path : (asrOptions[0]?.path ?? '');
    if (init) setAsrPath(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset, asrOptions, asrPath]);

  const handleTranscribe = async () => {
    setAsrDone(false);
    await transcribe(asrPath, lang);
    const st = useAiStore.getState();
    if (st.transcript && !st.error) setAsrDone(true);
  };

  // 用 ASR 真实语音时间戳直接生成字幕（与音频精准对齐，无需 DeepSeek 重猜时间轴）
  const handleBuildFromAsr = () => {
    try {
      if (!asrResult) {
        setAppliedInfo('暂无 ASR 结果，请先执行语音转写');
        return;
      }
      const segs = asrResult.segments;
      if (!segs || !Array.isArray(segs) || segs.length === 0) {
        setAppliedInfo('ASR 结果中没有语音片段（segments 为空），可能音频无人声');
        return;
      }
      const sub: SubtitleGenResult = {
        items: segs.map((s) => ({ start: s.start, end: s.end, text: s.text })),
        fontFamily: undefined,
        fontSize: undefined,
        color: undefined,
        position: 'bottom',
      };
      // 写入 aiStore.result，让 AIPanel 显示字幕列表（与 DeepSeek 路径一致）
      useAiStore.setState({ result: sub as any });
      if (onApply) {
        const msg = onApply(sub);
        setAppliedInfo(msg || '✅ 已用语音时间戳生成字幕（与音频对齐），可在画布预览');
      } else {
        // eslint-disable-next-line no-console
        console.warn('[AIPanel] 未提供 onApply 回调，字幕未写入片段');
        setAppliedInfo('未接入 onApply：字幕已生成但未写入片段');
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[AIPanel] handleBuildFromAsr 异常:', e);
      setAppliedInfo('生成字幕失败: ' + (e?.message || String(e)));
    }
  };

  const [appliedInfo, setAppliedInfo] = React.useState<string | null>(null);

  const handleGenerate = () => {
    setAppliedInfo(null);
    generateSubtitles(transcript, lang);
  };

  const handleApply = () => {
    if (!result) return;
    if (onApply) {
      const msg = onApply(result);
      setAppliedInfo(msg || `已应用 ${result.items.length} 条字幕到选中片段`);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[AIPanel] 未提供 onApply 回调，字幕未写入片段');
      setAppliedInfo('未接入 onApply：结果已生成但未写入片段');
    }
  };

  return (
    <div style={{ padding: 12, border: '1px solid #2a2a2a', borderRadius: 8, color: '#eee', fontSize: 13 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>AI 自动字幕</h3>

      <label style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}>语言</label>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        style={{ width: '100%', marginBottom: 8, padding: 4, background: '#1a1a1a', color: '#eee', border: '1px solid #333' }}
      >
        <option value="zh">中文</option>
        <option value="en">English</option>
        <option value="auto">自动检测</option>
      </select>

      {/* ── 语音转写(ASR) ── */}
      <div style={{ border: '1px solid #2a2a2a', borderRadius: 6, padding: 8, marginBottom: 10, background: '#161616' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>语音转写 (ASR)</div>
        <label style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}>选择素材（音频/视频）</label>
        <select
          value={asrPath}
          onChange={(e) => setAsrPath(e.target.value)}
          style={{ width: '100%', marginBottom: 8, padding: 4, background: '#1a1a1a', color: '#eee', border: '1px solid #333' }}
        >
          <option value="">请选择素材</option>
          {asrOptions.map((a) => (
            <option key={a.id} value={a.path}>{nameOf(a.path)}</option>
          ))}
        </select>
        <button
          onClick={handleTranscribe}
          disabled={isTranscribing || !asrPath}
          style={{ width: '100%', padding: '6px 10px', background: (isTranscribing || !asrPath) ? '#555' : '#8e44ad', color: '#fff', border: 'none', borderRadius: 4, cursor: (isTranscribing || !asrPath) ? 'default' : 'pointer' }}
        >
          {isTranscribing ? '转写中…' : '开始转写'}
        </button>
        {isTranscribing && (
          <div style={{ marginTop: 6, opacity: 0.8 }}>正在本地 whisper.cpp 转写音轨…</div>
        )}
        {asrDone && !isTranscribing && (
          <div style={{ color: '#7bed9f', marginTop: 6 }}>
            ✅ 已转写并填入文本，点下方「生成字幕」即可生成时间轴字幕
          </div>
        )}
        {asrResult && !isTranscribing && (
          <button
            onClick={handleBuildFromAsr}
            style={{ width: '100%', marginTop: 6, padding: '6px 10px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
          >
            用语音时间戳直接生成字幕
          </button>
        )}
      </div>

      <label style={{ display: 'block', marginBottom: 4, opacity: 0.8 }}>ASR 转写文本</label>
      <textarea
        value={transcript}
        onChange={(e) => { setTranscript(e.target.value); setAsrDone(false); }}
        placeholder="粘贴语音识别(ASR)的纯文本，点击生成后由 DeepSeek 切分为时间轴字幕…"
        rows={6}
        style={{ width: '100%', boxSizing: 'border-box', padding: 6, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, resize: 'vertical' }}
      />

      <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          style={{ flex: 1, padding: '6px 10px', background: isGenerating ? '#555' : '#3a7afe', color: '#fff', border: 'none', borderRadius: 4, cursor: isGenerating ? 'default' : 'pointer' }}
        >
          {isGenerating ? '生成中…' : '生成字幕'}
        </button>
        <button
          onClick={clearResult}
          style={{ padding: '6px 10px', background: '#333', color: '#eee', border: '1px solid #444', borderRadius: 4, cursor: 'pointer' }}
        >
          清空
        </button>
      </div>

      {error && (
        <div style={{ color: '#ff6b6b', marginBottom: 8 }}>错误：{error}</div>
      )}

      {appliedInfo && (
        <div style={{ color: '#7bed9f', marginTop: 6 }}>{appliedInfo}</div>
      )}

      {result && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ opacity: 0.8 }}>共 {result.items.length} 条</span>
            <button
              onClick={handleApply}
              style={{ padding: '4px 10px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >
              应用到选中片段
            </button>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto', background: '#161616', border: '1px solid #2a2a2a', borderRadius: 4 }}>
            {result.items.map((it, i) => (
              <div key={i} style={{ padding: '4px 8px', borderBottom: '1px solid #222', display: 'flex', gap: 8 }}>
                <span style={{ opacity: 0.5, minWidth: 92, fontVariantNumeric: 'tabular-nums' }}>
                  {it.start.toFixed(1)}s – {it.end.toFixed(1)}s
                </span>
                <span>{it.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p style={{ fontSize: 11, opacity: 0.5, marginTop: 10, lineHeight: 1.5 }}>
        后端：DeepSeek LLM（curl 调用 api.deepseek.com，key 取自 DEEPSEEK_API_KEY）。
        已接入 window.aicut.ai.generateSubtitles（electron → aicut-engine ai subtitles）。
        选中时间轴上的片段后点「应用到选中片段」即可写入 subtitle。
      </p>
    </div>
  );
};
