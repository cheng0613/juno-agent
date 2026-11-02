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

---

## 十二、接 claude-code 的探路结果（未完成）

### 好消息：CLI 能跑，链路能通

`claude.exe`（upstream 里有，v2.1.296，260MB）在本地能启动，用 sniffer 代理验证过：

```
POST /v1/messages?beta=true   ← CLI 真的发请求了
收到                          ← 模型返回
```

**缺的两个必需环境变量**（Cindy 在 `env-builder.ts` 里设的）：

```bash
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1
CLAUDE_CODE_ENTRYPOINT=claude-desktop
```

不设这两个，CLI 会在本地静默退出，**一个请求都不发**——这个现象很难查
（没有任何错误输出）。

### 坏消息：模型名对不上

CLI 有**本地模型白名单**，只认 `claude-*` 或目录里的别名：

```
deepseek-v4.1-flash-1017 → [claude-code:unrecognized_model] 直接拒绝，不发请求
claude-sonnet-4-5        → 同上
sonnet                   → 通过 CLI 校验，但端点返回 400（tokenhub 不认这个 ID）
```

而 tokenhub 的 Anthropic 端点**接受 `deepseek-v4.1-flash-1017`**
（直接 curl `/v1/messages` 返回 200）。

**两边对不上**：CLI 只认 `sonnet`，端点只认 `deepseek-v4.1-flash-1017`。

### 可能的解法：宿主做模型名改写

CLI 发 `sonnet` → 宿主代理改写 body 里的 `model` → 转发到 tokenhub。

试到这一步时代理实现有个 undici 报错（fetch 失败），还没排查完。

**这条路是通的**（sniffer 已验证 CLI 会发请求、会读响应），
只差一个能正常工作的改写代理。

### 成本重估

| 项 | 估算 |
|---|---|
| 改写代理 | 2 小时（含调试） |
| 接进 hostRuntime（替换 pi 做 lead） | 半天 |
| ORCA 工具走 `toClaudeSdkConfig` | 半天 |
| 回归 + 验收 | 半天 |
| **合计** | **约 2 天** |

### 风险

1. **CLI 版本升级可能改校验规则** —— 现在靠的是 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
   这个内部 flag，不是稳定 API
2. **`sonnet` 别名会被 CLI 当成真 Claude** —— 它可能给模型加 Claude 专属的
   系统提示（比如「你是 Claude」），行为上和 deepseek 混用会怪
3. **260MB 的二进制** —— 安装包会变大（比现在多一倍）

### 建议

**先不做。** 理由：

- pi 上手动派活已经能用，覆盖了大部分场景
- 改写代理是个 hack，CLI 升级就可能失效
- 2 天投入换来的是「模型能自主派活」，但**还没验证 deepseek 在 CLI 里
  会不会也编造工具名**（那是当初卡住的原问题）

如果要做，**先花 1 小时验证第 2 点**：接好代理后，让模型列工具，
看它能不能正确看到 ORCA 工具。如果模型照样编名字，那 2 天也白花。

### 已完成的部分（已提交）

- `createClaudeCodeAgent` 在 host-core 里（能起会话，能到模型这一层）
- ORCA 改成 `McpProvider`（跨 harness 可复用，虽然目前只有 pi 在用）

---

## 十三、【重要修正】Cindy 的原生模型接法是可行的，我之前判断错了

我去查了 Cindy 怎么处理「CLI 模型白名单」这个问题，答案是——
**它根本不需要改写代理。我漏了一个环境变量。**

### 真正需要的三个环境变量

```bash
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1   # 锁定 provider 路由
CLAUDE_CODE_ENTRYPOINT=claude-desktop    # 标明是宿主托管
XDT_MAKER_MODEL_CONTEXT_WINDOWS='{"<model-id>":200000}'   # ← 关键这个
```

第三个来自 `env-builder.ts:556`：

```ts
const modelContextWindows = serializeModelContextWindows(options.modelContextWindows);
if (modelContextWindows) env[MAKER_MODEL_CONTEXT_WINDOWS_ENV] = modelContextWindows;
```

序列化后是一个 `{ "model-id": window, "model-id[1m]": window }` 的 JSON。

### 关键认识：`unrecognized_model` 只是警告

加上这个变量后，CLI 仍然打印：

