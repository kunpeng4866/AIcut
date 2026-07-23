// 预览画布 — WebGPU/HTML5 双路径视频预览 + 播放控制栏
// 多轨道叠加：查找 currentTime 下所有可见 video 轨道的活跃 clip，按 track.order 从底到顶叠加
// 音频轨道：独立 <audio> 元素播放，受静音/独奏控制（不受可见性影响）
// WebGPU 不可用时回退到 HTML5 video（渲染所有活跃视频轨道，按层级叠加）
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { useWebGPUPreview, type ActiveVideoClip } from './WebGPUPreview';
import type { ClipConfig, TrackConfig, AssetConfig } from '../types';

// 文件路径转 aicut-asset:// URL（绕过系统代理，修复 SSL handshake failed）
const pathToUrl = (path: string): string => {
  if (/^(https?|aicut-asset|blob):/.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  return `aicut-asset:///${normalized}`;
};

// 格式化时间码 mm:ss.cs
const formatTC = (sec: number): string => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
};

// 活跃音频片段（音频轨道上的 clip）
interface ActiveAudioClip { clip: ClipConfig; asset: AssetConfig; trackId: string }

const theme = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', background: '#000', fontFamily: 'system-ui' } as React.CSSProperties,
  stage: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' } as React.CSSProperties,
  video: { maxWidth: '100%', maxHeight: '100%' } as React.CSSProperties,
  canvas: { maxWidth: '100%', maxHeight: '100%', background: '#000' } as React.CSSProperties,
  hiddenMedia: { display: 'none' } as React.CSSProperties,
  placeholder: { color: '#555', fontSize: 14, textAlign: 'center' } as React.CSSProperties,
  controls: { height: 48, background: '#1a1a2e', borderTop: '1px solid #0f3460', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 10, flexShrink: 0 } as React.CSSProperties,
  btn: { background: 'none', border: 'none', color: '#eee', cursor: 'pointer', fontSize: 18, padding: 4, display: 'flex', alignItems: 'center' } as React.CSSProperties,
  timecode: { color: '#eee', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 140, textAlign: 'center' } as React.CSSProperties,
  progress: { flex: 1, height: 6, background: '#0f3460', borderRadius: 3, cursor: 'pointer', position: 'relative' } as React.CSSProperties,
  progressFill: { height: '100%', background: '#e94560', borderRadius: 3, transition: 'width 0.05s linear' } as React.CSSProperties,
  progressHandle: { position: 'absolute', width: 12, height: 12, background: '#eee', borderRadius: '50%', top: -3, transform: 'translateX(-50%)' } as React.CSSProperties,
  volume: { display: 'flex', alignItems: 'center', gap: 4 } as React.CSSProperties,
  volumeSlider: { width: 60, accentColor: '#e94560', cursor: 'pointer' } as React.CSSProperties,
};

