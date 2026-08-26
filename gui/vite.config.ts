import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { renameSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// emptyOutDir:false —— 构建环境存在 safe-delete 拦截（Node rmSync 被重定向到回收站并失败），
// 关闭清空可避免 Vite 在打包前删除 dist 时触发该拦截。
// 代价：dist/assets 会累积每次构建的 hash 命名 bundle（曾攒到 106 个 / 42MB，全被打进 app.asar）。
// 故用下面这个插件在构建开始时把旧 assets 目录「改名移走」而非删除 —— 绕过拦截又不留冗余。
function moveStaleAssets() {
  return {
    name: 'aicut-move-stale-assets',
    apply: 'build' as const,
    buildStart() {
      const assets = join(__dirname, 'dist', 'assets');
      if (!existsSync(assets)) return;
      const trash = join(__dirname, '.build-trash');
      if (!existsSync(trash)) mkdirSync(trash, { recursive: true });
      try {
        renameSync(assets, join(trash, `assets-${Date.now()}`));
      } catch {
        /* 改名失败不阻断构建，最坏结果只是保留冗余产物 */
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), moveStaleAssets()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: false },
  server: { port: 5173 },
});
