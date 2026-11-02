/**
 * Phase 1 spike —— 最小宿主实现。
 *
 * 目的：证明 vendored @cindy/maker-core 可以在 Cindy 桌面端之外跑起来。
 * 这里只实现 maker-core 要求的三个注入点：
 *   1. SessionStorage   —— 内存版（6 个方法）
 *   2. AuthAdapter      —— 环境变量版（4 个必填方法）
 *   3. Logger           —— maker-core 自带的 createConsoleLogger
 *
 * 刻意不做的事（留给后续 Phase）：
 *   - 不接 SQLite（Phase 2）
 *   - 不接 MakerMemory（可选注入，spike 省略）
 *   - 不接 MCP provider（Pi 会用自己原生工具）
 *   - 不接 Electron（Phase 3）
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

import {
  ClaudeCodeAgent,
  createConsoleLogger,
  PiAgent,
  type AgentDeps,
  type AgentKind,
  type AuthAdapter,
  type AuthState,
  type Effort,
  type Logger,
  type McpProvider,
  type PiNativeApi,
  type SessionMeta,
  type SessionStorage,
} from '@cindy/maker-core';

/* ------------------------------------------------------------------ *
 * 1. SessionStorage —— 内存实现
 * ------------------------------------------------------------------ */

export class MemorySessionStorage implements SessionStorage {
  private readonly rows = new Map<string, SessionMeta>();

  async create(meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>): Promise<SessionMeta> {
    const now = Date.now();
    const row: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
    this.rows.set(row.id, row);
    return row;
  }

  async get(id: string): Promise<SessionMeta | null> {
    return this.rows.get(id) ?? null;
  }

