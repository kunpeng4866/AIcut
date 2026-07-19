// AIcut Desktop — Main App
import React, { useState, useCallback, useEffect } from 'react';
import type { ProjectConfig, AssetConfig, TrackConfig, ClipConfig, MediaInfo } from './types';

const DEFAULT_PROJECT: ProjectConfig = {
  version: '1.0',
  canvas: { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
  assets: [], tracks: [],
};

export default function App() {
  const [project, setProject] = useState<ProjectConfig>(DEFAULT_PROJECT);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [renderCmd, setRenderCmd] = useState('');
  const [presets, setPresets] = useState<string[]>([]);

  useEffect(() => { window.aicut.getPresets().then(setPresets).catch(() => {}); }, []);

  const handleImport = useCallback(async () => {
    const files = await window.aicut.openFiles();
    if (!files.length) return;
    const newAssets: AssetConfig[] = [];
    for (const f of files) {
      const result = await window.aicut.probe(f);
      const name = f.replace(/^.*[\\/]/, '');
      newAssets.push({
        id: `a${Date.now()}_${newAssets.length}`, type: 'video', path: f,
        duration: result.info?.duration || 5,
        width: result.info?.width || 1920, height: result.info?.height || 1080,
        codec: result.info?.codec || 'h264',
      });
    }
    setProject(p => ({
      ...p,
      assets: [...p.assets, ...newAssets],
      tracks: p.tracks.length ? p.tracks : [{ id: 'main', type: 'video', order: 0, clips: [] }],
    }));
  }, []);

  const handleAddToTimeline = useCallback((asset: AssetConfig) => {
    setProject(p => {
      const track = p.tracks[0] || { id: 'main', type: 'video', order: 0, clips: [] };
      const lastClip = track.clips[track.clips.length - 1];
      const start = lastClip ? lastClip.timelineOut : 0;
      const duration = asset.duration || 5;
      const newClip: ClipConfig = {
        id: `c${Date.now()}`, assetId: asset.id,
        src_range: { start: 0, end: duration },
        timelineIn: start, timelineOut: start + duration,
        transform: { x: 0.5, y: 0.5, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
        volume: 1, speed: 1,
        effects: [], masks: [], filters: [], keyframes: {},
      };
      return {
        ...p,
        tracks: [{ ...track, clips: [...track.clips, newClip] }],
      };
    });
  }, []);

  const handleRender = useCallback(async () => {
    const json = JSON.stringify(project);
    const result = await window.aicut.render(json);
    if (result.success && result.command) setRenderCmd(result.command);
  }, [project]);

  const selectedClip = project.tracks[0]?.clips.find(c => c.id === selectedClipId);

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui' }}>
      {/* Sidebar */}
      <aside style={{ width: 280, background: '#1a1a2e', color: '#eee', padding: 12, overflowY: 'auto' }}>
        <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>AIcut</h2>
        <button onClick={handleImport} style={btnStyle}>📁 导入素材</button>
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>素材库 ({project.assets.length})</h3>
          {project.assets.map(a => (
            <div key={a.id} onClick={() => handleAddToTimeline(a)}
                 style={{ padding: 6, margin: '4px 0', background: '#16213e', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
              {a.path.replace(/^.*[\\/]/, '')} ({a.width}x{a.height})
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>滤镜预置</h3>
          {presets.map(p => (
            <div key={p} style={{ padding: 4, fontSize: 12, color: '#aaa' }}>{p}</div>
          ))}
        </div>
        <button onClick={handleRender} style={{ ...btnStyle, marginTop: 16, background: '#e94560' }}>
          🎬 渲染导出
        </button>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Preview */}
        <div style={{ flex: 1, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
          <span style={{ color: '#555' }}>
            {renderCmd ? '✅ 命令已生成，在终端执行' : '预览区域 — 导入素材开始编辑'}
          </span>
        </div>

        {/* Timeline */}
        <div style={{ height: 200, background: '#16213e', borderTop: '2px solid #0f3460', padding: 8, overflowX: 'auto' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 12, color: '#aaa' }}>时间轴</h4>
          <div style={{ display: 'flex', gap: 4, height: 80, alignItems: 'center' }}>
            {(project.tracks[0]?.clips || []).map(c => {
              const asset = project.assets.find(a => a.id === c.assetId);
              const dur = c.timelineOut - c.timelineIn;
              return (
                <div key={c.id} onClick={() => setSelectedClipId(c.id)}
                     style={{
                       width: Math.max(dur * 40, 60), height: 60,
                       background: c.id === selectedClipId ? '#e94560' : '#0f3460',
                       borderRadius: 4, cursor: 'pointer', fontSize: 10,
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       color: '#fff', flexShrink: 0,
                     }}>
                  {asset?.path.replace(/^.*[\\/]/, '') || c.id}
                </div>
              );
            })}
          </div>
        </div>
      </main>

      {/* Properties Panel */}
      <aside style={{ width: 260, background: '#1a1a2e', color: '#eee', padding: 12, overflowY: 'auto' }}>
        <h3 style={{ fontSize: 13, margin: '0 0 12px' }}>属性面板</h3>
        {selectedClip ? (
          <div style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 8 }}>
              <label>不透明度</label>
              <input type="range" min={0} max={1} step={0.01}
                     value={selectedClip.transform?.opacity || 1}
                     onChange={e => {
                       const v = parseFloat(e.target.value);
                       setProject(p => ({
                         ...p, tracks: p.tracks.map(t => ({
                           ...t, clips: t.clips.map(c =>
                             c.id === selectedClipId ? { ...c, transform: { ...c.transform, opacity: v } } : c)
                         }))
                       }));
                     }}
                     style={{ width: '100%' }} />
              <span>{(selectedClip.transform?.opacity || 1).toFixed(2)}</span>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>缩放 X</label>
              <input type="range" min={0.1} max={3} step={0.01}
                     value={selectedClip.transform?.scale_x || 1}
                     onChange={e => {
                       const v = parseFloat(e.target.value);
                       setProject(p => ({
                         ...p, tracks: p.tracks.map(t => ({
                           ...t, clips: t.clips.map(c =>
                             c.id === selectedClipId ? { ...c, transform: { ...c.transform, scale_x: v, scale_y: v } } : c)
                         }))
                       }));
                     }}
                     style={{ width: '100%' }} />
              <span>{(selectedClip.transform?.scale_x || 1).toFixed(2)}</span>
            </div>
            <div>
              <label>速度</label>
              <input type="range" min={0.1} max={4} step={0.1}
                     value={selectedClip.speed || 1}
                     onChange={e => {
                       const v = parseFloat(e.target.value);
                       setProject(p => ({
                         ...p, tracks: p.tracks.map(t => ({
                           ...t, clips: t.clips.map(c =>
                             c.id === selectedClipId ? { ...c, speed: v } : c)
                         }))
                       }));
                     }}
                     style={{ width: '100%' }} />
              <span>{selectedClip.speed || 1}x</span>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#666' }}>
            画布: {project.canvas.width}x{project.canvas.height} @ {project.canvas.fps}fps<br/>
            素材: {project.assets.length} 个<br/>
            片段: {project.tracks[0]?.clips.length || 0} 个
          </div>
        )}
        {renderCmd && (
          <div style={{ marginTop: 12, padding: 8, background: '#16213e', borderRadius: 4, fontSize: 10, wordBreak: 'break-all' }}>
            <strong>FFmpeg 命令:</strong>
            <code style={{ display: 'block', marginTop: 4 }}>{renderCmd.substring(0, 200)}...</code>
          </div>
        )}
      </aside>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', background: '#0f3460', color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
};
