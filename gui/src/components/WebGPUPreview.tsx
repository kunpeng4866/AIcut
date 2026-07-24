// @ts-nocheck — WebGPU 类型未安装（Phase 5 M3）
// useWebGPUPreview — WebGPU 实时视频预览 hook（多轨道纹理叠加）
// 负责：设备初始化、WGSL 渲染管线、rAF 渲染循环（多视频帧上传→多 pass Over 合成→渲染）、资源清理
import { useEffect, useRef, useState } from 'react';
import type { ClipConfig, AssetConfig } from '../types';

// ── WGSL 着色器 ──
// Uniform 32 字节：transform(vec4f) + params(vec4f)
//   transform: x=posX, y=posY, z=scaleX, w=scaleY（归一化）
//   params:    x=rotation(rad), y=opacity, z=videoAspect, w=canvasAspect
const WGSL_SHADER = /* wgsl */ `
struct Uniforms {
  transform: vec4f,
  params: vec4f,
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
  return vec4f(color.rgb, color.a * u.params.y);
}
`;

// 最大支持 4 个视频轨道叠加
const MAX_CLIPS = 4;

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
}

/**
 * WebGPU 实时视频预览 hook（多轨道叠加）。
 * 启用时创建设备+管线，rAF 循环从多个 <video> 上传帧到各自 GPU 纹理，
 * 按 Over 合成（src-over blend）从底到顶依次渲染到 canvas。
 * 卸载或禁用时销毁所有 GPU 资源。
 */
export function useWebGPUPreview({
  canvasRef, videoRefs, bitmapSources, canvasWidth, canvasHeight, clips, enabled, pluginManifests,
}: UseWebGPUPreviewOptions) {
  const deviceRef = useRef<GPUDevice | null>(null);
  const pipelineRef = useRef<GPURenderPipeline | null>(null);
  const uniformBufsRef = useRef<GPUBuffer[]>([]);
  const samplerRef = useRef<GPUSampler | null>(null);
  const rafRef = useRef<number | null>(null);
  const clipsRef = useRef<ActiveVideoClip[]>(clips);
  // 插件滤镜：清单（按 id 索引，含内联 WGSL shader）、管线缓存、编译失败集合
  const pluginManifestsRef = useRef<Record<string, any>>({});
  const filterPipelinesRef = useRef<Map<string, GPURenderPipeline>>(new Map());
  const filterFailedRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 保存最新 clips 到 ref，避免每帧重建渲染循环
  useEffect(() => { clipsRef.current = clips; }, [clips]);

  // 保存最新插件清单到 ref，供渲染循环读取（避免每帧重建）
  useEffect(() => { pluginManifestsRef.current = pluginManifests ?? {}; }, [pluginManifests]);

  // 编译并缓存插件滤镜渲染管线（按 kind）。编译失败则标记 failed，后续跳过该滤镜（降级为原图）。
  // 插件 shader 绑定契约（硬约束）：@group(0) @binding(0)=uniform, 1=texture_2d<f32>, 2=sampler。
  const getFilterPipeline = (device: any, kind: string, shaderSrc: string): GPURenderPipeline | null => {
    if (filterFailedRef.current.has(kind)) return null;
    const cached = filterPipelinesRef.current.get(kind);
    if (cached) return cached;
    try {
      const module = device.createShaderModule({ code: shaderSrc });
      const p = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip' },
      });
      filterPipelinesRef.current.set(kind, p);
      return p;
    } catch (e: any) {
      console.error('[WebGPU] 插件 shader 编译失败，预览跳过该滤镜:', kind, e?.message || e);
      filterFailedRef.current.add(kind);
      return null;
    }
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
        device.addEventListener('uncapturederror', (e: any) => {
          console.error('[WebGPU] uncaptured error:', e.error.message);
          setError(e.error.message || 'WebGPU 验证错误');
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
          device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
      deviceRef.current?.destroy();
      deviceRef.current = null;
      setReady(false);
    };
  }, [enabled, canvasWidth, canvasHeight]);

  // ── rAF 渲染循环（多 pass Over 合成）──
  useEffect(() => {
    if (!enabled || !ready) return;

    let failed = false;
    const render = () => {
      if (failed) return;
      rafRef.current = requestAnimationFrame(render);
      try {
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
        const items: { source: HTMLVideoElement | ImageBitmap; clip: ClipConfig; vw: number; vh: number }[] = [];
        for (const { clip } of activeClips) {
          const video = videoRefs.current.get(clip.id);
          if (!video || video.readyState < 2) continue;
          const bmp = bitmapSources?.current.get(clip.id) || null;
          const source: HTMLVideoElement | ImageBitmap = bmp || video;
          const vw = bmp ? bmp.width : (video.videoWidth || canvasWidth);
          const vh = bmp ? bmp.height : (video.videoHeight || canvasHeight);
          items.push({ source, clip, vw, vh });
        }
        if (items.length === 0) return;

        const canvasAspect = canvasWidth / canvasHeight;
        const ctx = canvas.getContext('webgpu')!;
        const cmd = device.createCommandEncoder();
        const view = ctx.getCurrentTexture().createView();

        // 每帧创建的离屏纹理 / 滤镜 uniform，提交后统一销毁（源纹理已在循环内各自 destroy）
        const frameTextures: any[] = [];
        const frameBufs: any[] = [];

        // 多 pass 渲染：从底到顶依次 Over 合成
        // Pass 0: clear 黑色背景；Pass 1-N: load 保留前一 pass 结果
        items.forEach((item, idx) => {
          const { source, clip, vw, vh } = item;

          // 上传视频帧到临时纹理
          const texture = device.createTexture({
            size: [vw, vh],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
          device.queue.copyExternalImageToTexture(
            { source, flipY: false },
            { texture },
            [vw, vh],
          );

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
          const posX = t.x ?? 0.5;
          const posY = t.y ?? 0.5;
          const scaleX = t.scale_x ?? 1.0;
          const scaleY = t.scale_y ?? 1.0;
          const rotation = ((t.rotation ?? 0) * Math.PI) / 180;
          const opacity = t.opacity ?? 1.0;
          const videoAspect = vw / vh;

          const uniformBuf = uniformBufsRef.current[idx];
          const data = new Float32Array(8);
          data[0] = posX; data[1] = posY; data[2] = scaleX; data[3] = scaleY;
          data[4] = rotation; data[5] = opacity; data[6] = videoAspect; data[7] = canvasAspect;
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
          texture.destroy();
        });

        device.queue.submit([cmd.finish()]);
        // 提交后销毁本帧离屏纹理 / 滤镜 uniform（源纹理已在循环内各自 destroy）
        frameTextures.forEach((tx: any) => tx.destroy());
        frameBufs.forEach((b: any) => b.destroy());
      } catch (e: any) {
        failed = true;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        setError(e.message || String(e));
        console.error('[WebGPU] 渲染失败，将回退到 HTML5 video:', e);
      }
    };

    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [enabled, ready]);

  return { ready, error };
}
