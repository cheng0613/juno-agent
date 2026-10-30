/**
 * 权限规则存储 —— 让审批不再每次都弹。
 *
 * 设计取舍：
 * - 只记「工具 + 主语」两段，不做正则/glob。真实使用里 90% 的痛点是
 *   「每次 git 都问一遍」，而不是「要精确表达 `git push` 但不要 `git push --force`」。
 *   过于强大的规则语言会让用户不敢用，最后全点允许，反而更危险。
 * - subject 由宿主侧提取（bash 取命令首词，文件类取路径前缀），
 *   不让渲染层算 —— 否则规则含义会随 UI 变化而漂移。
 * - deny 规则优先于 allow：显式拒绝要能压过历史放行。
 */
import { randomUUID } from 'node:crypto';

import type { Db } from './open.js';

export type RuleBehavior = 'allow' | 'deny';
export type RuleScope = 'session' | 'global';

export interface PermissionRule {
  id: string;
  toolName: string;
  /** null = 该工具任意入参 */
  subject: string | null;
  behavior: RuleBehavior;
  scope: RuleScope;
  sessionId: string | null;
  createdAt: number;
}

interface RuleRow {
  id: string;
  tool_name: string;
  subject: string | null;
  behavior: string;
  scope: string;
  session_id: string | null;
  created_at: number;
}

function toRule(row: RuleRow): PermissionRule {
  return {
    id: row.id,
    toolName: row.tool_name,
    subject: row.subject,
    behavior: row.behavior as RuleBehavior,
    scope: row.scope as RuleScope,
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}

export class PermissionStore {
  constructor(private readonly db: Db) {}

  /**
   * 找一条能命中本次请求的规则。
   *
   * 优先级：会话级 > 全局级；带 subject 的 > 通配的；deny > allow。
   * 用一个查询取回全部候选再在内存里排序，规则表永远很小，没必要搞复杂 SQL。
   */
  lookup(toolName: string, subject: string | null, sessionId: string): PermissionRule | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM permission_rules
          WHERE tool_name = ?
            AND (subject IS NULL OR subject = ?)
            AND (scope = 'global' OR session_id = ?)`,
      )
      .all(toolName, subject, sessionId) as RuleRow[];

    if (rows.length === 0) return null;

    const ranked = rows.map(toRule).sort((a, b) => {
      // deny 压过 allow
      if (a.behavior !== b.behavior) return a.behavior === 'deny' ? -1 : 1;
      // 会话级压过全局级
      if (a.scope !== b.scope) return a.scope === 'session' ? -1 : 1;
      // 具体 subject 压过通配
      const aSpecific = a.subject === null ? 1 : 0;
      const bSpecific = b.subject === null ? 1 : 0;
      return aSpecific - bSpecific;
    });

    return ranked[0] ?? null;
  }

  /** 同义规则不重复插入（同工具+同主语+同行为+同作用域） */
  add(input: {
    toolName: string;
    subject: string | null;
    behavior: RuleBehavior;
    scope: RuleScope;
    sessionId: string | null;
  }): PermissionRule {
    const existing = this.db
      .prepare(
        `SELECT * FROM permission_rules
          WHERE tool_name = ? AND subject IS ? AND behavior = ? AND scope = ? AND session_id IS ?`,
      )
      .get(
        input.toolName,
        input.subject,
        input.behavior,
        input.scope,
        input.sessionId,
      ) as RuleRow | undefined;

    if (existing) return toRule(existing);

    const rule: PermissionRule = {
      id: randomUUID(),
      toolName: input.toolName,
      subject: input.subject,
      behavior: input.behavior,
      scope: input.scope,
      sessionId: input.sessionId,
      createdAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO permission_rules (id, tool_name, subject, behavior, scope, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id,
        rule.toolName,
        rule.subject,
        rule.behavior,
        rule.scope,
        rule.sessionId,
        rule.createdAt,
      );

    return rule;
  }

  list(): PermissionRule[] {
    const rows = this.db
      .prepare('SELECT * FROM permission_rules ORDER BY created_at DESC')
      .all() as RuleRow[];
    return rows.map(toRule);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id);
  }

  clearScope(scope: RuleScope): number {
    return this.db.prepare('DELETE FROM permission_rules WHERE scope = ?').run(scope).changes;
  }
}
