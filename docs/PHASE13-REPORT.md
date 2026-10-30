# Phase 13：后台任务 / 子任务进度

A 类第七项。核心发现：**这个功能之前一直是空的，不是模型不愿拆活，是宿主少传了一个依赖。**

---

## 根因：缺 `spawnPiSubagentRunner`

探测脚本先跑了一轮「起后台任务」和一轮「拆子任务」，结果全是空：

```
listBackgroundTasks {"tasks":[]}
agent_task_update 次数 {"taskUpdates":0}
```

翻引擎源码才找到卡点：

```ts
const localSubagentSupported = Boolean(
  !reviewMode && !opts[LOCAL_AGENT_CLIENT]?.hostToolsOnly
  && !remote
  && this.deps.spawnPiSubagentRunner,   // ← 我们没有传
);
if (localSubagentSupported) {
  await writeFile(subagentExtensionPath, CINDY_SUBAGENT_EXTENSION_SOURCE);
  ...
}
```

没传这个依赖 → subagent 扩展根本不会被写入 → **模型连 subagent 工具都没有** → 后台任务列表永远是空的。

而且整套后台任务 API（`listBackgroundTasks` / `stopBackgroundTask` / `resumeBackgroundTask`）**全都绑在 subagent 上**，pi 没有独立的 bash 后台任务通道。

### 实现只有十几行

原本以为要自己做子进程生命周期管理、stdout 桥接、审批转发——实际看 `PiSubagentRunnerProcess` 接口，它就是 `ChildProcess` 的最小子集，输出走磁盘上的 `status.json`，不需要管道：

```ts
spawnPiSubagentRunner: (request) => spawn(process.execPath, [request.runnerFile, request.configFile], {
  cwd: request.cwd,
  env: { ...request.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'ignore',      // 输出走磁盘；管道不消费会在缓冲满时卡死子进程
  windowsHide: true,
})
```

**补上之后立刻生效**——模型马上把任务拆成 3 个并发跑起来，`agent_task_update` 持续推送进度。

`ELECTRON_RUN_AS_NODE=1` 是给打包后准备的：那时 `process.execPath` 指向 `electron.exe`，不加这个会当成开新窗口而不是跑脚本。

---

## 一个必须做的节流

引擎推 `agent_task_update` 的频率很高——实测同一条任务每几百毫秒一次 `progress`。每次都广播会把 IPC 刷爆，而 UI 实际只关心「有哪些任务、各自什么状态」。

所以宿主侧按 `taskId` 聚合成快照，**只在任务集合或状态真的变了才广播**：

```ts
const changed = !before || before.status !== status || before.title !== title;
if (!changed) return;
```

---

## UI 放在对话流里，不是侧边栏

子任务是「在这一轮里派出去的活」。离开上下文单独看一排任务，用户会不知道它们属于哪个请求。

折叠时显示「N 个进行中 / 全部结束」，展开能看每个子任务的诉求原文，进行中的有「停止」按钮（点它不该顺带展开卡片，所以 `preventDefault`）。

---

## 验收：验「活儿真的派出去了」

这个功能空过一整轮，所以不能只验「API 没报错」：

```
子任务事件数: 1 / 任务数: 1
任务: [{"title":"快速排序 · 归并排序 · 堆排序","status":"running"}]
界面卡片数: 1 / 条目数: 1
最终状态: ["completed"]
仍标 running 的数量: 0
```

模型确实调用了 `subagent` 工具（截图里能看到 tool_use 卡片带 `{"tasks":[{"agent":"scout","title":"快速排序"...`），卡片从「1 个进行中」转成「全部结束」。

---

## 顺手修了一个时序脆弱的测试

回归时 `steer` 偶发失败：「界面上没有出现插话标记」。重跑就过。

原因：测试固定 `delay(1500)` 后插话，但模型数数很快，有时 1.5 秒时这一轮已经数完了，插话自然失败。

改成**轮询等「已经开始流式输出」就立刻插话**（最多等 3 秒）。连跑两次都稳定。

这类「固定 sleep 依赖模型速度」的测试会随机变红，让人误判成回归——修掉比反复重跑划算。

---

## 十一个模式全部通过

`1` / `permission` / `queue` / `resume` / `compact` / `steer` / `diff` / `mode` / `model` / `export` / `task` 全绿，`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `packages/host-core/src/host.ts` | **`spawnPiSubagentRunner`**（本项关键）+ `ELECTRON_RUN_AS_NODE` |
| `apps/desktop/electron/hostRuntime.ts` | `agent_task_update` 聚合与节流、`listTasks` / `stopTask` |
| `apps/desktop/src/TaskCard.tsx` | 新文件：子任务卡片 |
| `apps/desktop/src/shared/ipc.ts` | `TaskInfo`、`tasks` 事件、两条通道 |
| `apps/desktop/electron/autotest.ts` | `runTaskTest` + steer 时序修正 |
| `apps/desktop/src/App.tsx` / `devMock.ts` / `styles/app.css` | 接入与样式 |
| `apps/spike/src/probeTasks.ts` | 一次性探测脚本 |

## 已知限制

- pi 只有 subagent 一种后台任务，**没有独立的 bash 后台任务**
- 子任务列表存在内存里，不落库——重开应用看不到历史子任务
- `resumeBackgroundTask`（给子任务追加指令）没接
- 子任务的 usage 全是 0（引擎报的，不是我们丢的）
- 停掉子任务后 UI 状态要等下一次 `agent_task_update` 才刷新

## 下一步（A 类剩余）

- 回退到某条消息（`previewRewindFiles` / `commitRewindFiles`）
- 会话分支树（`getSessionTree` / `navigateSessionTree`）
- 额外工作目录（`setExtraDirs` / `setWritableDirs`）
- 图片（`image` 事件）
- 模型热切换的「多端点」部分（`APP_MODELS` 的 endpoint 字段目前没传给 pi）
