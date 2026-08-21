// TextPanel.tsx
// 用途：左侧面板「文字」标签页组件。负责添加文字片段、导入 SRT/ASS/VTT 字幕，
// 并列出工程里所有 text / subtitle 轨道上的片段，支持点击选中与删除。

import React, { useCallback, useState } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useAiStore } from '../../store/aiStore';
import { useConfigStore } from '../../store/configStore';
import { addTextClip, addSubtitleClip, parseSRT, createSubtitleClipFromAsr, createTranslatedTrack, createAudioClip, addClipToTrack, uid } from '../../utils/clipFactories';
import { subtitleItemDisplayStart } from '../../utils/timelineMap';
import type { ClipConfig, AssetConfig, TimeRemapConfig } from '../../types';

const theme = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    fontFamily: 'system-ui',
    color: '#eee',
  } as React.CSSProperties,
  btnRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 8,
  } as React.CSSProperties,
  addBtn: {
    flex: 1,
    padding: '8px 10px',
    background: '#0f3460',
    color: '#eee',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  } as React.CSSProperties,
  listWrap: {
    flex: 1,
    overflowY: 'auto' as const,
  },
  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 6,
    margin: '4px 0',
    background: '#16213e',
    borderRadius: 4,
    cursor: 'pointer',
    border: '1px solid transparent',
  } as React.CSSProperties,
  itemMain: {
    flex: 1,
    overflow: 'hidden',
  } as React.CSSProperties,
  primaryText: {
    color: '#eee',
    fontSize: 12,
  } as React.CSSProperties,
  secondaryText: {
    color: '#aaa',
    fontSize: 11,
  } as React.CSSProperties,
  deleteBtn: {
    padding: '2px 8px',
    background: '#3a1f2b',
    color: '#eee',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
  } as React.CSSProperties,
  emptyText: {
    color: '#aaa',
    fontSize: 12,
    padding: 8,
  } as React.CSSProperties,
};

const fmt = (s: number) => `${s.toFixed(1)}s`;

// 翻译目标语言（英文/中文为主，其余按模型能力提供）
const TARGET_LANGS: { value: string; label: string }[] = [
  { value: 'en', label: '翻译为英文' },
  { value: 'zh', label: '翻译为中文' },
  { value: 'ja', label: '翻译为日文' },
  { value: 'ko', label: '翻译为韩文' },
  { value: 'fr', label: '翻译为法文' },
  { value: 'de', label: '翻译为德文' },
  { value: 'es', label: '翻译为西班牙文' },
];

