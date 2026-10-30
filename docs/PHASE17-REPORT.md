# Phase 17：文件回滚（git savepoint）

A 类最后一项，也是清单里风险最高的一项。补的是 Phase 15 点名的那个缺口：**回退只改对话分支，磁盘上的文件改动仍在**。

---

## 为什么这个缺口必须补

用户点「从这里重来」时的心理预期是「回到那一刻」——包括文件。

实际情况（Phase 15 之后）：对话退回了，但 `target.txt` 还是被改过的版本。模型拿着旧对话、文件却是新的，用户以为万事大吉。**这种不一致比不支持回退更糟**，因为它会让人建立错误的信任。

---

## 上游的做法 vs 我们的做法

上游 `apps/desktop/src/main/git-snapshot/` 是一套 4398 行的完整系统：隐藏 ref、shadow commit、写队列、稀疏检出、孤立 git 执行器……

全盘照搬不现实。核心机制其实很简单：

> 临时 index + `write-tree` + `commit-tree` + `update-ref`，全程不碰 HEAD、分支、用户的 index 和 worktree，也不触发 git hook。

先写了个 20 行的 shell 实验验证这个机制真的安全：

```bash
export GIT_INDEX_FILE=/tmp/test-index
git read-tree HEAD
git add -A
git write-tree          # tree=0c5ed6d
unset GIT_INDEX_FILE
git status --short      # 仍然 M f.txt —— 用户的暂存区没被碰
```

验证通过才动手实现。

---

## 实现要点

### 拍快照的时机

**必须在 `send()` 之前。** `send()` 一返回模型就可能开始改文件，晚一步拍到的已经是「改过之后」——那样的快照回滚毫无意义。

快照失败**不阻断发送**：没有快照只是不能回滚文件，对话仍然能用。日志记一笔 `reason` 供事后排查。

### 三个安全约束

| 约束 | 做法 |
|---|---|
| 不碰用户的 git 状态 | 全部用临时 `GIT_INDEX_FILE` |
| 不触发 hook | 用 `commit-tree` plumbing，不走 `git commit` |
| 有冲突时放弃 | `ls-files --unmerged` 非空就返回 `unmerged-changes`，宁可没有回滚也不把仓库搞更乱 |

另外 `GIT_OPTIONAL_LOCKS=0`，避免和用户正在跑的 git 命令抢 `index.lock`。

### 恢复时不动快照之后新建的文件

用 `read-tree` + `checkout-index -a -f` 把工作区推到那个 tree，但**不删**快照里没有的文件——它们可能是用户自己建的，静默删掉风险太大。

### 顺序：先恢复文件，再切对话

反过来的话，切完对话失败会留下「对话退了、文件没退」——最坏的情况。

而且**恢复失败就直接抛错中止**，不切对话。宁可什么都不变，也不要留下半套状态。

---

## 撞到的两个问题

### 问题 1：轮次编号是倒的

第一版按树的遍历顺序给 user 节点编号，测试里看到：

```
user 节点: [{"idx":1,"p":"只回答「好」"},{"idx":0,"p":"用 bash 把..."}]
```

第一轮是 1、第二轮是 0 —— 完全反了。

原因：pi 的树 `roots` 是**新到旧**排列的，遍历出来就是倒序。这次碰巧蒙对（因为刚好回退到第二轮），换个场景就会回滚错轮次，而且是**静默的错**。

改成按 `timestamp` 排序编号。没有 timestamp 的节点不给编号——宁愿它拿不到快照，也不要错位到别的轮上。

### 问题 2：回退后改动面板还挂着

截图里发现：文件已经恢复成 `ORIGINAL`，但右侧改动面板还显示 `target.txt +1 -1`。用户会以为「文件没退干净」。

修：回退时一并清 `turnDiff` / `diffOpen` / `tasks`——它们都属于已经退回的那条时间线。

---

## 验收：验文件字节真的变了

```
已初始化仓库，target.txt = ORIGINAL
改完后 target.txt = "MODIFIED\n"
user 节点: [{"idx":0,...},{"idx":1,...}]   ← 编号正了
回退结果: filesRestored=true
回退后 target.txt = "ORIGINAL"            ← 关键
回退后对话气泡数: 2 / 改动面板数: 0
```

比对的是磁盘上的**实际文件内容**，不是任何标志位。

---

## 十五个模式全部通过

`1` / `permission` / `queue` / `resume` / `compact` / `steer` / `diff` / `mode` / `model` / `export` / `task` / `dirs` / `tree` / `image` / `rewind` 全绿，`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/gitSavepoint.ts` | 新文件：拍快照 / 恢复 / 列快照 |
| `packages/host-core/src/db/schema.ts` | migration v5：`turns.savepoint_commit` |
| `packages/host-core/src/db/turnStore.ts` | `setSavepoint` / `getSavepoint` / `savepointForUserClientId` |
| `apps/desktop/electron/hostRuntime.ts` | `send` 前拍快照；`navigateTree` 先恢复文件再切对话；turnIndex 按时间排序 |
| `apps/desktop/src/shared/ipc.ts` | `TreeEntry.turnIndex`、`NavigateResult.filesRestored` |
| `apps/desktop/src/App.tsx` | 回退后清改动面板/子任务，提示文件是否回滚 |
| `apps/desktop/electron/autotest.ts` | `runRewindTest` |

## 已知限制

- **只在 git 仓库里工作**。不是 git 目录就没有文件回滚，UI 会明说原因而不是静默跳过
- **快照会积累**。每轮一张，`refs/juno/savepoints/<sessionId>/` 下的 ref 目前不清理
- **不恢复被删除的未跟踪文件**（把 `checkout-index` 换成 `read-tree -u --reset` 才能删，但那样会误删用户文件，风险更大，有意不做）
- **子模块变动可能被混进快照**（`git add -A` 的行为）
- 回滚不做冲突检测——如果用户在回退后手动改过文件，会被直接覆盖

## A 类收尾

到 Phase 17，A 类（引擎现成、只差接线）已全部做完：

插话 / 上下文占用 / 改动面板 / 权限档位 / 计划模式 / 思考档位 / 模型热切换 / 导出 HTML / 子任务进度 / 会话分支树 / 图片输入 / 文件回滚。

下一步该回到 **D 类（给别人用的硬门槛）**：设置页、密钥加密存储、错误边界、超时看门狗。
