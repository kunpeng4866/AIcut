// @ts-nocheck — WebGPU 类型未安装（Phase 5 M3）
// useWebGPUPreview — WebGPU 实时视频预览 hook（多轨道纹理叠加）
// 负责：设备初始化、WGSL 渲染管线、rAF 渲染循环（多视频帧上传→多 pass Over 合成→渲染）、资源清理
import { useEffect, useRef, useState } from 'react';
import type { ClipConfig, AssetConfig, MaskConfig } from '../types';
import { useProjectStore } from '../store/projectStore';
import { computeOutClipOpacity, getOutClipTransition, type MaskRect } from '../utils/transitionUtils';
import { composeMaskedFrame } from '../utils/maskRender';
import { applyKeying, applyMatte } from '../utils/keyingRender';

// 文件路径转 aicut-asset:// URL（与 PreviewCanvas 内 pathToUrl 保持一致；此处本地副本避免循环依赖）
const pathToUrl = (path: string): string => {
  if (/^(https?|aicut-asset|blob):/.test(path)) return path;
  const normalized = path.replace(/\\/g, '/');
  return `aicut-asset:///${normalized}`;
};

// 从 transform CSS 字符串（如 "scale(1.12)"）解析缩放因子，供 zoom 转场折进 WebGPU 用户 scale
function parseScale(s: string | null | undefined): number {
  if (!s) return 1;
  const mm = /scale\(([^)]+)\)/.exec(s);
  if (!mm) return 1;
  const v = parseFloat(mm[1]);
  return isFinite(v) ? v : 1;
}

// ── WGSL 着色器 ──
// Uniform 32 字节：transform(vec4f) + params(vec4f)
//   transform: x=posX, y=posY, z=scaleX, w=scaleY（归一化）
//   params:    x=rotation(rad), y=opacity, z=videoAspect, w=canvasAspect
const WGSL_SHADER = /* wgsl */ `
struct Uniforms {
  transform: vec4f,
  params: vec4f,
  mask: vec4f,
  mask2: vec4f, // x=mode(0=rect,1=circle), y=r(圈半径), z=feather, w=unused
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var videoTexture: texture_2d<f32>;
@group(0) @binding(2) var videoSampler: sampler;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // 全屏四边形 (triangle strip)，UV V=0 顶部
  let positions = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0)
  );
  let uvs = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 0.0)
  );
  let basePos = positions[vi];
  let uv = uvs[vi];

  // contain 适配
  let videoAspect = u.params.z;
  let canvasAspect = u.params.w;
  var fitScale = vec2f(1.0, 1.0);
  if (videoAspect > canvasAspect) {
    fitScale = vec2f(1.0, canvasAspect / videoAspect);
  } else {
    fitScale = vec2f(videoAspect / canvasAspect, 1.0);
  }

  // 用户缩放
  let scaled = basePos * fitScale * vec2f(u.transform.z, u.transform.w);

  // 2D 旋转
  let r = u.params.x;
  let cr = cos(r); let sr = sin(r);
  let rotated = vec2f(scaled.x * cr - scaled.y * sr, scaled.x * sr + scaled.y * cr);

  // 位置偏移：归一化 [0,1] → clip [-1,1]，Y 翻转
  let clipX = u.transform.x * 2.0 - 1.0;
  let clipY = 1.0 - u.transform.y * 2.0;
  let finalPos = rotated + vec2f(clipX, clipY);

  var out: VSOut;
  out.position = vec4f(finalPos, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let color = textureSample(videoTexture, videoSampler, in.uv);
  let nx = in.uv.x;
  let ny = 1.0 - in.uv.y; // 画布坐标 y-down
  let m = u.mask;
  if (nx < m.x || nx > m.z || ny < m.y || ny > m.w) { return vec4f(0.0, 0.0, 0.0, 0.0); }
  var alpha = color.a * u.params.y;
  if (u.mask2.x > 0.5) {
    // 圆形遮罩（归一化圆）：圈内可见、圈外丢弃；feather 软边 smoothstep
    let d = distance(vec2f(nx, ny), vec2f(0.5, 0.5));
    let fw = max(u.mask2.z, 0.001);
    let a = 1.0 - smoothstep(u.mask2.y - fw, u.mask2.y + fw, d);
    if (a <= 0.0) { return vec4f(0.0, 0.0, 0.0, 0.0); }
    alpha = alpha * a;
  }
  return vec4f(color.rgb, alpha);
}
`;

