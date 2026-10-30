# 开发记录

16 个阶段的实施报告。每篇都是「动手前查了什么 → 撞到什么 → 怎么定的 → 怎么验的」。

**如果只看三篇**：[Phase 1](./PHASE1-REPORT.md)（可行性结论）、[Phase 3](./PHASE3-REPORT.md)（宿主与 UI 架构）、[Phase 13](./PHASE13-REPORT.md)（最典型的一次「功能为空，根因是缺依赖」排查）。

---

## 按主题找

### 引擎接入
- [Phase 1](./PHASE1-REPORT.md) — Pi 子进程 / RPC / 事件流，证明 vendor 路线成立
- [Phase 6](./PHASE6-REPORT.md) — 上下文压缩（`compact_boundary`）
- [Phase 15](./PHASE15-REPORT.md) — 会话分支树（`navigateSessionTree`）

### 数据与恢复
- [Phase 2](./PHASE2-REPORT.md) — SQLite 6 表、迁移、中断恢复
- [Phase 4](./PHASE4-REPORT.md) — 打包分发 + 中断续跑
- [Phase 14](./PHASE14-REPORT.md) — 额外工作目录（migration v4）
- [Phase 17](./PHASE17-REPORT.md) — 文件回滚（git savepoint）

### 交互
- [Phase 5](./PHASE5-REPORT.md) — 会话标题、权限记忆、输入队列
- [Phase 7](./PHASE7-REPORT.md) — 插话纠正（`steer`）、上下文占用条
- [Phase 8](./PHASE8-REPORT.md) — 本轮改动面板
- [Phase 9](./PHASE9-REPORT.md) — 权限档位、计划模式
- [Phase 10](./PHASE10-REPORT.md) — 思考档位
- [Phase 11](./PHASE11-REPORT.md) — 模型热切换
- [Phase 12](./PHASE12-REPORT.md) — 导出 HTML
- [Phase 13](./PHASE13-REPORT.md) — 子任务进度
- [Phase 16](./PHASE16-REPORT.md) — 图片输入

### 外壳
- [Phase 3](./PHASE3-REPORT.md) — Electron + IPC + 对话 UI
- [Phase 4](./PHASE4-REPORT.md) — NSIS 打包、asar 瘦身
- [Phase 18](./PHASE18-REPORT.md) — 操作台布局 + 状态行
- [Phase 19](./PHASE19-REPORT.md) — 样式体系对齐 Cindy
- [Phase 20](./PHASE20-REPORT.md) — 配置持久化 + 首次启动向导
- [Phase 21](./PHASE21-REPORT.md) — 错误边界

---

## 值得记住的坑

### 引擎侧

| 现象 | 根因 | 出处 |
|---|---|---|
| 后台任务列表永远为空 | 宿主没传 `spawnPiSubagentRunner`，subagent 扩展根本没写入，模型连工具都没有 | [13](./PHASE13-REPORT.md) |
| 改动面板列出文件但点开是空的 | `git diff HEAD` 不含未跟踪文件，得自己拼 unified diff | [8](./PHASE8-REPORT.md) |
| 思考档位「声明支持、点了报错」 | 能力声明了 6 档，但宿主没传 `APP_EFFORTS`，pi 只放行 `low` | [10](./PHASE10-REPORT.md) |
| 手动压缩永远 noop | pi 有内置下限，小会话必定拒绝；配置降不下来 | [6](./PHASE6-REPORT.md) |
| 回退后对话区全空 | 引擎的 `content` 有对象和裸字符串两种形状，只认一种就吃掉了所有内容 | [15](./PHASE15-REPORT.md) |
| 回退轮次编号是倒的 | pi 的树 `roots` 是新到旧排列，按遍历顺序编号会静默错位到别的轮 | [17](./PHASE17-REPORT.md) |
| Fast mode 是假开关 | `setFastMode` 只记偏好不验证；deepseek 不在 `fastModels` 里 | [10](./PHASE10-REPORT.md) |

### 宿主侧

| 现象 | 根因 | 出处 |
|---|---|---|
| 审批点了没反应，工具永远挂住 | 先 `emit` 再注册 `pending`，监听器同步回批准时查不到 | [4](./PHASE4-REPORT.md) |
| 续跑后用户消息重复 | 重发时生成了新 `client_id`，幂等没命中 | [4](./PHASE4-REPORT.md) |
| 上一轮永远停在 running | 单字段 `turnUnsubscribe` 被新 `send` 覆盖，旧轮的终态收不到 | [5](./PHASE5-REPORT.md) |
| 队列同时冲出两条 | `setQueued` 重渲染时 `turn:running` 还在 IPC 路上，`running` 仍是 false | [5](./PHASE5-REPORT.md) |

### 测试自身

| 现象 | 根因 | 出处 |
|---|---|---|
| 偶发 `UnknownVizError` 导致整条验收失败 | `capturePage()` 会偶发失败，五处截图函数只有一份有重试 | [7](./PHASE7-REPORT.md) |
| 改完路由后 compact 测试点了导出按钮 | 新增并列元素后 `querySelector` 第一个匹配就选错了 | [12](./PHASE12-REPORT.md) |
| 分支树测试假绿 | 只验了「输入框有内容」，没验「对话区没空」 | [15](./PHASE15-REPORT.md) |
| steer 测试随机变红 | 固定 `delay(1500)` 依赖模型速度，改成轮询等流式输出 | [13](./PHASE13-REPORT.md) |
| 切换模型「全绿」其实没切 | 用的假模型 id 端点不校验，验的是「没报错」不是「真换了」 | [11](./PHASE11-REPORT.md) |
| 圆角全变尖、气泡变直角 | CSS 变量自引用形成循环，值变无效 | [19](./PHASE19-REPORT.md) |
| Tailwind 配了但静默不生效 | `viteBuild({configFile})` 路径下 `css.postcss` 没被读到 | [19](./PHASE19-REPORT.md) |
| 双击 exe 报 `no_key` | key 只能靠环境变量传，没有配置入口 | [20](./PHASE20-REPORT.md) |
| 渲染层异常直接白屏 | 没有 error boundary；且只有边界接不到事件/Promise 错误 | [21](./PHASE21-REPORT.md) |
| 改样式后测试集体变红 | 测试依赖 class 名，换方案就会断；改用 data-testid | [21](./PHASE21-REPORT.md) |

**一句话总结**：看到「不对劲」先看数据，别看像素；看到「全绿」先问一句「它到底验了什么」。

---

## 验收方式

每个阶段都跑真实模型 + 截图，不是修 mock。共 14 个 `APP_AUTOTEST` 模式，用法见根目录 [README](../README.md)。

关键原则：**验行为变化，不验 API 不报错**。

| 功能 | 验的是 |
|---|---|
| 插话 | 让它数到 30，中途插话改成 5 —— 必须停在 5 |
| 权限档位 | 切到 auto 后审批次数必须为 0 |
| 改动面板 | 磁盘上真建了 `+hello` 才通过 |
| 子任务 | 模型真拆出 3 个并发任务 |
| 图片 | 发纯红图，模型必须说「红色」 |
| 分支树 | 退回后历史重建、再发能长出新枝 |
| 文件回滚 | `target.txt` 从 `MODIFIED` 真的变回 `ORIGINAL` |
