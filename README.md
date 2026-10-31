# spike-host

验证工程：只 vendor `@cindy/maker-core`，自己写宿主，这条路走不走得通。

**结论：走得通。**

| 阶段 | 内容 | 报告 |
|---|---|---|
| Phase 1 | 引擎接通（Pi 子进程 / RPC / 事件流） | [报告](./docs/PHASE1-REPORT.md) |
| Phase 2 | SQLite 持久化、中断恢复 | [报告](./docs/PHASE2-REPORT.md) |
| Phase 3 | Electron 外壳、IPC 边界、对话 UI | [报告](./docs/PHASE3-REPORT.md) |
| Phase 4 | 打包分发（NSIS）、中断续跑 | [报告](./docs/PHASE4-REPORT.md) |
| Phase 5 | 会话标题、权限记忆、输入队列 | [报告](./docs/PHASE5-REPORT.md) |
| Phase 6 | 上下文压缩 | [报告](./docs/PHASE6-REPORT.md) |
| Phase 7 | 插话纠正（steer）、上下文占用条 | [报告](./docs/PHASE7-REPORT.md) |
| Phase 8 | 本轮改动面板（turn diff） | [报告](./docs/PHASE8-REPORT.md) |
| Phase 9 | 权限档位、计划模式 | [报告](./docs/PHASE9-REPORT.md) |
| Phase 10 | 思考档位（effort） | [报告](./docs/PHASE10-REPORT.md) |
| Phase 11 | 模型热切换、多模型配置 | [报告](./docs/PHASE11-REPORT.md) |
| Phase 12 | 导出 HTML | [报告](./docs/PHASE12-REPORT.md) |
| Phase 13 | 子任务进度 | [报告](./docs/PHASE13-REPORT.md) |
| Phase 14 | 额外工作目录 | [报告](./docs/PHASE14-REPORT.md) |
| Phase 15 | 会话分支树 | [报告](./docs/PHASE15-REPORT.md) |
| Phase 16 | 图片输入 | [报告](./docs/PHASE16-REPORT.md) |
| Phase 17 | 文件回滚（git savepoint） | [报告](./docs/PHASE17-REPORT.md) |
| Phase 18 | 操作台布局 + 状态行 | [报告](./docs/PHASE18-REPORT.md) |
| Phase 19 | 样式体系对齐 Cindy（Tailwind + tokens） | [报告](./docs/PHASE19-REPORT.md) |
| Phase 20 | 配置持久化 + 首次启动向导 | [报告](./docs/PHASE20-REPORT.md) |
| Phase 21 | 错误边界（D 类） | [报告](./docs/PHASE21-REPORT.md) |
| Phase 22 | 卡住提示（D 类） | [报告](./docs/PHASE22-REPORT.md) |
| Phase 23 | 窗口记忆 + 干净机器验证（D 类） | [报告](./docs/PHASE23-REPORT.md) |
| Phase 24 | 会话管理（B 类） | [报告](./docs/PHASE24-REPORT.md) |
| Phase 25 | 多会话并行（B 类） | [报告](./docs/PHASE25-REPORT.md) |
| Phase 26 | 后台完成通知（B 类） | [报告](./docs/PHASE26-REPORT.md) |
| Phase 27 | 跨会话事件路由（B 类） | [报告](./docs/PHASE27-REPORT.md) |

报告索引与踩坑汇总见 [docs/README.md](./docs/README.md)。

---

## 结构

```
spike-host/
├── design/                    ← design tokens
│   ├── tokens.css             唯一来源，93 个变量
│   ├── preview.html           自包含预览（双主题）
│   ├── preview.template.html  模板
│   └── build-preview.mjs      注入脚本
├── packages/
│   ├── maker-core/            从 upstream 原样拷贝，零改动（Apache-2.0）
│   ├── maker-shared/           39k 行 · 跨端展示契约
│   ├── model-providers/        13k 行 · 供应商目录 + 路由
│   ├── model-compat/             · 协议兼容
│   └── host-core/             ← 宿主运行时（CLI 与桌面共用）
│       └── host · recorder · approval · db/*
└── apps/
    ├── spike/                 ← CLI，验证引擎与数据层
    │   ├── src/main.ts        跑一轮，全程落库
    │   ├── src/selftest.ts    6 项数据层断言（不需 key）
    │   ├── inspect.mjs        看库里有什么
    │   └── simulate-crash.mjs 模拟进程中途被杀
    └── desktop/               ← Electron 桌面端
        ├── electron/main.ts      窗口 + IPC handler
        ├── electron/preload.ts   contextBridge 白名单
        ├── electron/hostRuntime.ts 宿主对象（不依赖 Electron）
        ├── src/shared/ipc.ts     主/渲染唯一契约
        ├── src/App.tsx           外壳：侧边栏 + 消息 + 输入 + 审批
        ├── src/Chat.tsx          消息渲染 + 工具卡片
        ├── src/devMock.ts        无 Electron 时的假宿主
        └── src/styles/app.css    全部样式走 tokens
```

