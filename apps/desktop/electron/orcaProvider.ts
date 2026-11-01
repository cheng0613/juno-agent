/**
 * ORCA 的 MCP 提供者。
 *
 * 为什么用 `McpProvider` 而不是直接传 `LOCAL_AGENT_CLIENT`：
 *
 * `McpProvider` 是 maker-core 的通用抽象 —— 一份工具定义，宿主按 harness
 * 转成不同形态（Claude 的 in-process server / Codex 的 HTTP 配置 /
 * pi 的本地 bridge）。绑死 `LOCAL_AGENT_CLIENT` 的话，ORCA 只能跑在 pi 上，
 * 将来接 claude-code / codex 都要重写。
 *
 * 另一个好处（也是这次改造的主要原因）：
 * pi 的 MCP 工具有两种暴露方式 ——
 *   A. 经 `cindy_mcp_list_tools` + `cindy_mcp_call_tool` 二段网关
 *   B. 直接注册成模型可见的工具
 * 走 A 时模型经常**发现不了**工具，会自己编一个名字去调（实测 deepseek 和
 * glm 都这样，发 `mcp:orca:create_worker` 这种不存在的工具名）。
 * Cindy 的注释里写明他们因此选择了 B。
 *
 * 这个 provider 走的就是 B：工具直接挂进系统提示，模型一眼能看到。
 */
import type { McpProvider, McpProviderContext } from '@cindy/maker-core';

import { ORCA_PREDEFINED_ROLES, ORCA_WORKER_HARD_LIMIT, type OrcaWorkerRecord } from '@juno/host-core';

/** provider 名。会出现在工具名前缀里，别随意改 */
export const ORCA_PROVIDER_NAME = 'orca';

/** 宿主能力：provider 只描述工具，真正干活的是宿主 */
export interface OrcaProviderHost {
  createWorker: (
    leadSessionId: string,
    config: { role: string; label?: string; firstTask?: string },
  ) => Promise<OrcaWorkerRecord>;
  sendToWorker: (workerId: string, text: string) => Promise<void>;
  listWorkers: (leadSessionId: string) => Array<{
    id: string;
    label: string;
    role: string;
    status: string;
  }>;
  reportToLead: (workerId: string, message: string) => Promise<void>;
  /** worker 反查它属于哪个 lead；返回 null 表示这个 session 不是 worker */
  workerOf: (sessionId: string) => { workerId: string; leadSessionId: string } | null;
}

/** 工具注册器：宿主按 harness 提供具体实现 */
export type RegisterOrcaTool = (
  name: string,
  description: string,
  shape: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>,
) => void;