export default function PreviewCanvas() {
  const project = useProjectStore((s) => s.project);
  const { currentTime, isPlaying, togglePlay, setCurrentTime } = useUIStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const [volume, setVolume] = useState(1);

  // WebGPU 可用性检测
  const webgpuAvailable = typeof navigator !== 'undefined' && !!(navigator as any).gpu;

  // 是否有轨道处于独奏状态
  const hasSolo = project.tracks.some(t => t.solo);

  // 判断轨道是否应该有音频输出
  // 层级关系仅指画面，音频不受层级影响，仅受左侧按钮（muted/solo）控制
  // 对于 video 轨道：隐藏应同时禁用音频（正确）
  // 对于 audio 轨道：visible 不影响播放（音频轨没有视觉内容，"隐藏"概念不适用）
  const trackHasAudio = (track: TrackConfig): boolean => {
    if (track.muted) return false;                     // 静音轨无声音
    if (hasSolo && !track.solo) return false;          // 独奏模式下，非独奏轨无声音
    if (track.type === 'video' && track.visible === false) return false;  // 视频轨隐藏→无声音
    // audio 轨道：visible 不影响播放，仅 muted/solo 控制
    return true;
  };

  // 查找 currentTime 下所有可见 video 轨道的活跃 clip
  // 渲染顺序：数组第一个 = 底层，最后一个 = 顶层
  // project.tracks 已由 sortTracks 排序（text→video→audio，video 内主轨最下）
  // filter 后 [video(非主), video(主)]，reverse 后 [video(主), video(非主)]
  // → 主轨在底层，上方轨在顶层 ✓
  // 注意：锁定轨道仍可播放，只是不能编辑
  const activeVideoClips: ActiveVideoClip[] = (() => {
    const tracks = project.tracks
      .filter((t) => t.type === 'video' && t.visible !== false)
      .reverse(); // 反转：主轨(底)在前，上方轨(顶)在后
    const result: ActiveVideoClip[] = [];
    for (const track of tracks) {
      const clip = track.clips.find((c) => currentTime >= c.timelineIn && currentTime < c.timelineOut);
      if (clip) {
        const asset = project.assets.find((a) => a.id === clip.assetId);
        if (asset) result.push({ clip, asset });
      }
    }
    return result;
  })();

  // 查找 currentTime 下所有 audio 轨道的活跃 clip
  // 注意：audio 轨道的 visible 不影响播放，仅 muted/solo 控制（通过 trackHasAudio）
  // 隐藏的音频轨仍会创建 <audio> 元素，但 trackHasAudio 会通过 muted/solo 控制是否出声
  const activeAudioClips: ActiveAudioClip[] = (() => {
    const tracks = project.tracks
      .filter((t) => t.type === 'audio');
    const result: ActiveAudioClip[] = [];
    for (const track of tracks) {
      const clip = track.clips.find((c) => currentTime >= c.timelineIn && currentTime < c.timelineOut);
      if (clip) {
        const asset = project.assets.find((a) => a.id === clip.assetId);
        if (asset) result.push({ clip, asset, trackId: track.id });
      }
    }
    return result;
  })();

  // 查找当前文字/字幕叠加层
  const activeTextOverlays: { text: string; style: React.CSSProperties }[] = (() => {
    const result: { text: string; style: React.CSSProperties }[] = [];
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (!(currentTime >= clip.timelineIn && currentTime < clip.timelineOut)) continue;
        if (clip.text) {
          const t = clip.text;
          result.push({
            text: t.content,
            style: {
              position: 'absolute', left: `${(t.x ?? 0.5) * 100}%`, top: `${(t.y ?? 0.5) * 100}%`,
              transform: 'translate(-50%, -50%)', color: t.color || '#fff',
              fontSize: t.fontSize || 48, fontFamily: t.fontFamily || 'system-ui',
              textAlign: (t.textAlign || 'center') as any, fontWeight: 'bold',
              pointerEvents: 'none', zIndex: 100, textShadow: '0 0 10px rgba(0,0,0,0.8)',
            },
          });
        }
        if (clip.subtitle) {
          const s = clip.subtitle;
          const offset = currentTime - clip.timelineIn;
          const item = s.items.find(i => offset >= i.start && offset < i.end);
          if (item) {
            const isCenter = s.position === 'center';
            result.push({
              text: item.text,
              style: {
                position: 'absolute', left: '50%',
                bottom: s.position === 'bottom' ? 40 : undefined,
                top: s.position === 'top' ? 40 : isCenter ? '50%' : undefined,
                transform: isCenter ? 'translate(-50%, -50%)' : 'translateX(-50%)',
                color: s.color || '#fff', fontSize: s.fontSize || 24,
                fontFamily: 'system-ui', textAlign: 'center' as any, pointerEvents: 'none', zIndex: 101,
                textShadow: '0 0 10px rgba(0,0,0,0.8)', maxWidth: '90%', whiteSpace: 'pre-wrap' as any,
                background: isCenter ? 'transparent' : 'rgba(0,0,0,0.5)',
                padding: isCenter ? 0 : '4px 16px', borderRadius: isCenter ? 0 : 4,
              },
            });
          }
        }
      }
    }
    return result;
  })();

  const hasContent = activeVideoClips.length > 0 || activeAudioClips.length > 0;

  // WebGPU 渲染 hook
  const { ready: gpuReady, error: gpuError } = useWebGPUPreview({
    canvasRef,
    videoRefs,
    canvasWidth: project.canvas.width,
    canvasHeight: project.canvas.height,
    clips: activeVideoClips,
    enabled: webgpuAvailable && activeVideoClips.length > 0,
  });

  // WebGPU 实际可用 = 检测到 navigator.gpu 且运行时无错误
  const useWebGPU = webgpuAvailable && !gpuError;

  // 渲染引擎状态标签
  const engineLabel = !webgpuAvailable ? 'HTML5' : gpuError ? 'HTML5 (fallback)' : gpuReady ? 'WebGPU' : 'WebGPU…';
  const engineColor = useWebGPU && gpuReady ? '#4caf50' : '#ff9800';

  // 工程总时长（所有片段的最大 timelineOut）
  const totalDuration = Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => c.timelineOut)));

  // ── RAF 全局时钟：isPlaying 时独立推进 currentTime，不依赖任何 video 元素 ──
  // 每个轨道完全独立播放，播放结束条件 = currentTime >= 总时长
  useEffect(() => {
    if (!isPlaying) return;
    let raf: number;
    let lastTs = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = (now - lastTs) / 1000;
      lastTs = now;
      const cur = useUIStore.getState().currentTime;
      const totalDur = Math.max(0, ...useProjectStore.getState().project.tracks.flatMap((t) => t.clips.map((c) => c.timelineOut)));
      const newTime = cur + dt;
      if (newTime >= totalDur) {
        setCurrentTime(totalDur);
        useUIStore.getState().togglePlay();
        return;
      }
      setCurrentTime(newTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); };
  }, [isPlaying, setCurrentTime]);

  // 播放/暂停：同步所有 video + audio 元素（每个轨道独立控制）
  useEffect(() => {
    activeVideoClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      if (isPlaying) v.play().catch(() => {});
      else v.pause();
    });
    activeAudioClips.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      if (isPlaying) a.play().catch(() => {});
      else a.pause();
    });
  }, [isPlaying, activeVideoClips, activeAudioClips]);

  // seek + 偏差修正：currentTime 变化时同步所有视频/音频源时间
  // 偏差阈值 0.3 秒 — 允许 video 自然播放，只在偏差过大时强制 seek
  useEffect(() => {
    activeVideoClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      const speed = clip.speed ?? 1.0;
      const targetTime = clip.src_range.start + (currentTime - clip.timelineIn) * speed;
      if (v.readyState >= 1 && Math.abs(v.currentTime - targetTime) > 0.3) {
        v.currentTime = Math.max(0, targetTime);
      }
    });
    activeAudioClips.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const speed = clip.speed ?? 1.0;
      const targetTime = clip.src_range.start + (currentTime - clip.timelineIn) * speed;
      if (a.readyState >= 1 && Math.abs(a.currentTime - targetTime) > 0.3) {
        a.currentTime = Math.max(0, targetTime);
      }
    });
  }, [currentTime, activeVideoClips, activeAudioClips]);

  // 音量：根据静音/独奏/隐藏状态设置每个元素的音量
  useEffect(() => {
    activeVideoClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      // 查找该 clip 所属的 track
      const track = project.tracks.find(t => t.clips.some(c => c.id === clip.id));
      if (!track) return;
      const shouldHaveAudio = trackHasAudio(track);
      v.volume = shouldHaveAudio ? volume * (clip.volume ?? 1) : 0;
    });
    activeAudioClips.forEach(({ clip, trackId }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const track = project.tracks.find(t => t.id === trackId);
      if (!track) return;
      const shouldHaveAudio = trackHasAudio(track);
      a.volume = shouldHaveAudio ? volume * (clip.volume ?? 1) : 0;
    });
  }, [volume, activeVideoClips, activeAudioClips, project.tracks, hasSolo]);

  // 视频元数据加载完成：seek 到正确位置 + 恢复播放
  const onLoadedMetadataFor = (clip: ClipConfig) => () => {
    const v = videoRefs.current.get(clip.id);
    if (!v) return;
    const speed = clip.speed ?? 1.0;
    const targetTime = clip.src_range.start + (currentTime - clip.timelineIn) * speed;
    v.currentTime = Math.max(0, Math.min(v.duration || targetTime, targetTime));
    if (useUIStore.getState().isPlaying) v.play().catch(() => {});
  };

  // 音频元数据加载完成
  const onLoadedMetadataForAudio = (clip: ClipConfig) => () => {
    const a = audioRefs.current.get(clip.id);
    if (!a) return;
    const speed = clip.speed ?? 1.0;
    const targetTime = clip.src_range.start + (currentTime - clip.timelineIn) * speed;
    a.currentTime = Math.max(0, Math.min(a.duration || targetTime, targetTime));
    if (useUIStore.getState().isPlaying) a.play().catch(() => {});
  };

  const handleTogglePlay = useCallback(() => { togglePlay(); }, [togglePlay]);

  // 进度条点击/拖拽跳转
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setCurrentTime(ratio * (totalDuration || 1));
  };

  // 音量变化
  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(parseFloat(e.target.value));
  };

  // 进度百分比
  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div style={theme.root}>
      {/* 舞台：视频画面 */}
      <div style={theme.stage}>
        {activeVideoClips.length > 0 ? (
          useWebGPU ? (
            <>
              {/* 隐藏 video：每个活跃 clip 一个，负责解码+音频 */}
              {activeVideoClips.map(({ clip, asset }) => (
                <video
                  key={clip.id}
                  ref={(el) => { if (el) videoRefs.current.set(clip.id, el); else videoRefs.current.delete(clip.id); }}
                  src={pathToUrl(asset.path)}
                  style={theme.hiddenMedia}
                  onLoadedMetadata={onLoadedMetadataFor(clip)}
                />
              ))}
              {/* 可见 canvas：WebGPU 渲染 */}
              <canvas ref={canvasRef} style={theme.canvas} onClick={handleTogglePlay} />
            </>
          ) : (
            <>
              {/* HTML5 回退：渲染所有活跃视频轨道，按层级叠加 */}
              {/* activeVideoClips: index 0 = 底层(主轨)，最后一个 = 顶层 */}
              {/* zIndex 从 0 开始递增，确保顶层覆盖底层 */}
              {activeVideoClips.map(({ clip, asset }, idx) => (
                <video
                  key={clip.id}
                  ref={(el) => { if (el) videoRefs.current.set(clip.id, el); else videoRefs.current.delete(clip.id); }}
                  src={pathToUrl(asset.path)}
                  style={{
                    position: idx === 0 ? 'relative' : 'absolute',
                    maxWidth: '100%', maxHeight: '100%',
                    zIndex: idx,  // 底层 idx=0，顶层 idx=最大
                    top: 0, left: 0,
                  }}
                  onLoadedMetadata={onLoadedMetadataFor(clip)}
                  onClick={handleTogglePlay}
                />
              ))}
            </>
          )
        ) : activeAudioClips.length > 0 ? (
          // 仅有音频，无视频画面
          <div style={theme.placeholder}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🔊</div>
            <div>音频播放中</div>
          </div>
        ) : (
          <div style={theme.placeholder}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🎬</div>
            <div>选择时间轴片段以预览</div>
          </div>
        )}

        {/* 文字/字幕叠加层 */}
        {activeTextOverlays.map((item, idx) => (
          <div key={idx} style={item.style}>{item.text}</div>
        ))}

        {/* 隐藏 audio：每个活跃音频 clip 一个 */}
        {activeAudioClips.map(({ clip, asset }) => (
          <audio
            key={clip.id}
            ref={(el) => { if (el) audioRefs.current.set(clip.id, el); else audioRefs.current.delete(clip.id); }}
            src={pathToUrl(asset.path)}
            style={theme.hiddenMedia}
            onLoadedMetadata={onLoadedMetadataForAudio(clip)}
          />
        ))}

        {/* 渲染引擎浮动徽标（右上角） */}
        {hasContent && (
          <div style={{
            position: 'absolute', top: 8, right: 8,
            fontSize: 12, fontWeight: 700, color: engineColor,
            padding: '4px 10px', borderRadius: 6,
            background: 'rgba(0,0,0,0.7)',
            border: `1px solid ${engineColor}`,
            fontFamily: 'monospace', whiteSpace: 'nowrap',
            pointerEvents: 'none', zIndex: 10,
          }}>
            {engineLabel}
            {hasSolo && <span style={{ color: '#ff9800', marginLeft: 6 }}>🎤 SOLO</span>}
          </div>
        )}
      </div>

      {/* 播放控制栏 */}
      <div style={theme.controls}>
        <button style={theme.btn} onClick={handleTogglePlay} title={isPlaying ? '暂停' : '播放'}>
          {isPlaying ? '⏸' : '▶'}
        </button>

        <div style={theme.timecode}>
          {formatTC(currentTime)} / {formatTC(totalDuration)}
        </div>

        {/* 进度条 */}
        <div style={theme.progress} onClick={handleSeek}>
          <div style={{ ...theme.progressFill, width: `${progress}%` }} />
          <div style={{ ...theme.progressHandle, left: `${progress}%` }} />
        </div>

        {/* 音量 */}
        <div style={theme.volume}>
          <span style={{ fontSize: 14 }}>🔊</span>
          <input type="range" min={0} max={1} step={0.01} value={volume}
            onChange={handleVolume} style={theme.volumeSlider} />
        </div>

        {/* 渲染引擎状态 */}
        <div style={{
          fontSize: 11, color: engineColor, fontWeight: 600,
          padding: '2px 8px', borderRadius: 4,
          background: engineColor === '#4caf50' ? 'rgba(76,175,80,0.15)' : 'rgba(255,152,0,0.15)',
          border: `1px solid ${engineColor}40`,
          fontFamily: 'monospace', whiteSpace: 'nowrap',
        }}>
          {engineLabel}
        </div>
      </div>
    </div>
  );
}