---

## 快速开始

```bash
pnpm install

# ---- 桌面端 ----
cd apps/desktop
node scripts/build.mjs       # 渲染层 + 主进程 + preload
node scripts/launch.mjs      # 启动（需 APP_PI_API_KEY）
node scripts/smoke.mjs       # 启动冒烟测试，自动清理
node scripts/package.mjs     # 打包成免安装版 release/out/win-unpacked
node scripts/package.mjs --installer   # 另外产出 NSIS 安装包

# ---- 验中断续跑 ----
node scripts/inject-interrupted.mjs .appdata/app.db   # 注入一条被杀掉的轮
APP_AUTOTEST=resume node scripts/launch.mjs           # 自动点「继续」并截图

# ---- 验权限记忆规则 ----
APP_AUTOTEST=permission node scripts/launch.mjs       # 首次选「始终」，第二轮应免审批

# ---- 验输入队列 ----
APP_AUTOTEST=queue node scripts/launch.mjs            # 跑着时连发两条，应排队后依次发出

# ---- 验上下文压缩 ----
APP_AUTOTEST=compact node scripts/launch.mjs          # 小会话给 noop 提示；合成的边界应落库并渲染

# ---- 验插话与上下文占用 ----
APP_AUTOTEST=steer node scripts/launch.mjs            # 让模型数到 30，中途插话改成只数到 5

# ---- 验本轮改动面板 ----
APP_AUTOTEST=diff node scripts/launch.mjs             # 让模型创建文件，右侧面板应列出并展示 diff

# ---- 验权限档位与计划模式 ----
APP_AUTOTEST=mode node scripts/launch.mjs             # 全放行需二次确认；auto 档不再弹审批

# ---- 验模型热切换（需先配 APP_MODELS，至少两个）----
APP_MODELS='[{"id":"m1","label":"模型一"},{"id":"m2","label":"模型二"}]' \
  APP_AUTOTEST=model node scripts/launch.mjs           # 切后 UI 跟随、未知模型被拒

# ---- 验导出 HTML ----
APP_AUTOTEST=export node scripts/launch.mjs           # 导出并校验磁盘上的文件非空且含对话内容

# ---- 验子任务进度 ----
APP_AUTOTEST=task node scripts/launch.mjs             # 让模型拆三个子任务，卡片应出现且最终转 completed

# ---- 验额外工作目录 ----
APP_AUTOTEST=dirs node scripts/launch.mjs             # 设完后模型能读到外部目录，resume 后仍在

# ---- 验会话分支树 ----
APP_AUTOTEST=tree node scripts/launch.mjs             # 退回后原话回到输入框、历史重建、再发能长新枝

# ---- 验图片输入 ----
APP_AUTOTEST=image node scripts/launch.mjs            # 发纯红图，模型必须回答「红色」

# ---- 验文件回滚 ----
APP_AUTOTEST=rewind node scripts/launch.mjs           # 回退后磁盘文件必须变回旧内容

# ---- 验状态行 ----
APP_AUTOTEST=status node scripts/launch.mjs           # 耗时任务中应显示「正在执行命令 · 2s · 5.1k tokens」

# ---- 验配置持久化（不带 key 启动）----
APP_AUTOTEST=settings node scripts/launch.mjs         # 无 key 时应出现全屏向导；保存后加密落盘

# ---- 验保存即重启 ----
APP_AUTOTEST=restart node scripts/launch.mjs          # 跑着时保存应弹重启确认，不静默打断

# ---- 验错误边界 ----
APP_AUTOTEST=error node scripts/launch.mjs            # 渲染异常应显示恢复页；异步错误弹提示

# ---- CLI（验证数据层，不需要 key）----
cd apps/spike
node build.mjs
node dist/selftest.js        # 6/6
```

