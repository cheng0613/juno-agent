/**
 * 一次性探测：当前模型下 effort / fastMode 到底能不能用。
 *
 * 跑法：APP_PI_API_KEY=... node dist/probeModes.js
 *
 * 目的：不要在 UI 上摆一个点了没反应的开关。
 * pi 的 Fast mode 依赖模型目录里的 fastModels，深寻这类第三方模型很可能不在列。
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { Maker, createConsoleLogger, type PiNativeApi } from '@cindy/maker-core';
import {
  assertPiBinaryExists,
  createPiAgent,
  openDatabase,
  resolvePiBinary,
  SqliteSessionStorage,
} from '@juno/host-core';

const logger = createConsoleLogger('probe-modes');
const UPSTREAM_ROOT = process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';
const API = (process.env.APP_API ?? 'openai-completions') as PiNativeApi;
const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'probe-modes');

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
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultEffort: 'medium',
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
  title: 'probe-modes',
});

const caps = session.getRuntimeCapabilities();
logger.info('capabilities', {
  hasFastMode: (caps as Record<string, unknown>)?.hasFastMode ?? null,
  effort: (caps as Record<string, unknown>)?.effort ?? null,
  effortLevels: (caps as Record<string, unknown>)?.effortLevels ?? null,
});
const sessionCaps = (session as unknown as { capabilities?: Record<string, unknown> }).capabilities;
logger.info('session.capabilities', {
  effort: sessionCaps?.effort ?? null,
  effortLevels: sessionCaps?.effortLevels ?? null,
  fastMode: sessionCaps?.fastMode ?? null,
  hasFastMode: sessionCaps?.hasFastMode ?? null,
});

// 逐个试 effort
for (const level of ['minimal', 'medium', 'max'] as const) {
  try {
    await session.setEffort(level);
    logger.info(`setEffort(${level}) ok`, { now: session.getEffort() });
  } catch (error) {
    logger.error(`setEffort(${level}) 失败`, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// 试 fast mode
try {
  await session.setFastMode(true);
  logger.info('setFastMode(true) ok', { now: session.getFastMode() });
} catch (error) {
  logger.error('setFastMode 失败', {
    message: error instanceof Error ? error.message : String(error),
  });
}
try {
  await session.setThinkingEnabled(true);
  logger.info('setThinkingEnabled(true) ok');
} catch (error) {
  logger.error('setThinkingEnabled 失败', {
    message: error instanceof Error ? error.message : String(error),
  });
}

await maker.shutdown();
logger.info('probe done');
