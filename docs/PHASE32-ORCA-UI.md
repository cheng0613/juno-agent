# ORCA 阶段二：右侧 worker 面板

用户的第一需求是「**要看到 worker 干活**」。阶段二就是让这句话成立。

---

## 做出来的东西

```
┌─────────┬──────────────────┬──────────────────────┐
│ 侧栏    │ 主对话            │ 协同面板              │
│         │                  │ ┌──────────────────┐ │
│ 新会话  │  有什么可以帮你？  │ │协同 3   + Worker │ │
│         │                  │ │●dev ○dev-2 ○dev-3│ │
│         │                  │ ├──────────────────┤ │
│         │                  │ │developer  ● 完成  │ │
│         │                  │ │独立工作区    移出 │ │
│         │                  │ ├──────────────────┤ │
│         │                  │ │  数一下1加到100   │ │
│ 协同 3  │                  │ │  5050            │ │
│         │                  │ ├──────────────────┤ │
│         │                  │ │给 developer 派活… │ │
└─────────┴──────────────────┴──────────────────────┘
```

**worker 不进左侧主列表。** 它们属于某个 Lead，在右侧面板里。

---

## 三个设计决定

### ① worker 的对话不进主对话

worker 本质上也是个会话，`text` 事件只带 `sessionId`。
不区分的话，「看到 worker 干活」会变成「主对话里莫名其妙多出别人写的字」。

所以 `text` 事件里先查反查表（`sessionId → workerId`），是 worker 就分流到面板。

### ② 渲染层拿 state 快照，不拿 ref

第一版直接把 `workerMsgs.current`（Map）传给面板。
结果面板永远停在打开那一刻 —— **ref 变了 React 不会重渲染**。

改用 `workerView` state 快照，每次内容变化同步一份。

> 这个 bug 只有真的看着界面才会发现：数据在内存里是全的，
> 但用户看到的是一片空白。

### ③ 状态由宿主投影，渲染层不自己推导

`{ type: 'workers', leadSessionId, workers }` 整张表推送。

渲染层不判断「这个 worker 是不是在跑」——那是宿主的活。
宿主在轮开始的 `running` 和轮结束的 `done/error` 两处同步。

---

## 踩到的问题

### 侧栏没过滤掉 worker（真 bug）

截图一看就发现：左侧主列表里躺着 3 个 `developer`。

原因：`listSessions()` 查的是所有未归档会话，worker 的会话也在里面。

修法：`SessionSummary` 带 `orcaRole`，侧栏 `.filter(s => s.orcaRole !== 'worker')`。

**这个是靠看截图发现的，不是靠断言。** 当时测试全绿。

### 「切不回隔离」不是 bug，是正确降级

验收第一次跑：隔离切换 `0 → 0`，失败。

查下来是测试环境的工作目录**不是 git 仓库** ——
`prepareWorkerWorktree` 降级返回 `isolated: false`，这完全正确。

修的是**测试**（先 `git init`），不是代码。

> 这件事值得记：断言失败不一定是代码错了，
> 也可能是测试没准备好前提条件。直接改代码迁就测试就糟了。

---

## 验收

新增 autotest 模式 **`orca-ui`**（第 29 个）。**全程走 UI 路径**：

```
点「协同」按钮 → 点「+ Worker」×3 → 点第二个胶囊 → 输入框派活 → 等跑完
```

（`runtime.createWorker()` 直接调不会更新 React state —— 这个坑记了三次，这次没再踩。）

| 断言 | 结果 |
|---|---|
| 点「协同」后面板出现 | ✓ |
| 连点 3 次建出 3 个胶囊 | ✓ |
| label 自动去重 `developer/developer-2/developer-3` | ✓ |
| **worker 不漏进左侧主列表** | ✓ |
| 点胶囊切换选中的 worker | ✓ |
| worker 派活后状态变 `done` | ✓ |
| **面板里看得到「派活」和「5050」** | ✓ |
| 隔离切换生效（`1 → 0`） | ✓ |
| 再点「协同」关掉面板 | ✓ |

```
侧栏条目: ["新会话⋯"]          ← 只有 Lead，worker 被过滤
面板里有对话内容: true
隔离切换: 1 → 0
```

回归：`orca` / `orca-iso` / `session` / `parallel` / `routing` / `live` /
`permission` / `mode` / `task` / `rewind` 全过。

---

## 文件

| 文件 | 内容 |
|---|---|
| `src/WorkerPanel.tsx` | 新增，面板组件（~300 行） |
| `src/App.tsx` | worker 状态、事件分流、操作函数、渲染（~200 行） |
| `src/shared/ipc.ts` | 5 个 IPC、`UiWorker`、`workers` 事件、`SessionSummary.orcaRole` |
| `electron/hostRuntime.ts` | 状态投影、`emitWorkers`、`removeWorker`、listSessions 带角色 |
| `electron/main.ts` / `preload.ts` | IPC handlers |
| `src/styles/app.css` | 面板样式（~230 行） |
| `electron/autotest.ts` | `runOrcaUiTest` |

---

## 已知限制

- **面板宽度固定**（`min(460px, 60%)`），不能拖拽调整
- **胶囊不显示详细进度**（只有状态点）。想知道具体在干什么，得点进去看对话
- **切走会话后 worker 对话缓存在内存**，重启丢失（和 `liveBySession` 同样的问题）
- **没做「worker 完成后汇总到 Lead」** —— Cindy 也没做，done 是常态不值得打扰
- 侧栏 `协同` 按钮只在有 Lead 会话时才有意义，但没做条件显示

---

## 下一步：阶段三

阶段三才需要模型参与：让 Lead 用工具派活给 worker。

- 3 个工具：`create_worker` / `send_to_worker` / `list_workers`
- worker 侧 `send_to_lead` 回报
- 回报注入 Lead 对话（带 `[From Orca Worker <role>]` 前缀）

MCP 链路已在 `docs/SPIKE-MCP.md` 验证过，没有技术不确定性。
