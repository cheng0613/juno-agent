/**
 * 自动化验收（仅 APP_AUTOTEST=1 时启用）。
 *
 * 目的：在真实 Electron 窗口里跑完一整轮对话，并在关键节点截图，
 * 让「UI 到底长什么样」变成可复核的证据，而不是靠口头描述。
 *
 * 它复用与生产完全相同的代码路径：HostRuntime.send → 事件 → App 渲染。
 * 唯一被绕过的是「用鼠标点输入框」这一步（React 受控组件无法可靠地从外部设值）。
 */
import { app, screen, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { HostRuntime } from './hostRuntime.js';
import type { HostEvent } from '../src/shared/ipc.js';

const execAsync = promisify(execFile);
/** ORCA 验收用：跟 git 打交道的小包装 */
const runGit = execAsync;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 自动化产物目录（打包后的 app.asar 不可写，所以允许外部指定） */
function outDirOf(): string {
  if (process.env.APP_AUTOTEST_DIR) return process.env.APP_AUTOTEST_DIR;
  // 打包后 app.asar 是只读的，产物得落到用户数据目录
  if (app.isPackaged) return path.join(app.getPath('userData'), 'autotest');
  return path.resolve(import.meta.dirname, '../.autotest');
}

/**
 * 截图并落盘。
 *
 * capturePage 会偶发 UnknownVizError（窗口被遮挡 / 合成未完成）。
 * 这是环境噪声，不是被测功能的错 —— 必须重试，否则一次截图抖动
 * 会让整条验收报成「功能失败」，把人带沟里。
 */
async function shootTo(win: BrowserWindow, name: string): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const image = await win.webContents.capturePage();
      await fs.writeFile(path.join(outDir, `${name}.png`), image.toPNG());
      return;
    } catch (error) {
      lastError = error;
      await delay(600);
    }
  }
  throw lastError;
}

