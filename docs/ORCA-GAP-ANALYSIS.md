# Cindy ORCA 与我们实现的差距

对比对象：
- `packages/lizi-mcps/src/orca/server.ts`（606 行，18 个派活工具）
- `packages/orca-workflow/src/orca-bridge-mcp.ts`（1048 行，worker 侧工具 + 跨 harness 注入）
- 我们的 `apps/desktop/electron/orcaToolServer.ts`（315 行，4 个工具）

---

## 一、最关键的差距：注入机制不同

### Cindy：用 `McpProvider` 抽象

```ts
// maker-core/src/interfaces/mcp-provider.ts
export interface McpProvider {
  name: string;
  isEnabled?(context: McpProviderContext): boolean;
  /** Claude SDK 形态 */
  toClaudeSdkConfig?(context): unknown | null;
  /** Codex 形态 */
  toCodexMcpConfig?(context): CodexHttpMcpServerConfig | null;
  getExtraEnv?(context): Promise<Record<string, string> | null> | ...;
}
```

`orca-bridge-mcp.ts` 的实现：

```ts
return {
  name: 'orca_worker_bridge',
  isEnabled: (ctx) =>
    ctx.vendorOptions?.orcaRole === 'worker'
    || ctx.vendorOptions?.orcaRemoteWorker === true
    || ctx.agentKind === 'codex'
    || (ctx.agentKind === 'pi' && typeof ctx.getSessionContext === 'function'),
  toClaudeSdkConfig: (ctx) => { /* in-process McpServer */ },
  toCodexMcpConfig: (ctx) => { /* HTTP config */ },
  …
}
```

**一份工具定义，三种注入形态**（Claude SDK / Codex HTTP / pi bridge）。

### 我们：写死 `LOCAL_AGENT_CLIENT`

```ts
this.maker.createSession({
  agentKind: 'pi',                    // ← 写死
  [LOCAL_AGENT_CLIENT]: {
    url: this.orcaTools.url,
    token: pendingToken,
    mcpName: 'orca',
  },
})
```

**只能在 pi 上用。** 换 harness 就没了。

### 影响

| | Cindy | 我们 |
|---|---|---|
| 支持的 harness | claude-code / codex / pi（+ 别人新加的 codebuddy） | 仅 pi |
| 加新 harness 要做什么 | 什么都不用做 | 重写注入层 |
| 远程 worker | 支持（`remoteHostId` + `execution_device_id`） | 不支持 |

---

## 二、工具数量：18 vs 4

### Cindy 的 18 个（`orca/server.ts`）

| 类别 | 工具 |
|---|---|
| 团队生命周期 | `start_team` / `end_team` |
| 建 worker | `create_worker` / `create_workers`（批量） |
| 派活 | `send_to_worker` / `interrupt_worker` |
| **消息队列（6 个）** | `get_worker_queue_status` / `update_queued_message` / `cancel_queued_message` / `merge_queued_messages` / `steer_queued_message` / `move_queued_message` |
| 查看 | `list_workers` / `switch_focus` |
| 管理 | `idle_worker` / `archive_worker` / `update_worker` |
| 模型 | `list_available_models` |

### 我们的 4 个

`create_worker` / `send_to_worker` / `list_workers` / `send_to_lead`

### worker 侧：Cindy 4 个 vs 我们 1 个

| Cindy | 作用 | 我们 |
|---|---|---|
| `send_to_lead` | 回报（支持 `delivery: queue\|steer`） | ✅ 有 |
| `lead_status` | 查 lead 状态 | ❌ |
| `read_lead` | 读 lead 最近消息 | ❌ |
| `read_lead_history` | 读 lead 历史 | ❌ |

**这三个的意义**：worker 能自己判断"lead 在忙什么"，不用每次回报都问一遍。

---

## 三、Cindy 早踩过我们踩的坑

`orca/server.ts` 开头的注释：

> **为什么直接注册而非走入口**：协同工具藏在 list_tools/call_tool 后面时，
> 模型在用户说"开协同 / 派 worker"时**往往发现不了 start_team**，
> 反而误抓直接可见的 send_to_session（产普通独立 session，不进入 team/worker 控制面）。
> 把协同工具提到顶层直接可见后，"开协同 → start_team" 的路由才确定。

**这正是我们卡了三轮的问题**——模型发 `mcp:orca:create_worker`（编的名字），
因为真正的工具藏在 `cindy_mcp_call_tool` 二段式网关后面。

Cindy 的结论：**宁可让 schema 进系统提示前缀（固定成本），换路由可靠性。**

---

## 四、插件化开关

