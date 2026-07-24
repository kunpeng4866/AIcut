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
import { ClipFrameCache, isRVFCSupported } from '../utils/frameCache';
import { computeOutClipOpacity, getIncomingTransitionLayer, getOutClipTransition, getOutClipAudioEnv, getIncomingAudioTransitionLayer, audioCrossfadeEnv, getClipEnvelopeGain, type TransitionPreviewLayer } from '../utils/transitionUtils';

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

// 保音高变速（time-stretch）：设置 HTMLMediaElement.preservesPitch = true，
// 浏览器会补偿 playbackRate 变化引起的音高偏移 → 变速不变调，与后端重采样导出一致。
// 规范默认虽为 true，但历史上部分引擎默认 false，故显式设置以保证确定性。
// 包含 Safari <17.2 (webkit) / Firefox <101 (moz) 前缀，缺失属性赋值无害。
function applyPreservesPitch(el: HTMLMediaElement) {
  el.preservesPitch = true;
  (el as any).webkitPreservesPitch = true; // Safari <17.2
  (el as any).mozPreservesPitch = true;    // Firefox <101（缺失则无害）
}

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
// 非冻结段的有效偏移：从片段起点到 t 之间、扣除「冻结窗口已流逝时间」后的播放时间。
// 与后端 strategy.rs::effective_off 逐字节一致：退出冻结时源时间从 freeze.sourceTime 平滑继续，
// 不再突跳 freeze.duration 秒；完整素材在「前端计入 freeze.duration 的延长 timelineOut」内播完。
function frozenElapsed(freeze: { start: number; duration: number } | null, off: number): number {
  if (!freeze) return 0;
  if (off <= freeze.start) return 0;
  if (off >= freeze.start + freeze.duration) return freeze.duration;
  return off - freeze.start;
}

function clipSourceTime(t: number, clip: ClipConfig): { srcT: number; frozen: boolean } {
  const dur = clip.timelineOut - clip.timelineIn;
  const off = t - clip.timelineIn;                  // 绝对偏移（秒）
  const offNorm = dur > 1e-6 ? off / dur : 0;        // 归一化 [0,1]（供曲线积分与冻结窗口判断）
  const remap = clip.time_remap ?? { reverse: false, freeze: null, curve: [] as SpeedPointConfig[] };
  const clamp = (x: number) => Math.max(clip.src_range.start, Math.min(clip.src_range.end, x));
  if (remap.curve && remap.curve.length > 0) {
    // 绝对速度曲线积分（play 归一化 [0,1]）：srcT = src_start + dur * ∫₀^offNorm speed(τ) dτ
    const srcT = clip.src_range.start + dur * rawSpeedIntegral(remap.curve, offNorm);
    // 零速曲线定格段：该处瞬时 speed≈0 → 与冻结一致，定格+静音；其它段正常自播放出声
    const speed = rawSpeedAt(remap.curve, offNorm);
    return { srcT: clamp(srcT), frozen: speed < 1e-4 };
  }
  let frozen = false; let srcT: number;
  // 冻结窗口判断：与后端 base_source_time 一致，用绝对偏移 off（freeze.start/duration 为绝对秒，见 PropertiesPanel 输入）
  if (remap.freeze && off >= remap.freeze.start && off < remap.freeze.start + remap.freeze.duration) {
    srcT = remap.freeze.sourceTime; frozen = true;
  } else {
    const speed = clip.speed ?? 1;
    // 普通/倒放：与后端 base_source_time 完全一致——用「有效偏移」(扣除冻结已流逝) 乘 speed，
    // 覆盖整段素材（而非归一化值）。冻结窗口之外按有效偏移推进，退出冻结平滑无跳变。
    const effOff = off - frozenElapsed(remap.freeze ?? null, off);
    srcT = remap.reverse
      ? clip.src_range.start + (dur - effOff) * speed
      : clip.src_range.start + effOff * speed;
  }
  return { srcT: clamp(srcT), frozen };
}

