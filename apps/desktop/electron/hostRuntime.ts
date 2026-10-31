/**
 * 主进程侧的宿主运行时。
 *
 * 把 maker-core + SQLite 包成一个「可被 IPC 驱动」的对象。
 * 这个文件不认识 Electron，纯 node —— 所以它能在没有窗口的情况下被测试。
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  Maker,
  createConsoleLogger,
  isTerminalTurnEvent,
  type AgentEvent,
  type Effort,
  type PiNativeApi,
  type Session,
} from '@cindy/maker-core';

import {
  MessageStore,
  ORCA_WORKER_HARD_LIMIT,
  OrcaStore,
  PermissionStore,
  SessionRecorder,
  SqliteSessionStorage,
  TurnStore,
  assertPiBinaryExists,
  createPiAgent,
  openDatabase,
  orcaWorkerSessionTitle,
  resolvePiBinary,
  type Db,
  type OrcaWorkerConfig,
  type OrcaWorkerRecord,
} from '@juno/host-core';

import type {
  ApprovalRequest,
  CompactResult,
  ContextUsage,
  HostEvent,
  InterruptedTurn,
  ModeState,
  NavigateResult,
  PermissionModeChoice,
  TaskInfo,
  TreeEntry,
  UiMessage,
} from '../src/shared/ipc.js';

import {
  collectTurnDiff,
  createBaseline,
  type DiffBaseline,
} from './turnDiff.js';
import { parseModelCatalog } from './modelCatalog.js';
import { createSavepoint, restoreSavepoint } from './gitSavepoint.js';
import { saveImageAttachment, type SavedImage } from './imageAttachment.js';
import { prepareWorkerWorktree, removeWorkerWorktree } from './workerWorktree.js';

export interface HostConfig {
  upstreamRoot: string;
  /** 直接指定 pi 可执行文件；打包后指向 resources/pi-bin/pi.exe */
  binaryPath?: string;
  /** 当前模型；会因热切换而改，所以不是只读 */
  model: string;
  endpoint: string;
  api: PiNativeApi;
  contextWindow: number;
  /** 自动压缩触发点（窗口百分比）；不设就走 pi 默认 */
  compactionPct?: number;
  efforts: readonly Effort[];
  dataDir: string;
  workDir: string;
  agentHome: string;
  /** 审批策略：真实产品用 'ipc'（抛给渲染层），CLI 用 'allow' */
  approval: 'ipc' | 'allow';
  /** 导出 HTML 的落地目录 */
  exportDir: string;
  /** 模型 key；来自环境变量或本地设置。pi 子进程靠它认证 */
  apiKey?: string;
  /** 多模型清单（JSON 字符串）；与 APP_MODELS 同格式 */
  modelsJson?: string;
  /**
   * 一轮零事件多久后判定卡死（毫秒）。0 = 关闭。
   *
   * 引擎自己的默认是 45 分钟 —— 对用户来说太久了，
   * 45 分钟里界面只会一直转圈，人早放弃了。
   */
  turnStallMs?: number;
}

export interface EnvOverrides {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  api?: string;
  contextWindow?: number;
  models?: string;
  efforts?: string;
  approval?: 'ipc' | 'allow';
  workDir?: string;
}

/**
 * 构造宿主配置。
 *
 * 优先级：环境变量 > 本地配置文件 > 内置默认值。
 * 环境变量优先是为了 CI / 脚本注入不被本地文件覆盖。
 */
export function configFromEnv(file: EnvOverrides = {}): HostConfig {
  const dataDir =
    process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'spike-desktop');
  const pick = (envName: string, fileValue: string | undefined, fallback: string): string =>
    process.env[envName]?.trim() || fileValue?.trim() || fallback;

  // 卡死判定阈值：默认 15 分钟。
  // 引擎默认 45 分钟太长 —— 那段时间界面只会静默转圈。
  const stallMinutes = Number(process.env.APP_STALL_MINUTES ?? 15);
  const turnStallMs =
    Number.isFinite(stallMinutes) && stallMinutes > 0 ? stallMinutes * 60_000 : 0;

  return {
    upstreamRoot:
      process.env.APP_UPSTREAM_ROOT ??
      'C:/Users/chiaki/Desktop/agent/upstream/cindy',
    binaryPath: process.env.APP_PI_BINARY,
    model: pick('APP_MODEL', file.model, 'deepseek-v4.1-flash-1017'),
    endpoint: pick('APP_ENDPOINT', file.endpoint, 'https://tokenhub.tencentmaas.com/v1'),
    api: pick('APP_API', file.api, 'openai-completions') as PiNativeApi,
    contextWindow: Number(
      process.env.APP_CONTEXT_WINDOW ?? file.contextWindow ?? 200_000,
    ),
    compactionPct: process.env.APP_COMPACT_PCT
      ? Number(process.env.APP_COMPACT_PCT)
      : undefined,
    efforts: pick('APP_EFFORTS', file.efforts, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as Effort[],
    dataDir,
    workDir:
      process.env.APP_WORKDIR?.trim() || file.workDir?.trim() || path.join(dataDir, 'workspace'),
    agentHome: process.env.APP_AGENT_HOME ?? path.join(dataDir, 'pi-agent-home'),
    approval: (pick('APP_APPROVAL', file.approval, 'ipc') as 'ipc' | 'allow'),
    exportDir: process.env.APP_EXPORT_DIR ?? path.join(dataDir, 'exports'),
    /** 给 pi 子进程的 key；环境变量没配就用设置里的 */
    apiKey: process.env.APP_PI_API_KEY?.trim() || file.apiKey?.trim() || undefined,
    /** 多模型清单（JSON 字符串），运行期解析 */
    modelsJson: process.env.APP_MODELS?.trim() || file.models?.trim() || undefined,
    turnStallMs,
  };
}

const logger = createConsoleLogger('host');

/**
 * 引擎给的树历史 → UI 消息。
 *
 * 与 main.ts 的 rowToUiMessage 形状保持一致，但输入不同：
 * 这里拿到的是引擎内部条目，不是我们库里的行。
 * thinking / tool_use / tool_result 也一并保留，否则回退后的历史会缺块。
 */
function historyToUiMessage(row: {
  clientId: string;
  role: string;
  content: unknown;
  toolUseId?: string;
}): UiMessage | null {
  const id = row.clientId;

  // content 有两种形状：user 是 { text }，assistant 的文本块直接是字符串。
  // 只认一种就会把另一半渲染成空白 —— 回退后对话区全空就是这么来的。
  if (typeof row.content === 'string') {
    const role = row.role === 'user' || row.role === 'assistant' || row.role === 'thinking'
      ? row.role
      : null;
    if (!role) return null;
    return { id, role, text: row.content };
  }

  const c = (row.content ?? {}) as Record<string, unknown>;

  if (row.role === 'user' || row.role === 'assistant' || row.role === 'thinking') {
    return { id, role: row.role, text: String(c.text ?? '') };
  }
  if (row.role === 'tool_use') {
    return {
      id,
      role: 'tool_use',
      toolName: String(c.toolName ?? '?'),
      toolUseId: String(c.toolUseId ?? row.toolUseId ?? ''),
      input: c.input,
    };
  }
  if (row.role === 'tool_result') {
    return {
      id,
      role: 'tool_result',
      toolUseId: String(c.toolUseId ?? row.toolUseId ?? ''),
      output: String(c.fullText ?? c.summary ?? ''),
      isError: c.isError === true,
    };
  }
  return null;
}

/**
 * 把引擎的英文状态翻成人话。
 *
 * 不是逐字翻译：「Working…」这种没用，用户已经知道它在工作。
 * 能确认到具体工具就说得具体（「正在执行 bash」）；确认不了就保持宽松描述。
 */
function humanizeStatus(raw: string | undefined, toolName: string | null): string {
  const text = (raw ?? '').toLowerCase();

  if (text.includes('compact')) return '正在压缩上下文';
  if (text.includes('thinking') || text.includes('reasoning')) return '正在思考';

  if (toolName) {
    const map: Record<string, string> = {
      bash: '正在执行命令',
      powershell: '正在执行命令',
      read: '正在读文件',
      write: '正在写文件',
      edit: '正在改文件',
      ls: '正在看目录',
      grep: '正在搜索',
      glob: '正在找文件',
      subagent: '正在派子任务',
      ask_user_question: '在等你回答',
    };
    const mapped = map[toolName];
    if (mapped) return mapped;
    return `正在用 ${toolName}`;
  }

  return '正在处理';
}

/** 从库里的 JSON 字符串读目录名单；坏数据一律当空，不报错 */
function parseDirList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

