// 预览画布 — WebGPU/HTML5 双路径视频预览 + 播放控制栏
// 多轨道叠加：查找 currentTime 下所有可见 video 轨道的活跃 clip，按 track.order 从底到顶叠加
// 音频轨道：独立 <audio> 元素播放，受静音/独奏控制（不受可见性影响）
// WebGPU 不可用时回退到 HTML5 video（渲染所有活跃视频轨道，按层级叠加）
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { useWebGPUPreview, type ActiveVideoClip } from './WebGPUPreview';
import type { ClipConfig, TrackConfig, AssetConfig, SpeedPointConfig } from '../types';
import { rawSpeedIntegral, rawSpeedAt } from '../utils/speedCurve';
import { ClipFrameCache, isRVFCSupported } from '../utils/frameCache';
import { computeOutClipOpacity, getIncomingTransitionLayer, getOutClipTransition, getOutClipAudioEnv, getIncomingAudioTransitionLayer, audioCrossfadeEnv, getClipFadeGain, getFlashOverlay, type TransitionPreviewLayer, type MaskRect } from '../utils/transitionUtils';
import { CANVAS_PRESETS, findPresetIndex } from '../utils/canvasPresets';
import { findFontCss } from '../utils/subtitleFonts';
import { buildMaskImageUrl, buildMaskShadowFilter } from '../utils/maskRender';

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

function clipSourceTime(t: number, clip: ClipConfig, overrideTimelineIn?: number): { srcT: number; frozen: boolean } {
  const timelineIn = overrideTimelineIn ?? clip.timelineIn;
  const dur = clip.timelineOut - timelineIn;
  const off = t - timelineIn;                  // 绝对偏移（秒）
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
  canvas: { width: '100%', height: '100%', display: 'block', background: '#000' } as React.CSSProperties,
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
  frame: { position: 'relative', flex: '0 0 auto', overflow: 'hidden', background: '#000', boxShadow: '0 0 0 1px #0f3460' } as React.CSSProperties,
  frameVideo: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' } as React.CSSProperties,
  aspectSelectWrap: { position: 'absolute', right: 10, bottom: 10, zIndex: 30 } as React.CSSProperties,
  aspectSelect: { background: 'rgba(10,15,30,0.85)', color: '#eee', border: '1px solid #e94560', borderRadius: 6, padding: '5px 8px', fontSize: 12, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.5)', maxWidth: 220 } as React.CSSProperties,
};

