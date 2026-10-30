/**
 * Phase 2 · 事件 → 落库 的胶水层
 *
 * 职责单一：把 maker-core 的 AgentEvent 流变成 messages / turns / usage_events 行。
 * 不做 UI，不做业务判断。
 *
 * 三条容易写错的规则（都按上游语义来）：
 * 1. 只落 `isFinal` 的 text / thinking —— 增量 delta 只给 UI 用，落库会写爆
 * 2. clientId 由 turnId + 序号拼成，保证重放/重连时幂等
 * 3. 终态事件必须收敛 turn，否则进程下次启动会把它当成被中断的轮
 */
import { randomUUID } from 'node:crypto';

import type { AgentEvent } from '@cindy/maker-core';

import { MessageStore } from './db/messageStore.js';
import { TurnStore } from './db/turnStore.js';
import type { Db } from './db/open.js';

export interface BeginTurnResult {
  turnId: string;
  userClientId: string;
  userMessageId: string;
}

interface AgentMetaCarrier {
  agentMeta?: Record<string, unknown>;
}

export class SessionRecorder {
  private seq = new Map<string, number>();
  /** 已写入完整输出的 toolUseId —— 之后的 tool_result 摘要事件就不再重复落库 */
  private fullResultSeen = new Set<string>();
  /** usage 去重：同一轮的同一份 usage 只写一次 */
  private usageSeen = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly messages: MessageStore,
    private readonly turns: TurnStore,
  ) {}

  /**
   * 用户按下发送：先落 user message，再开 turn。
   *
   * reuseClientId 用于「续跑时重发原文」：那一行早就落库了，
   * 传回原来的 client_id 就能击中 UNIQUE(session_id, client_id)，
   * INSERT OR IGNORE 直接跳过，不会在 conversation 里多出一条重复的用户气泡。
   * turn 仍然新建 —— 重跑确实是新的一轮尝试。
   */
  beginUserTurn(
    sessionId: string,
    agentKind: string,
    userText: string,
    reuseClientId?: string,
  ): BeginTurnResult {
    const userClientId = reuseClientId ?? randomUUID();
    const userMessageId = reuseClientId ?? randomUUID();

    const turnId = this.turns.begin(sessionId, userClientId);

    this.messages.append({
      id: userMessageId,
      clientId: userClientId,
      sessionId,
      turnId,
      role: 'user',
      content: { text: userText },
      agentKind: agentKind as never,
    });

    return { turnId, userClientId, userMessageId };
  }

  /** 消费一个 agent 事件，按需落库 */
  onEvent(sessionId: string, turnId: string, agentKind: string, event: AgentEvent): void {
    switch (event.type) {
      case 'text': {
        const data = event.data as { text?: string; isFinal?: boolean } | undefined;
        // 增量不落库
        if (!data?.text || data.isFinal !== true) return;
        this.appendBlock(sessionId, turnId, agentKind, 'assistant', { text: data.text }, event);
        // Pi 的 token 用量 / 成本挂在 text 事件的 agentMeta.usage 上
        this.recordUsageFromMeta(sessionId, turnId, event);
        return;
      }

      case 'thinking': {
        const data = event.data as { text?: string; isFinal?: boolean } | undefined;
        if (!data?.text || data.isFinal !== true) return;
        this.appendBlock(sessionId, turnId, agentKind, 'thinking', { text: data.text }, event);
        return;
      }

      case 'tool_use': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const toolUseId = (data.toolUseId ?? data.tool_use_id ?? null) as string | null;
        this.appendBlock(sessionId, turnId, agentKind, 'tool_use', data, event, toolUseId);
        return;
      }

      case 'tool_result_full': {
        // 真正带输出的那个事件。Pi 紧接着还会发一个只有 {summary,toolUseIds}
        // 的 tool_result，那是给 UI 做状态切换用的，不该覆盖完整输出。
        const data = (event.data ?? {}) as Record<string, unknown>;
        const toolUseId = (data.toolUseId ?? null) as string | null;
        if (toolUseId) this.fullResultSeen.add(toolUseId);
        this.appendBlock(sessionId, turnId, agentKind, 'tool_result', data, event, toolUseId);
        return;
      }

      case 'tool_result': {
        // 已经落过完整输出的，跳过摘要，避免同一结果占两行
        const data = (event.data ?? {}) as Record<string, unknown>;
        const ids = (data.toolUseIds ?? (data.toolUseId ? [data.toolUseId] : [])) as string[];
        if (ids.length > 0 && ids.every((id) => this.fullResultSeen.has(id))) return;
        this.appendBlock(
          sessionId,
          turnId,
          agentKind,
          'tool_result',
          data,
          event,
          ids[0] ?? null,
        );
        return;
      }

      case 'error': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        this.appendBlock(sessionId, turnId, agentKind, 'error', data, event);
        // 只有终结性 error 才收口 turn；可重试的中间错误（如 Reconnecting 1/6）不算
        if (data.isTerminal === true) {
          this.turns.finish(turnId, 'error', {
            error: String(data.message ?? 'unknown error'),
            errorTerminal: true,
          });
        }
        return;
      }

      case 'done': {
        this.turns.finish(turnId, 'done');
        return;
      }

      case 'account_usage': {
        this.recordUsage(sessionId, turnId, event);
        return;
      }

      case 'compact_boundary': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        this.recordCompactBoundary(sessionId, turnId, data, event);
        return;
      }

      default:
        return;
    }
  }

  /**
   * 压缩边界落库。
   *
   * 为什么非要存一行：压缩后模型看到的上下文已经变了，但对话历史没变。
   * 不标出来，用户下次进来看历史会以为「它怎么忘了我刚说的」是 bug。
   * 也不走 appendBlock —— 那个按 turnId 拼幂等键，而空闲手动压缩没有 turn
   * （turnId 为 null），会被拼成 `null:compact_boundary:1`，跟别的会话撞键。
   */
  recordCompactBoundary(
    sessionId: string,
    turnId: string | null,
    data: Record<string, unknown>,
    event?: AgentEvent,
  ): void {
    this.messages.append({
      id: randomUUID(),
      clientId: `compact:${randomUUID()}`,
      sessionId,
      turnId,
      role: 'compact_boundary',
      content: {
        trigger: data.trigger === 'manual' ? 'manual' : 'auto',
        preTokens: typeof data.preTokens === 'number' ? data.preTokens : null,
        postTokens: typeof data.postTokens === 'number' ? data.postTokens : null,
      },
      agentMeta: event ? ((event as AgentEvent & AgentMetaCarrier).agentMeta ?? null) : null,
      agentKind: 'pi',
    });
  }

  /**
   * 插话落库。
   *
   * 为什么单独一个 role：它属于当前正在跑的那一轮，不是新轮的开头。
   * 若当成普通 user 存，重放历史时会看起来像用户连发了两条、模型却只回一次。
   */
  appendSteer(sessionId: string, turnId: string, text: string): void {
    const seq = (this.seq.get(turnId) ?? 0) + 1;
    this.seq.set(turnId, seq);
    this.messages.append({
      id: randomUUID(),
      clientId: `${turnId}:user_steer:${seq}`,
      sessionId,
      turnId,
      role: 'user_steer',
      content: { text },
      agentKind: 'pi',
    });
  }

  /** 手动收口（超时 / 用户中断） */
  finish(turnId: string, state: 'done' | 'error' | 'cancelled' | 'interrupted', error?: string): void {
    this.turns.finish(turnId, state, { error });
  }

  private appendBlock(
    sessionId: string,
    turnId: string,
    agentKind: string,
    role: 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'error',
    content: unknown,
    event: AgentEvent,
    toolUseId: string | null = null,
  ): void {
    const seq = (this.seq.get(turnId) ?? 0) + 1;
    this.seq.set(turnId, seq);

    this.messages.append({
      id: randomUUID(),
      // turnId + 角色 + 序号：同一轮重放时天然幂等
      clientId: `${turnId}:${role}:${seq}`,
      sessionId,
      turnId,
      role,
      content,
      agentMeta: (event as AgentEvent & AgentMetaCarrier).agentMeta ?? null,
      agentKind: agentKind as never,
      toolUseId,
    });
  }

  private recordUsageFromMeta(sessionId: string, turnId: string, event: AgentEvent): void {
    const meta = (event as AgentEvent & AgentMetaCarrier).agentMeta as
      | { model?: string; usage?: Record<string, unknown> }
      | undefined;
    const usage = meta?.usage;
    if (!usage) return;

    const num = (key: string): number => {
      const value = usage[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };

    // Pi 的 usage 形状：{ input, output, cacheRead, cacheWrite, cost, totalTokens }
    this.insertUsage({
      sessionId,
      turnId,
      model: meta?.model ?? 'unknown',
      inputTokens: num('input'),
      outputTokens: num('output'),
      cacheReadTokens: num('cacheRead'),
      cacheWriteTokens: num('cacheWrite'),
      // Pi 直接给美元数（不是分）
      costAmount: num('cost'),
      costCurrency: num('cost') > 0 ? 'USD' : null,
    });
  }

  private recordUsage(sessionId: string, turnId: string, event: AgentEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const pick = (key: string): number => {
      const value = data[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    };

    this.insertUsage({
      sessionId,
      turnId,
      model: String(data.model ?? 'unknown'),
      inputTokens: pick('inputTokens'),
      outputTokens: pick('outputTokens'),
      cacheReadTokens: pick('cacheReadTokens'),
      cacheWriteTokens: pick('cacheWriteTokens'),
      costAmount: pick('costAmount'),
      costCurrency: (data.currency as string | undefined) ?? null,
    });
  }

  private insertUsage(row: {
    sessionId: string;
    turnId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costAmount: number;
    costCurrency: string | null;
  }): void {
    // 同一轮的同一份 usage 可能从 text(agentMeta) 和 account_usage 两边都到，去重
    const key = `${row.turnId}:${row.model}:${row.inputTokens}:${row.outputTokens}`;
    if (this.usageSeen.has(key)) return;
    this.usageSeen.add(key);

    // 全 0 的 usage 是「上游没报」，不写库，避免污染成本统计
    if (
      row.inputTokens === 0 &&
      row.outputTokens === 0 &&
      row.cacheReadTokens === 0 &&
      row.cacheWriteTokens === 0 &&
      row.costAmount === 0
    ) {
      return;
    }

    this.db
      .prepare(
        `INSERT INTO usage_events (
           session_id, turn_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cost_amount, cost_currency, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sessionId,
        row.turnId,
        row.model,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.costAmount,
        row.costCurrency,
        Date.now(),
      );

    // 同时把累计值刷到 sessions 上（读优化列，真源是 usage_events）
    this.db
      .prepare(
        `UPDATE sessions
            SET total_tokens      = total_tokens      + ?,
                total_cost_amount = total_cost_amount + ?
          WHERE id = ?`,
      )
      .run(
        row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
        row.costAmount,
        row.sessionId,
      );
  }
}
