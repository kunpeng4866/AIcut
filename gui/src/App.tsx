// AIcut 主布局 — 顶部导航 + 左面板 + 预览 + 右面板 + 时间轴
import { useEffect } from 'react';
import { useConfigStore } from './store/configStore';
import { useAssetStore } from './store/assetStore';
import { useUIStore } from './store/uiStore';
import { useProjectStore } from './store/projectStore';
import { isAIConfigured } from './config/ai_config';
import ConfigWizard from './config/ConfigWizard';
import AssetManagerModal from './components/AssetManagerModal';
import Header from './components/Header';
import MediaPanel from './components/MediaPanel';
import TextPanel from './components/panels/TextPanel';
import AudioPanel from './components/panels/AudioPanel';
import StickerPanel from './components/panels/StickerPanel';
import EffectsPanel from './components/panels/EffectsPanel';
import SpeechPanel from './components/panels/SpeechPanel';
import PreviewCanvas from './components/PreviewCanvas';
import ErrorBoundary from './components/ErrorBoundary';
import PropertiesPanel from './components/PropertiesPanel';
import MixerPanel from './components/MixerPanel';
import { AIPanel } from './components/AIPanel';
import Timeline from './components/Timeline';
import Splitter from './components/Splitter';
import type { SubtitleGenResult } from './aiTypes';
import type { ClipConfig } from './types';
import { createSubtitleClipFromAsr } from './utils/clipFactories';

// 深色主题色板
const C = {
  bg: '#1a1a2e',
  panel: '#16213e',
  control: '#0f3460',
  accent: '#e94560',
  textMain: '#eee',
  textSub: '#aaa',
  border: '#0f3460',
};

// 左面板标签页定义
const LEFT_TABS: { key: 'media' | 'effects' | 'text' | 'audio' | 'stickers' | 'speech'; label: string }[] = [
  { key: 'media', label: '素材' },
  { key: 'effects', label: '特效' },
  { key: 'text', label: '文字' },
  { key: 'audio', label: '音频' },
  { key: 'stickers', label: '贴纸' },
  { key: 'speech', label: '口播' },
];

