/**
 * 一次性探测：会话分支树长什么样、分叉怎么产生。
 *
 * 跑法：APP_PI_API_KEY=... node dist/probeTree.js
 *
 * 目的：分支树只有在真的分叉后才有内容。先确认
 *   1. getSessionTree 能返回什么形状
 *   2. 普通对话是不是一条直线（没有分叉）
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
} from '@spike/host-core';

const logger = createConsoleLogger('probe-tree');
const UPSTREAM_ROOT = process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';
const API = (process.env.APP_API ?? 'openai-completions') as PiNativeApi;
const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'probe-tree');

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
  title: 'probe-tree',
});

session.setInteractionListener(async () => ({ kind: 'permission', behavior: 'allow' }) as never);

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

const dumpTree = (snapshot: unknown) => {
  const snap = snapshot as {
    leafId?: string | null;
    activePathIds?: string[];
    roots?: Array<Record<string, unknown>>;
  };
  const walk = (node: Record<string, unknown>, depth: number): string[] => {
    const lines = [
      `${'  '.repeat(depth)}- [${String(node.kind)}/${String(node.role ?? '-')}] ${String(node.preview ?? '').slice(0, 40)} (id=${String(node.id).slice(0, 12)})`,
    ];
    for (const child of (node.children as Array<Record<string, unknown>>) ?? []) {
      lines.push(...walk(child, depth + 1));
    }
    return lines;
  };
  const lines: string[] = [];
  for (const root of snap.roots ?? []) lines.push(...walk(root, 0));
  return {
    leafId: snap.leafId?.slice(0, 12) ?? null,
    activePathCount: snap.activePathIds?.length ?? 0,
    text: lines.join('\n'),
  };
};

await runTurn('记住这个数字：42。只回答「好」');
await runTurn('刚才那个数字是多少？只回答数字');

const tree = await session.getSessionTree();
const d = dumpTree(tree);
logger.info('第一棵树', { leafId: d.leafId, activePathCount: d.activePathCount });
process.stdout.write(d.text + '\n');

// 试试对一个中间节点做 fork —— 这就是分叉的来源
const entries = (tree as unknown as { roots: Array<{ children: Array<{ id: string }> }> }).roots;
const userIds: string[] = [];
const collect = (node: { id: string; kind?: string; children?: Array<never> }): void => {
  if (node.kind === 'message') userIds.push(node.id);
  for (const child of (node as unknown as { children?: Array<{ id: string; kind?: string }> }).children ?? []) {
    collect(child as never);
  }
};
for (const root of entries) collect(root as never);
logger.info('候选分叉点', { count: userIds.length, ids: userIds.map((i) => i.slice(0, 12)) });

if (userIds.length >= 2) {
  try {
    const result = await session.navigateSessionTree(userIds[0]!, { summarize: false });
    logger.info('navigate 成功', { result: JSON.stringify(result).slice(0, 300) });
    const tree2 = await session.getSessionTree();
    const d2 = dumpTree(tree2);
    logger.info('分叉后的树', { leafId: d2.leafId, activePathCount: d2.activePathCount });
    process.stdout.write('=== 分叉后 ===\n' + d2.text + '\n');
  } catch (error) {
    logger.error('navigate 失败', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

await maker.shutdown();
logger.info('probe done');
