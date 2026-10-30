/**
 * 开发工具：直接看数据库里有什么。
 *
 * 用法：
 *   node inspect.mjs                  总览
 *   node inspect.mjs --last           最近一个会话的完整消息（含工具参数）
 *   node inspect.mjs --session <id>   指定会话
 *   node inspect.mjs <dbPath>         指定数据库
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbPath =
  args.find((a) => !a.startsWith('--') && !a.match(/^[0-9a-f-]{36}$/)) ??
  path.resolve(import.meta.dirname, '../../.data/spike.db');

if (!fs.existsSync(dbPath)) {
  console.error(`db not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

/* ---------------- 单会话详细视图 ---------------- */
const wantDetail = args.includes('--last') || args.includes('--session');
if (wantDetail) {
  const sessionId = args.includes('--last')
    ? db.prepare('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1').get()?.id
    : getFlag('--session');

  if (!sessionId) {
    console.error('no session found');
    process.exit(1);
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  console.log(`\n=== session ${sessionId} ===`);
  console.log(`  model=${session.model} agent=${session.agent_kind} status=${session.status}`);
  console.log(`  sdkSessionId=${session.sdk_session_id ?? '-'}`);

  console.log('\n=== messages（按创建顺序）===');
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
    .all(sessionId);
  for (const m of rows) {
    const tool = m.tool_use_id ? ` tool=${m.tool_use_id.slice(0, 8)}` : '';
    console.log(`\n[${m.role}]${tool}`);
    try {
      console.log(JSON.stringify(JSON.parse(m.content), null, 2).slice(0, 900));
    } catch {
      console.log(String(m.content).slice(0, 900));
    }
  }

  console.log('\n=== turns ===');
  console.table(
    db
      .prepare(
        'SELECT substr(id,1,8) id, state, attempt, error_terminal, error FROM turns WHERE session_id = ? ORDER BY started_at, rowid',
      )
      .all(sessionId),
  );

  console.log('=== usage_events ===');
  console.table(
    db.prepare('SELECT * FROM usage_events WHERE session_id = ?').all(sessionId),
  );

  db.close();
  process.exit(0);
}

/* ---------------- 总览 ---------------- */

const show = (title, sql) => {
  console.log(`\n=== ${title} ===`);
  try {
    console.table(db.prepare(sql).all());
  } catch (error) {
    console.log(`  (query failed: ${error.message})`);
  }
};

show(
  'sessions',
  `SELECT substr(id,1,8) AS id, agent_kind, model, status,
          sdk_session_id IS NOT NULL AS has_sdk,
          context_tokens, context_window,
          datetime(created_at/1000,'unixepoch','localtime') AS created
   FROM sessions ORDER BY created_at DESC`,
);

show(
  'messages',
  `SELECT role, substr(client_id,1,22) AS client_id,
          substr(content,1,44) AS content,
          tool_use_id IS NOT NULL AS has_tool,
          agent_kind
   FROM messages ORDER BY created_at, rowid`,
);

show(
  'turns',
  `SELECT substr(id,1,8) AS id, state, attempt,
          substr(user_client_id,1,8) AS user_cid,
          error_terminal,
          datetime(started_at/1000,'unixepoch','localtime') AS started
   FROM turns ORDER BY started_at, rowid`,
);

show('usage_events', `SELECT * FROM usage_events ORDER BY id`);
show('attachments', `SELECT * FROM attachments`);
show('schema_migrations', `SELECT version, name FROM schema_migrations`);

db.close();
