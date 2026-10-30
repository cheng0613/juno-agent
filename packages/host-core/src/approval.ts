/**
 * 审批通道 —— Phase 2 补上的缺口。
 *
 * 坑：不挂这个监听器，Pi 的写文件 / 执行命令工具会以
 * `no_listener_attached` 被**静默拒绝**。日志里只有一行
 * `project resource assembly snapshot ... approval-resolver-unavailable`，
 * 很容易当成无害警告放过 —— 结果 agent 看起来能跑，实际只有只读工具可用。
 *
 * 三种交互共用这一个入口：
 *   - permission        写文件 / 执行命令的授权
 *   - ask_user_question agent 反问用户
 *   - plan_review       计划审批
 */
import { createInterface } from 'node:readline/promises';

import type { InteractionDecision, InteractionRequest, Logger } from '@cindy/maker-core';
import type { InteractionRequestListener } from '@cindy/maker-core';

export type ApprovalMode = 'allow' | 'deny' | 'ask';

function describe(req: InteractionRequest): string {
  switch (req.kind) {
    case 'permission':
      return `${req.toolName ?? '?'} ${JSON.stringify(req.input ?? {}).slice(0, 160)}`;
    case 'ask_user_question':
      return `${req.questions.length} 个问题`;
    case 'plan_review':
      return `计划审批`;
  }
}

export function createConsoleApproval(opts: {
  mode: ApprovalMode;
  logger: Logger;
}): InteractionRequestListener {
  const { mode, logger } = opts;

  return async (req: InteractionRequest): Promise<InteractionDecision> => {
    logger.info('interaction request', { kind: req.kind, summary: describe(req) });

    switch (req.kind) {
      case 'permission': {
        if (mode === 'allow') {
          logger.info('interaction auto-allow', { tool: req.toolName });
          return { kind: 'permission', behavior: 'allow' };
        }
        if (mode === 'deny') {
          return { kind: 'permission', behavior: 'deny', reason: 'spike auto-deny' };
        }
        return await askPermission(req);
      }

      case 'ask_user_question': {
        if (mode !== 'ask') {
          // 非交互模式：每题给一个空答案，避免阻塞 turn
          return {
            kind: 'ask_user_question',
            answers: Object.fromEntries(req.questions.map((q) => [q.question, ''])),
          };
        }
        return await askQuestions(req);
      }

      case 'plan_review': {
        if (mode === 'allow') return { kind: 'plan_review', behavior: 'allow' };
        if (mode === 'deny') return { kind: 'plan_review', behavior: 'deny', reason: 'spike auto-deny' };
        return await askPlan();
      }
    }
  };
}

/* ---------------- 交互模式（Phase 3 的 UI 会替掉这段） ---------------- */

async function withPrompt<T>(fn: (rl: ReturnType<typeof createInterface>) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

async function askPermission(req: Extract<InteractionRequest, { kind: 'permission' }>) {
  return withPrompt<InteractionDecision>(async (rl) => {
    const answer = await rl.question(
      `\n允许 ${req.toolName ?? '?'}? ${JSON.stringify(req.input ?? {}).slice(0, 200)}\n[y/N] `,
    );
    const allow = answer.trim().toLowerCase().startsWith('y');
    return allow
      ? { kind: 'permission', behavior: 'allow' }
      : { kind: 'permission', behavior: 'deny', reason: 'user denied' };
  });
}

async function askQuestions(req: Extract<InteractionRequest, { kind: 'ask_user_question' }>) {
  return withPrompt<InteractionDecision>(async (rl) => {
    const answers: Record<string, string> = {};
    for (const q of req.questions) {
      answers[q.question] = await rl.question(`\n${q.question}\n> `);
    }
    return { kind: 'ask_user_question', answers };
  });
}

async function askPlan() {
  return withPrompt<InteractionDecision>(async (rl) => {
    const answer = await rl.question('\n批准这个计划? [y/N] ');
    return answer.trim().toLowerCase().startsWith('y')
      ? { kind: 'plan_review', behavior: 'allow' }
      : { kind: 'plan_review', behavior: 'deny', reason: 'user denied' };
  });
}