/** 去空、去重、统一分隔符；同一目录不会因为写法不同被算两次 */
function normalizeDirs(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = path.resolve(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** 文件名里的非法字符：Windows 比 posix 严，统一按最严的来 */
function sanitizeFileName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 末尾的点和空格在 Windows 上会被静默吃掉，进而导致路径对不上
    .replace(/[. ]+$/, '');
  return (cleaned || '会话').slice(0, 60);
}

/** 新建会话的占位标题；只有还是它的时候才会被自动改写 */
const DEFAULT_SESSION_TITLE = '新会话';

/**
 * 从用户第一句话里压出一个标题。
 *
 * 有意不调模型：标题要在会话刚建立时立刻出现，而且它只是个导航标识，
 * 不是内容。规则生成即时、免费、可预测，失败也没法坏到哪里去。
 * 想更聪明的话，以后可以拿模型润色覆盖这一步的结果。
 */
function makeSessionTitle(input: string): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  // 去掉开场客套：标题位置宝贵，不需要「请」「帮我」
  const stripped = oneLine.replace(/^(请你?|帮我|麻烦你?|能不能|可以|帮忙)+/, '').trim();
  const base = stripped || oneLine;
  const MAX = 24;
  return base.length > MAX ? `${base.slice(0, MAX)}…` : base;
}

interface PendingApproval {
  resolve: (decision: unknown) => void;
  /** 记住规则时要用到的上下文 */
  toolName: string;
  subject: string | null;
  /** 哪个会话发起的：多会话并行下不能靠「当前会话」猜 */
  sessionId: string | null;
}

export class HostRuntime {
  private db!: Db;
  private storage!: SqliteSessionStorage;
  private messages!: MessageStore;
  private turns!: TurnStore;
  private permissions!: PermissionStore;
  /** ORCA 协作：team / worker 的持久化 */
  private orca!: OrcaStore;
  private recorder!: SessionRecorder;
  private maker!: Maker;
  /**
   * 所有活着的会话。
   *
   * 之前只有一个 this.session，切会话就得关掉旧的、重建新的 ——
   * 后果是「让它跑 A，我去看 B」会把 A 打断。
   * 现在按 sessionId 常驻，切会话只是切 UI，后台那轮照跑。
   */
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingApproval>();
  private listeners = new Set<(event: HostEvent) => void>();
  /**
   * 每个会话当前在跑的那一轮。
   *
   * 之前是全局单值 activeTurnId —— 那隐含「同时只能有一轮」，
   * 多会话并行就是要拆掉这个假设。
   */
  private readonly activeTurns = new Map<string, string>();

  /** 兼容旧代码：最近一次操作的会话 id，用于 steer/cancel 这类没带 sessionId 的路径 */
  private activeTurnSessionId: string | null = null;
  /**
   * 每一轮各自一份订阅，按 turnId 归档。
   *
   * Session.onEvent 是集合订阅（不会自动退订），同一 session 续发多次会把
   * 每个事件投给 N 个 handler —— 消息重复落库、turn 被收口多次。
   * 之所以不用一个字段存「当前订阅」：如果上一轮还没收口就来了新 send，
   * 旧订阅会被默默覆盖，那一轮就永远停在 running（落库残留 + 重启后误报中断）。
   */
  private readonly turnUnsubs = new Map<string, () => void>();
  /**
   * 本轮动作的基准与痕迹。
   *
   * pi 不发 turn_diff（只有 codex 发），所以改动得我们自己算：
   * 轮开始前记 git 基准，期间收集 tool_use 碰过的路径（非 git 目录的兼底）。
   */
  private turnTrace: {
    turnId: string;
    cwd: string;
    baseline: DiffBaseline;
    paths: string[];
  } | null = null;

  /**
   * 当前权限/计划模式。
   *
   * 为什么要在宿主侧存一份：引擎的 getPlanMode() 可能返回 null，
   * 而 UI 总得知道现在是什么状态。这里存的是「最后一次确认过的值」。
   */
  private modes: ModeState = { permissionMode: 'ask', planMode: false, effort: null, effortLevels: [] };

  /** 引擎推来的子任务，按 taskId 聚合成最新快照 */
  private readonly taskMap = new Map<string, TaskInfo>();
  /** 每轮最近一次工具名，用于把状态写得具体一点 */
  private readonly toolByTurn = new Map<string, string>();
  /** 每轮最新的 token 用量 */
  private readonly lastUsageTokens = new Map<string, number>();
  /**
   * 每轮最后一次收到事件的时刻。
   * 状态行用它算「多久没动静了」，超过阈值就提示可能卡住。
   */
  private readonly lastEventAt = new Map<string, number>();
  /**
   * 每轮「正在执行中的工具」。
   *
   * 工具从调用到返回之间可能很久没事件（`sleep 60`、大文件读写），
   * 那是正常执行，不是卡死。不区分的话会把正常的长命令误报成无响应。
   */
  private readonly runningTools = new Map<string, string>();

  /** 可选模型清单。启动时解析一次，运行期不变 */
  private readonly catalog: ReturnType<typeof parseModelCatalog>;