```ts
// 独立成 server（从 cindy_helper 拆出）：让协同能力成为用户可关的插件
// ("协同模式"开关 gate 整个 cindy_orca server)
```

我们：工具**永远挂着**，没有开关。

这在之前讨论"A/B 都保留"时说过要做，还没做。

---

## 五、其他差异

| 项 | Cindy | 我们 |
|---|---|---|
| 并发上限 | soft 5 / hard 8 | ✅ 相同（实测值一致） |
| worktree 隔离 | `owns_worktree` 显式标记 + 回收 | ✅ 有，但没显式所有权概念 |
| worker 持久化 | 完整 rehydrate（含 `sdkSessionId`、`remoteHostId`） | 部分（重启后状态可能丢） |
| 崩溃恢复 | `orcaStrandedLeadReconcile` / `orcaIdleReleaseWatcher` | ❌ 无 |
| 诊断 | `orcaDiagnostics.ts` | 刚做了错误翻译 |
| 队列持久化 | 数据库表 | ❌ 内存 |

---

## 六、差距量化

| 维度 | Cindy | 我们 | 完成度 |
|---|---|---|---|
| 派活工具 | 18 | 4 | **22%** |
| worker 侧工具 | 4 | 1 | 25% |
| 支持 harness | 3+ | 1 | 33% |
| 注入机制 | 抽象接口 | 写死 | **结构性差距** |
| 消息队列 | 6 个工具 + 落库 | 无 | 0% |
| 崩溃恢复 | 2 个模块 | 无 | 0% |

**代码量**：Cindy ORCA 约 1650 行（不含宿主胶水），我们 315 行。

---

## 七、该优先补什么

按「决定能不能用」排序：

### P0：改用 `McpProvider`（结构性）

不做这个，将来想支持 codebuddy / claude-code 就得重写。

而且**可能顺带解决工具调不动的问题**——`McpProvider` 是原生注册，
不走 `cindy_mcp_call_tool` 二段网关，模型能直接看到 `create_worker`。

> 这也解释了为什么 Cindy 说「直接注册，路由才确定」。

**成本：半天。风险：低（接口现成，maker-core 里就有）。**

### P1：`start_team` / `end_team`

现在我们是「建第一个 worker 时隐式建 team」。Cindy 是显式 `start_team`。

**好处**：模型有个明确的"开始协同"动作，不用猜。
而且 `start_team` 的 description 可以写清「用户什么时候该用协同」——这是引导模型的关键。

**成本：2 小时。**

### P2：worker 侧 `lead_status` / `read_lead`

worker 能自己判断 lead 在忙什么，少一次来回。

**成本：2 小时。**

### P3：消息队列 6 个工具

复杂但价值明确：lead 一次能排多条指令，不用等 worker 干完。

**成本：1 天。**

### 不做

- 远程 worker（`execution_device_id`）：你自己用，没多设备需求
- 崩溃恢复两个模块：等真出问题再说

---

## 八、一句话结论

**我们的 ORCA 是「能跑通的最小实现」，Cindy 的是「给团队用的产品」。**

差的不是功能数量，是**架构选择**：

- 它把 ORCA 做成 **host 注入的 McpProvider**，所以跨 harness 天然可用
- 我们把 ORCA 做成 **pi 专用的 MCP server**，所以绑死在一个 harness 上

**建议先做 P0（改 McpProvider）**——它可能顺手解决工具调不动的问题，
而且不改的话，P1-P3 都是在错误的地基上叠砖。

---

## 九、补充：身份传递机制（比我原先判断的更关键）

我原本以为差距只在「能不能跨 harness」。查完 `piEnvironment.ts` 后发现还有一层：

### Cindy：AsyncLocalStorage 恢复 session 上下文

```ts
// piEnvironment.ts doStart()
const ctx: McpProviderContext = {
  agentKind: 'pi',
  workingDir: '',
  vendorOptions: {},
  getSessionContext: () => {
    const active = getLiziMcpSessionContext();   // ← AsyncLocalStorage
    if (active?.agentKind !== 'pi' && …) return undefined;
    return { sessionId: active.sessionId, vendorOptions: active.vendorOptions, … };
  },
};
```

bridge 的 `?session=` 路由在 `runWithLiziMcpSessionContext` 里注入 ALS，
工具 handler 调 `getSessionContext()` 就能拿到「当前是谁在调」。

### 我们：token 反查

```ts
resolveToken: (token) => {
  const id = this.orcaTokens.get(token);
  if (!id) return null;
  return { role: 'lead', sessionId: id.sessionId };
}
```

**两种方案对比**：

