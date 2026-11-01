/**
 * 比对我们的 tokens 和 Cindy 源文件的差异。
 *
 * 结论用来看「配色是否已经完全复刻」——如果差异是 0，
 * 那主题配色这块就是原样照搬，不用再对。
 */
import fs from 'node:fs';

const CINDY = 'C:/Users/chiaki/Desktop/agent/upstream/cindy/packages/design-tokens/src/out-tokens.css';
const OURS = 'apps/desktop/src/styles/tokens.css';

function parse(file, selector) {
  const s = fs.readFileSync(file, 'utf8');
  const i = s.indexOf(selector);
  if (i < 0) return {};
  const start = s.indexOf('{', i) + 1;
  const end = s.indexOf('\n}', start);
  const out = {};
  for (const line of s.slice(start, end).split('\n')) {
    const m = line.match(/^\s*(--[a-z0-9-]+):\s*(.+?);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

for (const [label, sel] of [
  ['浅色', ':root {'],
  ['深色', '.dark {'],
]) {
  const c = parse(CINDY, sel);
  const o = parse(OURS, sel);
  const keys = Object.keys(c);
  const diffs = keys.filter((k) => o[k] !== c[k]);
  console.log(`\n=== ${label}：${diffs.length} 处差异 / 共 ${keys.length} 个角色 ===`);
  for (const k of diffs.slice(0, 20)) {
    console.log(`  ${k}`);
    console.log(`    cindy: ${c[k]}`);
    console.log(`    ours : ${o[k] ?? '(缺失)'}`);
  }
  if (diffs.length > 20) console.log(`  …还有 ${diffs.length - 20} 处`);
}
