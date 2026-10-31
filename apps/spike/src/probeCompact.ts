/**
 * 一次性探测：pi 的「Nothing to compact (session too small)」到底卡在哪。
 *
 * 跑法：
 *   APP_PI_API_KEY=... node scripts/probe-compact.mjs
 *
 * 做法：一个会话里先堆几轮大文本，每堆一轮就试一次 compact，
 * 把 tokensBefore/estimatedTokensAfter 或原始 noop 打出来。
 * 目标不是验收，是搞清门槛，别在 Electron 里反复试。
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { Maker, createConsoleLogger, isTerminalTurnEvent, type PiNativeApi } from '@cindy/maker-core';
import {
  assertPiBinaryExists,
  createPiAgent,
  openDatabase,
  resolvePiBinary,
  SqliteSessionStorage,
} from '@juno/host-core';

const logger = createConsoleLogger('probe');
const UPSTREAM_ROOT = process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';
const API = (process.env.APP_API ?? 'openai-completions') as PiNativeApi;
const CONTEXT_WINDOW = Number(process.env.APP_CONTEXT_WINDOW ?? 200_000);
const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'probe-compact');

const binaryPath = resolvePiBinary(UPSTREAM_ROOT);
await assertPiBinaryExists(binaryPath);
const agentHome = path.join(DATA_DIR, 'pi-agent-home');
await fs.mkdir(agentHome, { recursive: true });

const agent = createPiAgent({
  binaryPath,
  model: MODEL,
  api: API,
  endpoint: ENDPOINT,
  contextWindow: CONTEXT_WINDOW,
  compactionPct: process.env.APP_COMPACT_PCT ? Number(process.env.APP_COMPACT_PCT) : undefined,
  efforts: [],
  defaultEffort: null,
  agentHome,
  logger: logger.child('pi'),
});

const maker = new Maker({
  agents: { pi: agent },
  storage: new SqliteSessionStorage(await openDatabase(path.join(DATA_DIR, 'probe.db'))),
  logger,
});
const workDir = path.join(DATA_DIR, 'workspace');
await fs.mkdir(workDir, { recursive: true });
const session = await maker.createSession({
  agentKind: 'pi',
  workingDir: workDir,
  model: MODEL,
  title: 'probe',
});

session.setInteractionListener(async () => ({ kind: 'permission', behavior: 'allow' }) as never);

let contextTokens: number | null = null;
session.onEvent((event) => {
  if (event.type === 'compact_boundary') {
    logger.info('compact_boundary', event.data as Record<string, unknown>);
  }
  const meta = (event as { agentMeta?: { usage?: { input?: number } } }).agentMeta;
  if (meta?.usage && typeof meta.usage.input === 'number') contextTokens = meta.usage.input;
});

const runTurn = async (prompt: string) => {
  const done = new Promise<void>((resolve) => {
    const off = session.onEvent((event) => {
      if (event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        off();
        resolve();
      }
    });
  });
  await session.send(prompt);
  await done;
};

const tryCompact = async (label: string) => {
  try {
    const result = await session.compactSession();
    logger.info(`compact[${label}]`, { ...result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`compact[${label}] threw`, { message });
    return null;
  }
};

logger.info('probe start', { model: MODEL, contextWindow: CONTEXT_WINDOW, compactionPct: process.env.APP_COMPACT_PCT ?? null });

// 第一轮：极短，确认 baseline 就是 noop
await runTurn('你好，用一句话介绍你自己');
logger.info('after tiny turn', { contextTokens });
await tryCompact('tiny');

// 之后每轮写一大段，逐步逼近门槛
for (let i = 1; i <= 4; i += 1) {
  await runTurn(
    `写一段约 1500 字的技术说明，主题是「分布式系统里的第 ${i} 类一致性问题」补充材料，小标题分段。`,
  );
  logger.info(`after bulky turn ${i}`, { contextTokens });
  await tryCompact(`bulky-${i}`);
}

await maker.shutdown();
logger.info('probe done');
