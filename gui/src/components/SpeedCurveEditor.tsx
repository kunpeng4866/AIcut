import React, { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../store/uiStore';
import { ClipConfig, SpeedPointConfig, FreezeConfig } from '../types';

// 曲线编辑器可视化（速度曲线模型）：
//   横轴 = 播放时间(play, timeline 相对偏移 0~dur)
//   纵轴 = 速度倍率(speed, 0~SPEED_MAX；0 = 该段冻结)
// 与后端 src/pipeline/strategy.rs 的 clip_source_time / speed_integral 一一对应：
//   srcT = src_range.start + ∫₀^off speed(τ) dτ，speed 按 play 分段线性积分。
//   speed>0 时 srcT 单调推进 → 预览连续播放，绝不静止画面；speed=0 段即冻结帧。
// 交互：拖拽关键帧(限制不越过相邻点)、双击空白新增、Shift+点击删除、蓝色播放头随 currentTime 移动。

const H = 190;            // canvas CSS 高度
const PAD = 30;           // 坐标轴内边距
const HIT = 9;            // 关键帧命中半径(px)
const SPEED_MIN = 0;      // 纵轴下限（0 = 冻结）
const SPEED_MAX = 4;      // 纵轴上限（4x）

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Props {
  clip: ClipConfig;
  curve: SpeedPointConfig[];
  freeze: FreezeConfig | null;
  reverse: boolean;
  onChange: (next: SpeedPointConfig[]) => void;
  onCommit: (next: SpeedPointConfig[]) => void;
}

export function SpeedCurveEditor({ clip, curve, freeze, reverse, onChange, onCommit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const [dragOrig, setDragOrig] = useState<number | null>(null);
  const currentTime = useUIStore((s) => s.currentTime);

  const dur = Math.max(0.001, clip.timelineOut - clip.timelineIn);
  const hasCurve = curve.length > 0;

  // 始终保留最新 curve 快照，供鼠标事件构造新数组
  const curveRef = useRef(curve);
  curveRef.current = curve;

  // 按 play 升序并保留原始索引
  const points = curve.map((p, idx) => ({ ...p, idx })).sort((a, b) => a.play - b.play);

  // 响应式宽度
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(220, e.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.max(220, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const plotW = width - PAD * 2;
  const plotH = H - PAD * 2;
  // 曲线 play 为归一化 [0,1] 域（与片段绝对时长解耦）：横轴 0..1 对应整段片段
  const playToX = (play: number) => PAD + play * plotW;
  const xToPlay = (x: number) => clamp((x - PAD) / plotW, 0, 1);
  const speedToY = (speed: number) => PAD + plotH - ((speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * plotH;
  const yToSpeed = (y: number) => clamp(SPEED_MIN + ((plotH - (y - PAD)) / plotH) * (SPEED_MAX - SPEED_MIN), SPEED_MIN, SPEED_MAX);

  // 绘制
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, H);

    // 画布底色
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(PAD, PAD, plotW, plotH);

    // 网格
    ctx.strokeStyle = '#1c2530';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gx = PAD + (i / 4) * plotW;
      ctx.beginPath(); ctx.moveTo(gx, PAD); ctx.lineTo(gx, PAD + plotH); ctx.stroke();
      const gy = PAD + (i / 4) * plotH;
      ctx.beginPath(); ctx.moveTo(PAD, gy); ctx.lineTo(PAD + plotW, gy); ctx.stroke();
    }

    // 轴标签
    ctx.fillStyle = '#6b7785';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('播放时间 (s)', PAD + plotW / 2, H - 6);
    ctx.save();
    ctx.translate(10, PAD + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('速度 (x)', 0, 0);
    ctx.restore();
    // 端点数值
    ctx.textAlign = 'left';
    ctx.fillText(dur.toFixed(1), PAD + plotW - 22, PAD + plotH + 12);
    ctx.textAlign = 'right';
    ctx.fillText(SPEED_MAX.toFixed(1), PAD - 4, PAD + 10);
    ctx.fillText(SPEED_MIN.toFixed(1), PAD - 4, PAD + plotH + 10);

    // 1x 参考线（speed=1 水平虚线）
    ctx.strokeStyle = '#26323f';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD, speedToY(1));
    ctx.lineTo(PAD + plotW, speedToY(1));
    ctx.stroke();
    ctx.setLineDash([]);

    // 无曲线：冻结 / 倒放 可视化
    if (!hasCurve) {
      if (freeze) {
        // freeze.start/duration 为绝对秒（见 PropertiesPanel），画在归一化 [0,1] 轴上需除以 dur
        const fStart = dur > 1e-6 ? freeze.start / dur : 0;
        const fEnd = dur > 1e-6 ? (freeze.start + freeze.duration) / dur : 0;
        const fx0 = playToX(fStart);
        const fx1 = playToX(fEnd);
        ctx.fillStyle = 'rgba(76,201,240,0.18)';
        ctx.fillRect(fx0, PAD, Math.max(1, fx1 - fx0), plotH);
        ctx.strokeStyle = '#4cc9f0';
        ctx.lineWidth = 1;
        ctx.strokeRect(fx0, PAD, Math.max(1, fx1 - fx0), plotH);
        ctx.fillStyle = '#4cc9f0';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('冻结', fx0 + 3, PAD + 11);
      } else if (reverse) {
        ctx.strokeStyle = '#e94560';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(PAD, speedToY(1));
        ctx.lineTo(PAD + plotW, speedToY(1));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#e94560';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('REV 倒放', PAD + plotW - 4, PAD + 13);
      }
    }

    // 曲线（权威映射）：速度曲线，端点外以首/末速度水平延伸（与积分一致）
    if (hasCurve) {
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playToX(0), speedToY(points[0].speed));
      for (const p of points) ctx.lineTo(playToX(p.play), speedToY(p.speed));
      ctx.lineTo(playToX(1), speedToY(points[points.length - 1].speed));
      ctx.stroke();
    }

    // 关键帧圆点
    for (const p of points) {
      const x = playToX(p.play), y = speedToY(p.speed);
      ctx.fillStyle = dragOrig === p.idx ? '#ff8c42' : '#ffd166';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    }

    // 播放头（off 归一化到 [0,1] 与曲线 play 域一致）
    const off = dur > 1e-6 ? (currentTime - clip.timelineIn) / dur : 0;
    const offAbs = currentTime - clip.timelineIn; // 绝对偏移（秒），供冻结窗口判断（freeze.start 为绝对秒）
    if (off >= 0 && off <= 1) {
      const px = playToX(off);
      ctx.strokeStyle = '#4cc9f0';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, PAD); ctx.lineTo(px, PAD + plotH); ctx.stroke();
      // 当前速度（曲线：分段线性插值；无曲线冻结段=0，否则取 clip.speed）
      let curSpeed = 1;
      if (hasCurve) {
        if (off <= points[0].play) curSpeed = points[0].speed;
        else if (off >= points[points.length - 1].play) curSpeed = points[points.length - 1].speed;
        else {
          for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            if (off >= a.play && off <= b.play) {
              const r = (off - a.play) / (b.play - a.play || 1);
              curSpeed = a.speed + r * (b.speed - a.speed);
              break;
            }
          }
        }
      } else if (freeze && offAbs >= freeze.start && offAbs < freeze.start + freeze.duration) {
        curSpeed = 0;
      } else {
        curSpeed = clip.speed ?? 1;
      }
      const py = speedToY(curSpeed);
      ctx.fillStyle = '#4cc9f0';
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }, [width, curve, freeze, reverse, currentTime, dur, clip.timelineIn, points, hasCurve, dragOrig]);

  // ── 鼠标交互 ──
  const getPos = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
  };
  const hitTest = (mx: number, my: number): number => {
    let best = -1, bd = HIT * HIT;
    for (const p of points) {
      const dx = mx - playToX(p.play), dy = my - speedToY(p.speed);
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p.idx; }
    }
    return best;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const { mx, my } = getPos(e);
    const hit = hitTest(mx, my);
    if (hit >= 0) {
      if (e.shiftKey) {
        onCommit(curveRef.current.filter((_, i) => i !== hit));
      } else {
        setDragOrig(hit);
      }
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (dragOrig === null) return;
    const { mx, my } = getPos(e);
    let newPlay = xToPlay(mx);
    const newSpeed = yToSpeed(my);
    // 限制不越过相邻关键帧的 play（保持分段单调）
    const k = points.findIndex((p) => p.idx === dragOrig);
    const left = k > 0 ? points[k - 1].play : 0;
    const right = k < points.length - 1 ? points[k + 1].play : dur;
    newPlay = clamp(newPlay, left, right);
    onChange(curveRef.current.map((p, i) => i === dragOrig ? { play: newPlay, speed: newSpeed } : p));
  };

  const onMouseUp = () => {
    if (dragOrig !== null) onCommit(curveRef.current);
    setDragOrig(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { mx, my } = getPos(e);
    if (hitTest(mx, my) >= 0) return; // 落在点上不新增
    const newPlay = xToPlay(mx);
    const newSpeed = yToSpeed(my);
    onCommit([...curveRef.current, { play: newPlay, speed: newSpeed }]);
  };

  return (
    <div ref={wrapRef} style={{ width: '100%', marginBottom: 8 }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', borderRadius: 6, cursor: dragOrig !== null ? 'grabbing' : 'crosshair', touchAction: 'none' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={onDoubleClick}
      />
      <div style={{ color: '#888', fontSize: 10, marginTop: 3, lineHeight: 1.5 }}>
        拖拽关键帧改速度 · 双击空白添加 · Shift+点击删除 · 蓝线为播放头（蓝点=当前速度）
      </div>
    </div>
  );
}
