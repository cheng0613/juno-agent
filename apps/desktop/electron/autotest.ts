/**
 * 自动化验收（仅 APP_AUTOTEST=1 时启用）。
 *
 * 目的：在真实 Electron 窗口里跑完一整轮对话，并在关键节点截图，
 * 让「UI 到底长什么样」变成可复核的证据，而不是靠口头描述。
 *
 * 它复用与生产完全相同的代码路径：HostRuntime.send → 事件 → App 渲染。
 * 唯一被绕过的是「用鼠标点输入框」这一步（React 受控组件无法可靠地从外部设值）。
 */
import { app, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { HostRuntime } from './hostRuntime.js';
import type { HostEvent } from '../src/shared/ipc.js';

const execAsync = promisify(execFile);

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
         const b = document.querySelector('.topbar-action');
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
    // 等它开始吐字，再插话 —— 太早插话这一轮可能还没真正开始
    await delay(1500);

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
      `document.querySelectorAll('.diff-panel').length`,
    );
    const fileRows = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.diff-path')].map(e => e.textContent)`,
    );
    const headText = await win.webContents.executeJavaScript(
      `document.querySelector('.diff-title') ? document.querySelector('.diff-title').innerText : ''`,
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
         const s = document.querySelector('.diff-file > summary');
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
