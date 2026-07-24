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
}

/**
 * WebGPU 实时视频预览 hook（多轨道叠加）。
 * 启用时创建设备+管线，rAF 循环从多个 <video> 上传帧到各自 GPU 纹理，
 * 按 Over 合成（src-over blend）从底到顶依次渲染到 canvas。
 * 卸载或禁用时销毁所有 GPU 资源。
 */
export function useWebGPUPreview({
  canvasRef, videoRefs, bitmapSources, canvasWidth, canvasHeight, clips, enabled,
}: UseWebGPUPreviewOptions) {
  const deviceRef = useRef<GPUDevice | null>(null);
  const pipelineRef = useRef<GPURenderPipeline | null>(null);
  const uniformBufsRef = useRef<GPUBuffer[]>([]);
  const samplerRef = useRef<GPUSampler | null>(null);
  const rafRef = useRef<number | null>(null);
  const clipsRef = useRef<ActiveVideoClip[]>(clips);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 保存最新 clips 到 ref，避免每帧重建渲染循环
  useEffect(() => { clipsRef.current = clips; }, [clips]);

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
              { binding: 1, resource: texture.createView() },
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
