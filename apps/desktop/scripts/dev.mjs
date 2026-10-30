/**
 * 开发模式：Vite dev server + Electron 指向它。
 *
 * 为什么不分开开两个终端：改完渲染层存盘即热更新，
 * 主进程改动需要重启 electron（脚本会给提示）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

const LOCAL_DIST = 'C:/Users/chiaki/Desktop/agent/upstream/cindy/node_modules/electron/dist';

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.server.port}/`;
server.printUrls();

// 主进程 & preload 先构建一次
await import('./build-main.mjs');

const env = { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: url };
if (!env.ELECTRON_OVERRIDE_DIST_PATH && fs.existsSync(LOCAL_DIST)) {
  env.ELECTRON_OVERRIDE_DIST_PATH = LOCAL_DIST;
}

const electronPath = require('electron');
const child = spawn(electronPath, [root], { env, stdio: 'inherit' });

child.on('exit', async () => {
  await server.close();
  process.exit(0);
});
