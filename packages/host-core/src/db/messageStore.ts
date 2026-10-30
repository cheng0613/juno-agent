/**
 * Phase 2 · 消息存储
 *
 * 关键约束（与上游一致）：
 * - 写入靠 (session_id, client_id) 唯一索引做幂等，重复提交不产生第二行
 * - 删除是软删（rewind_at），读取一律过滤
 * - 历史消息按写入时的 agent_kind 解析，不看会话当前引擎
 */
import type { AgentKind } from '@cindy/maker-core';

import type { Db } from './open.js';

export type MessageRole =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'error'
  | 'agent_switch'
  | 'context_rebuild'
  /** 上下文压缩边界：不是对话内容，但必须留在时间线上，否则用户以为什么都没发生 */
  | 'compact_boundary'
  | 'message_tombstone';

export interface MessageInput {
  id: string;
  clientId: string;
  sessionId: string;
  turnId?: string | null;
  role: MessageRole;
  /** 任意可 JSON 化的内容 */
  content: unknown;
  agentMeta?: unknown;
  agentKind?: AgentKind | null;
  toolUseId?: string | null;
  createdAt?: number;
}

export interface StoredMessage {
  id: string;
  clientId: string;
  sessionId: string;
  turnId: string | null;
  role: MessageRole;
  content: unknown;
  agentMeta: unknown;
  agentKind: AgentKind | null;
  toolUseId: string | null;
  createdAt: number;
}

interface MessageRow {
  id: string;
  client_id: string;
  session_id: string;
  turn_id: string | null;
  role: string;
  content: string;
  agent_meta: string | null;
  agent_kind: string | null;
  tool_use_id: string | null;
  created_at: number;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 坏数据不应该让整次读取失败，退化成原文字符串
    return { _unparsed: raw };
  }
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    clientId: row.client_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role as MessageRole,
    content: parseJson(row.content),
    agentMeta: parseJson(row.agent_meta),
    agentKind: (row.agent_kind as AgentKind | null) ?? null,
    toolUseId: row.tool_use_id,
    createdAt: row.created_at,
  };
}

export class MessageStore {
  constructor(private readonly db: Db) {}

  /**
   * 幂等写入。返回 true 表示新插入，false 表示该 (session, clientId) 已存在被忽略。
   * 流式场景下同一条消息的多次 final 落库、断线重放都会走到这里。
   */
  append(input: MessageInput): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (
           id, client_id, session_id, turn_id, role, content,
           agent_meta, agent_kind, tool_use_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.clientId,
        input.sessionId,
        input.turnId ?? null,
        input.role,
        JSON.stringify(input.content ?? null),
        input.agentMeta === undefined ? null : JSON.stringify(input.agentMeta),
        input.agentKind ?? null,
        input.toolUseId ?? null,
        input.createdAt ?? Date.now(),
      );

    if (result.changes > 0) this.touchSession(input.sessionId);
    return result.changes > 0;
  }

  list(sessionId: string, opts: { includeRewound?: boolean } = {}): StoredMessage[] {
    const filter = opts.includeRewound ? '' : 'AND rewind_at IS NULL';
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? ${filter}
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Rewind：把某条消息（含）之后的所有消息软删。
   *
   * 用 createdAt 做边界，同一毫秒内用 rowid 兜底——只靠时间戳会在批量写入时截错位置。
   */
  rewindTo(sessionId: string, clientId: string): number {
    const anchor = this.db
      .prepare('SELECT created_at, rowid FROM messages WHERE session_id = ? AND client_id = ?')
      .get(sessionId, clientId) as { created_at: number; rowid: number } | undefined;
    if (!anchor) throw new Error(`rewind anchor not found: ${clientId}`);

    const result = this.db
      .prepare(
        `UPDATE messages SET rewind_at = ?
         WHERE session_id = ?
           AND rewind_at IS NULL
           AND (created_at > ? OR (created_at = ? AND rowid >= ?))`,
      )
      .run(Date.now(), sessionId, anchor.created_at, anchor.created_at, anchor.rowid);

    return result.changes;
  }

  /** 把某条消息从 wire 重放里彻底移除（墓碑），保留 id 阻止历史被重新导入 */
  tombstone(messageId: string): void {
    this.db
      .prepare(
        `UPDATE messages
         SET role = 'message_tombstone', content = 'null', agent_meta = NULL
         WHERE id = ?`,
      )
      .run(messageId);
  }

  count(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND rewind_at IS NULL')
      .get(sessionId) as { n: number };
    return row.n;
  }

  touchSession(sessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }
}
