# Phase 9：权限档位 + 计划模式

A 类第三项。原计划照引擎的 6 档做，动手前发现 pi 只认 3 档 —— 反而更简单。

---

## 一个简化了设计的发现

引擎的 `PermissionMode` 有 6 个值：

```ts
'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
```

但 pi 的能力声明里只列了 3 个：

```ts
permissionModes: [
  { id: 'ask',               … },
  { id: 'auto',              … },
  { id: 'bypassPermissions', … },
]
```

摆 6 个到 UI 上，用户点 `acceptEdits` 会没反应——比不提供更糟。所以只暴露真实支持的三档。

另一个关键区分：**计划模式不是权限档位**。引擎里它是独立的 `setPlanMode()` 开关（`planMode` 能力），跟权限模式是两条并行线。所以 UI 上是两个独立控件：一个下拉选档位，一个开关切计划模式。

---

## 三档的语义（写进 UI 文案）

| 档位 | 对用户说的话 |
|---|---|
| 每次询问 | 只读工具直接跑；改文件、执行命令、调 MCP 都先问你 |
| 自动放行工作区内 | 工作区内写文件和常用安全命令不再问；区外写入和危险命令仍会问 |
| 全放行 | 任何文件都能改、任何命令都能跑，不再确认。只在你完全信任任务时用 |

**文案是刻意写成「会替你做什么」而不是术语。** 用户看不懂 `Auto-review` 就不会去动它，最后永远停在最烦人或最不安全的那一档。

---

## 全放行必须二次确认

这是整个 app 里**唯一一个点错一次就把整台机器交出去**的开关。所以：

- 菜单里用红色标出
- 点了不直接生效，弹二次确认，正文写明「可以直接改任何文件、跑任何命令，不再征求你同意」
- 确认按钮是红色的「确认全放行」，取消是普通按钮
- 取消后真的不生效（测试里专门验了这点）

生效期间顶栏按钮**持续显示红色**——不能只在菜单里标一次，那样切完就看不见了。

---

## 一个设计上的取舍

**轮进行中也允许切档位。** 引擎支持即时生效（`setPermissionModeMidSession: true`）。用户跑到一半发现「这个应该全放行」很正常，没必要逼他先停下再切再继续。

**`plan_mode_changed` 事件要接。** agent 自己也会切计划模式（比如计划批准后自动退出）。不接的话 UI 上那个开关会跟实际状态相反——用户以为还开着，其实早退出了。

**`readModes()` 以引擎为准，但允许引擎返回 null。** `getPlanMode()` 可能返回 null（未知/不支持），那时退回宿主自己记的值，总比报错强。

---

## 验收

```
菜单项: ["每次询问","自动放行工作区内","全放行"]
二次确认是否出现: 1
取消后档位: ask              ← 点了取消，确实没生效
切换后档位: auto
auto 档审批次数: 0            ← 关键：档位真的传到了引擎
计划模式: true → false        ← 开关往返正常
```

「auto 档审批次数: 0」是这条验收的核心——它不是验 API 没报错，而是验**行为真的变了**。之前 `ask` 档下跑 `echo ok` 会弹审批，切到 `auto` 后不再弹。

---

## 顺手修的一处测试基建

跑回归时模式 `1` 报 `UnknownVizError`。原因还是 `capturePage()` 偶发失败——上一轮我把 5 处截图函数抽成了一个 `shootTo()`，但漏掉了 `runAutotest` 里的 `shot`（它额外维护一个 `shots` 数组，所以没被批量替换到）。

这次把剩下 3 处裸调用（permission / compact / queue）也全部换掉了。现在全仓库只有 2 处 `capturePage()`：`shootTo` 本体，和 resume 那份更早的带重试实现。

---

## 八个模式全部通过

| 模式 | 结果 |
|---|---|
| `1` | 11 段流式 / 160 字 ✅ |
| `permission` | 第二轮 0 次弹窗 ✅ |
| `queue` | 3 轮全 done ✅ |
| `compact` | 边界落库/渲染 ✅ |
| `resume` | 横幅归零 ✅ |
| `steer` | 插话后停在 5 ✅ |
| `diff` | 列出 note.txt + 正文 ✅ |
| `mode` | 二次确认 + auto 零审批 + 计划开关 ✅ |

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/ModeControls.tsx` | 新文件：档位下拉 + 计划开关 + 危险档确认 |
| `apps/desktop/electron/hostRuntime.ts` | `setPermissionMode` / `setPlanMode` / `readModes` / `plan_mode_changed` |
| `apps/desktop/electron/main.ts` | 3 条 IPC |
| `apps/desktop/electron/preload.ts` | 桥接 |
| `apps/desktop/electron/autotest.ts` | `runModeTest` + 剩余截图统一到 `shootTo` |
| `apps/desktop/src/shared/ipc.ts` | `PermissionModeChoice` / `ModeState` / `modes` 事件 |
| `apps/desktop/src/App.tsx` | 模式状态、切换动作、顶栏接入 |
| `apps/desktop/src/styles/app.css` | 菜单、确认框、危险态样式 |
| `apps/desktop/src/devMock.ts` | 补齐三个 mock |

## 已知限制

- 只支持 pi 的 3 档；接 claude-code 后它的 `default` / `acceptEdits` 需要在能力探测后动态显示
- 档位存在会话里，不跨会话记忆（新会话默认回到 `ask`）
- 计划模式下模型被禁用写工具，但 UI 没有专门提示「现在是只读状态」——只有顶栏那个 `计划 ✓`
- 危险档没有自动回退：切到全放行后忘了切回来会一直保持

## 下一步（A 类剩余）

- 思考档位 `setEffort()` / Fast mode
- 模型热切换 `setModel()`
- 后台任务 + 子任务进度
- 回退到某条消息
- 会话分支树 / 导出 HTML