// 最大支持 4 个视频轨道叠加 + 最多 4 个转场入片段附加层（每轨转场时各加 1 层）
const MAX_CLIPS = 8;

export interface ActiveVideoClip {
  clip: ClipConfig;
  asset: AssetConfig;
}

interface UseWebGPUPreviewOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  videoRefs: React.MutableRefObject<Map<string, HTMLVideoElement>>;
  bitmapSources?: React.MutableRefObject<Map<string, ImageBitmap | null>>;
  canvasWidth: number;
  canvasHeight: number;
  clips: ActiveVideoClip[];
  enabled: boolean;
  /** 插件清单（含预览用 shader: string 内联 WGSL），按 id 索引。供滤镜离屏 pass 使用。 */
  pluginManifests?: Record<string, any>;
  /** 全局播放头时间（秒），用于 computeOutClipOpacity 计算转场淡出 */
  currentTime?: number;
  /** 转场入片段层：挂在"出片段"上，转场窗内作为附加合成层叠加在出片段之上 */
  transitionIncoming?: Array<{ outClipId: string; clip: ClipConfig; opacity: number; offsetX: number; clipPath: string | null; maskRect: MaskRect; direction: string; transform?: string | null; filter?: string | null }>;
}

/**
 * WebGPU 实时视频预览 hook（多轨道叠加）。
 * 启用时创建设备+管线，rAF 循环从多个 <video> 上传帧到各自 GPU 纹理，
 * 按 Over 合成（src-over blend）从底到顶依次渲染到 canvas。
 * 卸载或禁用时销毁所有 GPU 资源。
 */