  async list(): Promise<SessionMeta[]> {
    return [...this.rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const current = this.rows.get(id);
    if (!current) throw new Error(`session not found: ${id}`);
    const next: SessionMeta = { ...current, ...patch, id, updatedAt: Date.now() };
    this.rows.set(id, next);
    return next;
  }

  /**
   * 只有当前值仍等于 expected 时才清空，避免旧的失败覆盖并发写入的新值。
   * 这个语义在 maker-core 里是硬要求，内存实现也必须遵守。
   */
  async compareAndClearSdkSessionId(id: string, expected: string): Promise<boolean> {
    const current = this.rows.get(id);
    if (!current || current.sdkSessionId !== expected) return false;
    this.rows.set(id, { ...current, sdkSessionId: undefined, updatedAt: Date.now() });
    return true;
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

/* ------------------------------------------------------------------ *
 * 2. AuthAdapter —— 环境变量实现
 * ------------------------------------------------------------------ */

export interface EnvAuthOptions {
  /** 读取 API key 的环境变量名列表，按顺序取第一个非空值 */
  apiKeyEnvNames: string[];
  /** 注入给 agent 子进程的 env key，例如 Pi 期望的 CINDY_PI_API_KEY */
  targetEnvKey: string;
}

export function createEnvAuthAdapter(opts: EnvAuthOptions): AuthAdapter {
  const readKey = (): string | undefined => {
    for (const name of opts.apiKeyEnvNames) {
      const value = process.env[name];
      if (value && value.trim()) return value.trim();
    }
    return undefined;
  };

  const state = (): AuthState => {
    const key = readKey();
    return { authenticated: Boolean(key), authSource: key ? 'api-key' : undefined };
  };

  return {
    async getState() {
      return state();
    },
    async triggerLogin() {
      return state();
    },
    async logout() {
      /* 环境变量模式下没有可清理的本地凭证 */
    },
    async getAuthEnv() {
      const key = readKey();
      return key ? { [opts.targetEnvKey]: key } : {};
    },
  };
}

/* ------------------------------------------------------------------ *
 * 3. Agent 装配 —— 只装配 Pi
 * ------------------------------------------------------------------ */

export interface PiHostOptions {
  /** pi 可执行文件绝对路径（spike 直接指向仓库里的 apps/pi-bin/<platform>/pi[.exe]） */
  binaryPath: string;
  /** 模型 id，例如 "claude-sonnet-4-5" / "deepseek-v4.1-flash-1017" */
  model: string;
  /**
   * 上游 wire 协议。
   * - anthropic-messages：Anthropic 原生（Pi 自己追加 /v1/messages）
   * - openai-completions：OpenAI Chat Completions 兼容端点（baseUrl 以 /v1 为根）
   * - openai-responses：OpenAI Responses API
   * - google-generative-ai：Gemini
   */
  api?: PiNativeApi;
  /** 上游接入端点。undefined = 走 SDK/CLI 默认 */
  endpoint?: string;
  /** 上下文窗口大小，用于 models.json 与压缩判定 */
  contextWindow?: number;
  /**
   * 自动压缩在窗口的百分之几处触发（默认由 pi 决定，约 90）。
   * 值越小压缩越早 —— 小窗口模型上比默认值更实用。
   */
  compactionPct?: number;
  /** 支持的努力档位；空数组 = 该模型不支持 effort 切换 */
  efforts?: readonly Effort[];
  /**
   * 额外可切换的模型。不传 = 只有 opts.model 一个。
   *
   * 为什么需要：pi 的 availableModels 是切换的唯一来源。
   * 宿主不挂的话，UI 上根本没有可切的第二个模型。
   */
  extraModels?: readonly {
    id: string;
    label?: string;
    contextWindow?: number;
    efforts?: readonly Effort[];
  }[];
  /** 默认 effort；null = 不支持 */
  defaultEffort?: Effort | null;
  /** pi 配置目录（内含 models.json / sessions/） */
  agentHome: string;
  /**
   * 宿主注入的 MCP 工具提供者。
   *
   * 为什么用这个而不直接传 LOCAL_AGENT_CLIENT：
   * McpProvider 是 maker-core 的通用抽象，同一份工具定义能同时给
   * claude-code（SDK 形态）、codex（HTTP 形态）、pi（bridge 形态）用。
   * 绑死 LOCAL_AGENT_CLIENT 的话，ORCA 就只能跑在 pi 上。
   */
  mcpProviders?: McpProvider[];
  /**
   * 把 mcpProviders 转成 pi 能消费的 bridge 配置。
   *
   * pi 的 MCP 是「本地 HTTP bridge + LOCAL_AGENT_CLIENT」形态，
   * 跟 Claude 的 in-process server / Codex 的远程配置都不一样，
   * 所以转换逻辑归宿主 —— maker-core 只认这个回调。
   */
  preparePiExtraSpawnConfig?: AgentDeps['preparePiExtraSpawnConfig'];
  logger?: Logger;
}

export function createPiAgent(opts: PiHostOptions): PiAgent {
  const logger = opts.logger ?? createConsoleLogger('pi');
  const api: PiNativeApi = opts.api ?? 'anthropic-messages';
  const efforts = opts.efforts ?? ([] as const);
  const defaultEffort = opts.defaultEffort ?? (efforts.length > 0 ? efforts[1]! : null);

  const deps: AgentDeps = {
    auth: createEnvAuthAdapter({
      // 按优先级取第一个非空值；同时兼容 OpenAI 风格的 OPENAI_API_KEY
      apiKeyEnvNames: [
        'APP_PI_API_KEY',
        'SPIKE_PI_API_KEY',
        'CINDY_PI_API_KEY',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
      ],
      targetEnvKey: 'CINDY_PI_API_KEY',
    }),
    runtimeConfig: {
      endpoint: opts.endpoint,
      // 宿主产品级 system prompt。spike 阶段留空，Phase 3 再接。
      systemPrompt: undefined,
      autoCompactThresholdPct: 85,
    },
    binaryPath: opts.binaryPath,
    logger,
    // Pi 由 maker-core 在 agentHome 里生成 models.json，
    // 把这里声明的模型挂到单一 provider 下，baseUrl 取 runtimeConfig.endpoint。
    capabilityAdditions: {
      availableModels: [
        {
          id: opts.model,
          displayName: opts.model,
          contextWindow: opts.contextWindow ?? 200_000,
          efforts,
          defaultEffort,
          // efforts 为空时标明「目录未声明」，避免准入校验把「没声明」当成「明确不支持」
          effortsUnknown: efforts.length === 0,
        },
        // 额外模型：只负责让 pi 认得它们，切不切由用户决定。
        // 重复 id 直接跳过 —— 同一个模型挂两次会让目录里出现重复项。
        ...(opts.extraModels ?? [])
          .filter((m) => m.id && m.id !== opts.model)
          .map((m) => ({
            id: m.id,
            displayName: m.label ?? m.id,
            contextWindow: m.contextWindow ?? opts.contextWindow ?? 200_000,
            efforts: m.efforts ?? efforts,
            defaultEffort,
            effortsUnknown: (m.efforts ?? efforts).length === 0,
          })),
      ],
    },
    // 子代理运行器：pi 把 subagent 当独立进程跑，状态写磁盘上的 status.json。
    // 宿主只需把它拉起来 —— 不传这个依赖，subagent 扩展根本不会被写入，
    // 模型也就没有 subagent 工具可用（后台任务列表会永远是空的）。
    spawnPiSubagentRunner: (request) => {
      const child = spawn(process.execPath, [request.runnerFile, request.configFile], {
        cwd: request.cwd,
        env: {
          ...request.env,
          // 子进程与主进程同一个 Electron/Node 运行时；不加这个，
          // 打包后的 Electron 里 process.execPath 指向 electron.exe，会当成开新窗口
          ELECTRON_RUN_AS_NODE: '1',
        },
        // 输出走磁盘（status.json / output 文件），不需要管道；
        // 管道不消费会在缓冲区满时把子进程卡死。
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (error) => {
        logger.warn('pi subagent runner failed to spawn', {
          runId: request.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return child;
    },
    resolveModelContextLimit: () => opts.contextWindow ?? 200_000,
    // 不设就交给 pi 自己的默认策略（约 90%），宿主不擅自改运维口径
    resolveModelCompactionPct: () => opts.compactionPct ?? null,
    // 关键：上一次写死 anthropic-messages，接 OpenAI 兼容端点会直接把请求打歪
    resolvePiGatewayModelApi: () => api,
    resolvePiAgentHome: () => opts.agentHome,
    // MCP 工具提供者透传：ORCA 等能力走这一层，而不是写死 LOCAL_AGENT_CLIENT
    ...(opts.mcpProviders ? { mcpProviders: opts.mcpProviders } : {}),
    ...(opts.preparePiExtraSpawnConfig
      ? { preparePiExtraSpawnConfig: opts.preparePiExtraSpawnConfig }
      : {}),
  };

  return new PiAgent(deps);
}

/* ------------------------------------------------------------------ *
 * Claude Code 装配
 * ------------------------------------------------------------------ */

export interface ClaudeHostOptions {
  /** Claude Code CLI 绝对路径（如 upstream 里的 apps/claude-code-bin/win32-x64/claude.exe） */
  binaryPath: string;
  /** 默认模型 id */
  model: string;
  /**
   * Anthropic 协议端点。
   *
   * 注意：不是 openai-completions 那个 —— Claude CLI 只认 `/v1/messages`。
   * 实测腾讯 tokenhub 同时支持两种协议，所以同一个 key 两边都能用。
   */
  endpoint?: string;
  /** 上下文窗口 */
  contextWindow?: number;
  /** 额外可切换的模型 */
  extraModels?: readonly { id: string; label?: string; contextWindow?: number }[];
  /** 工作目录外的额外可写目录 */
  logger?: Logger;
  /** 同上：ORCA 等能力的 MCP 提供者 */
  mcpProviders?: McpProvider[];
}

/**
 * 造一个 Claude Code agent。
 *
 * 为什么要它：pi 的 MCP 工具一律藏在二段网关后面，模型看不到
 * `create_worker`，ORCA 的「Lead 自主派活」在 pi 上跑不通。
 * Claude Code 是直连 MCP（`toClaudeSdkConfig` 返回 in-process server），
 * 工具直接进模型视野。
 */
export function createClaudeCodeAgent(opts: ClaudeHostOptions): ClaudeCodeAgent {
  const logger = opts.logger ?? createConsoleLogger('claude');

  const deps: AgentDeps = {
    auth: createEnvAuthAdapter({
      // Claude CLI 直接读 ANTHROPIC_API_KEY；其它名字是兼容写的
      apiKeyEnvNames: ['APP_PI_API_KEY', 'SPIKE_PI_API_KEY', 'ANTHROPIC_API_KEY'],
      targetEnvKey: 'ANTHROPIC_API_KEY',
    }),
    runtimeConfig: {
      endpoint: opts.endpoint,
      autoCompactThresholdPct: 85,
      /*
       * 让 Claude Code CLI 接受「非官方模型名」的三个 flag。
       *
       * 少了 XDT_MAKER_MODEL_CONTEXT_WINDOWS，CLI 会认为模型未知，
       * **静默退出，一个请求都不发** —— 没有任何错误输出，极难查。
       * 加上之后 CLI 仍会打印 unrecognized_model 警告，但请求照发。
       *
       * 这个变量名是 Cindy（上游）自己定的，格式 { "model-id": 窗口 }。
       */
      behaviorFlags: {
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
        XDT_MAKER_MODEL_CONTEXT_WINDOWS: JSON.stringify({
          [opts.model]: opts.contextWindow ?? 200_000,
          ...Object.fromEntries(
            (opts.extraModels ?? []).map((m) => [
              m.id,
              m.contextWindow ?? opts.contextWindow ?? 200_000,
            ]),
          ),
        }),
      },
    },
    binaryPath: opts.binaryPath,
    logger,
    capabilityAdditions: {
      // ModelDescriptor 要有 displayName / efforts / defaultEffort；
      // efforts 给空数组 = 不支持档位切换（Claude 的档位由 SDK 自己管）
      availableModels: [
        {
          id: opts.model,
          displayName: opts.model,
          contextWindow: opts.contextWindow ?? 200_000,
          efforts: [] as const,
          defaultEffort: null,
        },
        ...(opts.extraModels ?? []).map((m) => ({
          id: m.id,
          displayName: m.label ?? m.id,
          contextWindow: m.contextWindow ?? opts.contextWindow ?? 200_000,
          efforts: [] as const,
          defaultEffort: null,
        })),
      ],
    },
    resolveModelContextLimit: () => opts.contextWindow ?? 200_000,
    resolveModelCompactionPct: () => null,
    ...(opts.mcpProviders ? { mcpProviders: opts.mcpProviders } : {}),
  };

  return new ClaudeCodeAgent(deps);
}

/* ------------------------------------------------------------------ *
 * 4. 平台相关的 pi 二进制解析
 * ------------------------------------------------------------------ */

export function resolvePiBinary(upstreamRepoRoot: string): string {
  const exe = process.platform === 'win32' ? 'pi.exe' : 'pi';
  const triple =
    process.platform === 'darwin'
      ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : process.platform === 'win32'
        ? `win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
        : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  return path.join(upstreamRepoRoot, 'apps', 'pi-bin', triple, exe);
}

export async function assertPiBinaryExists(binaryPath: string): Promise<void> {
  try {
    await fs.access(binaryPath);
  } catch {
    throw new Error(
      `pi binary not found at ${binaryPath}\n` +
        `请确认 spikes 指向的 upstream 仓库已执行过 pnpm install（apps/pi-bin 由 postinstall 下载）。`,
    );
  }
}

export type { AgentKind };

/** Claude Code CLI 路径（upstream 里有，和 pi-bin 同级） */
export function resolveClaudeBinary(upstreamRepoRoot: string): string {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const triple =
    process.platform === 'darwin'
      ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : process.platform === 'win32'
        ? `win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
        : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  return path.join(upstreamRepoRoot, 'apps', 'claude-code-bin', triple, exe);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
