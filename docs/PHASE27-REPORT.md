# Phase 27：跨会话事件路由（B 类）

ORCA 的最后一个前置条件。

---

## 一个会串台的真 bug

多会话并行做完后，`turn` 事件带了 `sessionId`，但 **`text` / `thinking` / `tool_use` / `tool_result` / `status` 都没带**。

后果不是理论上的——测试直接抓到了：

```
A 已产出 10 段文本
B 界面上正在流式的内容: "后台任务标记ABC\n后台任务标记ABC\n…"
A 的内容串到 B 了吗: true        ← 切到 B，看到的是 A 正在吐的字
```

原因：这些事件无条件写进当前会话的 `liveText`。用户正在看 B，屏幕上却是 A 的输出。

---

## 修法：所有按会话的事件都带 sessionId

改事件契约：

```ts
| { type: 'text';        sessionId: string; turnId: string; … }
| { type: 'thinking';    sessionId: string; turnId: string; … }
| { type: 'tool_use';    sessionId: string; turnId: string; … }
| { type: 'tool_result'; sessionId: string; turnId: string; … }
| { type: 'status';      sessionId: string; status: … }
```

`project()` 加 `sessionId` 参数，一路传下去。

`error` 事件保持 `sessionId?` 可选——有些错误是全局的（比如续跑找不到原文），没有会话归属。

### UI 侧加守卫

```ts
case 'text': {
  // 后台会话的事件不能进当前会话的界面
  if (event.sessionId !== activeRef.current) return;
  …
}
```

五处事件（text / thinking / tool_use / tool_result / status）统一加。

`turn` 事件不加这种「直接返回」，因为它要更新侧栏的运行标记——那个与当前会话无关。

---

## 验收：两层都验

**第一层：宿主路由正确**
```
A 已产出 18 段文本
B 收到的 text 事件数: 0（应为 0，B 这轮没发消息）
```

**第二层：UI 守卫生效**
```
B 界面上正在流式的内容: ""
A 的内容串到 B 了吗: false
```

**第三层：A 的内容没丢**
```
A 落库的内容含标记: true
```

三层缺一不可——只验「B 没有」可能是 A 也没跑；只验「A 跑了」可能是两边都显示。

---

## 测试本身踩了三次坑

这一项花在**修测试**上的时间比修代码多。记下来：

**① 直接调 `runtime.createSession`** —— React 的 sessions 列表不更新，侧栏没元素可点，`no-item`。改成点「+ 新会话」。

**② 靠标题找会话** —— 两个会话都叫「新会话」（自动标题要等用户发言才生成），找不到目标。改成按「非激活项」定位。

**③ 宿主侧 `renameSession` 改 DB，React 不认** —— 我加了一段改名再按标题找，结果侧栏还是「新会话」。

最后放弃标题方案，改成：

```js
const target = items.find((el) => !el.className.includes('surface-active'));
```

点「不是当前激活」的那一项，靠切换动作本身确认切过去了。

**教训**：验 UI 就要走 UI 路径建数据；DOM 里拿不到业务 id 时，用「状态特征」（激活/非激活）而不是「内容特征」（标题）。

---

## 25 个模式全部通过

`tsc` 0 错误。这次动的是事件契约，全量回归跑了一遍。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/shared/ipc.ts` | 5 类事件加 `sessionId`；`error` 加可选 `sessionId` |
| `apps/desktop/electron/hostRuntime.ts` | `project(event, sessionId, turnId)` 贯穿 |
| `apps/desktop/src/App.tsx` | 5 处事件加「非当前会话直接返回」守卫 |
| `apps/desktop/src/devMock.ts` | 补齐 sessionId |
| `apps/desktop/electron/autotest.ts` | `runEventRoutingTest` |

## 已知限制

- **后台会话的流式输出被丢弃，不是缓存**。切回去只能看最终结果（从 DB 重拉），看不到当时的逐字过程
- 如果要做「切过去能看到正在流的字」，需要在 UI 侧按会话缓存 `liveText`——但那会占内存，当前没做
- `error` 事件的可选 `sessionId` 意味着全局错误还是会显示在当前界面上（这是有意的）

---

## ORCA 前置条件清单

| 条件 | 状态 |
|---|---|
| 多会话并行 | ✅ Phase 25 |
| 每会话独立 turn 追踪 | ✅ Phase 25 |
| 运行状态可见 | ✅ Phase 25 补充 |
| 完成通知 | ✅ Phase 26 |
| 并发上限已知 | ✅ 5 个安全（1.3GB） |
| 跨会话事件路由 | ✅ Phase 27 |

**前置齐了。**

按 `docs/BENCH-PARALLEL.md` 的结论：ORCA 第一版应该**硬编码并发 3**，因为测量的乐观值 5 是在短对话下得出的，真实 worker 带长上下文和工具调用会更高。
