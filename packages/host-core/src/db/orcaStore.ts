/**
 * ORCA 数据访问层。
 *
 * 方法名对齐上游 Cindy 的 orcaTeamStore，方便以后对照。
 * 但只实现当前需要的 —— Cindy 那套 977 行里大半是跨设备和消息队列，
 * 我们还不做那些。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from '../db/open.js';
import {
  createWorkerLabel,
  normalizeOrcaLabel,
  normalizeOrcaRole,
  type OrcaTeamRecord,
  type OrcaTeamStatus,
  type OrcaWorkerRecord,
  type OrcaWorkerStatus,
} from '../orca/types.js';

interface TeamRow {
  id: string;
  lead_session_id: string;
  status: string;
  created_at: number;
  completed_at: number | null;
}

interface WorkerRow {
  id: string;
  team_id: string;
  session_id: string;
  role: string;
  label: string | null;
  status: string;
  focused: number;
  idle_since: number | null;
  created_at: number;
  updated_at: number;
}

function toTeam(row: TeamRow): OrcaTeamRecord {
  return {
    id: row.id,
    leadSessionId: row.lead_session_id,
    status: row.status as OrcaTeamStatus,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function toWorker(row: WorkerRow): OrcaWorkerRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    sessionId: row.session_id,
    role: row.role,
    label: row.label,
    status: row.status as OrcaWorkerStatus,
    focused: row.focused === 1,
    idleSince: row.idle_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OrcaStore {
  constructor(private readonly db: Db) {}

  /**
   * 取 lead 的 active team，没有就建。
   *
   * 幂等：唯一索引 `uniq_orca_active_team` 保证一个 lead 只有一个 active team，
   * 并发调用时靠 INSERT OR IGNORE + 重读兜住。
   */
  createOrGetTeamForLead(leadSessionId: string): OrcaTeamRecord {
    const existing = this.getActiveTeamByLead(leadSessionId);
    if (existing) return existing;

    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orca_teams (id, lead_session_id, status, created_at)
         VALUES (?, ?, 'active', ?)`,
      )
      .run(randomUUID(), leadSessionId, now);
    // 同时给 lead 打标记，侧栏据此区分
    this.db
      .prepare(`UPDATE sessions SET orca_role = 'lead' WHERE id = ?`)
      .run(leadSessionId);

    const created = this.getActiveTeamByLead(leadSessionId);
    if (!created) throw new Error(`建 team 失败: ${leadSessionId}`);
    return created;
  }

  getActiveTeamByLead(leadSessionId: string): OrcaTeamRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM orca_teams WHERE lead_session_id = ? AND status = 'active'`)
      .get(leadSessionId) as TeamRow | undefined;
    return row ? toTeam(row) : null;
  }

  /** worker 反查它属于哪个 team（以及 lead 是谁） */
  getTeamByWorkerSession(sessionId: string): OrcaTeamRecord | null {
    const row = this.db
      .prepare(
        `SELECT t.* FROM orca_teams t
           JOIN orca_workers w ON w.team_id = t.id
          WHERE w.session_id = ?`,
      )
      .get(sessionId) as TeamRow | undefined;
    return row ? toTeam(row) : null;
  }

  /**
   * 加一个 worker。
   *
   * label 不传或撞名时自动生成（developer、developer-2 …），
   * 让 UI 永远能显示一个可辨识的名字。
   */
  addWorker(input: {
    teamId: string;
    sessionId: string;
    role: string;
    label?: string | null;
  }): OrcaWorkerRecord {
    const role = normalizeOrcaRole(input.role);
    const explicit = normalizeOrcaLabel(input.label);
    const label = explicit ?? createWorkerLabel(role, this.listWorkerLabels(input.teamId));

    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO orca_workers
           (id, team_id, session_id, role, label, status, focused, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'idle', 0, ?, ?)`,
      )
      .run(id, input.teamId, input.sessionId, role, label, now, now);

    // 给 worker 会话打标记：侧栏据此把它从主列表里过滤掉
    this.db
      .prepare(`UPDATE sessions SET orca_role = 'worker' WHERE id = ?`)
      .run(input.sessionId);

    const row = this.db
      .prepare('SELECT * FROM orca_workers WHERE id = ?')
      .get(id) as WorkerRow;
    return toWorker(row);
  }

  listWorkerLabels(teamId: string): string[] {
    const rows = this.db
      .prepare('SELECT label FROM orca_workers WHERE team_id = ? AND label IS NOT NULL')
      .all(teamId) as Array<{ label: string }>;
    return rows.map((r) => r.label);
  }

  listWorkersByLead(leadSessionId: string): OrcaWorkerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT w.* FROM orca_workers w
           JOIN orca_teams t ON t.id = w.team_id
          WHERE t.lead_session_id = ?
          ORDER BY w.created_at ASC`,
      )
      .all(leadSessionId) as WorkerRow[];
    return rows.map(toWorker);
  }

  listWorkersByTeam(teamId: string): OrcaWorkerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM orca_workers WHERE team_id = ? ORDER BY created_at ASC')
      .all(teamId) as WorkerRow[];
    return rows.map(toWorker);
  }

  getWorker(workerId: string): OrcaWorkerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM orca_workers WHERE id = ?')
      .get(workerId) as WorkerRow | undefined;
    return row ? toWorker(row) : null;
  }

  getWorkerBySession(sessionId: string): OrcaWorkerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM orca_workers WHERE session_id = ?')
      .get(sessionId) as WorkerRow | undefined;
    return row ? toWorker(row) : null;
  }

  /** 正在跑的 worker 数（idle/done/error 都不算） */
  countActiveWorkers(teamId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM orca_workers WHERE team_id = ? AND status = 'running'`,
      )
      .get(teamId) as { n: number };
    return row.n;
  }

  countWorkers(teamId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM orca_workers WHERE team_id = ?')
      .get(teamId) as { n: number };
    return row.n;
  }

  /**
   * 改 worker 状态。
   *
   * running 时清 idle_since（它开始干活了），
   * 其它状态记下 idle_since（用于以后「闲置多久自动回收」）。
   */
  updateWorkerStatus(workerId: string, status: OrcaWorkerStatus): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE orca_workers
            SET status = ?, idle_since = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(status, status === 'running' ? null : now, now, workerId);
  }

  /** 把某个 worker 设为 focused（同 team 其它 worker 自动取消） */
  setFocusedWorker(teamId: string, workerId: string): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE orca_workers SET focused = 0, updated_at = ? WHERE team_id = ?')
      .run(now, teamId);
    this.db
      .prepare('UPDATE orca_workers SET focused = 1, updated_at = ? WHERE id = ?')
      .run(now, workerId);
  }

  /**
   * 移除 worker（只删关联，不删会话）。
   *
   * 删会话是很重的操作 —— 用户可能有对话在里面。
   * 这里只断开 worker 关联并把会话标记清掉，会话本身留着。
   */
  removeWorker(workerId: string): void {
    const worker = this.getWorker(workerId);
    if (!worker) return;
    this.db.prepare('DELETE FROM orca_workers WHERE id = ?').run(workerId);
    this.db.prepare(`UPDATE sessions SET orca_role = NULL WHERE id = ?`).run(worker.sessionId);
  }

  /** 结束整个 team */
  markTeamEnded(teamId: string, status: Exclude<OrcaTeamStatus, 'active'>): void {
    this.db
      .prepare('UPDATE orca_teams SET status = ?, completed_at = ? WHERE id = ?')
      .run(status, Date.now(), teamId);
  }

  /** 这个会话是不是 worker（侧栏过滤用） */
  isWorkerSession(sessionId: string): boolean {
    return this.getWorkerBySession(sessionId) !== null;
  }
}
