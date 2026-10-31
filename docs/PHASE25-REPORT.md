# Phase 25：多会话并行（B 类）

「让它跑 A，我去看 B」——之前这么做会把 A 打断。

---

## 先确认引擎支持

动手前查了两件事，避免白干：

**① Maker 能同时持有多个 Session** —— `sessions: readonly Session[]`，支持。

**② 并发发送不会互相阻塞** —— 关键在 `sessionRpcChain`：

```ts
const runExclusivePiRpc = (fn) => {
  const run = sessionRpcChain.then(fn);
  sessionRpcChain = run.then(...);
  return run;
};
```

这是**每个 session 内部**的串行链，不同 session 之间互不阻塞。

**结论：引擎层没问题，障碍全在宿主。**

---

## 改造：单实例 → 多实例

### 改动前

```ts
private session: Session | null = null;

// 每个方法开头都是这几行
if (!this.session || this.session.id !== sessionId) await this.resume(sessionId);
const session = this.session!;
```

这个写法的隐含语义是「**同一时刻只能有一个会话**」——正是要拆掉的东西。

### 改动后

```ts
private readonly sessions = new Map<string, Session>();

private async getSession(sessionId: string): Promise<Session> {
  const existing = this.sessions.get(sessionId);
  if (existing) return existing;
  await this.resume(sessionId);
  return this.sessions.get(sessionId)!;
}
```

41 处 `this.session` 里，12 处是完全相同的模式，批量替换成 `getSession`。其余逐个改。

### `activeTurnId` → `activeTurns`

这是并行的**真正核心**：

```ts
// 改前：全局单值
private activeTurnId: string | null = null;

// 改后：按会话记
private readonly activeTurns = new Map<string, string>();
```

不改这个的话，两个会话各跑一轮时后者会覆盖前者的 turnId——`cancel` / `steer` / 压缩保护全都会作用到错的会话上。

顺带把 `cancel()` 改成接收 `sessionId`：

```ts
// 改前：只能停「当前会话」
async cancel(): Promise<void>

// 改后：明确停哪个
async cancel(sessionId: string): Promise<void>
```

多会话下「当前会话」是个 UI 概念，宿主不该依赖它。

---

## 一个隐蔽的致命 bug

`resume()` 原来**无条件新建会话**：

```ts
const session = await this.maker.createSession({ id: sessionId, ... });
this.attach(session);
```

改成多实例后这变成大问题：**切走再切回会把正在跑的会话实例连同它的订阅一起换掉**。

后果：后台轮静默消失，不报错，界面上那个会话看起来「好像还在跑」，其实已经没有监听器了。

修：

```ts
async resume(sessionId: string): Promise<string> {
  // 已经活着的会话直接复用
  if (this.sessions.has(sessionId)) return sessionId;
  ...
}
```

**这个 bug 不修的话，功能看起来能用、实际在随机丢任务**——比直接报错糟得多。

---

## 验收：验「切走不打断」

```
会话 A=0bbbde7d / B=af1b0e69
A 的轮已开始: 836dfd6a
已切换到 B
已在 B 发消息
切换后 A 的轮仍在跑: true        ← 关键
轮状态: [["46be7181","done"],["836dfd6a","done"]]
A 的轮最终状态: done
A 的消息数: 4                    ← 真的跑完并落库了
```

做法：让 A 跑 `sleep 10`，切到 B 发消息，再等两轮都收口。

- 「切换后 A 的轮仍在跑: true」—— 旧实现在这里会是 false
- 两个轮都 `done`
- A 落了 4 条消息，证明不是「假完成」

---

## 23 个模式全部通过

`tsc` 0 错误。这次动的是宿主核心，全量回归跑了一遍，没有一个回归。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/hostRuntime.ts` | `sessions` Map、`getSession`、`activeTurns`、`cancel(sessionId)`、`resume` 幂等 |
| `apps/desktop/electron/main.ts` | `cancel` IPC 传 sessionId |
| `apps/desktop/src/App.tsx` | `host.cancel(activeId)`（接口不变，语义更明确） |
| `apps/desktop/src/SessionItem.tsx` | `busy` 标记 |
| `apps/desktop/electron/autotest.ts` | `runParallelTest` |

## 已知限制

- **UI 没有并行状态指示**：后台会话在跑时，侧栏没有标记。用户切走后不知道它还在跑
- 后台轮完成时没有通知（切换走的那一轮跑完了不会提醒）
- 两个会话的输出都通过同一条 `onEvent` 流，UI 只渲染当前会话的——数据不会串，但后台事件被丢弃
- **并发数没有上限**：开 10 个会话同时跑会起 10 个 pi 子进程，内存压力没测
- `activeTurnSessionId` 作为兼容保留（steer / approve 里还在用），它记的是「最近一次操作的会话」——多会话下如果用户在两个会话间快速操作，可能取到错的

## B 类剩余

- 并行状态指示 + 完成通知（上面第一条，做完并行才算完整）
- 草稿持久化、快捷键、通知、非图片附件、项目分组
