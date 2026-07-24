// 转场预览计算（与 src/pipeline/export.rs::render_video_frame 的转场逻辑镜像）
// 转场数据模型：clip.transition 挂在"出片段"上，作用于本片段结尾与同轨下一片段之间。
//   transitionType: 'none' | 'fade' | 'dissolve' | 'slide'
//   duration: 秒（转场窗长度），默认 0.5
// 转场窗：[timelineOut - duration, timelineOut)
import { ClipConfig, TrackConfig } from '../types';

export interface TransitionPreviewLayer {
  clip: ClipConfig; // 入片段（同轨下一片段，在转场窗内被提前叠到出片段上方）
  trackId: string;
  opacity: number; // 入片段在当前时刻的不透明度（0→1）
  // 归一化偏移：相对舞台宽/高，0..1。slide 时从右侧外（1）滑入归位（0）。
  // 子代理渲染时按舞台像素尺寸换算（HTML5: offsetX * stageWidth；WebGPU: 按自身坐标系换算）。
  offsetX: number;
  offsetY: number;
  zIndex: number;
}

const DEFAULT_DUR = 0.5;

function transitionOf(clip: ClipConfig) {
  const tr = clip.transition;
  if (!tr || tr.transitionType === undefined || tr.transitionType === 'none') return null;
  const dur = tr.duration && tr.duration > 0 ? tr.duration : DEFAULT_DUR;
  return { type: tr.transitionType, dur };
}

// 出片段在转场窗内的不透明度：窗外 = 1（无影响），窗内 = 1 - progress（淡出）。
export function computeOutClipOpacity(outClip: ClipConfig, currentTime: number): number {
  const tr = transitionOf(outClip);
  if (!tr) return 1;
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return 1;
  const progress = (currentTime - (outT - tr.dur)) / tr.dur; // 0 -> 1
  return 1 - progress;
}

// 给定某轨在 currentTime 的"出片段"（当前活跃片段），计算转场附加的入片段层。
// 返回 null = 不在转场窗 / 无转场 / 找不到同轨下一片段。
export function getIncomingTransitionLayer(
  track: TrackConfig,
  outClip: ClipConfig,
  currentTime: number,
): TransitionPreviewLayer | null {
  const tr = transitionOf(outClip);
  if (!tr) return null;
  const outT = outClip.timelineOut;
  if (currentTime < outT - tr.dur || currentTime >= outT) return null;
  const progress = (currentTime - (outT - tr.dur)) / tr.dur; // 0 -> 1
  // 同轨下一片段：timelineIn 最接近 outT（邻接）的那个
  const next = [...track.clips]
    .filter((c) => c.id !== outClip.id && c.timelineIn >= outT - 1e-4)
    .sort((a, b) => a.timelineIn - b.timelineIn)[0];
  if (!next) return null;

  let offsetX = 0;
  let offsetY = 0;
  if (tr.type === 'slide') {
    // 从右侧滑入：起始在最右外（1 个舞台宽），结束归位（0）
    offsetX = 1 - progress;
  }
  // fade 与 dissolve 在预览中等价：纯 opacity 交叉（导出侧 dissolve 也是 opacity 交叉）
  return {
    clip: next,
    trackId: track.id,
    opacity: progress,
    offsetX,
    offsetY,
    zIndex: 102, // 盖在出片段之上
  };
}