| | Cindy (ALS) | 我们 (token) |
|---|---|---|
| 依赖 | Node 内置机制 | 自己维护 Map |
| 多 worker 并发 | 天然隔离 | 靠 token 区分（已实现） |
| 泄漏风险 | 上下文没设 = 拿不到身份，直接拒绝 | token 泄漏 = 冒名顶替 |
| 代码量 | 一个回调 | Map + 生命周期管理 |

**我们目前的 token 方案是对的**（多 worker 并发已验证），
但如果改用 McpProvider，ALS 是更好的选择——少一份状态要维护。

---

## 十、改 McpProvider 的具体路径

`maker-core` 已经支持，不需要改引擎：

```ts
// 现状（hostRuntime.ts）
this.maker = new Maker({ agents: { pi: agent }, storage, logger });

// 改成
this.maker = new Maker({
  agents: { pi: agent },
  storage,
  logger,
  mcpProviders: [this.orcaProvider],   // ← 新增
});
```

`createPiAgent` 侧已经有 `deps.mcpProviders`（`pi/index.ts:3784` 在用），
但需要宿主提供 `preparePiExtraSpawnConfig`——**这是目前缺的那块**。

参照 `pi-host.ts:2034` 的实现：

```ts
createPiAgent({
  …,
  preparePiExtraSpawnConfig: async (providers, ctx) => {
    // 1. 过滤出 isEnabled 的 provider
    // 2. 每个 provider 调 toClaudeSdkConfig / 转成 bridge server
    // 3. 启动本地 HTTP bridge，返回 { mcpBridge: { servers, token } }
  },
})
```

**估算**：半天。风险点是 `preparePiExtraSpawnConfig` 的类型契约要摸清
（返回值形状、生命周期、shutdown 语义）。

---

## 十一、修正：McpProvider 不解决「模型找不到工具」

我之前判断「改 McpProvider 可能顺带解决工具调不动的问题」，**验证后是错的**。

### 实测结果

改成 `McpProvider` + `preparePiExtraSpawnConfig` 后：

```
[host/pi] pi startup stage { stage: 'mcp-ready', mcpServerCount: 1, status: 'ok' }
[orca/tools] REQ POST /mcp   ← bridge 连上了
[cindy-bridge] MCP gateway ready (3 tools)
```

但让模型列工具，还是：

```
read / bash / edit / write / ask_user_question / grep / find / ls
powershell / cindy_mcp_list_tools / cindy_mcp_call_tool / subagent
```

**没有 `create_worker`。**

### 为什么

`preparePiExtraSpawnConfig` 和 `LOCAL_AGENT_CLIENT` **本质是同一个通道** ——
都产出 `mcpBridge: { token, servers }`，pi 拿到后统一走
`cindy_mcp_list_tools` + `cindy_mcp_call_tool` 二段网关。

pi 的架构里**没有旁路**：任何 MCP server 进 pi 都要过网关。
我搜了 `directExpose` / `passthrough` / `bypassGateway`，都不存在。

### Cindy 的「顶层直接注册」是什么意思

`orca/server.ts` 说的是相对 **`cindy_helper` 的二级入口**：

> 协同工具藏在 list_tools/call_tool 后面时…… 提到顶层直接可见后
> 代价是这些工具 schema 进系统提示前缀（固定成本、缓存稳定）

指的是「挂在 `cindy_orca` server 顶层，而不是再套一层 `cindy_helper.call_tool`」。
**但 `cindy_orca` 本身进 pi 仍要过网关。**

所以 Cindy 在 pi 上跑 ORCA 时，模型同样需要先 discover 再 call。
它优化的是**少一层嵌套**，不是完全绕过。

### 那 Cindy 为什么能用

它支持的 **claude-code / codex** 是直连 MCP（`toClaudeSdkConfig` /
`toCodexMcpConfig`），工具直接进模型视野。**只有 pi 受网关限制。**

这反过来说明：**pi 不是一个适合跑 ORCA lead 的 harness。**

### 这对我们意味着什么

改 McpProvider 的价值变成两个（都不是原目标）：

1. **跨 harness 复用**：将来接 claude-code / codex，ORCA 定义一行不用改
2. **代码更干净**：工具定义和注入方式解耦，不用手动管 token 生命周期

但**pi 上「模型自主派活」依然走不通**，除非：
- 换 harness（接 claude-code 或 codex）
- 或接受「模型必须走 cindy_mcp_call_tool」这个现实，用提示词引导（试过，两个模型都不听）

**当前 McpProvider 改造已提交（代码更好，但没解决核心问题）。**
