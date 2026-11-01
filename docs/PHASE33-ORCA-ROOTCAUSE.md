# ORCA 阶段三：根因定位

上次卡在「模型调了工具但 HTTP server 收不到 `tools/call`」。这轮查清了。

---

## 根因：模型编造工具名

**不是集成问题，是模型行为问题。**

### 证据

我让模型原样列出它能调用的工具，它回答：

```
read / bash / edit / write / ask_user_question / grep / find / ls / powershell
cindy_mcp_list_tools / cindy_mcp_call_tool / subagent
```

**列表里没有 `mcp:orca:create_worker`。** 但模型调用时用的就是这个名字——**它自己编的**。

正确的工具 `cindy_mcp_call_tool` 明明在列表里，模型不用。

### 上游早就知道

`maker-core/src/agents/pi/cindy-bridge-source.ts:4054` 的注释写着：

> 模型看不到 name/args，就把内层字段直接塞进 args 并丢掉 name
> （2026-10-15 实测 MiniMax-M3.1 / **deepseek-v4.1-flash** / step-5 三会话均复现）

**我们用的默认模型就是 `deepseek-v4.1-flash-1017`。**

### 为什么 MCP 工具不直接暴露给模型

`cindy-bridge-source.ts:14` 的注释：

> 对每个 server 走 initialize → 分页 tools/list；**模型侧固定注册两个通用网关工具**

也就是说，pi 的架构是「MCP 工具不直连模型，必须经 `cindy_mcp_list_tools` + `cindy_mcp_call_tool` 二段式」。这是**安全设计**——模型不能盲调没见过的工具。

所以我们看到的 3 个请求是对的：

```
REQ POST /mcp sid=-            initialize
REQ POST /mcp sid=<id>         notifications/initialized
REQ POST /mcp sid=<id>         tools/list
```

`tools/call` 从来没发出，因为模型压根没调对工具。

---

## 试过的（全部失败）

| 提示词写法 | 模型行为 |
|---|---|
| 「立刻调用 mcp:orca:create_worker」 | 照做了，但工具不存在 → 失败 |
| 「调用 cindy_mcp_call_tool，参数 {...}」 | 转成 `mcp:orca:create_worker` |
| 「cindy_mcp_call_tool 是独立工具，不要拼名字」 | 照样拼 |
| 「server 和 tool 是参数，不是工具名的一部分」 | 照样拼 |
| 「第一步 server="orca"，tool="create_worker"」 | 照样拼 |
| 工具描述里写调用示例 | 照样拼 |

**6 种写法，模型全部固执地编造工具名。**

---

## 三个可选方向

### A. 换一个不犯这个错的模型

上游点名了 3 个有问题的模型（MiniMax-M3.1 / deepseek-v4.1-flash / step-5）。
说明**别的模型是正常的**。

- 成本：换个 API key 或换个模型 ID
- 风险：低
- **这是唯一能直接验证「是不是模型问题」的办法**

### B. 放弃「Lead 自主派活」，只做手动派活

阶段二已经能做：用户点「+ Worker」、输入框派活、看 worker 干活。

- 成本：0（已经做完了）
- 代价：用户得自己决定派给谁，Lead 不会自己拆活
- **但这是当前唯一确定能用的路径**

### C. 接 pi 自带的 `cindy_helper` 编排工具

`start_session_task` / `send_to_agent` 等是**原生工具**（`pi.registerTool` 直接注册），
不是 MCP 网关工具——**模型能直接调，不需要二段式**。

- 前提：宿主提供名为 `cindy_helper` 的 MCP server
- 成本：1-2 天
- 风险：`cindy_helper` 的语义是「Cindy 云端协作」，和本地 Lead/Worker 不完全对应，要写适配层

---

## 我的建议

**先试 A（换模型），半小时就能出结论。**

如果要继续自建这条线，A 是必须验证的前提——如果换了模型就正常，
那之前的调试全是白费力气，问题根本不在我们的代码。

如果 A 也不行，再选 B（认了，只做手动派活）或 C（接原生工具）。

**不建议继续调提示词。** 6 次都失败，说明这不是提示词能解决的问题。

---

## 附：这轮验证用到的命令

```bash
# 让模型列出它能调用的工具（最直接的诊断）
APP_AUTOTEST=probe ... node scripts/launch.mjs
```

`runToolProbe` 在 `electron/autotest.ts`，可以随时改提示词重跑。

---

## 换模型复验（2026-11-01）

| 模型 | 能列出真实工具 | 调用时是否编造名字 |
|---|---|---|
| `deepseek-v4.1-flash-1017` | ✅ 12 个，无 `mcp:orca:*` | ❌ 编造 `mcp:orca:create_worker` |
| `glm-5.3-flash` | ✅ 12 个，无 `mcp:orca:*` | ❌ 编造 `mcp:orca:create_worker` |

**两个不同厂商的模型，同一行为。**

所以这不是模型缺陷，是**架构层面的诱导**：

`cindy_mcp_call_tool` 的参数是 `{server, tool, args}`，
模型看到「server=orca, tool=create_worker」，很自然地拼出
`mcp:orca:create_worker` 当成"完整工具名"去调 ——
而那个工具并不存在。

### 顺带修正一个认识

之前以为「换个好模型就行」。**实际不行** —— 换了两家都一样。

问题在 pi 的二段式网关设计本身：让模型间接描述「我要调哪个 server 的哪个工具」，
比直接给它一个工具名更容易出错。

### 模型 ID 的坑

`z-ai/glm-5.3-flash` 是 registry 里的 id，但这个 endpoint 要的是**裸名字** `glm-5.3-flash`。
用错会返回 `400004 The model or service ID ... does not exist`。

`tencent/hy4-preview` 同理，这个 endpoint 上不存在。
