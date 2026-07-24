// TextPanel.tsx
// 用途：左侧面板「文字」标签页组件。负责添加文字片段、导入 SRT/ASS/VTT 字幕，
// 并列出工程里所有 text / subtitle 轨道上的片段，支持点击选中与删除。

import React, { useCallback } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { addTextClip, addSubtitleClip, parseSRT } from '../../utils/clipFactories';
import type { ClipConfig } from '../../types';

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
