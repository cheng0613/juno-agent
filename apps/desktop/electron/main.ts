/**
 * Electron 主进程。
 *
 * 三条边界原则：
 *   1. 渲染进程拿不到 node / fs / child_process —— 只走 preload 白名单
 *   2. 宿主对象只活在主进程，渲染层看到的是可结构化克隆的纯数据
 *   3. 事件用单向推送（webContents.send），请求用 invoke —— 不混用
 */
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { HostRuntime, configFromEnv } from './hostRuntime.js';
import {
  IPC,
  type ApproveInput,
  type BootstrapResult,
  type PermissionModeChoice,
  type SendInput,
} from '../src/shared/ipc.js';

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

let win: BrowserWindow | null = null;
let runtime: HostRuntime | null = null;

/** 把数据库行映射成渲染层的 UiMessage */
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
      return { ...base, text: String(c?.text ?? '') };
    case 'tool_use':
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
    messages: rows.map(rowToUiMessage),
    interruptedTurns: rt.interruptedTurns(),
    model: configFromEnv().model,
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
      model: configFromEnv().model,
    };
  });

  ipcMain.handle(IPC.loadSession, async (_e, sessionId: string) => {
    const rt = runtime!;
    await rt.resume(sessionId);
    return rt.messageRows(sessionId).map(rowToUiMessage);
  });

  ipcMain.handle(IPC.send, async (_e, input: SendInput) => {
    // 不 await：一轮可能跑几分钟，渲染层靠事件流更新
    void runtime!.send(input.sessionId, input.text).catch((error: unknown) => {
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

  ipcMain.handle(IPC.cancel, async () => {
    await runtime!.cancel();
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
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#f4f4ef',
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
  }

  runtime = new HostRuntime({
    ...configFromEnv(),
    // 导出的 HTML 落到用户能找到的地方（文档目录），而不是 app 数据目录深处
    exportDir: process.env.APP_EXPORT_DIR ?? path.join(app.getPath('documents'), 'Agent 导出'),
  });
  await runtime.init();

  // 宿主事件 → 一条通道单向推给渲染层
  runtime.onEvent((event) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.event, event);
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
  const mode = process.env.APP_AUTOTEST;
  if (mode && mode !== '0' && win) {
    const { runAutotest, runResumeTest, runPermissionTest, runQueueTest, runCompactTest, runSteerTest, runDiffTest, runModeTest, runModelTest, runExportTest } =
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
