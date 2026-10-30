# Phase 22：卡住提示（看门狗）

D 类第二项。原本以为要自己造看门狗，动手前查了一下——**引擎早就有**，缺的是「让用户看得见」。

---

## 先查再动手：引擎已有完整看门狗

`packages/maker-core/src/session.ts`：

```ts
const DEFAULT_TURN_STALL_MS = 45 * 60_000;   // 45 分钟零事件才中止
```

而且做得比我自己写更细：

- **零事件才计时**（有事件就重置）
- **等用户回应时自动挂起**（权限询问 / AskUserQuestion 期间不算卡死）
- 中止后走 `abort()` 的恢复流程
- 可用 `turnStallMs` 选项或 `XDT_SESSION_TURN_STALL_MS` 覆盖

所以「永远转圈」不会真的永远——**但 45 分钟对用户来说等于永远**。这期间界面只有一 个转圈，没有任何「可能卡住了」的信号。

**结论：不重造看门狗，做两件事**——调短阈值 + 让等待可见。

---

## 一、阈值调短到 15 分钟

```ts
const stallMinutes = Number(process.env.APP_STALL_MINUTES ?? 15);
const turnStallMs = stallMinutes > 0 ? stallMinutes * 60_000 : 0;
```

通过 `createSession({ turnStallMs })` 传给引擎，两处建会话都传（新建 + resume）。

15 分钟的依据：一个正常的长任务（跑测试、装依赖）很少超过这个数；超过 15 分钟还没任何事件，基本可以判定链路死了。

`APP_STALL_MINUTES=0` 可以关掉。

---

## 二、界面提前提示「没有响应」

引擎在 15 分钟才动手，但用户在第 3 分钟就该知道「它可能卡了」。

状态行扩展两个字段：

```ts
interface TurnStatus {
  idleMs: number;        // 多久没收到事件
  stallAfterMs: number;  // 超过这个就提示
}
```

宿主记每次收到事件的时刻：

```ts
private projectStatus(event, turnId) {
  this.lastEventAt.set(turnId, Date.now());   // 任何事件都算「活着」
  ...
}
```

客户端把 `idleMs` 本地往后推（宿主只在有事件时推送，两次推送之间的空闲要自己累加），超过阈值时：

```
◜ 已经 3 分钟没有任何响应                    12m 05s · 8.2k tokens
```

- 文字从「正在执行命令…」变成「已经 N 分钟没有任何响应」
- **spinner 停下**并变警告色——一直转是在假装在跑
- 右侧时长变警告色

---

## 撞到的一个真设计缺陷

第一版直接把「超阈值」当卡住，测试用 5 秒阈值跑 `sleep 12`：

```
状态文字: "已经 6 秒没有任何响应"     ← 但命令正常在跑！
```

**`sleep 12` 期间本来就没有事件**——那是命令在正常工作，不是死机。按第一版的逻辑，任何超过阈值的命令都会被误报。

修法：跟踪「正在执行中的工具」：

```ts
private readonly runningTools = new Map<string, string>();  // turnId → toolUseId

// tool_use 时记上，tool_result_full 时清掉
stallAfterMs: toolRunning ? Number.POSITIVE_INFINITY : hintThreshold
```

有工具在跑就把阈值拉到无限——长命令、大文件读写都不该被当成卡死。

修复后同一个测试：

```
工具执行中: label="正在执行命令…" stalled=0
```

---

## 验收的边界：真卡住造不出来

模型不会无缘无故不响应，所以「真卡住」在测试里复现不了。

能验的、也真正有价值的是**不误报**：

```
工具执行中: label="正在执行命令…" stalled=0
```

即：一个 8 秒的命令跑在 5 秒阈值下，界面不该提示卡住。

而卡住时的显示逻辑（`formatIdle` 秒/分钟切换、`.status-spinner-stalled` 停转）是纯函数和静态样式，不依赖运行时，不需要集成测试。

**这个取舍要说清楚**：不是漏测，是这类「外部故障」在单机测试里没有可靠的注入点。

---

## 20 个模式全部通过

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/hostRuntime.ts` | `turnStallMs` 传引擎；`lastEventAt` / `runningTools` 跟踪 |
| `apps/desktop/src/StatusLine.tsx` | 无响应提示、spinner 停止、`formatIdle` |
| `apps/desktop/src/shared/ipc.ts` | `TurnStatus.idleMs` / `stallAfterMs` |
| `apps/desktop/src/styles/app.css` | `.status-spinner-stalled` |
| `apps/desktop/electron/autotest.ts` | `runWatchdogTest` |

## 已知限制

- **真卡住没有端到端验证**（见上）
- 提示阈值 180 秒是拍的，没经过真实使用校准
- 没有「中止这一轮」的按钮——用户看到「无响应」只能点停止（现有的 cancel）
- 工具执行中即使真卡死也不会提示（阈值被拉无限）；这是防误报的代价
- 引擎的 15 分钟中止没有 UI 反馈，用户只会看到轮突然结束

## D 类剩余

- **D8 窗口尺寸记忆**：每次打开固定大小
- D5 图标 / D6 签名 / D7 自动更新 / D9 干净机器验证
