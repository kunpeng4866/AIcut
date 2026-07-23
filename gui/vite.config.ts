import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // emptyOutDir:false —— 构建环境存在 safe-delete 拦截（Node rmSync 被重定向到回收站并失败），
  // 关闭清空可避免 Vite 在打包前删除 dist 时触发该拦截；dist 内容由本命令手动先清空。
  build: { outDir: 'dist', emptyOutDir: false },
  server: { port: 5173 },
});
