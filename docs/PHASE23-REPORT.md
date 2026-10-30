# Phase 23：窗口记忆 + 干净机器验证

D 类第三、四项。

---

# 一、窗口尺寸记忆

每次打开都变回固定的 1180×800，用户每次都得重新调。

## 两个容易做错的点

### 1. 最大化时要记「还原后」的尺寸

`win.getBounds()` 在最大化状态下返回的是**整个屏幕**。记成那个值，用户取消最大化后窗口会变成满屏大小、再也缩不回去。

用 `win.getNormalBounds()`：

```ts
const normal = win.getNormalBounds();   // 无论是否最大化，都返回还原后的尺寸
maximized: win.isMaximized(),
```

验收里专门测了这条：

```
最大化: true / 记录尺寸: 1001x701 / 屏幕: 1707
```

记录的是 `1001x701`，不是屏幕的 `1707`。

### 2. 位置可能失效

上次在副屏、这次副屏拔了；或者分辨率变了 → 恢复出来的窗口在屏幕外，用户会遇到「程序启动了但窗口看不见」。

恢复前校验位置是否还落在某个可见工作区里：

```ts
const overlapX = Math.min(x + width, dx + dw) - Math.max(x, dx);
const overlapY = Math.min(y + height, dy + dh) - Math.max(y, dy);
return overlapX >= 80 && overlapY >= 80;
```

失效时**只丢位置、保留尺寸**——让系统默认居中打开，比硬塞一个屏幕外坐标强。

```
屏幕外位置处理结果: {"width":1000,"height":700}   ← x/y 被丢掉
正常位置: x:100 保留
```

## 保存时机

用 `'close'` 而不是 `'closed'`：

```ts
win.on('close', () => { if (win) void saveWindowState(win); });
win.on('closed', () => { win = null; });
```

`'closed'` 时窗口已销毁，拿不到 bounds。

配置文件损坏 → 用默认值，不让 app 起不来。

## 顺手修的硬编码

`backgroundColor: '#f4f4ef'` 是 Phase 19 换配色时漏掉的（Cindy 是 `#f2f2ed`）。这处必须硬编码——页面加载前就要用它，读不到 CSS 变量。

---

# 二、干净机器安装验证

现在安装包只在开发机跑过免安装版，**「别人装上去会不会崩」从没验过**。这个风险比没图标大得多。

## 我做了什么

写了 `scripts/verify-install.mjs`——**不依赖项目源码，只要一个 Node 就能跑**，方便拷到目标机器。

三类检查：

**静态**（安装包里该有的东西在不在）
| 检查 | 为什么 |
|---|---|
| `pi.exe` 存在 | 引擎本体，缺了没法工作 |
| `better-sqlite3` 已解包 | 原生模块没解包必崩 |
| `app.asar` < 30MB | 偏大通常意味着 pi.exe 被打进去两次 |

**环境**：Node 版本、平台、系统、内存。

**启动**：真启动一次，12 秒内不崩 + 用户数据目录能建出来。

## 本机验证结果

```
✓ pi 引擎存在 — 106MB
✓ better-sqlite3 已解包
✓ app.asar 体积正常 — 2.1MB
✓ 启动后保持运行 — 12 秒内没有崩溃
✓ 用户数据目录已创建
=== 结果：10/10 通过 ===
```

**但「没崩」不等于「能用」**（可能只是弹了配置向导）。所以又做了一步更硬的验证：**对打包版跑一轮完整对话**。

```
[host] createSession ↑ elapsedMs=879
[autotest] 流式增量: 11 段 / 共 160 字
[autotest] 数据库消息数: 4
[autotest] 完成
```

打包版完整跑通：会话建立、流式输出、消息落库。**数据库文件真实生成 114KB**——证明 better-sqlite3 在打包环境里工作正常。

打包时那条 `cannot find path for dependency node-addon-api@undefined` 是无害的间接依赖警告。

## 怎么用

在干净机器上：

```bash
# 1. 双击安装包装完
# 2. 把 verify-install.mjs 拷过去
node verify-install.mjs
```

注意：这个脚本验证的是「安装包结构 + 能启动」，**不等于用户视角的完整体验**。真正要人做的还是手动点一遍：配置 key → 发消息 → 看回复。

---

## 21 个模式全部通过

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/windowState.ts` | 新文件：读写 + 屏幕校验 + 最大化处理 |
| `apps/desktop/electron/main.ts` | 恢复尺寸、`close` 时保存、背景色对齐 Cindy |
| `apps/desktop/electron/autotest.ts` | `runWindowStateTest` |
| `apps/desktop/scripts/verify-install.mjs` | 新文件：干净机器验证脚本 |

## 已知限制

- **窗口状态在多显示器切换时只做「是否可见」判断**，不会记住「原来在副屏」
- 只记宽高/位置/最大化，不记全屏、不记缩放
- `verify-install.mjs` 只验结构和启动，**真人操作路径仍需人工点一遍**
- 安装包仍是 135MB（pi.exe 占 106MB）

## D 类剩余

- **D5 图标 + D6 签名**：需要品牌名，等你定
- **D7 自动更新**：等前面稳定
