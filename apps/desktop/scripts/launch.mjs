/**
 * 启动 Electron。
 *
 * 本机已经有 Electron 42 的二进制（在 upstream 仓库里），
 * 所以安装时跳过了 90MB 下载，用 ELECTRON_OVERRIDE_DIST_PATH 指过去。
 * 换机器或提交到 CI 时把这一行删掉让 electron 自己下载即可。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

const LOCAL_DIST = 'C:/Users/chiaki/Desktop/agent/upstream/cindy/node_modules/electron/dist';

const env = { ...process.env };
if (!env.ELECTRON_OVERRIDE_DIST_PATH && fs.existsSync(LOCAL_DIST)) {
  env.ELECTRON_OVERRIDE_DIST_PATH = LOCAL_DIST;
  console.log(`[launch] 复用本地 Electron 二进制: ${LOCAL_DIST}`);
}

let electronPath;
try {
  electronPath = require('electron');
} catch (error) {
  console.error('[launch] 找不到 electron，请先 pnpm install');
  throw error;
}

if (typeof electronPath !== 'string') {
  console.error('[launch] electron 未安装二进制，请去掉 ELECTRON_SKIP_BINARY_DOWNLOAD 重装');
  process.exit(1);
}

const child = spawn(electronPath, [root], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code ?? 0));
