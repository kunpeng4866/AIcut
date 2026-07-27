// 素材面板 — 导入、搜索、列表、拖拽支持
import React, { useState, useCallback } from 'react';
import { useProjectStore } from '../store/projectStore';
import type { AssetConfig, ClipConfig } from '../types';

// 生成唯一ID
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
// 从路径提取文件名
const getFilename = (path: string): string => {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.substring(idx + 1) : path;
};
// 格式化时长 mm:ss
const formatTime = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const theme = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'system-ui', color: '#eee' } as React.CSSProperties,
  header: { padding: 8, display: 'flex', gap: 6 } as React.CSSProperties,
  btn: { padding: '6px 10px', background: '#0f3460', color: '#eee', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,
  input: { flex: 1, padding: '6px 8px', background: '#0f3460', border: '1px solid #16213e', borderRadius: 4, color: '#eee', fontSize: 12, outline: 'none' } as React.CSSProperties,
  list: { flex: 1, overflowY: 'auto', padding: '0 8px' } as React.CSSProperties,
  item: { display: 'flex', alignItems: 'center', gap: 8, padding: 6, margin: '4px 0', background: '#16213e', borderRadius: 4, cursor: 'pointer', border: '1px solid transparent' } as React.CSSProperties,
  itemHover: { border: '1px solid #e94560' } as React.CSSProperties,
  thumb: { width: 48, height: 32, background: '#0f3460', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 } as React.CSSProperties,
  info: { flex: 1, minWidth: 0 } as React.CSSProperties,
  name: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  dur: { fontSize: 10, color: '#aaa', marginTop: 2 } as React.CSSProperties,
  footer: { padding: '6px 8px', borderTop: '1px solid #0f3460', fontSize: 11, color: '#aaa', textAlign: 'center' } as React.CSSProperties,
  empty: { textAlign: 'center', color: '#666', fontSize: 12, padding: 24 } as React.CSSProperties,
};

export default function MediaPanel() {
  const assets = useProjectStore((s) => s.project.assets);
  const addAsset = useProjectStore((s) => s.addAsset);
  const addClip = useProjectStore((s) => s.addClip);
  const addTrack = useProjectStore((s) => s.addTrack);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  // 导入素材：调用主进程选择文件 → 探测元数据 → 加入素材库
  const handleImport = useCallback(async () => {
    try {
      const paths = await window.aicut.openFiles();
      if (!paths || paths.length === 0) return;
      setBusy(true);
      for (const path of paths) {
        try {
          const result = await window.aicut.probe(path);
          const info = result.info;
          addAsset({
            id: uid('asset'),
            type: info?.media_type || 'video',
            path,
            duration: info?.duration || 5,
            width: info?.width || 1920,
            height: info?.height || 1080,
            codec: info?.codec || 'h264',
            fps: info?.fps || 30,
          });
        } catch {
          // 探测失败用默认值
          addAsset({ id: uid('asset'), type: 'video', path, duration: 5, width: 1920, height: 1080, codec: 'h264', fps: 30 });
        }
      }
    } finally {
      setBusy(false);
    }
  }, [addAsset]);

  // 点击素材：添加到时间轴末尾（视频→主视频轨，音频→音频轨）
  const handleAddToTimeline = useCallback((asset: AssetConfig) => {
    const state = useProjectStore.getState();
    const trackType = asset.type === 'audio' ? 'audio' : 'video';
    // 视频素材优先使用主视频轨道
    let track = trackType === 'video'
      ? state.project.tracks.find((t) => t.type === 'video' && t.isMain) || state.project.tracks.find((t) => t.type === 'video')
      : state.project.tracks.find((t) => t.type === 'audio');
    if (!track) {
      addTrack(trackType as 'video' | 'audio' | 'text' | 'sticker');
      track = trackType === 'video'
        ? useProjectStore.getState().project.tracks.find((t) => t.type === 'video')
        : useProjectStore.getState().project.tracks.find((t) => t.type === 'audio');
    }
    if (!track) return;
    const lastClip = track.clips[track.clips.length - 1];
    const start = lastClip ? lastClip.timelineOut : 0;
    const duration = asset.duration || 5;
    const clip: ClipConfig = {
      id: uid('clip'),
      assetId: asset.id,
      src_range: { start: 0, end: duration },
      timelineIn: start,
      timelineOut: start + duration,
      transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      volume: 1, speed: 1,
      effects: [], masks: [], filters: [], keyframes: {},
    };
    addClip(track.id, clip);
  }, [addClip, addTrack]);

  // 拖拽：设置数据传输
  const handleDragStart = (e: React.DragEvent, asset: AssetConfig) => {
    e.dataTransfer.setData('application/json', JSON.stringify(asset));
    e.dataTransfer.effectAllowed = 'copy';
  };

  // 根据类型返回图标
  const iconFor = (type: string) => (type === 'audio' ? '🎵' : type === 'image' ? '🖼️' : '🎬');

  // 过滤搜索结果
  const filtered = search
    ? assets.filter((a) => getFilename(a.path).toLowerCase().includes(search.toLowerCase()))
    : assets;

  return (
    <div style={theme.root}>
      {/* 顶部：导入 + 搜索 */}
      <div style={theme.header}>
        <button style={theme.btn} onClick={handleImport} disabled={busy}>
          {busy ? '导入中...' : '+ 导入'}
        </button>
        <input style={theme.input} placeholder="搜索素材..." value={search}
          onChange={(e) => setSearch(e.target.value)} />
      </div>

      {/* 中间：素材列表 */}
      <div style={theme.list}>
        {filtered.length === 0 ? (
          <div style={theme.empty}>{search ? '未找到匹配素材' : '暂无素材，点击导入'}</div>
        ) : (
          filtered.map((a) => (
            <div key={a.id} style={theme.item}
              onClick={() => handleAddToTimeline(a)}
              draggable
              onDragStart={(e) => handleDragStart(e, a)}
              title="点击添加到时间轴，或拖拽到时间轴">
              <div style={theme.thumb}>{iconFor(a.type)}</div>
              <div style={theme.info}>
                <div style={theme.name}>{getFilename(a.path)}</div>
                <div style={theme.dur}>{formatTime(a.duration || 0)} · {a.width || 0}×{a.height || 0}</div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 底部：统计 */}
      <div style={theme.footer}>共 {assets.length} 个素材</div>
    </div>
  );
}
