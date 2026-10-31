/**
 * Phase 2 入口：SQLite 持久化版。
 *
 * 与 Phase 1 的差别：
 *   - SessionStorage 换成 SqliteSessionStorage
 *   - 每条消息 / 每轮执行都落库
 *   - 启动时先 reap 停在 running 的轮，识别出「上次被中断的任务」
 *
 * 运行：
 *   SPIKE_PI_API_KEY=sk-ant-... node dist/main.mjs "你的问题"
 *   SPIKE_PI_API_KEY=sk-ant-... node dist/main.mjs --resume <sessionId> "继续"
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  Maker,
  createConsoleLogger,
  isTerminalTurnEvent,
  type AgentEvent,
  type Effort,
  type PiNativeApi,
} from '@cindy/maker-core';

import {
  assertPiBinaryExists,
  createPiAgent,
  resolvePiBinary,
} from '@juno/host-core';
import { openDatabase } from '@juno/host-core';
import { SqliteSessionStorage } from '@juno/host-core';
import { MessageStore } from '@juno/host-core';
import { TurnStore } from '@juno/host-core';
import { SessionRecorder } from '@juno/host-core';
import { createConsoleApproval, type ApprovalMode } from '@juno/host-core';

const logger = createConsoleLogger('spike');

const UPSTREAM_ROOT =
  process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.SPIKE_MODEL ?? 'claude-sonnet-4-5';
const ENDPOINT = process.env.SPIKE_ENDPOINT ?? 'https://api.anthropic.com';
/** 上游 wire 协议：anthropic-messages | openai-completions | openai-responses | google-generative-ai */
const API = (process.env.SPIKE_API ?? 'anthropic-messages') as PiNativeApi;
const CONTEXT_WINDOW = Number(process.env.SPIKE_CONTEXT_WINDOW ?? 200_000);
/** 逗号分隔；空串 = 该模型不支持 effort 切换 */
const EFFORTS = (process.env.SPIKE_EFFORTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as Effort[];
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 180_000);
/** 审批策略：allow | deny | ask。默认 allow（spike 阶段；真实产品必须是交互式 UI） */
const APPROVAL = (process.env.SPIKE_APPROVAL ?? 'allow') as ApprovalMode;
const DATA_DIR = process.env.SPIKE_DATA_DIR ?? path.join(os.tmpdir(), 'spike-host');
const DB_PATH = process.env.SPIKE_DB ?? path.join(DATA_DIR, 'spike.db');

/** 解析 `--resume <id>` 与剩余的自由文本 */
function parseArgs(argv: string[]): { resumeId?: string; prompt: string } {
  const rest: string[] = [];
  let resumeId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--resume') {
      resumeId = argv[i + 1];
      i += 1;
      continue;
    }
    rest.push(argv[i]!);
  }
  return { resumeId, prompt: rest.join(' ').trim() };
}

function formatEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case 'text': {
      const data = event.data as { text?: string; isFinal?: boolean } | undefined;
      if (!data?.text || data.isFinal !== true) return null;
      return `\n[text] ${data.text}`;
    }
    case 'thinking': {
      const data = event.data as { text?: string; isFinal?: boolean } | undefined;
      if (!data?.text || data.isFinal !== true) return null;
      return `\n[thinking] ${data.text.slice(0, 200)}`;
    }
    case 'tool_use': {
      const data = event.data as Record<string, unknown> | undefined;
      return `\n[tool_use] ${String(data?.toolName ?? '?')} ${JSON.stringify(data?.input ?? {}).slice(0, 120)}`;
    }
    case 'tool_result_full':
    case 'tool_result': {
      const data = event.data as Record<string, unknown> | undefined;
      if (event.type === 'tool_result') {
        return `\n[tool_result] ${String(data?.summary ?? '?')}`;
      }
      const text = String(data?.fullText ?? '').trim();
      const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text;
      return `\n[tool_result${data?.isError ? ' ✗' : ''}] ${preview.replace(/\n/g, '\n              ')}`;
    }
    case 'error':
      return `\n[error] ${JSON.stringify(event.data)}`;
    case 'done':
      return `\n[done]`;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { resumeId, prompt } = parseArgs(process.argv.slice(2));

  // ---- 1. 数据层 ----
  const db = await openDatabase(DB_PATH);
  const storage = new SqliteSessionStorage(db);
  const messages = new MessageStore(db);
  const turns = new TurnStore(db);
  const recorder = new SessionRecorder(db, messages, turns);
  logger.info('db ready', { dbPath: DB_PATH });

  // ---- 2. 启动期恢复检查 ----
  //    进程上次被杀时，running 的轮会一直停在 running —— 这里一次性收口成 interrupted。
  const interrupted = turns.reapInterrupted();
  if (interrupted.length > 0) {
    logger.warn('found interrupted turns', {
      count: interrupted.length,
      turns: interrupted.map((t) => ({
        sessionId: t.sessionId,
        turnId: t.id,
        userClientId: t.userClientId,
      })),
    });
  } else {
    logger.info('no interrupted turns');
  }

  // ---- 3. 引擎 ----
  logger.info('routing', {
    model: MODEL,
    api: API,
    endpoint: ENDPOINT,
    contextWindow: CONTEXT_WINDOW,
    efforts: EFFORTS,
  });

  const binaryPath = resolvePiBinary(UPSTREAM_ROOT);
  await assertPiBinaryExists(binaryPath);

  const agentHome = process.env.SPIKE_AGENT_HOME ?? path.join(DATA_DIR, 'pi-agent-home');
  await fs.mkdir(agentHome, { recursive: true });

  const agent = createPiAgent({
    binaryPath,
    model: MODEL,
    api: API,
    endpoint: ENDPOINT,
    contextWindow: CONTEXT_WINDOW,
    efforts: EFFORTS,
    defaultEffort: EFFORTS.length > 0 ? EFFORTS[Math.floor(EFFORTS.length / 2)]! : null,
    agentHome,
    logger: logger.child('pi'),
  });

  const maker = new Maker({ agents: { pi: agent }, storage, logger });

  // ---- 4. 建会话或恢复 ----
  let session;
  if (resumeId) {
    const meta = await storage.get(resumeId);
    if (!meta) throw new Error(`session not found for --resume: ${resumeId}`);
    session = await maker.createSession({
      id: resumeId,
      agentKind: 'pi',
      workingDir: meta.workDir,
      model: meta.model,
      title: meta.title,
    });
    logger.info('session resumed', { sessionId: resumeId, sdkSessionId: meta.sdkSessionId });
  } else {
    const workDir = process.env.SPIKE_WORKDIR ?? path.join(DATA_DIR, 'workspace');
    await fs.mkdir(workDir, { recursive: true });
    session = await maker.createSession({
      agentKind: 'pi',
      workingDir: workDir,
      model: MODEL,
      title: 'spike',
    });
    logger.info('session created', { sessionId: session.id, workDir });
  }

  // ---- 5. 挂审批通道 ----
  //   不挂的话，Pi 的写文件/执行命令工具会以 no_listener_attached 被静默拒绝，
  //   只有只读工具能用，极难排查。
  session.setInteractionListener(
    createConsoleApproval({ mode: APPROVAL, logger: logger.child('approval') }),
  );
  logger.info('approval channel attached', { mode: APPROVAL });

  // ---- 6. 落库 + 等终态 ----
  const turn = recorder.beginUserTurn(session.id, 'pi', prompt);
  logger.info('turn begun', { ...turn });

  let settled = false;
  const terminal = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      recorder.finish(turn.turnId, 'error', 'timeout');
      logger.error('turn timed out', { timeoutMs: TIMEOUT_MS });
      resolve();
    }, TIMEOUT_MS);

    session.onEvent((event: AgentEvent) => {
      recorder.onEvent(session.id, turn.turnId, 'pi', event);

      const line = formatEvent(event);
      if (line) process.stdout.write(line + '\n');

      if (!settled && event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });

  process.stdout.write(`\n> ${prompt}\n`);
  const sendResult = await session.send(prompt);
  logger.info('send accepted', sendResult && typeof sendResult === 'object' ? sendResult : {});

  await terminal;

  // ---- 7. 收尾 + 落库校验 ----
  if (!settled) {
    // 超时路径已经收口过，这里不再重复
  }

  const stored = messages.list(session.id);
  const lastTurn = turns.last(session.id);
  logger.info('spike finished', {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    messageCount: messages.count(session.id),
    lastTurnState: lastTurn?.state ?? null,
    roles: stored.map((m) => m.role),
  });

  await maker.shutdown().catch(() => undefined);
  db.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  logger.error('spike failed', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
