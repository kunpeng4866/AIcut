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

// 阻止从文件管理器拖入文件/目录时 Chromium 默认的「导航到文件/下载」行为，
// 否则拖到素材面板以外的区域会触发白屏。素材面板自身会处理导入（见 MediaPanel）。
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(<App />);
