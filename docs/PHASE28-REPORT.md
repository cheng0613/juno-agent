# Phase 28：看着 worker 干活（实时流式可见）

Phase 27 把后台会话的流式输出「挡住」了——不串台，但也看不见了。切回去只能从 DB 重拉看最终结果。

ORCA 要派 worker 干活，用户必须能**看着它写**，而不是等它写完。

---

## 做法：按会话缓存流式文本

之前 `liveText` 是单份 state，切会话就清空。改成按会话缓存：

```ts
const liveBySession = useRef<Map<string, string>>(new Map());
```

三处改动：

**① 收到 text 事件**：不论是不是当前会话都先缓存，只有当前会话才上屏

```ts
const cached = event.isFinal
  ? event.text
  : (liveBySession.current.get(event.sessionId) ?? '') + event.text;
liveBySession.current.set(event.sessionId, cached);

if (event.sessionId !== activeRef.current) return;  // 后台只缓存
setLiveText(cached);
```

**② 切会话**：从缓存恢复，接上正在流的内容

```ts
const cached = liveBySession.current.get(id) ?? '';
setLiveText(cached);
```

**③ 轮结束**：删掉缓存（内容已落库，留着下次切回来会看到重复的一份）

```ts
liveBySession.current.delete(event.sessionId);
```

**内存代价可忽略**：每个会话最多几十 KB 文本，并发 5 个也就几百 KB。

---

## 验收

```
A 已产出 11 段，立即切回
切回后侧栏状态: [{"t":"新会话","active":false},{"t":"把「正在写长文」…","active":true}]
A 切回后可见的流式文本长度: 176
A 可见内容前 40 字: "正在写长文\n正在写长文\n正在写长文\n…"
```

截图里能看到 A 正在一行行写，侧栏 A 前面有橙色运行点。

---

## 测试写的比代码难，记四个坑

这一项修测试花的时间是修代码的几倍：

**① 替换脚本静默失败** —— 我用 `s.replace()` 改 `src/App.tsx`，字符串里有多行 + 中文，**没匹配上但脚本继续跑**，结果只加了个 state 声明，三处逻辑一个没改。表现是「缓存不生效」。

教训：脚本改代码必须**校验替换次数**，不能假设成功。

**② 等太久，任务已经跑完** —— 第一版等「产出 3 段」再切回，实测那时 A 已经写完 35 段了。改成等 1 段就切。

**③ 靠「非激活项」定位会话不可靠** —— 第一次点非激活项切到 B，第二次再点非激活项，找到的却还是同一个项（因为激活状态更新有延迟），切回失败但没报错。

**④ 最终解法：给会话项加 `data-session-id`**

```tsx
<div data-testid="session-item" data-session-id={session.id} …>
```

```js
document.querySelector(`[data-session-id="${sid}"]`).querySelector('button').click()
```

按 id 精确点，不猜位置、不猜激活状态。**DOM 里能塞业务 id 就塞**——测试就不用靠推断。

---

## 26 个模式全部通过

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/App.tsx` | `liveBySession` 缓存、切会话恢复、收口清理 |
| `apps/desktop/src/SessionItem.tsx` | `data-session-id` |
| `apps/desktop/electron/autotest.ts` | `runLiveViewTest` |

## 已知限制

- **缓存只在内存**，应用重启就没了（重启后只能看落库的最终结果，这是对的）
- 后台会话缓存的是**完整累积文本**，不是增量 — 长任务几十 KB，可接受
- 切到后台会话看不到它的历史工具调用（那些在 messages 里，切过去会重拉，没问题）
- 如果后台会话跑了很久，缓存会一直累积到轮结束才清

---

## ORCA 前置条件：全部齐备

| 条件 | 状态 |
|---|---|
| 多会话并行 | ✅ Ph25 |
| 每会话 turn 追踪 | ✅ Ph25 |
| 运行状态可见 | ✅ Ph25 |
| 完成通知 | ✅ Ph26 |
| 跨会话事件路由（不串台） | ✅ Ph27 |
| **实时流式可见（能看它干活）** | ✅ Ph28 |
| 并发上限已知 | ✅ 5 个安全（1.3GB） |

**可以做 ORCA 了。** 第一版按测量结论硬编码并发 3。
