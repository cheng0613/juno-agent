/**
 * ORCA 的 MCP 工具服务器。
 *
 * Lead 靠这些工具派活 —— 这是「一个 agent 带多个 agent」的接线处。
 *
 * 链路（已在 docs/SPIKE-MCP.md 验证）：
 *   宿主起 localhost MCP server
 *     → 通过 LOCAL_AGENT_CLIENT 注入给 pi
 *     → pi 发现 mcp:orca:* 工具
 *     → 模型调用 → 请求回到宿主 → 宿主真正建 worker / 派活
 *     → 结果回到模型
 *
 * 三个关键约束：
 *   1. **每个请求新建 transport**：一个 transport 只能服务一次 initialize 握手，
 *      共用会让 tools/list 正常但 tools/call 返回 500。这个坑踩过。
 *   2. **返回值必须是 { content: [{ type: 'text', text }] }**，
 *      复杂结构用 JSON.stringify 塞进 text（Cindy 也这么做）。
 *   3. **报错要给人话**：模型看到的错误信息会直接决定它下一步怎么做。
 *      说「已达上限 8 个」比说 "Error: limit" 有用得多。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  ORCA_PREDEFINED_ROLES,
  ORCA_WORKER_HARD_LIMIT,
  type OrcaWorkerRecord,
} from '@juno/host-core';

/** 宿主需要提供给工具的能力。刻意用窄接口，方便单测 */
export interface OrcaToolHost {
  /** 建 worker（内部会做上限检查和 worktree 隔离） */
  createWorker: (leadSessionId: string, config: { role: string; label?: string }) => Promise<OrcaWorkerRecord>;
  /** 给 worker 派活 */
  sendToWorker: (workerId: string, text: string) => Promise<void>;
  /** 列某个 Lead 的 worker */
  listWorkers: (leadSessionId: string) => OrcaWorkerRecord[];
  /**
   * worker 向 Lead 回报。
   *
   * fromWorkerId 是调用的那个 worker —— 不能靠模型自己填，
   * 它可能填错，那样回报就冒名顶替了。
   */
  reportToLead: (fromWorkerId: string, message: string) => Promise<void>;
}

/** token 对应的调用者身份。由宿主维护，server 只查不存 */
export type OrcaCaller =
  | { role: 'lead'; sessionId: string }
  | { role: 'worker'; sessionId: string; workerId: string };

export interface OrcaToolServer {
  /** 给 LOCAL_AGENT_CLIENT 用的 URL */
  url: string;
  close: () => Promise<void>;
}

const log = (msg: string, data?: unknown) => {
  // eslint-disable-next-line no-console
  console.log(`[orca/tools] ${msg}`, data ?? '');
};

