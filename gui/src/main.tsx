import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { injectBundledFontFaces } from './utils/subtitleFonts';

// 注入内置字体 @font-face，使预览使用随包分发的字体文件（离线、与导出一致）。
// dev 模式下字体目录由主进程从仓库 public/fonts 提供；打包模式从 resources/fonts 提供。
const aicutApi = (window as any).aicut;
if (aicutApi?.getFontsDir) {
  aicutApi.getFontsDir().then((dir: string) => injectBundledFontFaces(dir)).catch(() => injectBundledFontFaces(''));
} else {
  injectBundledFontFaces('');
}

createRoot(document.getElementById('root')!).render(<App />);
