/**
 * 开发工具：模拟「进程在某一轮中途被杀」。
 *
 * 真实场景下不需要这个脚本——进程被 kill 时 turn 会自然停在 running。
 * 这里是为了在不真的杀进程的情况下验证启动期恢复逻辑。
 *
 * 用法：node simulate-crash.mjs <sessionId>
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.resolve(import.meta.dirname, '../../.data/spike.db');
if (!fs.existsSync(dbPath)) {
  console.error(`db not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const sessionId =
  process.argv[2] ??
  (db.prepare('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1').get()?.id ??
    null);

if (!sessionId) {
  console.error('no session found');
  process.exit(1);
}

const turnId = randomUUID();
const userClientId = randomUUID();

db.prepare(
  `INSERT INTO turns (id, session_id, state, attempt, user_client_id, started_at)
   VALUES (?, ?, 'running', 99, ?, ?)`,
).run(turnId, sessionId, userClientId, Date.now());

console.log(
  `已注入一个停在 running 的轮：\n  sessionId=${sessionId}\n  turnId=${turnId}\n  userClientId=${userClientId}`,
);

db.close();
