# Phase 5：会话标题 / 权限记忆 / 输入队列

三件「不做就会天天硌人」的小事。每件都跑了真实端点 + GUI 截图验收。

---

## 1. 会话标题自动生成

**做了什么**：会话建立后，用首条用户消息生成标题（`makeSessionTitle`：压空白 → 剥开头客套 → 超 24 字截断加 `…`），落库并广播 `session_title`，渲染层只改本地列表、不重拉。

**为什么用规则而不是让模型起名**：标题要在会话刚出现时立刻可读；模型版要等一次往返，侧栏会先挂一秒「新会话」。规则版即时、零成本、可预测。后续想润色可以用模型覆盖，接口不用改。

**一个容易踩的点**：标题取的是「该会话第一条 user 消息」，不是「本轮文本」。因为续跑会发「继续你刚才没做完的事」这种合成指令，拿它当标题会把会话名改成废话。

另外有意**不更新 `updated_at`** —— 改标题不是「有新活动」，否则侧栏会自己跳位。

**验收**：`APP_AUTOTEST=1` → 库里两条标题正确，`06-streaming-final.png` 中侧栏显示标题并被省略号截断。

---

## 2. 权限档位（记忆型白名单）

**做了什么**：
- 新表 `permission_rules(id, tool_name, subject, behavior, scope, session_id, created_at)` + 索引（migration v3）
- `PermissionStore.lookup()` 一次取候选、内存排序：**deny > allow → 会话级 > 全局级 → 具体 subject > 通配**
- 审批弹层加分段控件「记住：仅本次 / 本会话 / 始终」，记住后才显示具体规则（`bash: git`）

**为什么只记「工具 + 主语」两段，不做正则/glob**：真实痛点 90% 是「每次 git 都问一遍」。规则语言越强，用户越不敢用，最后全点允许反而更危险。

**为什么主语在宿主侧提取**：让渲染层算，规则含义会随 UI 漂移。`extractSubject()` 对 shell 类工具取命令首词（`git status` → `git`），其他工具返回 `null` = 工具级规则。

**有意不做路径前缀规则**：按目录记很容易变成一条覆盖全盘的规则，用户以为放行了一个目录，实际放行了一大片。

**deny 优先**：显式拒绝必须能压过历史放行。

**验收**（`APP_AUTOTEST=permission`，走真实 UI：点「始终」再点「允许」）：
```
规则: [{tool_name:'bash', subject:'ls', behavior:'allow', scope:'global'}]
第二轮审批次数: 0
turns: done, done
```

---

## 3. 输入队列

**原来的行为**：跑着的时候输入框还能打字，Enter 被 `if (running) return;` 静默吞掉 —— 用户的话凭空消失，也没有任何提示。这是本轮抓到的第一个真 bug。

**现在的语义**：跑着时 Enter → 进入队列（底部显示「排队中 N」+ 每条可 × 取消），本轮结束后自动按顺序发出。占位文案同时改成「这一轮还在跑，Enter 会排队，结束后自动发送」。

**为什么排队而不是并发发送**：引擎的并发 `send` 语义不确定，宿主也不该替它赌。排队让「一句话都不会丢」这件事由我们保证。

### 修掉的两个真 bug

**① 队列同时冲出两条**
队列保底是 `useEffect`，依赖 `[running, queued]`。`setQueued(rest)` 触发重渲染时，主进程的 `turn:running` 还在 IPC 路上，`running` 仍是 `false` → effect 再跑一次，把剩下的条目一口气全发了。
修法：派发时**乐观 `setRunning(true)`**。`send()` 里同样加上，防手快连敲两次 Enter。

**② 上一轮的订阅被覆盖，那一轮永远停在 running**
`hostRuntime` 原用一个字段 `turnUnsubscribe` 存「当前订阅」，`send` 前先解绑上一个。一旦出现并发 send，旧订阅被默默覆盖 → 旧轮的终态事件再也收不到 → 库里的 turn 永远 `running`，下次启动会被误判成「未完成」。
修法：改成 `Map<turnId, unsubscribe>` 分轮归档；终态到达时解绑自己那一份。若真出现「上一轮没结束就来新 send」，**如实把旧轮标成 `interrupted` 并广播**，而不是假装它还在跑。
顺带修了同一轮收到多个终态事件会重复收口的问题（每轮只发一次 `turn done`）。

**验收**（`APP_AUTOTEST=queue`，用真实输入路径：往 textarea 塞值 + 派发 Enter）：
```
界面上的排队条数: 2
turns started=3 finished=3
turns: [done ×3]
用户消息: 用 bash 跑 ls -a… → 回复：收到第一条 → 回复：收到第二条
助手回复: 目录是空的… → 收到第一条 → 收到第二条
```
严格一问一答交替，没有孤儿轮。

> 测试脚手架的教训：第一版用「排队的第一条」当内容，模型把它当成提问、去调 `ask_user_question`，把流程搅乱。验收用句要无歧义（「回复：收到第一条」）。计数也要按 `turnId` 去重，不能数事件个数。

---

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/hostRuntime.ts` | 标题生成、规则查表、`Map` 分轮订阅、重复收口去重 |
| `apps/desktop/electron/autotest.ts` | 新增 `runPermissionTest` / `runQueueTest` |
| `apps/desktop/src/App.tsx` | 标题事件、审批「记住」控件、队列 + 乐观 running |
| `apps/desktop/src/shared/ipc.ts` | `session_title`、`rememberKey`、`remember` |
| `apps/desktop/src/styles/app.css` | `.seg` 分段控件、`.queue-strip` |
| `packages/host-core/src/db/permissionStore.ts` | 新文件 |
| `packages/host-core/src/db/schema.ts` | migration v3 |

## 四个模式回归

| 模式 | 结果 |
|---|---|
| `APP_AUTOTEST=1` | 11 段流式 / 160 字 / 6 条消息落库 ✅ |
| `APP_AUTOTEST=permission` | 规则命中，第二轮 0 次弹窗 ✅ |
| `APP_AUTOTEST=queue` | 排队 2 条，3 轮全 done ✅ |
| `APP_AUTOTEST=resume` | 横幅 → 继续 → 自动批准 → 归零 ✅ |
