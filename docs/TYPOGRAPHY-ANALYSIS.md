# Cindy 的排版为什么"舒服"——逐层分析

我把 Cindy 的 design-token、globals.css、MarkdownRenderer、chatChrome 全部过了一遍，
和我们的实现逐项对比。

**结论先说：不是某一项特别强，是三层都做对了，而我们三层都有偏差。**

---

## 第一层：字体栈（最容易被忽略，影响最大）

### Cindy 的做法

```css
/* globals.css:160 */
/* CJK 字体放在 Segoe UI / Roboto 之前: Windows 上 Segoe UI 自带 《》 等
   CJK 标点的窄字形, 会跟相邻 CJK 字符 fallback 到 YaHei 的全角字形混在
   同一行, 出现"一个半角一个全角"。把 CJK 字体提前后, Inter 没覆盖的
   CJK 标点直接落到 PingFang/YaHei, 宽度统一。Latin 仍然走 Inter, 无副作用。 */
font-family: var(--app-font-ui, var(--app-font-ui-default));
```

栈顺序：
```
'Inter Variable', Inter, -apple-system, BlinkMacSystemFont,
'PingFang SC', 'Hiragino Sans GB', 'HarmonyOS Sans SC',
'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC',
'Source Han Sans SC',
'Segoe UI', Roboto, sans-serif      ← 注意：Segoe UI 在 CJK 字体**之后**
```

**关键点：`Segoe UI` 排在所有 CJK 字体后面。**

我们的是：
```
'Inter Variable', Inter, -apple-system, BlinkMacSystemFont,
'PingFang SC', 'Hiragino Sans GB', 'HarmonyOS Sans SC',
'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC',
'Source Han Sans SC',
'Segoe UI', Roboto, sans-serif      ← 一样在后面
```

**这一项我们是对的。** 之前 Phase 19 抄过来了。

### 但 Cindy 还有一层我们完全没有

```css
html:lang(ja) { --app-font-ui-default: ... 'Hiragino Kaku Gothic ProN' ... }
html:lang(ko) { --app-font-ui-default: ... 'Apple SD Gothic Neo' ... }
```

注释写着：

> 同一汉字在中/日/韩字体中字形不同（康熙体 vs 新字体 vs 한국체）；
> 不按 lang 区分会出现"日文界面里的汉字看起来像中文"

**我们没做。** 只影响多语言界面，现在只有中文，不急。

---

## 第二层：字号刻度（差距最大的一层）

### Cindy 有两套体系

```css
/* 语义刻板：带行高 */
--text-xs: 12px;  --text-xs-line-height: 16px;
--text-sm: 14px;  --text-sm-line-height: 20px;
--text-base: 16px; --text-base-line-height: 24px;
--text-lg: 18px;  --text-lg-line-height: 28px;

/* 像素刻板：不带行高，行高由用它的地方指定 */
--text-10/11/12/13/14/15/16/18/20/24/28
```

### 但我们两边数值其实一样

| | Cindy | 我们 |
|---|---|---|
| 12px 行高 | 16px | 16px ✅ |
| 14px 行高 | 20px | 20px ✅ |
| 15px 正文 | `leading-[1.6]` = 24px | `--leading-relaxed` 1.6 ✅ |

**所以数字层面我们没错。** 差在**用的时候**。

---

## 第三层：Markdown 排版刻度（真正的问题在这）

### 聊天正文

```ts
// chatChrome.ts:7
export const CHAT_BODY_CLASS = 'text-15 font-normal leading-[1.6]';
```

我们：`font-size: var(--text-15); line-height: var(--leading-relaxed);` —— **一致**。

### 标题（差得最多）

| 级别 | Cindy | 我们 | 差异 |
|---|---|---|---|
| h1 | `text-20` / **1.4** / **font-medium** | 18px / 1.35 / **semibold** | 字号小 2px、字重太重 |
| h2 | `text-18` / **1.556** / **font-medium** | 16px / 1.35 / **semibold** | 字号小 2px、行高紧 0.2 |
| h3 | `text-16` / **1.5** / **font-medium** | 15px / 1.35 / semibold | 全部偏小偏紧 |

