/**
 * 一次性探测：后台任务与子任务进度在当前环境到底有没有东西。
 *
 * 跑法：APP_PI_API_KEY=... node dist/probeTasks.js
 *
 * 目的：不要在 UI 上摆一个永远空的列表。
 * pi 的后台任务依赖模型主动发起（local_bash / subagent），
 * 而子 agent 又要模型愿意拆活。
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

const logger = createConsoleLogger('probe-tasks');
const UPSTREAM_ROOT = process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';
const API = (process.env.APP_API ?? 'openai-completions') as PiNativeApi;
const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'probe-tasks');

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
  title: 'probe-tasks',
});

session.setInteractionListener(async () => ({ kind: 'permission', behavior: 'allow' }) as never);

let taskUpdates = 0;
session.onEvent((event) => {
  if (event.type === 'agent_task_update') {
    taskUpdates += 1;
    logger.info('agent_task_update', event.data as Record<string, unknown>);
  }
});

// 能力声明
const caps = (session as unknown as { capabilities?: Record<string, unknown> }).capabilities;
logger.info('capabilities', {
  backgroundTasks: caps?.backgroundTasks ?? null,
  subagents: caps?.subagents ?? null,
  taskList: typeof session.listBackgroundTasks,
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

logger.info('turn 1: 让它起一个后台任务');
await runTurn('用 bash 在后台跑一个耗时 5 秒的命令（例如 sleep 5），然后用一句话告诉我你做了什么');
await new Promise((r) => setTimeout(r, 1500));
logger.info('listBackgroundTasks', { tasks: session.listBackgroundTasks() });

logger.info('turn 2: 让它拆子任务');
await runTurn('把「列举三种排序算法并各写一句说明」拆成三个子任务并行做，最后汇总');
await new Promise((r) => setTimeout(r, 1500));
logger.info('listBackgroundTasks（第二轮后）', { tasks: session.listBackgroundTasks() });
logger.info('agent_task_update 次数', { taskUpdates });

await maker.shutdown();
logger.info('probe done');
