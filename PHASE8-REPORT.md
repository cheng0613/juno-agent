# Phase 8：本轮改动面板（`turn_diff`）

A 类第二项。原本以为是把引擎的 `turn_diff` 事件接上，动手前发现了个关键事实，做法全变了。

---

## 一个推翻了原计划的发现

**pi 根本不发 `turn_diff`。**

```
grep 'turn_diff' agents/  →  只有 agents/codex/index.ts:3780
```

`Capabilities` 里也没有 `turnDiff` 声明，pi 实现里连 diff 相关代码都没有。我们跑的是 pi，所以这个能力**没有现成的可接**，只能自己在宿主侧算。

（这也解释了为什么之前 `HostEvent` 里没这条 —— 不是漏了，是源头没有。）

---

## 怎么算的

### 否决的方案：全量文件快照

轮开始前扫一遍工作目录、结束后再扫一遍做对比。听起来通用，但实测本项目是 **1653 个文件 / 764MB**——每轮前后各扫一遍，对话会明显卡顿。否决。

### 采用的方案：git 优先 + 路径兜底

| 场景 | 做法 | 能给出什么 |
|---|---|---|
| 工作目录是 git 仓库 | 轮开始时记基准，结束后 `git diff --numstat` + `git diff` | 精确的行级 diff、增删行数、新增/修改判断 |
| 不是 git 仓库 | 收集本轮 `tool_use` 碰过的路径 | 只列「动过哪些文件」，无行级 diff |

非 git 场景有意不显示假 diff——宁可明说「看不到具体改动」，也不扫全盘凑一个。

### 三个实现细节

**1. 只管本轮工作目录那一块。** 用户的工作目录可能是大仓库里的子目录，直接 `git diff` 会把仓库里其他人的改动也算进来，那不是「这一轮」改的。用 `git diff --relative -- .` 限定范围。

**2. 未跟踪的新文件要自己拼 diff。** `git diff HEAD` 不包含未跟踪文件——这是第一版跑出来的 bug：面板列出了 `note.txt` 但点开是空的。补了 `git ls-files --others` 拿到新文件列表，再自己拼一段标准 unified diff（`diff --git` / `new file mode` / `--- /dev/null` / `+++` / `@@` / `+行`），格式对齐 git，前端的分节解析才认。

**3. 基准必须在 `send()` 之前拍。** `send()` 一返回模型可能已经开始写文件了，晚一步就漏掉最早的改动。

---

## UI 取舍

**默认只列文件名 + 增删行数，点开才看 diff。** 绝大多数时候用户只关心「它动了哪几个文件」，一上来铺几百行 diff 反而看不清重点。

**面板是挤压式不是覆盖式。** 第一版绝对定位盖在对话上，截图里「有什么可以帮你」被切掉一半，看着像布局坏了。改成：
- 用 `.main:has(.diff-panel)` 让对话区自动让位
- 面板从顶栏下方开始（不盖住会话名和按钮）
- 到输入区上方结束（不遮输入框）

`bottom` 用的是估算高度变量，不是真测量——输入框是固定高度所以够用，但如果以后输入区做自适应高度需要改真测量。

**关掉不丢。** 面板收起后顶栏留一个「改动 N」按钮，随时能再打开。切会话/新建会话会清掉——上一轮的改动不该挂在新会话上。

---

## 验收

真让模型改文件，不是造数据：

```
[autotest/diff] 已把工作目录初始化为 git 仓库
[autotest/diff] 列出的文件: ["note.txt"]
[autotest/diff] 标题: 1 个文件改动 +2
[autotest/diff] 事件: {"tracked":true,"changes":[{"path":"note.txt","status":"added","insertions":2,"deletions":0}]}
[autotest/diff] diff 行数: 6
```

面板截图确认：`+hello` 绿底、hunk 头灰显、格式正确。

**测试里的一个坑**：想展开 diff 正文时，直接 `details.open = true` 不行——React 不认外部改的 DOM 属性，下一次重渲染会把 `open` 抹掉，截图抓到的还是折叠状态。改成模拟点击 `<summary>`。

---

## 七个模式全部通过

| 模式 | 结果 |
|---|---|
| `1` | 15 段流式 / 160 字 ✅ |
| `permission` | 第二轮 0 次弹窗 ✅ |
| `queue` | 3 轮全 done ✅ |
| `compact` | 边界落库/渲染 ✅ |
| `resume` | 横幅归零 ✅ |
| `steer` | 插话后停在 5 ✅ |
| `diff` | 列出 note.txt + 正文渲染 ✅ |

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/turnDiff.ts` | 新文件：基准、收集、新文件合成 patch |
| `apps/desktop/electron/hostRuntime.ts` | `turnTrace` 基准与路径追踪、`finishTurnDiff` |
| `apps/desktop/electron/autotest.ts` | `runDiffTest` + git 初始化 |
| `apps/desktop/src/DiffPanel.tsx` | 新文件：面板与 diff 按文件分节 |
| `apps/desktop/src/shared/ipc.ts` | `turn_diff` 事件、`FileChange`、`TurnDiffPayload` |
| `apps/desktop/src/App.tsx` | 面板状态、顶栏入口、切会话清理 |
| `apps/desktop/src/styles/app.css` | 面板样式、`:has()` 挤压布局 |

## 已知限制

- 非 git 目录只有文件名，没有行级 diff
- 面板不跟随流式更新（要等轮结束才出）——上游 codex 是流式推的，pi 没有这个事件，我们只能事后算
- `bottom` 用的是估算高度，输入区若改成自适应高度需改为真实测量
- 二进制文件不在 diff 里显示增删行数（git 给的是 `-`，按 0 处理）

## 下一步（A 类剩余）

- 权限档位 `setPermissionMode()`（6 种模式）
- 计划模式 `setPlanMode()`
- 思考档位 / Fast mode
- 模型热切换
- 后台任务 + 子任务进度
- 回退到某条消息