  constructor(private readonly cfg: HostConfig) {
    this.catalog = parseModelCatalog(process.env.APP_MODELS, {
      id: cfg.model,
      contextWindow: cfg.contextWindow,
      efforts: [...cfg.efforts],
    });
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* 渲染进程可能已销毁，忽略 */
      }
    }
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cfg.dataDir, { recursive: true });
    await fs.mkdir(this.cfg.workDir, { recursive: true });
    await fs.mkdir(this.cfg.agentHome, { recursive: true });

    this.db = await openDatabase(path.join(this.cfg.dataDir, 'app.db'));
    this.storage = new SqliteSessionStorage(this.db);
    this.messages = new MessageStore(this.db);
    this.turns = new TurnStore(this.db);
    this.permissions = new PermissionStore(this.db);
    this.orca = new OrcaStore(this.db);
    this.recorder = new SessionRecorder(this.db, this.messages, this.turns);

    // 启动期把上次被杀时停在 running 的轮收口
    const reaped = this.turns.reapInterrupted();
    if (reaped.length > 0) logger.warn('reaped interrupted turns', { count: reaped.length });

    const binaryPath = this.cfg.binaryPath ?? resolvePiBinary(this.cfg.upstreamRoot);
    await assertPiBinaryExists(binaryPath);

    const agent = createPiAgent({
      binaryPath,
      model: this.cfg.model,
      api: this.cfg.api,
      endpoint: this.cfg.endpoint,
      contextWindow: this.cfg.contextWindow,
      compactionPct: this.cfg.compactionPct,
      extraModels: this.catalog.multi
        ? this.catalog.entries
            .filter((m) => m.id !== this.cfg.model)
            .map((m) => ({
              id: m.id,
              label: m.label,
              contextWindow: m.contextWindow,
              efforts: (m.efforts as Effort[] | undefined) ?? undefined,
            }))
        : undefined,
      efforts: this.cfg.efforts,
      defaultEffort:
        this.cfg.efforts.length > 0
          ? this.cfg.efforts[Math.floor(this.cfg.efforts.length / 2)]!
          : null,
      agentHome: this.cfg.agentHome,
      logger: logger.child('pi'),
    });

    this.maker = new Maker({ agents: { pi: agent }, storage: this.storage, logger });
    logger.info('host ready', {
      model: this.cfg.model,
      api: this.cfg.api,
      dataDir: this.cfg.dataDir,
    });
  }

  /**
   * 启动期要提示用户的中断轮列表。
   *
   * 这里把「继续」需要的东西一次性备齐，而不是让渲染层再回头查：
   * 原文要拿来零产出时重发，hasOutput 决定该重发还是发续跑指令。
   */
  interruptedTurns(): InterruptedTurn[] {
    return this.turns.listInterrupted().map((t) => {
      const titleRow = this.db
        .prepare('SELECT title FROM sessions WHERE id = ?')
        .get(t.sessionId) as { title: string } | undefined;

      const userRow = t.userClientId
        ? (this.db
            .prepare(
              'SELECT id, content FROM messages WHERE session_id = ? AND client_id = ? AND rewind_at IS NULL LIMIT 1',
            )
            .get(t.sessionId, t.userClientId) as
            | { id: string; content: string }
            | undefined)
        : undefined;

      let userText: string | null = null;
      if (userRow) {
        try {
          const parsed = JSON.parse(userRow.content) as { text?: string };
          userText = parsed.text?.trim() || null;
        } catch {
          userText = null;
        }
      }

      // 用户那句话之后是否已经落过任何一条消息 —— 决定续跑语义
      let hasOutput = false;
      if (userRow) {
        const row = this.db
          .prepare(
            'SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND rewind_at IS NULL ' +
              'AND rowid > (SELECT rowid FROM messages WHERE id = ?)',
          )
          .get(t.sessionId, userRow.id) as { c: number };
        hasOutput = row.c > 0;
      }

      return {
        turnId: t.id,
        sessionId: t.sessionId,
        sessionTitle: titleRow?.title || '未命名会话',
        startedAt: t.startedAt,
        userText,
        hasOutput,
      };
    });
  }

  /**
   * 继续一个被中断的轮。
   *
   * 两种语义，对应两种真实情况：
   *   - 已经有产出（跑过工具或已经写了一半话）→ 发续跑指令，模型接着做
   *   - 零产出（被杀在模型回包之前）→ 重发用户原文，否则模型不知道要干什么
   *
   * 先 markResolved 再 send：万一 send 抛错，这句提示不会再弹一次，
   * 用户可以从错误消息里看到失败原因，比反复骚扰好。
   */
  async resumeTurn(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`turn not found: ${turnId}`);
    if (turn.state !== 'interrupted') {
      throw new Error(`turn is not resumable (state=${turn.state}): ${turnId}`);
    }

    // 双击「继续」会并发进来两次；resolved_at 是幂等标记，用它挡住第二次
    if (turn.resolvedAt !== null) {
      throw new Error(`turn already handled: ${turnId}`);
    }

    const info = this.interruptedTurns().find((t) => t.turnId === turnId);
    this.turns.markResolved(turnId);

    // 续跑指令必须带上原任务原文。
    // 只说「继续没做完的事」时模型看不到到底在继续什么：上下文里那一问早已答完，
    // 它会以为要自己去找活干 —— 于是翻目录、跑命令，一轮接一轮停不下来（实测 120s 超时）。
    const text = info?.hasOutput
      ? [
          '继续你刚才没做完的事，从断点接着做，不要复述已经完成的部分。',
          info.userText ? `\n被中断那一轮，用户的原话是：「${info.userText}」` : '',
          '\n如果这件事其实已经做完，直接说明现状并结束，不要另起新任务。',
        ].join('')
      : info?.userText;

    if (!text) {
      this.emit({
        type: 'error',
        message: '这一轮没有留下可用的原文，无法自动续跑，请手动重新发送。',
      });
      return;
    }

    // 重发原文时必须沿用原来的 client_id，否则 user 气泡会出现两条
    const reuseClientId = info?.hasOutput ? undefined : (turn.userClientId ?? undefined);
    await this.send(turn.sessionId, text, { reuseClientId });
  }

  /** 忽略一个中断轮，不再提示 */
  dismissTurn(turnId: string): void {
    this.turns.markResolved(turnId);
  }

  async createSession(
    title = '新会话',
    /** ORCA worker 用：工作目录与模型可以跟 lead 不一样 */
    model?: string,
    workingDir?: string,
  ): Promise<string> {
    const session = await this.maker.createSession({
      agentKind: 'pi',
      workingDir: workingDir ?? this.cfg.workDir,
      model: model ?? this.cfg.model,
      title,
      // 传 undefined 时引擎用自己的 45 分钟默认值；我们显式给 15 分钟
      ...(this.cfg.turnStallMs !== undefined ? { turnStallMs: this.cfg.turnStallMs } : {}),
    });
    this.attach(session);
    return session.id;
  }

  async ensureSession(): Promise<string> {
    // 已经有活着的会话就直接复用（启动时 bootstrap 会调到这里）
    const alive = this.sessions.values().next();
    if (!alive.done) return alive.value.id;
    const existing = await this.storage.list();
    if (existing.length > 0) {
      return await this.resume(existing[0]!.id);
    }
    return await this.createSession();
  }

  /**
   * 取会话实例，没有就建。
   *
   * 取代原来「this.session 不是它 → resume」那套写法：
   * 那个写法的隐含语义是「同一时刻只能有一个会话」，
   * 而这正是多会话并行要拆掉的东西。
   */
  private async getSession(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    await this.resume(sessionId);
    const created = this.sessions.get(sessionId);
    if (!created) throw new Error(`会话创建失败: ${sessionId}`);
    return created;
  }

  async resume(sessionId: string): Promise<string> {
    // 已经活着的会话直接复用。
    // 这里无条件重建的话，切走再切回会把正在跑的那一轮连同它的订阅一起换掉 ——
    // 后台任务静默消失，而且不会有任何报错。
    if (this.sessions.has(sessionId)) return sessionId;

    const meta = await this.storage.get(sessionId);
    if (!meta) throw new Error(`session not found: ${sessionId}`);
    const session = await this.maker.createSession({
      id: sessionId,
      agentKind: 'pi',
      workingDir: meta.workDir,
      model: meta.model,
      title: meta.title,
      ...(this.cfg.turnStallMs !== undefined ? { turnStallMs: this.cfg.turnStallMs } : {}),
    });
    this.attach(session);
    // 重建会话后必须把额外目录重新交给引擎 —— 它们只存在于运行时，
    // 不重放的话重启一次就白设了。
    await this.reapplyExtraDirs(sessionId, session);
    return session.id;
  }

  /** 把库里记着的额外目录重新应用到引擎 */
  private async reapplyExtraDirs(sessionId: string, session: Session): Promise<void> {
    const dirs = this.readExtraDirs(sessionId);
    if (dirs.read.length === 0 && dirs.write.length === 0) return;
    try {
      if (dirs.read.length > 0) await session.setExtraDirs(dirs.read);
      if (dirs.write.length > 0) await session.setWritableDirs(dirs.write);
    } catch (error) {
      // 目录可能已经被删了。不能让一个失效设置把会话拦在门外。
      logger.warn('重新应用额外目录失败', {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 读某会话的额外目录 */
  readExtraDirs(sessionId: string): { read: string[]; write: string[] } {
    const row = this.db
      .prepare('SELECT extra_read_dirs, extra_write_dirs FROM sessions WHERE id = ?')
      .get(sessionId) as { extra_read_dirs?: string; extra_write_dirs?: string } | undefined;
    return {
      read: parseDirList(row?.extra_read_dirs),
      write: parseDirList(row?.extra_write_dirs),
    };
  }

  /**
   * 设置额外目录。落库 + 立即生效。
   *
   * 两个列表分开传：只读和可写是两个权限层级，
   * 合并成一个列表会让用户以为「加进来就能写」。
   */
  async setExtraDirs(
    sessionId: string,
    dirs: { read: string[]; write: string[] },
  ): Promise<void> {
    const session0 = await this.getSession(sessionId);
    const session = session0;

    const read = normalizeDirs(dirs.read);
    const write = normalizeDirs(dirs.write);

    // 先落库再动引擎：万一引擎报错，至少设置不会丢；
    // 反过来会出现「UI 上看着设了，重启后没了」。
    this.db
      .prepare('UPDATE sessions SET extra_read_dirs = ?, extra_write_dirs = ? WHERE id = ?')
      .run(JSON.stringify(read), JSON.stringify(write), sessionId);

    await session.setExtraDirs(read);
    await session.setWritableDirs(write);
  }

  private attach(session: Session): void {
    this.sessions.set(session.id, session);
    session.setInteractionListener(async (req) => {
      if (this.cfg.approval === 'allow') {
        return req.kind === 'permission'
          ? ({ kind: 'permission', behavior: 'allow' } as never)
          : ({ kind: req.kind, behavior: 'allow' } as never);
      }

      // 先查记忆规则：命中就不惊动用户
      if (req.kind === 'permission') {
        const toolName = req.toolName ?? 'unknown';
        const subject = extractSubject(toolName, req.input);
        const rule = this.permissions.lookup(toolName, subject, session.id);
        if (rule) {
          logger.debug('permission rule hit', { toolName, subject, behavior: rule.behavior });
          return { kind: 'permission', behavior: rule.behavior } as never;
        }
      }

      return await this.askRenderer(req);
    });
  }

  /** 把审批请求抛给渲染层，等它回答 */
  private askRenderer(req: {
    kind: string;
    toolName?: string;
    input?: Record<string, unknown>;
  }): Promise<never> {
    const requestId = randomUUID();
    const toolName = req.toolName ?? req.kind;
    const subject = extractSubject(toolName, req.input);
    const request: ApprovalRequest = {
      requestId,
      kind: req.kind as ApprovalRequest['kind'],
      toolName: req.toolName,
      input: safeInput(req.input),
      summary: req.toolName ?? req.kind,
      // 渲染层拿它展示「记住 bash: git」——具体含义仍然由宿主定义
      rememberKey: subject ? `${toolName}: ${subject}` : toolName,
    };

    // 必须先注册 pending 再 emit。
    // 监听器若在事件里同步回批准（自动批准策略、测试脚本），
    // 先 emit 会让 approve() 查不到 pending，决定被静默丢弃，工具永远挂住。
    const waiting = new Promise<never>((resolve) => {
      this.pending.set(requestId, {
        resolve: resolve as (d: unknown) => void,
        toolName,
        subject,
        sessionId: this.activeTurnSessionId,
      });
    });

    this.emit({ type: 'approval', request });
    return waiting;
  }

  approve(
    requestId: string,
    behavior: 'allow' | 'deny',
    options?: { answers?: Record<string, string>; remember?: 'none' | 'session' | 'global' },
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);

    // 先落规则再解挂：即使随后 agent 报错，用户的「记住」也不该丢
    const remember = options?.remember ?? 'none';
    if (remember !== 'none' && entry.subject !== undefined) {
      this.permissions.add({
        toolName: entry.toolName,
        subject: entry.subject,
        behavior,
        scope: remember,
        sessionId:
          remember === 'session' ? entry.sessionId : null,
      });
    }

    entry.resolve(
      options?.answers
        ? { kind: 'ask_user_question', answers: options.answers }
        : {
            kind: 'permission',
            behavior,
            reason: behavior === 'deny' ? 'user denied' : undefined,
          },
    );
    this.emit({ type: 'approval_settled', requestId });
  }

  async send(
    sessionId: string,
    text: string,
    opts?: { reuseClientId?: string; images?: string[] },
  ): Promise<void> {
    const session0 = await this.getSession(sessionId);

    const session = session0;

    // 图片先落盘再开轮：落盘失败时不应该已经开了一个空轮
    const savedImages: SavedImage[] = [];
    for (const dataUrl of opts?.images ?? []) {
      savedImages.push(await saveImageAttachment(path.join(this.cfg.dataDir, 'sessions'), dataUrl));
    }

    const turn = this.recorder.beginUserTurn(
      sessionId,
      'pi',
      text,
      opts?.reuseClientId,
      savedImages.map((img) => ({ path: img.path })),
    );
    this.maybeTitleSession(sessionId);

    // 拍快照：必须在 send 之前。send 一返回模型就可能开始改文件，
    // 晚一步拍到的已经是「改过之后」了，回退就没意义。
    // 失败不阻断发送 —— 没有快照只是不能回退文件，对话仍然能用。
    const savepoint = await createSavepoint(this.cfg.workDir, sessionId).catch(
      (error: unknown) => ({
        commit: null,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    if (savepoint.commit) {
      this.turns.setSavepoint(turn.turnId, savepoint.commit);
    } else {
      logger.debug('savepoint 未创建，文件回滚将不可用', { reason: savepoint.reason });
    }

    // 上一轮还没收口就来了新 send：旧订阅要先拆掉，否则它会继续吃新一轮的事件，
    // 把新事件写到旧 turnId 名下。同时如实把旧轮收成 interrupted，
    // 免得库里留一条永远 running 的行、下次启动误报「未完成」。
    const staleTurnId = this.activeTurns.get(sessionId);
    if (staleTurnId) {
      const stale = staleTurnId;
      this.turnUnsubs.get(stale)?.();
      this.turnUnsubs.delete(stale);
      this.recorder.finish(stale, 'interrupted');
      this.emit({ type: 'turn', sessionId, turnId: stale, state: 'interrupted' });
      logger.warn('send 被新消息顶掉，上一轮已标为 interrupted', { stale });
    }

    this.activeTurns.set(sessionId, turn.turnId);
    this.activeTurnSessionId = sessionId;
    this.emit({ type: 'turn', sessionId, turnId: turn.turnId, state: 'running' });

    // 同一轮可能收到多个终态事件（引擎的 done 与会话收口事件），
    // 收口只能通知一次 —— 渲染层依赖它去重拉历史、去推进队列
    let settled = false;
    const unsubscribe = session.onEvent((event: AgentEvent) => {
      // 订阅排在被顶掉之后仍可能收到残留事件；不是自己这轮的就不认
      if (settled) return;
      this.recorder.onEvent(sessionId, turn.turnId, 'pi', event);
      this.project(event, sessionId, turn.turnId);
      this.traceEvent(event);

      if (event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        settled = true;
        const state = event.type === 'error' ? 'error' : 'done';
        this.emit({ type: 'turn', sessionId, turnId: turn.turnId, state });
        // 状态行必须跟着消失，否则界面上会一直挂着「正在执行命令」
        this.emit({ type: 'status', sessionId, status: null });
        this.toolByTurn.delete(turn.turnId);
        this.lastUsageTokens.delete(turn.turnId);
        this.lastEventAt.delete(turn.turnId);
        this.runningTools.delete(turn.turnId);
        this.activeTurns.delete(sessionId);
        unsubscribe();
        this.turnUnsubs.delete(turn.turnId);
        // 先把轮收口通知发出去（UI 立刻不再转圈），再静悄悄算 diff
        void this.finishTurnDiff(turn.turnId);
      }
    });
    this.turnUnsubs.set(turn.turnId, unsubscribe);

    // 基准必须在 send 之前拍：send 一返回，模型可能已经开始写文件了
    this.turnTrace = {
      turnId: turn.turnId,
      cwd: this.cfg.workDir,
      baseline: await createBaseline(this.cfg.workDir),
      paths: [],
    };

    await session.send(
      savedImages.length === 0
        ? text
        : ({
            type: 'user',
            content: [
              { type: 'text', text },
              ...savedImages.map((img) => ({ type: 'image', path: img.path })),
            ],
          } as never),
    );
  }

  /** 记下本轮 tool_use 碰过的路径（非 git 目录时当兼底） */
  private traceEvent(event: AgentEvent): void {
    const trace = this.turnTrace;
    if (!trace) return;
    if (event.type !== 'tool_use') return;
    const d = (event.data ?? {}) as Record<string, unknown>;
    const input = d.input as Record<string, unknown> | undefined;
    if (!input) return;
    for (const key of ['path', 'file_path', 'filePath', 'target_path']) {
      const value = input[key];
      if (typeof value === 'string' && value) trace.paths.push(value);
    }
  }

  /** 轮结束后算改动并广播。失败就静静算了 —— diff 是辅助信息，不该报错打扰人 */
  private async finishTurnDiff(turnId: string): Promise<void> {
    const trace = this.turnTrace;
    if (!trace || trace.turnId !== turnId) return;
    this.turnTrace = null;
    try {
      const diff = await collectTurnDiff(trace.cwd, trace.baseline, trace.paths);
      this.emit({ type: 'turn_diff', turnId, ...diff });
    } catch (error) {
      logger.debug('turn diff unavailable', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** AgentEvent → 渲染层事件。只映射 UI 需要的，不做业务判断 */
  private project(event: AgentEvent, sessionId: string, turnId: string): void {
    switch (event.type) {
      case 'text': {
        const d = event.data as { text?: string; isFinal?: boolean };
        // 顺手记下 token 用量，状态行要显示
        const meta = (event as { agentMeta?: { usage?: { totalTokens?: number } } }).agentMeta;
        if (typeof meta?.usage?.totalTokens === 'number') {
          this.lastUsageTokens.set(turnId, meta.usage.totalTokens);
        }
        if (d?.text)
          this.emit({ type: 'text', sessionId, turnId, text: d.text, isFinal: d.isFinal === true });
        return;
      }
      case 'thinking': {
        const d = event.data as { text?: string; isFinal?: boolean };
        if (d?.text)
          this.emit({ type: 'thinking', sessionId, turnId, text: d.text, isFinal: d.isFinal === true });
        return;
      }
      case 'tool_use': {
        const d = event.data as Record<string, unknown>;
        const toolName = String(d?.toolName ?? '?');
        // 记下来给状态行用：引擎只会说「Working…」，具体在跑什么这个更准
        this.toolByTurn.set(turnId, toolName);
        this.runningTools.set(turnId, String(d?.toolUseId ?? toolName));
        this.emit({
          type: 'tool_use',
          sessionId,
          turnId,
          toolUseId: String(d?.toolUseId ?? ''),
          toolName,
          input: d?.input,
        });
        return;
      }
      case 'tool_result_full': {
        const d = event.data as Record<string, unknown>;
        // 工具结束了，「正在执行」的标记要清掉，否则后面真的卡住也报不出来
        this.runningTools.delete(turnId);
        this.emit({
          type: 'tool_result',
          sessionId,
          turnId,
          toolUseId: String(d?.toolUseId ?? ''),
          output: String(d?.fullText ?? ''),
          isError: d?.isError === true,
        });
        return;
      }
      case 'error': {
        const d = event.data as Record<string, unknown>;
        this.emit({ type: 'error', sessionId, message: String(d?.message ?? 'unknown error') });
        return;
      }
      case 'compact_boundary': {
        const d = (event.data ?? {}) as Record<string, unknown>;
        this.emit({
          type: 'compact',
          turnId,
          trigger: d.trigger === 'manual' ? 'manual' : 'auto',
          preTokens: typeof d.preTokens === 'number' ? d.preTokens : null,
          postTokens: typeof d.postTokens === 'number' ? d.postTokens : null,
        });
        return;
      }
      case 'status': {
        this.projectStatus(event, sessionId, turnId);
        return;
      }
      case 'agent_task_update': {
        this.trackTask(event.data as Record<string, unknown>);
        return;
      }
      case 'plan_mode_changed': {        // agent 自己也会切计划模式（比如计划批准后自动退出），
        // 不同步的话 UI 上那个开关会与实际状态相反
        const d = (event.data ?? {}) as { enabled?: boolean };
        if (typeof d.enabled === 'boolean') {
          this.modes.planMode = d.enabled;
          this.emitModes();
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * 标题取「用户在这个会话里的第一句话」，不取当前这句。
   *
   * 原因是续跑会发「继续你刚才没做完的事」这种合成指令，
   * 拿它当标题会把会话名改成一句废话。
   */
  private maybeTitleSession(sessionId: string): void {
    const row = this.db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as
      | { title: string | null }
      | undefined;
    if (!row) return;

    const current = (row.title ?? '').trim();
    if (current && current !== DEFAULT_SESSION_TITLE) return;

    const first = this.db
      .prepare(
        "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND rewind_at IS NULL ORDER BY rowid ASC LIMIT 1",
      )
      .get(sessionId) as { content: string } | undefined;
    if (!first) return;

    let userText = '';
    try {
      userText = String((JSON.parse(first.content) as { text?: string }).text ?? '');
    } catch {
      return;
    }

    const title = makeSessionTitle(userText);
    if (!title) return;

    // 不动 updated_at：改标题不是「有新活动」，否则侧栏会自己跳位
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
    this.emit({ type: 'session_title', sessionId, title });
  }

  /**
   * 手动压缩上下文。
   *
   * 空闲压缩发生在「轮之外」，此时没有活跃的 turn 订阅（轮结束后就被拆了），
   * 所以这里临时挂一份订阅，只为收那条 compact_boundary；收到就拆。
   * 边界也可能比 compactSession 的返回值晚到，所以不能用 finally 立即拆 ——
   * 那样会漏掉事件，UI 就不会出现分隔线。
   */
  async compact(sessionId: string): Promise<CompactResult> {
    const session0 = await this.getSession(sessionId);
    if (this.activeTurns.get(sessionId)) throw new Error('这一轮还在跑，等它结束再压缩');

    const session = session0;
    let boundarySeen = false;
    let unsub: () => void = () => {};
    const stop = () => {
      unsub();
    };

    unsub = session.onEvent((event: AgentEvent) => {
      if (event.type !== 'compact_boundary') return;
      boundarySeen = true;
      const d = (event.data ?? {}) as Record<string, unknown>;
      this.recorder.recordCompactBoundary(sessionId, null, d, event);
      stop();
    });

    try {
      const result = await session.compactSession();
      // 良性空操作：上下文太小 / 没东西可压
      if (result.noop) {
        stop();
        return { noop: true };
      }
      return {
        noop: false,
        preTokens: result.tokensBefore,
        postTokens: result.estimatedTokensAfter,
      };
    } finally {
      // 给迟到的事件留一点时间窗口，随后无条件收尾
      if (!boundarySeen) setTimeout(stop, 3000);
    }
  }

  /**
   * 仅供验收：伪造一条压缩边界，走与真实事件完全相同的落库 + 广播路径。
   * 存在的理由：pi 的手动压缩有内置下限，小会话永远 noop。
   */
  injectCompactBoundary(
    sessionId: string,
    data: { trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null },
  ): void {
    this.recorder.recordCompactBoundary(sessionId, null, data);
    this.emit({ type: 'compact', turnId: null, ...data });
  }

  /**
   * 轮进行中插话。与 send 的区别：send 开新一轮，steer 把话塞进当前这轮，
   * 模型看到后调整方向而不重做。队列是「等它跑完」，steer 是「现在就改」。
   */
  async steer(sessionId: string, text: string): Promise<void> {
    const session0 = await this.getSession(sessionId);
    const session = session0;

    // 先把「不能插话」的情况翻译成人话，否则渲染层只能看到 SESSION_RUNNING 这类黑话
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) {
      throw new Error('当前没有正在进行的轮，直接发送即可');
    }

    try {
      await session.steer(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 引擎可能在这句话投递前就把轮跑完了 —— 这不是错误，只是话没地方塞
      if (message.includes('no active turn')) {
        throw new Error('这一轮刚好结束了，请重新发送');
      }
      throw error;
    }

    // 插话也要进对话历史，否则用户看到自己说的话凭空消失
    this.recorder.appendSteer(sessionId, turnId, text);
    this.emit({ type: 'steer', turnId, text });
  }

  /**
   * 当前上下文占用。
   *
   * 失败时返回 null 而不是抛错：占用条是辅助信息，拿不到就不画，
   * 不该因为一个进度条把整个界面搞出错误提示。
   */
  /**
   * 切权限档位。
   *
   * 轮进行中允许切 —— 引擎是即时生效的（setPermissionModeMidSession）。
   * 用户跑到一半发现「这个应该全放行」很正常，没必要逼他先停下来。
   */
  async setPermissionMode(sessionId: string, mode: PermissionModeChoice): Promise<void> {
    const session0 = await this.getSession(sessionId);
    await session0.setPermissionMode(mode);
    // 引擎只在内存里记，从不落库 —— 重启后档位会悄悄变回建会话时的默认值。
    // 对 worker 尤其致命：明明是 bypassPermissions，重启后变成 ask，
    // 后台跑的任务全卡在等确认上，用户看不出原因。
    this.db
      .prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?')
      .run(mode, sessionId);
    this.modes.permissionMode = mode;
    this.emitModes();
  }

  /** 可选模型清单 + 当前模型 */
  /** 可选模型清单 + 当前模型 */
  currentModel(): string {
    return this.cfg.model;
  }

  listModels(): { models: Array<{ id: string; label: string }>; current: string } {
    return {
      models: this.catalog.entries.map((m) => ({ id: m.id, label: m.label })),
      current: this.cfg.model,
    };
  }

  /**
   * 切换模型。
   *
   * 先问引擎「会怎么切」：
   *   hot / refresh → 直接切，历史保留
   *   rebuild       → 需要重建会话，**可能丢掉当前上下文**，必须让用户知道
   *   unavailable   → 这个模型当下切不了，直接报错比默默无视强
   *
   * preview 本身也可能抛（引擎未就绪），那时仍然尝试切 ——
   * 因为 preview 只是预检，不是前置条件。
   */
  async switchModel(sessionId: string, modelId: string): Promise<{ rebuilt: boolean }> {
    const session0 = await this.getSession(sessionId);
    const session = session0;

    if (!this.catalog.entries.some((m) => m.id === modelId)) {
      throw new Error(`未知模型：${modelId}`);
    }

    let action: string | null = null;
    let reason: string | undefined;
    try {
      const preview = await session.previewModelSwitch(modelId);
      action = preview?.action ?? null;
      reason = preview?.reason;
    } catch {
      // 预检失败不影响切换本身，忽略
    }

    if (action === 'unavailable') {
      throw new Error(reason ?? '当前环境切换不了这个模型');
    }

    await session.setModel(modelId);
    this.cfg.model = modelId;
    // 换模型后档位集合与上下文都不一样，必须重算
    this.refreshEffort();
    this.emitModes();
    this.emit({ type: 'model', modelId });

    return { rebuilt: action === 'rebuild' };
  }

  /**
   * 导出会话为 HTML。
   *
   * 指定路径而不是交给 pi 自选：它自选的默认位置用户根本找不到，
   * 导完还得去翻日志。落到用户的「文档」目录里最直观。
   */
  async exportHtml(sessionId: string): Promise<string> {
    const session0 = await this.getSession(sessionId);

    const row = this.db
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .get(sessionId) as { title?: string } | undefined;
    const title = sanitizeFileName(row?.title ?? '会话');
    const stamp = new Date()
      .toISOString()
      .replace(/[:T]/g, '-')
      .replace(/\..+$/, '');

    // 导出目录不存在时自己建：用户可能从没打开过「文档」
    const dir = this.cfg.exportDir;
    await fs.mkdir(dir, { recursive: true });
    const outputPath = path.join(dir, `${title}-${stamp}.html`);

    return await session0.exportSessionHtml(outputPath);
  }

  /**
   * 子任务进度。
   *
   * 引擎会高频推同一条任务（每几百毫秒一次 progress），每次都广播会把 IPC 刷爆，
   * 而 UI 实际上只关心「有哪些任务、各自什么状态」。所以这里只在
   * 「任务集合或状态真的变了」时广播。
   */
  private trackTask(data: Record<string, unknown>): void {
    const taskId = typeof data.taskId === 'string' ? data.taskId : '';
    if (!taskId) return;
    const status = typeof data.status === 'string' ? data.status : 'running';
    const title = typeof data.title === 'string' && data.title ? data.title : taskId;
    const description = typeof data.description === 'string' ? data.description : undefined;

    const before = this.taskMap.get(taskId);
    // 已完成/失败的任务留在表里（用户想看结果），不删
    this.taskMap.set(taskId, { taskId, title, status, description });

    const changed = !before || before.status !== status || before.title !== title;
    if (!changed) return;

    this.emit({ type: 'tasks', tasks: [...this.taskMap.values()] });
  }

  /** 后台任务快照（面板初次打开用） */
  async listTasks(sessionId: string): Promise<TaskInfo[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [...this.taskMap.values()];
    // 引擎侧列表只含「未结束」的 subagent；已结束的留在我们自己记的表里
    for (const running of session.listBackgroundTasks()) {
      const existing = this.taskMap.get(running.taskId);
      if (!existing) {
        this.taskMap.set(running.taskId, {
          taskId: running.taskId,
          title: running.title ?? running.taskId,
          status: 'running',
        });
      }
    }
    return [...this.taskMap.values()];
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const session0 = await this.getSession(sessionId);
    await session0.stopBackgroundTask(taskId);
  }

  /**
   * 读会话分支树。
   *
   * 只保留消息类节点：model_change / thinking_level_change 这些系统节点
   * 对用户没有意义，摆出来只会让树看起来像调试面板。
   */
  async sessionTree(sessionId: string): Promise<TreeEntry[]> {
    const session0 = await this.getSession(sessionId);
    const snapshot = await session0.getSessionTree();
    const active = new Set(snapshot.activePathIds);

    /**
     * 给 user 节点编轮次号。
     *
     * 不能按遍历顺序编：pi 的 roots 是新到旧的，遍历出来是倒序（踩过）。
     * 按 timestamp 排序才是时间序。没有 timestamp 的节点排到末尾，
     * 宁可它拿不到快照，也不要错位到别的轮上。
     */
    const userTimestamps: Array<{ id: string; ts: number }> = [];
    const collect = (node: Record<string, unknown>): void => {
      if (node.kind === 'message' && node.role === 'user') {
        const ts = Date.parse(String(node.timestamp ?? '')) || 0;
        userTimestamps.push({ id: String(node.id ?? ''), ts });
      }
      for (const child of (node.children as Array<Record<string, unknown>>) ?? []) collect(child);
    };
    for (const root of snapshot.roots as unknown as Array<Record<string, unknown>>) collect(root);
    userTimestamps.sort((a, b) => a.ts - b.ts);
    const turnIndexOf = new Map<string, number>();
    userTimestamps.forEach((entry, index) => turnIndexOf.set(entry.id, index));

    const convert = (node: Record<string, unknown>, isRoot: boolean): TreeEntry | null => {
      const kind = typeof node.kind === 'string' ? node.kind : 'unknown';
      const children = ((node.children as Array<Record<string, unknown>>) ?? [])
        .map((child) => convert(child, false))
        .filter((c): c is TreeEntry => c !== null);

      const role = typeof node.role === 'string' ? node.role : undefined;
      // 只留「用户说过的话」和「模型的回答」。
      // system / summary 这类节点对用户没有意义，摆上去只会让人以为是 bug。
      const keep = kind === 'message' && (role === 'user' || role === 'assistant');
      if (!keep && children.length === 0) return null;

      // 非消息节点但有孩子：把子节点提升上来，不让它在树上占位
      if (!keep) {
        if (children.length === 1) return children[0]!;
        // 多个子节点又不可见：造一个合成节点包住它们
        return {
          id: String(node.id ?? ''),
          kind,
          preview: '',
          active: false,
          children,
        };
      }

      const nodeId = String(node.id ?? '');
      return {
        id: nodeId,
        kind,
        role,
        preview: typeof node.preview === 'string' ? node.preview : '',
        active: active.has(nodeId),
        ...(role === 'user' && turnIndexOf.has(nodeId)
          ? { turnIndex: turnIndexOf.get(nodeId)! }
          : {}),
        children,
      };
    };

    const roots: TreeEntry[] = [];
    for (const root of snapshot.roots as unknown as Array<Record<string, unknown>>) {
      const converted = convert(root, true);
      if (converted) roots.push(converted);
    }
    return roots;
  }

  /**
   * 回到某个节点重来。
   *
   * 语义是「回到改写前重问」而不是「切换分支」：
   * 引擎会把选中 user 消息的原文放回编辑器，用户改完再发就长出新枝。
   * 所以这里把 draftText 一并带回去 —— 不返回的话用户得自己回忆刚才问的什么。
   */
  /**
   * 回到某个节点重来（含文件回滚）。
   *
   * 顺序很重要：**先恢复文件，再切对话**。
   * 反过来的话，切完对话失败会留下「对话退了、文件没退」 —— 最坏的情况。
   * 而且恢复失败时直接中止，不切对话，两者保持一致。
   */
  async navigateTree(
    sessionId: string,
    entryId: string,
    turnIndex?: number,
  ): Promise<NavigateResult> {
    const session0 = await this.getSession(sessionId);

    // 找到那一轮开始前的快照并恢复。
    // 没有快照（非 git 目录 / 老会话）就只回退对话，并如实告知。
    let filesRestored = false;
    let filesRestoreReason: string | undefined;
    if (typeof turnIndex === 'number') {
      const commit = this.savepointByTurnIndex(sessionId, turnIndex);
      if (!commit) {
        filesRestoreReason = '这轮没有文件快照（工作目录不是 git 仓库，或会话太早）';
      } else {
        const restored = await restoreSavepoint(this.cfg.workDir, commit);
        filesRestored = restored.ok;
        if (!restored.ok) {
          filesRestoreReason = restored.reason;
          // 回滚失败就不切对话：宁可什么都不变，也不要留下半套状态
          throw new Error(`文件回滚失败，已保持原状：${restored.reason ?? '未知原因'}`);
        }
      }
    } else {
      filesRestoreReason = '没有指定轮次，只回退对话';
    }

    const result = await session0.navigateSessionTree(entryId, { summarize: false });
    if (result.cancelled) throw new Error('切换被取消');

    // 回到旧节点后，当前轮的状态作废（活在被丢掉的支上）
    this.activeTurns.delete(sessionId);

    // 引擎给的时间线才是当前分支的真实内容。
    // 数据库里还存着被丢弃那一支的消息 —— 它是历史存档，不该再显示。
    const messages: UiMessage[] = [];
    for (const row of result.messages) {
      const mapped = historyToUiMessage(row);
      if (mapped) messages.push(mapped);
    }

    return {
      draftText: result.draftText,
      activeCount: result.tree.activePathIds.length,
      messages,
      filesRestored,
      ...(filesRestoreReason ? { filesRestoreReason } : {}),
    };
  }

  /** 第 N 轮（从 0 起）对应的文件快照 */
  private savepointByTurnIndex(sessionId: string, turnIndex: number): string | null {
    const row = this.db
      .prepare(
        'SELECT savepoint_commit FROM turns WHERE session_id = ? ORDER BY rowid ASC LIMIT 1 OFFSET ?',
      )
      .get(sessionId, turnIndex) as { savepoint_commit?: string | null } | undefined;
    return row?.savepoint_commit ?? null;
  }

  /**
   * 状态行。
   *
   * 目的：让用户知道「它在跑什么、跑了多久」，而不是只看到一个转圈。
   * 引擎给的 status 文本是英文（Working… / Compacting context…），
   * 这里翻成人话；翻不了就原样透传，总比不显示强。
   */
  private projectStatus(event: AgentEvent, sessionId: string, turnId: string): void {
    // 只要收到任何事件就算「活着」，含思考/工具/状态本身
    this.lastEventAt.set(turnId, Date.now());

    const d = (event.data ?? {}) as { status?: string; isRunning?: boolean };
    if (d.isRunning === false) {
      this.emit({ type: 'status', sessionId, status: null });
      return;
    }

    // 本轮开始时间：优先用引擎给的第一条 running 记录，没有就现拿
    const turn = this.turns.get(turnId);
    const startedAt = turn?.startedAt ?? Date.now();
    const label = humanizeStatus(d.status, this.lastToolName(turnId));
    const idleMs = Date.now() - (this.lastEventAt.get(turnId) ?? startedAt);
    // 有工具在执行时不算卡住：长命令本来就没有中间事件
    const toolRunning = this.runningTools.get(turnId);

    this.emit({
      type: 'status',
      sessionId,
      status: {
        label,
        startedAt,
        tokens: this.lastUsageTokens.get(turnId) ?? null,
        idleMs,
        // 工具在跑时把阈值拉到无限，等同于「别报卡住」
        // 超过阈値没任何事件就提醒；真正的中止由引擎（15 分钟）做。
        // 测试用 APP_STALL_HINT_SEC 调短，否则验一次要等 3 分钟。
        stallAfterMs: toolRunning
          ? Number.POSITIVE_INFINITY
          : Number(process.env.APP_STALL_HINT_SEC ?? 180) * 1000,
      },
    });
  }

  /** 最近一次工具名，用来把「Working…」说得更具体 */
  private lastToolName(turnId: string): string | null {
    return this.toolByTurn.get(turnId) ?? null;
  }

  async setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
    const session0 = await this.getSession(sessionId);
    await session0.setPlanMode(enabled);
    this.modes.planMode = enabled;
    this.emitModes();
  }

  /**
   * 切思考档位。
   *
   * 只接受能力里声明过的档位：不同模型的档位集合不一样，
   * 不校验的话传个不存在的值进去，pi 那边会报一个很难懂的错误。
   */
  async setEffort(sessionId: string, effort: string): Promise<void> {
    const session0 = await this.getSession(sessionId);
    if (!this.modes.effortLevels.includes(effort)) {
      throw new Error(`当前模型不支持「${effort}」档`);
    }
    await session0.setEffort(effort as never);
    // 以引擎回读为准：失败时抛错，这里拿到的就是真生效后的值
    this.modes.effort = session0.getEffort();
    this.emitModes();
  }

  /** 模式变化统一从这里广播，避免三个调用点各拼一遍字段 */
  private emitModes(): void {
    this.emit({
      type: 'modes',
      permissionMode: this.modes.permissionMode,
      planMode: this.modes.planMode,
      effort: this.modes.effort,
      effortLevels: this.modes.effortLevels,
    });
  }

  /**
   * 读当前模式。
   *
   * 以引擎为准：plan 模式可能被 agent 自己退出（plan_mode_changed 事件），
   * 只靠我们自己的变量会跟现实脱节。
   * 但 getPlanMode() 可能返回 null（未知），那时退回到我们记的值。
   */  async readModes(sessionId: string): Promise<ModeState> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ...this.modes };
    }
    try {
      const plan = session.getPlanMode();
      if (typeof plan === 'boolean') this.modes.planMode = plan;
    } catch {
      // 拿不到就用记着的值
    }
    this.refreshEffort();
    return { ...this.modes };
  }

  /**
   * 从引擎能力里读当前模型的档位集合与当前值。
   *
   * 档位不写死：不同模型能给的不一样（有的一次给六档，有的一档没有）。
   * 写死就会出现「UI 有这个选项，点了引擎报错」。
   */
  private refreshEffort(): void {
    const session = this.sessions.get(this.activeTurnSessionId ?? "");
    if (!session) return;
    try {
      // capabilities 不在公开类型上，但它是运行时就能拿到的真值
      const caps = (
        session as unknown as {
          capabilities?: {
            effort?: { supported?: boolean };
            effortLevels?: Array<{ id?: string }>;
          };
        }
      ).capabilities;
      if (caps?.effort?.supported !== true) {
        this.modes.effortLevels = [];
        this.modes.effort = null;
        return;
      }
      const levels = (caps.effortLevels ?? [])
        .map((l) => l.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      // 能力声明可能会大于实际能切的：pi 在模型目录未声明 effort 时
      // 只放行 low（当占位值），其余都会报错。宿主传了哪些就是真正可用的哪些。
      const configured = new Set<string>(this.cfg.efforts as readonly string[]);
      const usable = configured.size === 0 ? [] : levels.filter((id) => configured.has(id));
      this.modes.effortLevels = usable;
      this.modes.effort = usable.length > 0 ? session.getEffort() : null;
    } catch {
      // 拿不到就当不支持，UI 不画那个控件
      this.modes.effortLevels = [];
      this.modes.effort = null;
    }
  }

  async contextUsage(sessionId: string): Promise<ContextUsage | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    try {
      const usage = await session.getContextUsage();
      return {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: Math.max(0, Math.min(100, usage.percentage)),
      };
    } catch (error) {
      logger.debug('contextUsage unavailable', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 中断某个会话正在跑的那一轮。
   *
   * 接收 sessionId 而不是找「当前会话」——
   * 多会话并行下，「当前」是个 UI 概念，后台会话也要能单独取消。
   */
  async cancel(sessionId: string): Promise<void> {
    const turnId = this.activeTurns.get(sessionId);
    if (!turnId) return;
    const session = this.sessions.get(sessionId);
    await session?.abort().catch(() => undefined);
    this.recorder.finish(turnId, 'cancelled');
    this.emit({ type: 'turn', sessionId, turnId, state: 'cancelled' });
    this.activeTurns.delete(sessionId);
    this.turnUnsubs.get(turnId)?.();
    this.turnUnsubs.delete(turnId);
  }

  messageRows(sessionId: string) {
    return this.messages.list(sessionId);
  }

  /* ---------------- ORCA 协作 ---------------- */

  /**
   * 建一个 worker：一个独立的会话 + 一条 orca_workers 记录。
   *
   * 为什么 worker 是独立会话而不是子 agent：
   *   子 agent 是「一轮里临时派出去的活」，跑完就没了；
   *   worker 要能持续接活、能被用户点进去直接对话、能跨轮存在。
   *
   * 硬上限 8 来自实测（8 个并发 2.2GB、延迟 +28%）。
   * 超了直接报错而不是静默降级 —— 用户得知道为什么建不出来。
   */
  async createWorker(leadSessionId: string, config: OrcaWorkerConfig): Promise<OrcaWorkerRecord> {
    const team = this.orca.createOrGetTeamForLead(leadSessionId);

    const total = this.orca.countWorkers(team.id);
    if (total >= ORCA_WORKER_HARD_LIMIT) {
      throw new Error(
        `worker 数量已达上限 ${ORCA_WORKER_HARD_LIMIT} 个（受内存限制），请先结束一些`,
      );
    }

    // 继承 lead 的工作目录与模型，除非显式指定
    const leadMeta = await this.storage.get(leadSessionId);
    if (!leadMeta) throw new Error(`lead 会话不存在: ${leadSessionId}`);

    const role = config.role || 'developer';
    const label = config.label ?? null;

    /* ---- 工作区隔离 ----
     * 多个 worker 改同一个文件会静默覆盖（A 读 → B 写 → A 写，B 的改动没了）。
     * 每个 worker 一个 git worktree，物理隔离。
     *
     * config.isolate === false 时跳过（用户明确要共享目录，比如只是想
     * 让 worker 看看同一个仓库又不想建 worktree）。
     * 非 git 仓库会自动降级，此时 isolated=false，UI 据此提示风险。
     */
    const baseDir = config.workingDir ?? leadMeta.workDir;
    let workingDir = baseDir;
    let isolationInfo: { isolated: boolean; reason?: string } = { isolated: false };
    if (config.isolate !== false) {
      const prepared = await prepareWorkerWorktree(baseDir, label ?? role);
      workingDir = prepared.workingDir;
      isolationInfo = { isolated: prepared.isolated, reason: prepared.reason };
      if (!prepared.isolated) {
        console.warn(`[orca] worker 工作区未隔离: ${prepared.reason}`);
      }
    }

    const sessionId = await this.createSession(
      orcaWorkerSessionTitle(role, label),
      config.model ?? leadMeta.model,
      workingDir,
    );

    /* ---- 默认全放行 ----
     * worker 的价值是「不用一直盯着」，每步弹确认就失去意义。
     *
     * 敢默认 bypassPermissions 的前提是上面做了 worktree 隔离：
     * 改坏也只坏自己那份，主目录不受影响。
     * 未隔离时降回 auto —— 没有隔离还全放行，风险是叠加的。
     */
    const permissionMode: PermissionModeChoice = config.permissionMode
      ?? (isolationInfo.isolated ? 'bypassPermissions' : 'auto');
    try {
      const session = await this.getSession(sessionId);
      await session.setPermissionMode(permissionMode);
    } catch (error) {
      console.warn('[orca] 设置 worker 权限档位失败:', String(error));
    }

    return this.orca.addWorker({
      teamId: team.id,
      sessionId,
      role,
      label,
      workingDir,
      isolated: isolationInfo.isolated,
      isolationReason: isolationInfo.reason ?? null,
    });
  }

  listWorkers(leadSessionId: string): OrcaWorkerRecord[] {
    return this.orca.listWorkersByLead(leadSessionId);
  }

  /**
   * 切换 worker 的工作区隔离 —— 用户随时可以改。
   *
   * 两种情况：
   *   - 从共享 → 隔离：新建 worktree，会话的工作目录切过去
   *   - 从隔离 → 共享：删掉 worktree 的记录，目录切回 Lead 的
   *
   * 注意：**不搬文件**。切过去之后 worker 看到的是新目录的内容，
   * 之前那份的改动留在原来位置不动 —— 搬文件会把两边的改动混在一起，
   * 那才是真正会丢数据的地方。
   */
  async setWorkerIsolation(workerId: string, isolated: boolean): Promise<OrcaWorkerRecord> {
    const worker = this.orca.getWorker(workerId);
    if (!worker) throw new Error(`worker 不存在: ${workerId}`);

    const team = this.orca.getWorkerBySession(worker.sessionId);
    if (!team) throw new Error('worker 缺少 team');

    // Lead 的目录就是「共享目录」的定义
    const leadRow = this.db
      .prepare(
        `SELECT t.lead_session_id AS leadId FROM orca_teams t WHERE t.id = ?`,
      )
      .get(team.teamId) as { leadId: string } | undefined;
    const leadMeta = leadRow ? await this.storage.get(leadRow.leadId) : null;
    if (!leadMeta) throw new Error('找不到 Lead 会话');

    const label = worker.label ?? worker.role;
    const prepared = isolated
      ? await prepareWorkerWorktree(leadMeta.workDir, label)
      : { workingDir: leadMeta.workDir, isolated: false, reason: 'user-shared' as string | undefined };

    this.db
      .prepare(
        `UPDATE orca_workers
            SET working_dir = ?, isolated = ?, isolation_reason = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        prepared.workingDir,
        prepared.isolated ? 1 : 0,
        prepared.reason ?? null,
        Date.now(),
        workerId,
      );

    // 会话自己的 working_dir 也要跟着改，否则引擎还在旧目录里跑
    this.db
      .prepare('UPDATE sessions SET working_dir = ? WHERE id = ?')
      .run(prepared.workingDir, worker.sessionId);

    // 引擎侧的 session 是长驻对象，得重新应用目录才真的生效
    try {
      const session = await this.getSession(worker.sessionId);
      await session.setWritableDirs([prepared.workingDir]);
      await session.setExtraDirs([prepared.workingDir]);
    } catch (error) {
      console.warn('[orca] 切换隔离后重应用目录失败:', String(error));
    }

    const updated = this.orca.getWorker(workerId);
    if (!updated) throw new Error('切换后读不到 worker');
    return updated;
  }

  /** worker 用的工作目录（UI 显示「在哪干活」） */
  workerWorkingDir(workerId: string): string | null {
    const row = this.db
      .prepare('SELECT working_dir FROM orca_workers WHERE id = ?')
      .get(workerId) as { working_dir: string | null } | undefined;
    return row?.working_dir ?? null;
  }

  /** 验收用：读会话的 workingDir / model，测试要据此准备 git 仓库 */
  async debugSessionMeta(sessionId: string): Promise<{ workDir: string; model: string }> {
    const meta = await this.storage.get(sessionId);
    if (!meta) throw new Error(`会话不存在: ${sessionId}`);
    return { workDir: meta.workDir, model: meta.model };
  }

  /** 验收用：读会话当前的权限档位（引擎侧生效值，不是数据库缓存） */
  debugPermissionMode(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        return (session as unknown as { permissionModeState: { mode: string } }).permissionModeState.mode;
      } catch {
        /* 引擎没暴露就用库里的值兜底 */
      }
    }
    const row = this.db
      .prepare('SELECT permission_mode FROM sessions WHERE id = ?')
      .get(sessionId) as { permission_mode?: string } | undefined;
    return row?.permission_mode ?? 'unknown';
  }

  /**
   * 验收用：**只看数据库**里的权限档位。
   *
   * 单独开一个方法而不是给上面加参数，因为两者的断言意义不同：
   *   上面的：引擎当前真的用什么档位
   *   这个：重启后会用回什么档位（= 库里存的值）
   * 只查引擎会漏掉「不落库」这类 bug。
   */
  debugPermissionModeFromDb(sessionId: string): string {
    const row = this.db
      .prepare('SELECT permission_mode FROM sessions WHERE id = ?')
      .get(sessionId) as { permission_mode?: string } | undefined;
    return row?.permission_mode ?? 'unknown';
  }

  /** 验收用：拿 lead 的 active team id（验证幂等） */
  debugOrcaTeam(leadSessionId: string): string | null {
    return this.orca.getActiveTeamByLead(leadSessionId)?.id ?? null;
  }

  /** 某个会话是 lead 还是 worker（侧栏分组用） */
  orcaRoleOf(sessionId: string): 'lead' | 'worker' | null {
    if (this.orca.getWorkerBySession(sessionId)) return 'worker';
    const row = this.db
      .prepare('SELECT orca_role FROM sessions WHERE id = ?')
      .get(sessionId) as { orca_role?: string | null } | undefined;
    return row?.orca_role === 'lead' ? 'lead' : null;
  }

  /** 会话标题；找不到返回 null（通知里用作标题） */
  sessionTitle(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .get(sessionId) as { title?: string } | undefined;
    return row?.title?.trim() || null;
  }

  async listSessions() {
    // 注意：status 不在 SessionMeta 里 —— 上游刻意把运行态从 SessionMeta 剔除了
    // （见 maker-core/interfaces/session-storage.ts 末尾的注释）。
    // 持久态 status 归产品层，所以这里直接读我们自己的 sessions 表。
    //
    // 排序：置顶的永远在前（按置顶时间新→旧），其余按最近活动。
    // 不能只按 updated_at —— 置顶就是为了让它不被新会话挤下去。
    const rows = this.db
      .prepare(
        `SELECT id, title, model, status, updated_at, pinned_at
           FROM sessions
          WHERE archived_at IS NULL
          ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC`,
      )
      .all() as Array<{
      id: string;
      title: string;
      model: string;
      status: string;
      updated_at: number;
      pinned_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title || '未命名',
      model: r.model,
      status: r.status,
      updatedAt: r.updated_at,
      pinned: r.pinned_at !== null,
    }));
  }

  /** 重命名。空标题不改 —— 避免误操作把名字清成空白 */
  renameSession(sessionId: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('标题不能为空');
    if (trimmed.length > 120) throw new Error('标题太长（上限 120 字）');
    // 不动 updated_at：改名不是「有新活动」，否则侧栏会自己跳位
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(trimmed, sessionId);
  }

  /** 置顶 / 取消置顶 */
  setSessionPinned(sessionId: string, pinned: boolean): void {
    this.db
      .prepare('UPDATE sessions SET pinned_at = ? WHERE id = ?')
      .run(pinned ? Date.now() : null, sessionId);
  }

  /**
   * 归档会话。
   *
   * 用归档而不是直接删除：删错了整个会话的对话就永久没了。
   * 归档还能找回，而且不再出现在侧栏。
   */
  archiveSession(sessionId: string): void {
    // 归档正在用的会话时先解绑，避免后续操作写到已归档会话上
    this.sessions.delete(sessionId);
    this.db
      .prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }

  /** 从归档恢复 */
  unarchiveSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET archived_at = NULL WHERE id = ?').run(sessionId);
  }

  /** 列出已归档的会话（供恢复用） */
  listArchivedSessions() {
    const rows = this.db
      .prepare(
        `SELECT id, title, model, status, updated_at, archived_at
           FROM sessions
          WHERE archived_at IS NOT NULL
          ORDER BY archived_at DESC`,
      )
      .all() as Array<{
      id: string;
      title: string;
      model: string;
      status: string;
      updated_at: number;
      archived_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title || '未命名',
      model: r.model,
      status: r.status,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
    }));
  }

  /**
   * 彻底删除会话（不可恢复）。
   *
   * messages / turns / usage_events 靠外键 CASCADE 一起删
   * （open.ts 里开了 foreign_keys，不开的话级联会静默失效）。
   * 破坏性操作，UI 层必须二次确认。
   */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  async shutdown(): Promise<void> {
    for (const unsubscribe of this.turnUnsubs.values()) unsubscribe();
    this.turnUnsubs.clear();
    await this.maker?.shutdown().catch(() => undefined);
    this.db?.close();
  }
}

/** 审批卡片只需要看到命令/路径这类摘要，不要把整包入参塞进 IPC */
/** 这些工具的「主语」是命令首词：记住 `git` 就能让所有 git 命令免责 */
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'sh', 'cmd', 'run', 'execute']);

/**
 * 从工具入参里提取一个可记住的「主语」。
 *
 * 只对 shell 类工具做，其他工具返回 null 表示「整个工具」级别的规则。
 * 有意不用路径做主语：按目录记很容易变成一条覆盖全盘的规则，
 * 用户以为只放行了一个目录，实际放行了一大片。
 */
function extractSubject(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input || !SHELL_TOOLS.has(toolName)) return null;
  const command = typeof input.command === 'string' ? input.command : null;
  if (!command) return null;
  const first = command
    .trim()
    .replace(/^["']/, '')
    .split(/[\s;&|]+/)[0];
  return first ? first.replace(/["']$/, '') : null;
}

function safeInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v.length > 800 ? `${v.slice(0, 800)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}