export function useWebGPUPreview({
  canvasRef, videoRefs, bitmapSources, canvasWidth, canvasHeight, clips, enabled, pluginManifests,
  currentTime, transitionIncoming,
}: UseWebGPUPreviewOptions) {
  const deviceRef = useRef<GPUDevice | null>(null);
  const pipelineRef = useRef<GPURenderPipeline | null>(null);
  const uniformBufsRef = useRef<GPUBuffer[]>([]);
  const samplerRef = useRef<GPUSampler | null>(null);
  const rafRef = useRef<number | null>(null);
  const clipsRef = useRef<ActiveVideoClip[]>(clips);
  // 插件滤镜：清单（按 id 索引，含内联 WGSL shader）、管线缓存、编译失败集合
  const pluginManifestsRef = useRef<Record<string, any>>({});
  // 缓存 {pipeline, device}：必须记录所属 device。device 重建后旧管线属旧 device，
  // 若直接复用会触发 "Invalid BindGroupLayout is associated with [Device] ... and cannot be used with [Device]"（跨 device 错误 → 整会话退回 HTML5）。
  const filterPipelinesRef = useRef<Map<string, { pipeline: GPURenderPipeline; device: any }>>(new Map());
  const filterFailedRef = useRef<Set<string>>(new Set());
  // 正在异步验证（createRenderPipeline 的 shader 编译/验证可能异步完成）的 kind 集合：
  // 验证完成前本帧先跳过该滤镜（降级为原图），避免用到一个尚未确定有效的管线（1 帧窗口）。
  const filterValidatingRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 智能抠像（smart）matte 视频缓存：matteAssetId → 隐藏 <video>；离屏 canvas 复用。
  const matteVideoCacheRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const matteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 当前工程（含 assets），供按 matteAssetId 查真实路径。直接写 ref 避免触发重渲染。
  const projectRef = useRef(useProjectStore.getState().project);
  projectRef.current = useProjectStore((s) => s.project);

  // 取当前时刻的 matte 帧（灰度）绘制到离屏 canvas 并返回。
  // matte 视频与源视频同步 currentTime：源暂停则 matte 也暂停并精确 seek；源播放则 matte 跟随播放、
  // 仅在漂移 > 0.05s 时纠正 seek，避免每帧 seek 卡顿。未就绪（readyState<2）返回 null。
  const getMatteFrame = (
    matteAssetId: string,
    srcTime: number,
    srcPaused: boolean,
    srcRate: number,
    targetW: number,
    targetH: number,
  ): HTMLCanvasElement | null => {
    const asset = projectRef.current?.assets?.find((a) => a.id === matteAssetId);
    if (!asset) return null;
    let video = matteVideoCacheRef.current.get(matteAssetId);
    if (!video) {
      video = document.createElement('video');
      video.src = pathToUrl(asset.path);
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      matteVideoCacheRef.current.set(matteAssetId, video);
      video.play().catch(() => {});
    }
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return null;
    // 同步源视频的播放速率（变速片段下 matte 与源需同速，否则随时间漂移）
    if (isFinite(srcRate) && srcRate > 0) video.playbackRate = srcRate;

    if (srcPaused) {
      video.pause();
      if (!video.seeking) video.currentTime = Math.max(0, srcTime);
    } else {
      video.play().catch(() => {});
      if (!video.seeking && Math.abs(video.currentTime - srcTime) > 0.05) {
        video.currentTime = Math.max(0, srcTime);
      }
    }

    let mc = matteCanvasRef.current;
    if (!mc) { mc = document.createElement('canvas'); matteCanvasRef.current = mc; }
    if (mc.width !== targetW) mc.width = targetW;
    if (mc.height !== targetH) mc.height = targetH;
    const mctx = mc.getContext('2d');
    if (!mctx) return null;
    mctx.drawImage(video, 0, 0, targetW, targetH);
    return mc;
  };

  // 最新播放头时间 / 转场入片段层：渲染循环每帧读取，避免重建渲染循环
  const currentTimeRef = useRef<number>(currentTime ?? 0);
  const transitionIncomingRef = useRef<Array<{ outClipId: string; clip: ClipConfig; opacity: number; offsetX: number; clipPath: string | null; maskRect: MaskRect; direction: string; transform?: string | null; filter?: string | null }>>(transitionIncoming ?? []);

  // 保存最新 clips 到 ref，避免每帧重建渲染循环
  useEffect(() => { clipsRef.current = clips; }, [clips]);

  // 保存最新插件清单到 ref，供渲染循环读取（避免每帧重建）
  useEffect(() => { pluginManifestsRef.current = pluginManifests ?? {}; }, [pluginManifests]);

  // 保存最新播放头时间到 ref（转场淡出计算用）
  useEffect(() => { currentTimeRef.current = currentTime ?? 0; }, [currentTime]);

  // 保存最新转场入片段层到 ref，供渲染循环读取
  useEffect(() => { transitionIncomingRef.current = transitionIncoming ?? []; }, [transitionIncoming]);

  // 编译并缓存插件滤镜渲染管线（按 kind）。编译失败则标记 failed，后续跳过该滤镜（降级为原图）。
  // 插件 shader 绑定契约（硬约束）：@group(0) @binding(0)=uniform, 1=texture_2d<f32>, 2=sampler。
  const getFilterPipeline = (device: any, kind: string, shaderSrc: string): GPURenderPipeline | null => {
    if (filterFailedRef.current.has(kind)) return null;
    const cached = filterPipelinesRef.current.get(kind);
    if (cached) {
      // device 重建后旧管线属旧 device → 丢弃并重建，杜绝跨 device 的 Invalid BindGroupLayout
      if (cached.device === device) return cached.pipeline;
      filterPipelinesRef.current.delete(kind);
    }
    // 正在异步验证该滤镜管线时，本帧先跳过（降级为原图），避免用未确定有效的管线（1 帧窗口）
    if (filterValidatingRef.current.has(kind)) return null;
    // 用 error scope 隔离插件 shader 的验证错误：失败时仅跳过该滤镜（降级为原图），
    // 不污染全局 uncapturederror，避免单坏插件拖垮整个 WebGPU 会话。
    device.pushErrorScope('validation');
    let module: any, p: any;
    try {
      module = device.createShaderModule({ code: shaderSrc });
      p = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip' },
      });
    } catch (e: any) {
      device.popErrorScope();
      console.error('[WebGPU] 插件 shader 创建失败，预览跳过该滤镜:', kind, e?.message || e);
      filterFailedRef.current.add(kind);
      return null;
    }
    filterPipelinesRef.current.set(kind, { pipeline: p, device });
    filterValidatingRef.current.add(kind);
    device.popErrorScope().then((err: any) => {
      filterValidatingRef.current.delete(kind);
      if (err) {
        console.error('[WebGPU] 插件 shader 验证失败，预览跳过该滤镜:', kind, err?.message || err);
        filterFailedRef.current.add(kind);
        filterPipelinesRef.current.delete(kind);
      }
    });
    return p;
  };

  // ── 初始化设备 + 管线 + canvas 配置 ──
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      try {
        if (!navigator.gpu) throw new Error('WebGPU 不可用');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('无 GPU 适配器');
        const device = await adapter.requestDevice();
        if (cancelled) { device.destroy(); return; }
        deviceRef.current = device;

        // 捕获 WebGPU 验证错误（validation error 不抛 JS 异常，需监听 uncapturederror）
        // 注意：此处仅记录，不在此直接回退。单帧验证错误由渲染循环的 error scope 捕获并决定是否回退，
        // 避免偶发/良性 uncaptured error 误杀整个 WebGPU 会话（会导致"第一次能播、后来整段退回 HTML5"）。
        device.addEventListener('uncapturederror', (e: any) => {
          console.error('[WebGPU] uncaptured error:', e.error?.message || e.error);
        });

        const canvas = canvasRef.current;
        if (!canvas) throw new Error('canvas 不存在');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('webgpu');
        if (!ctx) throw new Error('无法获取 webgpu 上下文');
        ctx.configure({ device, format: 'bgra8unorm', alphaMode: 'premultiplied' });

        const module = device.createShaderModule({ code: WGSL_SHADER });
        pipelineRef.current = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs_main' },
          fragment: {
            module, entryPoint: 'fs_main',
            targets: [{
              format: 'bgra8unorm',
              // Over 合成：src * srcAlpha + dst * (1 - srcAlpha)
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            }],
          },
          primitive: { topology: 'triangle-strip' },
        });

        // 预分配 MAX_CLIPS 个 uniform buffer，避免每帧创建/销毁
        uniformBufsRef.current = Array.from({ length: MAX_CLIPS }, () =>
          device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        );
        samplerRef.current = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

        setReady(true);
      } catch (e: any) {
        setError(e.message || String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      uniformBufsRef.current.forEach((b) => b.destroy());
      uniformBufsRef.current = [];
      samplerRef.current = null;
      pipelineRef.current = null;
      // device 即将销毁：清空滤镜管线缓存（它们隶属于本 device，不能留给重建后的新 device，否则跨 device 报错）
      filterPipelinesRef.current.clear();
      filterFailedRef.current.clear();
      filterValidatingRef.current.clear();
      deviceRef.current?.destroy();
      deviceRef.current = null;
      setReady(false);
      // 释放智能抠像 matte 视频缓存，避免内存泄漏
      matteVideoCacheRef.current.forEach((v) => { try { v.pause(); v.removeAttribute('src'); (v as any).load?.(); } catch (_) {} });
      matteVideoCacheRef.current.clear();
      matteCanvasRef.current = null;
    };
  }, [enabled, canvasWidth, canvasHeight]);

  // ── rAF 渲染循环（多 pass Over 合成）──
  useEffect(() => {
    if (!enabled || !ready) return;

    let failed = false;
    const render = () => {
      if (failed) return;
      rafRef.current = requestAnimationFrame(render);
      const device = deviceRef.current;
      const pipeline = pipelineRef.current;
      const canvas = canvasRef.current;
      const sampler = samplerRef.current;
      if (!device || !pipeline || !canvas || !sampler) return;

      const activeClips = clipsRef.current;
      if (activeClips.length === 0) return;

      // 收集已就绪的视频（readyState >= 2 即 HAVE_CURRENT_DATA）
      // 手动驱动片段若已预解码就绪，用缓存 ImageBitmap 作为纹理源（绕开每帧 seek，满帧流畅）；
      // 否则回退采视频元素（现有 seek 路径）。
      const items: { source: HTMLVideoElement | ImageBitmap; clip: ClipConfig; vw: number; vh: number; extraOpacity: number; offsetX: number; maskRect: any; transform?: string | null }[] = [];
      for (const { clip } of activeClips) {
        const video = videoRefs.current.get(clip.id);
        // 仅 readyState>=2 不够：video.seeking 中（刚 play/seek 首帧未稳定）或尺寸为 0 时，
        // copyExternalImageToTexture 会同步抛 "doesn't have back resource"。必须一并排除。
        if (!video || video.readyState < 2 || video.seeking || video.videoWidth === 0 || video.videoHeight === 0) continue;
        const bmp = bitmapSources?.current.get(clip.id) || null;
        const source: HTMLVideoElement | ImageBitmap = bmp || video;
        const vw = bmp ? bmp.width : (video.videoWidth || canvasWidth);
        const vh = bmp ? bmp.height : (video.videoHeight || canvasHeight);
        // 出片段：转场窗内淡出（computeOutClipOpacity 窗外=1，窗内=1-progress）
        const outTr = getOutClipTransition(clip, currentTimeRef.current);
        items.push({ source, clip, vw, vh, extraOpacity: outTr.opacity, offsetX: 0, maskRect: outTr.maskRect ?? null, transform: outTr.transform ?? null });

        // 转场入片段（同轨下一片段）：转场窗内叠在出片段之上，保持出→入顺序以保证层级正确
        const inc = transitionIncomingRef.current.find((t) => t.outClipId === clip.id);
        if (inc) {
          const iv = videoRefs.current.get(inc.clip.id);
          if (iv && iv.readyState >= 2 && !iv.seeking && iv.videoWidth > 0 && iv.videoHeight > 0) {
            const ibmp = bitmapSources?.current.get(inc.clip.id) || null;
            const isource: HTMLVideoElement | ImageBitmap = ibmp || iv;
            const ivw = ibmp ? ibmp.width : (iv.videoWidth || canvasWidth);
            const ivh = ibmp ? ibmp.height : (iv.videoHeight || canvasHeight);
            items.push({ source: isource, clip: inc.clip, vw: ivw, vh: ivh, extraOpacity: inc.opacity, offsetX: inc.offsetX, maskRect: inc.maskRect ?? null, transform: inc.transform ?? null });
          }
        }
      }
      if (items.length === 0) return;

      // 用 error scope 捕获本帧所有 WebGPU 验证错误，精准拿到报错文本并决定是否回退，
      // 避免依赖全局 uncapturederror（可能含偶发良性错误而误杀整个会话）
      device.pushErrorScope('validation');
      try {
        const canvasAspect = canvasWidth / canvasHeight;
        const ctx = canvas.getContext('webgpu')!;
        const cmd = device.createCommandEncoder();
        const view = ctx.getCurrentTexture().createView();

        // 每帧创建的 GPU 资源（源纹理 / 离屏纹理 / 滤镜 uniform）。
        // 关键：这些纹理仍被本帧命令引用，submit 是异步的，GPU 还没读完时不能立刻 destroy，
        // 否则报 "Destroyed texture while calling [Queue].Submit" → 整会话退回 HTML5。
        // 因此统一收集，待 queue.onSubmittedWorkDone()（本帧真正跑完）后再销毁。
        const sourceTextures: any[] = [];
        const frameTextures: any[] = [];
        const frameBufs: any[] = [];

        // 多 pass 渲染：从底到顶依次 Over 合成
        // Pass 0: clear 黑色背景；Pass 1-N: load 保留前一 pass 结果
        items.forEach((item, idx) => {
          const { source, clip, vw, vh, extraOpacity, offsetX, maskRect } = item;

          // 蒙版合成（最小侵入式）：把「视频帧 × 蒙版 alpha」画到离屏 canvas，再上传纹理，
          // 不改动现有 WGSL shader 与 transform/opacity/滤镜管线。无启用蒙版时回退用原帧。
          let uploadSource: CanvasImageSource = source;
          const maskList = (clip.masks || []).filter((m: any) => m && m.enabled);
          if (maskList.length > 0) {
            try {
              const composed = composeMaskedFrame(source, vw, vh, maskList as MaskConfig[]);
              if (composed) uploadSource = composed;
            } catch {
              /* 合成失败则回退原帧 */
            }
          }

          // 抠像合成（最小侵入式）：在蒙版合成之后，对已合成帧再做 chroma key 离屏合成。
          // 不改动现有 WGSL shader 与后续 transform/opacity/滤镜管线。不满足条件时回退原帧。
          if (clip.keying && clip.keying.enabled && clip.keying.mode === 'chroma') {
            try {
              const keyed = applyKeying(uploadSource, vw, vh, clip.keying);
              if (keyed) uploadSource = keyed;
            } catch {
              /* 抠像失败则回退原帧 */
            }
          }

          // 智能抠像（smart）预览合成：在 chroma 分支之后。把灰度 matte 视频的 luma 作为 alpha
          // 叠加到已合成帧上。matteAssetId 存在时取当前时刻 matte 帧并与源视频同步 currentTime。
          if (clip.keying && clip.keying.enabled && clip.keying.mode === 'smart' && clip.keying.matteAssetId) {
            try {
              const srcTime = video ? video.currentTime : currentTimeRef.current;
              const srcPaused = video ? video.paused : true;
              const srcRate = video ? video.playbackRate : 1;
              const matteCanvas = getMatteFrame(clip.keying.matteAssetId, srcTime, srcPaused, srcRate, vw, vh);
              if (matteCanvas) {
                const keyed = applyMatte(uploadSource, matteCanvas, clip.keying.threshold ?? 0.5, clip.keying.edgeSoftness ?? 0.1);
                if (keyed) uploadSource = keyed;
              }
            } catch {
              /* matte 合成失败则回退原帧 */
            }
          }

          // 上传视频帧到临时纹理
          const texture = device.createTexture({
            size: [vw, vh],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
          try {
            device.queue.copyExternalImageToTexture(
              { source: uploadSource, flipY: false },
              { texture },
              [vw, vh],
            );
          } catch (err) {
            // 偶发：video 当前帧尚未稳定（刚 seek/play 首帧尚未解码到 GPU 可见状态），
            // copyExternalImageToTexture 同步抛 "doesn't have back resource"。
            // 仅跳过该层、不回退整会话——错误发生在 JS 侧校验，未进入 GPU 验证队列，
            // 不会触发 pushErrorScope 的验证错误，故不会误杀 WebGPU 会话。
            try { texture.destroy(); } catch (_) {}
            return; // forEach 回调内 return 即跳过该 item 的剩余合成
          }

          // ── 插件滤镜离屏 pass：对每个 enabled 且有 shader 的滤镜，依次渲染到离屏纹理 ──
          // 输入 = 源纹理（或上一滤镜的离屏结果），uniform = 插件参数；最终离屏结果再喂给 Over pass。
          // 这样插件 shader 只需实现"输入纹理 → 输出纹理"，无需理解 transform/opacity/合成（职责分离）。
          let srcView = texture.createView();
          const manifestMap = pluginManifestsRef.current;
          const enabledFilters = (clip.filters || []).filter(
            (f: any) => f && f.enabled && f.kind && manifestMap[f.kind] && manifestMap[f.kind].shader
          );
          if (enabledFilters.length > 0) {
            let inputView = srcView;
            for (const f of enabledFilters) {
              const manifest = manifestMap[f.kind];
              const fpipeline = getFilterPipeline(device, f.kind, manifest.shader);
              if (!fpipeline) continue;
              const offTex = device.createTexture({
                size: [vw, vh],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
              });
              frameTextures.push(offTex);
              // FilterUniforms: resolution(vec2f) + opacity(f32) + time(f32) + params: array<vec4f,16> = 272 字节
              // 参数按 manifest.parameters 顺序映射到 params[k]，Slider/Toggle/Select 取 .x，Color 取 .xyz
              const fdata = new Float32Array(68);
              fdata[0] = vw; fdata[1] = vh;
              fdata[2] = clip.transform?.opacity ?? 1.0;
              fdata[3] = 0.0; // time（预留动画类滤镜）
              (manifest.parameters || []).forEach((p: any, k: number) => {
                if (k >= 16) return;
                const raw = f.params ? f.params[p.key] : undefined;
                let val = (raw === undefined || raw === null) ? (p.default ?? 0) : raw;
                if (p.param_type === 'Slider') {
                  val = Math.max(p.min ?? val, Math.min(p.max ?? val, val));
                }
                if (p.param_type === 'Color') {
                  // f64 0xRRGGBB → 归一化 r,g,b，写入 params[k].xyz（单 vec4f 槽位容纳）
                  const int = Math.max(0, Math.min(0xffffff, Math.round(val))) | 0;
                  fdata[4 + k * 4 + 0] = ((int >> 16) & 0xff) / 255;
                  fdata[4 + k * 4 + 1] = ((int >> 8) & 0xff) / 255;
                  fdata[4 + k * 4 + 2] = (int & 0xff) / 255;
                } else {
                  fdata[4 + k * 4 + 0] = val;
                }
              });
              const fbuf = device.createBuffer({ size: 272, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
              frameBufs.push(fbuf);
              device.queue.writeBuffer(fbuf, 0, fdata);
              const fbg = device.createBindGroup({
                layout: fpipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: { buffer: fbuf } },
                  { binding: 1, resource: inputView },
                  { binding: 2, resource: sampler },
                ],
              });
              const fpass = cmd.beginRenderPass({
                colorAttachments: [{
                  view: offTex.createView(),
                  clearValue: { r: 0, g: 0, b: 0, a: 1 },
                  loadOp: 'clear',
                  storeOp: 'store',
                }],
              });
              fpass.setPipeline(fpipeline);
              fpass.setBindGroup(0, fbg);
              fpass.draw(4, 1, 0, 0);
              fpass.end();
              inputView = offTex.createView();
            }
            srcView = inputView;
          }

          // 更新 uniform：transform + params
          const t = clip.transform || {};
          // slide：入片段 transform.x 叠加归一化偏移（offsetX 0..1，1=完全偏出右侧），与 HTML5 换算一致
          const posX = (t.x ?? 0.5) + (offsetX ?? 0);
          const posY = t.y ?? 0.5;
          const scaleX = t.scale_x ?? 1.0;
          const scaleY = t.scale_y ?? 1.0;
          const rotation = ((t.rotation ?? 0) * Math.PI) / 180;
          // 出片段乘转场淡出、入片段乘转场 progress 不透明度
          const opacity = (t.opacity ?? 1.0) * (extraOpacity ?? 1.0);
          const videoAspect = vw / vh;

          const uniformBuf = uniformBufsRef.current[idx];
          const data = new Float32Array(16);
          data[0] = posX; data[1] = posY; data[2] = scaleX; data[3] = scaleY;
          data[4] = rotation; data[5] = opacity; data[6] = videoAspect; data[7] = canvasAspect;
          // maskRect：元组=矩形硬裁切；对象=圆形遮罩（mode=1）
          let mode = 0, r = 0, feather = 0;
          let rx0 = 0, ry0 = 0, rx1 = 1, ry1 = 1;
          const m = item.maskRect;
          if (m && typeof m === 'object' && !Array.isArray(m)) {
            mode = 1; r = m.r; feather = m.feather;
          } else if (Array.isArray(m)) {
            rx0 = m[0]; ry0 = m[1]; rx1 = m[2]; ry1 = m[3];
          }
          data[8] = rx0; data[9] = ry0; data[10] = rx1; data[11] = ry1;
          data[12] = mode; data[13] = r; data[14] = feather; data[15] = 0;
          // zoom 转场：把出/入片段的 scale() 折进现有用户 scale
          const zoom = parseScale(item.transform);
          if (zoom !== 1) { data[2] *= zoom; data[3] *= zoom; }
          device.queue.writeBuffer(uniformBuf, 0, data);

          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniformBuf } },
              { binding: 1, resource: srcView },
              { binding: 2, resource: sampler },
            ],
          });

          const pass = cmd.beginRenderPass({
            colorAttachments: [{
              view,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: idx === 0 ? 'clear' : 'load',
              storeOp: 'store',
            }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(4, 1, 0, 0);
          pass.end();
          // 注意：源纹理仍被本帧命令引用，不能直接 destroy！收集起来，待 submit 跑完后统一销毁（见下方 onSubmittedWorkDone）。
          sourceTextures.push(texture);
        });

        device.queue.submit([cmd.finish()]);
        // 关键修复：submit 是异步的，GPU 仍在读取这些纹理/uniform。必须等本帧命令真正跑完
        // （onSubmittedWorkDone）后再销毁，否则报 "Destroyed texture while calling [Queue].Submit"
        // 并导致整会话永久退回 HTML5。原代码在 submit 之后立刻 destroy 正是此 bug 根因。
        const toDestroyTex = [...sourceTextures, ...frameTextures];
        const toDestroyBuf = frameBufs;
        device.queue.onSubmittedWorkDone().then(() => {
          toDestroyTex.forEach((tx: any) => { try { tx.destroy(); } catch (_) {} });
          toDestroyBuf.forEach((b: any) => { try { b.destroy(); } catch (_) {} });
        });
      } catch (e: any) {
        device.popErrorScope().catch(() => {});
        failed = true;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        setError(e.message || String(e));
        console.error('[WebGPU] 渲染失败，将回退到 HTML5 video:', e);
        return;
      }
      device.popErrorScope().then((err: any) => {
        if (err) {
          failed = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
          setError(err.message || 'WebGPU 验证错误');
          console.error('[WebGPU] 渲染验证失败，将回退到 HTML5 video:', err);
        }
      });
    };

    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [enabled, ready]);

  return { ready, error };
}