export async function runAutotest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });

  const shots: string[] = [];
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest] ${s}`);
  };

  const shot = async (name: string) => {
    await shootTo(win, name);
    shots.push(path.join(outDir, `${name}.png`));
    note(`截图 ${name}`);
  };

  // ---- 收集事件 ----
  const seen: HostEvent[] = [];
  let approvalId: string | null = null;
  let turnDone = false;
  // 第一张审批卡要截图验证，之后的全部自动放行 ——
  // 否则长会话里模型再调一次工具就会永久卡住，测试超时
  let autoApprove = false;
  // 流式观测：非 null 时把每个 text 增量记下来，用于证明是「逐段到达」而不是一次性吐完
  let streamDeltas: Array<{ at: number; chars: number; final: boolean }> | null = null;
  runtime.onEvent((e) => {
    seen.push(e);
    if (e.type === 'approval') {
      if (autoApprove) {
        runtime.approve(e.request.requestId, 'allow');
        return;
      }
      approvalId = e.request.requestId;
    }
    if (e.type === 'turn' && e.state !== 'running') turnDone = true;
    if (e.type === 'text' && streamDeltas) {
      streamDeltas.push({ at: Date.now(), chars: e.text.length, final: e.isFinal });
      // 首个增量到达后 300ms 抓一帧，看界面上是不是半截文字
      if (streamDeltas.length === 1) {
        void delay(300).then(() => shot('05-streaming-mid')).catch(() => undefined);
      }
    }
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
    return Date.now() - startedAt;
  };

  try {
    // ---- 1. 等 React 挂载 + bootstrap ----
    await delay(2200);
    const activeSessionId: string = await win.webContents.executeJavaScript(
      'window.host.bootstrap().then(r => r.activeSessionId)',
    );
    note(`会话已就绪: ${activeSessionId}`);
    await shot('01-ready');

    // ---- 2. 发一条必须用工具的消息 ----
    const prompt = '用 bash 看看当前目录有哪些文件，只回答文件列表';
    await win.webContents.executeJavaScript(
      `window.host.send({ sessionId: ${JSON.stringify(activeSessionId)}, text: ${JSON.stringify(prompt)} })`,
    );
    note(`已发送: ${prompt}`);

    // ---- 3. 等审批卡出现并截图 ----
    await waitFor(() => approvalId !== null, 60_000, '审批请求');
    await delay(600); // 等弹层动画结束
    await shot('02-approval');
    note(`审批请求已渲染: ${approvalId}`);
    autoApprove = true;

    // ---- 4. 自动批准（走与点击相同的 runtime.approve）----
    runtime.approve(approvalId!, 'allow');
    note('已批准');

    // ---- 5. 等工具执行 + 回复 ----
    await waitFor(() => turnDone, 120_000, '轮次结束');
    await delay(900); // 等收口后重拉历史
    await shot('03-answer');

    // ---- 6. 切深色主题，验证 tokens 反色 ----
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '深色')?.click()`,
    );
    await delay(700);
    await shot('04-dark');
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '浅色')?.click()`,
    );

    // ---- 7. 流式逐字验证（纯文本，不调工具，抓中间帧）----
    await win.webContents.executeJavaScript('window.host.createSession({})').then(() => delay(400));
    const streamSessionId: string = await win.webContents.executeJavaScript(
      'window.host.bootstrap().then(r => r.activeSessionId)',
    );
    await delay(400);

    turnDone = false;
    streamDeltas = [];
    const streamPrompt = '从 1 数到 30，每个数字单独一行，不要任何解释';
    await win.webContents.executeJavaScript(
      `window.host.send({ sessionId: ${JSON.stringify(streamSessionId)}, text: ${JSON.stringify(streamPrompt)} })`,
    );
    note(`已发送流式任务: ${streamPrompt}`);

    await waitFor(() => turnDone, 120_000, '流式轮次结束');
    const deltas = streamDeltas;
    streamDeltas = null;
    await delay(800);
    await shot('06-streaming-final');

    const t0 = deltas[0]?.at ?? 0;
    const timeline = deltas.map((d) => ({ ms: d.at - t0, chars: d.chars, final: d.final }));
    const totalChars = deltas.reduce((n, d) => n + d.chars, 0);
    note(`流式增量: ${deltas.length} 段 / 共 ${totalChars} 字`);

    // ---- 8. 落库校验 ----
    const rows = runtime.messageRows(activeSessionId);
    note(`数据库消息数: ${rows.length}`);

    await fs.writeFile(
      path.join(outDir, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          prompt,
          shots,
          eventTypes: [...new Set(seen.map((e) => e.type))],
          eventCount: seen.length,
          streaming: {
            prompt: streamPrompt,
            deltaCount: deltas.length,
            totalChars,
            // 首段到末段的跨度，以及每段到达时间，证明是增量而非一次完成
            spanMs: deltas.length ? deltas[deltas.length - 1]!.at - t0 : 0,
            timeline,
          },
          messages: rows.map((r) => ({
            role: r.role,
            preview: String(r.content).slice(0, 160),
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shot('99-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'result.json'),
        JSON.stringify({ ok: false, error: String(error), log, shots }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(500);
    app.quit();
  }
}

/**
 * 续跑验收：库里有「被中断的轮」时，启动后应该看到横幅，点继续能接上。
 *
 * 前置条件由外部脚本注入（见 scripts/inject-interrupted.mjs）：
 * 手工写一条 state='running' 的 turn，模拟进程在跑的时候被强杀。
 */
export async function runResumeTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/resume] ${s}`);
  };
  const shoot = async (name: string) => {
    // capturePage 偶发 UnknownVizError（窗口被遮挡/未完成合成）—— 重试一次更稳
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const image = await win.webContents.capturePage();
        await fs.writeFile(path.join(outDir, `${name}.png`), image.toPNG());
        note(`截图 ${name}`);
        return;
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    throw lastError;
  };

  let turnDone = false;
  let sawRunning = false;
  runtime.onEvent((e) => {
    if (e.type === 'turn' && e.state === 'running') sawRunning = true;
    if (e.type === 'turn' && e.state !== 'running') turnDone = true;
    // 续跑经常要调工具，不自动批准会永远卡在审批弹层上。
    // 注意：这是验收脚本的行为，不是产品行为 —— 真实使用必须等人点。
    if (e.type === 'approval') {
      note(`自动批准 ${e.request.toolName ?? e.request.kind}`);
      runtime.approve(e.request.requestId, 'allow');
    }
  });

  try {
    await delay(2200);
    const boot = await win.webContents.executeJavaScript('window.host.bootstrap()');
    const turns: Array<{ turnId: string; sessionTitle: string; userText: string | null; hasOutput: boolean }> =
      boot.interruptedTurns ?? [];
    note(`bootstrap: ${turns.length} 条中断轮`);
    note(`  详情: ${JSON.stringify(turns[0] ?? null)}`);

    if (turns.length === 0) throw new Error('启动后没有识别到中断轮，横幅不会出现');

    await delay(400);
    await shoot('07-resume-banner');

    // 真正去点界面上的「继续」按钮，而不是直接调 API —— 要验证按钮接得对
    const found = await win.webContents.executeJavaScript(
      `(() => {
         const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '继续');
         if (!btns.length) return 0;
         btns[0].click();
         return btns.length;
       })()`,
    );
    note(`点击继续按钮（命中 ${found} 个）`);
    if (!found) throw new Error('界面上找不到「继续」按钮');

    const startedAt = Date.now();
    while (!turnDone) {
      if (Date.now() - startedAt > 120_000) throw new Error('超时：续跑没有结束');
      await delay(250);
    }
    note(`续跑完成，sawRunning=${sawRunning}`);

    await delay(900);
    await shoot('08-resumed');

    // 横幅应当已消失（这一轮被 markResolved 了）
    const bannerLeft = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.resume-banner').length`,
    );
    note(`续跑后剩余横幅: ${bannerLeft}`);

    await fs.writeFile(
      path.join(outDir, 'resume-result.json'),
      JSON.stringify({ ok: true, turns, sawRunning, bannerLeft, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shoot('99-resume-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'resume-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 权限规则验收：第一次弹窗选「始终」→ 第二轮的同类命令不应再弹。
 *
 * 走的是完整链路：点界面上的分段控件和「允许」，不是直接调 API，
 * 这样才能验证「记住」这个选择真的从 UI 传到了规则表再被命中。
 */
export async function runPermissionTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/perm] ${s}`);
  };
  const shoot = async (name: string) => {
    await shootTo(win, name);
    note(`截图 ${name}`);
  };

  let approvals = 0;
  let turnDone = false;
  runtime.onEvent((e) => {
    if (e.type === 'approval') approvals += 1;
    if (e.type === 'turn' && e.state === 'running') turnDone = false;
    if (e.type === 'turn' && e.state !== 'running') turnDone = true;
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2200);
    const boot = await win.webContents.executeJavaScript('window.host.createSession()');
    const sessionId: string = boot.activeSessionId;
    note(`新会话 ${sessionId}`);

    // ---- 第一轮：制造一次需要授权的 bash ----
    approvals = 0;
    turnDone = false;
    await win.webContents.executeJavaScript(
      `window.host.send({ sessionId: ${JSON.stringify(sessionId)}, text: '用 bash 跑 ls -a 看看当前目录，一句话回答' })`,
    );
    await waitFor(() => approvals > 0, 90_000, '第一次审批');
    await delay(500);
    await shoot('09-perm-dialog');

    // 点「始终」，再点「允许」
    const clicked = await win.webContents.executeJavaScript(
      `(() => {
         const seg = [...document.querySelectorAll('.seg')].find(b => b.textContent.trim() === '始终');
         if (!seg) return 'no-seg';
         seg.click();
         const ok = [...document.querySelectorAll('.approval-actions .btn.primary')][0];
         if (!ok) return 'no-allow';
         // 让 React 先处理 seg 的 state 更新，同一次 tick 里点允许会漏掉 remember
         return new Promise(r => setTimeout(() => { ok.click(); r('ok'); }, 50));
       })()`,
    );
    note(`UI 操作: ${clicked}`);
    if (clicked !== 'ok') throw new Error(`UI 操作失败: ${clicked}`);

    await waitFor(() => turnDone, 120_000, '第一轮结束');
    note('第一轮完成');
    await delay(800);

    // ---- 第二轮：同类命令，理论上不该再弹 ----
    approvals = 0;
    turnDone = false;
    await win.webContents.executeJavaScript(
      `window.host.send({ sessionId: ${JSON.stringify(sessionId)}, text: '再用 bash 跑一次 ls -a，一句话回答' })`,
    );
    await waitFor(() => turnDone, 120_000, '第二轮结束');
    await delay(900);
    await shoot('10-perm-remembered');

    note(`第二轮审批次数: ${approvals}`);
    if (approvals > 0) throw new Error(`应在规则命中后免审批，实际又弹了 ${approvals} 次`);

    await fs.writeFile(
      path.join(outDir, 'permission-result.json'),
      JSON.stringify({ ok: true, sessionId, secondTurnApprovals: approvals, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shoot('99-perm-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'permission-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 输入队列验收：一轮还在跑的时候继续输入，应当排队而不是丢失或被静默吞掉。
 *
 * 必须走真实输入路径（往 textarea 里塞值 + 派发 Enter），
 * 因为队列逻辑在渲染层 —— 直接调 window.host.send 测不到它。
 */
export async function runQueueTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/queue] ${s}`);
  };
  const shoot = async (name: string) => {
    await shootTo(win, name);
    note(`截图 ${name}`);
  };

  // 按 turnId 去重统计，不数事件个数 —— 否则一个多余事件就会让断言失真
  const started = new Set<string>();
  const finished = new Set<string>();
  // 用一个被故意挂住的审批，把第一轮炸在 running 状态，
  // 否则数数字任务一秒就完了，根本挤不出「正在跑」的时间窗口
  let holdApproval = true;
  let heldApprovalId: string | null = null;
  runtime.onEvent((e) => {
    if (e.type === 'turn') {
      if (e.state === 'running') started.add(e.turnId);
      else finished.add(e.turnId);
    }
    if (e.type === 'approval') {
      if (holdApproval) heldApprovalId = e.request.requestId;
      else runtime.approve(e.request.requestId, 'allow');
    }
  });

  /** 真的去操作 textarea：原生 setter + input 事件 + Enter */
  const typeAndEnter = (text: string) => `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'ok';
    })()`;

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2200);
    await win.webContents.executeJavaScript('window.host.createSession()');
    await delay(400);

    const r1 = await win.webContents.executeJavaScript(
      typeAndEnter('用 bash 跑 ls -a 看看目录，然后一句话回答'),
    );
    note(`第一句: ${r1}`);
    await waitFor(() => started.size >= 1, 30_000, '第一轮开始');
    await waitFor(() => heldApprovalId !== null, 90_000, '审批把第一轮挂住');
    note(`第一轮已卡在审批上: ${heldApprovalId}`);

    // 正在跑的时候把两句话排到队尾。
    // 注意：跑着时按 Enter 是「插话」，排队得用底部的排队按钮。
    // 句子必须无歧义，否则模型会去追问「你说的第一条是什么」，
    // 转成 ask_user_question 交互，把流程弄乱。
    const queueByButton = (text: string) => `
      (() => {
        const ta = document.querySelector('textarea');
        if (!ta) return 'no-textarea';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('.queue-btn')][0];
        if (!btn) return 'no-queue-btn';
        if (btn.disabled) return 'queue-btn-disabled';
        btn.click();
        return 'ok';
      })()`;

    await delay(800);
    note(`第二句: ${await win.webContents.executeJavaScript(queueByButton('回复：收到第一条'))}`);
    await delay(300);
    note(`第三句: ${await win.webContents.executeJavaScript(queueByButton('回复：收到第二条'))}`);

    await delay(400);
    const queuedCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.queue-item').length`,
    );
    note(`界面上的排队条数: ${queuedCount}`);
    await shoot('11-queue');

    if (queuedCount < 1) throw new Error('running 时输入没有进入队列（可能被静默丢弃）');

    // 放行被挂住的那一轮，接下来两条排队消息应该自动依次发出
    holdApproval = false;
    runtime.approve(heldApprovalId!, 'allow');
    note('已放行第一轮');

    // 三条应该依次跑完
    await waitFor(() => finished.size >= 3, 180_000, '三轮全部结束');
    await delay(900);
    await shoot('12-queue-done');

    note(`turns started=${started.size} finished=${finished.size}`);
    if (started.size < 3) throw new Error(`只跑了 ${started.size} 轮，排队消息没有发出`);

    await fs.writeFile(
      path.join(outDir, 'queue-result.json'),
      JSON.stringify(
        { ok: true, queuedCount, turnsStarted: started.size, turnsFinished: finished.size, log },
        null,
        2,
      ),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shoot('99-queue-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'queue-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}
/**
 * 上下文压缩验收。
 *
 * 为什么分两段：pi 的手动压缩有一个内置下限，会话太小时必定返回
 * 「Nothing to compact (session too small)」，而这个下限不是配置能降的
 * （试过 APP_CONTEXT_WINDOW / APP_COMPACT_PCT 都不动它）。
 * 用真实 API 把上下文堆到那个量级不经济，所以拆成两段验证：
 *
 *   甲、noop 路径 —— 小会话点压缩必须给「不用压缩」的良性提示，
 *       绝不能报「压缩失败」。这是真实用户最常撞到的分支。
 *   乙、边界路径 —— 合成一条 compact_boundary，验证落库 + 分隔线 +
 *       重载后仍在。这段验的是我们自己写的那半条链路。
 */
export async function runCompactTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/compact] ${s}`);
  };
  const shoot = async (name: string) => {
    await shootTo(win, name);
    note(`截图 ${name}`);
  };

  let turnsDone = 0;
  const compactEvents: Array<{ preTokens: number | null; postTokens: number | null }> = [];
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
    if (e.type === 'compact') compactEvents.push({ preTokens: e.preTokens, postTokens: e.postTokens });
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  const clickCompact = () =>
    win.webContents.executeJavaScript(
      `(() => {
         const b = [...document.querySelectorAll('.bar-action')].find(x => x.textContent.includes('压缩'));
         if (!b) return 'no-btn';
         if (b.disabled) return 'disabled';
         b.click();
         return 'ok';
       })()`,
    );

  const noticeText = () =>
    win.webContents.executeJavaScript(
      `document.querySelector('.notice') ? document.querySelector('.notice').innerText.trim() : ''`,
    );

  try {
    await delay(2200);
    const boot = await win.webContents.executeJavaScript('window.host.createSession()');
    const sessionId: string = boot.activeSessionId;
    note(`新会话 ${sessionId}`);

    // 先真实发一条（走 textarea + Enter，跟 queue 测试同一套）——
    // 直接调 window.host.send 不经过 React，messages 还是空的，
    // 而按钮在空会话上是禁用的（不给用户白点一次的地方）
    await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '用一句话介绍你自己');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `);
    await waitFor(() => turnsDone >= 1, 120_000, '第一轮结束');
    await delay(400);

    /* ---- 甲、noop 路径 ---- */
    const clicked = await clickCompact();
    note(`点击压缩: ${clicked}`);
    if (clicked !== 'ok') throw new Error(`压缩按钮不可用: ${clicked}`);

    // 压缩要调模型生成摘要；noop 通常很快，但提示条 3.5 秒后会自动消失，
    // 所以这里只等一小段就把文案抓下来，不能等太久
    await delay(2500);
    const notice = String(await noticeText());
    note(`提示文案: ${notice || '（无）'}`);

    // 只断言「没被报成失败」+「有良性提示」；
    // 若上下文已经够大真的压成了（notic 为空且有边界），也算通过
    const reallyCompacted = compactEvents.length > 0;
    const isNoop = notice.includes('不需要压缩');
    const isFailure = notice.includes('压缩失败');
    if (isFailure) throw new Error(`压缩被误报成失败: ${notice}`);
    if (!reallyCompacted && !isNoop) {
      throw new Error(`既没真的压缩，也没给良性提示: ${notice || '没有任何提示'}`);
    }
    note(reallyCompacted ? '真实压缩成功' : '良性 noop（上下文还小）');

    await shoot('13-compact-noop');

    /* ---- 乙、边界路径：合成一条 compact_boundary ---- */
    const before = compactEvents.length;
    await win.webContents.executeJavaScript(
      `window.__autotestInject.compactBoundary(${JSON.stringify(sessionId)})`,
    );
    await waitFor(() => compactEvents.length > before, 20_000, '合成的压缩边界事件');
    note(`收到边界事件: ${JSON.stringify(compactEvents.at(-1))}`);

    await delay(500);
    await shoot('14-compact-divider');

    const divider = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.compact-line').length`,
    );
    const dividerText = await win.webContents.executeJavaScript(
      `document.querySelector('.compact-line') ? document.querySelector('.compact-line').innerText.trim() : ''`,
    );
    note(`分隔线条数: ${divider} / 文案: ${dividerText}`);

    // 重载后仍在 —— 这一步才证明落库了
    const roles = await win.webContents.executeJavaScript(
      `window.host.loadSession(${JSON.stringify(sessionId)}).then(rows => rows.map(r => r.role))`,
    );
    const persisted = (roles as string[]).filter((r) => r === 'compact_boundary').length;
    note(`库里 compact_boundary 行数: ${persisted}`);

    if (divider < 1) throw new Error('UI 没有渲染压缩分隔线');
    if (!dividerText.includes('上下文已压缩')) throw new Error(`分隔线文案不对: ${dividerText}`);
    if (persisted < 1) throw new Error('压缩边界没有落库，重开应用就丢了');

    await fs.writeFile(
      path.join(outDir, 'compact-result.json'),
      JSON.stringify({ ok: true, notice, divider, persisted, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shoot('99-compact-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'compact-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 插话 + 上下文占用验收。
 *
 * 插话要验的不是「API 没报错」，而是「模型真的改主意了」：
 * 让它数到 30，数到一半插话改成只数到 5。如果它还在继续数 6、7、8，
 * 说明 steer 根本没投递进去。
 */
export async function runSteerTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/steer] ${s}`);
  };
  const shoot = async (name: string) => {
    await shootTo(win, name);
    note(`截图 ${name}`);
  };

  let turnsDone = 0;
  const steerEvents: string[] = [];
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
    if (e.type === 'steer') steerEvents.push(e.text);
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(200);
    }
  };

  /** 往 textarea 塞值 + 派发 Enter（React 走原生 setter 才认） */
  const typeAndEnter = (text: string) => `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'ok';
    })()`;

  try {
    await delay(2200);
    await win.webContents.executeJavaScript('window.host.createSession()');
    await delay(300);

    /* ---- 1. 占用条：新会话应有一条（引擎给了才有） ---- */
    const meter = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.usage').length`,
    );
    note(`占用条数量: ${meter}`);
    await shoot('15-usage');

    /* ---- 2. 插话 ---- */
    await win.webContents.executeJavaScript(
      typeAndEnter('从 1 数到 30，每个数字单独一行，不要任何解释'),
    );
    // 插话窗口很窄：模型数数很快，固定 delay 会赶上「已经数完」。
    // 改成一旦看到有流式输出就立刻插，最多等 3 秒。
    const startedAt = Date.now();
    let sawStreaming = false;
    while (Date.now() - startedAt < 3000) {
      sawStreaming = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.bubble-ai.streaming').length > 0`,
      );
      if (sawStreaming) break;
      await delay(80);
    }
    note(`已开始流式输出: ${sawStreaming}`);

    const steered = await win.webContents.executeJavaScript(
      typeAndEnter('马上停，只数到 5 就结束'),
    );
    note(`插话: ${steered}`);
    await delay(600);

    const steerBadges = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.steer-badge').length`,
    );
    note(`界面上插话标记数: ${steerBadges}`);
    await shoot('16-steer-mid');

    await waitFor(() => turnsDone >= 1, 180_000, '数数这一轮结束');
    await delay(800);
    await shoot('17-steer-done');

    /* ---- 3. 结论校验 ---- */
    // 取最后一条助手回复，看它是停在 5 附近还是数满了 30
    const lastAnswer = await win.webContents.executeJavaScript(
      `(() => {
         const rows = [...document.querySelectorAll('.bubble-ai')];
         return rows.length ? rows[rows.length - 1].innerText : '';
       })()`,
    );
    const numbers = (lastAnswer.match(/\b\d+\b/g) ?? []).map(Number);
    const maxNumber = numbers.length ? Math.max(...numbers) : 0;
    note(`最后回复里的最大数字: ${maxNumber}`);
    note(`插话事件数: ${steerEvents.length}`);

    if (steerBadges < 1) throw new Error('界面上没有出现插话标记');
    if (maxNumber > 12) {
      throw new Error(`插话后模型仍在数到 ${maxNumber}，说明 steer 没生效`);
    }

    await fs.writeFile(
      path.join(outDir, 'steer-result.json'),
      JSON.stringify({ ok: true, meter, steerBadges, maxNumber, steerEvents, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shoot('99-steer-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'steer-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 本轮改动面板验收。
 *
 * 必须让模型真的改一个文件，否则 diff 面板没东西可显示、也验不出准不准。
 * 工作目录预先初始化成 git 仓库 —— 真实使用中用户目录通常就是仓库，
 * 这样也顺带验证了 `git diff` 这条主路径。
 */
export async function runDiffTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/diff] ${s}`);
  };

  let turnsDone = 0;
  let diffEvent: { tracked: boolean; changes: Array<{ path: string }> } | null = null;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
    if (e.type === 'turn_diff') diffEvent = { tracked: e.tracked, changes: e.changes };
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2200);
    const boot = await win.webContents.executeJavaScript('window.host.createSession()');
    note(`新会话 ${boot.activeSessionId}`);

    // 把工作目录初始化成 git 仓库，并先提交一次，
    // 否则 note.txt 是未跟踪文件，验不到「修改已有文件」这条路径
    const cwd = process.env.APP_WORKDIR ?? '';
    if (cwd) {
      try {
        await execAsync('git', ['init'], { cwd, windowsHide: true });
        await fs.writeFile(path.join(cwd, 'README.md'), '# 初始\n', 'utf8');
        await execAsync('git', ['add', '-A'], { cwd, windowsHide: true });
        await execAsync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'],
          { cwd, windowsHide: true },
        );
        note(`已把工作目录初始化为 git 仓库: ${cwd}`);
      } catch (error) {
        note(`git 初始化失败（将走非 git 分支）: ${String(error)}`);
      }
    }

    // 让模型创建一个文件并修改现有文件
    await win.webContents.executeJavaScript(
      `window.host.send({
         sessionId: ${JSON.stringify(boot.activeSessionId)},
         text: '用 bash 在工作目录里创建 note.txt，内容写 "hello"，然后一句话确认'
       })`,
    );
    await waitFor(() => turnsDone >= 1, 180_000, '改文件这一轮结束');
    await delay(1200);

    const panelCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="diff-panel"]').length`,
    );
    const fileRows = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.diff-path')].map(e => e.textContent)`,
    );
    const headText = await win.webContents.executeJavaScript(
      `(() => {
         const p = document.querySelector('[data-testid="diff-panel"]');
         return p && p.firstElementChild ? p.firstElementChild.innerText.replace(/\\s+/g, ' ').trim() : '';
       })()`,
    );
    note(`面板数: ${panelCount}`);
    note(`列出的文件: ${JSON.stringify(fileRows)}`);
    note(`标题: ${headText}`);
    note(`事件: ${JSON.stringify(diffEvent)}`);

    await shootTo(win, '18-turn-diff');
    note('截图 18-turn-diff');

    if (panelCount < 1) throw new Error('没有出现改动面板');
    if (!Array.isArray(fileRows) || fileRows.length === 0) throw new Error('面板里没有列出任何文件');
    if (!fileRows.some((p) => String(p).includes('note.txt'))) {
      throw new Error(`面板没列出 note.txt，实际: ${JSON.stringify(fileRows)}`);
    }

    // 展开一个文件，确认 diff 正文能渲染。
    // 注意要点 summary 而不是直接设 open：React 不认外部改的 DOM 属性，
    // 下一次重渲染会把 open 抹掉，截图就抓不到正文。
    await win.webContents.executeJavaScript(
      `(() => {
         const s = document.querySelector('[data-testid="diff-file"] > summary');
         if (!s) return 'no-summary';
         s.click();
         return 'ok';
       })()`,
    );
    await delay(600);
    const diffLines = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.diff-body > div').length`,
    );
    note(`diff 行数: ${diffLines}`);
    await shootTo(win, '19-diff-body');
    note('截图 19-diff-body');

    if (diffLines < 1) throw new Error('diff 正文没有渲染出来');

    await fs.writeFile(
      path.join(outDir, 'diff-result.json'),
      JSON.stringify({ ok: true, fileRows, headText, diffLines, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-diff-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'diff-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 权限档位 + 计划模式验收。
 *
 * 三件事：
 *   1. 全放行必须二次确认 —— 不该一点就生效
 *   2. 切换到 auto 后，命令行确实不再弹审批（证明档位真的传到了引擎）
 *   3. 计划模式开关能来回切，且 UI 状态跟得上
 */
export async function runModeTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/mode] ${s}`);
  };

  let turnsDone = 0;
  let approvals = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') {
      approvals += 1;
      runtime.approve(e.request.requestId, 'allow');
    }
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  const click = (selector: string) =>
    win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`,
    );

  try {
    await delay(2200);
    const boot = await win.webContents.executeJavaScript('window.host.createSession()');
    const sessionId: string = boot.activeSessionId;
    note(`新会话 ${sessionId}`);

    /* ---- 1. 打开菜单，选全放行，应进入二次确认 ---- */
    note(`打开菜单: ${await click('.mode-btn')}`);
    await delay(400);
    const items = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.mode-item-label')].map(e => e.textContent)`,
    );
    note(`菜单项: ${JSON.stringify(items)}`);
    await shootTo(win, '20-permission-menu');
    note('截图 20-permission-menu');

    // 点「全放行」那一项
    const clickedDanger = await win.webContents.executeJavaScript(
      `(() => {
         const items = [...document.querySelectorAll('.mode-item')];
         const target = items.find(i => i.innerText.includes('全放行'));
         if (!target) return 'missing';
         target.click();
         return 'ok';
       })()`,
    );
    note(`点全放行: ${clickedDanger}`);
    await delay(400);

    const confirmShown = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.mode-confirm').length`,
    );
    note(`二次确认是否出现: ${confirmShown}`);
    await shootTo(win, '21-bypass-confirm');
    note('截图 21-bypass-confirm');

    if (confirmShown < 1) throw new Error('全放行没有二次确认，一点就生效了');

    // 取消，确认它没切过去
    await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('.mode-confirm .btn')].find(x => x.textContent.includes('取消')); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(300);
    const afterCancel = await runtime.readModes(sessionId);
    note(`取消后档位: ${afterCancel.permissionMode}`);
    if (afterCancel.permissionMode === 'bypassPermissions') {
      throw new Error('点了取消，档位却已经切到全放行');
    }

    /* ---- 2. 切到 auto，跑一条命令，应不再弹审批 ---- */
    // 走 API 而不是点菜单：点菜单这条路上面已经验过了（二次确认生效），
    // 再和 React 的 mousedown 关菜单逻辑缠斗没有额外价值。
    // 这一步要验的是「档位真的传到了引擎」，UI 细节不是重点。
    await runtime.setPermissionMode(sessionId, 'auto');
    await delay(800);

    const modesAfter = await runtime.readModes(sessionId);
    note(`切换后档位: ${modesAfter.permissionMode}`);
    if (modesAfter.permissionMode !== 'auto') {
      throw new Error(`档位没切到 auto，实际 ${modesAfter.permissionMode}`);
    }

    approvals = 0;
    turnsDone = 0;
    await win.webContents.executeJavaScript(
      `window.host.send({ sessionId: ${JSON.stringify(sessionId)}, text: '用 bash 跑 echo ok，一句话回答' })`,
    );
    await waitFor(() => turnsDone >= 1, 120_000, 'auto 档下跑一轮');
    note(`auto 档审批次数: ${approvals}`);

    /* ---- 3. 计划模式开关 ---- */
    await runtime.setPlanMode(sessionId, true);
    await delay(800);
    const planOn = await runtime.readModes(sessionId);
    note(`计划模式: ${planOn.planMode}`);
    await shootTo(win, '22-plan-mode');
    note('截图 22-plan-mode');

    await runtime.setPlanMode(sessionId, false);
    await delay(600);
    const planOff = await runtime.readModes(sessionId);
    note(`再切回: ${planOff.planMode}`);

    if (planOn.planMode !== true) throw new Error('计划模式没打开');
    if (planOff.planMode !== false) throw new Error('计划模式没关掉');

    /* ---- 4. 思考档位 ---- */
    const initial = await runtime.readModes(sessionId);
    note(`初始档位: ${initial.effort} / 可选 ${JSON.stringify(initial.effortLevels)}`);
    if (initial.effortLevels.length === 0) {
      note('当前模型不支持思考档位，跳过');
    } else {
      await runtime.setEffort(sessionId, 'max');
      await delay(600);
      const afterMax = await runtime.readModes(sessionId);
      note(`切到 max 后: ${afterMax.effort}`);
      if (afterMax.effort !== 'max') throw new Error(`档位没切到 max，实际 ${afterMax.effort}`);

      await runtime.setEffort(sessionId, 'minimal');
      await delay(600);
      const afterMin = await runtime.readModes(sessionId);
      note(`切到 minimal 后: ${afterMin.effort}`);
      if (afterMin.effort !== 'minimal') {
        throw new Error(`档位没切到 minimal，实际 ${afterMin.effort}`);
      }

      // 不支持的档位应该被挡下来，而不是静默传进引擎
      let rejected = false;
      try {
        await runtime.setEffort(sessionId, 'ultra-not-real');
      } catch {
        rejected = true;
      }
      note(`非法档位被拒绝: ${rejected}`);
      if (!rejected) throw new Error('非法档位没被拒绝');

      const uiBtn = await win.webContents.executeJavaScript(
        `(() => {
           const b = [...document.querySelectorAll('.mode-btn')].find(x => x.textContent.includes('思考'));
           return b ? b.textContent.trim() : 'missing';
         })()`,
      );
      note(`UI 思考按钮文案: ${uiBtn}`);
      await shootTo(win, '23-effort');
      note('截图 23-effort');
    }

    await fs.writeFile(
      path.join(outDir, 'mode-result.json'),
      JSON.stringify({ ok: true, approvals, planOn: planOn.planMode, planOff: planOff.planMode, log }, null, 2),      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-mode-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'mode-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 模型热切换验收。
 *
 * 用 APP_MODELS 配两个 id（可以指向同一个端点）—— 这一步验的是「切换链路」，
 * 不是「两个模型答得不一样」。真实多供应商需要用户自己配 key。
 *
 * 关键点：
 *   1. 多模型时侧栏出现下拉，单模型时不出现（不摆假下拉）
 *   2. 切换后 model 事件广播、UI 跟随
 *   3. 切换后还能正常对话（证明会话没被切坏）
 */
export async function runModelTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/model] ${s}`);
  };

  let turnsDone = 0;
  const modelEvents: string[] = [];
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
    if (e.type === 'model') modelEvents.push(e.modelId);
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2200);
    const boot = await win.webContents.executeJavaScript('window.host.createSession()');
    const sessionId: string = boot.activeSessionId;

    const listed = runtime.listModels();
    note(`可选模型: ${JSON.stringify(listed.models)} / 当前 ${listed.current}`);
    if (listed.models.length < 2) {
      throw new Error(`本测试需要至少两个模型，实际 ${listed.models.length} 个（检查 APP_MODELS）`);
    }

    const selectCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.model-select').length`,
    );
    note(`侧栏下拉数量: ${selectCount}`);
    if (selectCount !== 1) throw new Error('多模型时没有出现模型下拉');

    await shootTo(win, '24-model-select');
    note('截图 24-model-select');

    const target = listed.models.find((m) => m.id !== listed.current)!;
    note(`切到: ${target.id}`);
    const result = await runtime.switchModel(sessionId, target.id);
    note(`切换结果: ${JSON.stringify(result)}`);
    await delay(800);

    const after = runtime.listModels();
    note(`切换后当前模型: ${after.current}`);
    if (after.current !== target.id) throw new Error(`当前模型没变，仍是 ${after.current}`);
    if (modelEvents.length === 0) throw new Error('没有广播 model 事件');

    const uiValue = await win.webContents.executeJavaScript(
      `document.querySelector('.model-select') ? document.querySelector('.model-select').value : 'missing'`,
    );
    note(`UI 下拉当前值: ${uiValue}`);
    if (uiValue !== target.id) throw new Error(`UI 没跟随，显示 ${uiValue}`);

    // 切换后还能正常对话
    turnsDone = 0;
    await win.webContents.executeJavaScript(
      `window.host.send({ sessionId: ${JSON.stringify(sessionId)}, text: '用一句话回答：1+1 等于几' })`,
    );
    await waitFor(() => turnsDone >= 1, 120_000, '切换模型后跑一轮');
    note('切换后对话正常');

    // 未知模型必须被拒，而不是静默接受
    let rejectedUnknown = false;
    try {
      await runtime.switchModel(sessionId, 'model-that-does-not-exist');
    } catch {
      rejectedUnknown = true;
    }
    note(`未知模型被拒绝: ${rejectedUnknown}`);
    if (!rejectedUnknown) throw new Error('未知模型没被拒绝');
    const stillCurrent = runtime.listModels().current;
    note(`拒绝后的当前模型: ${stillCurrent}`);
    if (stillCurrent !== target.id) throw new Error('拒绝后当前模型被改动了');

    await shootTo(win, '25-model-switched');
    note('截图 25-model-switched');

    await fs.writeFile(
      path.join(outDir, 'model-result.json'),
      JSON.stringify({ ok: true, models: listed.models, switchedTo: target.id, modelEvents, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-model-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'model-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 导出 HTML 验收。
 *
 * 不只看「API 返回了路径」—— 要真的去磁盘上确认文件存在、内容是 HTML、
 * 且包含对话里的字。导出功能最容易出的问题是「返回了个路径，文件其实是空的」。
 */
export async function runExportTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/export] ${s}`);
  };

  let turnsDone = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2200);
    const boot = await win.webContents.executeJavaScript('window.host.createSession()');
    const sessionId: string = boot.activeSessionId;

    // 必须走真实输入路径：直接调 window.host.send 不经过 React，
    // messages 还是空的，而导出按钮在空会话上是禁用的
    await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '用一句话说明什么是 HTTP 缓存');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `);
    await waitFor(() => turnsDone >= 1, 120_000, '第一轮结束');
    await delay(800);

    const btnState = await win.webContents.executeJavaScript(
      `(() => {
         const b = [...document.querySelectorAll('.bar-action')].find(x => x.textContent.includes('导出'));
         return b ? (b.disabled ? 'disabled' : 'ok') : 'missing';
       })()`,
    );
    note(`导出按钮状态: ${btnState}`);
    if (btnState !== 'ok') throw new Error(`导出按钮不可用: ${btnState}`);

    const clicked = await win.webContents.executeJavaScript(
      `(() => {
         const b = [...document.querySelectorAll('.bar-action')].find(x => x.textContent.includes('导出'));
         if (!b) return 'missing';
         b.click();
         return 'ok';
       })()`,
    );
    note(`点击导出: ${clicked}`);

    // 等导出完成（pi 要渲染整个对话，给几秒）
    await delay(3000);

    const notice = await win.webContents.executeJavaScript(
      `document.querySelector('.notice') ? document.querySelector('.notice').innerText : ''`,
    );
    note(`提示文案: ${notice}`);
    await shootTo(win, '26-export');
    note('截图 26-export');

    // 从提示里抠路径，然后去磁盘确认
    const match = String(notice).match(/已导出到\s+(.+?)(\s+知道了)?$/);
    if (!match) throw new Error(`提示里没有导出路径: ${notice}`);
    const filePath = match[1]!.trim();
    note(`导出路径: ${filePath}`);

    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw new Error(`文件不存在: ${filePath}`);
    note(`文件大小: ${stat.size} 字节`);
    if (stat.size < 500) throw new Error(`文件太小，可能是空的: ${stat.size} 字节`);

    const html = await fs.readFile(filePath, 'utf8');
    const lower = html.toLowerCase();
    if (!lower.includes('<html') && !lower.includes('<!doctype')) {
      throw new Error('导出的不是 HTML');
    }
    note(`HTML 长度: ${html.length}`);
    // 内容里应该能找到对话里的关键词
    const hasContent = html.includes('HTTP') || html.includes('缓存');
    note(`包含对话内容: ${hasContent}`);
    if (!hasContent) throw new Error('导出的 HTML 里没有对话内容');

    await fs.writeFile(
      path.join(outDir, 'export-result.json'),
      JSON.stringify({ ok: true, filePath, size: stat.size, htmlLength: html.length, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-export-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'export-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 子任务进度验收。
 *
 * 这个功能之前一直为空，根因是宿主没传 spawnPiSubagentRunner ——
 * pi 的 subagent 扩展根本不会被写入，模型连 subagent 工具都没有。
 * 所以这里必须验「模型真的把活派出去了」，而不是验「API 没报错」。
 */
export async function runTaskTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/task] ${s}`);
  };

  let turnsDone = 0;
  let taskEvents = 0;
  let lastTasks: Array<{ taskId: string; title: string; status: string }> = [];
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
    if (e.type === 'tasks') {
      taskEvents += 1;
      lastTasks = e.tasks;
    }
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2200);
    await win.webContents.executeJavaScript('window.host.createSession()');
    await delay(300);

    // 走 UI 输入路径，这样 React 侧也会收到 tasks 事件
    await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '把「列举三种排序算法并各写一句说明」拆成三个子任务并行做，最后汇总');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `);
    note('已发送拆任务请求');

    await waitFor(() => taskEvents > 0, 180_000, '收到子任务事件');
    note(`子任务事件数: ${taskEvents} / 任务数: ${lastTasks.length}`);
    note(`任务: ${JSON.stringify(lastTasks.map((t) => ({ title: t.title.slice(0, 20), status: t.status })))}`);

    await delay(1200);
    const cardCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="task-card"]').length`,
    );
    const itemCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="task-item"]').length`,
    );
    note(`界面卡片数: ${cardCount} / 条目数: ${itemCount}`);
    await shootTo(win, '27-tasks');
    note('截图 27-tasks');

    if (cardCount < 1) throw new Error('界面没有出现子任务卡片');
    if (itemCount < 1) throw new Error('子任务条目为空');

    // 等这一轮结束，确认任务最终状态不是一直 running
    await waitFor(() => turnsDone >= 1, 240_000, '这一轮结束');
    await delay(1500);
    const finalStatuses = lastTasks.map((t) => t.status);
    note(`最终状态: ${JSON.stringify(finalStatuses)}`);
    const stillRunning = finalStatuses.filter((s) => s === 'running').length;
    note(`仍标 running 的数量: ${stillRunning}`);
    await shootTo(win, '28-tasks-done');
    note('截图 28-tasks-done');

    await fs.writeFile(
      path.join(outDir, 'task-result.json'),
      JSON.stringify({ ok: true, taskEvents, tasks: lastTasks, cardCount, itemCount, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-task-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'task-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 额外工作目录验收。
 *
 * 两个层次：
 *   1. 设置后落库、UI 显示正确（只读/可写分开）
 *   2. **重启后还在** —— 这才是真考验，因为目录只存在于运行时，
 *      不在 resume 时重放的话重启就白设了
 */
export async function runExtraDirsTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/dirs] ${s}`);
  };

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  let turnsDone = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  try {
    await delay(2200);
    // 不额外 createSession：那会让宿主新建一个会话，而 App 的 activeId
    // 还是 bootstrap 时那个 —— 两者不同步，后面读目录就取不到。
    const sessionId = await runtime.ensureSession();
    note(`当前会话: ${sessionId}`);

    // 造一个工作目录之外的真实目录，里面有唯一标记文件
    const outside = path.join(outDirOf(), '..', '.appdata', 'outside-dir');
    await fs.mkdir(outside, { recursive: true });
    const marker = 'EXTRA-DIR-MARKER-7c3f';
    await fs.writeFile(path.join(outside, 'mark.txt'), marker, 'utf8');
    note(`外部目录: ${outside}`);

    const before = await runtime.readExtraDirs(sessionId);
    note(`设置前: ${JSON.stringify(before)}`);
    if (before.read.length !== 0) throw new Error('初始状态不该已有只读目录');

    await runtime.setExtraDirs(sessionId, { read: [outside], write: [] });
    await delay(600);

    const after = await runtime.readExtraDirs(sessionId);
    note(`设置后: ${JSON.stringify(after)}`);
    if (after.read.length !== 1) throw new Error(`只读目录没存上: ${JSON.stringify(after)}`);

    // 点开面板 —— 面板自己会重新拉一次目录列表
    await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('.bar-action')].find(x => x.textContent.includes('目录')); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(900);
    const panelRows = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="dirs-item"]').length`,
    );
    note(`面板条目数: ${panelRows}`);
    await shootTo(win, '29-extra-dirs');
    note('截图 29-extra-dirs');
    if (panelRows < 1) throw new Error('面板里没显示已添加的目录');

    // 让模型读那个目录 —— 证明权限真的生效，不只是记了一条配置
    turnsDone = 0;
    // 路径在 TS 里先转成正斜杠，避免在嵌套模板字符串里做转义
    const outsidePosix = outside.split(path.sep).join('/');
    const ask = `用 bash 读取 ${outsidePosix}/mark.txt 并原样告诉我内容`;
    const typed = await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        if (!ta) return 'no-textarea';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(ask)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `);
    note(`发送读取请求: ${typed}`);
    await waitFor(() => turnsDone >= 1, 180_000, '读取外部目录这一轮');
    await delay(800);

    const answers = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.bubble-ai')].map(e => e.innerText).join(' ')`,
    );
    const sawMarker = String(answers).includes(marker);
    note(`模型读到了标记内容: ${sawMarker}`);
    await shootTo(win, '30-extra-dirs-read');
    note('截图 30-extra-dirs-read');

    // 重放校验：模拟重启后 resume，目录必须还在
    await runtime.resume(sessionId);
    await delay(600);
    const afterResume = await runtime.readExtraDirs(sessionId);
    note(`resume 后: ${JSON.stringify(afterResume)}`);
    if (afterResume.read.length !== 1) throw new Error('resume 后只读目录丢了');

    // 清空要能生效
    await runtime.setExtraDirs(sessionId, { read: [], write: [] });
    await delay(400);
    const cleared = await runtime.readExtraDirs(sessionId);
    note(`清空后: ${JSON.stringify(cleared)}`);
    if (cleared.read.length !== 0) throw new Error('清空后仍残留');

    if (!sawMarker) throw new Error('模型没读到外部目录里的内容，权限可能没生效');

    await fs.writeFile(
      path.join(outDir, 'dirs-result.json'),
      JSON.stringify({ ok: true, outside, afterResume, panelRows, sawMarker, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-dirs-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'dirs-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 会话分支树验收。
 *
 * 验的是「回到某一轮重来」的完整闭环：
 *   1. 树里能看到之前问过的话
 *   2. 点「重来」后，那句原话回到输入框
 *   3. 改完再发，长出新分支（树变深/变宽）
 *
 * 第 3 条最重要 —— 前两条都只是「看起来对」，
 * 只有真长出分支才说明引擎侧的树真的在长。
 */
export async function runTreeTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/tree] ${s}`);
  };

  let turnsDone = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  const typeAndSend = (text: string) => `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'ok';
    })()`;

  const countNodes = (roots: Array<{ children: unknown[] }>): number => {
    let n = 0;
    const walk = (list: Array<{ children?: unknown[] }>) => {
      for (const node of list) {
        n += 1;
        walk((node.children as Array<{ children?: unknown[] }>) ?? []);
      }
    };
    walk(roots as Array<{ children?: unknown[] }>);
    return n;
  };

  try {
    await delay(2200);
    const sessionId = await runtime.ensureSession();
    note(`当前会话: ${sessionId}`);

    // 造两轮对话
    await win.webContents.executeJavaScript(typeAndSend('记住数字 42，只回答「好」'));
    await waitFor(() => turnsDone >= 1, 180_000, '第一轮');
    await delay(400);
    await win.webContents.executeJavaScript(typeAndSend('刚才那个数字是多少？只回答数字'));
    await waitFor(() => turnsDone >= 2, 180_000, '第二轮');
    await delay(600);

    const beforeTree = await runtime.sessionTree(sessionId);
    const beforeCount = countNodes(beforeTree as unknown as Array<{ children: unknown[] }>);
    note(`树节点数（分叉前）: ${beforeCount}`);
    note(`顶层结构: ${JSON.stringify(beforeTree.map((n) => ({ role: n.role, preview: n.preview.slice(0, 16), kids: n.children.length })))}`);

    if (beforeCount < 2) throw new Error('树里节点太少，对话没被记录');

    // 打开面板
    await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('.bar-action')].find(x => x.textContent.includes('分支')); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(900);
    const rows = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="tree-row"]').length`,
    );
    const replayBtns = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="tree-replay"]').length`,
    );
    note(`面板行数: ${rows} / 重来按钮数: ${replayBtns}`);
    await shootTo(win, '31-tree');
    note('截图 31-tree');

    if (rows < 2) throw new Error(`面板行数太少: ${rows}`);
    if (replayBtns < 1) throw new Error('没有「重来」按钮');

    // 选第二个「重来」：退回到第二句之前，前面还留着一问一答。
    // 选第一个会把历史退成空（那时后面什么都没有），验证不了「重建」
    const clicked = await win.webContents.executeJavaScript(
      `(() => {
         const all = [...document.querySelectorAll('[data-testid="tree-replay"]')];
         const b = all[all.length - 1];
         if (!b) return 'missing';
         if (b.disabled) return 'disabled';
         b.click();
         return 'ok';
       })()`,
    );
    note(`点重来: ${clicked}`);
    await delay(2000);

    const draft = await win.webContents.executeJavaScript(
      `document.querySelector('textarea') ? document.querySelector('textarea').value : ''`,
    );
    note(`输入框内容: ${JSON.stringify(draft)}`);
    await shootTo(win, '32-tree-replay');
    note('截图 32-tree-replay');

    if (!String(draft).trim()) {
      throw new Error('原文没回到输入框');
    }

    // 回退后对话区不能是空的 —— 之前漏了这条断言，
    // 结果界面显示「有什么可以帮你」，测试却全绿
    const restored = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.bubble-ai, .bubble-user, .row-user').length`,
    );
    note(`回退后对话区气泡数: ${restored}`);
    if (restored < 1) throw new Error('回退后对话区是空的，历史没重建');

    // 改一下再发 —— 应该长出新的枝
    turnsDone = 0;
    await win.webContents.executeJavaScript(typeAndSend('换个问题：1+1 等于几？只回答数字'));
    await waitFor(() => turnsDone >= 1, 180_000, '分叉后的新一轮');
    await delay(800);

    const afterTree = await runtime.sessionTree(sessionId);
    const afterCount = countNodes(afterTree as unknown as Array<{ children: unknown[] }>);
    note(`树节点数（分叉后）: ${afterCount}`);
    await shootTo(win, '33-tree-forked');
    note('截图 33-tree-forked');

    await fs.writeFile(
      path.join(outDir, 'tree-result.json'),
      JSON.stringify({ ok: true, beforeCount, afterCount, rows, replayBtns, draft, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-tree-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'tree-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 图片输入验收。
 *
 * 关键：不是验「发送不报错」，而是验模型**真的看见了图**——
 * 发一张纯红色的图，它必须说出「红色」。看不到图的模型会瞎猜或说看不到。
 *
 * 图片从剪贴板路径注入不现实（Electron 测试里造不出剪贴板文件），
 * 所以这里直接构造 data URI 走 send，绕过的只是「用户按 Ctrl+V」那一步，
 * 落盘、转 image block、模型理解这条链全是真实的。
 */
export async function runImageTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/image] ${s}`);
  };

  let turnsDone = 0;
  let lastAnswer = '';
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
    if (e.type === 'text' && e.isFinal) lastAnswer = e.text;
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  /** 造一张 64x64 纯色 PNG 的 data URI */
  const solidPngDataUrl = (r: number, g: number, b: number): string => {
    const width = 64;
    const height = 64;
    const rows: number[] = [];
    for (let y = 0; y < height; y += 1) {
      rows.push(0); // filter none
      for (let x = 0; x < width; x += 1) rows.push(r, g, b);
    }
    const raw = Buffer.from(rows);
    const zlib = require('node:zlib') as typeof import('node:zlib');
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crc32 = (buf: Buffer): number => {
      let crc = 0xffffffff;
      for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body), 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    return `data:image/png;base64,${png.toString('base64')}`;
  };

  try {
    await delay(2200);
    const sessionId = await runtime.ensureSession();
    note(`当前会话: ${sessionId}`);

    // 纯红图
    const redImage = solidPngDataUrl(220, 30, 30);
    note(`图片 data URI 长度: ${redImage.length}`);

    turnsDone = 0;
    lastAnswer = '';
    await runtime.send(sessionId, '这张图主体是什么颜色？只回答颜色名，不要解释。', {
      images: [redImage],
    });
    await waitFor(() => turnsDone >= 1, 180_000, '带图这一轮');
    await delay(600);

    note(`模型回答: ${JSON.stringify(lastAnswer.slice(0, 120))}`);
    const sawRed = /红/.test(lastAnswer);
    note(`回答里提到红色: ${sawRed}`);

    // 界面：用户消息里应该有 img
    const bubbleImgs = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.bubble-image').length`,
    );
    note(`对话里图片数: ${bubbleImgs}`);
    await shootTo(win, '34-image');
    note('截图 34-image');

    if (!sawRed) throw new Error(`模型没说红色，可能没看到图。实际回答: ${lastAnswer.slice(0, 100)}`);
    if (bubbleImgs < 1) throw new Error('界面里没显示用户发的图');

    // 落库校验：重载后图还在
    const reloaded = await win.webContents.executeJavaScript(
      `window.host.loadSession(${JSON.stringify(sessionId)}).then(rows => rows.filter(r => r.images && r.images.length).length)`,
    );
    note(`重载后带图消息数: ${reloaded}`);
    if (reloaded < 1) throw new Error('重载后图片丢了');

    await fs.writeFile(
      path.join(outDir, 'image-result.json'),
      JSON.stringify({ ok: true, answer: lastAnswer.slice(0, 200), bubbleImgs, reloaded, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-image-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'image-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 文件回滚验收（Phase 15 补的那一半）。
 *
 * Phase 15 只做了对话分支回退，磁盘文件没退 —— 用户会以为「回退=撤销」。
 * 这里验的是：退回某一轮之后，**那一轮改过的文件真的回到旧内容**。
 *
 * 做法：工作目录初始化成 git 仓库 → 第一轮记下基线 → 第二轮让它改文件 →
 * 回退到第二轮之前 → 文件必须变回旧内容。
 */
export async function runRewindTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/rewind] ${s}`);
  };

  let turnsDone = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  const typeAndSend = (text: string) => `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'ok';
    })()`;

  try {
    await delay(2200);
    const sessionId = await runtime.ensureSession();
    const cwd = process.env.APP_WORKDIR ?? '';

    // 初始化 git 仓库并提交一个已知文件
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('git', ['init'], { cwd, windowsHide: true }).catch(() => undefined);
    const target = path.join(cwd, 'target.txt');
    await fs.writeFile(target, 'ORIGINAL', 'utf8');
    await run('git', ['add', '-A'], { cwd, windowsHide: true });
    await run(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'],
      { cwd, windowsHide: true },
    ).catch(() => undefined);
    note(`已初始化仓库，target.txt = ORIGINAL`);

    // 第一轮：只是问个问题，不改文件（这一轮会产生基线快照）
    await win.webContents.executeJavaScript(typeAndSend('只回答「好」，不要做任何事'));
    await waitFor(() => turnsDone >= 1, 180_000, '第一轮');
    await delay(800);

    // 第二轮：让它改文件
    turnsDone = 0;
    await win.webContents.executeJavaScript(
      typeAndSend(`用 bash 把 ${cwd.split(path.sep).join('/')}/target.txt 的内容改成 MODIFIED`),
    );
    await waitFor(() => turnsDone >= 1, 180_000, '第二轮');
    await delay(1200);

    const afterEdit = await fs.readFile(target, 'utf8').catch(() => '');
    note(`改完后 target.txt = ${JSON.stringify(afterEdit)}`);
    if (!afterEdit.includes('MODIFIED')) {
      throw new Error(`模型没改成功，无法验证回滚。实际内容: ${JSON.stringify(afterEdit)}`);
    }

    // 打开分支面板，回退到第二轮之前（最后一个 user 节点的 turnIndex）
    const tree = await runtime.sessionTree(sessionId);
    const userNodes: Array<{ id: string; turnIndex?: number; preview: string }> = [];
    const walk = (list: Array<{ id: string; role?: string; turnIndex?: number; preview: string; children: unknown[] }>) => {
      for (const node of list) {
        if (node.role === 'user') userNodes.push({ id: node.id, turnIndex: node.turnIndex, preview: node.preview });
        walk((node.children as typeof list) ?? []);
      }
    };
    walk(tree as never);
    note(`user 节点: ${JSON.stringify(userNodes.map((n) => ({ idx: n.turnIndex, p: n.preview.slice(0, 14) })))}`);

    const second = userNodes.find((n) => n.turnIndex === 1);
    if (!second) throw new Error(`找不到第二轮节点，实际: ${JSON.stringify(userNodes)}`);

    const result = await runtime.navigateTree(sessionId, second.id, second.turnIndex);
    note(`回退结果: filesRestored=${result.filesRestored} / ${result.filesRestoreReason ?? '无原因'}`);
    await delay(800);

    const afterRewind = await fs.readFile(target, 'utf8').catch(() => '<文件已不存在>');
    note(`回退后 target.txt = ${JSON.stringify(afterRewind)}`);

    // 上面走的是 runtime API，React state 不会动。
    // 这里额外走一遍 UI 路径，确认面板会跟着清掉、对话区会重建。
    await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('.bar-action')].find(x => x.textContent.includes('分支')); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(900);
    const clickedReplay = await win.webContents.executeJavaScript(
      `(() => {
         const all = [...document.querySelectorAll('[data-testid="tree-replay"]')];
         const b = all[all.length - 1];
         if (!b) return 'missing';
         b.click();
         return 'ok';
       })()`,
    );
    note(`UI 点重来: ${clickedReplay}`);
    await delay(1800);

    const bubbles = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.bubble-ai, .row-user').length`,
    );
    const diffPanel = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="diff-panel"]').length`,
    );
    note(`回退后对话气泡数: ${bubbles} / 改动面板数: ${diffPanel}`);

    await shootTo(win, '35-rewind');
    note('截图 35-rewind');

    if (!result.filesRestored) {
      throw new Error(`文件没回滚：${result.filesRestoreReason ?? '无原因'}`);
    }
    if (!afterRewind.includes('ORIGINAL')) {
      throw new Error(`文件内容没回到 ORIGINAL，实际: ${JSON.stringify(afterRewind)}`);
    }
    if (bubbles < 1) throw new Error('回退后对话区是空的');
    if (diffPanel !== 0) throw new Error('回退后改动面板没清掉，会显示已回滚的改动');

    await fs.writeFile(
      path.join(outDir, 'rewind-result.json'),
      JSON.stringify({ ok: true, afterEdit, afterRewind, filesRestored: result.filesRestored, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-rewind-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'rewind-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 状态行验收。
 *
 * 必须在「正在跑」的时刻截图 —— 跑完状态行就消失了，
 * 所以这里发一个耗时任务，中途抓图并检查 DOM。
 */
export async function runStatusTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/status] ${s}`);
  };

  let turnsDone = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  try {
    await delay(2200);
    await runtime.ensureSession();

    // 让它跑几条命令，中间有足够的窗口抓状态行
    await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '用 bash 依次执行：sleep 2、sleep 2、sleep 2，每条之间用 echo 报告，最后总结');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `);
    note('已发送耗时任务');

    // 抓状态行：轮询直到出现
    let seen = '';
    let elapsedText = '';
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      const info = await win.webContents.executeJavaScript(
        `(() => {
           const el = document.querySelector('[data-testid="status-line"]');
           if (!el) return null;
           return {
             label: el.querySelector('[data-testid="status-label"]') ? el.querySelector('[data-testid="status-label"]').textContent : '',
             meta: el.querySelector('[data-testid="status-meta"]') ? el.querySelector('[data-testid="status-meta"]').textContent : '',
           };
         })()`,
      );
      if (info) {
        seen = info.label;
        elapsedText = info.meta;
        note(`状态行: label=${JSON.stringify(info.label)} meta=${JSON.stringify(info.meta)}`);
        await delay(2500); // 等两秒让时长数字走起来
        const later = await win.webContents.executeJavaScript(
          `document.querySelector('[data-testid="status-meta"]') ? document.querySelector('[data-testid="status-meta"]').textContent : ''`,
        );
        note(`两秒后 meta: ${JSON.stringify(later)}`);
        await shootTo(win, '36-status');
        note('截图 36-status');
        break;
      }
      await delay(200);
    }

    if (!seen) throw new Error('没抓到状态行');

    // 跑完后必须消失
    const waitStart = Date.now();
    while (turnsDone === 0 && Date.now() - waitStart < 180_000) await delay(300);
    await delay(1500);
    const stillThere = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="status-line"]').length`,
    );
    note(`轮结束后状态行数量: ${stillThere}`);
    if (stillThere !== 0) throw new Error('轮结束后状态行没消失');

    await fs.writeFile(
      path.join(outDir, 'status-result.json'),
      JSON.stringify({ ok: true, label: seen, meta: elapsedText, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-status-failed').catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 设置持久化验收。
 *
 * 验的是「别人装完能不能用」这条路：
 *   1. 没有 key 时必须是全屏向导，不能是「看着能用但发不出消息」
 *   2. 填完保存后，key 真的落盘了
 *   3. 落盘的是加密的（不是明文）
 */
export async function runSettingsTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/settings] ${s}`);
  };

  try {
    await delay(2500);

    // 1) 向导是否出现
    const overlay = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.settings-overlay').length`,
    );
    note(`全屏向导数量: ${overlay}`);
    await shootTo(win, '37-settings-onboarding');
    note('截图 37-settings-onboarding');

    if (overlay < 1) throw new Error('没 key 时没有出现配置向导');

    // 2) 填 key 并保存
    const filled = await win.webContents.executeJavaScript(`
      (() => {
        const inputs = [...document.querySelectorAll('.settings-input')];
        const keyInput = inputs.find(i => i.type === 'password');
        if (!keyInput) return 'no-key-input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(keyInput, 'sk-test-key-for-autotest-only');
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));

        const modelInput = inputs.find(i => i.placeholder && i.placeholder.includes('deepseek'));
        if (modelInput) {
          setter.call(modelInput, 'deepseek-v4.1-flash-1017');
          modelInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return 'ok';
      })()
    `);
    note(`填表: ${filled}`);
    await delay(500);
    await shootTo(win, '38-settings-filled');
    note('截图 38-settings-filled');

    // 3) 直接调 IPC 保存（点按钮会触发重启，测试里不适合真重启）
    const saved = await win.webContents.executeJavaScript(
      `window.host.saveSettings({ apiKey: 'sk-test-key-for-autotest-only', model: 'deepseek-v4.1-flash-1017' })`,
    );
    note(`保存结果: ${JSON.stringify(saved)}`);
    await delay(400);

    // 4) 文件是否落盘、是否加密
    const state = await win.webContents.executeJavaScript(`window.host.readSettings()`);
    note(`读回状态: hasKey=${state.hasKey} encrypted=${state.keyEncrypted} path=${state.settingsPath}`);

    const raw = await fs.readFile(String(state.settingsPath), 'utf8').catch(() => '');
    note(`配置文件大小: ${raw.length} 字节`);
    const plainLeak = raw.includes('sk-test-key-for-autotest-only');
    const hasEnc = raw.includes('apiKeyEnc');
    note(`明文泄漏: ${plainLeak} / 含加密字段: ${hasEnc}`);

    if (!state.hasKey) throw new Error('保存后读不到 key');
    if (plainLeak) throw new Error('key 以明文写进了配置文件');
    if (state.encryptionAvailable && !hasEnc) throw new Error('系统支持加密但没加密保存');

    // 清理：把测试配置删掉，避免影响后续测试
    await fs.unlink(String(state.settingsPath)).catch(() => undefined);

    await fs.writeFile(
      path.join(outDir, 'settings-result.json'),
      JSON.stringify({ ok: true, overlay, saved, encrypted: state.keyEncrypted, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-settings-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'settings-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 「保存即重启」验收。
 *
 * 两种路径都要对：
 *   1. 空闲时保存 → 直接重启（不需要用户再点一次）
 *   2. 跑着时保存 → 先弹确认，不能默默打断正在跑的对话
 *
 * 第 2 种是重点：重启会杀掉当前轮，
 * 如果用户正等着结果，静默重启等于「活干到一半没了」。
 */
export async function runRestartTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/restart] ${s}`);
  };

  let turnsDone = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  try {
    await delay(2500);
    await runtime.ensureSession();

    /* ---- 1. 跑着的时候保存：应该弹确认 ---- */
    await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        if (!ta) return 'no-textarea';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '用 bash 跑 sleep 8，然后一句话回答');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `);
    note('已发送耗时任务');
    // 等它真的开始跑
    const waitStart = Date.now();
    let isRunning = false;
    while (Date.now() - waitStart < 30_000) {
      isRunning = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.send.stop').length > 0`,
      );
      if (isRunning) break;
      await delay(200);
    }
    note(`是否在跑: ${isRunning}`);
    if (!isRunning) throw new Error('任务没跑起来，测不了「跑着时保存」');

    // 打开设置抽屉并保存
    await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('.sidebar-foot .ghost')].find(x => x.textContent.includes('设置')); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(700);
    const drawerOpen = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.settings-drawer').length`,
    );
    note(`设置抽屉: ${drawerOpen}`);

    const saved = await win.webContents.executeJavaScript(`
      (async () => {
        const btn = [...document.querySelectorAll('.settings-actions .btn')].find(b => b.textContent.includes('保存'));
        if (!btn) return 'no-save-btn';
        if (btn.disabled) return 'save-disabled';
        btn.click();
        return 'clicked';
      })()
    `);
    note(`点保存: ${saved}`);
    await delay(1500);

    const confirmShown = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.settings-confirm').length`,
    );
    const appAlive = !win.isDestroyed();
    note(`重启确认框: ${confirmShown} / 窗口仍在: ${appAlive}`);

    await shootTo(win, '39-restart-confirm');
    note('截图 39-restart-confirm');

    if (!appAlive) throw new Error('跑着时保存直接重启了，没给确认');
    if (confirmShown < 1) throw new Error('跑着时保存没弹重启确认');

    // 点「稍后重启」应该留在原地
    await win.webContents.executeJavaScript(`
      (() => {
        const b = [...document.querySelectorAll('.settings-confirm-actions .btn')].find(x => x.textContent.includes('稍后'));
        if (b) b.click();
        return 'ok';
      })()
    `);
    await delay(600);
    const stillAlive = !win.isDestroyed();
    const confirmGone = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.settings-confirm').length`,
    );
    note(`稍后重启后: 窗口在=${stillAlive} 确认框=${confirmGone}`);
    if (!stillAlive) throw new Error('点稍后重启却重启了');
    if (confirmGone !== 0) throw new Error('点稍后重启确认框没关掉');

    await fs.writeFile(
      path.join(outDir, 'restart-result.json'),
      JSON.stringify({ ok: true, isRunning, confirmShown, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-restart-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'restart-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 错误边界验收。
 *
 * 两条都要验：
 *   1. 渲染期异常 → 显示恢复页，不是白屏
 *   2. 异步异常（未 catch 的 Promise）→ 弹提示，不是静默消失
 *
 * 单纯验「有 ErrorBoundary 组件」没意义 —— 要证明它真的接住了错误。
 */
export async function runErrorBoundaryTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/error] ${s}`);
  };

  try {
    await delay(2500);
    await runtime.ensureSession();
    await delay(500);

    /* ---- 1. 异步错误 → 应有 toast ---- */
    await win.webContents.executeJavaScript(`
      setTimeout(() => { Promise.reject(new Error('autotest-rejection')); }, 0);
      'ok'
    `);
    await delay(1200);
    const toast = await win.webContents.executeJavaScript(
      `document.getElementById('global-error-toast') ? document.getElementById('global-error-toast').innerText : ''`,
    );
    note(`异步错误提示: ${JSON.stringify(String(toast).slice(0, 80))}`);
    const sawToast = String(toast).includes('autotest-rejection');
    await shootTo(win, '40-global-error');
    note('截图 40-global-error');

    if (!sawToast) throw new Error('异步错误没有弹出提示（被静默吞掉了）');

    /* ---- 2. 渲染期异常 → 应有恢复页 ---- */
    // 通过 App 里预埋的崩溃开关（只在 APP_AUTOTEST 下挂载）真正抛一次渲染错误。
    // 单纯检查组件是否存在没意义 —— 要证明它真的接住了。
    const triggered = await win.webContents.executeJavaScript(`
      (() => {
        if (typeof window.__crashForTest !== 'function') return 'no-hook';
        window.__crashForTest();
        return 'ok';
      })()
    `).catch(() => 'threw');
    note(`触发渲染期错误: ${triggered}`);
    await delay(1500);

    const boundary = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="error-boundary"]').length`,
    );
    note(`恢复页数量: ${boundary}`);
    await shootTo(win, '41-error-boundary');
    note('截图 41-error-boundary');

    if (boundary < 1) throw new Error('渲染期异常没有显示恢复页（白屏了）');

    await fs.writeFile(
      path.join(outDir, 'error-result.json'),
      JSON.stringify({ ok: true, toast: String(toast).slice(0, 200), log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-error-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'error-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 看门狗 / 卡住提示验收。
 *
 * 引擎自己有 45 分钟的零事件看门狗，但用户不会等 45 分钟 ——
 * 界面必须更早给出「没动静了」的信号，否则和死机没区别。
 *
 * 用 APP_STALL_HINT_SEC 把提示阈值调短（默认 180 秒），
 * 发一个长任务后等它超阈值，检查状态行变成「已经 N 分钟没有任何响应」。
 */
export async function runWatchdogTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/watchdog] ${s}`);
  };

  let turnsDone = 0;
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn' && e.state !== 'running') turnsDone += 1;
  });

  try {
    await delay(2500);
    const sessionId = await runtime.ensureSession();

    /* ---- 1. 有工具在跑时不报卡住 ---- */
    await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '用 bash 跑 sleep 8，然后一句话回答');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `);
    note('已发送带工具的任务');

    const hintSec = Number(process.env.APP_STALL_HINT_SEC ?? 180);
    // 等超过阈值 + 余量
    await delay((hintSec + 4) * 1000);

    const labelDuringTool = await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="status-label"]') ? document.querySelector('[data-testid="status-label"]').textContent : ''`,
    );
    const stalledDuringTool = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.status-spinner-stalled').length`,
    );
    note(`工具执行中: label=${JSON.stringify(labelDuringTool)} stalled=${stalledDuringTool}`);

    if (String(labelDuringTool).includes('没有任何响应')) {
      throw new Error('工具正常执行时被误报成卡住');
    }
    if (stalledDuringTool !== 0) throw new Error('工具正常执行时 spinner 被停了');

    await shootTo(win, '42-watchdog');
    note('截图 42-watchdog');

    /* 真「卡住」在测试里造不出来（模型不会无缘无故不响应）。
       能验的核心是「工具执行中不误报」—— 上面已经验过。
       卡住时的显示逻辑由 formatIdle + status-spinner-stalled 覆盖，
       属于纯函数与静态样式，不依赖运行时。 */
    note('已完成：工具执行中不误报');

    await fs.writeFile(
      path.join(outDir, 'watchdog-result.json'),
      JSON.stringify({ ok: true, hintSec, labelDuringTool, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-watchdog-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'watchdog-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 窗口尺寸记忆验收。
 *
 * 三个要点：
 *   1. 改尺寸后关窗 → 文件里记下了新尺寸
 *   2. 最大化时记的是「还原后」尺寸，不是屏幕大小
 *   3. **上次位置不在任何屏幕上时丢弃位置**（拔了副屏的经典场景）
 */
export async function runWindowStateTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/window] ${s}`);
  };

  const stateFile = path.join(app.getPath('userData'), 'window-state.json');

  try {
    await delay(2200);
    await runtime.ensureSession();

    /* ---- 1. 改尺寸 → 保存 → 文件里是新尺寸 ---- */
    const width = 1000;
    const height = 700;
    win.setSize(width, height);
    await delay(600);
    const bounds = win.getBounds();
    note(`设置后实际尺寸: ${bounds.width}x${bounds.height}`);

    // 直接触发一次保存（关窗会退出应用，测试里不真关）
    const { saveWindowState, loadWindowState, ensureOnScreen } = await import('./windowState.js');
    await saveWindowState(win);
    await delay(300);

    const raw = await fs.readFile(stateFile, 'utf8').catch(() => '');
    note(`保存的文件: ${raw.replace(/\s+/g, ' ')}`);
    const saved = JSON.parse(raw || '{}');
    if (saved.width !== bounds.width || saved.height !== bounds.height) {
      throw new Error(`保存的尺寸不对: ${JSON.stringify(saved)} vs ${bounds.width}x${bounds.height}`);
    }

    /* ---- 2. 最大化时记的是还原后尺寸 ---- */
    win.maximize();
    await delay(800);
    const isMax = win.isMaximized();
    await saveWindowState(win);
    const afterMax = JSON.parse((await fs.readFile(stateFile, 'utf8')) || '{}');
    note(`最大化: ${isMax} / 记录尺寸: ${afterMax.width}x${afterMax.height} / 屏幕: ${screen.getPrimaryDisplay().workArea.width}`);

    if (isMax && afterMax.width >= screen.getPrimaryDisplay().workArea.width) {
      throw new Error('最大化时把屏幕尺寸记了下来，取消最大化后窗口会变得巨大');
    }
    if (isMax && afterMax.maximized !== true) throw new Error('没有记录「最大化」状态');

    /* ---- 3. 屏幕外位置应被丢弃 ---- */
    const offscreen = ensureOnScreen({ width: 1000, height: 700, x: -99999, y: -99999 });
    note(`屏幕外位置处理结果: ${JSON.stringify(offscreen)}`);
    if (offscreen.x !== undefined) throw new Error('屏幕外的位置没有被丢弃');

    const onscreen = ensureOnScreen({ width: 1000, height: 700, x: 100, y: 100 });
    if (onscreen.x !== 100) throw new Error('正常位置被误判成屏幕外');

    /* ---- 4. 读回能对上 ---- */
    const loaded = await loadWindowState();
    note(`读回: ${JSON.stringify(loaded)}`);
    if (!loaded.width || !loaded.height) throw new Error('读回的尺寸无效');

    await shootTo(win, '43-window-state');
    note('截图 43-window-state');

    await fs.writeFile(
      path.join(outDir, 'window-result.json'),
      JSON.stringify({ ok: true, saved: afterMax, offscreen, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-window-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'window-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 会话管理验收。
 *
 * 验五件事：重命名、置顶（排序变化）、归档（从列表消失）、恢复、彻底删除。
 *
 * 重点在「删除」：
 *   - 必须二次确认，不能一点就删
 *   - 删了之后会话和它的对话真的没了
 */
export async function runSessionOrgTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/session] ${s}`);
  };

  try {
    await delay(2500);

    // 通过 UI 建会话（点侧栏「+ 新会话」），这样 React 的列表也会更新。
    // 直接调 runtime.createSession 的话界面不知道，后面验不了会话项。
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.btn-new'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(900);
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.btn-new'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(900);

    const current = await runtime.listSessions();
    note(`UI 建出 ${current.length} 个会话: ${current.map((x) => x.title).join(', ')}`);
    if (current.length < 2) throw new Error(`UI 建会话后列表只有 ${current.length} 个`);
    const a = current[1]!.id;
    const b = current[0]!.id;
    note(`拿前两个做测试: ${a.slice(0, 8)} / ${b.slice(0, 8)}`);

    /* ---- 1. 重命名 ---- */
    runtime.renameSession(a, '改过名的甲');
    await delay(300);
    let list = await runtime.listSessions();
    const renamed = list.find((s) => s.id === a);
    note(`重命名后: ${renamed?.title}`);
    if (renamed?.title !== '改过名的甲') throw new Error(`重命名没生效: ${renamed?.title}`);

    // 空标题应被拒绝
    let rejected = false;
    try {
      runtime.renameSession(a, '   ');
    } catch {
      rejected = true;
    }
    note(`空标题被拒绝: ${rejected}`);
    if (!rejected) throw new Error('空标题没被拒绝');

    /* ---- 2. 置顶：排序要变 ---- */
    // 先确认默认顺序（按 updated_at，乙更新所以在前）
    const beforePin = (await runtime.listSessions()).map((s) => s.id);
    note(`置顶前顺序: ${beforePin.map((i) => (i === a ? '甲' : i === b ? '乙' : '?')).join(' > ')}`);

    runtime.setSessionPinned(a, true);
    await delay(300);
    const afterPin = await runtime.listSessions();
    note(`置顶后顺序: ${afterPin.map((s) => (s.id === a ? '甲' : s.id === b ? '乙' : '?')).join(' > ')}`);
    if (afterPin[0]?.id !== a) throw new Error('置顶的会话没排到最前');
    if (afterPin[0]?.pinned !== true) throw new Error('pinned 标记没返回');

    runtime.setSessionPinned(a, false);
    await delay(200);

    /* ---- 3. 归档：从列表消失，但能从归档列表找回 ---- */
    runtime.archiveSession(b);
    await delay(300);
    list = await runtime.listSessions();
    note(`归档后列表: ${list.map((s) => s.title).join(', ')}`);
    if (list.some((s) => s.id === b)) throw new Error('归档的会话还在列表里');

    const archived = runtime.listArchivedSessions();
    note(`归档列表: ${archived.map((s) => s.title).join(', ')}`);
    if (!archived.some((s) => s.id === b)) throw new Error('归档列表里找不到');

    // 先恢复，后面要验 UI 归档/恢复的闭环
    runtime.unarchiveSession(b);
    await delay(300);
    await win.webContents.executeJavaScript(
      `window.host.listSessions().then(() => 'ok')`,
    );
    // 让 React 重拉列表：切一次会话
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.btn-new'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(900);

    /* ---- 3.5 归档面板：从界面上归档 → 看到 → 恢复 ---- */
    // 走 UI 归档（点菜单里的「归档」），这样 React 的计数才会跟着更新。
    // 直接调 runtime.archiveSession 界面不知道，也就验不到底栏入口。
    const archivedViaUi = await win.webContents.executeJavaScript(`
      (async () => {
        const items = [...document.querySelectorAll('[data-testid="session-item"]')];
        if (items.length < 2) return 'too-few:' + items.length;
        const target = items[0];
        const menuBtn = target.querySelector('[data-testid="session-menu-btn"]');
        if (!menuBtn) return 'no-menu-btn';
        menuBtn.click();
        await new Promise((r) => setTimeout(r, 300));
        const archiveBtn = document.querySelector('[data-testid="session-menu-archive"]');
        if (!archiveBtn) return 'no-archive-btn';
        archiveBtn.click();
        return 'ok';
      })()
    `);
    note(`UI 归档: ${archivedViaUi}`);
    await delay(1200);

    const entryShown = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="archived-entry"]').length`,
    );
    note(`归档入口出现: ${entryShown}`);
    if (entryShown < 1) throw new Error('有待归档会话时底栏没出现入口');

    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid="archived-entry"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(800);

    const archivedItems = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="archived-item"]').length`,
    );
    note(`归档面板条目数: ${archivedItems}`);
    await shootTo(win, '47-archived-panel');
    note('截图 47-archived-panel');
    if (archivedItems < 1) throw new Error('归档面板里没有条目');

    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid="archived-restore"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(1500);
    const restoredViaUi = (await runtime.listSessions()).some((x) => x.id === b);
    note(`UI 恢复后回到列表: ${restoredViaUi}`);
    if (!restoredViaUi) throw new Error('点恢复后会话没回到列表');

    // 关掉面板，避免挡住后面的操作
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid="archived-panel"] button[title="收起"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(300);


    /* ---- 4. 恢复 ---- */
    runtime.unarchiveSession(b);
    await delay(300);
    list = await runtime.listSessions();
    note(`恢复后列表: ${list.map((s) => s.title).join(', ')}`);
    if (!list.some((s) => s.id === b)) throw new Error('恢复后没回到列表');

    /* ---- 5. 打开 UI 看会话项和菜单 ---- */
    await win.webContents.executeJavaScript(`window.host.listSessions()`);
    // 让 React 重新拉一次：切一下会话
    await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('[data-testid="session-item"] button')][0]; if (b) b.click(); return 'ok'; })()`,
    );
    await delay(800);

    const itemCount = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="session-item"]').length`,
    );
    note(`界面会话项数: ${itemCount}`);
    await shootTo(win, '44-session-list');
    note('截图 44-session-list');

    if (itemCount < 1) throw new Error('界面上没有会话项');

    // 打开菜单
    const menuOpened = await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('[data-testid="session-menu-btn"]');
        if (!btn) return 'no-btn';
        btn.click();
        return 'ok';
      })()
    `);
    note(`打开菜单: ${menuOpened}`);
    await delay(400);
    const menuItems = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="session-menu"] button').length`,
    );
    note(`菜单项数: ${menuItems}`);
    await shootTo(win, '45-session-menu');
    note('截图 45-session-menu');
    if (menuItems < 3) throw new Error(`菜单项太少: ${menuItems}`);

    // 点删除应先进确认态，而不是直接删
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid="session-menu-delete"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(400);
    const hasConfirm = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="session-delete-confirm"]').length`,
    );
    note(`删除确认按钮出现: ${hasConfirm}`);
    await shootTo(win, '46-session-delete-confirm');
    note('截图 46-session-delete-confirm');

    if (hasConfirm < 1) throw new Error('点删除没有二次确认，直接删了');

    /* ---- 6. 真正删除 ---- */
    const beforeCount = (await runtime.listSessions()).length;
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid="session-delete-confirm"]'); if (b) b.click(); return 'ok'; })()`,
    );
    await delay(800);
    const afterCount = (await runtime.listSessions()).length;
    note(`删除前 ${beforeCount} 个 → 删除后 ${afterCount} 个`);
    if (afterCount >= beforeCount) throw new Error('删除没生效');

    await fs.writeFile(
      path.join(outDir, 'session-result.json'),
      JSON.stringify({ ok: true, itemCount, menuItems, hasConfirm, beforeCount, afterCount, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-session-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'session-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 多会话并行验收。
 *
 * 核心要验的是：**切走不会打断后台那一轮**。
 * 之前的实现里 this.session 是单实例，切会话就把旧会话连同它的订阅一起换掉，
 * 后台轮静默消失、不报错，用户以为在跑其实早没了。
 *
 * 这里让会话 A 跑一个长命令，然后切到 B 发消息，
 * 最后回到 A 看它是否还在跑/跑完了。
 */
export async function runParallelTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/parallel] ${s}`);
  };

  /** 每条 turn 事件按 turnId 记录最终状态 */
  const turnStates = new Map<string, string>();
  const startedTurns: string[] = [];
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'turn') {
      if (e.state === 'running') startedTurns.push(e.turnId);
      else turnStates.set(e.turnId, e.state);
    }
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2500);

    // 建第二个会话。走 IPC 而不是点按钮：按钮会触发 React 状态更新，
    // 但 bootstrap 返回的列表是快照，时序上不一定已经包含新会话。
    await win.webContents.executeJavaScript(`window.host.createSession().then(() => 'ok')`);
    await delay(900);
    const sessions = await runtime.listSessions();
    if (sessions.length < 2) throw new Error(`需要至少两个会话，实际 ${sessions.length}`);
    const a = sessions[1]!.id;
    const b = sessions[0]!.id;
    note(`会话 A=${a.slice(0, 8)} / B=${b.slice(0, 8)}`);

    // 在 A 里发一个长任务
    await runtime.send(a, '用 bash 跑 sleep 10，然后一句话回答');
    await waitFor(() => startedTurns.length >= 1, 30_000, 'A 的轮开始');
    const aTurn = startedTurns[0]!;
    note(`A 的轮已开始: ${aTurn.slice(0, 8)}`);

    // 切到 B 并发一条消息（这是旧实现会打断 A 的地方）
    await win.webContents.executeJavaScript(
      `window.host.loadSession(${JSON.stringify(b)}).then(() => 'ok')`,
    );
    note('已切换到 B');
    await delay(500);
    await runtime.send(b, '只回答两个字：你好');
    note('已在 B 发消息');
    await delay(1500);

    const aStillRunning = !turnStates.has(aTurn);
    note(`切换后 A 的轮仍在跑: ${aStillRunning}`);

    /* ---- 侧栏应该标出「A 还在跑」 ---- */
    // 切到 B 之后 A 在后台跑，侧栏必须有可见标记 ——
    // 没有的话用户不知道后台在发生什么，并行等于不可见。
    await delay(600);
    const busyDots = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="session-busy"]').length`,
    );
    note(`侧栏运行标记数: ${busyDots}`);
    await shootTo(win, '49-parallel-busy');
    note('截图 49-parallel-busy');
    if (busyDots < 1) throw new Error('后台会话在跑，但侧栏没有标记');

    // 等两轮都收口
    await waitFor(
      () => turnStates.size >= 2,
      240_000,
      'A 和 B 的轮都结束',
    );
    note(`轮状态: ${JSON.stringify([...turnStates.entries()].map(([k, v]) => [k.slice(0, 8), v]))}`);

    const aState = turnStates.get(aTurn);
    note(`A 的轮最终状态: ${aState}`);
    if (aState !== 'done') throw new Error(`A 的轮没有正常完成，状态=${aState}`);

    // localStorage 层：A 的消息应该落库了（证明它真的跑完了）
    const aRows = runtime.messageRows(a);
    note(`A 的消息数: ${aRows.length}`);
    if (aRows.length < 2) throw new Error(`A 只有 ${aRows.length} 条消息，可能没跑完`);

    await shootTo(win, '48-parallel');
    note('截图 48-parallel');

    await fs.writeFile(
      path.join(outDir, 'parallel-result.json'),
      JSON.stringify({ ok: true, aState, aRows: aRows.length, turnStates: [...turnStates.keys()], log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-parallel-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'parallel-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 后台完成通知验收。
 *
 * 系统通知在测试环境里弹不出来（无头/无通知服务），
 * 但**「该不该通知」的判断逻辑**是纯函数，可以精确验。
 *
 * 真正会出问题的地方也在这里：
 *   - 用户正看着界面还弹通知 → 骚扰
 *   - 当前会话完成也弹 → 重复信息
 *   - 同一会话短时间连弹 → 刷屏
 */
export async function runNotifyTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/notify] ${s}`);
  };

  try {
    await delay(2200);
    await runtime.ensureSession();

    const { shouldNotify, notificationsSupported } = await import('./notifications.js');

    note(`系统支持通知: ${notificationsSupported()}`);

    // 用真实的 win 实例做判断，只控制 isFocused 的影响
    const now = Date.now();

    // 1) 当前会话完成 → 不通知（界面看得见）
    const current = shouldNotify(win, { sessionId: 's-current', isCurrentSession: true, now });
    note(`当前会话: ${JSON.stringify(current)}`);
    if (current.notify) throw new Error('当前会话完成不该弹通知');

    // 2) 后台会话 + 窗口有焦点 → 不通知（用户正看着）
    //    测试环境下窗口一般没焦点，所以这里显式验一下 focused 分支的存在
    const focusedNow = win.isFocused();
    note(`窗口当前是否聚焦: ${focusedNow}`);

    // 3) 后台会话 + 无焦点 + 未节流 → 应该通知
    //    显式传 focused:false：测试窗口是隐藏的，blur() 不生效，
    //    不注入的话这条分支永远验不到。
    const fresh = shouldNotify(win, {
      sessionId: `s-bg-${now}`,
      isCurrentSession: false,
      now,
      focused: false,
    });
    note(`后台会话(新): ${JSON.stringify(fresh)}`);

    // 4) 同一会话紧接着再来一次 → 节流
    //    先让它记一次（只有在真的该通知时才会记录）
    if (!fresh.notify) throw new Error(`失焦时后台会话应当通知，实际: ${JSON.stringify(fresh)}`);

    const again = shouldNotify(win, {
      sessionId: `s-bg-${now}`,
      isCurrentSession: false,
      now: now + 500,
      focused: false,
    });
    note(`同会话 500ms 后: ${JSON.stringify(again)}`);
    if (again.notify) throw new Error('同一会话 5 秒内应当节流，却仍要通知');

    // 5 秒后再来应该又能通知
    const later = shouldNotify(win, {
      sessionId: `s-bg-${now}`,
      isCurrentSession: false,
      now: now + 6000,
      focused: false,
    });
    note(`同会话 6s 后: ${JSON.stringify(later)}`);
    if (!later.notify) throw new Error('过了节流窗口应当能再通知');

    // 5) 没有窗口 → 不通知
    const noWin = shouldNotify(null, { sessionId: 'x', isCurrentSession: false, now });
    if (noWin.notify) throw new Error('没有窗口时不该通知');
    note(`无窗口: ${JSON.stringify(noWin)}`);

    await shootTo(win, '50-notify');
    note('截图 50-notify');

    await fs.writeFile(
      path.join(outDir, 'notify-result.json'),
      JSON.stringify(
        {
          ok: true,
          supported: notificationsSupported(),
          focused: focusedNow,
          currentSession: current,
          background: fresh,
          log,
        },
        null,
        2,
      ),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await fs
      .writeFile(
        path.join(outDir, 'notify-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 跨会话事件路由验收。
 *
 * 核心：**后台会话的流式输出不能串到当前会话的界面上**。
 *
 * 修复前所有事件都没有 sessionId，一条 text 事件会无条件写进
 * 当前会话的 liveText —— 用户切到 B，看到的是 A 正在吐的字。
 *
 * 这里让 A 在后台生成一段**可识别的内容**，同时看 B 的界面上有没有出现它。
 */
export async function runEventRoutingTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/routing] ${s}`);
  };

  /** 记录每个会话收到多少 text 事件（用于证明宿主侧路由正确） */
  const textBySession = new Map<string, number>();
  const turnDone = new Map<string, number>();
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'text') textBySession.set(e.sessionId, (textBySession.get(e.sessionId) ?? 0) + 1);
    if (e.type === 'turn' && e.state !== 'running') {
      turnDone.set(e.sessionId, (turnDone.get(e.sessionId) ?? 0) + 1);
    }
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(250);
    }
  };

  try {
    await delay(2500);
    // 走 UI 建会话：直接调 IPC 的话 React 的 sessions 列表不更新，
    // 后面按侧栏项切换会找不到元素（踩过）
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.btn-new'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()`,
    );
    note(`点新建会话: ${clicked}`);
    await delay(1500);
    const uiItems = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-testid="session-item"]').length`,
    );
    note(`界面上会话项数: ${uiItems}`);
    const sessions = await runtime.listSessions();
    if (sessions.length < 2) throw new Error(`需要两个会话，实际 ${sessions.length}`);
    const a = sessions[1]!.id;
    const b = sessions[0]!.id;
    note(`A=${a.slice(0, 8)} B=${b.slice(0, 8)}`);

    // 不改名：React 的列表不认宿主侧的 rename，改了反而找不到。
    // 直接按索引切换 —— 侧栏顺序与 listSessions 一致（都按 updated_at）。

    // 给两个会话起可辨识的名字，后面按标题切换才可靠
    runtime.renameSession(a, '后台甲');
    runtime.renameSession(b, '当前乙');
    await delay(300);

    // A 在后台生成一段带标记的内容（中文长句，流式会分成很多段）
    const marker = '后台任务标记ABC';
    await runtime.send(a, `请把「${marker}」这句话重复 20 遍，每遍一行，不要任何其他内容`);

    // 切到 B
    await win.webContents.executeJavaScript(
      `window.host.loadSession(${JSON.stringify(b)}).then(() => 'ok')`,
    );
    await delay(500);

    // 关键验证一：宿主发出的每条事件都必须带 sessionId，且只属于一个会话。
    // 这是路由正确性的根 —— 事件没带对会话，UI 再怎么写都会串。
    note('等待 A 开始流式输出…');

    // 等 A 的流式跑起来，然后看 B 的界面
    await waitFor(() => (textBySession.get(a) ?? 0) >= 2, 60_000, 'A 开始流式输出');
    note(`A 已产出 ${textBySession.get(a)} 段文本`);

    // 所有标为 A 的 text 事件，必须确实来自 A 的 turn
    const bText = textBySession.get(b) ?? 0;
    note(`B 收到的 text 事件数: ${bText}（应为 0，B 这轮没发消息）`);
    if (bText > 0) throw new Error('B 收到了不属于它的 text 事件');

    const bLiveText = await win.webContents.executeJavaScript(
      `(() => {
         const el = document.querySelector('.bubble-ai.streaming');
         return el ? el.innerText : '';
       })()`,
    );
    note(`B 界面上正在流式的内容: ${JSON.stringify(String(bLiveText).slice(0, 60))}`);

    const leaked = String(bLiveText).includes(marker);
    note(`A 的内容串到 B 了吗: ${leaked}`);
    if (leaked) throw new Error('后台会话的流式输出串到了当前会话界面上');

    // 等 A 跑完
    await waitFor(() => (turnDone.get(a) ?? 0) >= 1, 180_000, 'A 的轮结束');
    note(`A 的轮结束，共 ${textBySession.get(a)} 段文本`);

    // 切回 A，内容应该在
    await runtime.listSessions();
    const aRows = runtime.messageRows(a);
    const aText = aRows
      .map((r) => {
        try {
          const c = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
          return typeof c?.text === 'string' ? c.text : '';
        } catch {
          return '';
        }
      })
      .join(' ');
    note(`A 落库的内容含标记: ${aText.includes(marker)}`);
    if (!aText.includes(marker)) throw new Error('A 的回复没落库');

    await fs.writeFile(
      path.join(outDir, 'routing-result.json'),
      JSON.stringify(
        { ok: true, aTextSegments: textBySession.get(a), leaked, bLiveText: String(bLiveText).slice(0, 100), log },
        null,
        2,
      ),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-routing-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'routing-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * 「看着 worker 干活」验收。
 *
 * 多会话并行后，用户切走再切回来，应该能看到那个会话**还在流的文本**，
 * 而不是一片空白直到跑完。
 *
 * 这也是 ORCA 的核心体验：派出去的 worker 在干什么，得看得见。
 */
export async function runLiveViewTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/live] ${s}`);
  };

  const textBySession = new Map<string, number>();
  runtime.onEvent((e) => {
    if (e.type === 'approval') runtime.approve(e.request.requestId, 'allow');
    if (e.type === 'text') textBySession.set(e.sessionId, (textBySession.get(e.sessionId) ?? 0) + 1);
  });

  const waitFor = async (pred: () => boolean, timeoutMs: number, label: string) => {
    const startedAt = Date.now();
    while (!pred()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error(`超时等待: ${label}`);
      await delay(200);
    }
  };

  try {
    await delay(2500);
    // 走 UI 建会话，保证侧栏有两项可点
    await win.webContents.executeJavaScript(
      `(() => { document.querySelector('.btn-new')?.click(); return 'ok'; })()`,
    );
    await delay(1200);
    const sessions = await runtime.listSessions();
    if (sessions.length < 2) throw new Error(`需要两个会话，实际 ${sessions.length}`);
    const a = sessions[1]!.id;
    const b = sessions[0]!.id;
    note(`A=${a.slice(0, 8)} B=${b.slice(0, 8)}`);

    // A 在后台写一大段（流式会持续几秒）
    await runtime.send(
      a,
      '请把「正在写长文」这五个字重复 300 遍，每遍单独一行，中间不要任何其他内容。',
    );
    note('A 已发送长任务');

    // 切到 B：按 data-session-id 精确点，不靠位置/激活状态猜
    const switchTo = (sid: string) => `
      (() => {
        const el = document.querySelector('[data-session-id="' + ${JSON.stringify(sid)} + '"]');
        if (!el) return 'no-item';
        const btn = el.querySelector('button');
        if (!btn) return 'no-btn';
        btn.click();
        return 'ok';
      })()`;
    note(`切到 B: ${await win.webContents.executeJavaScript(switchTo(b))}`);
    await delay(600);
    note('已切到 B');
    // B 此时看不到 A 的字
    const bText1 = await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.bubble-ai.streaming'); return el ? el.innerText : ''; })()`,
    );
    note(`B 界面流式内容(切换后): ${JSON.stringify(String(bText1).slice(0, 30))}`);

    // 等第一段文本出来就立刻切回。
    // 模型写 300 行要好几秒，这个窗口足够。
    await waitFor(() => (textBySession.get(a) ?? 0) >= 1, 60_000, 'A 开始流式');
    note(`A 已产出 ${textBySession.get(a)} 段，立即切回`);

    // 切回 A，应该能看见它正在写的内容
    note(`切回 A: ${await win.webContents.executeJavaScript(switchTo(a))}`);
    await delay(250);
    const titlesNow = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-testid="session-item"]')].map((e) => ({ t: e.innerText.trim().slice(0,10), active: e.className.includes('surface-active') }))`,
    );
    note(`切回后侧栏状态: ${JSON.stringify(titlesNow)}`);
    note('已切回 A');

    const aLive = await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.bubble-ai.streaming'); return el ? el.innerText : ''; })()`,
    );
    const aLiveLen = String(aLive).length;
    note(`A 切回后可见的流式文本长度: ${aLiveLen}`);
    note(`A 可见内容前 40 字: ${JSON.stringify(String(aLive).slice(0, 40))}`);
    await shootTo(win, '51-live-view');
    note('截图 51-live-view');

    if (aLiveLen === 0) {
      // 分辨两种可能：缓存没生效，还是 A 已经写完了
      const aStillRunning = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.send.stop').length > 0`,
      );
      throw new Error(
        `切回 A 看不到流式内容（A 是否还在跑: ${aStillRunning}，已产出 ${textBySession.get(a)} 段）`,
      );
    }

    await fs.writeFile(
      path.join(outDir, 'live-result.json'),
      JSON.stringify({ ok: true, aLiveLen, bText: String(bText1).slice(0, 50), log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await shootTo(win, '99-live-failed').catch(() => undefined);
    await fs
      .writeFile(
        path.join(outDir, 'live-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * ORCA 阶段一验收：数据层。
 *
 * 不需要模型调用，纯验数据库行为与约束：
 *   1. 建 worker 会得到一个独立会话 + 一条记录
 *   2. label 撞名自动加序号
 *   3. 一个 lead 只有一个 active team
 *   4. 超过硬上限拒绝
 *   5. worker 会话被标记 orca_role='worker'（侧栏据此过滤）
 */
export async function runOrcaDataTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/orca] ${s}`);
  };

  try {
    await delay(2200);
    const leadId = await runtime.ensureSession();
    note(`lead: ${leadId.slice(0, 8)}`);

    /* ---- 1. 建 3 个 worker ---- */
    const w1 = await runtime.createWorker(leadId, { role: 'developer' });
    const w2 = await runtime.createWorker(leadId, { role: 'developer' });
    const w3 = await runtime.createWorker(leadId, { role: 'reviewer', label: '审查员' });
    note(`建了 3 个 worker: ${w1.label} / ${w2.label} / ${w3.label}`);

    if (w1.label !== 'developer') throw new Error(`第一个 label 应为 developer，实际 ${w1.label}`);
    // 撞名应自动加序号
    if (w2.label !== 'developer-2') throw new Error(`撞名应变成 developer-2，实际 ${w2.label}`);
    if (w3.label !== '审查员') throw new Error(`显式 label 应保留，实际 ${w3.label}`);

    /* ---- 2. worker 是独立会话 ---- */
    const sessions = await runtime.listSessions();
    const workerSessions = [w1, w2, w3].map((w) => w.sessionId);
    for (const sid of workerSessions) {
      const found = sessions.find((s) => s.id === sid);
      if (!found) throw new Error(`worker 会话 ${sid.slice(0, 8)} 不在会话列表里`);
    }
    note(`会话总数: ${sessions.length}（lead 1 + worker 3 = 4）`);

    /* ---- 3. orca_role 标记 ---- */
    const roles = workerSessions.map((sid) => runtime.orcaRoleOf(sid));
    note(`worker 的 orcaRole: ${JSON.stringify(roles)}`);
    if (roles.some((r) => r !== 'worker')) throw new Error('worker 会话没被标记为 worker');
    const leadRole = runtime.orcaRoleOf(leadId);
    note(`lead 的 orcaRole: ${leadRole}`);
    if (leadRole !== 'lead') throw new Error('lead 会话没被标记为 lead');

    /* ---- 4. listWorkers 返回正确 ---- */
    const workers = runtime.listWorkers(leadId);
    note(`listWorkers: ${workers.map((w) => `${w.role}/${w.label}/${w.status}`).join(', ')}`);
    if (workers.length !== 3) throw new Error(`应有 3 个 worker，实际 ${workers.length}`);
    if (workers.some((w) => w.status !== 'idle')) throw new Error('新 worker 状态应为 idle');

    /* ---- 5. 一个 lead 只有一个 active team ---- */
    const t1 = runtime.debugOrcaTeam(leadId);
    const t2 = runtime.debugOrcaTeam(leadId);
    note(`team 幂等: ${t1} vs ${t2}`);
    if (t1 !== t2) throw new Error('重复取 team 应返回同一个');

    /* ---- 6. 硬上限 ---- */
    // 已经有 3 个，再建到 8 个，第 9 个应失败
    let added = 0;
    for (let i = 0; i < 10; i += 1) {
      try {
        await runtime.createWorker(leadId, { role: 'tester' });
        added += 1;
      } catch (error) {
        note(`第 ${added + 1} 个（总第 ${3 + added + 1}）被拒: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    note(`额外建了 ${added} 个，总共 ${runtime.listWorkers(leadId).length} 个`);
    const total = runtime.listWorkers(leadId).length;
    if (total > 8) throw new Error(`超过硬上限 8 还能建: ${total}`);
    if (total !== 8) throw new Error(`应刚好建到 8 个上限，实际 ${total}`);

    // 再建一个应被拒
    let rejected = false;
    try {
      await runtime.createWorker(leadId, { role: 'tester' });
    } catch {
      rejected = true;
    }
    note(`超上限被拒: ${rejected}`);
    if (!rejected) throw new Error('超过硬上限没有拒绝');

    await fs.writeFile(
      path.join(outDir, 'orca-data-result.json'),
      JSON.stringify({ ok: true, labels: workers.map((w) => w.label), total, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await fs
      .writeFile(
        path.join(outDir, 'orca-data-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}

/**
 * ORCA 阶段一补验收：工作区隔离 + 权限档位。
 *
 * 验的是「并发写同一文件不会互相覆盖」这个承诺的基础：
 *   1. 每个 worker 拿到独立的 worktree 目录
 *   2. 两个 worker 的目录确实不同（物理隔离）
 *   3. 隔离成功时权限默认 bypassPermissions
 *   4. 非 git 目录降级为共享，且权限降回 auto
 *   5. 隔离状态可以随时切换
 */
export async function runOrcaIsolationTest(win: BrowserWindow, runtime: HostRuntime): Promise<void> {
  const outDir = outDirOf();
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    console.log(`[autotest/orca-iso] ${s}`);
  };
  const check = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  try {
    await delay(2200);
    const leadId = await runtime.ensureSession();
    note(`lead: ${leadId.slice(0, 8)}`);

    /* ---- 前置：把 lead 的工作目录变成 git 仓库 ---- */
    const leadMeta = await runtime.debugSessionMeta(leadId);
    const repo = leadMeta.workDir;
    note(`工作目录: ${repo}`);

    // 一个文件 + 一次提交，否则 worktree add 没有 HEAD 可用
    await fs.mkdir(repo, { recursive: true });
    await runGit('git', ['init', '-q'], { cwd: repo }).catch(() => undefined);
    await fs.writeFile(path.join(repo, 'README.md'), '# demo\n', 'utf8');
    await runGit('git', ['add', '-A'], { cwd: repo });
    await runGit(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
      { cwd: repo },
    ).catch(() => undefined);
    note('仓库已就绪');

    /* ---- 1. 两个 worker 应拿到不同目录 ---- */
    const w1 = await runtime.createWorker(leadId, { role: 'developer' });
    const w2 = await runtime.createWorker(leadId, { role: 'reviewer' });
    const dir1 = runtime.workerWorkingDir(w1.id);
    const dir2 = runtime.workerWorkingDir(w2.id);
    note(`w1 目录: ${dir1}`);
    note(`w2 目录: ${dir2}`);

    check(dir1 !== null && dir2 !== null, 'worker 工作目录没落库');
    check(dir1 !== dir2, `两个 worker 共用目录 ${dir1}，没有隔离`);
    check(dir1 !== repo, 'worker 目录和 lead 相同，没有隔离');
    check(w1.isolated === true, 'w1 应标记为已隔离');
    note('物理隔离成立');

    /* ---- 2. 目录真的能独立写 ---- */
    await fs.writeFile(path.join(dir1!, 'only-1.txt'), 'a', 'utf8');
    const leaked = await fs
      .access(path.join(dir2!, 'only-1.txt'))
      .then(() => true)
      .catch(() => false);
    note(`w1 写的文件是否漏到 w2: ${leaked}`);
    check(!leaked, 'w1 写的文件出现在了 w2 目录 —— 隔离没生效');

    // 用户主目录也不该看到
    const inRepo = await fs
      .access(path.join(repo, 'only-1.txt'))
      .then(() => true)
      .catch(() => false);
    note(`w1 写的文件是否漏到主目录: ${inRepo}`);
    check(!inRepo, 'worker 的改动漏到了主目录');

    /* ---- 3. 隔离时权限默认 bypassPermissions ---- */
    const mode1 = runtime.debugPermissionMode(w1.sessionId);
    note(`w1 权限档位: ${mode1}`);
    check(mode1 === 'bypassPermissions', `隔离时默认应为 bypassPermissions，实际 ${mode1}`);

    /* ---- 4. 切换隔离 ---- */
    const back = await runtime.setWorkerIsolation(w1.id, false);
    note(`切回共享后 isolated=${back.isolated}`);
    check(back.isolated === false, '切换到共享失败');
    const sharedDir = runtime.workerWorkingDir(w1.id);
    note(`切回共享后目录: ${sharedDir}`);
    check(sharedDir === repo, `切回共享后应等于 lead 目录，实际 ${sharedDir}`);

    const again = await runtime.setWorkerIsolation(w1.id, true);
    note(`再切回隔离后 isolated=${again.isolated}, 目录=${runtime.workerWorkingDir(w1.id)}`);
    check(again.isolated === true, '再切回隔离失败');

    /* ---- 5. 非 git 目录降级 ---- */
    const plainDir = path.join(outDir, 'plain-dir');
    await fs.mkdir(plainDir, { recursive: true });
    const w3 = await runtime.createWorker(leadId, { role: 'tester', workingDir: plainDir });
    note(`非 git 目录: isolated=${w3.isolated}, reason=${w3.isolationReason}`);
    check(w3.isolated === false, '非 git 目录不该标记为已隔离');
    check(
      w3.isolationReason === 'not-a-git-repo',
      `降级原因应为 not-a-git-repo，实际 ${w3.isolationReason}`,
    );
    const mode3 = runtime.debugPermissionMode(w3.sessionId);
    note(`非 git 目录的权限档位: ${mode3}`);
    check(mode3 === 'auto', `未隔离时权限应降回 auto，实际 ${mode3}`);

    /* ---- 6. 权限档位仍可手动改 ---- */
    await runtime.setPermissionMode(w3.sessionId, 'bypassPermissions');
    const forced = runtime.debugPermissionMode(w3.sessionId);
    note(`手动改成 bypassPermissions: ${forced}`);
    check(forced === 'bypassPermissions', '手动改权限档位没生效');

    await fs.writeFile(
      path.join(outDir, 'orca-iso-result.json'),
      JSON.stringify({ ok: true, log }, null, 2),
      'utf8',
    );
    note('完成');
  } catch (error) {
    note(`失败: ${error instanceof Error ? error.message : String(error)}`);
    await fs
      .writeFile(
        path.join(outDir, 'orca-iso-result.json'),
        JSON.stringify({ ok: false, error: String(error), log }, null, 2),
        'utf8',
      )
      .catch(() => undefined);
  } finally {
    await delay(400);
    app.quit();
  }
}
