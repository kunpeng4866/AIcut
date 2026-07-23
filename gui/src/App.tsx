// AIcut 主布局 — 顶部导航 + 左面板 + 预览 + 右面板 + 时间轴
import React, { useEffect } from 'react';
import { useConfigStore } from './store/configStore';
import { useUIStore } from './store/uiStore';
import { useProjectStore } from './store/projectStore';
import { isAIConfigured } from './config/ai_config';
import ConfigWizard from './config/ConfigWizard';
import Header from './components/Header';
import MediaPanel from './components/MediaPanel';
import PreviewCanvas from './components/PreviewCanvas';
import PropertiesPanel from './components/PropertiesPanel';
import MixerPanel from './components/MixerPanel';
import { AIPanel } from './components/AIPanel';
import Timeline from './components/Timeline';
import Splitter from './components/Splitter';
import type { SubtitleGenResult } from './aiTypes';
import type { SubtitleContent } from './types';

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
const LEFT_TABS: { key: 'media' | 'effects' | 'text' | 'audio' | 'stickers'; label: string }[] = [
  { key: 'media', label: '素材' },
  { key: 'effects', label: '特效' },
  { key: 'text', label: '文字' },
  { key: 'audio', label: '音频' },
  { key: 'stickers', label: '贴纸' },
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
  const [rightView, setRightView] = React.useState<'props' | 'mixer' | 'ai'>('props');

  // AI 字幕生成结果 → 写入当前选中片段的 subtitle 字段
  const handleApplySubtitles = (result: SubtitleGenResult): string => {
    const { selectedTrackId, selectedClipId } = useUIStore.getState();
    if (!selectedTrackId || !selectedClipId) {
      return '请先在时间轴上选中一个片段，再应用字幕';
    }
    const subtitle: SubtitleContent = {
      items: result.items.map((it) => ({ start: it.start, end: it.end, text: it.text })),
      fontFamily: result.fontFamily,
      fontSize: result.fontSize,
      color: result.color,
      position: result.position,
    };
    useProjectStore.getState().updateClip(selectedTrackId, selectedClipId, { subtitle });
    return `已应用 ${result.items.length} 条字幕到选中片段`;
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
          <div style={{ flex: 1, minHeight: 0 }}>
            {activeLeftPanel === 'media' ? <MediaPanel /> : (
              <div style={{ padding: 24, color: C.textSub, fontSize: 13, textAlign: 'center' }}>
                {LEFT_TABS.find((t) => t.key === activeLeftPanel)?.label}面板（开发中）
              </div>
            )}
          </div>
        </aside>

        {/* 左/预览 分隔条 */}
        <Splitter direction="horizontal" onDrag={(d) => setLeftPanelWidth(useUIStore.getState().leftPanelWidth + d)} />

        {/* 预览画布 */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <PreviewCanvas />
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
    </div>
  );
}
