/**
 * 注入一条「被中断的轮」，用于验收续跑 UI。
 *
 * 模拟的真实场景：用户消息已经落库、模型还没回包，进程就被强杀了。
 * 这是最有代表性的情况 —— 库里只有一句 user，后面什么都没有，
 * 所以 resumed 时必须「重发原文」，而不是发「继续」。
 *
 * 不要把中断注入到已经跑完的轮上：模型看到任务已完成还被要求「继续」，
 * 会满世界乱调工具，测试会变成无限审批循环。
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const dbPath = process.argv[2];
const prompt = process.argv[3] ?? '列出当前目录下的所有文件，然后一句话总结有几个';

if (!dbPath) {
  console.error('用法: node inject-interrupted.mjs <app.db> [原文]');
  process.exit(1);
}

const db = new Database(dbPath);

const cols = db.prepare('PRAGMA table_info(turns)').all().map((c) => c.name);
if (!cols.includes('resolved_at')) {
  console.error('该库还没迁移到 v2（缺 turns.resolved_at），先启动一次应用再注入');
  process.exit(1);
}

const session = db
  .prepare('SELECT id, title FROM sessions ORDER BY updated_at DESC LIMIT 1')
  .get();
if (!session) {
  console.error('库里没有会话，先启动应用并跑一轮再注入');
  process.exit(1);
}

const now = Date.now();
const clientId = randomUUID();
const messageId = randomUUID();
const turnId = randomUUID();

const tx = db.transaction(() => {
  // 只有一句 user，后面没有任何产出 → hasOutput = false
  db.prepare(
    `INSERT INTO messages (id, client_id, session_id, turn_id, role, content, agent_kind, created_at)
     VALUES (?, ?, ?, ?, 'user', ?, 'pi', ?)`,
  ).run(messageId, clientId, session.id, turnId, JSON.stringify({ text: prompt }), now);

  db.prepare(
    `INSERT INTO turns (id, session_id, state, attempt, user_client_id, started_at, error_terminal)
     VALUES (?, ?, 'running', 1, ?, ?, 0)`,
  ).run(turnId, session.id, clientId, now);
});

tx();

console.log(
  JSON.stringify(
    { 注入成功: turnId, 会话: session.title, 原文: prompt, 预期分支: '零产出 → 重发原文' },
    null,
    2,
  ),
);
db.close();
