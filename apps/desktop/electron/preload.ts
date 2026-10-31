/**
 * Preload —— 唯一的桥。
 *
 * 这里刻意只暴露 8 个方法 + 1 个事件订阅，且全部是显式白名单。
 * 渲染层拿不到 ipcRenderer 本体，所以不能自己拼通道名去调任意 handler。
 *
 * 注意：sandbox 开启时 preload 必须是 CJS，且只能用 `electron` 里
 * 被沙箱允许的那部分 API（contextBridge / ipcRenderer 恰好够用）。
 */
import { contextBridge, ipcRenderer } from 'electron';

import { IPC, type HostBridge, type HostEvent } from '../src/shared/ipc.js';

const bridge: HostBridge = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  createSession: () => ipcRenderer.invoke(IPC.createSession),
  loadSession: (sessionId) => ipcRenderer.invoke(IPC.loadSession, sessionId),
  send: (input) => ipcRenderer.invoke(IPC.send, input),
  approve: (input) => ipcRenderer.invoke(IPC.approve, input),
  cancel: (sessionId) => ipcRenderer.invoke(IPC.cancel, sessionId),
  resumeTurn: (turnId) => ipcRenderer.invoke(IPC.resumeTurn, turnId),
  dismissTurn: (turnId) => ipcRenderer.invoke(IPC.dismissTurn, turnId),
  compact: (sessionId) => ipcRenderer.invoke(IPC.compact, sessionId),
  steer: (sessionId, text) => ipcRenderer.invoke(IPC.steer, sessionId, text),
  contextUsage: (sessionId) => ipcRenderer.invoke(IPC.contextUsage, sessionId),
  setPermissionMode: (sessionId, mode) =>
    ipcRenderer.invoke(IPC.setPermissionMode, sessionId, mode),
  setPlanMode: (sessionId, enabled) => ipcRenderer.invoke(IPC.setPlanMode, sessionId, enabled),
  readModes: (sessionId) => ipcRenderer.invoke(IPC.readModes, sessionId),
  setEffort: (sessionId, effort) => ipcRenderer.invoke(IPC.setEffort, sessionId, effort),
  listModels: () => ipcRenderer.invoke(IPC.listModels),
  switchModel: (sessionId, modelId) => ipcRenderer.invoke(IPC.switchModel, sessionId, modelId),
  exportHtml: (sessionId) => ipcRenderer.invoke(IPC.exportHtml, sessionId),
  listTasks: (sessionId) => ipcRenderer.invoke(IPC.listTasks, sessionId),
  stopTask: (sessionId, taskId) => ipcRenderer.invoke(IPC.stopTask, sessionId, taskId),
  readExtraDirs: (sessionId) => ipcRenderer.invoke(IPC.readExtraDirs, sessionId),
  setExtraDirs: (sessionId, dirs) => ipcRenderer.invoke(IPC.setExtraDirs, sessionId, dirs),
  pickDir: () => ipcRenderer.invoke(IPC.pickDir),
  readSettings: () => ipcRenderer.invoke(IPC.readSettings),
  saveSettings: (input) => ipcRenderer.invoke(IPC.saveSettings, input),
  testSettings: (input) => ipcRenderer.invoke(IPC.testSettings, input),
  restartApp: () => ipcRenderer.invoke(IPC.restartApp),
  renameSession: (sessionId, title) => ipcRenderer.invoke(IPC.renameSession, sessionId, title),
  pinSession: (sessionId, pinned) => ipcRenderer.invoke(IPC.pinSession, sessionId, pinned),
  archiveSession: (sessionId) => ipcRenderer.invoke(IPC.archiveSession, sessionId),
  unarchiveSession: (sessionId) => ipcRenderer.invoke(IPC.unarchiveSession, sessionId),
  listArchived: () => ipcRenderer.invoke(IPC.listArchived),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  listWorkers: (leadSessionId) => ipcRenderer.invoke(IPC.listWorkers, leadSessionId),
  createWorker: (leadSessionId, config) =>
    ipcRenderer.invoke(IPC.createWorker, leadSessionId, config),
  removeWorker: (workerId) => ipcRenderer.invoke(IPC.removeWorker, workerId),
  setWorkerIsolation: (workerId, isolated) =>
    ipcRenderer.invoke(IPC.setWorkerIsolation, workerId, isolated),
  orcaRoleOf: (sessionId) => ipcRenderer.invoke(IPC.orcaRoleOf, sessionId),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  setCurrentSession: (sessionId) => ipcRenderer.invoke(IPC.setCurrentSession, sessionId),
  onFocusSession: (listener) => {
    const handler = (_e: unknown, sessionId: string) => listener(sessionId);
    ipcRenderer.on(IPC.focusSession, handler);
    return () => ipcRenderer.removeListener(IPC.focusSession, handler);
  },
  sessionTree: (sessionId) => ipcRenderer.invoke(IPC.sessionTree, sessionId),
  navigateTree: (sessionId, entryId, turnIndex) =>
    ipcRenderer.invoke(IPC.navigateTree, sessionId, entryId, turnIndex),

  onEvent: (listener) => {
    // 只把 payload 交给渲染层，不暴露 event 对象（含 sender 等能力）
    const handler = (_e: unknown, payload: HostEvent) => listener(payload);
    ipcRenderer.on(IPC.event, handler);
    return () => {
      ipcRenderer.removeListener(IPC.event, handler);
    };
  },
};

contextBridge.exposeInMainWorld('host', bridge);

// 验收专用后门：只在主进程开了 APP_AUTOTEST 时存在（否则 handle 不存在，调用会抛）
if (process.env.APP_AUTOTEST && process.env.APP_AUTOTEST !== '0') {
  contextBridge.exposeInMainWorld('__autotestInject', {
    compactBoundary: (sessionId: string) =>
      ipcRenderer.invoke('host:__inject-compact-boundary', sessionId),
  });
}
