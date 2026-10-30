# Phase 7：插话纠正 + 上下文占用条（A 类第一波）

按「引擎已给、我们没接」的思路先吃性价比最高的两项。每项都跑了真端点验收。

---

## 1. 插话纠正（`steer`）

**做了什么**：跑着的时候按 Enter 不再排队，而是把话塞进**当前这一轮**——模型看到后调整方向，不重做。

**为什么改语义**：用户跑着时打字，十有八九是「不对，改成……」，而不是「排队，等它跑完再说」。旧行为把这个动作变成排队，等于把最常用的纠正动作藏起来了。要排队现在点底部的「排队」按钮。

**为什么插话要单独一个 `user_steer` role**：它属于当前正在跑的那一轮，不是新轮的开头。当成普通 `user` 落库的话，重放历史会看起来像用户连发两条、模型只回一次，像 bug。

**为什么插话也要落库**：不落库的话，用户看到自己说的话在重载后凭空消失。

**两条错误都翻译成人话了**：
- 没有活跃轮 → 「当前没有正在进行的轮，直接发送即可」
- 轮刚好结束 → 「这一轮刚好结束了，请重新发送」

引擎原始错误是 `[NO_ACTIVE_TURN] ...` 这种，直接抛给用户等于没提示。

**验收方式**（关键）：不是验「API 没报错」，而是验**模型真的改主意**——让它数到 30，中途插话改成只数到 5。如果 steer 没投递进去，它会继续数 6、7、8。

```
[autotest/steer] 界面上插话标记数: 1
[autotest/steer] 最后回复里的最大数字: 5
[autotest/steer] 插话事件数: 1
```
停在 5，说明插话进了引擎、模型也照做了。

---

## 2. 上下文占用条

**做了什么**：顶栏一条细进度条 + 百分比，数据来自 `getContextUsage()`。点击即压缩。

**为什么只取三个字段**：引擎返回的 `ContextUsageData` 带着 `categories` / `gridRows` / `memoryFiles` / `mcpTools`——那是给「分项饼图」用的。我们只画一根条，把这些字段过 IPC 纯属浪费（`gridRows` 还是个二维数组）。

**为什么 60% 才变色**：平时它只是背景信息，不该抢注意力；快满了才该让人一眼看到。三档：<60% 灰、60-85% 黄、≥85% 红。

**为什么拿不到就不画**：`contextUsage()` 失败返回 `null` 而不是抛错。一个进度条不该让整个界面弹错误提示。

**刷新时机**：启用时、切会话、轮结束、压缩后。压缩那次特别重要——压缩就是为了降占用，不重算的话进度条还停在压缩前。

---

## 顺手修的两个问题

**1. 五个测试各写一份截图函数，只有一份有重试**

`capturePage()` 会偶发 `UnknownVizError`（窗口被遮挡/合成未完成）。这是环境噪声，不是被测功能的错。

写 steer 测试时我用了没重试的那份，结果第一次跑就报 `UnknownVizError`，我一度以为是 steer 失败，白查了十几分钟——**排查方向被一个测试脚手架缺陷带偏了**。

已抽成共用的 `shootTo()`，4 次重试，全部测试统一走它。

**2. `queue` 测试断言的是旧语义**

Enter 改成插话后，队列测试还在按「Enter 入队」断言，直接失败。已改成点「排队」按钮入队，与新产品语义一致（2 条入队、3 轮全 done）。

---

## 发现的真 bug（未修，记在案）

验收时模型调 `read` 工具读了一个**目录**，报：

```
EISDIR: illegal operation on a directory, read
```

工具调用没做防御——读路径前应该先判断是不是目录，是的话返回「这是个目录，你是想 ls 吗」之类的友好错误，而不是把 errno 直接怼到用户脸上。这是「给别人用必崩」那一类，下一轮该修。

---

## 六个模式全部通过

| 模式 | 结果 |
|---|---|
| `1` | 11 段流式 / 160 字 ✅ |
| `permission` | 第二轮 0 次弹窗 ✅ |
| `queue` | 排队 2 条、3 轮全 done ✅ |
| `compact` | noop 提示 + 边界落库 ✅ |
| `resume` | 横幅 → 继续 → 归零 ✅ |
| `steer` | 插话后停在 5 + 占用条 ✅ |

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `packages/host-core/src/db/messageStore.ts` | `user_steer` role |
| `packages/host-core/src/recorder.ts` | `appendSteer()` |
| `apps/desktop/electron/hostRuntime.ts` | `steer()` / `contextUsage()` + 错误翻译 |
| `apps/desktop/electron/main.ts` | 两条 IPC + 行映射 |
| `apps/desktop/electron/preload.ts` | 桥接两个方法 |
| `apps/desktop/electron/autotest.ts` | `runSteerTest`、共用 `shootTo`、queue 测试改语义 |
| `apps/desktop/src/shared/ipc.ts` | `steer` / `contextUsage` / `ContextUsage` / `user_steer` |
| `apps/desktop/src/App.tsx` | `UsageMeter`、Enter 插话、排队按钮、占用刷新 |
| `apps/desktop/src/Chat.tsx` | 插话行渲染 |
| `apps/desktop/src/styles/app.css` | 占用条、插话样式、排队按钮 |
| `apps/desktop/src/devMock.ts` | 补齐两个 mock 方法 |

## 下一步（A 类剩余）

- `turn_diff` 文件改动面板
- 权限档位 `setPermissionMode()`
- 计划模式 `setPlanMode()`
- 模型热切换 / effort / fast mode
- 回退到某条消息（`previewRewindFiles`）
