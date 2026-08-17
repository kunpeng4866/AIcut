// 素材面板 — 导入、搜索、列表、拖拽支持（含从文件夹拖入导入、删除素材）
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

// 媒体文件扩展名（用于从文件夹拖拽导入时过滤非媒体文件）
const MEDIA_EXT = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', 'ts',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'wma', 'opus',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff',
]);
const isMediaFile = (p: string): boolean => {
  const i = p.lastIndexOf('.');
  return i >= 0 && MEDIA_EXT.has(p.substring(i + 1).toLowerCase());
};
const pathExtIsAudio = (p: string): boolean => {
  const i = p.lastIndexOf('.');
  const ext = i >= 0 ? p.substring(i + 1).toLowerCase() : '';
  return ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'wma', 'opus'].includes(ext);
};

// 递归遍历拖入的目录（webkitGetAsEntry），收集所有文件的原生路径
function walkEntry(entry: any, out: string[]): Promise<void> {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file((file: any) => { if (file && file.path) out.push(file.path); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries((batch: any[]) => {
          if (!batch || batch.length === 0) return resolve();
          Promise.all(batch.map((e) => walkEntry(e, out))).then(readBatch);
        }, () => resolve());
      };
      readBatch();
    } else resolve();
  });
}

// 从 DataTransfer 收集所有拖入的文件/目录路径
async function collectPaths(dt: DataTransfer): Promise<string[]> {
  const out: string[] = [];
  const items = dt.items;
  if (items && items.length && typeof (items[0] as any).webkitGetAsEntry === 'function') {
    const entries: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as any;
      if (it.kind === 'string' && it.type === 'application/json') return []; // 素材拖出，交给时间轴处理
      const entry = it.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    for (const entry of entries) await walkEntry(entry, out);
    if (out.length) return out;
  }
  // 回退：多文件（不含目录）
  const files = dt.files;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as any;
    if (f && f.path) out.push(f.path);
  }
  return out;
}

const theme = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'system-ui', color: '#eee' } as React.CSSProperties,
  header: { padding: 8, display: 'flex', gap: 6 } as React.CSSProperties,
  btn: { padding: '6px 10px', background: '#0f3460', color: '#eee', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,
  input: { flex: 1, padding: '6px 8px', background: '#0f3460', border: '1px solid #16213e', borderRadius: 4, color: '#eee', fontSize: 12, outline: 'none' } as React.CSSProperties,
  list: { flex: 1, overflowY: 'auto', padding: '0 8px' } as React.CSSProperties,
  item: { display: 'flex', alignItems: 'center', gap: 8, padding: 6, margin: '4px 0', background: '#16213e', borderRadius: 4, cursor: 'pointer', border: '1px solid transparent' } as React.CSSProperties,
  itemHover: { borderColor: '#e94560' } as React.CSSProperties,
  thumb: { width: 48, height: 32, background: '#0f3460', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 } as React.CSSProperties,
  info: { flex: 1, minWidth: 0 } as React.CSSProperties,
  name: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  dur: { fontSize: 10, color: '#aaa', marginTop: 2 } as React.CSSProperties,
  delBtn: { width: 22, height: 22, flexShrink: 0, background: 'transparent', border: 'none', color: '#e94560', cursor: 'pointer', fontSize: 14, lineHeight: 1, borderRadius: 4, opacity: 0, transition: 'opacity 0.15s', padding: 0 } as React.CSSProperties,
  footer: { padding: '6px 8px', borderTop: '1px solid #0f3460', fontSize: 11, color: '#aaa', textAlign: 'center' } as React.CSSProperties,
  empty: { textAlign: 'center', color: '#666', fontSize: 12, padding: 24 } as React.CSSProperties,
  dropHint: { textAlign: 'center', color: '#4caf50', fontSize: 11, padding: '4px 8px' } as React.CSSProperties,
};