```
[claude-code:unrecognized_model] {"model":"deepseek-v4.1-flash-1017"}
```

**但请求照发、回答照回**。之前失败是因为**没设这个变量，CLI 直接静默退出**，
而不是「模型名被拒绝」。

### 实测结果

```
[REQ] deepseek-v4.1-flash-1017  tools=15
模型回了完整中文回答
```

**`tools=15`** —— 这才是关键：15 个工具直接进了模型上下文，
不需要 `cindy_mcp_list_tools` 二段发现。

对照 pi 那边：模型看到的工具列表里**永远没有** `create_worker`。

### 所以路线完全变了

**不需要写改写代理**。只要：

1. `createClaudeCodeAgent` 传 `XDT_MAKER_MODEL_CONTEXT_WINDOWS`
2. 用 ORCA 的 `McpProvider.toClaudeSdkConfig` 挂 in-process server
3. 把 lead 会话切到 claude-code

**成本从 2 天降到约 1 天。**

### 修正之前的三个风险判断

| 之前担心的 | 实际 |
|---|---|
| 要写改写代理（hack） | ❌ 不需要，一个环境变量 |
| CLI 升级会失效 | ⚠️ 仍存在，但靠的是 CLI 公开的 env（`XDT_` 前缀是宿主自定义的，风险低） |
| 260MB 二进制 | ✅ 仍在 |

### 唯一还没验证的

**deepseek 在 Claude CLI 里会不会照样编造工具名？**

这个必须验证。但现在工具是真·直接可见（`tools=15`），
理论上模型没理由编名字。需要实测确认。

### 补充：endpoint 不能带 `/v1`

踩了一个坑：`ANTHROPIC_BASE_URL` 要传**不带 `/v1`** 的地址。

```bash
# ❌ 错：CLI 会拼成 /v1/v1/messages
ANTHROPIC_BASE_URL=https://tokenhub.tencentmaas.com/v1

# ✅ 对
ANTHROPIC_BASE_URL=https://tokenhub.tencentmaas.com
```

因为 CLI 自己是 `BASE_URL + /v1/messages`。带 `/v1` 会 404，
而 CLI 把这个 404 报成 `model_not_found`（误导性很强）。

**当前可用的完整配置**：

```bash
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1
CLAUDE_CODE_ENTRYPOINT=claude-desktop
XDT_MAKER_MODEL_CONTEXT_WINDOWS='{"deepseek-v4.1-flash-1017":200000}'
ANTHROPIC_BASE_URL=https://tokenhub.tencentmaas.com
ANTHROPIC_API_KEY=<tokenhub 的 key>
--model deepseek-v4.1-flash-1017
```

实测返回：「你好！有什么可以帮你的吗？」

---

## 十四、【验证通过】claude-code 上模型会正确调用 MCP 工具

这是最后一块拼图。实测：

```
[TOOL_USE] {"toolName":"ToolSearch","input":{"query":"select:mcp__spike_tools__echo_marker"}}
[TOOL_USE] {"toolName":"mcp__spike_tools__echo_marker","input":{"text":"hello"}}
[审批] toolName=mcp__spike_tools__echo_marker
```

**模型用的是标准 MCP 名字 `mcp__<server>__<tool>`，没有编造。**

对照 pi 那边卡了三轮的现象（模型发 `mcp:orca:create_worker` 这种不存在的名字）：

| | pi | claude-code |
|---|---|---|
| 工具可见性 | 藏在 list_tools/call_tool 二段网关 | **直接进上下文** |
| 模型行为 | 编造工具名，请求打不到 handler | **正确调用** |
| 需要改写代理 | — | **不需要** |

### 顺带发现一个设计

Claude CLI 会先用 `ToolSearch` 工具"选中"目标工具
（`{"query":"select:mcp__spike_tools__echo_marker"}`），然后才调用。
这是它自己的延迟加载机制，不影响正确性。

### 审批监听器必须挂

不挂 `setInteractionListener` 的话，工具调用会被**默认拒绝**：

```
interaction request received but no listener attached, denying
```

返回格式是 `{ kind: 'permission', behavior: 'allow' }`。

### 最终结论

**ORCA 在 claude-code 上完全可行，成本约 1 天。**
pi 保持现状（手动派活），不强行改。
