/**
 * Electron 主进程。
 *
 * 三条边界原则：
 *   1. 渲染进程拿不到 node / fs / child_process —— 只走 preload 白名单
 *   2. 宿主对象只活在主进程，渲染层看到的是可结构化克隆的纯数据
 *   3. 事件用单向推送（webContents.send），请求用 invoke —— 不混用
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { HostRuntime, configFromEnv } from './hostRuntime.js';
import { readSettings, writeSettings, hasStoredKey, encryptionAvailable, settingsFilePath } from './settingsStore.js';
import { loadWindowState, saveWindowState } from './windowState.js';
import { migrateLegacyUserData } from './migrateUserData.js';
import { notifyTurnFinished } from './notifications.js';
import {
  IPC,
  type ApproveInput,
  type BootstrapResult,
  type ExtraDirs,
  type PermissionModeChoice,
  type SendInput,
  type SettingsInput,
  type SettingsState,
  type TestResult,
} from '../src/shared/ipc.js';

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

let win: BrowserWindow | null = null;
let runtime: HostRuntime | null = null;

/** 把数据库行映射成渲染层的 UiMessage */
/**
 * 行 → UI 消息，并把图片路径读成 data URI。
 *
 * 库里只存路径（不存 base64），所以回显历史时需要在这里读回来。
 * 图片文件可能已经被清掉，读不到就不带图，不能让一条历史消息把整页弄崩。
 */
async function mapRowsToUi(
  rows: Array<{
    id: string;
    role: string;
    content: unknown;
    toolUseId?: string | null;
  }>,
): Promise<Array<import('../src/shared/ipc.js').UiMessage>> {
  return Promise.all(
    rows.map(async (row) => {
      const ui = rowToUiMessage(row);
      if (ui.role !== 'user' && ui.role !== 'user_steer') return ui;

      let c: Record<string, unknown>;
      try {
        c = typeof row.content === 'string' ? JSON.parse(row.content) : (row.content as never);
      } catch {
        return ui;
      }
      const entries = Array.isArray(c?.images) ? (c.images as Array<{ path?: string }>) : [];
      if (entries.length === 0) return ui;

      const dataUrls: string[] = [];
      for (const entry of entries) {
        if (typeof entry?.path !== 'string') continue;
        try {
          const buf = await fs.readFile(entry.path);
          const mime =
            buf[0] === 0x89 && buf[1] === 0x50
              ? 'image/png'
              : buf[0] === 0xff && buf[1] === 0xd8
                ? 'image/jpeg'
                : buf.toString('ascii', 0, 4) === 'GIF8'
                  ? 'image/gif'
                  : 'image/webp';
          dataUrls.push(`data:${mime};base64,${buf.toString('base64')}`);
        } catch {
          // 文件没了就跳过
        }
      }
      return dataUrls.length > 0 ? { ...ui, images: dataUrls } : ui;
    }),
  );
}

function rowToUiMessage(row: {
  id: string;
  role: string;
  content: unknown;
  toolUseId?: string | null;
}): import('../src/shared/ipc.js').UiMessage {
  let c: Record<string, unknown> = {};
  try {
    c = typeof row.content === 'string' ? JSON.parse(row.content) : (row.content as never);
  } catch {
    c = { text: String(row.content) };
  }

  const role = row.role as
    | 'user'
    | 'user_steer'
    | 'assistant'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'error'
    | 'compact_boundary';
  const base = { id: row.id, role };

  switch (role) {
    case 'user':
    case 'user_steer':
    case 'assistant':
    case 'thinking':
      return { ...base, text: String(c?.text ?? '') };    case 'tool_use':
      return {
        ...base,
        toolName: String(c?.toolName ?? '?'),
        toolUseId: String(c?.toolUseId ?? row.toolUseId ?? ''),
        input: c?.input,
      };
    case 'tool_result':
      return {
        ...base,
        toolUseId: String(c?.toolUseId ?? row.toolUseId ?? ''),
        output: String(c?.fullText ?? c?.summary ?? ''),
        isError: c?.isError === true,
      };
    case 'error':
      return { ...base, text: String(c?.message ?? '未知错误'), isError: true };
    case 'compact_boundary':
      return {
        ...base,
        compact: {
          trigger: c?.trigger === 'manual' ? 'manual' : 'auto',
          preTokens: typeof c?.preTokens === 'number' ? c.preTokens : null,
          postTokens: typeof c?.postTokens === 'number' ? c.postTokens : null,
        },
      };
    default:
      return { ...base, text: String(c?.text ?? '') };
  }
}

