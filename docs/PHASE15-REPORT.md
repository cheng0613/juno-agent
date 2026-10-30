# Phase 15：会话分支树

A 类第九项。「回到某一轮重问」——比预想的更有价值，也比预想的更容易做错。

---

## 先搞清语义，再动手

引擎的 `navigateSessionTree` 不是「切换分支视角」。看注释：

> 选中 user entry 时 Pi 回到其 parent，并把原 prompt 放回编辑器

所以它是**回到改写前重问**：退到那一刻、把原话塞回输入框、用户改完再发就长出新枝。

这个语义决定了 UI 文案：「从这里重来」，不是「切换到此分支」。

探测脚本验证了完整链路：

```
第一棵树   leafId=7af2e4ae  activePathCount=7
navigate 成功
分叉后的树 leafId=0d6dfbf3  activePathCount=3
```

`activePathCount` 从 7 变 3，说明切换真的生效了。而**分叉不是 navigate 产生的**——要切回去之后**再发新消息**才会长新枝。

---

## 撞到的两个真问题

### 问题 1：对话区整个空了

第一版回退后，界面显示「有什么可以帮你？」——历史全没。

原因：我在 `replayFrom` 里调 `host.loadSession()`，读的是我们自己的 `messages` 表。那张表不知道分支结构，会把**已被丢弃的那一支也显示出来**（第一次跑就是这样，退回后还能看到旧分支的第二问）。

正确做法：用引擎返回的 `result.messages` 重建时间线。这正是 `NavigateSessionTreeResult.messages` 存在的意义。

### 问题 2：即使换了数据源，还是空

换完之后仍然是 0 个气泡。查引擎源码才发现 `content` 有**两种形状**：

```ts
// user：对象
content: { text: textFromContent(message.content) }
// assistant 的文本块：裸字符串
content: block.text
```

我的映射只处理 `c.text`，遇到裸字符串就得到空串——所有内容都被吃掉了。

修成两种都认：

```ts
if (typeof row.content === 'string') { ... text: row.content }
```

---

## 测试自身的问题：选错了节点

修完这两处，测试还是失败在「回退后对话区是空的」。

但这次是**测试选错了要验的东西**：我点了第一个「重来」按钮，那是第一句话——退到它之前，历史本来就该是空的（后面什么都没有）。

改成点**最后一个**「重来」（第二句），前面还留着一问一答，才能真正验到「历史重建」。

> 顺便记一笔：第一次跑全绿其实是假绿——因为当时只验了「输入框有内容」，没验「对话区没空」。补上 `bubbles < 1` 的断言后才暴露出来。**验证一个动作时，要同时验「该出现的出现了」和「不该消失的还在」。**

---

## UI 上的几个取舍

**只显示 user / assistant 消息。** `system` / `summary` 节点对用户没意义，摆上去会像调试面板。非消息节点若只有一个孩子就提升上来，不占位。

**「重来」按钮悬停才出现。** 它是低频但后果明显的动作，不该一直吸注意力。

**非活动路径的节点淡化**（`opacity: 0.45`）。一眼看出哪条是「现在这条」。

**用 `你` / `它` 而不是 user / assistant。** 中文界面里英文角色名很突兀。

---

## 验收

```
树节点数（分叉前）: 4
面板行数: 4 / 重来按钮数: 2
输入框内容: "刚才那个数字是多少？只回答数字"    ← 原话回来了
回退后对话区气泡数: 3                          ← 历史重建了
树节点数（分叉后）: 6                          ← 真长出新枝
```

三条缺一不可：原话回填、历史重建、再发能分叉。

---

## 十三个模式全部通过

`1` / `permission` / `queue` / `resume` / `compact` / `steer` / `diff` / `mode` / `model` / `export` / `task` / `dirs` / `tree` 全绿，`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/TreePanel.tsx` | 新文件：树形面板，`你`/`它` 标签，悬停出「重来」 |
| `apps/desktop/electron/hostRuntime.ts` | `sessionTree`（过滤系统节点）/ `navigateTree` / `historyToUiMessage` |
| `apps/desktop/src/shared/ipc.ts` | `TreeEntry` / `NavigateResult`，`messages` 必须随回退返回 |
| `apps/desktop/electron/main.ts` / `preload.ts` | 两条 IPC |
| `apps/desktop/electron/autotest.ts` | `runTreeTest`（含「对话区不能空」断言） |
| `apps/desktop/src/App.tsx` / `devMock.ts` / `styles/app.css` | 接入与样式 |
| `apps/spike/src/probeTree.ts` | 一次性探测脚本 |

## 已知限制

- **工作区文件不回退**。回退只改对话分支，`turn_diff` 里那些改动仍在磁盘上。这是最需要注意的一点。
- 数据库里被丢弃的那一支消息仍在（作为历史存档），只是不显示
- 回退后 `turnDiff` / `tasks` 面板不清空，可能显示上一支的内容
- `summarize` 选项没接（回退时不做摘要，避免额外调模型）

## 下一步（A 类剩余）

- 回退到某条消息的文件回滚（`previewRewindFiles` / `commitRewindFiles`）——**把对话回退和文件回滚对齐**
- 图片（`image` 事件，先确认 deepseek 支不支持视觉输入）
- `APP_MODELS` 多端点（endpoint 字段目前没传给 pi）
