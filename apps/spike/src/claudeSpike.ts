/**
 * Spike：验证 Claude Code 能不能接我们的 Anthropic 端点，以及模型能不能
 * 直接看到 MCP 工具（这是 ORCA 在 pi 上跑不通的核心原因）。
 *
 * 跑法：
 *   APP_PI_API_KEY=... node dist/claudeSpike.js
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createConsoleLogger, Maker, type Logger } from '@cindy/maker-core';

import {
  createClaudeCodeAgent,
  SqliteSessionStorage,
  openDatabase,
} from '@juno/host-core';

const UPSTREAM = process.env.UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';

const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(process.cwd(), '.claude-spike');
const KEY = process.env.APP_PI_API_KEY ?? '';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';

const log = (msg: string, data?: unknown) => console.log(`[claude-spike] ${msg}`, data ?? '');

/** 只保留 warn/error 的 logger：引擎的 info 太吵 */
function quietLogger(scope = 'cc'): Logger {
  const base = createConsoleLogger(scope);
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: base.warn,
    error: base.error,
    fatal: base.fatal,
    child: (s: string) => quietLogger(`${scope}:${s}`),
  };
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('缺 APP_PI_API_KEY');

  await fs.mkdir(DATA_DIR, { recursive: true });
  const db = await openDatabase(path.join(DATA_DIR, 'spike.db'));
  const storage = new SqliteSessionStorage(db);

  const binaryPath = path.join(UPSTREAM, 'apps', 'claude-code-bin', 'win32-x64', 'claude.exe');
  await fs.access(binaryPath).catch(() => {
    throw new Error(`找不到 claude.exe: ${binaryPath}`);
  });
  log('二进制', binaryPath);

  // 关键：给 agent 一个最简单的 MCP provider，验证工具会不会直接暴露给模型
  const testProvider = {
    name: 'spike_tools',
    capability: { title: '测试工具', description: 'spike 用', source: 'builtin' as const },
    isEnabled: () => true,
    toClaudeSdkConfig: () => null, // 先不挂，只验证 CLI 能跑
  };

  const agent = createClaudeCodeAgent({
    binaryPath,
    model: MODEL,
    endpoint: ENDPOINT,
    contextWindow: 200_000,
    logger: quietLogger(),
    mcpProviders: [testProvider],
  });

  const maker = new Maker({ agents: { 'claude-code': agent } as never, storage, logger: quietLogger('maker') });
  const session = await maker.createSession({
    agentKind: 'claude-code' as never,
    workingDir: DATA_DIR,
    model: MODEL,
    title: 'spike',
  });
  log('会话已建', session.id);

  session.onEvent((e: { type: string; data?: unknown }) => {
    if (e.type === 'error') log('错误事件', JSON.stringify(e.data).slice(0, 300));
  });

  await session.send('一句话回答：你现在能调用哪些工具？只列名字，一行一个。');

  // 等最终文本
  const done = new Promise<string>((resolve) => {
    let text = '';
    session.onEvent((e: { type: string; text?: string; isFinal?: boolean }) => {
      if (e.type === 'text' && typeof e.text === 'string') {
        text = e.isFinal ? e.text : text + e.text;
        if (e.isFinal) resolve(text);
      }
    });
    setTimeout(() => resolve(text || '(超时)'), 120_000);
  });

  const answer = await done;
  log('模型回答：');
  console.log(answer.slice(0, 1500));

  await session.close?.();
  process.exit(0);
}

main().catch((error) => {
  log('失败', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
