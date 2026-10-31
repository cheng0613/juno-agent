/**
 * MCP spike —— 验证「宿主提供 MCP 工具，pi 能调，结果能回到宿主」。
 *
 * 为什么必须先做这个：ORCA 的 Lead 派活全靠工具。
 * 如果 MCP 这条路走不通，阶段二做的 worker 面板就没有数据来源，白做。
 *
 * 链路要验的四段：
 *   1. 宿主机能起一个 localhost HTTP MCP server
 *   2. pi 拿到这个 server 的地址后能发现工具
 *   3. 模型决定调用工具时，请求能到宿主
 *   4. 工具返回值能回到模型，模型据此继续
 *
 * 跑法：
 *   APP_PI_API_KEY=... node dist/spikeMcp.js
 */
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  Maker,
  createConsoleLogger,
  isTerminalTurnEvent,
  LOCAL_AGENT_CLIENT,
  type PiNativeApi,
} from '@cindy/maker-core';
import {
  assertPiBinaryExists,
  createPiAgent,
  openDatabase,
  resolvePiBinary,
  SqliteSessionStorage,
} from '@juno/host-core';

const logger = createConsoleLogger('spike-mcp');
const UPSTREAM_ROOT = process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';
const API = (process.env.APP_API ?? 'openai-completions') as PiNativeApi;
const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'spike-mcp');

/** 记录工具被调用了几次，用来证明请求真的到了宿主 */
const toolCalls: Array<{ name: string; args: unknown; at: number }> = [];

/**
 * 起一个 MCP server（streamable HTTP）。
 *
 * 把工具定义在这里 —— 真做 ORCA 时换成 create_worker / send_to_worker / list_workers。
 */
function registerTools(server: McpServer): void {
  server.tool(
    'echo_back',
    '把输入原样返回，用于验证 MCP 链路是否通',
    { text: z.string().describe('要回显的文本') },
    async ({ text }) => {
      toolCalls.push({ name: 'echo_back', args: { text }, at: Date.now() });
      logger.info('工具被调用', { tool: 'echo_back', text });
      return {
        content: [{ type: 'text', text: `ECHO_OK:${text}` }],
      };
    },
  );

  server.tool(
    'create_worker',
    '创建一个 worker 会话（spike 里只返回假数据）',
    {
      role: z.string().describe('角色，如 developer / reviewer'),
      label: z.string().optional().describe('worker 标签'),
    },
    async ({ role, label }) => {
      toolCalls.push({ name: 'create_worker', args: { role, label }, at: Date.now() });
      logger.info('工具被调用', { tool: 'create_worker', role, label });
      const id = `fake-worker-${randomUUID().slice(0, 8)}`;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, worker_id: id, role, label: label ?? role }),
          },
        ],
      };
    },
  );

}

async function startMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  // 注意：一个 transport 实例只能服务一次 initialize 握手。
  // stateless 模式下必须**每个请求新建 transport**，
  // 共用一个实例会在第二次请求（tools/call）时崩掉 —— 实测 HTTP 500。
  const httpServer = http.createServer(async (req, res) => {
    try {
      const perRequestServer = new McpServer({ name: 'spike_orca_bridge', version: '0.1.0' });
      registerTools(perRequestServer);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await perRequestServer.connect(transport);
      await transport.handleRequest(req, res);
      res.on('close', () => {
        void transport.close().catch(() => undefined);
        void perRequestServer.close().catch(() => undefined);
      });
    } catch (error) {
      logger.error('MCP 请求处理失败', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal' }, id: null }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('无法获取 MCP server 端口');
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

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
  storage: new SqliteSessionStorage(await openDatabase(path.join(DATA_DIR, 'spike.db'))),
  logger,
});

const workDir = path.join(DATA_DIR, 'workspace');
await fs.mkdir(workDir, { recursive: true });

let mcp: { url: string; close: () => Promise<void> } | null = null;

try {
  mcp = await startMcpServer();
  logger.info('MCP server 已启动', { url: mcp.url });

  const session = await maker.createSession({
    agentKind: 'pi',
    workingDir: workDir,
    model: MODEL,
    title: 'mcp-spike',
    // 关键：把 MCP server 交给 pi。这个 symbol 是 maker-core 约定的注入点。
    [LOCAL_AGENT_CLIENT]: {
      url: mcp.url,
      token: 'spike-token',
      hostToolsOnly: false,
      mcpName: 'spike_bridge',
    },
  } as never);

  session.setInteractionListener(async () => ({ kind: 'permission', behavior: 'allow' }) as never);

  let answer = '';
  const toolUses: Array<{ toolName: string; input: unknown }> = [];
  session.onEvent((event) => {
    if (event.type === 'text') {
      const d = event.data as { text?: string; isFinal?: boolean };
      if (d?.isFinal && d.text) answer = d.text;
    }
    if (event.type === 'tool_use') {
      const d = event.data as { toolName?: string; input?: unknown };
      if (d?.toolName) toolUses.push({ toolName: d.toolName, input: d.input });
    }
  });

  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 120_000);
    const off = session.onEvent((event) => {
      if (event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });

  process.stdout.write('\n=== 让模型调 echo_back ===\n');
  await session.send(
    '请调用工具 spike_bridge 里的 echo_back，参数 text 传 "hello-mcp"。拿到结果后只回答结果的原文。',
  );
  await done;

  const toolNames = toolUses.map((t) => t.toolName);
  logger.info('模型调用的工具', { toolNames });
  logger.info('宿主侧收到的工具调用', { calls: toolCalls.map((c) => c.name) });
  logger.info('模型最终回答', { answer: answer.slice(0, 200) });

  const hostSawCall = toolCalls.length > 0;
  const modelUsedTool = toolNames.some((n) => n.includes('echo_back'));
  const gotResult = answer.includes('ECHO_OK') || answer.includes('hello-mcp');

  process.stdout.write('\n=== spike 结论 ===\n');
  process.stdout.write(`1. MCP server 起得来: 是 (${mcp.url})\n`);
  process.stdout.write(`2. pi 能发现工具并调用: ${modelUsedTool ? '是' : '否'}\n`);
  process.stdout.write(`3. 请求回到宿主: ${hostSawCall ? '是' : '否'}\n`);
  process.stdout.write(`4. 结果回到模型: ${gotResult ? '是' : '否'}\n`);
  process.stdout.write(
    `\n总结: ${hostSawCall && modelUsedTool && gotResult ? 'MCP 链路可行 ✅' : '链路有断点 ❌'}\n`,
  );

  if (toolNames.length > 0) {
    process.stdout.write(`\n模型看到的工具名: ${toolNames.join(', ')}\n`);
  }
} catch (error) {
  logger.error('spike 失败', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
  });
} finally {
  await maker.shutdown().catch(() => undefined);
  await mcp?.close().catch(() => undefined);
}