/** 从 ctx 里取「当前是哪个 session 在调」。取不到就不能放行 */
function callerOf(ctx: McpProviderContext): McpProviderContext | undefined {
  // 优先用调用时 ctx：长生命周期的 server（如 codex HTTP bridge）
  // 在工厂阶段拿不到 sessionId，必须在这里恢复。
  const live = ctx.getSessionContext?.();
  if (live?.sessionId) return live;
  return ctx.sessionId ? ctx : undefined;
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/**
 * 定义所有 ORCA 工具。
 *
 * 拆出这个函数而不是塞进 provider：宿主可以拿同一份定义去生成
 * pi bridge / claude SDK config，不用写两遍。
 */
export function defineOrcaTools(
  host: OrcaProviderHost,
  ctx: McpProviderContext,
  register: RegisterOrcaTool,
): void {
  const caller = callerOf(ctx);
  if (!caller?.sessionId) return; // 认不出身份就不挂工具，避免冒名顶替

  const asWorker = host.workerOf(caller.sessionId);

  /* ---------------- worker 侧：回报 ---------------- */
  if (asWorker) {
    register(
      'send_to_lead',
      '把结果汇报给 Lead。Lead 会看到你的全部内容。\n\n' +
        '什么时候用：干完了、遇到卡点、需要 Lead 决策。\n' +
        '写什么：结论 + 关键细节（改了哪些文件、命令输出、为什么这么做）。\n' +
        '不要只说「完成了」—— Lead 看不到你的对话，也不在你的工作目录里。',
      {
        message: { type: 'string', description: '要汇报的内容，Lead 会完整看到' },
      },
      async (args) => {
        const message = String(args.message ?? '').trim();
        if (!message) return fail('message 不能为空');
        try {
          await host.reportToLead(asWorker.workerId, message);
          return ok({ success: true, note: '已汇报给 Lead' });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return; // worker 只需要回报，不需要派活
  }

  /* ---------------- lead 侧：派活 ---------------- */
  const leadId = caller.sessionId;

  register(
    'create_worker',
    `创建一个 worker 来并行干活。worker 是独立会话，有自己的工作目录和上下文。

什么时候用：有能独立完成、且你想并行做的子任务。
什么时候不用：任务很小（自己做完更快），或需要大量来回确认。

创建后 worker 处于待命，用 send_to_worker 派活。`,
    {
      role: {
        type: 'string',
        description: `角色名，决定它擅长什么。可选：${ORCA_PREDEFINED_ROLES.join(' / ')}。默认 developer`,
      },
      label: { type: 'string', description: '给这个 worker 起的短名字，撞名会自动加序号' },
      first_task: { type: 'string', description: '可选：创建后立刻派给它做的事' },
    },
    async (args) => {
      try {
        const w = await host.createWorker(leadId, {
          role: typeof args.role === 'string' ? args.role : 'developer',
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
          ...(typeof args.first_task === 'string' ? { firstTask: args.first_task } : {}),
        });
        return ok({
          success: true,
          worker_id: w.id,
          label: w.label,
          role: w.role,
          isolated: w.isolated === true,
          next: '用 send_to_worker 给它派活',
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  register(
    'send_to_worker',
    '给一个 worker 派活或追加要求。worker 会立刻开始干活，干完后用 send_to_lead 汇报。',
    {
      worker_id: { type: 'string', description: 'create_worker 返回的 id，或用 list_workers 查' },
      message: {
        type: 'string',
        description: '要它做的事。写清楚期望结果 —— worker 看不到你的对话，只说「继续」它不知道继续什么',
      },
    },
    async (args) => {
      const workerId = String(args.worker_id ?? '');
      const message = String(args.message ?? '').trim();
      if (!workerId || !message) return fail('worker_id 和 message 都不能为空');
      try {
        await host.sendToWorker(workerId, message);
        return ok({ success: true, note: '已派活，它干完会通过 send_to_lead 回报' });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  register(
    'list_workers',
    `列出你的 worker 及状态。limit 是硬上限 ${ORCA_WORKER_HARD_LIMIT} 个（受内存限制）。

status：idle 待命 / running 干活中 / done 干完了 / error 出错了`,
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
 * 造 provider。
 *
 * `isEnabled` 是关键：只有 lead 会话需要派活工具，worker 只要回报工具。
 * 更重要的 —— **普通会话不挂**。否则每个聊天都顶着一堆协同工具，
 * 模型会误以为用户想开协同。
 */
export function createOrcaProvider(host: OrcaProviderHost): McpProvider & {
  /**
   * 给宿主的 pi bridge 用：按 session 生成工具列表。
   * pi 的 MCP 是「本地 HTTP server」，宿主需要在每次 spawn 时问一遍。
   */
  materialize: (ctx: McpProviderContext) => {
    name: string;
    tools: Array<{ name: string; description: string; shape: Record<string, unknown> }>;
  };
} {
  return {
    name: ORCA_PROVIDER_NAME,
    capability: {
      title: '多 agent 协同',
      description: '把能并行的活拆给多个 worker，每个 worker 独立工作区，互不覆盖。',
      source: 'builtin',
    },

    isEnabled: (ctx) => {
      const caller = callerOf(ctx);
      if (!caller?.sessionId) return false;
      // worker 会话要回报工具；lead 会话要派活工具。
      // 普通会话（既不是 worker 也没开过协同）不挂 —— 见上面注释。
      return true;
    },

    materialize: (ctx) => {
      const tools: Array<{ name: string; description: string; shape: Record<string, unknown> }> = [];
      // 用一次假的 register 把定义抓下来：工具定义只写一遍，
      // 具体怎么注册交给调用方。
      defineOrcaTools(host, ctx, (name, description, shape) => {
        tools.push({ name, description, shape });
      });
      return { name: ORCA_PROVIDER_NAME, tools };
    },
  };
}