export default function App() {
  const { config, isLoaded, showConfigWizard, updateConfig, setShowConfigWizard } = useConfigStore();
  const { activeLeftPanel, setActiveLeftPanel } = useUIStore();
  const {
    leftPanelWidth,
    rightPanelWidth,
    timelineHeight,
    setLeftPanelWidth,
    setRightPanelWidth,
    setTimelineHeight,
  } = useUIStore();
  const rightView = useUIStore((s) => s.rightView);
  const setRightView = useUIStore((s) => s.setRightView);
  // ⚠️ 必须在下方 `if (!isLoaded) return` 之前取：写在 JSX 里会让首渲染(提前返回)与
  // 加载完成后的渲染 hook 数量不一致，触发 React #310 整页崩溃。
  const showAssetManager = useAssetStore((s) => s.showManager);

  // AI 字幕 / ASR 结果 → 生成独立字幕轨 clip，与选中的音/视频片段对齐。
  // 走「时间轴文字轨」模型：预览(DOM 叠加层) 与导出(subtitle.rs drawtext) 均按
  // clip 时间线定位，天然一致；多次生成各自占一条轨、可分别编辑。
  const handleApplySubtitles = (result: SubtitleGenResult): string => {
    const { selectedTrackId, selectedClipId } = useUIStore.getState();
    const p = useProjectStore.getState();
    let refClip: ClipConfig | undefined;
    if (selectedTrackId && selectedClipId) {
      refClip = p.project.tracks
        .find((t) => t.id === selectedTrackId)
        ?.clips.find((c) => c.id === selectedClipId);
    }
    const n = createSubtitleClipFromAsr(result.items, refClip);
    if (n === 0) {
      return refClip
        ? '字幕落在音频区间外，未生成；请确认选中的是含该语音的片段'
        : `已生成 0 条字幕（请先在时间轴选中含音频的片段以便对齐）`;
    }
    return `已生成 ${n} 条字幕，放入独立文字轨（与音频对齐）`;
  };

  // 首次启动：加载配置；若AI未配置则弹出向导
  useEffect(() => {
    const { loadConfig } = useConfigStore.getState();
    loadConfig().then(() => {
      const state = useConfigStore.getState();
      if (state.config && !isAIConfigured(state.config)) {
        state.setShowConfigWizard(true);
      }
    });
    // 启动即探测补全资产状态（精简版缺 python/models 时用于「一键补全」提示）
    useAssetStore.getState().checkStatus();
  }, []);

  // 配置加载中
  if (!isLoaded) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', background: C.bg, color: C.textMain, fontFamily: 'system-ui', fontSize: 14 }}>
        AIcut 加载中...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, fontFamily: 'system-ui', overflow: 'hidden' }}>
      {/* 顶部导航栏 */}
      <Header />

      {/* 中间区域：左面板 + 预览 + 右面板 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 左面板 */}
        <aside style={{ width: leftPanelWidth, background: C.panel, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          {/* 面板切换标签 */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            {LEFT_TABS.map((tab) => (
              <button key={tab.key} onClick={() => setActiveLeftPanel(tab.key)} style={{
                flex: 1, padding: '8px 0', background: 'transparent',
                color: activeLeftPanel === tab.key ? C.textMain : C.textSub,
                border: 'none', borderBottom: activeLeftPanel === tab.key ? `2px solid ${C.accent}` : '2px solid transparent',
                cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
              }}>
                {tab.label}
              </button>
            ))}
          </div>
          {/* 面板内容 */}
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {activeLeftPanel === 'media' && <MediaPanel />}
            {activeLeftPanel === 'effects' && <EffectsPanel />}
            {activeLeftPanel === 'text' && <TextPanel />}
            {activeLeftPanel === 'audio' && <AudioPanel />}
            {activeLeftPanel === 'stickers' && <StickerPanel />}
            {activeLeftPanel === 'speech' && <SpeechPanel />}
          </div>
        </aside>

        {/* 左/预览 分隔条 */}
        <Splitter direction="horizontal" onDrag={(d) => setLeftPanelWidth(useUIStore.getState().leftPanelWidth + d)} />

        {/* 预览画布 */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <ErrorBoundary fallbackTitle="预览画布发生异常">
            <PreviewCanvas />
          </ErrorBoundary>
        </main>

        {/* 预览/右 分隔条 */}
        <Splitter direction="horizontal" onDrag={(d) => setRightPanelWidth(useUIStore.getState().rightPanelWidth - d)} />

        {/* 右面板：属性 / 混音器 切换 */}
        <aside style={{ width: rightPanelWidth, background: C.panel, borderLeft: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            {([['props', '属性'], ['mixer', '混音器'], ['ai', 'AI']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setRightView(key)} style={{
                flex: 1, padding: '8px 0', background: 'transparent',
                color: rightView === key ? C.textMain : C.textSub,
                border: 'none', borderBottom: rightView === key ? `2px solid ${C.accent}` : '2px solid transparent',
                cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
              }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {rightView === 'props' ? <PropertiesPanel /> : rightView === 'mixer' ? <MixerPanel /> : <AIPanel onApply={handleApplySubtitles} />}
          </div>
        </aside>
      </div>

      {/* 中间/时间轴 分隔条 */}
      <Splitter direction="vertical" onDrag={(d) => setTimelineHeight(useUIStore.getState().timelineHeight - d)} />

      {/* 底部时间轴 */}
      <div style={{ height: timelineHeight, background: C.panel, borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
        <Timeline />
      </div>

      {/* AI配置向导弹窗 */}
      {showConfigWizard && config && (
        <ConfigWizard
          initialConfig={config}
          onComplete={(cfg) => { updateConfig(cfg); setShowConfigWizard(false); }}
          onCancel={() => setShowConfigWizard(false)}
        />
      )}

      {/* AI 组件管理（一键补全）弹窗 */}
      {showAssetManager && <AssetManagerModal />}
    </div>
  );
}
