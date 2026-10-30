# Phase 3 报告 · Electron 外壳与对话 UI

> 日期：2026-10-30
> 目标：把 Phase 2 验证过的引擎 + 数据层，装进真正的桌面外壳，跑出可用的对话界面。
> 结论：**完成。进程启动、IPC、会话创建、pi 子进程全部实测通过。**

---

## 1. 交付物

```
spike-host/
├── design/                          ← Phase 2.5 产出的 design tokens
│   ├── tokens.css                   93 个变量，唯一来源
│   └── preview.html                 自包含预览
├── packages/
│   ├── maker-core/ 等 4 个           ← vendored，零改动
│   └── host-core/                   ← 新增：宿主运行时（CLI 与桌面共用）
│       └── src/{host,recorder,approval,db/*,index}.ts
├── apps/
│   ├── spike/                       ← Phase 1/2 的 CLI，改为依赖 host-core
│   └── desktop/                     ← 本期新增
│       ├── electron/main.ts         主进程：窗口 + IPC handler
│       ├── electron/preload.ts      contextBridge 白名单
│       ├── electron/hostRuntime.ts  宿主对象（不认识 Electron，可单测）
│       ├── src/shared/ipc.ts        主/渲染唯一契约
│       ├── src/App.tsx              外壳：侧边栏 + 消息区 + 输入 + 审批
│       ├── src/Chat.tsx             消息渲染 + 工具卡片
│       ├── src/devMock.ts           无 Electron 时的假宿主
│       └── src/styles/app.css       全部样式走 tokens
```

`apps/spike` 的数据层被抽到 `packages/host-core` 后，6/6 自检仍然通过 —— 这次重构没有改变行为。

---

## 2. 进程与权限边界

这是桌面端最容易做错的地方，本期按三条硬约束来：

| 约束 | 做法 |
|---|---|
| 渲染进程拿不到 Node | `nodeIntegration: false` |
| 上下文隔离 | `contextIsolation: true` |
| 沙箱 | `sandbox: true` |

代价是 preload 必须是 **CJS**，且只能用沙箱允许的那部分 `electron` API。
所以构建分两次：主进程 ESM、preload CJS。

```ts
// electron/main.ts
webPreferences: {
  preload: path.join(import.meta.dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

**preload 只暴露 6 个方法 + 1 个订阅**，且通道名是显式白名单。渲染层拿不到 `ipcRenderer` 本体，所以不可能自己拼通道名去调任意 handler。

另外 `setWindowOpenHandler` 把所有外链交给系统浏览器 —— 否则一个 `target=_blank` 就能在应用内开出无沙箱窗口。

---

## 3. IPC 契约

`src/shared/ipc.ts` 被两边同时引用，所以只放纯常量和类型，不 import 任何 node/electron 模块。

```
渲染 → 主（invoke）         主 → 渲染（send，单向）
─────────────────           ──────────────────────
host:bootstrap              host:event
host:create-session           ├ text / thinking
host:load-session             ├ tool_use / tool_result
host:send                     ├ turn
host:approve                  ├ approval / approval_settled
host:cancel                   └ error
```

请求用 `invoke`、事件用单向推送，两者不混用。

`host:send` 主进程**不 await** —— 一轮可能跑几分钟，渲染层靠事件流更新；错误通过 `host:event` 的 `error` 类型回传。

---

## 4. 事件 → UI 的两条路径

这里有个容易埋雷的地方：流式增量和权威历史是两条不同的数据源。

- **增量（text / thinking）**：只在内存里累加，给 UI 显示流式效果
- **终态**：`turn` 事件收口时，**重新从数据库拉一次** `loadSession`

为什么要重拉：流式拼接的文本 id 是临时的，工具调用顺序也可能与落库不一致。收口时以数据库为准，UI 和持久化才不会漂移。

```tsx
case 'turn': {
  if (event.state === 'running') { setRunning(true); return; }
  setRunning(false);
  const rows = await host.loadSession(activeId);   // ← 权威
  setMessages(rows);
}
```

---

## 5. 审批弹层

Phase 2 发现「不挂审批通道 → 所有写操作被静默拒绝」，所以这一版把审批做成了**模态弹层**，而不是事后 toast：

```
agent 要执行 tools → HostRuntime.askRenderer() 挂起 Promise
  → emit { type:'approval' }
  → 渲染层弹卡片（命令原文 + 拒绝/允许）
  → host.approve({ requestId, behavior })
  → 解挂 Promise → agent 继续
```

`hostRuntime.ts` 里用 `pending: Map<requestId, resolve>` 保存挂起的 Promise，这是整个审批链的关键。

审批卡片只传裁剪过的字段（`safeInput`：只保留 string/number/boolean，字符串截到 800 字），不把整包工具入参过 IPC。

---

## 6. 实测证据

### 6.1 构建

```
dist-electron\main.js        1.5mb   (含 maker-core)
dist-electron\preload.cjs    1.5kb
dist\                        渲染层
```

### 6.2 启动冒烟（`node scripts/smoke.mjs`）

```
  ✓ host ready
  ✓ pi binary
  · error              ← 无错误