/** 工具返回值：把任意对象序列化成模型能读的文本 */
function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string) {
  // isError 让模型知道这是失败，不是内容
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

/**
 * 注册工具。
 *
 * 工具描述写得啰嗦一点 —— 模型靠这几句话决定什么时候用哪个工具、
 * 参数怎么填。省字数最后会变成「模型乱调」。
 */
function registerTools(server: McpServer, host: OrcaToolHost, caller: OrcaCaller | null): void {
  // 没有身份（token 不认）时不注册任何工具 —— 宁可模型报「没有工具」，
  // 也不要让它调到一个不知道自己是谁的工具然后冒名顶替
  if (!caller) return;

  if (caller.role === 'worker') {
  /* ---------------- worker 侧：回报 ---------------- */
  server.tool(
    'send_to_lead',
    `把结果汇报给 Lead。Lead 会看到你说的全部内容。

什么时候用：干完了、遇到卡点、需要 Lead 决策。
写什么：结论 + 关键细节（改了哪些文件、命令输出、你为什么这么做）。
不要只说「完成了」—— Lead 看不到你的对话，也不在你的工作目录里。`,
    {
      message: z.string().describe('要汇报的内容，Lead 会完整看到'),
    },
    async ({ message }) => {
      log('send_to_lead', { workerId: caller.workerId, chars: message.length });
      try {
        await host.reportToLead(caller.workerId, message);
        return ok({ success: true, note: '已汇报给 Lead' });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );
  // worker 只需要回报工具，不需要派活工具
  return;
  }

  /* ---------------- Lead 侧：派活 ---------------- */
  const leadId = caller.sessionId;
  server.tool(
    'create_worker',
    `创建一个 worker 来并行干活。worker 是一个独立的会话，有自己的工作目录和上下文。

什么时候用：有一个能独立完成、且你想和别人并行做的子任务。
什么时候不用：任务很小（自己做完更快），或者需要大量来回确认（用 send_to_worker 给已有的 worker）。

创建后 worker 处于待命状态，用 send_to_worker 给它派活。`,
    {
      role: z
        .string()
        .optional()
        .describe(
          `角色名，决定它擅长什么。可选：${ORCA_PREDEFINED_ROLES.join(' / ')}。也可以自定义（如「翻译」）。默认 developer`,
        ),
      label: z
        .string()
        .optional()
        .describe('给这个 worker 起的短名字（如「登录页」「API 层」），撞名会自动加序号'),
    },
    async ({ role, label }) => {
      log('create_worker', { role, label });
      try {
        const w = await host.createWorker(leadId, {
          role: role ?? 'developer',
          ...(label ? { label } : {}),
        });
        return ok({
          success: true,
          worker_id: w.id,
          label: w.label,
          role: w.role,
          isolated: w.isolated === true,
          working_dir: w.isolated ? '独立工作区（改动不会影响主目录）' : '与 Lead 共享目录',
          next: '用 send_to_worker 给它派活',
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    'send_to_worker',
    `给一个 worker 派活或追加要求。worker 会立刻开始干活。

worker 干完后会用 send_to_lead 把结果告诉你。你也可以用 list_workers 看进度。`,
    {
      worker_id: z.string().describe('create_worker 返回的 worker_id，或用 list_workers 查'),
      message: z
        .string()
        .describe('要它做的事。写清楚期望结果 —— worker 看不到你的对话上下文，只说「继续」它不知道继续什么'),
    },
    async ({ worker_id, message }) => {
      log('send_to_worker', { worker_id, chars: message.length });
      try {
        await host.sendToWorker(worker_id, message);
        return ok({
          success: true,
          worker_id,
          note: '已派活。它干完会通过 send_to_lead 回报给你。',
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    'list_workers',
    `列出你所有的 worker 及其状态。

status 含义：
  idle    —— 待命，还没派活
  running —— 正在干活
  done    —— 上一轮干完了
  error   —— 上轮出错了`,
    {},
    async () => {
      try {
        const list = host.listWorkers(leadId);
        return ok({
          count: list.length,
          limit: ORCA_WORKER_HARD_LIMIT,
          workers: list.map((w) => ({
            worker_id: w.id,
            label: w.label,
            role: w.role,
            status: w.status,
          })),
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

/**
 * 起 MCP server。
 *
 * 端口用 0（系统分配）—— 写死端口会在多实例/端口被占时炸掉，
 * 而这个 server 只给本机 pi 用，端口号不重要。
 */
export async function startOrcaToolServer(
  host: OrcaToolHost & {
    /** token → 身份；返回 null 表示 token 无效 */
    resolveToken: (token: string) => OrcaCaller | null;
  },
): Promise<OrcaToolServer> {
  /*
   * 有状态 session：一个 MCP 会话（一个 pi 进程）对应一套 server + transport。
   *
   * 为什么不能用 stateless（每个请求新建）：pi 的 MCP 网关会在本地缓存
   * 工具的 inputSchema，调用前先比对。stateless 模式下每次连都是「新服务器」，
   * pi 就会一直要求它「先检查 schema」，而检查完又因为服务器又换了而失效 ——
   * 表现是工具列得出来、模型也反复调，但请求永远到不了 handler。
   *
   * 这个坑和 SPIKE-MCP.md 里那个「transport 不能复用」不矛盾：
   *   那里是一次请求不能共用 transport（initialize 只能一次）
   *   这里是**一个会话**内要复用同一套 transport
   */
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();

  const httpServer = http.createServer(async (req, res) => {
    // token 既做鉴权也做身份识别。
    // 每个会话一套 token —— 全局共享一个的话，两个 worker 同时回报
    // 就分不清谁是谁（HTTP 请求里没有我们的会话 id）。
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const caller = token ? host.resolveToken(token) : null;
    if (token && !caller) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    try {
      log(`REQ ${req.method} ${req.url} sid=${String(req.headers['mcp-session-id'] ?? '-')}`);
      const existingId = req.headers['mcp-session-id'] as string | undefined;
      const existing = existingId ? sessions.get(existingId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res);
        return;
      }

      // 新会话：建一套 server + transport，用 sessionIdGenerator 发 session id
      let createdId: string | null = null;
      const server = new McpServer({ name: 'orca', version: '0.1.0' });
      registerTools(server, host, caller);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          createdId = id;
          sessions.set(id, { server, transport });
          log(`新 MCP 会话 ${id.slice(0, 8)} role=${caller?.role ?? '?'}`);
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);

      transport.onclose = () => {
        if (createdId) sessions.delete(createdId);
      };
    } catch (error) {
      log('请求处理失败', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal' }, id: null }),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  log('已启动', { port });

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