**三个偏差叠加**：

1. **字号每级小 1–2px**
2. **行高紧**（1.35 vs 1.4–1.556）
3. **字重太重**（600 vs 500）

第 3 点最要命。中文在 600 字重下笔画会糊在一起，尤其是 YaHei 这类没有真 600 字形的字体——浏览器会**合成加粗**，看起来发虚发脏。

### 列表

| | Cindy | 我们 |
|---|---|---|
| 外边距 | `my-2` = 8px | `margin: 0 0 0.6em` ≈ 9px ✅ |
| 左缩进 | `ml-6` = 24px | `padding-left: 1.4em` ≈ 21px ⚠️ 略少 |
| 项间距 | `space-y-1` = 4px | `margin: 0.2em 0` ≈ 3px ⚠️ 略少 |

小差异，但列表项一多就显紧。

### 行内 code（差得明显）

```ts
// MarkdownRenderer.tsx:305
const INLINE_CODE_CLASS =
  'font-mono text-14 rounded-[6px] px-[0.4em] py-[0.2em] bg-[var(--msg-md-inline-code-bg)]';
```

| | Cindy | 我们 |
|---|---|---|
| 字号 | **14px（与正文同级）** | **13px** ❌ |
| 圆角 | **6px** | **4px** ❌ |
| 左右内距 | `0.4em` | `0.35em` ⚠️ |
| 上下内距 | `0.2em` | `0.1em` ⚠️ |

**字号比正文小 2px 是个明显错误**——行内 code 混在中文里时，大小不一致会显得"跳"。

Cindy 注释还写了为什么用 6px 圆角：

> 几何与底色对齐 GitHub（6px 圆角 + 左右内距 + 半透明淡底）

### 分割线

| | Cindy | 我们 |
|---|---|---|
| 上下边距 | `my-4` = **16px** | `margin: 1.1em` ≈ 16px ✅ |

### 消息间距

```ts
'msg-stream-items flex flex-col gap-3.5'   // 14px
```

我们：`gap: 14px` ✅ **一致**（上一轮改的）

---

## 还有一个隐藏差异：辅助文字的字重与行高

```tsx
// AssistantMessage.tsx
className="mb-1 text-13 font-normal leading-[1.384615]"
```

**13px 配 18px 行高**（1.384615 是精确值）。

这透露 Cindy 的一个原则：**小字号配更紧的行高**。13px 用 18px（1.38），
而我们小字普遍用 `--text-13-lh: 18px` —— 一致。

但注意它**显式写了 `leading-[1.384615]`** 而不是用变量。说明这个值是被单独调过的。

---

## 汇总：我们该改什么

按影响从大到小：

| 项 | 现状 | 应改为 | 影响 |
|---|---|---|---|
| **标题字重** | 600 semibold | **500 medium** | ⭐⭐⭐ 中文合成加粗发虚 |
| **标题字号** | 18/16/15 | **20/18/16** | ⭐⭐⭐ 层级不够开 |
| **标题行高** | 1.35 | **1.4 / 1.556 / 1.5** | ⭐⭐ 偏紧 |
| **行内 code 字号** | 13px | **14px**（与正文同级） | ⭐⭐⭐ 混排时"跳" |
| **行内 code 圆角** | 4px | **6px** | ⭐ 细节 |
| **行内 code 内距** | 0.1em/0.35em | **0.2em/0.4em** | ⭐ 细节 |
| 列表缩进 | 1.4em | 1.5em（24px） | ⭐ 略紧 |

---

## 一句话总结

**Cindy 的"舒服"来自三件事的叠加：**

1. **字体栈把 CJK 放在 Latin 系统字体之前** → 中英混排标点宽度统一（我们已做）
2. **标题用 medium 而不是 semibold** → 中文不会合成加粗发虚（**我们没做**）
3. **行内 code 与正文同字号** → 中英混排不跳（**我们没做**）

第 1 条是"看起来专业"，第 2、3 条是"看起来舒服"。

**最便宜的修法：先改标题字重 600 → 500。** 一行 CSS，效果立竿见影。
