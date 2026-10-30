/**
 * 独立编译 CSS（tailwind + tokens）。
 *
 * 为什么不走 Vite 的 css.postcss：实测在 viteBuild({configFile}) 这条路径下
 * 内联 postcss 配置不生效（产物里没有 utility 类），而单独跑 postcss 完全正常。
 * 与其和构建器的配置解析较劲，不如自己明确地跑一遍。
 */
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'src/styles/app.css');
const css = await fs.readFile(src, 'utf8');

const result = await postcss([
  tailwindcss({ config: path.join(root, 'tailwind.config.ts') }),
  autoprefixer(),
]).process(css, { from: src });

await fs.writeFile(path.join(root, 'src/styles/app.generated.css'), result.css, 'utf8');
console.log(`[css] app.generated.css ${(result.css.length / 1024).toFixed(1)}kb`);
