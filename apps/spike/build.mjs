/**
 * Spike 构建脚本。
 *
 * 存在的唯一原因：maker-core 的 4 个文件用了 Vite 的 `import x from './y.md?raw'` 语法
 * （见 packages/maker-core/src/types/md-raw.d.ts）。这套语法依赖 bundler 提供，
 * 裸 Node / tsx 都无法解析。
 *
 * 真实产品里由 Vite 处理；spike 阶段用 esbuild + 一个 20 行插件等价解决，
 * 顺便证明「换个 bundler 也能跑」——即这 6 处 ?raw 是唯一需要适配的打包边界。
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 把 `./x.md?raw` 解析成「导出文件内容字符串」的虚拟模块 */
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

await build({
  entryPoints: {
    main: 'src/main.ts',
    selftest: 'src/selftest.ts',
    probeCompact: 'src/probeCompact.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  sourcemap: true,
  plugins: [rawTextPlugin],
  // 只把「带原生二进制 / CJS 动态 require / 体量大」的依赖留作外部。
  // workspace 的 @cindy/* 全部打进 bundle —— 这正好验证 vendored 源码能否独立打包。
  external: [
    'better-sqlite3',
    'sharp',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
    'parse5',
    'gray-matter',
    'diff',
  ],
  logLevel: 'info',
});
