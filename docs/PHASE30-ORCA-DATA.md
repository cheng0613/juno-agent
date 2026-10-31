# ORCA 阶段一：数据层

阶段一目标：让「一个 Lead 带多个 Worker」这件事**先在数据库里成立**。零模型调用，可完整单测。

---

## 数据模型

```sql
orca_teams     -- 一个 Lead 一个 active team
  id, lead_session_id, status, created_at, completed_at

orca_workers   -- worker = 独立会话 + 一条记录
  id, team_id, session_id, role, label, status, focused, idle_since,
  created_at, updated_at

sessions.orca_role   -- 'lead' | 'worker' | NULL（冗余，避免查列表 join 三张表）
```

### 三个关键决定

**① Worker 是独立会话，不是子 agent**

子 agent 是「一轮里临时派出去的活」，跑完就没了。Worker 要能：
- 持续接活（多轮）
- 被用户点进去直接对话
- 跨轮存在，重启后还在

所以它必须是 `sessions` 里的真实行。

**② 一个 Lead 只能有一个 active team**

用**部分唯一索引**表达，不是靠代码判断：

```sql
CREATE UNIQUE INDEX uniq_orca_active_team
  ON orca_teams(lead_session_id) WHERE status = 'active';
```

代码判断会漏（并发、reopen、崩溃恢复）。交给数据库，`INSERT OR IGNORE` + 重读就天然幂等。

**③ `sessions.orca_role` 冗余存储**

侧栏查会话列表时不 join 三张表。代价是两处要同步更新——集中在 `OrcaStore` 里，可接受。

---

## 并发上限：软 5 / 硬 8

不是拍脑袋，来自 `docs/BENCH-PARALLEL.md` 的实测：

| 并发 | 内存 | 延迟 |
|---|---|---|
| 1 | 497 MB | 基准 |
| 3 | 1118 MB | 几乎不变 |
| 5 | 1307 MB | 几乎不变 |
| 8 | 2244 MB | **+28%，方差变大** |

和上游 Cindy 的 `softLimit: 5 / hardLimit: 8` **完全吻合**。

硬上限在 `createWorker` 里直接报错，不静默降级：

```
worker 数量已达上限 8 个（受内存限制），请先结束一些
```

用户得知道为什么建不出来。

第一版**不开放配置**——这些值要真实使用校准，不是配置项。

---

## Label 自动去重

`createWorkerLabel('developer', ['developer'])` → `developer-2`

对齐上游同名函数。UI 永远能显示一个可辨识的名字，不用处理 null。

---

## 验收

新增 autotest 模式 **`orca`**（第 27 个）。10 项断言：

| 断言 | 结果 |
|---|---|
| 第一个 label = `developer` | ✓ |
| 撞名 → `developer-2` | ✓ |
| 显式 label `审查员` 保留 | ✓ |
| 3 个 worker = 3 个独立会话（总数 4） | ✓ |
| worker 会话 `orca_role = 'worker'` | ✓ |
| Lead 会话 `orca_role = 'lead'` | ✓ |
| `listWorkers` 返回 3 个、状态 idle | ✓ |
| 重复取 team 返回同一个 id（幂等） | ✓ |
| 建到 8 个为止都能建 | ✓ |
| 第 9 个被拒 | ✓ |

落库复查：

```
user_version: 7（新库）
teams: [{status: "active"}]
workers: developer / developer-2 / 审查员 …（共 8）
orca_role 分布: lead 1, worker 8
```

> 注意 `user_version` 显示 0 —— 这个工程用的是自建 `migrations` 表而不是 SQLite 的 user_version 字段。查 `SELECT * FROM migrations` 才是真实版本。

---

## 文件

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/host-core/src/orca/types.ts` | 118 | 常量、类型、label 去重 |
| `packages/host-core/src/db/orcaStore.ts` | 254 | 数据访问（12 个方法） |
| `packages/host-core/src/db/schema.ts` | +48 | migration v7 |
| `apps/desktop/electron/hostRuntime.ts` | +60 | `createWorker` / `listWorkers` / `orcaRoleOf` |
| `apps/desktop/electron/autotest.ts` | +120 | `runOrcaDataTest` |

---

## 下一步

阶段二：右侧 worker 面板。已经有数据可驱动，不需要模型参与就能做出可看的东西。

阶段三才需要 MCP（派活工具）—— 链路已在 `docs/SPIKE-MCP.md` 验证过。
