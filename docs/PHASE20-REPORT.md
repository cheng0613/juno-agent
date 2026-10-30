# Phase 20：配置持久化 + 首次启动向导

你直接跑 `pnpm dev` 撞到的那个错误——`pi not authenticated: no_key`——就是这一项要解决的东西。

**在这之前，别人装完这个 app 是打不开的**：key 只能通过环境变量传，双击 exe 必然失败。这是「给别人用」清单里唯一的真阻断项。

---

## 问题长什么样

```
Error occurred in handler for 'host:bootstrap':
  AgentNotAuthenticatedError: pi not authenticated: no_key
    at _PiAgent.startSessionPrepared ...
```

不是报错文案的问题，是**根本没有任何地方能填 key**。

---

## 三层设计

### 1. 密钥加密存储

用 Electron 的 `safeStorage`（底层是系统密钥库：Windows DPAPI / macOS Keychain）。

```ts
if (safeStorage.isEncryptionAvailable()) {
  stored.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
} else {
  stored.apiKeyPlain = key;   // 明确降级，且标出来
}
```

**加密不可用时不假装安全**：文件里会写 `keyEncrypted: false`，UI 上直接提示「这台电脑的系统密钥库不可用，key 会以明文写入配置文件」。用户有权知道自己的密钥是怎么存的。

验证过——保存后配置文件里**搜不到明文**：

```
明文泄漏: false / 含加密字段: true
配置文件大小: 164 字节
```

### 2. 启动优先级：环境变量 > 本地设置 > 默认值

CI 和脚本注入不该被本地文件覆盖。

底层 `auth adapter` 只认 `process.env`，所以做法是在启动时把设置里的 key **注入到 process.env**——与其改整条链路，不如在入口对齐：

```ts
const settings = await readSettings();
if (settings.apiKey && !process.env.APP_PI_API_KEY) {
  process.env.APP_PI_API_KEY = settings.apiKey;
}
```

### 3. 没 key 时全屏拦截

```
┌────────────────────────────────────┐
│  先配置一下                          │
│  填一个模型接口就能开始用。            │
│  这些只存在你自己的电脑上。            │
│                                    │
│  API Key          未配置            │
│  [sk-...                        ]  │
│                                    │
│  接口地址                            │
│  [https://tokenhub.../v1        ]  │
│                                    │
│  [测试连接]      [保存并开始]        │
└────────────────────────────────────┘
```

**为什么必须拦截**：只弹一个提示条、让用户看到界面但发不出消息，比引导页更糟——用户会以为程序坏了。

有 key 时走原流程，向导完全不出现（回归验证过）。

---

## 两个设计取舍

**保存后重启而不是热生效。**

配置在启动时读一次，运行中的会话已经拿旧配置建好了。热更新会出现「一半新一半旧」的状态，比重启更难排查。所以保存时提示「重启应用后生效」，首次向导里则直接 `app.relaunch()`。

**连通性测试不真跑对话。**

`testSettings` 只请求 `/models` 拿模型列表——快（实测 42ms 级别）、不计费。发一轮对话动辄几秒还要花钱，作为「点一下看看配得对不对」太重了。

失败信息也做了区分：

| 状态码 | 提示 |
|---|---|
| 401 / 403 | Key 无效或没权限 |
| 其它 | 端点返回 N |

---

## 演进：一处小妥协

`configFromEnv()` 原本只读环境变量，现在多接受一个「文件配置」参数：

```ts
export function configFromEnv(file: EnvOverrides = {}): HostConfig
```

三处调用点里有两处只是为了取 `model`，顺手改成了 `rt.currentModel()`——避免为了一个字段把整个配置重算一遍。

---

## 验收

```
全屏向导数量: 1
保存结果: {"encrypted":true}
读回状态: hasKey=true encrypted=true
明文泄漏: false / 含加密字段: true
```

**17 个模式全部通过**，`tsc` 0 错误。

---

## 现在的启动方式

不需要再手打环境变量了：

```bash
cd apps/desktop
pnpm dev        # 第一次会弹配置向导
```

环境变量仍然有效，优先级更高（CI / 打包测试继续用）。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/settingsStore.ts` | 新文件：safeStorage 加密读写、损坏容错、降级标记 |
| `apps/desktop/src/SettingsPanel.tsx` | 新文件：首次向导 + 运行中抽屉 |
| `apps/desktop/electron/hostRuntime.ts` | `configFromEnv(file)` 支持文件配置；`currentModel()` |
| `apps/desktop/electron/main.ts` | 启动读设置并注入 key；四个 IPC（读/存/测/重启） |
| `apps/desktop/src/App.tsx` | 无 key 全屏拦截；侧栏「设置」入口 |
| `apps/desktop/src/shared/ipc.ts` | `SettingsState` / `SettingsInput` / `TestResult` |
| `apps/desktop/electron/autotest.ts` | `runSettingsTest` |
| `apps/desktop/src/styles/app.css` | 设置面板样式 |

## 已知限制

- **改配置要重启**（首次向导会自动重启，运行中修改只提示）
- 换机器 / 换系统用户后 `safeStorage` 解不开，会当作没配——这是加密的必然代价，提示里说明了
- 没有「删除已保存的 key」按钮（要手动删 settings.json）
- 环境变量存在时，设置里的 key 完全不生效（这是有意的优先级，但 UI 只给了文字说明）
- 还没有「最近使用的端点」、模型列表拉取等便利功能
