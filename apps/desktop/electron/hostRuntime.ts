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
} from '../src/shared/ipc.js';

export interface HostConfig {
  upstreamRoot: string;
  /** 直接指定 pi 可执行文件；打包后指向 resources/pi-bin/pi.exe */
  binaryPath?: string;
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
  };
}

const logger = createConsoleLogger('host');

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

  constructor(private readonly cfg: HostConfig) {}

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
    return session.id;
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

      if (event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        settled = true;
        const state = event.type === 'error' ? 'error' : 'done';
        this.emit({ type: 'turn', turnId: turn.turnId, state });
        this.activeTurnId = null;
        unsubscribe();
        this.turnUnsubs.delete(turn.turnId);
      }
    });
    this.turnUnsubs.set(turn.turnId, unsubscribe);

    await session.send(text);
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