[host] Maker initialized {"agents":["pi"],"makerMemory":false}
[host] host ready {"model":"deepseek-v4.1-flash-1017","api":"openai-completions"}
[host] createSession ↓ ...
[host/pi] pi-spawn    status=ok  durationMs=11
[host/pi] rpc-ready   status=ok  durationMs=878
[host] createSession ↑ sdkSessionId=...jsonl  elapsedMs=911
```

主进程、窗口、preload、IPC、pi 子进程全部打通，渲染层成功调用 `host:bootstrap`。

### 6.3 真实 GUI 端到端（`APP_AUTOTEST=1 node scripts/launch.mjs`）

`electron/autotest.ts` 在真窗口里跑完整一轮，并在关键节点截图：

| 截图 | 内容 |
|---|---|
| `01-ready.png` | 空会话：侧边栏 + 空态 + 输入区，暖纸底生效 |
| `02-approval.png` | 审批弹层：`需要授权` 徽标 + 工具名 `bash` + 命令原文 `ls -la` + 拒绝/允许 |
| `03-answer.png` | 完整一轮：用户气泡 + 工具卡（绿点）+ 输出卡 + 回复 |
| `04-dark.png` | 深色主题下同一会话，全部反色正常 |

事件流（`result.json`）：

```
eventTypes: turn, tool_use, approval, approval_settled, tool_result, text
eventCount: 14
messages:   user → tool_use → tool_result → assistant   (4 行，符合预期)
```

**实机验证抓到一个 UI bug**：工具卡左边的状态圆点在结果返回后仍是灰色，因为 `ToolCard` 写死了 `dot pending`。
修法：在 `Chat` 里先建 `toolUseId → ok` 映射（结果可能晚于卡片到达），再传给卡片。修完绿点正常。

### 6.4 流式逐字（真实验证）

同一脚本追加一个纯文本任务（「从 1 数到 30，每个数字单独一行」），在首个增量到达后 300ms 抓中间帧：

```
12 段增量 / 80 字 / 首末跨度 326ms
时间线 (ms:字数)
0:1  15:6  42:6  46:7  75:9  83:9  98:9  146:9  255:9  260:9  289:6  326:80F
```

- **UI 在中途停在数字 25**（实际数到 30），证明是边生成边渲染
- 末段带 `isFinal` 且重发全文（字数为前 11 段之和）—— 这是引擎的收口语义，落库取 final，不会重复
- 落库共 6 行：`user → tool_use → tool_result → assistant → user → assistant`

排查过的一个假警报：中间帧里 30 个数字行距偏大，挖到库里发现原文就是单换行 `1\n2\n3`，`line-height: 1.6` × 15px 的正常结果，**不是渲染 bug**。

### 6.5 浏览器预览模式

`src/devMock.ts` 在没有 `window.host` 时自动接管，所以 `preview.html` 或 `vite preview` 都能直接看 UI、改样式，不需要启动 Electron。界面上会显示「预览模式」角标，不会误判成真实环境。

---

## 7. 踩到的 4 个坑

| 坑 | 现象 | 解法 |
|---|---|---|
| preload 要 CJS | sandbox 下 ESM preload 直接失效 | esbuild 单独出 `format: 'cjs'` → `preload.cjs` |
| CJS 依赖打进 ESM 会炸 | `Dynamic require of "fs" is not supported` | banner 注入 `createRequire`，让 gray-matter/parse5/diff 正常打包 |
| `@anthropic-ai/claude-agent-sdk` 找不到 | barrel export 让它变成运行时依赖 | 目前加为显式依赖；**正确解法见 §8** |
| `SessionMeta` 没有 `status` | 想在会话列表显示状态却取不到 | 上游刻意剔除（运行态不持久化），改为直接读自己 DB 的 `sessions.status` |

第 4 条正好印证了 Phase 2 抄下来的那条设计原则 —— **运行时瞬态不进 `SessionMeta`**。

---

## 8. 已知技术债

**① `@anthropic-ai/claude-agent-sdk` 是纯多余依赖（115MB）**

`maker-core` 的 barrel `src/index.ts` 会 eager 引入 claude-code agent，哪怕我们只用 pi。
Phase 1 已记录此事，现在它有真实代价了。

正确解法二选一：
- 给 maker-core 加子路径导出 `./maker`，让宿主从 `@cindy/maker-core/maker` 导入
- 或用 esbuild `alias` 把 claude-agent-sdk 替换成桩（需先确认 barrel 不实例化它）

**② 摘要/记忆等 pi 侧能力未接**

`pi project resource assembly snapshot: approval-resolver-unavailable` 仍会出现 —— 因为审批监听器是在 `createSession` 返回后才挂上的。工具调用发生在之后，功能不受影响，但首帧快照是「不可用」。

**③ 输入框未做多行自适应上限**

`field-sizing: content` + `max-height` 已加，但 Chromium 以外不生效，后续要补 JS 兜底。

**④ 没有打包/分发**

`electron-builder` 未接。当前只有 `node scripts/launch.mjs` 能起。

---

## 9. Phase 3 门禁判定

| 判据 | 结果 |
|---|---|
| 进程能起、窗口能开 | ✅ |
| 渲染层与宿主隔离（无 node 权限） | ✅ sandbox + contextIsolation |
| IPC 有白名单边界 | ✅ 6 方法 + 1 订阅 |
| 会话能创建、pi 能起 | ✅ 878ms rpc-ready |
| **流式逐字输出** | ✅ 12 段增量 / 326ms，中间帧停在数字 25 |
| **落库完整性** | ✅ 6 行：user·tool_use·tool_result·assistant·user·assistant |
| **审批弹层** | ✅ 命令原文展示，批准后 agent 继续 |
| **工具卡状态联动** | ✅ 灰→绿（修了一处写死） |
| 深/浅色双主题 | ✅ 反色正常 |
| 无 Electron 也能看 UI | ✅ devMock |

**→ 通过。**

---

## 10. 下一步

按价值排序：

1. **electron-builder 打包**，产出可安装包
2. 中断续跑 UI（后端已就绪，前端未接）
3. 多会话并行 / 会话标题自动生成
4. `cindy-ui` 风格富组件（图表、表格、可交互控件）
5. 输入队列持久化、FTS 全文搜索

—— `@anthropic-ai/claude-agent-sdk` 体积问题暂缓（用户决定先不动）。
