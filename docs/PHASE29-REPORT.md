# Phase 29：改名为 Juno

产品名从「Spike Agent」（开发占位名）改成 **Juno**。

`spike` 在工程语境里是「探针 / 一次性验证」，发给别人等于告诉对方这是半成品。

---

## 改了什么

| 类别 | 内容 |
|---|---|
| **产品名** | `productName: 'Juno'`、`Juno.exe`、`Juno Setup 0.1.0.exe` |
| **包名** | `@spike/*` → `@juno/*`（3 个 package.json + 19 处 import） |
| **界面** | 侧栏品牌文本、`<title>Juno</title>` |
| **根包** | `name: juno`，脚本 `spike` → `cli` |
| **验证脚本** | 安装路径、userData 路径 |

共 18 个文件。

---

## 一处容易漏、漏了会「丢数据」

Electron 的 `app.getPath('userData')` **跟着 productName 变**：

```
改名前：%APPDATA%/Spike Agent/
改名后：%APPDATA%/Juno/
```

旧目录里躺着 `app.db`、`settings.json`、`pi-agent-home/`。不搬的话，用户升级后打开是**一片空白**——像被重置了，而且没法解释。

### 加了迁移（`migrateUserData.ts`）

```ts
const LEGACY_APP_NAMES = ['Spike Agent'];   // 以后改名往这里加
```

三条约束：

**① 只在目标为空时搬** —— 新目录已经有数据（用户已经在用新版）就不碰

**② 失败不阻断启动** —— 搬不动就用空目录跑，比起不来强

**③ 搬完留标记** —— `.migrated-from`，避免重复搬

`fs.cp` 用复制而不是移动，**旧目录保留**：万一新版本有问题，用户还能退回旧版本接着用。

调用时机在 `main.ts` 的 `whenReady` 里，**必须在读设置之前**——否则会读到空目录。

---

## 验证

- `tsc` 0 错误
- **26 个 autotest 模式全过**（改名动了包名和 19 处 import，必须全量验）
- 截图确认侧栏左上角是 **Juno**

---

## 已知限制

- **图标还没做**（现在用 Electron 默认图标）。名字定了，图标随时可以做。
- 迁移逻辑只在 `app.isPackaged` 时跑；开发环境目录本来就是临时的，不需要
- `apps/spike` 这个目录名没改（它是 CLI 验证工具，不是产品）。如果以后要改，注意 `pnpm-workspace.yaml` 和构建脚本里的路径
- 安装包名变了，**新旧两版能同时安装**（不同安装路径）。正式发版前要确认用户不会装两份

---

## 顺带：MCP spike 也验完了

`docs/SPIKE-MCP.md`：

```
1. MCP server 起得来: 是
2. pi 能发现工具并调用: 是（mcp:spike_bridge:echo_back）
3. 请求回到宿主: 是
4. 结果回到模型: 是
```

**ORCA 派活没有技术阻塞。**

踩到的坑：一个 `StreamableHTTPServerTransport` 只能服务一次 initialize 握手，stateless 模式必须每个请求新建。表现是 `tools/list` 正常但 `tools/call` HTTP 500——只验「能列工具」会以为成功了。
