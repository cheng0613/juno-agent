/**
 * 构建：渲染层走 Vite，主进程/preload 走 esbuild。
 *
 * 为什么不全用 Vite：主进程要 ESM + node 外部依赖，preload 要 CJS（sandbox 限制），
 * 两个 target 完全不同。esbuild 两行就能搞定，比配 Vite 的多入口 + SSR 模式省事。
 */
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** maker-core 用的 Vite 专有 `?raw` 语法，需由 bundler 提供 */
const rawTextPlugin = {
  name: 'md-raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'md-raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'md-raw' }, async (args) => {
      const text = await fs.readFile(args.path, 'utf8');
      return { contents: `export default ${JSON.stringify(text)};`, loader: 'js' };
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  plugins: [rawTextPlugin],
  external: [
    'electron',
    'better-sqlite3',
    'sharp',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
  ],
};

// 0) 先编 CSS：tailwind 在 Vite 的 css.postcss 里不生效（实测），单独跑一遍
//    postbuild-css.mjs 在 app 根目录（不是 scripts/），Windows 下需 file:// URL
await import(new URL('../postbuild-css.mjs', import.meta.url).href);

// 1) 渲染层
await viteBuild({ configFile: path.join(root, 'vite.config.ts') });

// 2) 主进程（ESM）
//    gray-matter / parse5 / diff 是 CJS，打进 ESM 后它们的 require('fs') 会炸，
//    除非先把 require 注入回来。这行 banner 就是干这个的。
await esbuild({
  ...shared,
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(root, 'dist-electron/main.js'),
  format: 'esm',
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

// 3) preload（CJS —— sandbox 下的硬性要求）
await esbuild({
  ...shared,
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: path.join(root, 'dist-electron/preload.cjs'),
  format: 'cjs',
});

console.log('\n构建完成：dist/ (渲染层) + dist-electron/ (主进程/preload)');
