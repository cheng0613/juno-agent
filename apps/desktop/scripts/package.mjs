/**
 * 打包成 Windows 可分发产物。
 *
 * 为什么先「摆一个 staging 目录」再交给 electron-builder：
 * pnpm 的 node_modules 是符号链接森林，electron-builder 追依赖时经常抓不全原生模块。
 * 我们自己把该带的东西实体化拷进去，让 builder 只负责套壳，行为完全可预测。
 *
 * 用法：
 *   node scripts/package.mjs            → release/out/win-unpacked（可直接运行，验证用）
 *   node scripts/package.mjs --installer → 另外产出 NSIS 安装包
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(root, '../../..');
const stage = path.join(root, 'release/stage');
const outDir = path.join(root, 'release/out');

const ELECTRON_VERSION = '42.11.12';
// 复用仓库里已有的 electron 二进制，省掉一次 100MB 下载
const LOCAL_ELECTRON_DIST = path.join(
  repoRoot,
  'upstream/cindy/node_modules/electron/dist',
);
const PI_BIN = path.join(repoRoot, `upstream/cindy/apps/pi-bin/${process.platform === 'win32' ? 'win32-x64' : 'linux-x64'}/pi.exe`);

const withInstaller = process.argv.includes('--installer');

function copyDir(from, to) {
  if (!fs.existsSync(from)) throw new Error(`缺少构建产物: ${from}\n先跑 node scripts/build.mjs`);
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

// ---------------------------------------------------------------- 1. 组装
console.log('→ 清理 staging');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

console.log('→ 拷贝渲染层与主进程');
copyDir(path.join(root, 'dist'), path.join(stage, 'dist'));
copyDir(path.join(root, 'dist-electron'), path.join(stage, 'dist-electron'));
// 源码映射对使用者没用，只会让包变大
for (const dir of ['dist-electron']) {
  for (const f of fs.readdirSync(path.join(stage, dir))) {
    if (f.endsWith('.map') || f.endsWith('.log')) fs.rmSync(path.join(stage, dir, f));
  }
}

console.log('→ 拷贝 better-sqlite3（原生模块要解链接成实体文件）');
const bs3Pkg = require.resolve('better-sqlite3/package.json');
copyDir(path.dirname(bs3Pkg), path.join(stage, 'node_modules/better-sqlite3'));

// better-sqlite3 v13 用预编译产物（prebuilds/<platform>-<arch>.node），不靠 node-gyp 现场编译。
// 确认本平台那份真的在，不然打包成功但一启动就炸。
const prebuilt = path.join(
  stage,
  `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`,
);
if (!fs.existsSync(prebuilt)) {
  throw new Error(`better-sqlite3 原生绑定缺失: ${prebuilt}`);
}
console.log(`  原生绑定 ${(fs.statSync(prebuilt).size / 1024 / 1024).toFixed(1)} MB`);

// 只留本平台：别的平台的 .node、C 源码和 sqlite amalgamation 白白占几十 MB
const bs3Dir = path.join(stage, 'node_modules/better-sqlite3');
for (const entry of fs.readdirSync(path.join(bs3Dir, 'prebuilds'))) {
  if (`prebuilds/${entry}` !== `prebuilds/${process.platform}-${process.arch}.node`) {
    fs.rmSync(path.join(bs3Dir, 'prebuilds', entry), { force: true });
  }
}
for (const junk of ['deps', 'src', 'binding.gyp']) {
  fs.rmSync(path.join(bs3Dir, junk), { recursive: true, force: true });
}

console.log('→ 拷贝 pi 二进制');
if (!fs.existsSync(PI_BIN)) throw new Error(`找不到 pi 二进制: ${PI_BIN}`);
fs.mkdirSync(path.join(stage, 'pi-bin'), { recursive: true });
fs.copyFileSync(PI_BIN, path.join(stage, 'pi-bin', 'pi.exe'));
console.log(`  pi.exe ${(fs.statSync(PI_BIN).size / 1024 / 1024).toFixed(0)} MB`);

fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'spike-agent',
      productName: 'Juno',
      version: '0.1.0',
      description: '本地 AI agent 桌面端（验证工程）',
      main: 'dist-electron/main.js',
      type: 'module',
      author: 'spike-host',
      // 必须声明：没有 dependencies 时 electron-builder 会把 node_modules
      // 当成“无主文件”直接剔除，原生模块就会静默丢失
      dependencies: { 'better-sqlite3': '13.0.3' },
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------- 2. 打包
const { build } = await import('electron-builder');

const targets = withInstaller ? ['nsis'] : ['dir'];
console.log(`→ electron-builder（${targets.join(', ')}）`);

await build({
  projectDir: stage,
  // 注意：electron-builder 把顶层当 BuildOptions，打包配置必须放在 config 里，
  // 平铺写会被忽略（表现为 types is not iterable）
  config: {
    electronVersion: ELECTRON_VERSION,
    electronDist: fs.existsSync(LOCAL_ELECTRON_DIST) ? LOCAL_ELECTRON_DIST : undefined,
    appId: 'app.spike.agent',
    productName: 'Juno',
    directories: { output: outDir },
    // pi-bin 已由 extraResources 单独投放，必须从 asar 里排除，
    // 否则 pi.exe（106MB）会被打进去两次，包体积直接翻倍
    files: ['**/*', '!pi-bin/**', '!**/*.map'],
    asar: true,
    // 原生模块和可执行文件不能在 asar 里，必须解出来
    asarUnpack: ['**/node_modules/better-sqlite3/**'],
    extraResources: [{ from: 'pi-bin', to: 'pi-bin' }],
    npmRebuild: false,
    win: {
      target: targets,
      // 不签名：本地验证用
      signAndEditExecutable: false,
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
    },
  },
});

const unpacked = path.join(outDir, 'win-unpacked');
if (fs.existsSync(unpacked)) {
  console.log(`\n✓ 免安装版: ${path.join(unpacked, 'Juno.exe')}`);
  console.log('  直接运行它就能验证打包结果（APP_AUTOTEST=1 可自动跑一轮）');
}
const installer = path.join(outDir, 'Juno Setup 0.1.0.exe');
if (fs.existsSync(installer)) {
  console.log(`✓ 安装包: ${installer}`);
}
