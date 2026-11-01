/**
 * Phase 2 数据层 · 打开与迁移
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { MIGRATIONS } from './schema.js';

export type Db = Database.Database;

const MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

/**
 * 打开（或创建）数据库并跑到最新版本。
 *
 * PRAGMA 说明：
 * - journal_mode = WAL   并发读 + 崩溃安全
 * - busy_timeout = 5000  主进程与后台任务同时写时不至于立刻 SQLITE_BUSY
 * - foreign_keys = ON    SQLite 默认关闭！不开的话 ON DELETE CASCADE 静默失效
 */
export async function openDatabase(dbPath: string): Promise<Db> {
  if (dbPath !== ':memory:') {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

export function migrate(db: Db): { from: number; to: number; applied: number[] } {
  db.exec(MIGRATION_TABLE);

  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const appliedVersions = new Set(rows.map((r) => r.version));
  // current 在整个迁移过程中要跟着推进：
  // 否则一次应用多条（比如空库从 v1 一路到 v8）时，
  // 第二条就会误报「expected 2, got 3」—— 这是真踩过的。
  let current = appliedVersions.size ? Math.max(...appliedVersions) : 0;
  const startVersion = current;

  // 迁移必须严格按版本递增，且不允许跳号（防止有人手写 3 却漏了 2）
  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );

  for (const m of pending) {
    if (appliedVersions.size > 0 && m.version !== current + 1) {
      throw new Error(
        `migration gap: expected version ${current + 1}, got ${m.version} (${m.name})`,
      );
    }
    // 每条迁移单独一个事务：失败时不会留下半套表
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    run();
    current = m.version;
    appliedVersions.add(m.version);
  }

  return {
    from: startVersion,
    to: current,
    applied: pending.map((m) => m.version),
  };
}
