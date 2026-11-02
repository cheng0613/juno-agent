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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  createClaudeCodeAgent,
  SqliteSessionStorage,
  openDatabase,
} from '@juno/host-core';

const UPSTREAM = process.env.UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';

const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(process.cwd(), '.claude-spike');
const KEY = process.env.APP_PI_API_KEY ?? '';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? "https://tokenhub.tencentmaas.com";

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

  /*
   * 关键验证：挂一个 in-process MCP server，看模型能不能直接用工具名调用。
   * 如果能看到并调用，说明 ORCA 在 claude-code 上跑得通（pi 上是看不到的）。
   */
  const testProvider = {
    name: 'spike_tools',
    capability: { title: '测试工具', description: 'spike 用', source: 'builtin' as const },
    isEnabled: () => true,
    toClaudeSdkConfig: () => {
      const server = new McpServer({ name: 'spike_tools', version: '0.1.0' });
      server.tool('echo_marker', '把输入原样返回，前面加 MARKER_', { text: z.string() }, async ({ text }) => ({
        content: [{ type: 'text' as const, text: `MARKER_${text}` }],
      }));
      return { type: 'sdk' as const, name: 'spike_tools', instance: server };
    },
  };

  const agent = createClaudeCodeAgent({
    binaryPath,
    model: MODEL,
    endpoint: ENDPOINT,
    contextWindow: 200_000,
    logger: quietLogger(),
    mcpProviders: [testProvider],
  });

  // 验证 behaviorFlags 是否真的进了 agent deps
  const depsProbe = (agent as unknown as { deps?: { runtimeConfig?: { behaviorFlags?: unknown } } }).deps;
  log('behaviorFlags:', JSON.stringify(depsProbe?.runtimeConfig?.behaviorFlags));

  const maker = new Maker({ agents: { 'claude-code': agent } as never, storage, logger: quietLogger('maker') });
  const session = await maker.createSession({
    agentKind: 'claude-code' as never,
    workingDir: DATA_DIR,
    model: MODEL,
    title: 'spike',
  });
  log('会话已建', session.id);

  // 必须有审批监听器：没挂的话工具调用会被默认拒绝（deny），看不到结果
  session.setInteractionListener?.((req: unknown) => {
    log('审批请求', JSON.stringify(req).slice(0, 160));
    return { kind: 'permission', behavior: 'allow' };
  });

  session.onEvent((e: { type: string; text?: string; isFinal?: boolean; data?: unknown }) => {
    if (e.type === 'text') log('TEXT', JSON.stringify(e.text?.slice(0, 120)), 'final=' + e.isFinal);
    if (e.type === 'tool_use') log('TOOL_USE', JSON.stringify(e.data).slice(0, 150));
    if (e.type === 'tool_result') log('TOOL_RESULT', JSON.stringify(e.data).slice(0, 150));
    if (e.type === 'error') log('错误事件', JSON.stringify(e.data).slice(0, 300));
  });

  await session.send(
    '调用 echo_marker 工具，参数 text="hello"。把它的完整返回值原样告诉我。',
  );

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
