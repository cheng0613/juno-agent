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
import fs from 'node:fs/promises';
import path from 'node:path';

import type { HostRuntime } from './hostRuntime.js';
import type { HostEvent } from '../src/shared/ipc.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 自动化产物目录（打包后的 app.asar 不可写，所以允许外部指定） */
function outDirOf(): string {
  if (process.env.APP_AUTOTEST_DIR) return process.env.APP_AUTOTEST_DIR;
  // 打包后 app.asar 是只读的，产物得落到用户数据目录
  if (app.isPackaged) return path.join(app.getPath('userData'), 'autotest');
  return path.resolve(import.meta.dirname, '../.autotest');
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
    const image = await win.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    await fs.writeFile(file, image.toPNG());
    shots.push(file);
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
    const image = await win.webContents.capturePage();
    await fs.writeFile(path.join(outDir, `${name}.png`), image.toPNG());
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
    const image = await win.webContents.capturePage();
    await fs.writeFile(path.join(outDir, `${name}.png`), image.toPNG());
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

    // 正在跑的时候连续再输入两句
    await delay(800);
    // 句子必须无歧义，否则模型会去追问「你说的第一条是什么」，
    // 转成 ask_user_question 交互，把流程弄乱
    note(`第二句: ${await win.webContents.executeJavaScript(typeAndEnter('回复：收到第一条'))}`);
    await delay(300);
    note(`第三句: ${await win.webContents.executeJavaScript(typeAndEnter('回复：收到第二条'))}`);

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
    const image = await win.webContents.capturePage();
    await fs.writeFile(path.join(outDir, `${name}.png`), image.toPNG());
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