// 该 clip 在时刻 t 是否必须手动驱动（pause + 逐帧 seek），而非依赖 <video>/<audio> 自播放。
// 仅 倒放 / 当前处于冻结窗口 / 曲线当前处于零速（定格）段 需手动驱动：这些无法用 playbackRate 表达，必须逐帧 seek 到 srcT。
// 零速曲线片段中 speed>0 的段与冻结片段的「非冻结段」一律自播放——视频正常、音频也正常出声；
// 只有真正处于定格的瞬间才暂停+seek（画面定格、且音频随暂停静音）。
// 注：定格段（冻结窗口 / 零速曲线段）的静音音量已由 volume effect 依据 clipSourceTime().frozen 处理。
function clipNeedsManualDrive(clip: ClipConfig, t: number): boolean {
  const remap = clip.time_remap;
  if (!remap) return false;
  if (remap.reverse) return true;                          // 倒放整段手动（已确认倒放静音即可）
  if (remap.freeze) {                                      // 仅冻结窗口内手动；窗口外自播放+音频
    const off = t - clip.timelineIn;
    return off >= remap.freeze.start && off < remap.freeze.start + remap.freeze.duration;
  }
  if (remap.curve && remap.curve.length > 0) {
    // 仅零速（定格）段手动驱动（pause+逐帧seek+静音）；speed>0 段自播放+出声。
    // 删除原整段 curveHasZeroSpeed → return true（会导致整段静音），改为按当前 t 的瞬时速度判断。
    const d = clip.timelineOut - clip.timelineIn;
    const offNorm = d > 1e-6 ? (t - clip.timelineIn) / d : 0;
    return rawSpeedAt(remap.curve, offNorm) < 1e-4;
  }
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
  const stageRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(1);

  // 手动驱动片段（倒放/冻结/零速曲线）的预解码帧缓存：播放时按源时间直接取帧，绕开每帧 seek
  const cacheMap = useRef<Map<string, ClipFrameCache>>(new Map());
  const bitmapSources = useRef<Map<string, ImageBitmap | null>>(new Map());

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

  // 查找每个活跃"出片段"在转场窗内的入片段层（同轨下一片段），供实时预览叠加。
  // 与 activeVideoClips 同源（同一可见 video 轨反转序列），故第 i 个层对应第 i 个活跃片段。
  const activeTransitionLayers: { layer: TransitionPreviewLayer; asset: AssetConfig; outClip: ClipConfig }[] = (() => {
    const tracks = project.tracks
      .filter((t) => t.type === 'video' && t.visible !== false)
      .reverse(); // 与 activeVideoClips 一致：主轨在前
    const result: { layer: TransitionPreviewLayer; asset: AssetConfig; outClip: ClipConfig }[] = [];
    for (const track of tracks) {
      const clip = track.clips.find((c) => currentTime >= c.timelineIn && currentTime < c.timelineOut);
      if (!clip) continue;
      const layer = getIncomingTransitionLayer(track, clip, currentTime);
      if (!layer) continue;
      const asset = project.assets.find((a) => a.id === layer.clip.assetId);
      if (asset) result.push({ layer, asset, outClip: clip });
    }
    return result;
  })();

  // 传给 WebGPU 预览 hook 的转场入片段信息（已算好 opacity / slide 偏移）
  const transitionIncoming = activeTransitionLayers.map(({ layer, outClip }) => ({
    outClipId: outClip.id,
    clip: layer.clip,
    opacity: layer.opacity,
    offsetX: layer.offsetX,
    clipPath: layer.clipPath,
    maskRect: layer.maskRect,
    direction: layer.direction,
  }));

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

  // 转场窗内的"入片段"音频（同轨下一片段），在窗内尚未活跃，需单独渲染并定位其音频
  const activeAudioTransitionIn: { clip: ClipConfig; asset: AssetConfig; trackId: string; progress: number }[] = (() => {
    const result: { clip: ClipConfig; asset: AssetConfig; trackId: string; progress: number }[] = [];
    for (const track of project.tracks.filter((t) => t.type === 'audio')) {
      const out = track.clips.find((c) => currentTime >= c.timelineIn && currentTime < c.timelineOut);
      if (!out) continue;
      const inc = getIncomingAudioTransitionLayer(track, out, currentTime);
      if (inc) {
        const asset = project.assets.find((a) => a.id === inc.inClip.assetId);
        if (asset) result.push({ clip: inc.inClip, asset, trackId: track.id, progress: inc.progress });
      }
    }
    return result;
  })();

  // 查找当前文字/字幕叠加层
  const activeTextOverlays: { text: string; kind: 'text' | 'subtitle'; trackId: string; clipId: string; style: React.CSSProperties }[] = (() => {
    const result: { text: string; kind: 'text' | 'subtitle'; trackId: string; clipId: string; style: React.CSSProperties }[] = [];
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (!(currentTime >= clip.timelineIn && currentTime < clip.timelineOut)) continue;
        if (clip.text) {
          const t = clip.text;
          result.push({
            text: t.content,
            kind: 'text',
            trackId: track.id,
            clipId: clip.id,
            style: {
              position: 'absolute', left: `${(t.x ?? 0.5) * 100}%`, top: `${(t.y ?? 0.5) * 100}%`,
              transform: 'translate(-50%, -50%)', color: t.color || '#fff',
              fontSize: t.fontSize || 48, fontFamily: t.fontFamily || 'system-ui',
              textAlign: (t.textAlign || 'center') as any, fontWeight: 'bold',
              pointerEvents: 'auto', cursor: 'pointer', zIndex: 100, textShadow: '0 0 10px rgba(0,0,0,0.8)',
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
              kind: 'subtitle',
              trackId: track.id,
              clipId: clip.id,
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

  // 查找当前贴纸（sticker 轨）图片叠加层：跨 WebGPU/HTML5 通用（DOM <img> 模式无关）
  const activeStickerOverlays: { src: string; style: React.CSSProperties }[] = (() => {
    const result: { src: string; style: React.CSSProperties }[] = [];
    const stageW = project.canvas?.width || 1920;
    for (const track of project.tracks) {
      if (track.type !== 'sticker') continue;
      for (const clip of track.clips) {
        if (!(currentTime >= clip.timelineIn && currentTime < clip.timelineOut)) continue;
        const asset = project.assets.find((a) => a.id === clip.assetId);
        if (!asset) continue;
        const t = clip.transform || {};
        const x = t.x ?? 0.5;
        const y = t.y ?? 0.5;
        const scale = t.scale_x ?? 1;
        const wPct = Math.min(80, ((asset.width || 300) / stageW) * 100) * scale;
        result.push({
          src: pathToUrl(asset.path),
          style: {
            position: 'absolute',
            left: `${x * 100}%`,
            top: `${y * 100}%`,
            transform: `translate(-50%, -50%) rotate(${(((t.rotation ?? 0) * Math.PI) / 180)}rad) scale(${scale})`,
            width: `${wPct}%`,
            height: 'auto',
            opacity: t.opacity ?? 1,
            objectFit: 'contain',
            pointerEvents: 'none',
            zIndex: 99,
          },
        });
      }
    }
    return result;
  })();

  const hasContent = activeVideoClips.length > 0 || activeAudioClips.length > 0;

  // 插件清单（含预览用 shader），供 WebGPU 预览应用滤镜。仅 WebGPU 路径使用；
  // HTML5 回退无法跑 WGSL，天然不显示插件滤镜（导出仍走 filter_spec 生效）。
  const [pluginManifests, setPluginManifests] = useState<Record<string, any>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api = (window as any).aicut;
        if (!api || typeof api.listPlugins !== 'function') return;
        const raw = api.listPlugins();
        const list: any = raw instanceof Promise ? await raw : raw;
        const arr: any[] = typeof list === 'string' ? JSON.parse(list) : (Array.isArray(list) ? list : []);
        const map: Record<string, any> = {};
        for (const m of arr) if (m && m.id) map[m.id] = m;
        if (!cancelled) setPluginManifests(map);
      } catch {
        /* 预览无滤镜而已，忽略 */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 计算 clip 的 CSS filter 预览（HTML5 回退路径用）。插件声明 css_filter 模板（含 {key} 占位）时生效；
  // 多个启用的 css_filter 插件用空格拼接。导出仍走精确的 filter_spec，此处仅做轻量预览近似。
  const computeCssFilter = (clip: any): string | undefined => {
    const map = pluginManifests;
    const parts: string[] = [];
    for (const f of (clip?.filters || []) as any[]) {
      if (!f || !f.enabled || !f.kind) continue;
      const m = map[f.kind];
      if (!m || !m.css_filter) continue;
      let expr = m.css_filter as string;
      for (const p of (m.parameters || []) as any[]) {
        const raw = f.params ? f.params[p.key] : undefined;
        const val = (raw === undefined || raw === null) ? (p.default ?? 0) : raw;
        expr = expr.split('{' + p.key + '}').join(String(val));
      }
      parts.push(expr);
    }
    return parts.length ? parts.join(' ') : undefined;
  };

  // WebGPU 渲染 hook
  const { ready: gpuReady, error: gpuError } = useWebGPUPreview({
    canvasRef,
    videoRefs,
    bitmapSources,
    canvasWidth: project.canvas.width,
    canvasHeight: project.canvas.height,
    clips: activeVideoClips,
    enabled: webgpuAvailable && activeVideoClips.length > 0,
    pluginManifests,
    currentTime,
    transitionIncoming,
  });

  // 是否有手动驱动片段正在后台预解码（用于"解码中"提示）
  const decoding = activeVideoClips.some(({ clip }) => {
    const c = cacheMap.current.get(clip.id);
    return !!c && c.status === 'decoding';
  }) || activeTransitionLayers.some(({ layer }) => {
    const c = cacheMap.current.get(layer.clip.id);
    return !!c && c.status === 'decoding';
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
      applyPreservesPitch(v); // 保音高变速（变速不变调），重复设置无害
      if (clipNeedsManualDrive(clip, currentTime)) { v.pause(); return; }
      // 自播放：用当前播放头处的瞬时有效速率（变速曲线会动态变化，见 seek effect 每帧更新）
      v.playbackRate = effectiveRate(clip, currentTime);
      if (isPlaying) v.play().catch(() => {});
      else v.pause();
    });
    activeTransitionLayers.forEach(({ layer }) => {
      const v = videoRefs.current.get(layer.clip.id);
      if (!v) return;
      applyPreservesPitch(v); // 保音高变速（变速不变调），重复设置无害
      if (clipNeedsManualDrive(layer.clip, currentTime)) { v.pause(); return; }
      v.playbackRate = effectiveRate(layer.clip, currentTime);
      if (isPlaying) v.play().catch(() => {});
      else v.pause();
    });
    activeAudioClips.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      applyPreservesPitch(a); // 保音高变速（变速不变调），重复设置无害
      if (clipNeedsManualDrive(clip, currentTime)) { a.pause(); return; }
      a.playbackRate = effectiveRate(clip, currentTime);
      if (isPlaying) a.play().catch(() => {});
      else a.pause();
    });
    activeAudioTransitionIn.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      applyPreservesPitch(a); // 保音高变速（变速不变调），重复设置无害
      if (clipNeedsManualDrive(clip, currentTime)) { a.pause(); return; }
      a.playbackRate = effectiveRate(clip, currentTime);
      if (isPlaying) a.play().catch(() => {});
      else a.pause();
    });
  }, [isPlaying, activeVideoClips, activeAudioClips, activeTransitionLayers, activeAudioTransitionIn]);

  // seek 同步：currentTime 变化时同步所有视频/音频源时间
  //  - 手动驱动片段（time_remap）：每帧按 currentTime 设源时间，!seeking 防止 seek 请求堆积，
  //    连续呈现倒放/冻结/曲线映射（video 已被 pause，不会自播放与之互掐）
  //  - 自播放片段（正放）：仅偏差 >0.3s 时纠正，允许 video 自然播放
  useEffect(() => {
    activeVideoClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      const { srcT: targetTime } = clipSourceTime(currentTime, clip);
      if (clipNeedsManualDrive(clip, currentTime)) {
        if (v.readyState >= 1 && !v.seeking) v.currentTime = Math.max(0, targetTime);
      } else {
        // 自播放：每帧把 playbackRate 更新为当前瞬时有效速率（变速曲线动态调速、平滑不掉帧），
        // 位置偏差 >0.3 才纠正 seek（速率跟踪良好时几乎不触发）
        v.playbackRate = effectiveRate(clip, currentTime);
        if (v.readyState >= 1 && Math.abs(v.currentTime - targetTime) > 0.3) v.currentTime = Math.max(0, targetTime);
      }
    });
    activeTransitionLayers.forEach(({ layer }) => {
      const v = videoRefs.current.get(layer.clip.id);
      if (!v) return;
      const { srcT: targetTime } = clipSourceTime(currentTime, layer.clip);
      if (clipNeedsManualDrive(layer.clip, currentTime)) {
        if (v.readyState >= 1 && !v.seeking) v.currentTime = Math.max(0, targetTime);
      } else {
        v.playbackRate = effectiveRate(layer.clip, currentTime);
        if (v.readyState >= 1 && Math.abs(v.currentTime - targetTime) > 0.3) v.currentTime = Math.max(0, targetTime);
      }
    });
    activeAudioClips.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const { srcT: targetTime } = clipSourceTime(currentTime, clip);
      if (clipNeedsManualDrive(clip, currentTime)) {
        if (a.readyState >= 1 && !a.seeking) a.currentTime = Math.max(0, targetTime);
      } else {
        a.playbackRate = effectiveRate(clip, currentTime);
        if (a.readyState >= 1 && Math.abs(a.currentTime - targetTime) > 0.3) a.currentTime = Math.max(0, targetTime);
      }
    });
    activeAudioTransitionIn.forEach(({ clip, progress }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      // 相邻：入片段起点 + progress·duration·speed；重叠：用 clipSourceTime
      const tr = clip.transition;
      const dur = tr?.duration && tr.duration > 0 ? tr.duration : 0.5;
      let targetTime: number;
      if (currentTime < clip.timelineIn) {
        // 入片段在转场窗内尚未"活跃"，按转场进度定位源位置
        targetTime = clip.src_range.start + progress * dur * (clip.speed ?? 1);
      } else {
        // 重叠：入片段已活跃，按普通时间重映射
        targetTime = clipSourceTime(currentTime, clip).srcT;
      }
      targetTime = Math.max(0, targetTime);
      if (clipNeedsManualDrive(clip, currentTime)) {
        if (a.readyState >= 1 && !a.seeking) a.currentTime = targetTime;
      } else {
        a.playbackRate = effectiveRate(clip, currentTime);
        if (a.readyState >= 1 && Math.abs(a.currentTime - targetTime) > 0.3) a.currentTime = targetTime;
      }
    });
  }, [currentTime, activeVideoClips, activeAudioClips, activeTransitionLayers, activeAudioTransitionIn]);

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
      v.volume = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) * getClipEnvelopeGain(clip, currentTime) : 0;
    });
    activeTransitionLayers.forEach(({ layer, outClip }) => {
      const v = videoRefs.current.get(layer.clip.id);
      if (!v) return;
      const track = project.tracks.find(t => t.clips.some(c => c.id === layer.clip.id));
      if (!track) return;
      const shouldHaveAudio = trackHasAudio(track);
      const { frozen } = clipSourceTime(currentTime, layer.clip);
      // 视频转场入片段：音频按 equal-power 淡入包络
      const inEnv = getIncomingAudioTransitionLayer(track, outClip, currentTime)?.progress ?? 1;
      const env = inEnv > 1 ? 1 : audioCrossfadeEnv(inEnv < 0 ? 0 : inEnv).inEnv;
      v.volume = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (layer.clip.volume ?? 1) * env * getClipEnvelopeGain(layer.clip, currentTime) : 0;
    });
    activeAudioClips.forEach(({ clip, trackId }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const track = project.tracks.find(t => t.id === trackId);
      if (!track) return;
      const shouldHaveAudio = trackHasAudio(track);
      const { frozen } = clipSourceTime(currentTime, clip);
      // 出片段在转场窗内乘音频包络（cos 淡出），窗外=1；再乘音频包络线增益
      a.volume = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) * getOutClipAudioEnv(clip, currentTime) * getClipEnvelopeGain(clip, currentTime) : 0;
    });
    // 转场窗内"入片段"音频（同轨下一片段，提前淡入）：equal-power 淡入包络；再乘音频包络线增益
    activeAudioTransitionIn.forEach(({ clip, trackId, progress }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const track = project.tracks.find(t => t.id === trackId);
      if (!track) return;
      const shouldHaveAudio = trackHasAudio(track);
      const { frozen } = clipSourceTime(currentTime, clip);
      const inEnv = audioCrossfadeEnv(progress).inEnv;
      a.volume = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) * inEnv * getClipEnvelopeGain(clip, currentTime) : 0;
    });
  }, [volume, activeVideoClips, activeAudioClips, activeTransitionLayers, activeAudioTransitionIn, project.tracks, hasSolo, currentTime]);

  // 预解码触发：对"手动驱动类型"片段（倒放/冻结/零速曲线）后台启动帧缓存（仅首次）。
  // 不支持 rVFC / 超长片段 → status='unsupported'，由播放逻辑回退到现有 seek。
  useEffect(() => {
    if (!isRVFCSupported()) return;
    for (const { clip, asset } of activeVideoClips) {
      const remap = clip.time_remap;
      const isManualType = !!remap && (remap.reverse || remap.freeze ||
        (remap.curve && remap.curve.length > 0 && curveHasZeroSpeed(remap.curve)));
      if (!isManualType) continue;
      if (cacheMap.current.has(clip.id)) continue;
      const cache = new ClipFrameCache();
      cacheMap.current.set(clip.id, cache);
      const src = pathToUrl(asset.path);
      cache.decode(src, clip.src_range.start, clip.src_range.end).catch(() => { cache.status = 'error'; });
    }
    // 转场入片段同样预解码（手动驱动类型），供 WebGPU 取帧 / 回退 seek
    for (const { layer, asset } of activeTransitionLayers) {
      const clip = layer.clip;
      const remap = clip.time_remap;
      const isManualType = !!remap && (remap.reverse || remap.freeze ||
        (remap.curve && remap.curve.length > 0 && curveHasZeroSpeed(remap.curve)));
      if (!isManualType) continue;
      if (cacheMap.current.has(clip.id)) continue;
      const cache = new ClipFrameCache();
      cacheMap.current.set(clip.id, cache);
      const src = pathToUrl(asset.path);
      cache.decode(src, clip.src_range.start, clip.src_range.end).catch(() => { cache.status = 'error'; });
    }
    // 缓存数量上限（简化 LRU：超出丢弃最旧），避免内存无限增长
    if (cacheMap.current.size > 6) {
      const oldest = cacheMap.current.keys().next().value as string;
      cacheMap.current.get(oldest)?.dispose();
      cacheMap.current.delete(oldest);
    }
  }, [activeVideoClips, activeTransitionLayers]);

  // 每帧把"已就绪缓存"的当前源时间对应帧写入 bitmapSources，供 WebGPU 取帧呈现；
  // 未就绪/回退状态下该 clip 不写入 → WebGPU 继续采视频（现有 seek 路径）。
  useEffect(() => {
    bitmapSources.current.clear();
    for (const { clip } of activeVideoClips) {
      const cache = cacheMap.current.get(clip.id);
      if (cache && cache.status === 'ready') {
        const { srcT } = clipSourceTime(currentTime, clip);
        const bmp = cache.getFrame(srcT);
        if (bmp) bitmapSources.current.set(clip.id, bmp);
      }
    }
    for (const { layer } of activeTransitionLayers) {
      const clip = layer.clip;
      const cache = cacheMap.current.get(clip.id);
      if (cache && cache.status === 'ready') {
        const { srcT } = clipSourceTime(currentTime, clip);
        const bmp = cache.getFrame(srcT);
        if (bmp) bitmapSources.current.set(clip.id, bmp);
      }
    }
  }, [currentTime, activeVideoClips, activeTransitionLayers]);

  // 卸载时释放所有缓存（关闭 bitmap、停止隐藏 video）
  useEffect(() => () => {
    cacheMap.current.forEach((c) => c.dispose());
    cacheMap.current.clear();
  }, []);

  // 视频元数据加载完成：seek 到正确位置 + 恢复播放
  const onLoadedMetadataFor = (clip: ClipConfig) => () => {
    const v = videoRefs.current.get(clip.id);
    if (!v) return;
    applyPreservesPitch(v); // 元素初次加载即设置，保证变速不变调
    const { srcT: targetTime } = clipSourceTime(currentTime, clip);
    v.currentTime = Math.max(0, Math.min(v.duration || targetTime, targetTime));
    // 手动驱动片段（time_remap）不 play()，交由 RAF 逐帧 seek
    if (!clipNeedsManualDrive(clip, currentTime) && useUIStore.getState().isPlaying) v.play().catch(() => {});
  };

  // 音频元数据加载完成
  const onLoadedMetadataForAudio = (clip: ClipConfig) => () => {
    const a = audioRefs.current.get(clip.id);
    if (!a) return;
    applyPreservesPitch(a); // 元素初次加载即设置，保证变速不变调
    const { srcT: targetTime } = clipSourceTime(currentTime, clip);
    a.currentTime = Math.max(0, Math.min(a.duration || targetTime, targetTime));
    if (!clipNeedsManualDrive(clip, currentTime) && useUIStore.getState().isPlaying) a.play().catch(() => {});
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
      <div style={theme.stage} ref={stageRef}>
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
              {/* 转场入片段隐藏 video：解码 + 供 WebGPU 取纹理（与出片段同步 seek） */}
              {activeTransitionLayers.map(({ layer, asset }) => (
                <video
                  key={`tr-${layer.clip.id}`}
                  ref={(el) => { if (el) videoRefs.current.set(layer.clip.id, el); else videoRefs.current.delete(layer.clip.id); }}
                  src={pathToUrl(asset.path)}
                  style={theme.hiddenMedia}
                  onLoadedMetadata={onLoadedMetadataFor(layer.clip)}
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
              {activeVideoClips.map(({ clip, asset }, idx) => {
                const outTr = getOutClipTransition(clip, currentTime);
                return (
                <video
                  key={clip.id}
                  ref={(el) => { if (el) videoRefs.current.set(clip.id, el); else videoRefs.current.delete(clip.id); }}
                  src={pathToUrl(asset.path)}
                  style={{
                    position: idx === 0 ? 'relative' : 'absolute',
                    maxWidth: '100%', maxHeight: '100%',
                    zIndex: idx,  // 底层 idx=0，顶层 idx=最大
                    top: 0, left: 0,
                    // 转场：出片段在转场窗内淡出（与 transform.opacity 相乘）
                    opacity: (clip.transform?.opacity ?? 1) * outTr.opacity,
                    ...(outTr.clipPath ? { clipPath: outTr.clipPath } : {}),
                    filter: computeCssFilter(clip),  // HTML5 回退：CSS filter 实时预览插件（WebGPU 走 WGSL）
                  }}
                  onLoadedMetadata={onLoadedMetadataFor(clip)}
                  onClick={handleTogglePlay}
                />
              );}) }
              {/* 转场入片段层：转场窗内叠在出片段上方（zIndex 高于出片段） */}
              {activeTransitionLayers.map(({ layer, asset }) => {
                const stageW = stageRef.current?.clientWidth || project.canvas?.width || 1920;
                const tStyle: React.CSSProperties = {
                  position: 'absolute', top: 0, left: 0,
                  maxWidth: '100%', maxHeight: '100%',
                  zIndex: layer.zIndex,
                  opacity: layer.opacity,
                };
                if (layer.offsetX !== 0) {
                  // slide：从右侧外（offsetX*stageWidth）滑入归位（0）
                  tStyle.transform = `translateX(${layer.offsetX * stageW}px)`;
                }
                if (layer.clipPath) {
                  // wipe：入片段按 CSS clip-path 揭示（出片段已裁掉对应区域）
                  tStyle.clipPath = layer.clipPath;
                }
                return (
                  <video
                    key={`tr-${layer.clip.id}`}
                    ref={(el) => { if (el) videoRefs.current.set(layer.clip.id, el); else videoRefs.current.delete(layer.clip.id); }}
                    src={pathToUrl(asset.path)}
                    style={tStyle}
                    onLoadedMetadata={onLoadedMetadataFor(layer.clip)}
                    onClick={handleTogglePlay}
                  />
                );
              })}
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
          <div
            key={idx}
            style={item.style}
            title="单击选中 · 双击编辑文字"
            onClick={() => useUIStore.getState().selectClip(item.trackId, item.clipId)}
            onDoubleClick={() => {
              useUIStore.getState().selectClip(item.trackId, item.clipId);
              useUIStore.getState().setActiveRightPanel(item.kind === 'subtitle' ? 'subtitle' : 'text');
            }}
          >{item.text}</div>
        ))}

        {/* 贴纸图片叠加层（DOM <img>，跨 WebGPU/HTML5 通用） */}
        {activeStickerOverlays.map((item, idx) => (
          <img key={idx} src={item.src} style={item.style} alt="" />
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

        {/* 转场窗内"入片段"音频（同轨下一片段，提前淡入） */}
        {activeAudioTransitionIn.map(({ clip, asset }) => (
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
          }}
          title={gpuError ? `WebGPU 渲染失败已退回 HTML5：${gpuError}` : undefined}
          >
            {engineLabel}
            {hasSolo && <span style={{ color: '#ff9800', marginLeft: 6 }}>🎤 SOLO</span>}
          </div>
        )}

        {/* WebGPU 失败原因（DevTools 默认禁用，直接显示在画面上便于排查） */}
        {gpuError && (
          <div style={{
            position: 'absolute', left: 8, bottom: 56, right: 8,
            fontSize: 11, color: '#ff6b6b', background: 'rgba(0,0,0,0.82)',
            border: '1px solid #ff6b6b', borderRadius: 4, padding: '4px 8px',
            fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'auto',
            pointerEvents: 'none', zIndex: 20,
          }}>
            WebGPU 渲染失败 → 已退回 HTML5：{gpuError}
          </div>
        )}

        {/* 预解码进度提示（倒放/冻结片段后台抓取帧时） */}
        {hasContent && decoding && (
          <div style={{
            position: 'absolute', top: 8, left: 8,
            fontSize: 12, fontWeight: 700, color: '#ffd166',
            padding: '4px 10px', borderRadius: 6,
            background: 'rgba(0,0,0,0.7)', border: '1px solid #ffd166',
            fontFamily: 'monospace', whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 10,
          }}>
            ⟳ 解码中…
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
        }}
        title={gpuError ? `WebGPU 渲染失败已退回 HTML5：${gpuError}` : undefined}
        >
          {engineLabel}
        </div>
      </div>
    </div>
  );
}
