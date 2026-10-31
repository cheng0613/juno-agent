# MCP Spike：ORCA 工具链可行性

ORCA 的 Lead 派活全靠工具。如果宿主不能给 pi 提供 MCP 工具，第二阶段做的 worker 面板就没有数据来源。

所以先花半天验这条路。

---

## 结论：可行 ✅

```
1. MCP server 起得来: 是 (http://127.0.0.1:49680/mcp)
2. pi 能发现工具并调用: 是（mcp:spike_bridge:echo_back）
3. 请求回到宿主: 是（echo_back 被调用，参数 hello-mcp）
4. 结果回到模型: 是（模型回答 ECHO_OK:hello-mcp）
```

四段链路全通，ORCA 的派活机制**没有技术阻塞**。

---

## 怎么接的

### 1. 宿主机起 localhost HTTP MCP server

```ts
const httpServer = http.createServer(async (req, res) => {
  const perRequestServer = new McpServer({ name: 'spike_orca_bridge', version: '0.1.0' });
  registerTools(perRequestServer);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await perRequestServer.connect(transport);
  await transport.handleRequest(req, res);
  …
});
httpServer.listen(0, '127.0.0.1');   // 随机端口
```

### 2. 通过 `LOCAL_AGENT_CLIENT` 交给 pi

```ts
const session = await maker.createSession({
  agentKind: 'pi',
  workingDir,
  model,
  [LOCAL_AGENT_CLIENT]: {
    url: 'http://127.0.0.1:PORT/mcp',
    token: 'spike-token',
    hostToolsOnly: false,
    mcpName: 'spike_bridge',
  },
});
```

pi 把工具名拼成 `mcp:spike_bridge:echo_back`。**命名空间来自 `mcpName`**——这决定了 ORCA 工具以后叫 `mcp:orca:create_worker`。

---

## 踩到的坑：transport 不能复用

第一版我创建一个 transport 给所有请求共用：

```ts
// ❌ 错
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);
http.createServer((req, res) => void transport.handleRequest(req, res));
```

结果：

```
1. MCP server 起得来: 是
2. pi 能发现工具并调用: 是        ← 工具列表拿到了
3. 请求回到宿主: 否              ← 但调用时 HTTP 500
4. 结果回到模型: 否
```

模型的原话很能说明问题：

> 工具调用失败了，没拿到结果：`spike_bridge` 服务器不可用（HTTP 500），可用工具列表为空

**原因**：一个 transport 实例只能服务一次 initialize 握手。`tools/list` 走通了（所以模型能发现工具），`tools/call` 就崩了。

**修法**：stateless 模式下**每个请求新建 transport + server**。

> 这个坑很隐蔽：错误发生在第二次请求，而且工具发现是正常的 ——
> 如果只验「能不能列工具」就以为成功了，集成后才会发现所有调用都失败。

---

## 依赖

需要两个包（已装）：

```
@modelcontextprotocol/sdk  1.29.0
zod                        4.6.7
```

---

## 对 ORCA 计划的影响

| 原计划 | 更新 |
|---|---|
| 阶段三「MCP 可行性」标为中等风险 | ✅ **已验证，降为低风险** |
| 工具命名空间未定 | `mcpName` 决定，建议用 `orca` |
| spike 排在阶段二之前 | 已完成，可以按阶段一 → 二 → 三顺序做 |

### 工具签名（照 spike 验证过的形式）

```ts
server.tool(
  'echo_back',
  '工具描述（模型靠这句话决定什么时候用）',
  { text: z.string().describe('参数说明') },
  async ({ text }) => ({
    content: [{ type: 'text', text: `ECHO_OK:${text}` }],
  }),
);
```

**返回值必须是 `{ content: [{ type: 'text', text }] }`**，复杂结构用 JSON.stringify 塞进 text（Cindy 也是这么做的）。

---

## 脚本

`apps/spike/src/spikeMcp.ts`，可重复运行：

```bash
pnpm --filter @spike/app build
APP_PI_API_KEY=... APP_DATA_DIR=./.mcp-spike \
  node apps/spike/dist/spikeMcp.js
```

里面注册了两个示例工具（`echo_back` 和假的 `create_worker`），做 ORCA 时替换掉。
