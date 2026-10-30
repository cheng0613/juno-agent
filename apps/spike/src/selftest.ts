/**
 * Phase 2 自检：不依赖模型 API，纯数据库层验证。
 *
 * 覆盖 5 个最容易写错的语义：
 *   1. 消息幂等（同 clientId 重复写只有一行）
 *   2. Rewind 软删边界正确
 *   3. sdkSessionId 的 CAS 清空
 *   4. 中断轮 reap（进程被杀后能识别）
 *   5. 软删会话对调用方不可见
 *
 * 运行：node dist/selftest.mjs
 */
import assert from 'node:assert/strict';

import { openDatabase } from '@spike/host-core';
import { SqliteSessionStorage } from '@spike/host-core';
import { MessageStore } from '@spike/host-core';
import { TurnStore } from '@spike/host-core';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    console.log(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  console.log('\nPhase 2 数据层自检\n');

  const db = await openDatabase(':memory:');
  const storage = new SqliteSessionStorage(db);
  const messages = new MessageStore(db);
  const turns = new TurnStore(db);

  // ---------- 1. 消息幂等 ----------
  await test('消息幂等：同 clientId 写两次只有一行', async () => {
    const session = await storage.create({
      id: 's-idem',
      agentKind: 'pi',
      workDir: '/tmp/x',
      title: 't',
      model: 'm',
    });

    const first = messages.append({
      id: 'm1',
      clientId: 'c1',
      sessionId: session.id,
      role: 'user',
      content: { text: 'hello' },
    });
    // 同 clientId、不同 id —— 模拟断线重发
    const second = messages.append({
      id: 'm1-dup',
      clientId: 'c1',
      sessionId: session.id,
      role: 'user',
      content: { text: 'hello' },
    });

    assert.equal(first, true, '首次写入应返回 true');
    assert.equal(second, false, '重复写入应返回 false');
    assert.equal(messages.count(session.id), 1, '库里应只有 1 行');
  });

  // ---------- 2. Rewind ----------
  await test('Rewind：锚点及之后的消息全部隐藏', async () => {
    const session = await storage.create({
      id: 's-rewind',
      agentKind: 'pi',
      workDir: '/tmp/x',
      title: 't',
      model: 'm',
    });

    for (let i = 0; i < 5; i += 1) {
      messages.append({
        id: `rw-${i}`,
        clientId: `rwc-${i}`,
        sessionId: session.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: { text: `m${i}` },
        createdAt: 1000 + i, // 显式递增，避免同毫秒
      });
    }

    const removed = messages.rewindTo(session.id, 'rwc-2');
    assert.equal(removed, 3, '应从第 3 条起删 3 条');
    assert.equal(messages.count(session.id), 2, '剩 2 条可见');
    assert.equal(messages.list(session.id, { includeRewound: true }).length, 5, '审计视图应仍见 5 条');
  });

  // ---------- 3. CAS ----------
  await test('CAS：sdkSessionId 只有值匹配时才清空', async () => {
    const session = await storage.create({
      id: 's-cas',
      agentKind: 'pi',
      workDir: '/tmp/x',
      title: 't',
      model: 'm',
      sdkSessionId: 'sdk-old',
    });

    assert.equal(
      await storage.compareAndClearSdkSessionId('s-cas', 'sdk-new'),
      false,
      '值不匹配应返回 false',
    );
    assert.equal((await storage.get('s-cas'))?.sdkSessionId, 'sdk-old', '不匹配时不应清空');

    assert.equal(
      await storage.compareAndClearSdkSessionId('s-cas', 'sdk-old'),
      true,
      '值匹配应返回 true',
    );
    assert.equal((await storage.get('s-cas'))?.sdkSessionId, undefined, '匹配时应清空');
  });

  // ---------- 4. 中断轮 reap ----------
  await test('中断恢复：停在 running 的轮被标记为 interrupted', async () => {
    const session = await storage.create({
      id: 's-turn',
      agentKind: 'pi',
      workDir: '/tmp/x',
      title: 't',
      model: 'm',
    });

    const t1 = turns.begin(session.id, 'uc-1');
    turns.finish(t1, 'done');

    // 模拟「进程在第二轮中途被杀」
    const t2 = turns.begin(session.id, 'uc-2');

    // 首次 reap（模拟重启）
    const reaped = turns.reapInterrupted();
    const mine = reaped.filter((t) => t.sessionId === session.id);
    assert.equal(mine.length, 1, '应识别出 1 个中断轮');
    assert.equal(mine[0]!.id, t2, '识别出的应是未收口那轮');
    assert.equal(mine[0]!.userClientId, 'uc-2', '应带回 userClientId 供重发原文');
    assert.equal(turns.last(session.id)?.state, 'interrupted', '状态应落为 interrupted');

    // 二次 reap 应为空——不能重复识别
    assert.equal(turns.reapInterrupted().length, 0, '重复 reap 应为空');
  });

  // ---------- 5. 软删 ----------
  await test('软删：delete 后 get 返回 null，但行仍在库里', async () => {
    await storage.create({
      id: 's-del',
      agentKind: 'pi',
      workDir: '/tmp/x',
      title: 't',
      model: 'm',
    });

    await storage.delete('s-del');
    assert.equal(await storage.get('s-del'), null, 'get 应返回 null');
    assert.equal(
      (await storage.list()).some((s) => s.id === 's-del'),
      false,
      'list 不应包含已删会话',
    );

    const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get('s-del') as {
      status: string;
    };
    assert.equal(row.status, 'deleted', '物理行应保留且状态为 deleted');
  });

  // ---------- 6. 外键级联 ----------
  await test('外键：删会话时消息级联删除', async () => {
    const session = await storage.create({
      id: 's-fk',
      agentKind: 'pi',
      workDir: '/tmp/x',
      title: 't',
      model: 'm',
    });
    messages.append({
      id: 'fk-m',
      clientId: 'fk-c',
      sessionId: session.id,
      role: 'user',
      content: { text: 'x' },
    });

    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    assert.equal(messages.count(session.id), 0, '消息应随会话删除');
  });

  db.close();

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} 通过${failed.length ? ' —— 有失败' : ''}\n`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error('selftest crashed:', error);
  process.exit(1);
});
