// 预览画布 — WebGPU/HTML5 双路径视频预览 + 播放控制栏
// 多轨道叠加：查找 currentTime 下所有可见 video 轨道的活跃 clip，按 track.order 从底到顶叠加
// 音频轨道：独立 <audio> 元素播放，受静音/独奏控制（不受可见性影响）
// WebGPU 不可用时回退到 HTML5 video（渲染所有活跃视频轨道，按层级叠加）
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { useWebGPUPreview, type ActiveVideoClip } from './WebGPUPreview';
import type { ClipConfig, TrackConfig, AssetConfig, SpeedPointConfig } from '../types';
import { rawSpeedIntegral, rawSpeedAt } from '../utils/speedCurve';

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

// 曲线是否含 0 速度关键帧（→ 有冻结段，无法仅用 playbackRate 表达，需逐帧 seek）
function curveHasZeroSpeed(curve: SpeedPointConfig[]): boolean {
  if (!curve || curve.length === 0) return false;
  return curve.some((p) => p.speed <= 0.001);
}

// 非手动驱动片段在播放头 t 处应使用的 playbackRate：
// 变速曲线 → 当前 play 偏移处的瞬时「绝对速度」（用户设定值，让 video 自播放、动态调速，避免逐帧 seek 卡顿）；
// 恒定/普通 → 整体速度 srcDur/dur。统一 clamp 到浏览器支持的 [0.0625, 16]。
// 注意：曲线绝对积分已由 store.setCurveCommit 反推片段时长，使 ∫₀^dur speed dτ = srcDur，
// 故此处直接用绝对速度作为 playbackRate，2.0 即真实 2×，无需再乘归一化系数。
function effectiveRate(clip: ClipConfig, t: number): number {
  const dur = clip.timelineOut - clip.timelineIn;
  if (dur < 1e-6) return 1;
  const srcDur = clip.src_range.end - clip.src_range.start;
  const off = (t - clip.timelineIn) / dur; // 归一化 [0,1]
  const curve = clip.time_remap?.curve;
  const r = curve && curve.length > 0
    ? rawSpeedAt(curve, off)
    : srcDur / dur;
  if (!isFinite(r) || r <= 0) return 1;
  return Math.max(0.0625, Math.min(16, r));
}

// 统一时间重映射：与后端 Rust clip_source_time 逐字节一致的纯函数
// 给定全局时间线时间 t 与 clip，返回素材源时间 srcT 及是否处于冻结帧
function clipSourceTime(t: number, clip: ClipConfig): { srcT: number; frozen: boolean } {
  const dur = clip.timelineOut - clip.timelineIn;
  const off = t - clip.timelineIn;                  // 绝对偏移（秒）
  const offNorm = dur > 1e-6 ? off / dur : 0;        // 归一化 [0,1]（供曲线积分与冻结窗口判断）
  const remap = clip.time_remap ?? { reverse: false, freeze: null, curve: [] as SpeedPointConfig[] };
  const clamp = (x: number) => Math.max(clip.src_range.start, Math.min(clip.src_range.end, x));
  if (remap.curve && remap.curve.length > 0) {
    // 绝对速度曲线积分（play 归一化 [0,1]）：srcT = src_start + dur * ∫₀^offNorm speed(τ) dτ
    const srcT = clip.src_range.start + dur * rawSpeedIntegral(remap.curve, offNorm);
    return { srcT: clamp(srcT), frozen: false };
  }
  let frozen = false; let srcT: number;
  // 冻结窗口判断：与后端 base_source_time 一致，用绝对偏移 off（freeze.start/duration 为绝对秒，见 PropertiesPanel 输入）
  if (remap.freeze && off >= remap.freeze.start && off < remap.freeze.start + remap.freeze.duration) {
    srcT = remap.freeze.sourceTime; frozen = true;
  } else {
    const speed = clip.speed ?? 1;
    // 普通/倒放：与后端 base_source_time 完全一致——用绝对偏移 off 乘 speed，覆盖整段素材（而非归一化值）
    srcT = remap.reverse
      ? clip.src_range.start + (dur - off) * speed
      : clip.src_range.start + off * speed;
  }
  return { srcT: clamp(srcT), frozen };
}