### 桌面端环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_PI_API_KEY` | — | **必填**，模型 key |
| `APP_MODEL` | `deepseek-v4.1-flash-1017` | 模型 id |
| `APP_ENDPOINT` | `https://tokenhub.tencentmaas.com/v1` | 上游端点 |
| `APP_API` | `openai-completions` | 协议 |
| `APP_APPROVAL` | `ipc` | `ipc` = 弹审批卡；`allow` = 全放行 |
| `APP_CONTEXT_WINDOW` | `200000` | 上下文窗口，用于 models.json 与压缩判定 |
| `APP_STALL_MINUTES` | `15` | 一轮零事件多久判定卡死（引擎级中止）；0 = 关闭 |
| `APP_STALL_HINT_SEC` | `180` | 界面多久提示「没有响应」（秒） |
| `APP_COMPACT_PCT` | 由 pi 决定（约 90） | 自动压缩在窗口的百分之几处触发；值越小压得越早 |
| `APP_EFFORTS` | 空 = 不支持思考档位 | 逗号分隔的档位，如 `minimal,low,medium,high,xhigh,max`；**配置后才在 UI 显示** |
| `APP_MODELS` | 空 = 只有一个模型 | JSON 数组，配两个以上才出现模型切换下拉。例：`[{"id":"m1","label":"模型一"},{"id":"m2","label":"模型二"}]` |
| `APP_EXPORT_DIR` | `%USERPROFILE%/Documents/Agent 导出` | 导出 HTML 的落地目录 |
| `APP_DATA_DIR` | `%TEMP%/spike-desktop` | 数据库与工作目录（打包版默认 `%APPDATA%/Spike Agent`） |
| `APP_PI_BINARY` | 自动解析 | pi 可执行文件绝对路径 |
| `APP_AUTOTEST` | 关 | `1` = 自动跑一轮对话；`resume` = 验中断续跑；`permission` = 验权限记忆；`queue` = 验输入队列；`compact` = 验上下文压缩；`steer` = 验插话与占用；`diff` = 验改动面板；`mode` = 验权限档位与计划模式；`model` = 验模型热切换；`export` = 验导出 HTML；`task` = 验子任务进度；`dirs` = 验额外工作目录；`tree` = 验会话分支树；`image` = 验图片输入；`rewind` = 验文件回滚；`status` = 验状态行；`settings` = 验配置持久化；`restart` = 验保存即重启；`error` = 验错误边界；`watchdog` = 验卡住提示；`window` = 验窗口记忆；`session` = 验会话管理；`parallel` = 验多会话并行；`notify` = 验完成通知；`routing` = 验事件路由 |

> 渲染层在没有 `window.host` 时自动用 `devMock`，所以直接用浏览器打开 `dist/index.html` 也能看 UI。

### CLI 环境变量（`apps/spike`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SPIKE_PI_API_KEY` | — | 跑真实链路时必填 |
| `SPIKE_ENDPOINT` | `https://api.anthropic.com` | 上游端点 |
| `SPIKE_API` | `anthropic-messages` | 协议 |
| `SPIKE_MODEL` | `claude-sonnet-4-5` | 模型 id |
| `SPIKE_CONTEXT_WINDOW` | `200000` | 上下文窗口 |
| `SPIKE_EFFORTS` | 空 | 逗号分隔；空 = 不支持 effort |
| `SPIKE_APPROVAL` | `allow` | `allow` / `deny` / `ask` |
| `SPIKE_DATA_DIR` | `%TEMP%/spike-host` | 数据根目录 |
| `SPIKE_UPSTREAM_ROOT` | `C:/Users/chiaki/Desktop/agent/upstream/cindy` | 找 pi 二进制 |
| `SPIKE_TIMEOUT_MS` | `180000` | 单轮超时 |

---

## 数据库

5 张表：`sessions` / `messages` / `turns` / `usage_events` / `attachments`，
外加 `schema_migrations`。迁移是内联 SQL 数组，打包成单文件后仍可迁移。

三条最容易踩的：
1. **运行态不进 `sessions.status`** —— 上游混用同一列，把运行中的会话误标成 archived
2. **`client_id` 唯一索引** 保证消息幂等
3. **同毫秒排序必须用 `rowid` 兜底**（自检抓到过真 bug）

---

## 已验证 / 未验证

