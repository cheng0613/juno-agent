/**
 * 只构建主进程 + preload（dev 模式用，渲染层交给 Vite HMR）。
 */
import { build as esbuild } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

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
  logLevel: 'warning',
  plugins: [rawTextPlugin],
  external: [
    'electron',
    'better-sqlite3',
    'sharp',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
  ],
};

await esbuild({
  ...shared,
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(root, 'dist-electron/main.js'),
  format: 'esm',
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

await esbuild({
  ...shared,
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: path.join(root, 'dist-electron/preload.cjs'),
  format: 'cjs',
  logLevel: 'info',
});
