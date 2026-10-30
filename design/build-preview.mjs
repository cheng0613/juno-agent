/**
 * 把 tokens.css 注入预览模板，产出单文件 preview.html。
 *
 * 存在的意义：预览页必须自包含（手机/远端直接打开），但 token 只能有一份源。
 * 每次改完 tokens.css 重跑即可，避免"预览和实际不一致"这种经典事故。
 *
 * 用法：node build-preview.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const here = import.meta.dirname;
const tokens = await fs.readFile(path.join(here, 'tokens.css'), 'utf8');
const tpl = await fs.readFile(path.join(here, 'preview.template.html'), 'utf8');

const marker = '/*__TOKENS__*/';
if (!tpl.includes(marker)) {
  throw new Error(`模板里找不到注入点 ${marker}`);
}

const out = tpl.replace(marker, tokens);
await fs.writeFile(path.join(here, 'preview.html'), out, 'utf8');

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`preview.html 已生成 (${kb} KB, 自包含单文件)`);
