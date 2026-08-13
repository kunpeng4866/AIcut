// @ts-nocheck
import { computeTextOverlayStyle } from './textOverlayStyle';
import type { TextContent } from '../types';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); }
  else { console.log('PASS: ' + msg); }
}

const base: TextContent = {
  content: '标题', fontSize: 48, color: '#ffffff', textAlign: 'center', x: 0.5, y: 0.5,
  background: { enabled: true, color: '#000000', opacity: 0.9, radius: 0.06, width: 0.19, height: 0.13, offsetX: 0.5, offsetY: 0.5 },
  shadow: { enabled: true, color: '#000000', opacity: 0.9, blur: 0.15, distance: 5, angle: -45 },
};

// 1) 背景偏移为 0（offset 0.5）时，背景层不偏移
{
  const p = computeTextOverlayStyle(base);
  assert(p.bgStyle !== null, '背景开启时应有 bgStyle');
  assert((p.bgStyle!.transform as string).includes('translate(0px, 0px)'), '背景 offset=0.5 时位移应为 0px');
}

// 2) 调整背景左右偏移：文字锚点（wrapper）不变，仅背景层 transform 变
{
  const a = computeTextOverlayStyle(base);
  const b = computeTextOverlayStyle({ ...base, background: { ...base.background!, offsetX: 0.7 } });
  assert(
    JSON.stringify(a.wrapperStyle) === JSON.stringify(b.wrapperStyle),
    '调整背景偏移时 wrapper（文字锚点）定位不得变化',
  );
  assert(
    (a.bgStyle!.transform as string) !== (b.bgStyle!.transform as string),
    '调整背景偏移时背景层 transform 必须变化',
  );
  assert((b.bgStyle!.transform as string).includes('translate(40px'), '背景向右偏移应产生正 translateX');
}

// 3) 调整背景上下偏移：文字锚点不变
{
  const a = computeTextOverlayStyle(base);
  const c = computeTextOverlayStyle({ ...base, background: { ...base.background!, offsetY: 0.3 } });
  assert(
    JSON.stringify(a.wrapperStyle) === JSON.stringify(c.wrapperStyle),
    '调整背景上下偏移时 wrapper（文字锚点）定位不得变化',
  );
  assert((c.bgStyle!.transform as string).includes('translate(0px, -40px)'), '背景向上偏移应产生负 translateY', );
}

// 4) 阴影距离+角度只改 text-shadow，不动 wrapper 与 bgStyle
{
  const a = computeTextOverlayStyle(base);
  const d = computeTextOverlayStyle({ ...base, shadow: { ...base.shadow!, distance: 22.36, angle: 26.565 } });
  assert((d.textStyle.textShadow as string).startsWith('20px 10px'), '阴影距离+角度应解析为相对文字偏移（+20,+10）');
  assert(
    JSON.stringify(a.wrapperStyle) === JSON.stringify(d.wrapperStyle),
    '调整阴影距离/角度时 wrapper（文字锚点）定位不得变化',
  );
  assert(
    JSON.stringify(a.bgStyle) === JSON.stringify(d.bgStyle),
    '调整阴影距离/角度时背景层不得变化',
  );
}

// 5) 背景关闭时不渲染背景层
{
  const p = computeTextOverlayStyle({ ...base, background: { ...base.background!, enabled: false } });
  assert(p.bgStyle === null, '背景关闭时不应有 bgStyle');
}

// 6) 描边必须用 CSS WebkitTextStroke + paint-order: stroke fill（实心填充，文字始终可见）
{
  const a = computeTextOverlayStyle({ ...base, strokeWidth: 2, strokeColor: '#ff0000', strokeOpacity: 1 });
  assert(a.stroke !== null, '描边开启时 stroke 不应为 null（用于导出/兼容）');
  assert(a.stroke!.color === 'rgba(255,0,0,1)', '描边不透明=1 时应为不透明红色');
  assert(a.stroke!.width === 2, '描边宽度应原样返回');
  assert(a.textStyle.WebkitTextStroke === '2px rgba(255,0,0,1)', '描边应写入 WebkitTextStroke（实心填充，非 SVG）');
  assert(a.textStyle.paintOrder === 'stroke fill', '描边应设 paint-order: stroke fill 避免镂空');
  const b = computeTextOverlayStyle({ ...base, strokeWidth: 2, strokeColor: '#ff0000', strokeOpacity: 0.5 });
  assert(b.textStyle.WebkitTextStroke === '2px rgba(255,0,0,0.5)', '描边不透明=0.5 时应为半透明红色');
}

// 7) 无描边时不应有任何 WebkitTextStroke
{
  const p = computeTextOverlayStyle(base);
  assert(p.stroke === null, '未设置描边时 stroke 应为 null');
  assert(p.textStyle.WebkitTextStroke === undefined, '未设置描边时不应有 WebkitTextStroke');
  assert(p.textStyle.paintOrder === undefined, '未设置描边时不应有 paintOrder');
}

if (failures > 0) { console.error(`\n${failures} 个断言失败`); process.exit(1); }
else { console.log('\n全部断言通过'); }
