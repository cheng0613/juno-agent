/**
 * Phase 2 · 轮次存储 —— 中断恢复的骨架
 *
 * 设计要点：
 * - 一次 send = 一个 turn row，开始时 state='running'
 * - 进程正常结束时收口成 done/error
 * - 进程被杀 → row 永远停在 running → 下次启动时这些行就是「可能被中断的轮」
 *
 * 这就是上游 `sessionActiveTurn` / `interruptedTurnAutoResume` 两套判据的数据基础：
 * 前者回答「启动时要不要提示用户」，后者回答「运行期要不要自动续跑」。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from './open.js';

export type TurnState = 'running' | 'done' | 'error' | 'interrupted' | 'cancelled';

export interface TurnRecord {
  id: string;
  sessionId: string;
  state: TurnState;
  attempt: number;
  userClientId: string | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  errorTerminal: boolean;
  /** 中断轮被用户处置（继续/忽略）的时间；null = 还没处置，启动时要提示 */
  resolvedAt: number | null;
}

interface TurnRow {
  id: string;
  session_id: string;
  state: string;
  attempt: number;
  user_client_id: string | null;
  started_at: number;
  ended_at: number | null;
  error: string | null;
  error_terminal: number;
  resolved_at: number | null;
}

function toTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    state: row.state as TurnState,
    attempt: row.attempt,
    userClientId: row.user_client_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error,
    errorTerminal: row.error_terminal === 1,
    resolvedAt: row.resolved_at ?? null,
  };
}

export class TurnStore {
  constructor(private readonly db: Db) {}

  /** 开一轮。attempt 自动 = 该会话历史轮数 + 1，便于统计重试次数 */
  begin(sessionId: string, userClientId: string | null): string {
    const id = randomUUID();
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
      .get(sessionId) as { n: number };

    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, state, attempt, user_client_id, started_at)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, sessionId, row.n + 1, userClientId, Date.now());

    return id;
  }

  /** 正常收口：done / error / cancelled */
  finish(
    turnId: string,
    state: Exclude<TurnState, 'running'>,
    detail: { error?: string; errorTerminal?: boolean } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE turns
         SET state = ?, ended_at = ?, error = ?, error_terminal = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(
        state,
        Date.now(),
        detail.error ?? null,
        detail.errorTerminal ? 1 : 0,
        turnId,
      );
  }

  /**
   * 启动期调用：把所有仍停在 running 的轮标记为 interrupted。
   *
   * 为什么必须先标记而不是直接续跑：进程刚起来时引擎还没就绪，
   * 盲目续跑会和用户手动操作打架。先标记，再由上层决定提示还是自动继续。
   *
   * 返回被标记的轮（含触发它的 userClientId，续跑时要用它找回原文）。
   */
  reapInterrupted(): TurnRecord[] {
    const stuck = this.db
      .prepare("SELECT * FROM turns WHERE state = 'running' ORDER BY started_at ASC")
      .all() as TurnRow[];

    if (stuck.length === 0) return [];

    const mark = this.db.prepare(
      `UPDATE turns SET state = 'interrupted', ended_at = ? WHERE id = ? AND state = 'running'`,
    );
    const now = Date.now();
    const run = this.db.transaction(() => {
      for (const row of stuck) mark.run(now, row.id);
    });
    run();

    return stuck.map((row) => ({ ...toTurn(row), state: 'interrupted' as TurnState }));
  }

  /** 当前仍停在 running 的轮（启动期收口前用于提示用户） */
  listRunning(): TurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE state = 'running' ORDER BY started_at ASC")
      .all() as TurnRow[];
    return rows.map(toTurn);
  }

  /**
   * 启动期给 UI 看的「待处理中断」：已被 reap 标成 interrupted、但还没被用户处置。
   *
   * 必须排除 resolved_at 非空的 —— 否则用户点了「继续」或「忽略」，
   * 下次启动又会看到同一条提示，变成永远消不掉的黄条。
   */
  listInterrupted(): TurnRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM turns WHERE state = 'interrupted' AND resolved_at IS NULL " +
          'ORDER BY started_at ASC',
      )
      .all() as TurnRow[];
    return rows.map(toTurn);
  }

  /** 中断轮处置完成（继续或忽略）。重复调用幂等。 */
  markResolved(turnId: string): void {
    this.db
      .prepare('UPDATE turns SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
      .run(Date.now(), turnId);
  }

  get(turnId: string): TurnRecord | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as
      | TurnRow
      | undefined;
    return row ? toTurn(row) : null;
  }

  list(sessionId: string, limit = 20): TurnRecord[] {
    // 同一毫秒内可能创建多轮（重试/连发），必须用 rowid 兜底保证稳定次序
    const rows = this.db
      .prepare(
        'SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
      )
      .all(sessionId, limit) as TurnRow[];
    return rows.map(toTurn);
  }

  last(sessionId: string): TurnRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      )
      .get(sessionId) as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  /** 是否存在未收口的轮（用于列表里打「可能中断」标记） */
  hasOpenTurn(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM turns WHERE session_id = ? AND state = 'running' LIMIT 1")
      .get(sessionId) as { x: number } | undefined;
    return Boolean(row);
  }
}
