# Phase 12：导出 HTML

A 类第六项。pi 原生 `export_html`，纯本地渲染不调网关。

---

## 做了什么

顶栏「导出」→ 把当前会话写成单个 HTML 文件 → 落盘到「文档」目录 → **自动在系统文件管理器里选中它**。

三个细节：

**1. 指定路径，不让 pi 自选。** 它自选的默认位置在 app 数据目录深处，用户根本找不到，导完还得去翻日志。落到 `文档/Agent 导出/` 最直观。

**2. 导完 `shell.showItemInFolder()`。** 导出了却找不到等于没导。

**3. 文件名消毒。** 用会话标题做文件名，去掉 Windows 非法字符，并特别处理末尾的点和空格——它们在 Windows 上会被静默吃掉，导致路径对不上。

---

## 验收：不只看「有没有返回路径」

导出功能最容易出的问题是「返回了个路径，文件其实是空的」。所以直接去磁盘查：

```
提示文案: 已导出到 C:\...\exports\用一句话说明什么是 HTTP 缓存-2026-10-30-06-44-39.html
文件大小: 320942 字节
HTML 长度: 320900
包含对话内容: true
```

**再验一层：是不是自包含单文件。** 这是用户明确偏好过的性质（好分享、好存档）。检查静态外链：

```
外链 <link>: 0
外链 <script src>: 0
内联 <style>: 2
内联 <script>: 6
```

pi 的 export_html 是自包含的：样式脚本内联，图片走 `data:` URI。

> 排查时踩了个小坑：正则抓 `src=` 时匹配到了**内联 script 源码里的模板字符串**（`<img src="${e}">`），一度以为有外链。改成只解析 `<img ...>` 标签内的静态属性才看清。教训：检查生成物时，别把源码当成品。

---

## 顺手修的两处

**1. compact 测试选择器撞车。** 顶栏原来只有一个 `.topbar-action`，加了「导出」后 `querySelector('.topbar-action')` 抓到的是导出按钮，compact 测试点了导出还以为自己点了压缩。

改成按文本匹配（`找 textContent 含「压缩」的那个`）。**这是新增并列元素时的典型回归**——凡是 `querySelector` 第一个匹配，加了就坏。

**2. 提示条挡住对话。** 原本浮在顶部中央，长路径（`C:\Users\...\xxx.html`）占三行，把消息盖住了。移到输入框上方，既不挡内容，离用户视线也近。

---

## 十个模式全部通过

| 模式 | 结果 |
|---|---|
| `1` / `permission` / `queue` / `resume` / `compact` / `steer` / `diff` / `mode` / `model` / `export` | 全绿 ✅ |

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/hostRuntime.ts` | `exportHtml()` + `sanitizeFileName()` + `HostConfig.exportDir` |
| `apps/desktop/electron/main.ts` | IPC + `shell.showItemInFolder` + 文档目录注入 |
| `apps/desktop/electron/preload.ts` | 桥接 |
| `apps/desktop/electron/autotest.ts` | `runExportTest` + compact 选择器修正 |
| `apps/desktop/src/shared/ipc.ts` | `exportHtml` 通道 |
| `apps/desktop/src/App.tsx` | 导出按钮、`exporting` 状态、提示条 6 秒 |
| `apps/desktop/src/styles/app.css` | 提示条改到输入框上方 |
| `apps/desktop/src/devMock.ts` | mock |

## 已知限制

- 导出的是 pi 自带的 HTML 模板，样式不跟随我们的 design tokens（深色主题导出来的还是它默认配色）
- 导出期间 UI 不显示进度，大会话可能要等一两秒
- 文件名用标题 + 时间戳，同名会话同一秒导出会覆盖（概率极低）

## 下一步（A 类剩余）

- 后台任务 + 子任务进度（`listBackgroundTasks` / `agent_task_update`）
- 回退到某条消息（`previewRewindFiles` / `commitRewindFiles`）
- 会话分支树（`getSessionTree` / `navigateSessionTree`）
- 额外工作目录（`setExtraDirs` / `setWritableDirs`）
- 图片（`image` 事件）
