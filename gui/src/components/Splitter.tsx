// Splitter — 可复用拖拽分隔条组件
// direction: 'horizontal' = 左右拖拽（调整宽度）, 'vertical' = 上下拖拽（调整高度）
// onDrag 回调接收相对于上一帧的增量 delta（像素），调用方用 set(w => w + delta) 更新
import React, { useCallback } from 'react';

interface SplitterProps {
  direction: 'horizontal' | 'vertical';
  onDrag: (delta: number) => void;
}

export default function Splitter({ direction, onDrag }: SplitterProps) {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let lastPos = direction === 'horizontal' ? e.clientX : e.clientY;

    const onMove = (ev: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const delta = currentPos - lastPos;
      lastPos = currentPos;
      onDrag(delta);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = direction === 'horizontal' ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [direction, onDrag]);

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        [direction === 'horizontal' ? 'width' : 'height']: 4,
        background: 'transparent',
        cursor: direction === 'horizontal' ? 'ew-resize' : 'ns-resize',
        transition: 'background 0.15s',
      } as React.CSSProperties}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(233, 69, 96, 0.3)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    />
  );
}
