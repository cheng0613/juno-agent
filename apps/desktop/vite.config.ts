import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = import.meta.dirname;
// design/ 在 app 之外，dev server 需要显式放行
const designDir = path.resolve(root, '../../design');

export default defineConfig({
  root: '.',
  base: './', // file:// 下必须相对路径，否则打包后白屏
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: {
    port: 5273,
    strictPort: true,
    fs: { allow: [root, designDir] },
  },
});
