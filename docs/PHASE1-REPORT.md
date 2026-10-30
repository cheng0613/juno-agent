# Phase 1 Spike · 验证报告

> 日期：2026-10-30
> 目的：验证「只 vendor `@cindy/maker-core`，自己写宿主」这条路是否成立。
> 结论：**成立。** 全链路已打通，只差一个有效的模型 API key。

---

## 1. 验证结论（一句话）

vendored `maker-core` 在 **完全脱离 Cindy 桌面端** 的宿主里跑通了完整 turn：
装配 → spawn `pi` 子进程 → RPC → 发起 provider 请求 → 解析错误事件 → 终态 → 关闭。
最后一步 Anthropic 返回 `403 Request not allowed`（key 无效），证明请求**真的到达了上游**。

---

## 2. 实测时间线（`node dist/main.mjs`）

```
[spike] pi binary resolved        pi.exe
[spike] Maker initialized         {"agents":["pi"],"makerMemory":false}
[spike] createSession ↓
[spike/pi] pi-spawn      status=ok   111ms     ← pi 子进程拉起
[spike/pi] rpc-ready     status=ok   923ms     ← JSONL/RPC 握手完成
[spike] createSession ↑  sdkSessionId=<...>.jsonl
[spike] send accepted    {"accepted":true}
[spike/pi] provider-request-prepared  toolCount=9  messageCount=1
[error] 403 {"type":"forbidden","message":"Request not allowed"}
[spike] spike finished   {"ok":true,"elapsedMs":1974}
[done]
```

**总耗时 1.97 秒**，其中引擎自身启动开销约 1.0 秒。

---

## 3. 宿主契约实测：真的只需要 3 样东西

`new Maker({ agents, storage, logger })` —— `makerMemory` 可选，spike 省略后一切正常。

| 注入点 | 实测实现 | 行数 | 是否够用 |
|---|---|---|---|
| `storage` | 内存 Map，6 个方法 | ~40 | ✅ |
| `logger` | maker-core 自带 `createConsoleLogger` | 0 | ✅ |
| `agents` | `new PiAgent(deps)`，必填 4 个字段 | ~30 | ✅ |

`AuthAdapter` 只实现了注释里标「必填」的 4 个方法（`getState / triggerLogin / logout / getAuthEnv`），其余 optional 全部省略，**没有报错**。

---

## 4. 踩到的 4 个真实问题（都是可解的）

### 4.1 `?raw` 导入是唯一硬耦合点 ⚠️ 重要

`maker-core` 有 **6 处** Vite 专有语法：

```
src/agents/claude-code/system-prompt-append.ts:19   import x from './system-prompt-append.md?raw'
src/agents/codex/system-prompt-append.ts:22         import x from './system-prompt-append.md?raw'
src/agents/codex/native-auto-review-policy.ts:1,2   import x from './native-auto-review-policy-*.md?raw'
src/contacts/system-prompt.ts:21,22                 import x from './system-prompt-enabled.md?raw' 等
src/memory/system-prompt.ts:18                      import x from './system-prompt.md?raw'
```

裸 Node / tsx 无法解析。**解决方式：bundler 插件（20 行）**，已写在 `apps/spike/build.mjs`。
你选的是 Vite，Vite 原生支持 `?raw`，落地时零成本。

**这就是 vendor 这套代码与宿主构建系统之间唯一的硬耦合点。**

### 4.2 barrel export 会让 Pi-only 宿主也拉入 Claude SDK

`maker-core` 的 `index.ts` 用 `export *` 导出三个 harness，所以哪怕你只用 Pi，
也会 eager import `@anthropic-ai/claude-agent-sdk`（含 115MB 平台二进制）。

- 影响：包体积、安装时间
- 解决：改用 `@cindy/maker-core/agents/pi` 这类子路径导入，或让 bundler tree-shake
- spike 阶段：直接装成依赖，不阻塞

### 4.3 CJS 依赖不能打进 ESM bundle

`gray-matter@4` 内部有动态 `require('fs')`，esbuild 打包进 ESM 后运行时报
`Dynamic require of "fs" is not supported`。
解决：`external` 掉 `gray-matter` / `diff` / `parse5` / 两个 anthropic SDK。

### 4.4 Pi 必须有 `runtimeConfig.endpoint`

不传时报 `models.json will have no usable provider` —— 因为 Pi 的 `models.json`
由 maker-core 生成，provider 的 `baseUrl` 就取自这个字段。
默认填 `https://api.anthropic.com` 即可。

---

## 5. 顺带确认的 3 件事

1. **`@anthropic-ai/claude-agent-sdk@0.3.292` 是 npm 公开版本**，不是私有 patch —— 不用担心拿不到。
2. **Pi 的会话文件落盘正常**：`pi-agent-home/sessions/<ts>_<uuid>.jsonl`，`sdkSessionId` 就是这个路径，resume 靠它。
3. **`maker-core` 会在宿主目录里自动生成 `models.json`**，把 `capabilityAdditions.availableModels` 挂到单一 provider `cindy` 下，凭证走 env 插值不落盘。

---

## 6. 依赖闭包（比预想的更小）

```
maker-core → maker-shared, model-providers, @anthropic-ai/claude-agent-sdk,
             @anthropic-ai/sdk, diff, gray-matter
maker-shared → parse5
model-providers → model-compat
model-compat → （无依赖）
```

**闭包正好 4 个包 + 6 个 npm 依赖**，全部 `type: module`，全部 `main` 指向 `.ts` 源码。
`better-sqlite3` 和 `sharp` 是 **optional peer**，spike 全程没装、没报错。

---

## 7. Phase 1 门禁判定

| 判据 | 结果 |
|---|---|
| 3 天内跑通 | ✅ 当天 |
| 是否需要改 maker-core 源码 | ✅ **零改动** |
| 失败原因是否在 API 抽象本身 | ✅ 不在，抽象站得住 |

**→ 通过，进入 Phase 2（SQLite 持久化 + 会话生命周期）。**

---

## 8. 下一步要做的

Phase 2 清单：
1. 把 `MemorySessionStorage` 换成 `SqliteSessionStorage`（需要装 `better-sqlite3`）
2. 设计 6 张表：`sessions` / `messages` / `message_blocks` / `session_runtime` / `usage` / `attachments`
3. 事件增量落库（流式追加，不是整条覆盖）
4. 中断恢复：照 `sessionActiveTurn` + `interruptedTurnAutoResume` 两套判据

**唯一待补**：一个有效的模型 API key，用来跑一次完整文本回复。