export default function TextPanel() {
  const tracks = useProjectStore((s) => s.project.tracks);
  const selectedClipId = useUIStore((s) => s.selectedClipId);

  // 收集 text / subtitle 轨道里的所有片段（带轨道类型与 id 信息）
  const items = tracks
    .filter((t) => t.type === 'text' || t.type === 'subtitle')
    .flatMap((t) =>
      t.clips.map((clip: ClipConfig) => ({
        trackId: t.id,
        trackType: t.type as 'text' | 'subtitle',
        clip,
      }))
    );

  // 点击片段 → 选中
  const handleSelect = useCallback((trackId: string, clipId: string) => {
    useUIStore.getState().selectClip(trackId, clipId);
  }, []);

  // 删除片段
  const handleDelete = useCallback((trackId: string, clipId: string) => {
    useProjectStore.getState().removeClip(trackId, clipId);
  }, []);

  // ── 语音转写 (ASR) 子模块 ──
  const assets = useProjectStore((s) => s.project.assets);
  const { transcribe, translate, isTranscribing, lang, setLang } = useAiStore();
  const [asrMsg, setAsrMsg] = useState<string | null>(null);
  const [translateMsg, setTranslateMsg] = useState<string | null>(null);
  const [translateTarget, setTranslateTarget] = useState('en');
  const [translating, setTranslating] = useState(false);
  const [ttsMsg, setTtsMsg] = useState<string | null>(null);
  const [ttsProgress, setTtsProgress] = useState<{ i: number; total: number } | null>(null);

  // 反查当前选中的片段及其素材（音频/视频才有音轨可转写）
  const refClip: ClipConfig | null = (() => {
    if (!selectedClipId) return null;
    for (const t of tracks) {
      const c = t.clips.find((c) => c.id === selectedClipId);
      if (c) return c;
    }
    return null;
  })();
  const refAsset = refClip ? assets.find((a) => a.id === refClip.assetId) : null;
  const canTranscribe = !!refAsset && (refAsset.type === 'audio' || refAsset.type === 'video');

  // 反查当前选中的「字幕轨」片段（翻译操作的对象）
  const selectedSubtitleClip: ClipConfig | null = (() => {
    if (!selectedClipId) return null;
    for (const t of tracks) {
      if (t.type !== 'subtitle') continue;
      const c = t.clips.find((c) => c.id === selectedClipId);
      if (c) return c;
    }
    return null;
  })();
  const subtitlePreview = selectedSubtitleClip
    ? (selectedSubtitleClip.subtitle?.items ?? []).map((it) => it.text).join(' / ')
    : '';

  const nameOf = (p: string): string => p.split(/[\\/]/).pop() || p;

  const handleAsr = async () => {
    if (!canTranscribe || !refAsset || !refClip) return;
    setAsrMsg('转写中…');
    try {
      await transcribe(refAsset.path, lang);
    } catch (e: any) {
      setAsrMsg('❌ 转写失败：' + (e?.message ?? String(e)));
      return;
    }
    const res = useAiStore.getState().asrResult;
    if (res && res.segments && res.segments.length) {
      const n = createSubtitleClipFromAsr(res.segments, refClip, { wordLevel: res.word_level, preGrouped: res.pre_grouped });
      setAsrMsg(
        n > 0
          ? `✅ 已生成 ${n} 条字幕，放在字幕轨（已与音频对齐）`
          : '⚠️ 转写结果落在音频区间外，未生成字幕',
      );
    } else {
      setAsrMsg('转写结果为空（可能无人声，或音频缺少音轨）。已生成调试日志，可在「系统临时目录\\aicut_asr_debug.log」查看真实返回；若仍为空，建议到「设置→语音识别→模型」切到 qwen-audio-3.0-asr-flash-streaming 重试。');
    }
  };

  // 翻译选中字幕「所在整条字幕轨」：收集该轨所有片段（按时间轴排序）的文字 → 逐片段翻译
  // → 克隆每个源片段、仅替换文本，1:1 落到一条新字幕轨。译文与源字幕、音频严格同刻对齐。
  const handleTranslate = async () => {
    if (!selectedSubtitleClip) return;
    const track = tracks.find(
      (t) => t.type === 'subtitle' && t.clips.some((c) => c.id === selectedSubtitleClip.id),
    );
    if (!track) {
      setTranslateMsg('找不到选中字幕所在的轨道');
      return;
    }
    // 同轨所有片段按时间轴顺序排序，保证译文 1:1 对应
    const sourceClips = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    // 收集所有非空字幕 item 的「扁平槽位」(片段下标 ci, item 下标 ii, 原文 text)，
    // 以便把整条字幕轨一次性批量翻译——避免逐句单发时 DeepSeek 对孤立短句“原样回声”导致漏翻
    // （实测：单独翻「大家看一下」被原样回传中文，9 句一起批量翻则正确出英文）。
    type Slot = { ci: number; ii: number; text: string };
    const slots: Slot[] = [];
    sourceClips.forEach((c, ci) => {
      (c.subtitle?.items ?? []).forEach((it, ii) => {
        const t = (it.text || '').trim();
        if (t) slots.push({ ci, ii, text: t });
      });
    });
    if (slots.length === 0) {
      setTranslateMsg('该字幕轨没有可翻译的文字');
      return;
    }
    // 逐条兜底翻译（仅批量失败时启用）：单条失败保留原文
    const translateEach = async (texts: string[], target: string): Promise<string[]> => {
      const out: string[] = [];
      for (const it of texts) {
        try {
          const r = await translate([it], target);
          out.push((r[0] ?? it).trim() || it);
        } catch { out.push(it); }
      }
      return out;
    };
    // 回声/未译检测：目标外文时译文仍含中文、或目标中文时译文不含中文，均判定为 DeepSeek 原样回声 → 回退原文
    const isCjkTarget = translateTarget === 'zh';
    const looksUntranslated = (tgt: string) => {
      const tgtCjk = /[一-鿿]/.test(tgt);
      return isCjkTarget ? !tgtCjk : tgtCjk;
    };
    setTranslating(true);
    setTranslateMsg('翻译中…');
    try {
      // 一次性批量翻译整条字幕轨所有非空句（后端 prompt 明确要求“逐行保序、行数一致”）
      const allTexts = slots.map((s) => s.text);
      let translatedAll: string[];
      try {
        const lines = await translate(allTexts, translateTarget);
        translatedAll =
          lines.length === allTexts.length ? lines : await translateEach(allTexts, translateTarget);
      } catch (e) {
        translatedAll = await translateEach(allTexts, translateTarget);
      }
      // 回填到逐片段 item 结构（与源 1:1 对齐）；空 item 保持占位，createTranslatedTrack 会回退原文
      const translatedItemsList: string[][] = sourceClips.map((c) =>
        (c.subtitle?.items ?? []).map(() => ''),
      );
      slots.forEach((s, k) => {
        const t = (translatedAll[k] ?? s.text).trim();
        translatedItemsList[s.ci][s.ii] = looksUntranslated(t) ? s.text : t;
      });
      const n = createTranslatedTrack(sourceClips, translatedItemsList);
      setTranslateMsg(
        n > 0
          ? `✅ 已翻译整条字幕（${n} 段）→ 新字幕轨，译文与原文一一对应`
          : '⚠️ 翻译结果为空',
      );
    } catch (e: any) {
      setTranslateMsg('❌ 翻译失败：' + (e?.message ?? String(e)));
    } finally {
      setTranslating(false);
    }
  };

  // 文字转语音：把选中字幕片段「所在整条字幕轨」逐句合成配音，按各自时间轴位置落到音频轨。
  // 每句调用 window.aicut.ttsSynthesize(text, voice)（输出路径由主进程生成），
  // 合成后用 probe 取真实时长，构造音频素材 + 音频片段并落轨。
  const handleTextToSpeech = async () => {
    if (!selectedSubtitleClip) return;
    const track = tracks.find(
      (t) => t.type === 'subtitle' && t.clips.some((c) => c.id === selectedSubtitleClip.id),
    );
    if (!track) {
      setTtsMsg('找不到选中字幕所在的轨道');
      return;
    }
    // 同轨所有片段按时间轴顺序排序
    const sourceClips = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    // 收集所有非空字幕 item，并折算其绝对时间起点。
    // ⚠️ 落点必须与「字幕在时间线上的实际显示起点」逐字节一致（见 PreviewCanvas）：
    // 显示当 (srcT(t) + lead) ∈ [item.start, item.end) 且 t ∈ [clip.timelineIn, clip.timelineOut)。
    // 旧写法 source_to_timeline(item.start - lead) 有两个硬伤：
    //   1) 倒放/曲线变速下不等于字幕显示起点（倒放会把 item 源起点映射到时间线末尾）→ 配音滞后；
    //   2) 设了时间偏移 lead 且 item 起点被 lead 推到 clip 起点之前时，算出负 timelineIn →
    //      开场句("大家看一下")落在时间线原点之前 → 音频片段不可见（"漏掉"）。
    // 故改用语幕显示起点函数（裁剪进 clip 活跃窗口），保证对齐且不越界。
    // ⚠️ 同时必须把字幕 clip 的变速（speed / time_remap）一并带给音频 clip：字幕在时间轴上
    //   是「变速后」显示的（窗口 = 源时长/speed），而 TTS 音频是「整句原速念出来的」。
    //   若音频不继承变速（speed 恒 1），变速场景下音频窗口被拉长、逐句累积滞后 →
    //   表现为"丢开头字、末尾句整句丢"。所以逐句记录 speed/time_remap，落轨时传给音频。
    const ttsItems: { text: string; absStart: number; speed: number; timeRemap?: TimeRemapConfig }[] = [];
    sourceClips.forEach((c) => {
      const lead = c.subtitle?.timeOffset || 0;
      const speed = c.speed && c.speed > 0 ? c.speed : 1;
      (c.subtitle?.items ?? []).forEach((it) => {
        const t = (it.text || '').trim();
        if (t) {
          const absStart = subtitleItemDisplayStart(c, it, lead);
          ttsItems.push({ text: t, absStart, speed, timeRemap: c.time_remap });
        }
      });
    });
    if (ttsItems.length === 0) {
      setTtsMsg('该字幕轨没有可合成的文字');
      return;
    }
    // 读 TTS 配置（与翻译读配置同源：useConfigStore）
    const ttsCfg = useConfigStore.getState().config?.tts;
    if (!ttsCfg || ttsCfg.provider === 'none') {
      setTtsMsg('TTS 未配置：请先到设置中选择火山引擎或 CosyVoice');
      return;
    }
    const provider = ttsCfg.provider;
    const voice =
      ttsCfg.defaultVoice || (provider === 'cosyvoice' ? 'longxiaochun' : 'BV002_streaming');

    // 逐段合成：失败重试一次（百炼/火山首调偶发冷启动失败），并真实记录失败段，
    // 绝不用「完成 N 段」覆盖掉失败提示（旧逻辑会把漏掉的片段静默吞掉）。
    const failed: string[] = [];
    let okCount = 0;
    for (let i = 0; i < ttsItems.length; i++) {
      const text = ttsItems[i].text;
      const absStart = ttsItems[i].absStart;
      setTtsProgress({ i, total: ttsItems.length });
      setTtsMsg(`合成中 ${i + 1}/${ttsItems.length}：${text.slice(0, 12)}${text.length > 12 ? '…' : ''}`);
      let res = await window.aicut.ttsSynthesize(text, voice);
      if (!res.success || !res.audioPath) {
        res = await window.aicut.ttsSynthesize(text, voice); // 重试一次
      }
      if (!res.success || !res.audioPath) {
        failed.push(text);
        continue;
      }
      // probe 取真实时长
      const probe = await window.aicut.probe(res.audioPath);
      const dur = probe?.info?.duration || 2;
      const asset: AssetConfig = {
        id: uid('asset'),
        type: 'audio',
        path: res.audioPath,
        duration: dur,
        width: 0,
        height: 0,
        codec: '',
        fps: 30,
      };
      useProjectStore.getState().addAsset(asset);
      const clip = createAudioClip(asset, { timelineIn: absStart, duration: dur, speed: ttsItems[i].speed, timeRemap: ttsItems[i].timeRemap });
      addClipToTrack('audio', clip);
      okCount++;
    }
    setTtsProgress(null);
    if (failed.length === 0) {
      setTtsMsg('文字转语音完成：共 ' + okCount + ' 段，已落到音频轨');
    } else {
      setTtsMsg(
        '文字转语音完成 ' + okCount + '/' + ttsItems.length + ' 段；失败 ' + failed.length +
        ' 段：' + failed.map((f) => '「' + f.slice(0, 10) + (f.length > 10 ? '…' : '') + '」').join(' '),
      );
    }
  };

  // 导入字幕：动态创建隐藏 file input，选择后用 FileReader 读文本并解析
  const handleImportSubtitle = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.ass,.vtt';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const parsed = parseSRT(text);
        if (parsed.length > 0) addSubtitleClip(parsed);
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  return (
    <div style={theme.root}>
      <div style={theme.btnRow}>
        <button style={theme.addBtn} onClick={() => addTextClip()}>
          添加文字
        </button>
        <button style={theme.addBtn} onClick={handleImportSubtitle}>
          导入字幕(CC)
        </button>
      </div>

      {/* 语音转写子模块：转写选中音/视频素材，结果落在独立文字轨 */}
      <div style={{ border: '1px solid #2a4a6a', borderRadius: 6, padding: 8, marginBottom: 8, background: '#101a30' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#cfe3ff', marginBottom: 6 }}>语音转写 (ASR)</div>
        {canTranscribe ? (
          <>
            <div style={{ ...theme.secondaryText, marginBottom: 6 }}>
              选中素材：{nameOf(refAsset!.path)}
            </div>
            <div style={theme.btnRow}>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                style={{ flex: 1, padding: '4px 6px', background: '#1a1a2e', color: '#eee', border: '1px solid #333', borderRadius: 4 }}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
                <option value="auto">自动检测</option>
              </select>
            </div>
            <button
              style={{ ...theme.addBtn, background: '#3a7afe' }}
              onClick={handleAsr}
              disabled={isTranscribing}
            >
              {isTranscribing ? '转写中…' : '开始转写并生成字幕轨'}
            </button>
          </>
        ) : (
          <div style={{ ...theme.secondaryText }}>
            请先在时间轴选中含音频的片段（音频 / 视频），再点击转写
          </div>
        )}
        {asrMsg && <div style={{ color: '#7bed9f', fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>{asrMsg}</div>}
      </div>

      {/* 翻译子模块：翻译选中字幕片段 → 新字幕轨（英/中为主，其余按模型能力） */}
      <div style={{ border: '1px solid #2a4a6a', borderRadius: 6, padding: 8, marginBottom: 8, background: '#101a30' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#cfe3ff', marginBottom: 6 }}>翻译整条字幕轨</div>
        {selectedSubtitleClip ? (
          <>
            <div style={{ ...theme.secondaryText, marginBottom: 6, wordBreak: 'break-all' }}>
              选中字幕：{subtitlePreview || '(空)'}
            </div>
            <select
              value={translateTarget}
              onChange={(e) => setTranslateTarget(e.target.value)}
              style={{ width: '100%', padding: '4px 6px', background: '#1a1a2e', color: '#eee', border: '1px solid #333', borderRadius: 4, marginBottom: 8 }}
            >
              {TARGET_LANGS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
            <button
              style={{ ...theme.addBtn, background: '#e94560' }}
              onClick={handleTranslate}
              disabled={translating}
            >
              {translating ? '翻译中…' : '翻译并生成新字幕轨'}
            </button>
          </>
        ) : (
          <div style={{ ...theme.secondaryText }}>
            请先在时间轴或下方列表选中任意一条字幕片段（将翻译其所在整条字幕轨）
          </div>
        )}
        {translateMsg && <div style={{ color: '#7bed9f', fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>{translateMsg}</div>}
      </div>

      {/* 文字转语音：把选中字幕轨逐句合成配音，按时间轴落到音频轨 */}
      <div style={{ border: '1px solid #2a4a6a', borderRadius: 6, padding: 8, marginBottom: 8, background: '#101a30' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#cfe3ff', marginBottom: 6 }}>文字转语音（配音）</div>
        {selectedSubtitleClip ? (
          <>
            <div style={{ ...theme.secondaryText, marginBottom: 6, wordBreak: 'break-all' }}>
              选中字幕：{subtitlePreview || '(空)'}
            </div>
            <button
              style={{ ...theme.addBtn, background: '#16a085' }}
              onClick={handleTextToSpeech}
              disabled={!!ttsProgress}
            >
              {ttsProgress ? `合成中 ${ttsProgress.i + 1}/${ttsProgress.total}` : '文字转语音并落到音频轨'}
            </button>
          </>
        ) : (
          <div style={{ ...theme.secondaryText }}>
            请先在时间轴或下方列表选中任意一条字幕片段（将合成其所在整条字幕轨）
          </div>
        )}
        {ttsMsg && <div style={{ color: '#7bed9f', fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>{ttsMsg}</div>}
      </div>

      <div style={theme.listWrap}>
        {items.length === 0 ? (
          <div style={theme.emptyText}>暂无文字/字幕，点击上方按钮添加</div>
        ) : (
          items.map(({ trackId, trackType, clip }) => {
            const isSelected = clip.id === selectedClipId;
            const label = trackType === 'text' ? '文字' : '字幕';
            const content =
              trackType === 'text'
                ? clip.text?.content ?? '(空文字)'
                : `${clip.subtitle?.items.length ?? 0} 条字幕`;
            return (
              <div
                key={clip.id}
                style={{
                  ...theme.listItem,
                  borderColor: isSelected ? '#e94560' : 'transparent',
                }}
                onClick={() => handleSelect(trackId, clip.id)}
              >
                <div style={theme.itemMain}>
                  <div style={theme.primaryText}>
                    [{label}] {content}
                  </div>
                  <div style={theme.secondaryText}>
                    {fmt(clip.timelineIn)} – {fmt(clip.timelineOut)}
                  </div>
                </div>
                <button
                  style={theme.deleteBtn}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    handleDelete(trackId, clip.id);
                  }}
                >
                  删除
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
