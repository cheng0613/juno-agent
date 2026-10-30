# Phase 2 报告 · 持久化与中断恢复

> 日期：2026-10-30
> 目标：会话与消息真正落盘，进程重启后能识别「上次被中断的任务」。
> 结论：**完成，6/6 自检通过 + 真实链路落库验证通过。**

---

## 1. 做了什么

| 模块 | 文件 | 作用 |
|---|---|---|
| Schema + 迁移 | `src/db/schema.ts` · `src/db/open.ts` | 5 张表 + 版本化迁移 |
| 会话存储 | `src/db/sqliteSessionStorage.ts` | `SessionStorage` 的 SQLite 实现（宿主契约注入点） |
| 消息存储 | `src/db/messageStore.ts` | 幂等写入 / rewind / 墓碑 |
| 轮次存储 | `src/db/turnStore.ts` | 中断恢复骨架 |
| 事件胶水 | `src/recorder.ts` | `AgentEvent` → DB 行 |
| 自检 | `src/selftest.ts` | 6 项语义断言，不需要 API key |
| 开发工具 | `inspect.mjs` · `simulate-crash.mjs` | 看库 / 模拟崩溃 |

Phase 1 的 `MemorySessionStorage` 已被 `SqliteSessionStorage` 取代（保留在 `host.ts` 里作参考实现）。

---

## 2. 表设计：5 张表，每一张都在替上游还债

### `sessions`
持久态**只有** `active / archived / deleted`。

> ⚠️ 这里有一条上游踩过的坑，直接抄进注释了：运行态（是否正在跑）**绝不能写进 `sessions.status`**。
> 上游把 SDK 的运行瞬态和产品生命周期混用一个 `status` 列，结果被 storage adapter 错误
> coerce 成 `archived`，**把正在运行的会话误标归档**。运行态归 `turns`，内存态归 `activeSessions`。

### `messages`
- `client_id` + `UNIQUE(session_id, client_id)` → 写入天然幂等
- `rewind_at` 软删，读取一律 `IS NULL`
- `agent_kind` 逐行 denormalize → 引擎切换后历史行仍按写入时引擎解析
- `content` / `agent_meta` 存 JSON（与上游同构，不拆 blocks 表）

### `turns` ← 中断恢复的核心
每轮一行，`state='running'` 的行就是「可能被中断的轮」。
- `user_client_id` 记录触发本轮的 user 消息 → 续跑时「有产出发续跑指令 / 零产出重发原文」要靠它找回
- 部分索引 `WHERE state='running'` → 启动期扫描是热路径

### `usage_events`
逐轮 token 与成本，可由它重算 `sessions` 上的累计展示值（那里只是读优化）。

### `attachments`
只存路径 + sha256，不存 blob。

---

## 3. 自检抓到的真 bug

自检第一次跑：**5/6**，挂在「中断恢复」这一项。

```
✗ 中断恢复：停在 running 的轮被标记为 interrupted
    状态应落为 interrupted
  + 'done'
  - 'interrupted'
```

原因：同一毫秒内创建的两轮，`ORDER BY started_at DESC` 排序不确定，`last()` 返回了已收口的那一轮。

**这正是我在 schema 注释里写下、实现时却漏掉的「同毫秒要用 rowid 兜底」。**
修法是所有 turns 排序都加 `, rowid DESC`。修完 6/6。

> 这就是为什么要把数据层语义写成可执行断言，而不是只写在文档里 ——
> 文档里的原则不会自己执行。

---

## 4. 验证证据

### 4.1 自检（`node dist/selftest.js`，无需 API key）

```
✓ 消息幂等：同 clientId 写两次只有一行
✓ Rewind：锚点及之后的消息全部隐藏
✓ CAS：sdkSessionId 只有值匹配时才清空
✓ 中断恢复：停在 running 的轮被标记为 interrupted
✓ 软删：delete 后 get 返回 null，但行仍在库里
✓ 外键：删会话时消息级联删除

6/6 通过
```

### 4.2 真实链路落库

```
[spike] spike finished {"ok":true,"elapsedMs":1540,"messageCount":2,
                        "lastTurnState":"error","roles":["user","error"]}
```

库里实际内容（`node inspect.mjs`）：

```
sessions : 1 行, agent_kind='pi', status='active', has_sdk=1
messages : user  {"text":"列出当前目录的文件"}  agent_kind='pi'
           error {"message":"403 ...","isTerminal":true}
turns    : state='error', attempt=1, error_terminal=1
migrations: version=1 name='init'
```

注意 `lastTurnState: "error"` —— 4xx 是终结性错误，turn 被正确收口，
下次启动不会被误判成「被中断」。

### 4.3 中断恢复

注入一个停在 `running` 的轮后重启：

```
[spike] found interrupted turns {"count":1,"turns":[
  {"sessionId":"3fb4832d-...","turnId":"e3c17368-...","userClientId":"10d870c2-..."}
]}
```

`turnId` 和 `userClientId` 都被完整带回 —— 续跑所需的两个关键信息都有。

---

## 5. 刻意推迟的部分

