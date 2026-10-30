/**
 * Phase 2 · SessionStorage 的 SQLite 实现
 *
 * 这是宿主契约里唯一「必须落盘」的注入点。6 个方法全部实现，
 * 行为与 maker-core 的语义严格对齐（尤其 compareAndClearSdkSessionId 的 CAS 语义）。
 */
import type {
  AgentKind,
  Effort,
  PermissionMode,
  SessionMeta,
  SessionStorage,
  WorkspaceKind,
} from '@cindy/maker-core';

import type { Db } from './open.js';

interface SessionRow {
  id: string;
  title: string;
  working_dir: string;
  workspace_kind: string;
  agent_kind: string;
  model: string;
  effort: string;
  permission_mode: string;
  fast_mode: string;
  plan_mode: number;
  review_mode: number;
  sdk_session_id: string | null;
  status: string;
  parent_session_id: string | null;
  created_at: number;
  updated_at: number;
}

/** 默认值集中在这里，避免 create 与 update 两处漂移 */
const DEFAULTS = {
  title: 'New Task',
  workspaceKind: 'project' as WorkspaceKind,
  effort: 'high' as Effort,
  permissionMode: 'ask' as PermissionMode,
  fastMode: false as boolean | 'ultrafast',
};

function encodeFastMode(value: boolean | 'ultrafast' | undefined): string {
  if (value === true) return 'fast';
  if (value === 'ultrafast') return 'ultrafast';
  return 'off';
}

function decodeFastMode(value: string): boolean | 'ultrafast' {
  if (value === 'ultrafast') return 'ultrafast';
  return value === 'fast';
}

function toMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    agentKind: row.agent_kind as AgentKind,
    workDir: row.working_dir,
    title: row.title,
    model: row.model,
    workspaceKind: row.workspace_kind as WorkspaceKind,
    effort: row.effort as Effort,
    permissionMode: row.permission_mode as PermissionMode,
    fastMode: decodeFastMode(row.fast_mode),
    planMode: row.plan_mode === 1,
    reviewMode: row.review_mode === 1 ? true : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sdkSessionId: row.sdk_session_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
  };
}

/** SessionMeta 字段 → 列名。update 时按 patch 里实际出现的键动态拼 SET。 */
const FIELD_TO_COLUMN: Record<string, string> = {
  agentKind: 'agent_kind',
  workDir: 'working_dir',
  title: 'title',
  model: 'model',
  workspaceKind: 'workspace_kind',
  effort: 'effort',
  permissionMode: 'permission_mode',
  fastMode: 'fast_mode',
  planMode: 'plan_mode',
  reviewMode: 'review_mode',
  sdkSessionId: 'sdk_session_id',
  parentSessionId: 'parent_session_id',
};

function encodeValue(field: string, value: unknown): unknown {
  if (field === 'fastMode') return encodeFastMode(value as boolean | 'ultrafast' | undefined);
  if (field === 'planMode') return value === true ? 1 : 0;
  if (field === 'reviewMode') return value === true ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export class SqliteSessionStorage implements SessionStorage {
  constructor(private readonly db: Db) {}

  async create(meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>): Promise<SessionMeta> {
    const now = Date.now();

    // 软删过的同 id 会话被重新创建时复活，而不是撞主键
    const existing = this.db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(meta.id) as { status: string } | undefined;
    if (existing) {
      if (existing.status !== 'deleted') {
        // 已存在且存活：按 maker-core 语义直接复用，不覆盖用户数据
        const row = this.requireRow(meta.id);
        return toMeta(row);
      }
      this.db.prepare("UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?").run(
        now,
        meta.id,
      );
      const row = this.requireRow(meta.id);
      return toMeta(row);
    }

    this.db
      .prepare(
        `INSERT INTO sessions (
           id, title, working_dir, workspace_kind, agent_kind, model, effort,
           permission_mode, fast_mode, plan_mode, review_mode, sdk_session_id,
           parent_session_id, status, last_activity_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        meta.id,
        meta.title || DEFAULTS.title,
        meta.workDir,
        meta.workspaceKind ?? DEFAULTS.workspaceKind,
        meta.agentKind,
        meta.model,
        meta.effort ?? DEFAULTS.effort,
        meta.permissionMode ?? DEFAULTS.permissionMode,
        encodeFastMode(meta.fastMode),
        meta.planMode === true ? 1 : 0,
        meta.reviewMode === true ? 1 : 0,
        meta.sdkSessionId ?? null,
        meta.parentSessionId ?? null,
        now,
        now,
        now,
      );

    return toMeta(this.requireRow(meta.id));
  }

  async get(id: string): Promise<SessionMeta | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    // 软删的行对调用方不可见
    if (!row || row.status === 'deleted') return null;
    return toMeta(row);
  }

  async list(): Promise<SessionMeta[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status != 'deleted'
         ORDER BY COALESCE(last_activity_at, created_at) DESC`,
      )
      .all() as SessionRow[];
    return rows.map(toMeta);
  }

  async update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [field, value] of Object.entries(patch)) {
      const column = FIELD_TO_COLUMN[field];
      if (!column) continue; // id / createdAt / updatedAt 不接受外部改
      sets.push(`${column} = ?`);
      values.push(encodeValue(field, value));
    }

    sets.push('updated_at = ?');
    values.push(Date.now(), id);

    const result = this.db
      .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
    if (result.changes === 0) throw new Error(`session not found: ${id}`);

    return toMeta(this.requireRow(id));
  }

  /**
   * CAS 语义：只有当前值仍等于 expected 时才清空。
   * maker-core 依赖这个语义避免「旧的失败覆盖并发写入的新值」。
   */
  async compareAndClearSdkSessionId(id: string, expected: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE sessions SET sdk_session_id = NULL, updated_at = ?
         WHERE id = ? AND sdk_session_id = ?`,
      )
      .run(Date.now(), id, expected);
    return result.changes > 0;
  }

  /** 软删：保留消息用于审计/恢复，只是对调用方不可见 */
  async delete(id: string): Promise<void> {
    this.db
      .prepare("UPDATE sessions SET status = 'deleted', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  private requireRow(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    if (!row) throw new Error(`session row missing after write: ${id}`);
    return row;
  }
}