export default function PreviewCanvas() {
  const project = useProjectStore((s) => s.project);
  const setCanvasSize = useProjectStore((s) => s.setCanvasSize);
  const { currentTime, isPlaying, togglePlay, setCurrentTime } = useUIStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 当前帧率：播放头所在主视频轨 clip 优先取其素材 fps，否则回退到工程画布 fps
  const activeClip = useMemo(() => {
    const t = currentTime;
    for (const tr of project.tracks) {
      if (tr.type !== 'video') continue;
      for (const c of tr.clips) {
        if (t >= c.timelineIn && t < c.timelineOut) return c;
      }
    }
    // 回退：任意第一个有素材的 video clip
    for (const tr of project.tracks) {
      if (tr.type !== 'video') continue;
      if (tr.clips.length) return tr.clips[0];
    }
    return null;
  }, [project, currentTime]);
  const activeFps =
    (activeClip ? project.assets.find((a) => a.id === activeClip.assetId)?.fps : undefined) ??
    project.canvas.fps ??
    30;
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  // 音量放大支持：HTMLMediaElement.volume 硬限 [0,1]，而 clip.volume / track.volume 可达 2，
  // 超出 1 的部分必须经 Web Audio GainNode 放大；AudioContext 不可用/未运行时回退 clamp 到 [0,1]，绝不抛异常。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainMapRef = useRef<Map<string, { el: HTMLMediaElement; src: MediaElementAudioSourceNode; gain: GainNode }>>(new Map());
  const stageRef = useRef<HTMLDivElement>(null);
  // 画布框：把工程画布按 aspect ratio letterbox 到 stage 内，保证面板缩放时画幅/视频比例不变、所见即所得。
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
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

  // flash 转场白场 overlay 不透明度：取所有视频轨出片段在转场窗内的峰值（窗中点最亮）
  const flashOverlayOpacity = Math.max(
    0,
    ...activeVideoClips.map(({ clip }) => getFlashOverlay(clip, currentTime)?.opacity ?? 0),
  );

  // 入片段「虚拟 timelineIn」映射（贯穿入片段整个可见生命周期，不止转场窗内）：
  // key=入片段 id，value=转场窗起点（outT - dur）。转场让入片段提前 dur 秒显示，
  // 其源时间应从转场窗起点起算，而非真实 timelineIn（=outT）。
  // 这样转场窗内（作为入片段叠加层）与窗后（成为活跃片段）源位置连续——
  // 窗结束瞬间从 dur*speed 衔接，不跳回 src_range.start（避免「入片段开头反复循环播放」）。
  // 遍历所有轨道（video/audio），凡挂有转场（非 none）的出片段，其同轨下一邻接片段即为入片段。
  // 该映射与 currentTime 无关（出片段→入片段关系固定），每帧重建成本极低。
  const incomingVirtualInMap = (() => {
    const m = new Map<string, number>();
    for (const track of project.tracks) {
      if (track.visible === false) continue;
      for (const clip of track.clips) {
        const tr = clip.transition;
        if (!tr || tr.transitionType === undefined || tr.transitionType === 'none') continue;
        const dur = tr.duration && tr.duration > 0 ? tr.duration : 0.5;
        const outT = clip.timelineOut;
        const next = [...track.clips]
          .filter((c) => c.id !== clip.id && c.timelineIn >= outT - 1e-4)
          .sort((a, b) => a.timelineIn - b.timelineIn)[0];
        if (next) m.set(next.id, outT - dur);
      }
    }
    return m;
  })();

  // 查找每个活跃"出片段"在转场窗内的入片段层（同轨下一片段），供实时预览叠加。
  // 与 activeVideoClips 同源（同一可见 video 轨反转序列），故第 i 个层对应第 i 个活跃片段。
  // 入片段的「虚拟 timelineIn」已由上方 incomingVirtualInMap 统一提供（贯穿生命周期）。
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
      if (asset) {
        result.push({ layer, asset, outClip: clip });
      }
    }
    return result;
  })();

  // 预加载列表：转场窗将在未来 2 秒内开始的入片段（同轨下一片段）。
  // 条件：currentTime >= outT - duration - 2.0 && currentTime < outT - duration
  // 这些入片段的 <video> 元素提前渲染（hidden），提前加载 + seek 到转场起点，
  // 转场窗开始时首帧已就绪，避免入片段开头卡顿。
  // 注意：与 activeTransitionLayers 互斥——进入转场窗后由 active 接管，upcoming 不再包含。
  const upcomingTransitionClips: { clip: ClipConfig; asset: AssetConfig; outClip: ClipConfig }[] = (() => {
    const tracks = project.tracks
      .filter((t) => t.type === 'video' && t.visible !== false)
      .reverse();
    const result: { clip: ClipConfig; asset: AssetConfig; outClip: ClipConfig }[] = [];
    for (const track of tracks) {
      const outClip = track.clips.find((c) => currentTime >= c.timelineIn && currentTime < c.timelineOut);
      if (!outClip) continue;
      const tr = outClip.transition;
      if (!tr || tr.transitionType === undefined || tr.transitionType === 'none') continue;
      const dur = tr.duration && tr.duration > 0 ? tr.duration : 0.5;
      const outT = outClip.timelineOut;
      const windowStart = outT - dur;       // 转场窗起点
      const preloadStart = windowStart - 2.0; // 预加载起点（提前 2 秒）
      if (currentTime < preloadStart || currentTime >= windowStart) continue;
      // 同轨下一片段：timelineIn 最接近 outT（邻接）的那个
      const next = [...track.clips]
        .filter((c) => c.id !== outClip.id && c.timelineIn >= outT - 1e-4)
        .sort((a, b) => a.timelineIn - b.timelineIn)[0];
      if (!next) continue;
      const asset = project.assets.find((a) => a.id === next.assetId);
      if (asset) result.push({ clip: next, asset, outClip });
    }
    return result;
  })();

  // 统一视频渲染列表：active 活跃片段 + 转场入片段（窗内）+ upcoming 预加载入片段（窗前），
  // 全部以 clip.id 为 React key 渲染在同一个 .map() 列表（同一父节点）。
  // 入片段在「upcoming → 转场窗(入片段层) → 正常活跃」全链路复用同一 DOM <video> 元素，
  // 转场窗结束瞬间不卸载重建（React 同父同 key 复用），消除「一下卡顿」。
  // 转场窗内/窗后仅切换该元素的样式（opacity/clipPath/transform），源位置由 incomingVirtualInMap 保证连续。
  const allVideoClips: { clip: ClipConfig; asset: AssetConfig; role: 'active' | 'incoming' | 'upcoming' }[] = (() => {
    const m = new Map<string, { clip: ClipConfig; asset: AssetConfig; role: 'active' | 'incoming' | 'upcoming' }>();
    for (const { clip, asset } of activeVideoClips) {
      if (!m.has(clip.id)) m.set(clip.id, { clip, asset, role: 'active' });
    }
    for (const { layer, asset } of activeTransitionLayers) {
      if (!m.has(layer.clip.id)) m.set(layer.clip.id, { clip: layer.clip, asset, role: 'incoming' });
    }
    for (const { clip, asset } of upcomingTransitionClips) {
      if (!m.has(clip.id)) m.set(clip.id, { clip, asset, role: 'upcoming' });
    }
    return [...m.values()];
  })();

  // 传给 WebGPU 预览 hook 的转场入片段信息（已算好 opacity / slide 偏移 / 缩放 / 圆形遮罩）
  const transitionIncoming = activeTransitionLayers.map(({ layer, outClip }) => ({
    outClipId: outClip.id,
    clip: layer.clip,
    opacity: layer.opacity,
    offsetX: layer.offsetX,
    clipPath: layer.clipPath,
    maskRect: layer.maskRect,
    direction: layer.direction,
    transform: layer.transform ?? null,
    filter: layer.filter ?? null,
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
              fontSize: t.fontSize || 48, fontFamily: findFontCss(t.fontFamily),
              textAlign: (t.textAlign || 'center') as any, fontWeight: (t.fontWeight as any) || 'bold',
              ...(t.strokeWidth ? { WebkitTextStroke: `${t.strokeWidth}px ${t.strokeColor || '#000'}` } : {}),
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
                fontFamily: findFontCss(s.fontFamily), textAlign: 'center' as any, pointerEvents: 'none', zIndex: 101,
                ...(s.strokeWidth ? { WebkitTextStroke: `${s.strokeWidth}px ${s.strokeColor || '#000'}` } : {}),
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
  const presetIdx = findPresetIndex(project.canvas.width, project.canvas.height);

  // 预览画布框：根据 stage 实际像素 + 工程画布比例，计算 letterbox 后的框尺寸。
  // 面板/时间轴缩放只改变 stage 尺寸 → ResizeObserver 触发重算，画布始终等比、不拉伸。
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const recompute = () => {
      const sw = el.clientWidth, sh = el.clientHeight;
      if (sw <= 0 || sh <= 0) return;
      const cw = project.canvas.width || 1920, ch = project.canvas.height || 1080;
      const scale = Math.min(sw / cw, sh / ch);
      setFrameSize({ w: Math.max(1, Math.round(cw * scale)), h: Math.max(1, Math.round(ch * scale)) });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.canvas.width, project.canvas.height]);

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
        if (totalDur <= 0) { useUIStore.getState().togglePlay(); return; }
        // 播放完成后把播放头自动归零，停在 0:00 准备下次播放
        setCurrentTime(0);
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
    // 预加载入片段：不播放，只 pause（由 seek effect 提前定位到转场起点）
    upcomingTransitionClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      v.pause();
    });
  }, [isPlaying, activeVideoClips, activeAudioClips, activeTransitionLayers, activeAudioTransitionIn, upcomingTransitionClips]);

  // seek 同步：currentTime 变化时同步所有视频/音频源时间
  //  - 手动驱动片段（time_remap）：每帧按 currentTime 设源时间，!seeking 防止 seek 请求堆积，
  //    连续呈现倒放/冻结/曲线映射（video 已被 pause，不会自播放与之互掐）
  //  - 自播放片段（正放）：仅偏差 >0.3s 时纠正，允许 video 自然播放
  useEffect(() => {
    activeVideoClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      // 若本片段是刚结束转场的入片段，用虚拟 timelineIn（转场窗起点）计算源时间，
      // 保证转场窗结束后从 dur*speed 位置连续衔接，不跳回开头（避免「开头反复播放」）。
      const virtualIn = incomingVirtualInMap.get(clip.id);
      const { srcT: targetTime } = clipSourceTime(currentTime, clip, virtualIn);
      if (clipNeedsManualDrive(clip, currentTime)) {
        if (v.readyState >= 1 && !v.seeking) v.currentTime = Math.max(0, targetTime);
      } else {
        // 自播放：每帧把 playbackRate 更新为当前瞬时有效速率（变速曲线动态调速、平滑不掉帧），
        // 位置偏差 >0.3 才纠正 seek（速率跟踪良好时几乎不触发）
        v.playbackRate = effectiveRate(clip, currentTime);
        if (v.readyState >= 1 && Math.abs(v.currentTime - targetTime) > 0.3) v.currentTime = Math.max(0, targetTime);
      }
    });
    activeTransitionLayers.forEach(({ layer, outClip }) => {
      const v = videoRefs.current.get(layer.clip.id);
      if (!v) return;
      // 统一用虚拟 timelineIn（转场窗起点）计算源时间，保证窗内/窗后连续，支持 time_remap。
      const virtualIn = outClip.timelineOut - (outClip.transition?.duration && outClip.transition.duration > 0 ? outClip.transition.duration : 0.5);
      const targetTime = Math.max(0, clipSourceTime(currentTime, layer.clip, virtualIn).srcT);
      if (clipNeedsManualDrive(layer.clip, currentTime)) {
        if (v.readyState >= 1 && !v.seeking) v.currentTime = targetTime;
      } else {
        v.playbackRate = effectiveRate(layer.clip, currentTime);
        if (v.readyState >= 1 && Math.abs(v.currentTime - targetTime) > 0.3) v.currentTime = targetTime;
      }
    });
    activeAudioClips.forEach(({ clip }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      // 入片段（转场窗之前被提前显示）窗后用虚拟 timelineIn 计算源时间，保证与转场窗内连续，
      // 不跳回素材开头（与视频入片段同源处理）。普通片段 virtualIn 为 undefined，走真实 timelineIn。
      const virtualIn = incomingVirtualInMap.get(clip.id);
      const { srcT: targetTime } = clipSourceTime(currentTime, clip, virtualIn);
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
    // 预加载入片段：seek 到转场起点（progress=0 对应素材起点），转场窗开始时首帧已就绪
    upcomingTransitionClips.forEach(({ clip }) => {
      const v = videoRefs.current.get(clip.id);
      if (!v) return;
      const targetTime = Math.max(0, clip.src_range.start);
      if (v.readyState >= 1 && !v.seeking && Math.abs(v.currentTime - targetTime) > 0.1) {
        v.currentTime = targetTime;
      }
    });
  }, [currentTime, activeVideoClips, activeAudioClips, activeTransitionLayers, activeAudioTransitionIn, upcomingTransitionClips]);

  // ---- 音量放大支持：HTMLMediaElement.volume 硬限 [0,1] ----
  // clip.volume / track.volume 可达 2，超出 1 的部分用 Web Audio GainNode 放大；
  // 若 AudioContext 不可用/未运行，则回退 clamp 到 [0,1]，绝不抛 "outside the range" 异常。
  const getOrCreateAudioCtx = useCallback((): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    try { audioCtxRef.current = new AC(); } catch { return null; }
    return audioCtxRef.current;
  }, []);

  const ensureAudioGraph = useCallback((el: HTMLMediaElement, id: string): GainNode | null => {
    const ctx = getOrCreateAudioCtx();
    if (!ctx || ctx.state !== 'running') return null; // 未运行则不要抢占元素音频，避免静音
    const entry = gainMapRef.current.get(id);
    if (entry && entry.el === el) return entry.gain;
    if (entry) {
      try { entry.src.disconnect(); entry.gain.disconnect(); } catch { /* noop */ }
      gainMapRef.current.delete(id);
    }
    try {
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain);
      gain.connect(ctx.destination);
      gainMapRef.current.set(id, { el, src, gain });
      return gain;
    } catch {
      return null; // 元素已被其它图占用，放弃放大
    }
  }, [getOrCreateAudioCtx]);

  const applyVolume = useCallback((el: HTMLMediaElement, id: string, target: number) => {
    const t = Math.max(0, target);
    const entry = gainMapRef.current.get(id);
    if (entry && entry.el === el) { entry.gain.gain.value = t; return; }
    if (t > 1) {
      const ctx = getOrCreateAudioCtx();
      if (ctx) {
        ctx.resume?.();
        const gain = ensureAudioGraph(el, id);
        if (gain) { gain.gain.value = t; el.volume = 1; return; }
      }
      el.volume = 1; // 无法放大则满音量输出，避免抛错
      return;
    }
    el.volume = t; // t ∈ [0,1] 且无图：直接经元素音量，安全
  }, [ensureAudioGraph, getOrCreateAudioCtx]);

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
      const target = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) * getClipFadeGain(clip, currentTime) : 0;
      applyVolume(v, clip.id, target);
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
      const target = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (layer.clip.volume ?? 1) * env * getClipFadeGain(layer.clip, currentTime) : 0;
      applyVolume(v, layer.clip.id, target);
    });
    activeAudioClips.forEach(({ clip, trackId }) => {
      const a = audioRefs.current.get(clip.id);
      if (!a) return;
      const track = project.tracks.find(t => t.id === trackId);
      if (!track) return;
      const shouldHaveAudio = trackHasAudio(track);
      const { frozen } = clipSourceTime(currentTime, clip);
      // 出片段在转场窗内乘音频包络（cos 淡出），窗外=1；再乘音频包络线增益
      const target = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) * getOutClipAudioEnv(clip, currentTime) * getClipFadeGain(clip, currentTime) : 0;
      applyVolume(a, clip.id, target);
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
      const target = shouldHaveAudio && !frozen ? volume * (track.volume ?? 1) * (clip.volume ?? 1) * inEnv * getClipFadeGain(clip, currentTime) : 0;
      applyVolume(a, clip.id, target);
    });
  }, [volume, activeVideoClips, activeAudioClips, activeTransitionLayers, activeAudioTransitionIn, project.tracks, hasSolo, currentTime, applyVolume]);

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
    // 若本片段是转场入片段，用虚拟 timelineIn（转场窗起点）计算源时间，
    // 转场窗内即可定位到正确的入片段位置（而非 clamp 到开头）。
    const virtualIn = incomingVirtualInMap.get(clip.id);
    const targetTime = clipSourceTime(currentTime, clip, virtualIn).srcT;
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

  const handleTogglePlay = useCallback(() => { audioCtxRef.current?.resume?.(); togglePlay(); }, [togglePlay]);

  // 逐帧步进：暂停后精确到上/下一帧。常规（无变速/冻结）走「源帧」精确：
  // 取当前源时间 → 源帧 ±1 → 逆映射回时间轴；变速片段回退到时间轴近似步进。
  const stepFrame = useCallback((dir: number) => {
    if (useUIStore.getState().isPlaying) useUIStore.getState().togglePlay();
    const remap = activeClip?.time_remap;
    const hasRemap = !!(remap && (remap.curve?.length || remap.freeze || remap.reverse));
    let newT: number;
    if (activeClip && !hasRemap) {
      const srcLen = activeClip.src_range.end - activeClip.src_range.start;
      const curSrc = clipSourceTime(currentTime, activeClip).srcT;
      const f = Math.round(curSrc * activeFps) + dir;
      const newSrc = Math.max(0, Math.min(srcLen, f / activeFps));
      const speed = activeClip.speed ?? 1;
      newT = activeClip.timelineIn + (newSrc - activeClip.src_range.start) / speed;
    } else {
      const f = Math.round(currentTime * activeFps) + dir;
      newT = f / activeFps;
    }
    setCurrentTime(Math.max(0, Math.min(totalDuration, newT)));
  }, [currentTime, activeClip, activeFps, totalDuration, setCurrentTime]);

  // 键盘逐帧：暂停态下 ← / , 上一帧，→ / . 下一帧；输入框聚焦时不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as any).isContentEditable)) return;
      if (e.key === 'ArrowLeft' || e.key === ',') { e.preventDefault(); stepFrame(-1); }
      else if (e.key === 'ArrowRight' || e.key === '.') { e.preventDefault(); stepFrame(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepFrame]);

  // 进度条点击/拖拽跳转
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setCurrentTime(ratio * (totalDuration || 1));
  };

  // 音量变化
  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    audioCtxRef.current?.resume?.();
    setVolume(parseFloat(e.target.value));
  };

  // 进度百分比
  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div style={theme.root}>
      {/* 舞台：视频画面 */}
      <div style={theme.stage} ref={stageRef}>
        {(activeVideoClips.length > 0 || activeTextOverlays.length > 0 || activeStickerOverlays.length > 0) ? (
          <div style={{ ...theme.frame, width: frameSize.w || 1, height: frameSize.h || 1 }} ref={frameRef}>
          {activeVideoClips.length > 0 ? (
            useWebGPU ? (
            <>
              {/* 统一隐藏 video 列表：active + 转场入片段 + upcoming 预加载，全部 key=clip.id，
                  同一父节点同一 .map()，跨转场窗前后复用同一 DOM，不重建（消除卡顿）。
                  WebGPU 模式下 video 仅作解码源，画面由 canvas 合成。 */}
              {allVideoClips.map(({ clip, asset }) => (
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
              {/* HTML5 回退：统一 video 列表，按 role 计算样式。
                  入片段在转场窗内用叠加样式(incoming)，窗后变 active 正常样式——同一 DOM 元素切换样式，不重建。 */}
              {allVideoClips.map(({ clip, asset, role }) => {
                if (role === 'upcoming') {
                  // 预加载阶段：不显示，仅解码 + seek 到转场起点，进入转场窗时首帧已就绪
                  return (
                    <video
                      key={clip.id}
                      ref={(el) => { if (el) videoRefs.current.set(clip.id, el); else videoRefs.current.delete(clip.id); }}
                      src={pathToUrl(asset.path)}
                      style={theme.hiddenMedia}
                      onLoadedMetadata={onLoadedMetadataFor(clip)}
                    />
                  );
                }
                if (role === 'incoming') {
                  // 转场入片段叠加层：叠在出片段上方（zIndex 高于出片段）
                  const layer = activeTransitionLayers.find((l) => l.layer.clip.id === clip.id)?.layer;
                  if (!layer) return null;
                  const stageW = frameRef.current?.clientWidth || project.canvas.width || 1920;
                  const tStyle: React.CSSProperties = { ...theme.frameVideo, zIndex: layer.zIndex, opacity: layer.opacity };
                  if (layer.offsetX !== 0) {
                    // slide：从右侧外（offsetX*stageWidth）滑入归位（0）
                    tStyle.transform = `translateX(${layer.offsetX * stageW}px)`;
                  } else if (layer.transform) {
                    // zoom：scale(0.88→1.0) 归位
                    tStyle.transform = layer.transform;
                  }
                  if (layer.filter) {
                    // blur 入片段（清晰，filter 一般用于出片段；此处兼容透传）
                    tStyle.filter = layer.filter;
                  }
                  if (layer.clipPath && !layer.maskImage) {
                    // wipe（无羽化）：入片段按 CSS clip-path 揭示
                    tStyle.clipPath = layer.clipPath;
                  }
                  if (layer.maskImage) {
                    // wipe + feather：用软边 mask（circle 用 radial-gradient，linear 用 linear-gradient）
                    tStyle.WebkitMaskImage = layer.maskImage;
                    tStyle.maskImage = layer.maskImage;
                    tStyle.WebkitMaskSize = '100% 100%';
                    tStyle.maskSize = '100% 100%';
                  }
                  return (
                    <video
                      key={clip.id}
                      ref={(el) => { if (el) videoRefs.current.set(clip.id, el); else videoRefs.current.delete(clip.id); }}
                      src={pathToUrl(asset.path)}
                      style={tStyle}
                      onLoadedMetadata={onLoadedMetadataFor(clip)}
                      onClick={handleTogglePlay}
                    />
                  );
                }
                // role === 'active'：正常活跃片段（含出片段在转场窗内淡出）
                const idx = activeVideoClips.findIndex((c) => c.clip.id === clip.id);
                const outTr = getOutClipTransition(clip, currentTime);
                const outStyle: React.CSSProperties = {
                  ...theme.frameVideo,
                  zIndex: idx,  // 底层 idx=0，顶层 idx=最大
                  // 转场：出片段在转场窗内淡出（与 transform.opacity 相乘）
                  opacity: (clip.transform?.opacity ?? 1) * outTr.opacity,
                  filter: computeCssFilter(clip),  // HTML5 回退：CSS filter 实时预览插件（WebGPU 走 WGSL）
                };
                if (outTr.transform) {
                  // zoom 出片段放大淡出：scale(1→1.12)
                  outStyle.transform = outTr.transform;
                }
                if (outTr.filter) {
                  // blur 出片段模糊淡出
                  outStyle.filter = outStyle.filter ? `${outStyle.filter} ${outTr.filter}` : outTr.filter;
                }
                if (outTr.clipPath && !outTr.maskImage) {
                  outStyle.clipPath = outTr.clipPath;
                }
                if (outTr.maskImage) {
                  outStyle.WebkitMaskImage = outTr.maskImage;
                  outStyle.maskImage = outTr.maskImage;
                  outStyle.WebkitMaskSize = '100% 100%';
                  outStyle.maskSize = '100% 100%';
                }
                // 蒙版（HTML5 回退）：把启用蒙版合成为 CSS mask-image（dataURL）。
                // 关键：阴影 drop-shadow【不能】和 mask-image 放在同一元素上。CSS 渲染顺序是先 filter 后 mask，
                // drop-shadow 生成的、延伸到蒙版形状之外的阴影会被 mask 一并裁掉 → 阴影永远不可见。
                // 因此阴影必须放到【无 mask 的外层 wrapper】，由其基于被遮罩子元素的 alpha 轮廓生成阴影，
                // wrapper 自身不被遮罩，阴影才不会被裁掉。
                // 与转场 maskImage 共存时以 clip 自身蒙版为准（覆盖转场软边）。
                const maskList = (clip.masks || []).filter((m) => m.enabled);
                let shadowFilter: string | null = null;
                if (maskList.length > 0) {
                  const maskUrl = buildMaskImageUrl(maskList);
                  if (maskUrl) {
                    outStyle.WebkitMaskImage = maskUrl;
                    outStyle.maskImage = maskUrl;
                    outStyle.WebkitMaskSize = '100% 100%';
                    outStyle.maskSize = '100% 100%';
                  }
                  shadowFilter = buildMaskShadowFilter(maskList); // 仅取字符串，挂到外层 wrapper
                }
                const videoEl = (
                  <video
                    key={clip.id}
                    ref={(el) => { if (el) videoRefs.current.set(clip.id, el); else videoRefs.current.delete(clip.id); }}
                    src={pathToUrl(asset.path)}
                    style={{ ...outStyle, pointerEvents: 'auto' }}
                    onLoadedMetadata={onLoadedMetadataFor(clip)}
                    onClick={handleTogglePlay}
                  />
                );
                return shadowFilter ? (
                  <div key={clip.id} style={{ position: 'absolute', inset: 0, filter: shadowFilter, pointerEvents: 'none' }}>
                    {videoEl}
                  </div>
                ) : videoEl;
              })}
            </>
          )
          ) : null}

          {/* flash 转场白场 overlay：全幅白色，叠在转场层之上（pointerEvents none） */}
          {flashOverlayOpacity > 0.001 && (
            <div style={{
              position: 'absolute', inset: 0, background: '#fff',
              opacity: flashOverlayOpacity, pointerEvents: 'none', zIndex: 200,
            }} />
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
          </div>
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

        {/* 画幅比例下拉（预览右下角） */}
        <div style={theme.aspectSelectWrap}>
          <select
            value={presetIdx >= 0 ? String(presetIdx) : 'custom'}
            onChange={(e) => {
              if (e.target.value === 'custom') return;
              const p = CANVAS_PRESETS[Number(e.target.value)];
              setCanvasSize(p.width, p.height);
            }}
            title="画幅比例"
            style={theme.aspectSelect}
          >
            {presetIdx < 0 && <option value="custom">自定义 {project.canvas.width}×{project.canvas.height}</option>}
            {CANVAS_PRESETS.map((p, i) => (
              <option key={i} value={String(i)}>{p.label}（{p.width}×{p.height}）</option>
            ))}
          </select>
        </div>
      </div>

      {/* 播放控制栏 */}
      <div style={theme.controls}>
        <button style={theme.btn} onClick={() => stepFrame(-1)} title="上一帧（暂停时 ← 或 ,）">⏮▏</button>
        <button style={theme.btn} onClick={() => stepFrame(1)} title="下一帧（暂停时 → 或 .）">▏⏭</button>

        <button style={theme.btn} onClick={handleTogglePlay} title={isPlaying ? '暂停' : '播放'}>
          {isPlaying ? '⏸' : '▶'}
        </button>

        <div style={theme.timecode}>
          {formatTC(currentTime)} / {formatTC(totalDuration)}
        </div>

        {/* 帧号显示：常规片段显示「源帧序号 / 源总帧数 @ fps」（基于素材源时间，与删除明细捕获同源） */}
        <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#9fe', whiteSpace: 'nowrap', marginLeft: 8 }}>
          {(() => {
            const srcTime = activeClip ? clipSourceTime(currentTime, activeClip).srcT : currentTime;
            const srcDur = activeClip ? (activeClip.src_range.end - activeClip.src_range.start) : totalDuration;
            const label = activeClip ? '源帧' : '帧';
            return <>{label} {Math.round(srcTime * activeFps)} / {Math.round(srcDur * activeFps)} @ {Math.round(activeFps)}fps</>;
          })()}
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
