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
  PermissionStore,
  SessionRecorder,
  SqliteSessionStorage,
  TurnStore,
  assertPiBinaryExists,
  createPiAgent,
  openDatabase,
  resolvePiBinary,
  type Db,
} from '@spike/host-core';

import type {
  ApprovalRequest,
  CompactResult,
  ContextUsage,
  HostEvent,
  InterruptedTurn,
  ModeState,
  PermissionModeChoice,
  TaskInfo,
} from '../src/shared/ipc.js';

import {
  collectTurnDiff,
  createBaseline,
  type DiffBaseline,
} from './turnDiff.js';
import { parseModelCatalog } from './modelCatalog.js';

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
}

export function configFromEnv(): HostConfig {
  const dataDir =
    process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'spike-desktop');
  return {
    upstreamRoot:
      process.env.APP_UPSTREAM_ROOT ??
      'C:/Users/chiaki/Desktop/agent/upstream/cindy',
    binaryPath: process.env.APP_PI_BINARY,
    model: process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017',
    endpoint: process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1',
    api: (process.env.APP_API ?? 'openai-completions') as PiNativeApi,
    contextWindow: Number(process.env.APP_CONTEXT_WINDOW ?? 200_000),
    compactionPct: process.env.APP_COMPACT_PCT
      ? Number(process.env.APP_COMPACT_PCT)
      : undefined,
    efforts: (process.env.APP_EFFORTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as Effort[],
    dataDir,
    workDir: process.env.APP_WORKDIR ?? path.join(dataDir, 'workspace'),
    agentHome: process.env.APP_AGENT_HOME ?? path.join(dataDir, 'pi-agent-home'),
    approval: (process.env.APP_APPROVAL ?? 'ipc') as 'ipc' | 'allow',
    // 默认落到系统临时目录下的 exports；main 会用真正的「文档」目录覆盖
    exportDir: process.env.APP_EXPORT_DIR ?? path.join(dataDir, 'exports'),
  };
}

const logger = createConsoleLogger('host');

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
}

export class HostRuntime {
  private db!: Db;
  private storage!: SqliteSessionStorage;
  private messages!: MessageStore;
  private turns!: TurnStore;
  private permissions!: PermissionStore;
  private recorder!: SessionRecorder;
  private maker!: Maker;
  private session: Session | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private listeners = new Set<(event: HostEvent) => void>();
  private activeTurnId: string | null = null;
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

  async createSession(title = '新会话'): Promise<string> {
    const session = await this.maker.createSession({
      agentKind: 'pi',
      workingDir: this.cfg.workDir,
      model: this.cfg.model,
      title,
    });
    this.attach(session);
    return session.id;
  }

  async ensureSession(): Promise<string> {
    if (this.session) return this.session.id;
    const existing = await this.storage.list();
    if (existing.length > 0) {
      return await this.resume(existing[0]!.id);
    }
    return await this.createSession();
  }

