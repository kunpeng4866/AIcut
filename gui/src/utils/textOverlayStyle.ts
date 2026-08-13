import type { TextContent } from '../types';
import { findFontCss } from './subtitleFonts';

export type CssDict = { [k: string]: string | number | undefined };

export interface StrokeSpec {
  color: string; // rgba
  width: number; // px
}

export interface TextOverlayParts {
  wrapperStyle: CssDict; // 定位锚点（文字中心），不受背景/阴影偏移影响
  bgStyle: CssDict | null; // 背景盒：独立一层，自身 transform 相对文字偏移
  textStyle: CssDict; // 文字本体：用于 <span> 或 SVG <text>
  stroke: StrokeSpec | null; // 非 null 时用 SVG <text> 的 stroke 实现实心描边
}

// hex 颜色 -> rgba（带 alpha），用于 CSS 预览
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2) || 'ff', 16);
  const g = parseInt(h.slice(2, 4) || 'ff', 16);
  const b = parseInt(h.slice(4, 6) || 'ff', 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

/**
 * 计算文字叠加层样式，拆分为三层：
 * - wrapperStyle：锚点定位（translate(-50%,-50%) 居中），背景/阴影偏移绝不改动它
 * - bgStyle：背景盒，独立一层，通过自身 transform 相对文字偏移（文字不动）
 * - textStyle：文字本体，阴影用 text-shadow（相对文字，不移动文字定位）
 */
export function computeTextOverlayStyle(t: TextContent, scale = 1): TextOverlayParts {
  const x = t.x ?? 0.5;
  const y = t.y ?? 0.5;
  // scale：预览舞台相对真实画布的显示缩放比（frameSize.w / canvas.width）。
  // 预览叠加层定位用百分比（与画布等比），但 fontSize / 描边宽度是绝对 CSS px，
  // 必须乘 scale 才能与导出（按真实画布像素）的视觉大小一致，否则预览字会偏大。

  // 锚点：始终在 (x, y) 居中，背景/阴影偏移不影响它
  const wrapperStyle: CssDict = {
    position: 'absolute',
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    transform: 'translate(-50%, -50%)',
    zIndex: 100,
  };

  // 阴影：text-shadow 相对文字，不影响文字定位
  // 距离 + 角度极坐标：角度 0°=右，90°=下，-45°=右上；距离单位 px
  let textShadow = '0 0 10px rgba(0,0,0,0.8)';
  const sh = t.shadow;
  if (sh?.enabled) {
    const rad = (sh.angle ?? -45) * Math.PI / 180;
    const d = sh.distance ?? 5;
    const dx = Math.round(d * Math.cos(rad));
    const dy = Math.round(d * Math.sin(rad));
    const blur = Math.round((sh.blur ?? 0.15) * 30);
    textShadow = `${dx}px ${dy}px ${blur}px ${hexToRgba(sh.color || '#000000', sh.opacity ?? 0.9)}`;
  }

  const textStyle: CssDict = {
    position: 'relative',
    color: t.color || '#fff',
    fontSize: (t.fontSize || 48) * scale,
    fontFamily: findFontCss(t.fontFamily),
    textAlign: (t.textAlign || 'center') as any,
    fontWeight: (t.fontWeight as any) || 'bold',
    // 禁用浏览器伪粗体合成：无真实 Bold 文件的字体（系统字体/站酷/Bebas）用真实字面渲染，
    // 与导出端 drawtext 使用同一字体文件一致；有真实 Bold 文件（思源黑体）则走 @font-face 真粗体。
    fontSynthesis: 'none',
    textShadow,
    pointerEvents: 'auto',
    cursor: 'pointer',
    zIndex: 2,
  };

  // 描边：用 WebkitTextStroke + paint-order: stroke fill 实现实心填充描边（先描边后填充，避免 -webkit-text-stroke 的镂空效果）。
  // 不使用 SVG，避免根 SVG overflow 裁剪导致文字在调描边数值时消失。
  let stroke: StrokeSpec | null = null;
  if (t.strokeWidth && t.strokeWidth > 0) {
    const strokeColor = hexToRgba(t.strokeColor || '#000000', t.strokeOpacity ?? 1);
    textStyle.WebkitTextStroke = `${t.strokeWidth * scale}px ${strokeColor}`;
    textStyle.paintOrder = 'stroke fill';
    stroke = { color: strokeColor, width: t.strokeWidth * scale };
  }

  // 背景：独立一层，相对文字偏移（绝不移动文字）
  let bgStyle: CssDict | null = null;
  const bg = t.background;
  if (bg?.enabled) {
    const padH = Math.round((bg.width ?? 0.19) * 100);
    const padV = Math.round((bg.height ?? 0.13) * 100);
    const radius = Math.round((bg.radius ?? 0.06) * 50);
    const offX = Math.round(((bg.offsetX ?? 0.5) - 0.5) * 200);
    const offY = Math.round(((bg.offsetY ?? 0.5) - 0.5) * 200);
    bgStyle = {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: `calc(100% + ${2 * padH}px)`,
      height: `calc(100% + ${2 * padV}px)`,
      transform: `translate(-50%, -50%) translate(${offX}px, ${offY}px)`,
      background: hexToRgba(bg.color || '#000000', bg.opacity ?? 0.9),
      borderRadius: `${radius}px`,
      pointerEvents: 'none',
      zIndex: 1,
    };
  }

  return { wrapperStyle, bgStyle, textStyle, stroke };
}
