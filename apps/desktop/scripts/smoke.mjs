/**
 * 启动冒烟测试：起 Electron，等几秒，检查主进程日志与窗口是否创建，然后精确杀掉自己的进程树。
 *
 * 注意：只按 PID 树终止，绝不用 taskkill /IM —— 系统里还有 Cindy 自己的 pi.exe。
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const logPath = path.join(root, 'dist-electron', 'smoke.log');

const LOCAL_DIST = 'C:/Users/chiaki/Desktop/agent/upstream/cindy/node_modules/electron/dist';
const env = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: '1',
  APP_APPROVAL: 'ipc',
  APP_DATA_DIR: path.join(root, '.smoke-data'),
  APP_PI_API_KEY: process.env.APP_PI_API_KEY ?? 'sk-smoke-not-used',
};
if (fs.existsSync(LOCAL_DIST)) env.ELECTRON_OVERRIDE_DIST_PATH = LOCAL_DIST;

const electronPath = require('electron');
const out = fs.openSync(logPath, 'w');
const child = spawn(electronPath, [root], { env, stdio: ['ignore', out, out] });

const waitMs = Number(process.argv[2] ?? 9000);

setTimeout(() => {
  let log = '';
  try {
    log = fs.readFileSync(logPath, 'utf8');
  } catch {}

  const lines = log.split('\n').filter(Boolean);
  const markers = {
    'host ready': lines.some((l) => l.includes('host ready')),
    'db opened': lines.some((l) => l.includes('db ready') || l.includes('app.db')),
    'pi binary': lines.some((l) => l.includes('pi binary') || l.includes('pi-spawn')),
    'GPU/render': lines.some((l) => /gpu|vulkan|d3d|renderer/i.test(l)),
    error: lines.some((l) => /error|failed|exception|ENOENT/i.test(l)),
  };

  console.log('--- 关键标记 ---');
  for (const [k, v] of Object.entries(markers)) console.log(`  ${v ? '✓' : '·'} ${k}`);

  console.log('\n--- 日志尾部 ---');
  console.log(lines.slice(-18).join('\n'));

  // 精确终止自己的进程树
  try {
    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
  } catch {}
  process.exit(markers['host ready'] ? 0 : 1);
}, waitMs);
