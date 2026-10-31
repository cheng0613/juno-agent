/**
 * @juno/host-core —— 宿主运行时
 *
 * 把「把 maker-core 跑起来」这件事从具体入口里剥离出来，
 * 让 CLI（apps/spike）和桌面端（apps/desktop）共用同一套：
 *   - AuthAdapter / PiAgent 装配
 *   - SQLite 数据层
 *   - AgentEvent → 数据库 的落库胶水
 *   - 审批通道
 *
 * 与具体 UI 无关。渲染层只通过 IPC 看到下面这些类型。
 */
export * from './host.js';
export * from './recorder.js';
export * from './approval.js';

export * from './db/open.js';
export * from './db/schema.js';
export * from './db/sqliteSessionStorage.js';
export * from './db/messageStore.js';
export * from './db/turnStore.js';
export * from './db/permissionStore.js';