| 项 | 为什么推迟 |
|---|---|
| FTS 全文搜索 | 上游有个坑值得提前记住：TEXT 主键的隐式 rowid 在 VACUUM 后会变，不能直接当 FTS 关联键，必须建独立整数行号映射表。Phase 4 再做。 |
| 输入队列持久化 | 单机单用户下队列在内存即可；等做多端才需要快照表 |
| 附件落盘 | 表已建，blob 存储等媒体需求明确后再说 |
| `MakerMemory` | 可选注入，需要 `better-sqlite3` 的 `sqliteFactory`；记忆功能本身是 Phase 4 |
| 真实文本回复 | 仍缺 API key |

---

## 6. 一个设计确认

`better-sqlite3` 是 `maker-core` 的 **optional peer**，但我们自己装了它 —— 因为
`MakerMemoryManager` 的 `sqliteFactory` 需要。目前没启用 memory，所以它只服务于我们自己的数据层。
Node 22 的 `node:sqlite` 也可以跑，但 Electron 里 `better-sqlite3` 更成熟，保持不变。

---

## 7. 补充（同日追加）：接真实端点后暴露的 3 个缺口

拿到真实 API key（OpenAI 兼容端点 + `deepseek-v4.1-flash-1017`）后，Phase 1 遗留的
「只差有效 key」假设被验证 —— 但立刻暴出 3 个之前不可能发现的问题。

### 7.1 协议写死：`resolvePiGatewayModelApi` 必须可配

`host.ts` 原来硬编码 `() => 'anthropic-messages'`。打 OpenAI 兼容端点（`/v1`）时
请求会直接打歪。改成 `SPIKE_API` 可配。

> 幂等细节：`piOpenAiBaseUrl()` 会自动补 `/v1`，传不传都行 —— 但 Anthropic 协议下
> baseUrl **不能**带 `/v1`（Pi 自己会追加 `/v1/messages`）。两种协议的 baseUrl 语义不同。

### 7.2 ⚠️ 审批通道没挂：所有写操作被静默拒绝

最有价值的一个发现。**不调 `session.setInteractionListener()`，Pi 的写文件 / 执行命令工具
会全部以 `no_listener_attached` 被静默拒绝**，只有只读工具能用。

表面症状极具欺骗性：
- 创建会话时只有一行 `project resource assembly snapshot ... "reason":"approval-resolver-unavailable"`
- agent 看起来正常运行，`ls` 之类的只读工具一切正常
- 一旦要写文件，就是一串莫名其妙的失败

修复：`src/approval.ts`，统一处理 `permission` / `ask_user_question` / `plan_review`
三种交互，由 `SPIKE_APPROVAL` 控制 `allow` / `deny` / `ask`。

```ts
session.setInteractionListener(createConsoleApproval({ mode: APPROVAL, logger }));
```

> 产品含义：**审批 UI 不是可选的加分项，是工具能力的前提。**
> Phase 3 的对话框优先级要提到「工具卡片」之前。

### 7.3 事件映射两处纠正

| 问题 | 现象 | 修正 |
|---|---|---|
| `tool_result` 只存了摘要 `{summary:'done'}` | 工具输出全丢 | 真正的输出在 **`tool_result_full`**（`{toolUseId, fullText, isError}`）。改为由它落库，随后的 `tool_result` 摘要事件跳过 |
| `usage_events` 一直是空表 | 成本/token 无记录 | Pi 的用量挂在 `text` 事件的 **`agentMeta.usage`**（`{input,output,cacheRead,cacheWrite,cost}`），不从 `account_usage` 来 |

修完后的真实一轮（`node inspect.mjs --last`）：

```
[tool_use]    tool=call_00_  {"toolName":"bash","input":{"command":"uname -a"}}
[tool_use]    tool=call_01_  {"toolName":"powershell","input":{"command":"ver"}}
[tool_result] tool=call_00_  {"fullText":"MINGW64_NT-10.0-26300 ...","isError":false}
[tool_result] tool=call_01_  {"fullText":"ver : 无法将“ver”项识别...","isError":true}
[assistant]   "`uname -a` 的输出（原样）：..."

turns: state=done
usage_events: input=390 output=146 cache_read=3968 cost=0
```

`isError: true` 的失败工具调用也正确落库了 —— 这是 UI 上要显示红叉的那类。

### 7.4 本次验证到的完整能力矩阵

| 能力 | 状态 |
|---|---|
| 文本回复流式 → 落库 | ✅ |
| 工具调用（bash / powershell） | ✅ |
| 审批通道（auto-allow） | ✅ |
| 工具完整输出 + 成功/失败标记 | ✅ |
| token 用量落库 | ✅（成本上游不报，为 0）|
| 多工具并发调用 | ✅（一轮 2 个 tool_use） |
| 错误工具结果可见 | ✅ |

### 7.5 遗留

- 上游网关不报 `cost`，`cost_amount` 恒为 0。需要时得自带价目表算
- `thinking` 事件未观察到（该模型可能不发推理块），thinking 落库路径未经真实数据检验

---

## 8. Phase 2 门禁判定

| 判据 | 结果 |
|---|---|
| 会话能落盘 | ✅ |
| 消息能落盘且幂等 | ✅ |
| 中断任务能被识别 | ✅（并带回续跑所需信息） |
| 数据层语义有可执行断言 | ✅ 6 项 |
| 真实文本回复 | ✅（见 §7） |
| 真实工具调用 + 审批 | ✅（见 §7） |

**→ 通过，进入 Phase 3（Electron 外壳 + 对话 UI）。**

> §7 的发现会改变 Phase 3 的排期：审批对话框必须在工具卡片之前做完，
> 否则一半工具能力用不了。