async function bootstrap(): Promise<BootstrapResult> {
  const rt = runtime!;
  const sessionId = await rt.ensureSession();
  const sessions = await rt.listSessions();
  const rows = rt.messageRows(sessionId);
  return {
    sessions,
    activeSessionId: sessionId,
    messages: await mapRowsToUi(rows),
    interruptedTurns: rt.interruptedTurns(),
    model: rt.currentModel(),
  };
}

function registerIpc(): void {
  ipcMain.handle(IPC.bootstrap, async () => bootstrap());

  ipcMain.handle(IPC.createSession, async (): Promise<BootstrapResult> => {
    const rt = runtime!;
    const id = await rt.createSession();
    const sessions = await rt.listSessions();
    return {
      sessions,
      activeSessionId: id,
      messages: [],
      interruptedTurns: rt.interruptedTurns(),
      model: rt.currentModel(),
    };
  });

  ipcMain.handle(IPC.loadSession, async (_e, sessionId: string) => {
    const rt = runtime!;
    await rt.resume(sessionId);
    return mapRowsToUi(rt.messageRows(sessionId));
  });

  ipcMain.handle(IPC.send, async (_e, input: SendInput) => {
    // 不 await：一轮可能跑几分钟，渲染层靠事件流更新
    void runtime!.send(input.sessionId, input.text, { images: input.images }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      win?.webContents.send(IPC.event, { type: 'error', message });
    });
  });

  ipcMain.handle(IPC.approve, async (_e, input: ApproveInput) => {
    runtime!.approve(input.requestId, input.behavior, {
      answers: input.answers,
      remember: input.remember,
    });
  });

  ipcMain.handle(IPC.cancel, async (_e, sessionId: string) => {
    await runtime!.cancel(sessionId);
  });

  ipcMain.handle(IPC.resumeTurn, async (_e, turnId: string) => {
    // 和 send 一样不 await：续跑本质上就是发一轮新的，靠事件流驱动 UI
    void runtime!.resumeTurn(turnId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      win?.webContents.send(IPC.event, { type: 'error', message });
    });
  });

  ipcMain.handle(IPC.dismissTurn, async (_e, turnId: string) => {
    runtime!.dismissTurn(turnId);
  });

  ipcMain.handle(IPC.compact, async (_e, sessionId: string) => {
    return runtime!.compact(sessionId);
  });

  ipcMain.handle(IPC.steer, async (_e, sessionId: string, text: string) => {
    return runtime!.steer(sessionId, text);
  });

  ipcMain.handle(IPC.contextUsage, async (_e, sessionId: string) => {
    return runtime!.contextUsage(sessionId);
  });

  ipcMain.handle(IPC.setPermissionMode, async (_e, sessionId: string, mode: PermissionModeChoice) => {
    return runtime!.setPermissionMode(sessionId, mode);
  });

  ipcMain.handle(IPC.setPlanMode, async (_e, sessionId: string, enabled: boolean) => {
    return runtime!.setPlanMode(sessionId, enabled);
  });

  ipcMain.handle(IPC.readModes, async (_e, sessionId: string) => {
    return runtime!.readModes(sessionId);
  });

  ipcMain.handle(IPC.setEffort, async (_e, sessionId: string, effort: string) => {
    return runtime!.setEffort(sessionId, effort);
  });

  ipcMain.handle(IPC.listModels, async () => runtime!.listModels());

  ipcMain.handle(IPC.switchModel, async (_e, sessionId: string, modelId: string) => {
    return runtime!.switchModel(sessionId, modelId);
  });

  ipcMain.handle(IPC.exportHtml, async (_e, sessionId: string) => {
    const filePath = await runtime!.exportHtml(sessionId);
    // 导完直接在系统文件管理器里选中它 —— 导出了却找不到等于没导
    shell.showItemInFolder(filePath);
    return filePath;
  });

  ipcMain.handle(IPC.listTasks, async (_e, sessionId: string) => {
    return runtime!.listTasks(sessionId);
  });

  ipcMain.handle(IPC.sessionTree, async (_e, sessionId: string) => {
    return runtime!.sessionTree(sessionId);
  });

  ipcMain.handle(IPC.navigateTree, async (_e, sessionId: string, entryId: string, turnIndex?: number) => {
    return runtime!.navigateTree(sessionId, entryId, turnIndex);
  });

  ipcMain.handle(IPC.stopTask, async (_e, sessionId: string, taskId: string) => {
    return runtime!.stopTask(sessionId, taskId);
  });

  ipcMain.handle(IPC.readExtraDirs, async (_e, sessionId: string) => {
    return runtime!.readExtraDirs(sessionId);
  });

  ipcMain.handle(IPC.setExtraDirs, async (_e, sessionId: string, dirs: ExtraDirs) => {
    return runtime!.setExtraDirs(sessionId, dirs);
  });

  ipcMain.handle(IPC.pickDir, async () => {
    if (!win) return null;
    // 用系统对话框而不是让用户手打路径：跨平台路径差异很容易写错
    const picked = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择一个目录',
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.readSettings, async (): Promise<SettingsState> => {
    const saved = await readSettings();
    const { hasKey, encrypted } = await hasStoredKey();
    const envKey = process.env.APP_PI_API_KEY?.trim();
    return {
      hasKey: Boolean(envKey) || hasKey,
      keyEncrypted: encrypted,
      encryptionAvailable: encryptionAvailable(),
      keySource: envKey ? 'env' : hasKey ? 'file' : 'none',
      model: configFromEnv(saved).model,
      endpoint: configFromEnv(saved).endpoint,
      api: configFromEnv(saved).api,
      contextWindow: configFromEnv(saved).contextWindow,
      models: saved.models ?? '',
      efforts: saved.efforts ?? '',
      approval: configFromEnv(saved).approval,
      workDir: configFromEnv(saved).workDir,
      settingsPath: settingsFilePath(),
    };
  });

  ipcMain.handle(IPC.saveSettings, async (_e, input: SettingsInput) => {
    const result = await writeSettings(input);
    // 不进 process.env 同步：重启后才生效，避免运行中的会话拿到半新半旧的配置
    return result;
  });

  ipcMain.handle(
    IPC.testSettings,
    async (_e, input: SettingsInput): Promise<TestResult> => {
      const startedAt = Date.now();
      const saved = await readSettings();
      const key = input.apiKey?.trim() || process.env.APP_PI_API_KEY?.trim() || saved.apiKey?.trim();
      const endpoint = input.endpoint?.trim() || saved.endpoint || configFromEnv().endpoint;
      const model = input.model?.trim() || saved.model || configFromEnv().model;

      if (!key) {
        return { ok: false, message: '还没填 API Key', elapsedMs: Date.now() - startedAt };
      }

      // 只验「能不能带这个 key 拿到模型列表」，不真跑一轮对话：
      // 测试要快，而发一轮动辄几秒、还会计费。
      try {
        const resp = await fetch(`${endpoint.replace(/\/$/, '')}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        });
        const elapsedMs = Date.now() - startedAt;
        if (resp.ok) {
          return { ok: true, message: `连接正常（${model}）`, elapsedMs };
        }
        // 401/403 说明 key 不对；其它状态码说明地址可能写错
        const detail = resp.status === 401 || resp.status === 403
          ? 'Key 无效或没权限'
          : `端点返回 ${resp.status}`;
        return { ok: false, message: detail, elapsedMs };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - startedAt,
        };
      }
    },
  );

  ipcMain.handle(IPC.renameSession, async (_e, sessionId: string, title: string) => {
    runtime!.renameSession(sessionId, title);
  });

  ipcMain.handle(IPC.pinSession, async (_e, sessionId: string, pinned: boolean) => {
    runtime!.setSessionPinned(sessionId, pinned);
  });

  ipcMain.handle(IPC.archiveSession, async (_e, sessionId: string) => {
    runtime!.archiveSession(sessionId);
  });

  ipcMain.handle(IPC.unarchiveSession, async (_e, sessionId: string) => {
    runtime!.unarchiveSession(sessionId);
  });

  ipcMain.handle(IPC.listArchived, async () => runtime!.listArchivedSessions());

  ipcMain.handle(IPC.deleteSession, async (_e, sessionId: string) => {
    runtime!.deleteSession(sessionId);
  });

  ipcMain.handle(IPC.listSessions, async () => runtime!.listSessions());

  /* ---- ORCA ---- */
  ipcMain.handle(IPC.listWorkers, async (_e, leadSessionId: string) =>
    runtime!.listWorkers(leadSessionId),
  );

  ipcMain.handle(
    IPC.createWorker,
    async (_e, leadSessionId: string, config: { role: string; label?: string; isolate?: boolean }) =>
      runtime!.createWorker(leadSessionId, config),
  );

  ipcMain.handle(IPC.removeWorker, async (_e, workerId: string) => {
    runtime!.removeWorker(workerId);
  });

  ipcMain.handle(
    IPC.setWorkerIsolation,
    async (_e, workerId: string, isolated: boolean) =>
      runtime!.setWorkerIsolation(workerId, isolated),
  );

  ipcMain.handle(IPC.orcaRoleOf, async (_e, sessionId: string) => runtime!.orcaRoleOf(sessionId));

  ipcMain.handle(IPC.restartApp, async () => {
    // 配置只在启动时读一次，重启是最简单可靠的生效方式
    app.relaunch();
    app.exit(0);
  });

  // 只在自动化验收时开的后门：伪造一条穿透引擎的压缩边界。
  // pi 的手动压缩有内置下限，小会话永远 noop，用真实 API 堆到那个量级不经济；
  // 而我们要验的「事件→落库→渲染」那半条链路，能用一个真实事件完整跑一遍。
  if (process.env.APP_AUTOTEST && process.env.APP_AUTOTEST !== '0') {
    ipcMain.handle('host:__inject-compact-boundary', async (_e, sessionId: string) => {
      runtime!.injectCompactBoundary(sessionId, {
        trigger: 'manual',
        preTokens: 12_345,
        postTokens: 2_100,
      });
    });
  }
}

async function createWindow(): Promise<void> {
  // 恢复上次的尺寸与位置（已校验过是否还在屏幕上）
  const saved = await loadWindowState();
  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 720,
    minHeight: 520,
    // 与 tokens.css 的 --surface 一致：#f2f2ed。
    // 写死的理由：这个值在页面加载前就要用，读不到 CSS 变量。
    backgroundColor: '#f2f2ed',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      // 三件套：不给 node、隔离上下文、沙箱
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 外链一律交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
  }

  if (saved.maximized) win.maximize();

  // 关窗前保存尺寸。
  // 用 'close' 而不是 'closed'：'closed' 时窗口已经销毁，拿不到 bounds。
  win.on('close', () => {
    if (win) void saveWindowState(win);
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  // 打包后的环境：pi 二进制随包发、数据目录落到 userData
  if (app.isPackaged) {
    process.env.APP_PI_BINARY ??= path.join(
      process.resourcesPath,
      'pi-bin',
      process.platform === 'win32' ? 'pi.exe' : 'pi',
    );
    process.env.APP_DATA_DIR ??= app.getPath('userData');
  } else {
    /*
     * 开发时也要用**固定**目录。
     * 之前走 temp 兜底，看起来没问题 —— 但 temp 目录重启就没了，
     * 开发时对话和配置全都会丢，而且不报错，很容易误以为存了。
     */
    process.env.APP_DATA_DIR ??= path.join(app.getPath('userData'), 'dev-data');
  }

  // 改名后 userData 目录变了（Spike Agent → Juno）。
  // 必须在读设置之前搬，否则会读到一个空目录，用户看起来像被重置了。
  if (app.isPackaged) await migrateLegacyUserData();

  // 读本地设置。key 存在这里时注入 process.env，
  // 因为底层 auth adapter 只认环境变量 —— 与其改整条链路，不如在入口对齐。
  // 环境变量已存在时不覆盖（CI / 脚本注入优先）。
  const settings = await readSettings();
  if (settings.apiKey && !process.env.APP_PI_API_KEY) {
    process.env.APP_PI_API_KEY = settings.apiKey;
  }

  runtime = new HostRuntime({
    ...configFromEnv(settings),
    // 导出的 HTML 落到用户能找到的地方（文档目录），而不是 app 数据目录深处
    exportDir: process.env.APP_EXPORT_DIR ?? path.join(app.getPath('documents'), 'Agent 导出'),
  });
  await runtime.init();

  // 宿主事件 → 一条通道单向推给渲染层
  /**
   * 当前正在看的会话。由渲染层上报 ——
   * 「当前会话」是 UI 概念，宿主自己猜不准（用户可能切走又切回）。
   */
  let currentSessionId: string | null = null;
  /** 每个会话最近一段助手输出，用作通知摘要 */
  const lastTextBySession = new Map<string, string>();
  /** turnId → sessionId。text 事件只带 turnId，靠这张表找回会话归属 */
  const sessionByTurn = new Map<string, string>();

  // 宿主事件 → 一条通道单向推给渲染层，顺带判断要不要发系统通知
  runtime.onEvent((event) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.event, event);

    // 记住 turn 与会话的对应关系
    if (event.type === 'turn') sessionByTurn.set(event.turnId, event.sessionId);

    // 攒摘要：final 的那段 text 就是这轮回复的全文
    if (event.type === 'text' && event.isFinal) {
      const sid = sessionByTurn.get(event.turnId);
      if (sid) lastTextBySession.set(sid, event.text);
    }

    // 轮收口时考虑发通知
    if (event.type === 'turn' && event.state !== 'running') {
      const title = runtime!.sessionTitle(event.sessionId) ?? '会话';
      const preview = lastTextBySession.get(event.sessionId) ?? '';
      notifyTurnFinished(
        win,
        {
          sessionId: event.sessionId,
          title,
          preview,
          state: event.state === 'error' ? 'error' : 'done',
        },
        event.sessionId === currentSessionId,
        (sessionId) => {
          // 点通知 → 让界面切过去
          if (win && !win.isDestroyed()) win.webContents.send(IPC.focusSession, sessionId);
        },
      );
      lastTextBySession.delete(event.sessionId);
      sessionByTurn.delete(event.turnId);
    }
  });

  ipcMain.handle(IPC.setCurrentSession, async (_e, sessionId: string | null) => {
    currentSessionId = sessionId;
  });

  registerIpc();
  await createWindow();

  // 自动化验收：只在显式开启时挂上，不影响正常启动
  //   APP_AUTOTEST=1          → 开一轮真实对话并截图
  //   APP_AUTOTEST=resume     → 验中断续跑
  //   APP_AUTOTEST=permission → 验权限记忆规则
  //   APP_AUTOTEST=queue      → 验输入队列
  //   APP_AUTOTEST=compact    → 验上下文压缩
  //   APP_AUTOTEST=steer      → 验插话与上下文占用
  //   APP_AUTOTEST=diff       → 验本轮改动面板
  //   APP_AUTOTEST=mode       → 验权限档位与计划模式
  //   APP_AUTOTEST=model      → 验模型热切换（需 APP_MODELS 配两个）
  //   APP_AUTOTEST=export     → 验导出 HTML
  //   APP_AUTOTEST=task       → 验子任务进度
  //   APP_AUTOTEST=dirs       → 验额外工作目录
  //   APP_AUTOTEST=tree       → 验会话分支树
  //   APP_AUTOTEST=image      → 验图片输入
  //   APP_AUTOTEST=rewind     → 验文件回滚
  //   APP_AUTOTEST=status     → 验状态行
  //   APP_AUTOTEST=settings   → 验配置持久化（需不带 APP_PI_API_KEY 启动）
  const mode = process.env.APP_AUTOTEST;
  if (mode && mode !== '0' && win) {
    const { runAutotest, runResumeTest, runPermissionTest, runQueueTest, runCompactTest, runSteerTest, runDiffTest, runModeTest, runModelTest, runExportTest, runTaskTest, runExtraDirsTest, runTreeTest, runImageTest, runRewindTest, runStatusTest, runSettingsTest, runRestartTest, runErrorBoundaryTest, runWatchdogTest, runWindowStateTest, runSessionOrgTest, runParallelTest, runNotifyTest, runEventRoutingTest, runLiveViewTest, runOrcaDataTest, runOrcaIsolationTest, runOrcaUiTest, runOrcaToolsTest, runToolProbe, runCodeBlockTest, runMarkdownTest } =
      await import('./autotest.js');
    void (
      mode === 'resume'
        ? runResumeTest(win, runtime)
        : mode === 'permission'
          ? runPermissionTest(win, runtime)
          : mode === 'queue'
            ? runQueueTest(win, runtime)
            : mode === 'compact'
              ? runCompactTest(win, runtime)
              : mode === 'steer'
                ? runSteerTest(win, runtime)
                : mode === 'diff'
                  ? runDiffTest(win, runtime)
                  : mode === 'mode'
                    ? runModeTest(win, runtime)
                    : mode === 'model'
                      ? runModelTest(win, runtime)
                      : mode === 'export'
                        ? runExportTest(win, runtime)
                        : mode === 'task'
                          ? runTaskTest(win, runtime)
                          : mode === 'dirs'
                            ? runExtraDirsTest(win, runtime)
                            : mode === 'tree'
                              ? runTreeTest(win, runtime)
                              : mode === 'image'
                                ? runImageTest(win, runtime)
                                : mode === 'rewind'
                                  ? runRewindTest(win, runtime)
                                  : mode === 'status'
                                    ? runStatusTest(win, runtime)
                                    : mode === 'settings'
                                      ? runSettingsTest(win, runtime)
                                      : mode === 'restart'
                                        ? runRestartTest(win, runtime)
                                      : mode === 'error'
                                        ? runErrorBoundaryTest(win, runtime)
                                      : mode === 'watchdog'
                                        ? runWatchdogTest(win, runtime)
                                      : mode === 'window'
                                        ? runWindowStateTest(win, runtime)
                                      : mode === 'session'
                                        ? runSessionOrgTest(win, runtime)
                                      : mode === 'parallel'
                                        ? runParallelTest(win, runtime)
                                      : mode === 'notify'
                                        ? runNotifyTest(win, runtime)
                                      : mode === 'routing'
                                        ? runEventRoutingTest(win, runtime)
                                      : mode === 'live'
                                        ? runLiveViewTest(win, runtime)
                                      : mode === 'orca'
                                        ? runOrcaDataTest(win, runtime)
                                      : mode === 'orca-iso'
                                        ? runOrcaIsolationTest(win, runtime)
                                      : mode === 'orca-ui'
                                        ? runOrcaUiTest(win, runtime)
                                      : mode === 'orca-tools'
                                        ? runOrcaToolsTest(win, runtime)
                                      : mode === 'probe'
                                        ? runToolProbe(win, runtime)
                                      : mode === 'codeblock'
                                        ? runCodeBlockTest(win, runtime)
                                      : mode === 'md'
                                        ? runMarkdownTest(win, runtime)
                                      : runAutotest(win, runtime)
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前必须收掉 pi 子进程，否则会留下孤儿
app.on('before-quit', (event) => {
  if (!runtime) return;
  event.preventDefault();
  const rt = runtime;
  runtime = null;
  void rt.shutdown().finally(() => app.quit());
});
