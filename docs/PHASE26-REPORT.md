# Phase 26：后台完成通知（B 类）

多会话并行之后，「让它跑 A，我去做 B」成了主要用法。但 A 跑完时用户可能在别的窗口里，**完全无从得知** —— 并行就只是「后台在烧钱」。

---

## 三条克制原则

通知这件事，做多了比不做更烦。所以：

| 原则 | 理由 |
|---|---|
| **只在窗口没焦点时通知** | 用户正看着界面，界面上有变化就够了 |
| **只通知后台会话** | 当前会话完成了主区可见，弹通知是重复信息 |
| **同会话 5 秒内只弹一次** | 一个失败重试循环能瞬间刷几十条 |

判断逻辑抽成纯函数 `shouldNotify()`，不埋在 Electron 构造函数里——这样「该不该打扰用户」这件事可以被单独验证。

---

## 实现

```
turn 收口 → 查该会话标题 → 取最近一段助手回复做摘要
         → shouldNotify 判断 → Notification.show()
         → 点击：窗口前置 + 让界面切到那个会话
```

三个细节：

**标题用来区分是哪个会话跑完了**，不是「你的任务完成了」这种废话。

**摘要取 `text` 事件的 `isFinal` 段**（那是这轮回复的全文），截 120 字。取不到就写「跑完了」。

**点通知要能跳过去**：`win.restore()` → `win.show()` → `win.focus()`，再通过 `IPC.focusSession` 让渲染层切会话。

---

## 当前会话怎么知道

「当前会话」是 UI 概念——用户可能切走又切回，宿主自己猜不准。

所以由渲染层上报：

```ts
useEffect(() => {
  void host.setCurrentSession(activeId);
}, [host, activeId]);
```

`text` 事件只带 `turnId` 不带 `sessionId`，所以在 main 里维护 `turnId → sessionId` 映射（从 `turn` 事件里拿）。

---

## 撞到的两个问题

### 问题 1：判断顺序让日志误导

第一版先查 `focused` 再查 `isCurrentSession`。结果一份「当前会话」的日志显示成：

```
当前会话: {"notify":false,"reason":"focused"}
```

排查时会误以为是焦点判断出了问题，实际是「本来就不该通知这类消息」。

改成先判语义、再判窗口状态：

```ts
if (input.isCurrentSession) return { notify: false, reason: 'current-session' };
if (focused) return { notify: false, reason: 'focused' };
```

**判断顺序会影响可诊断性**——不只是结果对就行。

### 问题 2：节流失效

第一版在 `notification.show()` 之后才记录「已通知过」。问题：

- `shouldNotify()` 只判断不记账 → 直接调用它永远不节流
- `show()` 抛错时也不会记账

修：**判定为「该通知」的同时就记账**。判断和记账是一件事，分开放必然对不齐。

---

## 测试怎么验

系统通知在测试环境弹不出来（窗口是隐藏的），但**判断逻辑可以精确验**。

为此给 `shouldNotify` 加了 `focused?: boolean` 注入点：

```ts
// 测试窗口是隐藏的，win.blur() 不生效，
// 不注入的话「用户没看着界面」这条分支永远验不到
const focused = input.focused ?? win.isFocused();
```

四条路径全验到：

```
系统支持通知: true
当前会话: {"notify":false,"reason":"current-session"}
后台会话(新): {"notify":true}          ← 该通知
同会话 500ms 后: {"notify":false,"reason":"throttled"}
同会话 6s 后: {"notify":true}          ← 过窗口又能通知
无窗口: {"notify":false,"reason":"no-window"}
```

---

## 24 个模式全部通过

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/notifications.ts` | 新文件：`shouldNotify` 纯函数 + `notifyTurnFinished` |
| `apps/desktop/electron/main.ts` | turn 收口时判断通知；`turnId → sessionId` 映射；当前会话上报 |
| `apps/desktop/src/App.tsx` | 上报当前会话；响应点通知切会话 |
| `apps/desktop/src/shared/ipc.ts` | `setCurrentSession` / `focusSession` 通道 |
| `apps/desktop/electron/preload.ts` | 桥接 |
| `apps/desktop/electron/autotest.ts` | `runNotifyTest` |

## 已知限制

- **通知本身没在真实桌面上验过**（测试环境弹不出来）；只验了判断逻辑
- 通知里没有按钮（比如「打开」「忽略」）
- 同一会话连续多轮只弹一次，第二轮要等 5 秒后才可能再弹
- 没有「静音某个会话」的开关
- Windows 上需要应用有 AppUserModelID 才能正常显示（未设置，可能显示成 electron）

## B 类剩余

- **跨会话事件路由**：后台会话的流式输出现在被丢弃，切过去只能看最终结果
- 草稿持久化、快捷键、非图片附件、项目分组