  async resume(sessionId: string): Promise<string> {
    const meta = await this.storage.get(sessionId);
    if (!meta) throw new Error(`session not found: ${sessionId}`);
    const session = await this.maker.createSession({
      id: sessionId,
      agentKind: 'pi',
      workingDir: meta.workDir,
      model: meta.model,
      title: meta.title,
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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    const session = this.session!;

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
    this.session = session;
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
          remember === 'session' ? (this.session?.id ?? null) : null,
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

  async send(sessionId: string, text: string, opts?: { reuseClientId?: string }): Promise<void> {
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);

    const session = this.session!;
    const turn = this.recorder.beginUserTurn(sessionId, 'pi', text, opts?.reuseClientId);
    this.maybeTitleSession(sessionId);

    // 上一轮还没收口就来了新 send：旧订阅要先拆掉，否则它会继续吃新一轮的事件，
    // 把新事件写到旧 turnId 名下。同时如实把旧轮收成 interrupted，
    // 免得库里留一条永远 running 的行、下次启动误报「未完成」。
    if (this.activeTurnId) {
      const stale = this.activeTurnId;
      this.turnUnsubs.get(stale)?.();
      this.turnUnsubs.delete(stale);
      this.recorder.finish(stale, 'interrupted');
      this.emit({ type: 'turn', turnId: stale, state: 'interrupted' });
      logger.warn('send 被新消息顶掉，上一轮已标为 interrupted', { stale });
    }

    this.activeTurnId = turn.turnId;
    this.emit({ type: 'turn', turnId: turn.turnId, state: 'running' });

    // 同一轮可能收到多个终态事件（引擎的 done 与会话收口事件），
    // 收口只能通知一次 —— 渲染层依赖它去重拉历史、去推进队列
    let settled = false;
    const unsubscribe = session.onEvent((event: AgentEvent) => {
      // 订阅排在被顶掉之后仍可能收到残留事件；不是自己这轮的就不认
      if (settled) return;
      this.recorder.onEvent(sessionId, turn.turnId, 'pi', event);
      this.project(event, turn.turnId);
      this.traceEvent(event);

      if (event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        settled = true;
        const state = event.type === 'error' ? 'error' : 'done';
        this.emit({ type: 'turn', turnId: turn.turnId, state });
        this.activeTurnId = null;
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

    await session.send(text);
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
  private project(event: AgentEvent, turnId: string): void {
    switch (event.type) {
      case 'text': {
        const d = event.data as { text?: string; isFinal?: boolean };
        if (d?.text) this.emit({ type: 'text', turnId, text: d.text, isFinal: d.isFinal === true });
        return;
      }
      case 'thinking': {
        const d = event.data as { text?: string; isFinal?: boolean };
        if (d?.text) this.emit({ type: 'thinking', turnId, text: d.text, isFinal: d.isFinal === true });
        return;
      }
      case 'tool_use': {
        const d = event.data as Record<string, unknown>;
        this.emit({
          type: 'tool_use',
          turnId,
          toolUseId: String(d?.toolUseId ?? ''),
          toolName: String(d?.toolName ?? '?'),
          input: d?.input,
        });
        return;
      }
      case 'tool_result_full': {
        const d = event.data as Record<string, unknown>;
        this.emit({
          type: 'tool_result',
          turnId,
          toolUseId: String(d?.toolUseId ?? ''),
          output: String(d?.fullText ?? ''),
          isError: d?.isError === true,
        });
        return;
      }
      case 'error': {
        const d = event.data as Record<string, unknown>;
        this.emit({ type: 'error', message: String(d?.message ?? 'unknown error') });
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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    if (this.activeTurnId) throw new Error('这一轮还在跑，等它结束再压缩');

    const session = this.session!;
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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    const session = this.session!;

    // 先把「不能插话」的情况翻译成人话，否则渲染层只能看到 SESSION_RUNNING 这类黑话
    if (!this.activeTurnId) {
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
    this.recorder.appendSteer(sessionId, this.activeTurnId, text);
    this.emit({ type: 'steer', turnId: this.activeTurnId, text });
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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    await this.session!.setPermissionMode(mode);
    this.modes.permissionMode = mode;
    this.emitModes();
  }

  /** 可选模型清单 + 当前模型 */
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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    const session = this.session!;

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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);

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

    return await this.session!.exportSessionHtml(outputPath);
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
    if (!this.session || this.session.id !== sessionId) return [...this.taskMap.values()];
    // 引擎侧列表只含「未结束」的 subagent；已结束的留在我们自己记的表里
    for (const running of this.session.listBackgroundTasks()) {
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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    await this.session!.stopBackgroundTask(taskId);
  }

  async setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    await this.session!.setPlanMode(enabled);
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
    if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
    if (!this.modes.effortLevels.includes(effort)) {
      throw new Error(`当前模型不支持「${effort}」档`);
    }
    await this.session!.setEffort(effort as never);
    // 以引擎回读为准：失败时抛错，这里拿到的就是真生效后的值
    this.modes.effort = this.session!.getEffort();
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
    if (!this.session || this.session.id !== sessionId) {
      return { ...this.modes };
    }
    try {
      const plan = this.session.getPlanMode();
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
    if (!this.session) return;
    try {
      // capabilities 不在公开类型上，但它是运行时就能拿到的真值
      const caps = (
        this.session as unknown as {
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
      this.modes.effort = usable.length > 0 ? this.session.getEffort() : null;
    } catch {
      // 拿不到就当不支持，UI 不画那个控件
      this.modes.effortLevels = [];
      this.modes.effort = null;
    }
  }

  async contextUsage(sessionId: string): Promise<ContextUsage | null> {
    if (!this.session || this.session.id !== sessionId) return null;
    try {
      const usage = await this.session.getContextUsage();
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

  async cancel(): Promise<void> {
    if (!this.session || !this.activeTurnId) return;
    const turnId = this.activeTurnId;
    await this.session.abort().catch(() => undefined);
    this.recorder.finish(turnId, 'cancelled');
    this.emit({ type: 'turn', turnId, state: 'cancelled' });
    this.activeTurnId = null;
    this.turnUnsubs.get(turnId)?.();
    this.turnUnsubs.delete(turnId);
  }

  messageRows(sessionId: string) {
    return this.messages.list(sessionId);
  }

  async listSessions() {
    // 注意：status 不在 SessionMeta 里 —— 上游刻意把运行态从 SessionMeta 剔除了
    // （见 maker-core/interfaces/session-storage.ts 末尾的注释）。
    // 持久态 status 归产品层，所以这里直接读我们自己的 sessions 表。
    const rows = this.db
      .prepare('SELECT id, title, model, status, updated_at FROM sessions ORDER BY updated_at DESC')
      .all() as Array<{
      id: string;
      title: string;
      model: string;
      status: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title || '未命名',
      model: r.model,
      status: r.status,
      updatedAt: r.updated_at,
    }));
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