export default function MediaPanel() {
  const assets = useProjectStore((s) => s.project.assets);
  const addAsset = useProjectStore((s) => s.addAsset);
  const setAssetProxy = useProjectStore((s) => s.setAssetProxy);
  const removeAsset = useProjectStore((s) => s.removeAsset);
  const addClip = useProjectStore((s) => s.addClip);
  const addTrack = useProjectStore((s) => s.addTrack);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // 核心：导入一批路径（探测元数据 → 加入素材库）
  const importPaths = useCallback(async (paths: string[]) => {
    setBusy(true);
    try {
      for (const path of paths) {
        try {
          const result = await window.aicut.probe(path);
          const info = result.info;
          const type = info?.media_type || (pathExtIsAudio(path) ? 'audio' : 'video');
          const isVideo = type === 'video';
          const width = info?.width || 1920;
          const height = info?.height || 1080;
          const id = uid('asset');
          addAsset({
            id, type, path,
            duration: info?.duration || 5,
            width, height,
            codec: info?.codec || 'h264',
            fps: info?.fps || 30,
            sar: info?.sar || 1,
          });
          // 4K 源素材：异步生成 720p 代理，完成后回填代理路径，预览走代理保证流畅
          if (isVideo && (width > 1920 || height > 1080)) {
            window.aicut.ensureProxy(path, width, height)
              .then((proxyPath) => { if (proxyPath) setAssetProxy(id, proxyPath); })
              .catch(() => {});
          }
        } catch {
          addAsset({ id: uid('asset'), type: pathExtIsAudio(path) ? 'audio' : 'video', path, duration: 5, width: 1920, height: 1080, codec: 'h264', fps: 30, sar: 1 });
        }
      }
    } finally {
      setBusy(false);
    }
  }, [addAsset]);

  // 导入素材：选择文件对话框
  const handleImport = useCallback(async () => {
    const paths = await window.aicut.openFiles();
    if (!paths || paths.length === 0) return;
    await importPaths(paths);
  }, [importPaths]);

  // 从文件夹拖拽导入（文件或目录）
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return; // 仅处理外部文件/目录拖入（素材拖出交给时间轴）
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const paths = await collectPaths(e.dataTransfer);
    const media = paths.filter(isMediaFile);
    if (media.length) await importPaths(media);
  }, [importPaths]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) setDragActive(false);
  }, []);

  // 删除素材（连带清理引用它的时间轴片段）
  const handleDelete = useCallback((asset: AssetConfig) => {
    if (window.confirm(`删除素材「${getFilename(asset.path)}」？\n引用该素材的时间轴片段将一并删除。`)) {
      removeAsset(asset.id);
    }
  }, [removeAsset]);

  // 点击素材：添加到时间轴末尾（视频→主视频轨，音频→音频轨）
  const handleAddToTimeline = useCallback((asset: AssetConfig) => {
    const state = useProjectStore.getState();
    const trackType = asset.type === 'audio' ? 'audio' : 'video';
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

  // 拖拽：设置数据传输（拖出素材到时间轴）
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
    <div style={{ ...theme.root, ...(dragActive ? { background: 'rgba(76,175,80,0.08)' } : {}) }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}>
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
          <div style={theme.empty}>{search ? '未找到匹配素材' : '暂无素材，点击导入\n或从文件夹拖拽文件到此处'}</div>
        ) : (
          filtered.map((a) => (
            <div key={a.id} style={{ ...theme.item, ...(hoverId === a.id ? theme.itemHover : {}) }}
              onClick={() => handleAddToTimeline(a)}
              onMouseEnter={() => setHoverId(a.id)}
              onMouseLeave={() => setHoverId((h) => (h === a.id ? null : h))}
              draggable
              onDragStart={(e) => handleDragStart(e, a)}
              title="点击添加到时间轴，或拖拽到时间轴">
              <div style={theme.thumb}>{iconFor(a.type)}</div>
              <div style={theme.info}>
                <div style={theme.name}>{getFilename(a.path)}</div>
                <div style={theme.dur}>{formatTime(a.duration || 0)} · {a.width || 0}×{a.height || 0}</div>
              </div>
              <button style={{ ...theme.delBtn, opacity: hoverId === a.id ? 1 : 0 }}
                onClick={(e) => { e.stopPropagation(); handleDelete(a); }}
                title="删除素材">×</button>
            </div>
          ))
        )}
      </div>

      {/* 底部：统计 + 拖拽提示 */}
      <div style={theme.footer}>共 {assets.length} 个素材{dragActive ? ' · 松开可导入' : ''}</div>
    </div>
  );
}
