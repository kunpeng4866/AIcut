// AudioPanel.tsx
// 左侧面板「音频」标签页：用于把音频素材导入素材库，并添加到时间轴音频轨。
// - 「添加音频」按钮：通过 window.aicut.openFiles() 选择音频文件，probe 后写入 project.assets。
// - 音频素材列表：展示已导入的音频（文件名 + 时长），点击「+ 添加」把该素材加到音频轨。
// 该组件无 props，状态全部来自 useProjectStore。

import React, { useState, useCallback } from 'react';
import { useProjectStore } from '../../store/projectStore';
import type { AssetConfig, ClipConfig } from '../../types';
import { uid, addClipToTrack } from '../../utils/clipFactories';

const theme = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    fontFamily: 'system-ui',
    color: '#eee',
    padding: 10,
    boxSizing: 'border-box' as const,
  },
  addBtn: {
    padding: '8px 10px',
    background: '#0f3460',
    color: '#eee',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  empty: {
    color: '#aaa',
    fontSize: 12,
    padding: '12px 4px',
  },
  list: {
    flex: 1,
    overflowY: 'auto' as const,
    marginTop: 10,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: 6,
    margin: '4px 0',
    background: '#16213e',
    borderRadius: 4,
  },
  itemName: {
    color: '#eee',
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  },
  itemDur: {
    color: '#aaa',
    fontSize: 11,
    flexShrink: 0 as const,
  },
  addClipBtn: {
    padding: '4px 8px',
    background: '#0f3460',
    color: '#eee',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
};

export default function AudioPanel() {
  const assets = useProjectStore((s) => s.project.assets);
  const audioAssets = assets.filter((a) => a.type === 'audio');

  // 添加音频：选文件 -> probe -> 写入素材库
  const handleAddAudio = useCallback(async () => {
    try {
      const paths: string[] = await window.aicut.openFiles();
      for (const path of paths) {
        const res = await window.aicut.probe(path);
        const asset: AssetConfig = {
          id: uid('asset'),
          type: 'audio',
          path,
          duration: res.info?.duration || 5,
          width: res.info?.width || 0,
          height: res.info?.height || 0,
          codec: res.info?.codec || '',
          fps: res.info?.fps || 30,
        };
        useProjectStore.getState().addAsset(asset);
      }
    } catch (err) {
      // 文件选择取消或 probe 失败时静默忽略
      console.error('[AudioPanel] add audio failed:', err);
    }
  }, []);

  // 把某个音频素材加到音频轨
  const handleAddToTimeline = useCallback((asset: AssetConfig) => {
    const dur = asset.duration || 5;
    const clip: ClipConfig = {
      id: uid('clip'),
      assetId: asset.id,
      src_range: { start: 0, end: dur },
      timelineIn: 0,
      timelineOut: dur,
      transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      volume: 1,
      speed: 1,
      effects: [],
      masks: [],
      filters: [],
      keyframes: {},
    };
    addClipToTrack('audio', clip);
  }, []);

  return (
    <div style={theme.root}>
      <button style={theme.addBtn} onClick={handleAddAudio}>
        添加音频
      </button>

      {audioAssets.length === 0 ? (
        <div style={theme.empty}>暂无音频，点击“添加音频”导入</div>
      ) : (
        <div style={theme.list}>
          {audioAssets.map((asset) => {
            const fileName = (asset.path || '').split(/[\\/]/).pop() || asset.path || '未命名';
            return (
              <div key={asset.id} style={theme.item}>
                <span style={theme.itemName} title={fileName}>
                  {fileName}
                </span>
                <span style={theme.itemDur}>{(asset.duration || 0).toFixed(1)}s</span>
                <button
                  style={theme.addClipBtn}
                  onClick={() => handleAddToTimeline(asset)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#1a4a82')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '#0f3460')}
                >
                  + 添加
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
