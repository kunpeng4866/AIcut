// StickerPanel.tsx
// 用途：左侧面板「贴纸」标签页组件。负责把本地图片作为贴纸素材导入，
// 并将选中的图片素材以贴纸片段（sticker clip）形式添加到时间轴的 sticker 轨道。
// 贴纸在预览画面中的实际叠加渲染由主代理在 PreviewCanvas 中补 DOM <img> 完成，
// 本组件只负责把素材写入 project.assets 并把片段加到 sticker 轨。

import React, { useState, useCallback } from 'react';
import { useProjectStore } from '../../store/projectStore';
import type { AssetConfig } from '../../types';
import { uid, addClipToTrack, createImageStickerClip } from '../../utils/clipFactories';

const theme = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    fontFamily: 'system-ui',
    color: '#eee',
  } as React.CSSProperties,
  addBtn: {
    padding: '8px 10px',
    background: '#0f3460',
    color: '#eee',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  } as React.CSSProperties,
  listItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: 6,
    margin: '4px 0',
    background: '#16213e',
    borderRadius: 4,
  } as React.CSSProperties,
  addSmallBtn: {
    padding: '4px 8px',
    background: '#0f3460',
    color: '#eee',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  } as React.CSSProperties,
  primaryText: {
    color: '#eee',
    fontSize: 12,
  } as React.CSSProperties,
  secondaryText: {
    color: '#aaa',
    fontSize: 11,
  } as React.CSSProperties,
};

export default function StickerPanel() {
  const [importing, setImporting] = useState(false);

  const assets = useProjectStore((s) => s.project.assets);
  const imageAssets = assets.filter((a) => a.type === 'image');

  // 添加贴纸：打开文件选择框，拿到路径后 probe + 写入素材库
  const handleAddSticker = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const paths = await window.aicut.openFiles();
      for (const path of paths) {
        const res = await window.aicut.probe(path);
        const asset: AssetConfig = {
          id: uid('asset'),
          type: 'image',
          path,
          duration: res.info?.duration || 5,
          width: res.info?.width || 0,
          height: res.info?.height || 0,
          codec: res.info?.codec || 'png',
        };
        useProjectStore.getState().addAsset(asset);
      }
    } finally {
      setImporting(false);
    }
  }, [importing]);

  // 把某个图片素材加为贴纸片段到 sticker 轨
  const handleAddToTrack = useCallback((asset: AssetConfig) => {
    addClipToTrack('sticker', createImageStickerClip(asset));
  }, []);

  return (
    <div style={theme.root}>
      <button style={theme.addBtn} onClick={handleAddSticker} disabled={importing}>
        {importing ? '导入中…' : '添加贴纸'}
      </button>

      <div style={{ flex: 1, overflowY: 'auto', marginTop: 8 }}>
        {imageAssets.length === 0 ? (
          <div style={{ ...theme.secondaryText, padding: 8 }}>
            暂无贴纸，点击“添加贴纸”导入图片
          </div>
        ) : (
          imageAssets.map((asset) => (
            <div key={asset.id} style={theme.listItem}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <div style={theme.primaryText}>
                  {asset.path.split(/[\\/]/).pop()}
                </div>
                <div style={theme.secondaryText}>
                  {asset.width}×{asset.height}
                </div>
              </div>
              <button style={theme.addSmallBtn} onClick={() => handleAddToTrack(asset)}>
                + 添加
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
