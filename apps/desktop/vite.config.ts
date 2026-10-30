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
  css: {
    // 样式已经由 postbuild-css.mjs 用 tailwind 编好（src/styles/app.generated.css）。
    // 这里不要再跑 postcss —— 双重处理会把已展开的样式再改一次。
    //
    // 为什么不用 Vite 的 css.postcss 内联配置：实测在
    // viteBuild({ configFile }) 这条路径下它不生效（产物里没有 utility 类），
    // 但单独跑 postcss 完全正常。与其和构建器较劲，不如自己明确跑一遍。
    postcss: { plugins: [] },
  },
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