**已验证**
- vendored maker-core 零改动可用（Pi 引擎）
- 真实模型文本回复 + 工具调用（bash / powershell）
- 审批通道、工具完整输出、token 用量落库
- 消息幂等 / rewind / CAS / 软删 / 外键级联（6/6 自检）
- 中断轮识别并带回续跑所需信息
- Electron 进程启动、sandbox 隔离、IPC 白名单、pi 子进程拉起
- 流式逐字输出（12 段 / 326ms，中间帧抓到半截）
- 中断续跑：启动横幅 → 点继续 → 自动重跑 → 横幅归零
- 会话标题自动生成（规则版，不吃模型往返）
- 权限记忆规则（bash/ls 记住后第二轮 0 次弹窗）
- 输入队列（跑着时连发两条，3 轮全 done，一问一答严格交替）
- 上下文压缩：noop 良性提示 + 边界落库/渲染/重载后仍在
- 插话（`steer`）：数到一半插话改成只数到 5，模型真的停在 5
- 上下文占用条：引擎给出的百分比实时显示，点击即压缩
- 本轮改动面板：真实创建文件后列出 +1，展开能看到 `+hello`
- 权限档位：全放行需二次确认；切到 auto 后审批次数 0
- 计划模式：开关往返正常
- 思考档位：未配置 `APP_EFFORTS` 时不显示；配置后 6 档可切、非法值被拒
- 模型热切换：多模型时出现下拉、切后 UI 跟随、未知模型被拒且不改动当前值
- 导出 HTML：真去磁盘查文件（313 KB），内容含对话、无外部引用（自包含单文件）
- 子任务：模型真的拆出 3 个子任务，卡片从「1 个进行中」转为「全部结束」
- 额外工作目录：模型真读到外部目录里的标记内容；resume 后仍在，清空后归零
- 会话分支树：退回后原话回到输入框、对话区重建（3 个气泡）、再发后树从 4 涨到 6
- 图片输入：发送纯红图，deepseek 回答「红色」；重载后图片仍在
- 文件回滚：`target.txt` 从 `MODIFIED` 退回 `ORIGINAL`，对话区重建、改动面板清空
- 状态行：耗时任务中显示「正在执行命令 · 2s · 5.1k tokens」，结束后自动消失
- 配置持久化：无 key 时出现全屏向导；保存后 `encrypted: true`，文件里无明文 key
- 保存即重启：跑着时保存弹确认框，点「稍后」窗口保留、确认框关闭
- 错误边界：渲染异常显示恢复页（非白屏）；未捕获的 Promise 拒绝弹提示
- 卡住提示：工具执行中（sleep 8 超过阈值）不误报；真无响应时 spinner 停下并变色
- 窗口记忆：保存真实尺寸、最大化记还原后尺寸、屏幕外位置被丢弃
- 打包版：完整跑通一轮对话（11 段流式 / 4 条消息 / 数据库 114KB）
- 会话管理：重命名生效、置顶排序变化、归档可恢复、删除需二次确认
- 多会话并行：A 跑 sleep 10 时切到 B 发消息，A 仍在跑并最终 done（4 条消息落库）；侧栏显示运行标记
- 完成通知：当前会话不打扰、后台无焦点要通知、5 秒节流、无窗口不通知（四条路径）
- 事件路由：A 产出 18 段文本时 B 收到 0 条；B 界面无 A 的内容；A 内容完整落库
- 打包：NSIS 安装包 135 MB，打包后的 exe 完整跑通一轮对话

**未验证**
- 安装包在干净机器上的安装流程（只在开发机跑了免安装版）
- 让 pi 真正压缩成功（它对手动压缩有内置下限，小会话必定 noop；
  而用真实 API 堆到那个量级不经济，目前只验到接线两端）
- 输入队列持久化、FTS 搜索、附件 blob

---

## 注意

`packages/*` 从 upstream **原样拷贝**，实测零改动可用。建议保持这个状态，方便 cherry-pick 上游修复。

唯一需要适配的是 6 处 Vite 专有的 `?raw` 导入 —— 由各 `build.mjs` 的插件处理；正式产品用 Vite 则原生支持。

品牌约束：Apache-2.0 只授权代码，`Cindy` 名称与 Logo 归 XD Inc.（见 `NOTICE`），fork 后必须换名和图标。`design/tokens.css` 已剔除全部品牌命名。
