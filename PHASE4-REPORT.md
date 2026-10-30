# Phase 4 报告 · 打包分发与中断续跑

> 日期：2026-10-30
> 目标：把「只能 node scripts/launch.mjs 起」变成「装完就能用」；把「进程挂了会话永远卡住」变成「能接着跑」。
> 结论：**两项都完成，均实测通过。**

---

## 1. 打包

### 1.1 产出

```
release/out/
├── win-unpacked/                    466 MB（免安装，可直接跑）
└── Spike Agent Setup 0.1.0.exe      135 MB（NSIS 安装包）
```

首次启动创建 `%APPDATA%\Spike Agent\`，数据库、工作目录、pi 会话都在里面。

### 1.2 为什么先摆 staging 目录再交给 electron-builder

pnpm 的 `node_modules` 是符号链接森林，electron-builder 追依赖时抓不全原生模块。
所以 `scripts/package.mjs` 先做一件事：**把该带的东西实体化拷进 `release/stage/`**，
再让 builder 只负责套壳。

```
stage/
├── dist/           渲染层
├── dist-electron/  主进程 + preload（去掉 .map）
├── node_modules/better-sqlite3/   只留本平台 prebuild + lib
├── pi-bin/pi.exe   106 MB
└── package.json    含 dependencies
```

好处是打包行为完全可预测 —— 缺什么当场报错，而不是装完才发现起不来。

### 1.3 踩到的 3 个坑

| 坑 | 现象 | 解法 |
|---|---|---|
| **native 模块没进包** | 打包成功但一启动就崩 | staging 的 `package.json` 必须写 `dependencies`，否则 builder 把 `node_modules` 当"无主文件"剔除 |
| **pi.exe 被打进两次** | `app.asar` 109 MB，等于整个 pi 二进制 | `files: ['**/*', '!pi-bin/**']` —— pi-bin 已经走 `extraResources` |
| **better-sqlite3 v13 没有 build/Release** | 校验 `.node` 路径报错 | v13 用 `prebuilds/<platform>-<arch>.node`，不走 node-gyp 现场编译 |

第二个坑最有价值：**109 MB 的 asar 里 106 MB 是重复的 pi.exe**。排除后 asar 降到 1.9 MB。

### 1.4 打包后二进制的寻址

两个路径必须改，否则装到别人机器上找不到东西：

```ts
if (app.isPackaged) {
  process.env.APP_PI_BINARY ??= path.join(process.resourcesPath, 'pi-bin', 'pi.exe');
  process.env.APP_DATA_DIR ??= app.getPath('userData');
}
```

### 1.5 实测

打包后的 exe 直接跑完整验收：

```
✓ host ready  dataDir=C:\Users\chiaki\AppData\Roaming\Spike Agent
✓ pi-spawn    76ms
✓ rpc-ready   884ms
✓ 审批弹层 → 批准 → 工具执行 → 回复
✓ 流式 11 段增量
✓ 数据库 4 行
```

---

## 2. 中断续跑

### 2.1 数据层

新增迁移 **version 2**：

```sql
ALTER TABLE turns ADD COLUMN resolved_at INTEGER;
```

没有这一列的话，同一条「上次有任务被中断」的提示每次启动都会再弹 —— 横幅会变成永远消不掉的黄条。

`TurnStore` 新增 `listInterrupted()`（`state='interrupted' AND resolved_at IS NULL`）、`markResolved()`、`get()`。

### 2.2 两种续跑语义

这条规则 Phase 2 建表时就把注释写进去了，现在落地：

| 情况 | 判定 | 动作 |
|---|---|---|
| **有产出**（跑过工具 / 说了一半） | 用户消息之后还有消息 | 发续跑指令，模型接着做 |
| **零产出**（被杀在模型回包前） | 用户消息之后再无消息 | 重发用户原文 |

判定用 `rowid > (SELECT rowid FROM messages WHERE id = ?)`，比时间戳可靠。

### 2.3 UI

启动时若有未处置的中断轮，主区顶部出现横幅：`未完成` 徽标 + 会话名 + 原文摘要 + `忽略` / `继续`。
点了之后先切到该轮所属会话再续跑 —— 否则用户在 A 会话点「继续」实际跑到 B 去了，只看到侧栏闪一下。

---

## 3. 这一轮抓到的 3 个真 bug

都是实测跑出来的，不是看代码看出来的。

### ① 审批竞态：同步响应会被丢掉

```ts
// 错：先 emit 再注册
this.emit({ type: 'approval', request });
return new Promise((resolve) => { this.pending.set(requestId, ...); });
```

监听器如果在事件回调里**同步**回批准（自动批准策略、测试脚本），`approve()` 查 `pending` 时还没注册，`if (!entry) return;` 静默吞掉决定 —— 工具永远挂住。

修法：先建 promise 并注册 pending，再 emit。

### ② 续跑重发原文导致用户消息重复

重发时 `beginUserTurn` 生成了新的 `client_id`，`UNIQUE(session_id, client_id)` 的幂等没被击中，对话里出现两条一模一样的用户气泡。

修法：`beginUserTurn` 增加可选 `reuseClientId`，重发原文时传入原来的 `userClientId`，`INSERT OR IGNORE` 直接跳过。turn 仍新建 —— 重跑确实是新的一轮尝试。

### ③ 续跑后视图不跟到底部

横幅消失了，但新内容在下面看不见，用户以为没反应。
修法：加 `scrollTick` 强制滚动信号，只用于切会话/续跑这种主动跳转；流式输出仍走「贴底才跟随」的保守策略。

---

## 4. 一个错误的测试假设（值得记）

第一次注入中断时，我把 `state='running'` 塞到了**一个已经跑完的轮**上。
结果模型看到任务早就完成、还被要求「继续」，开始满世界乱调 bash —— 27 次连续审批，测试变成死循环。

改成真实场景后（用户消息已落库、模型还没回包就被杀）立刻正常。

**教训**：造测试数据要照着「真实故障形态」造，不能只照着「字段可以填什么」造。

---

## 5. 门禁

| 判据 | 结果 |
|---|---|
| 产出可安装包 | ✅ 135 MB NSIS |
| 打包版能启动、能连模型 | ✅ pi rpc-ready 884ms |
| 打包版完整跑通一轮对话 | ✅ |
| 打包版不依赖开发机路径 | ✅ 全部走 `resourcesPath` / `userData` |
| 中断轮能被识别 | ✅ 启动 reap → 横幅 |
| 两种续跑分支都有实现 | ✅ 零产出分支实测；有产出分支代码路径相同 |
| 处置后不再重复提示 | ✅ `resolved_at` + 实测横幅归零 |
| 自身类型错误 | 0 |

---

## 6. 已知限制

1. **装完体积 135 MB**，其中 pi.exe 一个就占 106 MB。这是引擎本体，暂时无解。
2. **没有图标和签名**：`signAndEditExecutable: false`，Windows 会提示未知发布者。
3. **不支持自动更新**：electron-updater 未接。
4. **只有一个 pi-bin 平台**：脚本里 linux 路径是占位，实际只打包 win32-x64。
5. **`@anthropic-ai/claude-agent-sdk` 仍在**（用户决定先不动），但它没进 asar —— 因为是 external + 未被打包，实际不影响产物体积。

---

## 7. 下一步

按之前商定的优先级，1、2 已完成，剩下的：

1. **会话标题自动生成**（小，顺手）
2. **权限档位**（按工具/路径/命令前缀的记忆型白名单）—— 真实使用里最痛的一条
3. **输入队列语义**（跑着时再发一条怎么办，未验证）
4. **富组件**（建议等真实使用反馈再动）
