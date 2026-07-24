// 速度曲线纯函数：与后端 src/pipeline/strategy.rs::speed_integral 逐字节一致。
// 曲线模型为「绝对速度」：speed 是用户设定的速度倍率（2.0 = 2×），
// 片段时间线长由调用方按曲线平均速率反向推导（见 store.setCurveCommit），
// 使 ∫₀^dur speed dτ = srcDur —— 整段素材恰好在 dur 内播完，绝不越界定格。

export interface SpeedPoint {
  play: number;
  speed: number;
}

// 原始积分 ∫₀^off speed(τ) dτ（梯形，相对 srcStart=0）。
// speed 按 play 分段线性插值；段 [0, 首点.play] 以首点速度恒定；超出末点以末点速度外延。
export function rawSpeedIntegral(curve: SpeedPoint[], off: number): number {
  if (!curve || curve.length === 0) return 0;
  const pts = [...curve].sort((a, b) => a.play - b.play);
  if (off <= pts[0].play) return Math.max(off, 0) * pts[0].speed;
  let acc = pts[0].play * pts[0].speed; // 段 [0, 首点.play] 以首点速度恒定
  let lastPlay = pts[0].play;
  let lastSpeed = pts[0].speed;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const span = b.play - a.play;
    if (off <= b.play) {
      const frac = span < 1e-12 ? 0 : (off - a.play) / span;
      const speedOff = a.speed + (b.speed - a.speed) * frac;
      acc += (a.speed + speedOff) / 2 * (off - a.play);
      return acc;
    }
    if (span >= 1e-12) acc += (a.speed + b.speed) / 2 * span;
    lastPlay = b.play;
    lastSpeed = b.speed;
  }
  if (off > lastPlay) acc += (off - lastPlay) * lastSpeed; // 超出末点：以末点速度外延
  return acc;
}

// 曲线在 play 偏移 off 处的「瞬时原始速度」（分段线性插值，非积分）。
export function rawSpeedAt(curve: SpeedPoint[], off: number): number {
  if (!curve || curve.length === 0) return 1;
  const pts = [...curve].sort((a, b) => a.play - b.play);
  if (off <= pts[0].play) return pts[0].speed;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (off <= b.play) {
      const span = b.play - a.play;
      const frac = span < 1e-12 ? 0 : (off - a.play) / span;
      return a.speed + (b.speed - a.speed) * frac;
    }
  }
  return pts[pts.length - 1].speed;
}
