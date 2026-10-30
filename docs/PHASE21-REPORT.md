# Phase 21：错误边界

本阶段包含两块：
- **样式收尾**：5 个独立组件改用 Tailwind utility（PHASE19 的遗留）
- **D 类第一项**：错误边界

---

# 一、样式收尾

Phase 19 建了别名层做过渡，这次把结构独立的 5 个组件真正改成 utility：

| 组件 | 原 class 数 | 说明 |
|---|---|---|
| StatusLine | 5 | 状态行 |
| DiffPanel | 17 | 改动面板 |
| TaskCard | 9 | 子任务卡片 |
| TreePanel | 12 | 分支树 |
| ExtraDirsPanel | 14 | 工作目录 |

`app.css` 从 **1712 行降到 1224 行（-29%）**。

## utility 表达不了的三处，保留在 CSS

| 需求 | 为什么 utility 不行 |
|---|---|
| RTL 路径截断（`direction: rtl`） | 要的是「截中间保留尾部」，没有对应 utility |
| diff 行着色（按行内容前缀） | 颜色取决于字符串内容，不是静态类名 |
| spinner 旋转动画 | keyframes 只能写在 CSS 里 |

## 一个连带问题：测试全依赖 class 名

迁移后测试直接红：

```
界面卡片数: 0 / 条目数: 0   ← .task-card 找不到了
```

**class 名会随样式方案变，data 属性不会。** 所以给关键元素加了 `data-testid`，测试改用它：

```tsx
<aside data-testid="diff-panel" className="absolute right-0 ...">
```

```js
document.querySelectorAll('[data-testid="diff-panel"]')
```

这是「换样式方案」必须一起做的迁移——不然每次调样式都要修测试。

---

# 二、错误边界

在这之前，渲染层任何异常都是**一片白**，用户只能强杀进程。

## 分两层接

| 层 | 接什么 | 表现 |
|---|---|---|
| `ErrorBoundary` | React 渲染期同步异常 | 全屏恢复页 |
| 全局监听 | `window error` / `unhandledrejection` | 角落 toast |

**为什么必须两层**：React 的 error boundary **接不到**事件回调和 Promise 里的错误。只做边界的话，这类错误会静默消失——用户看到「点了没反应」，比白屏更难排查。

## 恢复页给三条路

```
┌────────────────────────────────────────┐
│ [出错了] 界面遇到一个未处理的问题          │
│                                        │
│ 对话数据没有丢，都保存在本地。            │
│ 可以先重试；重试无效就重新加载界面。       │
│                                        │
│ Error: xxx                             │
│   at ...                               │
│                                        │
│      [复制详情] [重新加载] [重试]        │
└────────────────────────────────────────┘
```

- **重试**：重置边界状态，让 React 重渲染（多半能救回来）
- **重新加载**：彻底重来
- **复制详情**：带完整堆栈，方便反馈

**「对话数据没有丢」这句是刻意写的。** 用户看到错误第一反应是「我的东西还在吗」，不主动说明，他们会以为全没了。

## toast 做了去重

同一个失败如果在一个循环里触发，会瞬间刷几十条。所以同一条消息 3 秒内只弹一次。

---

## 验收：真的抛错

不是检查「组件存在」，是真的让 React 崩一次。

为此在 App 里加了个**只在 `APP_AUTOTEST` 下挂载**的崩溃开关：

```tsx
{crashForTest && <CrashForTest />}   // 无条件 throw

function CrashForTest(): never {
  throw new Error('autotest-render-crash');
}
```

`window.__crashForTest` 只在 preload 挂了 `__autotestInject` 时才暴露——正常用户碰不到。

两条都验过：

```
异步错误提示: "未处理的 Promise 拒绝: Error: autotest-rejection"
触发渲染期错误: ok
恢复页数量: 1          ← 不是白屏
```

---

## 顺带：开了渲染层 sourcemap

原来只有主进程有。带上 `sourcemap: 'hidden'`——生成 `.map` 但不写 `sourceMappingURL` 注释，devtools 能加载、界面里不暴露。

不过**堆栈里仍是压缩后的位置**（`index-Bo-PmL7O.js:57:13937`）。真正要看懂得用 source-map 解析，而「把错误上报到服务端」是那之后的事——这次不做（没有服务端）。

---

## 19 个模式全部通过

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/ErrorBoundary.tsx` | 新文件：全屏恢复页 |
| `apps/desktop/src/globalErrorToast.ts` | 新文件：非致命错误提示（DOM 直写，React 外也能用） |
| `apps/desktop/src/main.tsx` | 包 ErrorBoundary + 两个全局监听 |
| `apps/desktop/src/App.tsx` | 验收专用崩溃开关 |
| `apps/desktop/src/{StatusLine,DiffPanel,TaskCard,TreePanel,ExtraDirsPanel}.tsx` | 改 utility |
| `apps/desktop/src/styles/app.css` | 1712 → 1224 行 |
| `apps/desktop/electron/autotest.ts` | `runErrorBoundaryTest`；选择器改 `data-testid` |
| `apps/desktop/src/globals.d.ts` | `__autotestInject` 类型 |

## 已知限制

- **堆栈是压缩后的**，需 source-map 解析才能读（没做）
- 错误不上报（没有服务端）；只在控制台和用户复制里
- 全局 toast 只提示不恢复——已离开 React 调用栈，恢复交给用户手动重试
- 组件样式还有 App.tsx（981 行）/ Chat.tsx / ModeControls / SettingsPanel 没迁
- `--radius-*` 等是自补的（Cindy 只有 4/12/16/full 四级）

## D 类剩余

- **D4 超时看门狗**：轮卡住会永远转圈
- **D8 窗口尺寸记忆**：每次打开固定大小
- D5 图标 / D6 签名 / D7 自动更新 / D9 干净机器验证
