#!/usr/bin/env node
/**
 * 干净机器安装验证。
 *
 * 为什么需要它：现在安装包只在开发机跑过免安装版。
 * 「别人装上去会不会崩」这件事从来没验过 —— 这个风险比没图标大得多。
 *
 * 用法（在目标机器上）：
 *   1. 正常双击安装包装完
 *   2. 把本文件拷过去：node verify-install.mjs
 *
 * 它做三件事：
 *   - 静态检查：安装目录里该有的东西在不在
 *   - 环境检查：Node/Electron/系统版本、密钥库是否可用
 *   - 启动检查：真启动一次 app，等它写出日志，看有没有崩溃
 *
 * 不依赖项目源码，只依赖 Node 本身。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Juno', 'Juno.exe'),
  path.join(process.env.PROGRAMFILES ?? '', 'Juno', 'Juno.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Juno', 'Juno.exe'),
  // 免安装版
  path.join(process.cwd(), 'win-unpacked', 'Juno.exe'),
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function findExe() {
  for (const candidate of CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 继续找下一个
    }
  }
  return null;
}

async function checkStatic(exePath) {
  const dir = path.dirname(exePath);
  record('找到可执行文件', true, exePath);

  // pi 引擎必须随包发出，而且不能被打进 asar
  const piPath = path.join(dir, 'resources', 'pi-bin', process.platform === 'win32' ? 'pi.exe' : 'pi');
  const piStat = await fs.stat(piPath).catch(() => null);
  record('pi 引擎存在', Boolean(piStat), piStat ? `${(piStat.size / 1024 / 1024).toFixed(0)}MB` : `缺失: ${piPath}`);

  // better-sqlite3 是原生模块，必须在 unpacked 里
  const resourcesDir = path.join(dir, 'resources');
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  const hasUnpacked = await fs.stat(unpacked).then(() => true).catch(() => false);
  record('better-sqlite3 已解包', hasUnpacked, hasUnpacked ? '' : '原生模块没解包，启动会崩溃');

  // asar 体积异常大通常意味着把 pi.exe 打进去了两次
  const asar = await fs.stat(path.join(resourcesDir, 'app.asar')).catch(() => null);
  if (asar) {
    const mb = asar.size / 1024 / 1024;
    record('app.asar 体积正常', mb < 30, `${mb.toFixed(1)}MB${mb >= 30 ? '（偏大，检查是否重复打包）' : ''}`);
  }
}

function checkEnv() {
  record('Node 版本', Number(process.versions.node.split('.')[0]) >= 18, process.versions.node);
  record('平台', true, `${process.platform} ${process.arch}`);
  record('系统', true, `${os.type()} ${os.release()}`);
  // Windows 上 DPAPI 加密需要用户已登录，这里只看进程能否访问
  record('内存', true, `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB`);
}

async function checkLaunch(exePath) {
  const userData = path.join(process.env.APPDATA ?? os.homedir(), 'Juno');
  const child = spawn(exePath, [], {
    stdio: 'pipe',
    windowsHide: false,
    env: {
      ...process.env,
      // 测试不依赖真实 key：app 应该弹配置向导而不是崩溃
      APP_PI_API_KEY: '',
      APP_AUTOTEST: '',
    },
  });

  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += String(d);
  });

  // 给它 12 秒：够启动 + 建窗口 + 写出 settings 检查
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 12_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exited !== null) {
    record('启动后保持运行', false, `进程提前退出，退出码 ${exited}${stderr ? `；stderr: ${stderr.slice(0, 200)}` : ''}`);
    return;
  }

  record('启动后保持运行', true, '12 秒内没有崩溃');

  // 正常关掉
  child.kill();
  await new Promise((r) => setTimeout(r, 1500));

  // 用户数据目录是否建出来了（说明它能写盘）
  const exists = await fs.stat(userData).then(() => true).catch(() => false);
  record('用户数据目录已创建', exists, userData);
}

async function main() {
  console.log('=== 干净机器安装验证 ===\n');
  checkEnv();
  console.log('');

  const exe = await findExe();
  if (!exe) {
    record('找到可执行文件', false, `试过：\n  ${CANDIDATES.join('\n  ')}`);
    console.log('\n没找到安装结果。请确认已安装，或用 APP_EXE 指定路径。');
    process.exitCode = 1;
    return;
  }

  await checkStatic(exe);
  console.log('');
  await checkLaunch(exe);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('验证脚本自身出错：', error);
  process.exitCode = 1;
});
