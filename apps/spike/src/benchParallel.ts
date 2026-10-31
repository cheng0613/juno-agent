#!/usr/bin/env node
/**
 * 并发上限测量。
 *
 * 目的：回答「能同时跑几个会话」这个问题。
 * ORCA 的核心是派 N 个 worker 并行，如果 5 个就把内存打爆，那功能就是负资产。
 *
 * 每个会话对应一个 pi 子进程（107MB 的二进制），所以开销主要在两处：
 *   1. 子进程自身的内存
 *   2. 模型请求的并发（远端不会因为我们并发就变快）
 *
 * 做法：一次起 N 个会话，同时发消息，量：
 *   - 内存增量
 *   - 每个会话从发送到收口的耗时
 *   - 有没有报错 / 超时
 *
 * 用法：APP_PI_API_KEY=... node dist/benchParallel.js [并发数...]
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Maker, createConsoleLogger, isTerminalTurnEvent, type PiNativeApi } from '@cindy/maker-core';
import {
  assertPiBinaryExists,
  createPiAgent,
  openDatabase,
  resolvePiBinary,
  SqliteSessionStorage,
} from '@juno/host-core';

const exec = promisify(execFile);
const logger = createConsoleLogger('bench');
const UPSTREAM_ROOT = process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';
const API = (process.env.APP_API ?? 'openai-completions') as PiNativeApi;
const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'bench-parallel');

const binaryPath = resolvePiBinary(UPSTREAM_ROOT);
await assertPiBinaryExists(binaryPath);
const agentHome = path.join(DATA_DIR, 'pi-agent-home');
await fs.mkdir(agentHome, { recursive: true });

const agent = createPiAgent({
  binaryPath,
  model: MODEL,
  api: API,
  endpoint: ENDPOINT,
  contextWindow: 200_000,
  efforts: [],
  defaultEffort: null,
  agentHome,
  logger: logger.child('pi'),
});

const db = await openDatabase(path.join(DATA_DIR, 'bench.db'));
const maker = new Maker({ agents: { pi: agent }, storage: new SqliteSessionStorage(db), logger });
const workDir = path.join(DATA_DIR, 'workspace');
await fs.mkdir(workDir, { recursive: true });

/** 当前所有 pi 子进程占用的内存（KB）。按可执行文件名筛，不按 PID —— 简单够用。 */
async function piMemoryKb(): Promise<number> {
  try {
    const { stdout } = await exec(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-Process -Name pi -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum",
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    const bytes = Number(stdout.trim());
    return Number.isFinite(bytes) ? Math.round(bytes / 1024) : 0;
  } catch {
    return 0;
  }
}

async function countPiProcesses(): Promise<number> {
  try {
    const { stdout } = await exec(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-Process -Name pi -ErrorAction SilentlyContinue | Measure-Object).Count",
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

const runOne = async (sessionId: string, index: number) => {
  const session = await maker.createSession({
    id: sessionId,
    agentKind: 'pi',
    workingDir: workDir,
    model: MODEL,
    title: `bench-${index}`,
  });
  session.setInteractionListener(async () => ({ kind: 'permission', behavior: 'allow' }) as never);

  const startedAt = Date.now();
  const done = new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(-1), 180_000);
    const off = session.onEvent((event) => {
      if (event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        clearTimeout(timer);
        off();
        resolve(Date.now() - startedAt);
      }
    });
  });

  await session.send('只回答两个字：收到');
  const elapsed = await done;
  return { session, elapsed };
};

const levels = process.argv.slice(2).map(Number).filter((n) => n > 0 && n <= 20);
const concurrencyLevels = levels.length > 0 ? levels : [1, 3, 5];

console.log('=== 并发上限测量 ===\n');
console.log(`模型: ${MODEL}`);
console.log(`初始 pi 进程数: ${await countPiProcesses()}`);
const baseMem = await piMemoryKb();
console.log(`初始 pi 内存: ${(baseMem / 1024).toFixed(0)}MB\n`);

const results: Array<{ n: number; ok: number; fail: number; totalMs: number; memMb: number; procs: number }> = [];

for (const n of concurrencyLevels) {
  console.log(`--- 并发 ${n} ---`);
  const ids = Array.from({ length: n }, (_, i) => `bench-${n}-${i}-${Date.now()}`);
  const batchStart = Date.now();

  const settled = await Promise.allSettled(ids.map((id, i) => runOne(id, i)));
  const totalMs = Date.now() - batchStart;

  const ok = settled.filter(
    (r) => r.status === 'fulfilled' && r.value.elapsed > 0,
  ).length;
  const fail = settled.length - ok;
  const elapsedList = settled
    .map((r) => (r.status === 'fulfilled' ? r.value.elapsed : -1))
    .filter((x) => x > 0);

  const memMb = Math.round((await piMemoryKb()) / 1024);
  const procs = await countPiProcesses();

  console.log(`  成功 ${ok} / 失败 ${fail}`);
  console.log(`  总耗时 ${totalMs}ms`);
  if (elapsedList.length > 0) {
    console.log(`  单会话耗时: ${elapsedList.map((x) => `${x}ms`).join(', ')}`);
    console.log(`  最慢 ${Math.max(...elapsedList)}ms / 平均 ${Math.round(elapsedList.reduce((a, b) => a + b, 0) / elapsedList.length)}ms`);
  }
  console.log(`  pi 进程数 ${procs} / 内存 ${memMb}MB（基线 ${Math.round(baseMem / 1024)}MB）\n`);

  results.push({ n, ok, fail, totalMs, memMb, procs });

  // 每档之间稍等，让上一个批次彻底收口
  await new Promise((r) => setTimeout(r, 3000));
}

console.log('=== 汇总 ===');
console.log('并发\t成功\t失败\t总耗时\t进程数\t内存');
for (const r of results) {
  console.log(`${r.n}\t${r.ok}\t${r.fail}\t${r.totalMs}ms\t${r.procs}\t${r.memMb}MB`);
}

await maker.shutdown();
console.log('\n测量完成');
