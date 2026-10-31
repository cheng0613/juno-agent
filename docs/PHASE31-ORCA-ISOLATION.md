# ORCA 阶段一补：工作区隔离 + 权限档位

用户问了一个关键问题：**多个 worker 改同一个文件会不会出问题？**

会。而且是**静默失败**。

---

## 问题

| 时序 | 后果 |
|---|---|
| A 读 → B 写 → A 写 | B 的修改**静默消失**，没人报错 |
| A、B 同时写 | 后写的赢，前一个的改动没了 |
| A 删 → B 接着改 | B 拿到「文件不存在」再重建，内容回到 A 删除前 |

宿主没有文件锁，pi 进程之间互相不知道对方存在。

### 这跟权限档位是两码事

```
bypassPermissions  ← 去掉「危险操作问一下」这道闸
worktree 隔离       ← 提供「改坏了能还原」这道保险
```

用户要求默认 `bypassPermissions`。但如果**同时**没有隔离，两道都没了：
用户跑完发现文件被改乱，既不知道是谁干的，也没法退回去。

所以这次一起做：**隔离 + 默认全放行**。

---

## 做法：每个 worker 一个 git worktree

```
项目/
├── .juno/worktrees/developer/    ← worker 1 在这干活
├── .juno/worktrees/reviewer/     ← worker 2 在这干活
└── （根目录）/                    ← Lead 和用户在这
```

用 `git worktree add --detach <path> HEAD`：

- **物理隔离**，并发写根本不会发生
- **不创建分支**（detached HEAD），不污染用户的 `git branch` 列表
- 一条命令，成本很低

### 三条降级规则

**① 不是 git 仓库 → 共享目录 + 权限降回 `auto`**

没有隔离还全放行，风险是叠加的。所以：

```ts
const permissionMode = isolation.isolated ? 'bypassPermissions' : 'auto';
```

**② worktree 建失败 → 同样降级**

宁可让 worker 干活（有覆盖风险），也不要因为 git 出问题就完全不能用。

**③ 用户显式 `isolate: false` → 照办**

---

## 踩到的坑：`git rev-parse` 会向上找父仓库

测试里我让一个 worker 用 `.appdata/plain-dir`（不是 git 仓库），
预期降级为共享 —— 结果它被判定为「已隔离」。

原因：`plain-dir` 嵌在 `.appdata/workspace`（一个 git 仓库）下面，
`git rev-parse --show-toplevel` 一路向上找到了父仓库。

**这不是测试环境特有的问题**：用户把项目放在 monorepo 的子目录里、
或者 `node_modules`、构建输出目录，都会踩到。

修法：要求 `cwd` **在**仓库里，且**不能被 .gitignore 忽略**：

```ts
const rel = path.relative(root, path.resolve(cwd));
if (rel.startsWith('..')) return null;

// 被忽略的子目录（.appdata、node_modules）不当作独立仓库根
if (rel) {
  await git(root, ['check-ignore', '--quiet', rel]);  // 成功 = 被忽略 = 不算
}
```

---

## 权限档位可以随时切换

用户明确要求「可以切换」，所以：

| 切换什么 | 方法 | 生效时机 |
|---|---|---|
| 权限档位 | `setPermissionMode(sessionId, mode)` | 立即，轮进行中也行 |
| 工作区隔离 | `setWorkerIsolation(workerId, isolated)` | 立即（会话目录切过去） |

**切隔离不搬文件。** 切过去之后 worker 看到的是新目录的内容，
之前那份的改动留在原地不动 —— 搬文件会把两边改动混在一起，那才是真会丢数据。

### 顺带修了一个真 bug：权限档位不落库

原来的 `setPermissionMode` 只改引擎内存，**没有任何地方写回数据库**。

后果：重启后权限档位悄悄变回建会话时的默认值。

对 worker 尤其危险——明明是 `bypassPermissions`，重启后变成 `ask`，
后台跑的任务**全都卡在等确认上**，而且用户看不出为什么。

已修：宿主在 `setPermissionMode` 里写回 `sessions.permission_mode`。

> 这也是验收容易假通过的地方：如果只读数据库断言，
> 会因为「数据库里本来就是默认值」而误判。验收里改成从**引擎**读真实值
> （`session.permissionModeState.mode`）。

---

## 验收

新增 autotest 模式 **`orca-iso`**（第 28 个）。13 项断言：

| 断言 | 结果 |
|---|---|
| 两个 worker 工作目录不同 | ✓ |
| worker 目录 ≠ Lead 目录 | ✓ |
| w1 标记 `isolated=true` | ✓ |
| w1 写的文件**不漏到** w2 | ✓ |
| w1 写的文件**不漏到主目录** | ✓ |
| 隔离时权限 = `bypassPermissions` | ✓ |
| 切成共享 → `isolated=false`、目录=Lead 目录 | ✓ |
| 再切回隔离 → `isolated=true`、目录回 worktree | ✓ |
| 非 git 目录 → `isolated=false`、原因 `not-a-git-repo` | ✓ |
| 非 git 目录权限**降回** `auto` | ✓ |
| 手动改成 `bypassPermissions` 生效 | ✓ |

```
w1 目录: .../.juno/worktrees/developer
w2 目录: .../.juno/worktrees/reviewer
w1 写的文件是否漏到 w2: false
w1 写的文件是否漏到主目录: false
w1 权限档位: bypassPermissions
非 git 目录: isolated=false, reason=not-a-git-repo
非 git 目录的权限档位: auto
```

回归：`orca` / `permission` / `rewind` / `mode` 全过。

---

## 已知限制

- **worktree 不会自动合并**。worker 改完的代码留在自己的目录里，
  要用户或 `merger` 角色手动处理。自动合并策略（谁来合、冲突怎么办）
  是阶段三以后的事。
- **worktree 不会自动清理**。worker 移除时删，但直接关掉 app 会留下目录。
  用户可以手动删 `.juno/worktrees/`。
- **未跟踪文件不复制**：`git worktree add` 只带已提交的内容。
  主目录里有没提交的改动，worker 看不到。这是 git 的语义，不是 bug，
  但用户可能会意外——阶段二要在 UI 上提示。
- 同一 label 重建 worktree 会 `--force` 删除旧的，**旧目录里的未保存改动会丢**。

---

## 文件

| 文件 | 内容 |
|---|---|
| `apps/desktop/electron/workerWorktree.ts` | 新增，worktree 生命周期（~160 行） |
| `packages/host-core/src/db/schema.ts` | migration v8（`working_dir` / `isolated` / `isolation_reason`） |
| `packages/host-core/src/db/orcaStore.ts` | `addWorker` 写三列 |
| `packages/host-core/src/orca/types.ts` | `isolate` / `permissionMode` 配置、`isolated` 字段 |
| `apps/desktop/electron/hostRuntime.ts` | `createWorker` 接隔离、`setWorkerIsolation`、权限落库 |
| `apps/desktop/electron/autotest.ts` | `runOrcaIsolationTest` |
