# Phase 19：样式体系对齐 Cindy

不是新功能，是把**样式技术路线**从「手写 CSS」换成与上游一致的「Tailwind + design tokens」，配色也换成 Cindy 的。

---

## 先搞清楚 Cindy 是怎么做的

翻上游才发现差别不在配色，在**架构**：

| | Cindy | 我们（改之前） |
|---|---|---|
| token | DTCG 源 → @terrazzo 生成 `tokens.css`（106 行） | 手抄 95 个变量 |
| 应用方式 | Tailwind utility（`text-13` / `bg-surface`） | 自定义 class（`.topbar-action`）+ 手写 CSS |
| 组件样式 | global.css 只放 base 层 | `app.css` **1424 行全手写** |

所以「与它保持一致」= 换技术路线，不只是调色值。

---

## 颜色是怎么拿到的

Cindy 的颜色 token 是**两层引用**：

```
themes/builtin.json  cindy-light.surface
   → $value: "{reference.themes.cindy-light.value-surface}"
reference/themes.json  value-surface
   → { colorSpace: "srgb", components: [0.949, 0.949, 0.929] }
```

写脚本按引用链解析、把 DTCG color 对象转成 CSS 颜色，**产出 354 个角色**（light + dark 各 177）。

关键值对比：

| token | Cindy | 我们之前 |
|---|---|---|
| `--surface` | `rgb(242 242 237)` #f2f2ed | `#f4f4ef` |
| `--accent-cta-bg` | `rgb(60 63 67)` 深灰 | `#1b1a17` 近黑 |
| `--text-primary` | `rgb(0 0 0 / 0.88)` | `#1b1a17` |

暖灰家族没变，但**主 CTA 从「近黑」变成「深灰」**，这是视觉上最明显的差异。

### 一个容易误判的 token

`--accent` 在 Cindy 里是 **`hsl(0 0% 0% / 0.05)`** —— 那是「淡黑底」，不是品牌色。真正的强调深灰是 `--accent-emphasis`。

第一版把 `--brand` 映射到 `--accent`，结果所有强调色都变成透明的。**名字像的 token 不能猜，要查值。**

---

## 迁移策略：别名层过渡

1424 行 CSS 一次重写风险太大。分两步：

**第一步（本次）**：建 `legacy-aliases.css`，把旧变量名映射到 Cindy token：

```css
--bg: var(--surface);
--brand: var(--accent-emphasis);   /* 不是 --accent */
--radius-sm: 6px;                   /* Cindy 没有这级，自己补 */
```

于是「换配色」立刻生效，组件样式一行不动。

**第二步（以后）**：组件逐个改写成 utility class，最后删掉别名层。

---

## 撞到的三个问题

### 问题 1：CSS 变量循环，样式大面积失效

第一版别名层写了这样的东西：

```css
--surface-elevated: var(--surface-elevated);
--text-primary: var(--text-primary);
```

这些名字**和 Cindy token 完全同名**，等于自引用 → CSS 变量变成无效值 → 所有引用它的地方退回浏览器默认样式。

表现：圆角全变尖、气泡变直角、卡片失去层次。截图一看就发现不对。

修法：别名层只映射**真正不同名**的变量。注释里明确写死这条规矩。

### 问题 2：Tailwind 在 Vite 里静默不生效

按常规配 `css.postcss` 内联插件，构建成功、无报错，但产物里**没有 preflight、没有 utility 类**。

逐步二分才定位：
- 单独跑 postcss + tailwind → 正常（preflight 生成）
- 走 `viteBuild({ configFile })` → 插件完全没介入

这不是配错，是**构建器路径下配置没被读到**。与其继续和构建器较劲，改成明确的方案：`postbuild-css.mjs` 独立跑一遍 postcss 生成 `app.generated.css`，Vite 只负责打包。

> 顺带记一个排查弯路：我一开始用 `grep "border-style: solid"` 判断 preflight 是否存在，
> 但压缩后的 CSS 可能换写法，导致误判「没生效」。后来改成直接看生成物文件才确认。

### 问题 3：Windows 下动态 import 绝对路径

`await import('C:\\...\\postbuild-css.mjs')` 直接报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

Windows 下必须是 `file://` URL：`new URL('../postbuild-css.mjs', import.meta.url).href`。

---

## 验收

不看「构建成不成功」，看**产物里有没有真东西**：

```
[css] app.generated.css 47.3kb
--surface: rgb(242 242 237)        ← Cindy 的值
--accent-cta-bg: rgb(60 63 67)     ← 深灰 CTA
border-style: solid                ← tailwind preflight 存在
```

界面截图确认：浅色/暗色都正常，圆角与层次恢复。

**16 个模式全部通过**，`tsc` 0 错误。

---

## 一个看起来像 bug 的设计

暗色主题下用户气泡是**近白底 + 深色字**，看着刺眼。

查 token 才确认这是 Cindy 的设计：

```css
.dark { --accent-cta-bg: rgb(238 238 238); }   /* 暗色下 CTA 反而是亮的 */
```

参考图里用户消息气泡也确实偏亮。**保持不变**——对齐就要对齐到底，不能一半用它的 token、一半用自己的审美。

---

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/styles/tokens.css` | 新文件：354 个颜色角色，从 Cindy 主题解析 |
| `apps/desktop/src/styles/base-tokens.css` | 新文件：字号/间距/圆角/动效 |
| `apps/desktop/src/styles/legacy-aliases.css` | 新文件：旧名 → Cindy token 过渡映射 |
| `apps/desktop/src/styles/app.css` | 入口改为 `@tailwind` + token import |
| `apps/desktop/tailwind.config.ts` | 新文件：token → utility 映射（同上游结构） |
| `apps/desktop/postbuild-css.mjs` | 新文件：独立跑 tailwind 编译 |
| `apps/desktop/vite.config.ts` | 关掉 CSS 的 postcss（避免双重处理） |
| `apps/desktop/scripts/build.mjs` | 构建前先编 CSS |
| `apps/desktop/src/main.tsx` | 引入生成产物 |
| `.gitignore` | 排除 `app.generated.css` |

## 已知限制

- **组件样式还没改成 utility**：现在靠别名层撑着，第二步没做
- `--radius-sm/md` 是自己补的（Cindy 只有 4/12/16/full 四级）
- 阴影 token 是自定的（Cindy 没有 shadow 体系）
- 主题切换只有 light/dark 两套，Cindy 内置主题更多（atom-one-light 等），没做
- 没引入高亮主题（`highlight.js` 的 github/github-dark），代码块颜色还是自定的