// 该 clip 是否必须手动驱动（pause + 逐帧 seek），而非依赖 <video>/<audio> 自播放。
// 只有 倒放 / 冻结帧 / 含 0 速度的曲线 无法用 playbackRate 表达，必须由 RAF 时钟逐帧 seek 到 srcT。
// 变速曲线（所有 speed>0，仅速率变化）改用「自播放 + 每帧动态 playbackRate」——
// HTML5 逐帧 seek 跟不上高速播放会掉帧/卡住，而 playbackRate 可在播放中随时调速、平滑不掉帧。
function clipNeedsManualDrive(clip: ClipConfig): boolean {
  const remap = clip.time_remap;
  if (!remap) return false;
  if (remap.reverse || remap.freeze) return true;
  if (remap.curve && remap.curve.length > 0 && curveHasZeroSpeed(remap.curve)) return true;
  return false;
}

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
          // 字幕时间戳与音视频源时间一致：使用同一份 clipSourceTime 映射（含倒放/冻结/曲线）
          const { srcT: offset } = clipSourceTime(currentTime, clip);
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

  // 播放/暂停：time_remap 片段必须 pause 由 RAF 逐帧 seek 驱动；
  // 普通正放 speed≠1 用 playbackRate 自播放保流畅；speed=1 直接自播放。
  // 不对手动驱动片段调用 play()，否则自播放与手动 seek 互掐导致卡顿/反复。
  useEffect(() => {
    activeVideoClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      if (clipNeedsManualDrive(clip)) { v.pause(); return; }
      // 自播放：用当前播放头处的瞬时有效速率（变速曲线会动态变化，见 seek effect 每帧更新）
      v.playbackRate = effectiveRate(clip, currentTime);
      if (isPlaying) v.play().catch(() => {});
      else v.pause();
    });
    activeAudioClips.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      if (clipNeedsManualDrive(clip)) { a.pause(); return; }
      a.playbackRate = effectiveRate(clip, currentTime);
      if (isPlaying) a.play().catch(() => {});
      else a.pause();
    });
  }, [isPlaying, activeVideoClips, activeAudioClips]);

  // seek 同步：currentTime 变化时同步所有视频/音频源时间
  //  - 手动驱动片段（time_remap）：每帧按 currentTime 设源时间，!seeking 防止 seek 请求堆积，
  //    连续呈现倒放/冻结/曲线映射（video 已被 pause，不会自播放与之互掐）
  //  - 自播放片段（正放）：仅偏差 >0.3s 时纠正，允许 video 自然播放
  useEffect(() => {
    activeVideoClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      const { srcT: targetTime } = clipSourceTime(currentTime, clip);
      if (clipNeedsManualDrive(clip)) {
        if (v.readyState >= 1 && !v.seeking) v.currentTime = Math.max(0, targetTime);
      } else {
        // 自播放：每帧把 playbackRate 更新为当前瞬时有效速率（变速曲线动态调速、平滑不掉帧），
        // 位置偏差 >0.3 才纠正 seek（速率跟踪良好时几乎不触发）
        v.playbackRate = effectiveRate(clip, currentTime);
        if (v.readyState >= 1 && Math.abs(v.currentTime - targetTime) > 0.3) v.currentTime = Math.max(0, targetTime);
      }
    });
    activeAudioClips.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const { srcT: targetTime } = clipSourceTime(currentTime, clip);
      if (clipNeedsManualDrive(clip)) {
        if (a.readyState >= 1 && !a.seeking) a.currentTime = Math.max(0, targetTime);
      } else {
        a.playbackRate = effectiveRate(clip, currentTime);
        if (a.readyState >= 1 && Math.abs(a.currentTime - targetTime) > 0.3) a.currentTime = Math.max(0, targetTime);
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
      const { frozen } = clipSourceTime(currentTime, clip);
      v.volume = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) : 0;
    });
    activeAudioClips.forEach(({ clip, trackId }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const track = project.tracks.find(t => t.id === trackId);
      if (!track) return;
      const shouldHaveAudio = trackHasAudio(track);
      const { frozen } = clipSourceTime(currentTime, clip);
      a.volume = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) : 0;
    });
  }, [volume, activeVideoClips, activeAudioClips, project.tracks, hasSolo, currentTime]);

  // 视频元数据加载完成：seek 到正确位置 + 恢复播放
  const onLoadedMetadataFor = (clip: ClipConfig) => () => {
    const v = videoRefs.current.get(clip.id);
    if (!v) return;
    const { srcT: targetTime } = clipSourceTime(currentTime, clip);
    v.currentTime = Math.max(0, Math.min(v.duration || targetTime, targetTime));
    // 手动驱动片段（time_remap）不 play()，交由 RAF 逐帧 seek
    if (!clipNeedsManualDrive(clip) && useUIStore.getState().isPlaying) v.play().catch(() => {});
  };

  // 音频元数据加载完成
  const onLoadedMetadataForAudio = (clip: ClipConfig) => () => {
    const a = audioRefs.current.get(clip.id);
    if (!a) return;
    const { srcT: targetTime } = clipSourceTime(currentTime, clip);
    a.currentTime = Math.max(0, Math.min(a.duration || targetTime, targetTime));
    if (!clipNeedsManualDrive(clip) && useUIStore.getState().isPlaying) a.play().catch(() => {});
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
