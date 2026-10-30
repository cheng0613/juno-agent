# Phase 6：上下文压缩

目标是把 `compact_boundary` 这条一直没接的事件链补上：压缩发生时对话里要留下痕迹，用户手动也要能压一次。

---

## 做了什么

**事件链**：`pi compaction_end` → maker-core `compact_boundary` → 宿主 `compact` 事件 → 落库一行 `role='compact_boundary'` → 对话里一条分隔线。

- `MessageRole` 增加 `compact_boundary`
- `SessionRecorder.recordCompactBoundary()` 存 `{trigger, preTokens, postTokens}`
- 时间线上渲染成一条横线：`上下文已压缩（手动） · 12.3k → 2.1k tokens`
- 顶栏加「压缩上下文」按钮 → `session.compactSession()`

**为什么边界必须落库**：压缩后模型看到的上下文变了，但对话记录没变。不标出来，用户下次翻历史会以为「它怎么忘了我刚说的」是 bug。所以这不是装饰，是解释性信息。

**为什么边界不走 `appendBlock`**：那个方法用 `turnId` 拼幂等键。空闲手动压缩发生在轮之外（`turnId` 为 null），会被拼成 `null:compact_boundary:1`，跨会话撞键。

**为什么手动压缩要临时挂订阅**：轮结束就解绑了订阅，空闲时没有活跃监听器。所以 `compact()` 临时挂一份只为收那条边界，收到就拆；边界可能比 `compactSession()` 的返回值晚到，因此不能 `finally` 里立即拆（会漏事件、UI 不出分隔线），改成「收到就拆，否则 3 秒后无条件收尾」。

**noop 是良性结果，不是错误**：引擎回答「Nothing to compact (session too small)」时提示「上下文还很小，暂时不需要压缩」，不能报「压缩失败」。这是真实用户最常撞到的分支。

---

## 一个查了很久的事实：pi 的手动压缩有内置下限

最初想端到端验「真的压缩一次」，结果连续撞 `Nothing to compact (session too small)`。排查过程与结论：

| 试过的办法 | 结果 |
|---|---|
| 堆 4 轮「1500 字」文章 | 模型实际只回几十字，上下文仅 ~2k tokens，仍 noop |
| `APP_CONTEXT_WINDOW=4000` | noop |
| `APP_CONTEXT_WINDOW=9000` + `APP_COMPACT_PCT=50` | noop（`reserveTokens` 确实写进了 settings.json，但门槛不动） |
| `APP_COMPACT_PCT=1`（阈值≈2k） | noop |
| 翻 pi.exe 二进制找门槛 | 找不到字符串（压缩逻辑不在里面，或编码不同） |
| 翻上游集成测试 | 他们也只断言「小会话 → noop」，从没让真实压缩在测试里发生 |

结论：**这个下限不是配置能降的**，要用真实 API 把上下文堆到那个量级才触发，成本不经济。

于是验收拆成两段，各自验真正的风险点：

**甲、noop 路径**（真实 UI 点击）—— 小会话点压缩必须给良性提示，不能报失败。

**乙、边界路径**（合成一条 `compact_boundary`）—— 走与真实事件完全相同的落库 + 广播路径，验「落库 / 渲染 / 重载后仍在」。这半条链路是我们自己写的，风险都在这里。

合成通道只在 `APP_AUTOTEST` 开启时存在（主进程 `ipcMain.handle` 和 preload 都做了开关），正常启动拿不到。

---

## 顺手修的两个 UI 问题

1. **提示条挤压顶栏**：`notice` 原本是全宽块，占了独立一行，把会话标题和按钮挤下去，看着像布局错位。改成浮在内容区顶部居中（`position: absolute`），不占布局流。
2. **空会话也能点压缩**：按钮在 `messages.length === 0` 时禁用。点了必然 noop，不该让用户白点一次。

提示条另外加了 3.5 秒自动消失——它是不阻塞的告知，不该要求用户手动点掉。

---

## 验收结果

```
[autotest/compact] 点击压缩: ok
[autotest/compact] 提示文案: 上下文还很小，暂时不需要压缩
[autotest/compact] 良性 noop（上下文还小）
[autotest/compact] 收到边界事件: {"preTokens":12345,"postTokens":2100}
[autotest/compact] 分隔线条数: 1 / 文案: 上下文已压缩（手动） · 12.3k → 2.1k tokens
[autotest/compact] 库里 compact_boundary 行数: 1
[autotest/compact] 完成
```

五个模式全部回归通过：

| 模式 | 结果 |
|---|---|
| `APP_AUTOTEST=1` | 12 段流式 / 160 字 / 6 条消息 ✅ |
| `APP_AUTOTEST=permission` | 第二轮 0 次弹窗 ✅ |
| `APP_AUTOTEST=queue` | 3 轮全 done ✅ |
| `APP_AUTOTEST=resume` | 横幅 → 继续 → 归零 ✅ |
| `APP_AUTOTEST=compact` | noop 提示 + 边界落库/渲染 ✅ |

---

## 文件改动

| 文件 | 说明 |
|---|---|
| `packages/host-core/src/db/messageStore.ts` | `MessageRole` 加 `compact_boundary` |
| `packages/host-core/src/recorder.ts` | `recordCompactBoundary()` + 事件分派 |
| `packages/host-core/src/host.ts` | `PiHostOptions.compactionPct` → `resolveModelCompactionPct` |
| `apps/desktop/electron/hostRuntime.ts` | `compact()`、`injectCompactBoundary()`、`compactionPct` |
| `apps/desktop/electron/main.ts` | 压缩 IPC、`compact_boundary` 行映射、验收后门 |
| `apps/desktop/electron/preload.ts` | `compact()`、验收专用 `__autotestInject` |
| `apps/desktop/electron/autotest.ts` | `runCompactTest`（两段式） |
| `apps/desktop/src/shared/ipc.ts` | `compact` 事件、`CompactResult`、`UiMessage.compact` |
| `apps/desktop/src/App.tsx` | 顶栏按钮、`compactNow`、notice 自动消失与浮动定位 |
| `apps/desktop/src/Chat.tsx` | 分隔线渲染 + token 缩写 |
| `apps/desktop/src/styles/app.css` | `.topbar` / `.compact-line` / `.notice` 重做 |
| `apps/spike/src/probeCompact.ts` | 一次性门槛探测脚本（保留作参考） |

**`packages/maker-core` 保持零改动**：排查期间临时加过一行 `console.warn` 打印 pi 原始报错，已用 `diff` 确认完全还原。

---

## 已知限制

- 真实压缩未被端到端验证（pi 内置下限，见上）。等真实使用中撞到自动压缩时，同一条 `compact` 事件链会走通，届时可观察。
- 自动压缩（`trigger='auto'`）同样未在真实场景观察到。
- 压缩后没有「展开看摘要」的能力——现在只标位置，不展示摘要正文。
