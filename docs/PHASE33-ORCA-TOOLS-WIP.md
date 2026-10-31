# ORCA 阶段三：进行中（交接文档）

**状态：卡在一个具体的技术障碍上，已提交推送，可安全休眠。**

最后提交 `14d1a6c`，工作区干净，`tsc` 0 错误，阶段二功能未受影响。

---

## 已经能跑通的部分

| 项 | 状态 | 证据 |
|---|---|---|
| MCP 工具服务器启动 | ✅ | `[orca/tools] 已启动 { port: 60417 }` |
| pi 发现工具 | ✅ | `[cindy-bridge] MCP gateway ready (3 tools)` |
| token 身份识别 | ✅ | `CALLER caller={"role":"lead","sessionId":"96b11b82-…"}` |
| 工具定义正确 | ✅ | `cindy_mcp_list_tools` 能返回完整 inputSchema |
| 回报注入 Lead 对话 | ✅ | 代码完成，未端到端验证 |
| **MCP 端点本身** | ✅ | **SDK client 直连测通**：列工具→调用→handler 全通 |

---

## 卡点：模型发起的调用到不了 handler

**现象**：模型确实调了 `mcp:orca:create_worker`，但我们的 HTTP server 只收到 3 个请求：

```
REQ POST /mcp sid=-              ← initialize
REQ POST /mcp sid=d01d4107-…     ← notifications/initialized
REQ POST /mcp sid=d01d4107-…     ← tools/list
```

**没有 `tools/call`。** 所以 handler 一次都没执行。

### 已经排除的可能

| 假设 | 验证方式 | 结论 |
|---|---|---|
| MCP 端点坏了 | SDK client 直连测试 | ❌ 排除，端点正常 |
| 鉴权 401 | 加日志看 resolveToken | ❌ 排除，token 能查到 |
| token 登记太晚 | 改成预生成 sessionId | ❌ 已修，不是卡点 |
| stateless transport | 改成有状态（每会话一套） | ❌ 已修，不是卡点 |
| schema 披露机制 | 查披露文件内容 | ❌ 已写入 `{"orca\0create_worker":"fb50bd…"}` |
| `hostToolsOnly` | 改成 true 试 | ❌ 无变化 |

### 关键线索

1. 模型发的是 **`mcp:orca:create_worker`**（冒号）
2. pi 内部转发用 **`mcp__orca__create_worker`**（下划线）
   — 见 `maker-core/src/agents/pi/cindy-bridge-source.ts:3276`
3. **`mcp:` 冒号前缀在 maker-core 里完全搜不到** —— 它来自 `pi.exe` 二进制

也就是说：pi 把工具以冒号格式暴露给模型，但**转发路径不经过我们的 HTTP server**。

---

## 另一条路（待评估）

**pi 自带完整的 ORCA 式编排工具**：

| 工具 | 作用 |
|---|---|
| `start_session_task` | 起独立后台任务，**支持 `use_worktree`** |
| `list_agents` | 列队友 |
| `send_to_agent` | 发消息给队友 |
| `check_agent_message` | 读回复 |
| `message_session_task` | 跟进任务 |
| `stop_session_task` | 停任务 |

见 `cindy-bridge-source.ts:3788-3900`。这些**正是 ORCA 要的东西**。

**但注册有前提**：

```ts
if (this.resolveStartSessionTask({})) {   // ← 这里是条件
  pi.registerTool({ name: CINDY_START_SESSION_TASK_TOOL, … });
}
```

`resolveStartSessionTask` → `resolveDirectHelperTool('cindy_helper', …)`，
需要宿主提供 **`cindy_helper` MCP server**。我们没实现，所以这些工具没注册。

---

## 下一步的两个选项

### A. 实现 `cindy_helper`，接 pi 自带工具（推荐）

- **优点**：走引擎设计意图；worktree 隔离现成；跨设备也支持
- **成本**：1-2 天
- **第一步**：读 `cindy-bridge-source.ts` 里 `resolveDirectHelperTool` 的实现，
  搞清楚 helper server 要提供哪些工具的哪个版本

### B. 继续查自建 MCP 工具的转发路径

- **可能方向**：抓 pi 的 HTTP 流量，看 `mcp:orca:*` 调用到底发到哪
- **风险**：`mcp:` 前缀在二进制里，可能是个死胡同
- **成本**：半天

**我倾向 A**：pi 自己实现过整套编排，说明那条路是设计意图；
我们自建的 MCP 工具可能撞上了二进制内部未公开的机制。

---

## 这轮踩的坑（都记录了原因）

**坑一：stateless transport 让 pi 的 schema 缓存永久失效**

一开始每请求新建 transport。结果 pi 每次连都是「新服务器」，
一直要求模型「先检查 schema」，检查完又因服务器换了而失效。
改成有状态（按 `mcp-session-id` 复用）才对。

> 这和 `docs/SPIKE-MCP.md` 里「transport 不能复用」**不矛盾**：
> 那里说的是一次 request/response 不能共用 transport（initialize 只能一次）；
> 这里说的是**一个会话内**要复用同一套 server+transport。

**坑二：token 必须在建会话之前登记**

pi 在建会话**过程中**就连 MCP 拉工具列表（日志顺序：
`createSession ↓` → `REQ POST /mcp` → `createSession ↑`）。
等 maker 返回再登记就已经 401 了，而且 pi **不会重试**——
只在 stderr 留一行 `connect orca failed: HTTP 401`，界面上完全看不出来。

修法：`createSession` 里**自己预生成 sessionId**（maker 支持传 `id`），
token 在调 `maker.createSession` 之前就带着完整身份登记好。

**坑三：多 worker 并发时不能靠「当前 worker」单值字段**

MCP server 全局一个，每个 pi 进程是独立 HTTP 客户端，请求里没有会话 id。
用单值字段的话，两个 worker 同时回报会冒名顶替。
改成**每个会话一套 token，token 即身份**。

---

## 本次新增的文件

| 文件 | 内容 |
|---|---|
| `apps/desktop/electron/orcaToolServer.ts` | MCP 工具服务器（约 290 行） |
| `apps/desktop/electron/hostRuntime.ts` | `startOrcaTools` / `reportToLead` / token 管理 |
| `apps/desktop/electron/autotest.ts` | `runOrcaToolsTest`（`APP_AUTOTEST=orca-tools`） |

依赖新增：`@modelcontextprotocol/sdk` + `zod`（桌面端）。

---

## 恢复工作的命令

```bash
cd apps/desktop
npx tsc --noEmit                 # 应为 0
node scripts/build.mjs           # 构建

# ORCA 工具链路验收（当前会失败在「模型没有创建 worker」）
APP_AUTOTEST=orca-tools \
  APP_PI_API_KEY=... \
  APP_DATA_DIR=$PWD/.appdata \
  node scripts/launch.mjs

# 阶段二回归（应该全过）
APP_AUTOTEST=orca-ui  node scripts/launch.mjs
APP_AUTOTEST=orca-iso node scripts/launch.mjs
```
