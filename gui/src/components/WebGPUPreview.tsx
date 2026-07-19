// WebGPU Preview — Phase 5 实时预览组件
// 在 Electron WebGPU 上下文中渲染视频帧

import React, { useRef, useEffect, useCallback } from 'react';

const VERTEX_SHADER = /* wgsl */ `
@vertex fn vs_main(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return vec4f(pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var videoTexture: texture_2d<f32>;
@group(0) @binding(1) var videoSampler: sampler;

@fragment fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let uv = vec2f(coord.x / 1920.0, coord.y / 1080.0);
  return textureSample(videoTexture, videoSampler, uv);
}`;

// Color adjustment shader (亮度/对比度/饱和度)
const COLOR_ADJUST_SHADER = /* wgsl */ `
@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: vec4f; // brightness, contrast, saturation, gamma

@fragment fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let uv = vec2f(coord.x / 1920.0, coord.y / 1080.0);
  var color = textureSample(inputTexture, inputSampler, uv);
  // Apply brightness
  color.rgb += params.x;
  // Apply contrast
  color.rgb = (color.rgb - 0.5) * params.y + 0.5;
  // Apply saturation (luminance-based)
  let luma = dot(color.rgb, vec3f(0.299, 0.587, 0.114));
  color.rgb = mix(vec3f(luma), color.rgb, params.z);
  // Apply gamma
  color.rgb = pow(max(color.rgb, vec3f(0.0)), vec3f(1.0 / max(params.w, 0.01)));
  return color;
}`;

interface PreviewProps {
  width: number;
  height: number;
  videoSrc?: HTMLVideoElement | null;
  enabled: boolean;
}

export default function WebGPUPreview({ width, height, videoSrc, enabled }: PreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deviceRef = useRef<GPUDevice | null>(null);
  const pipelineRef = useRef<GPURenderPipeline | null>(null);

  const initWebGPU = useCallback(async () => {
    if (!navigator.gpu) return;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return;
    const device = await adapter.requestDevice();
    deviceRef.current = device;

    const canvas = canvasRef.current!;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('webgpu')!;
    ctx.configure({ device, format: 'bgra8unorm', alphaMode: 'premultiplied' });

    const shaderModule = device.createShaderModule({ code: FRAGMENT_SHADER });
    pipelineRef.current = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code: VERTEX_SHADER }), entryPoint: 'vs_main' },
      fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: 'bgra8unorm' }] },
      primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint16' },
    });
  }, [width, height]);

  useEffect(() => { if (enabled) initWebGPU(); }, [enabled, initWebGPU]);

  const renderFrame = useCallback(() => {
    const device = deviceRef.current;
    const pipeline = pipelineRef.current;
    const canvas = canvasRef.current;
    if (!device || !pipeline || !canvas) return;
    if (!videoSrc) return;

    const ctx = canvas.getContext('webgpu')!;
    const texture = device.createTexture({
      size: [videoSrc.videoWidth || 1920, videoSrc.videoHeight || 1080],
      format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.copyExternalImageToTexture(
      { source: videoSrc }, { texture }, [videoSrc.videoWidth || 1920, videoSrc.videoHeight || 1080]
    );

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: sampler },
      ],
    });

    const cmd = device.createCommandEncoder();
    const pass = cmd.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4, 1, 0, 0);
    pass.end();
    device.queue.submit([cmd.finish()]);
    texture.destroy();

    requestAnimationFrame(renderFrame);
  }, [videoSrc]);

  useEffect(() => {
    if (enabled && videoSrc) {
      videoSrc.addEventListener('play', () => requestAnimationFrame(renderFrame));
    }
  }, [enabled, videoSrc, renderFrame]);

  return (
    <canvas ref={canvasRef}
            style={{ width: '100%', height: '100%', background: '#000' }}
            onClick={() => videoSrc?.paused ? videoSrc.play() : videoSrc?.pause()} />
  );
}
