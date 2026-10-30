# Phase 10：思考档位（effort）

A 类第四项。原计划做「思考档位 + Fast mode」两件，动手探测后发现 **Fast mode 对我们没有意义**，只做了前者。

---

## 一个提前否决的功能：Fast mode

pi 声明了 `hasFastMode: true`，`setFastMode(true)` 也返回成功。但实测：

```
setFastMode(true) ok  →  getFastMode() 返回 null
```

原因看源码：`setFastMode` 只是调 `updateRequestPrefs()` 记个偏好，**不跟模型通信、不验证**。真正生效靠 `fastModels`，而它只来自原生订阅的 provider：

```ts
const fastModels = nativeProviders.flatMap(p => p.models.filter(m => m.supportsFastMode === true))
```

我们用的 deepseek 走自定义 `openai-completions` 端点，永远不在这个列表里。**做了就是一个点了没反应的假开关**，所以不做。

这是本轮最有价值的判断——省掉一个假功能，而不是省掉工时。

---

## 思考档位：撞了两次「假开关」

### 第一次：能力声明 ≠ 实际可用

`effortLevels` 声明了 6 档（minimal → max），`setEffort` 也在探测脚本里成功过。但接进 UI 后切换失败：

```
pi set_thinking_level refused: effort 'max' is not in Pi's applied model catalog.
```

看引擎源码才明白：

```ts
// efforts:[] 仍可能收到 resolveEffort 的 UI 占位值 low；它代表"不支持切换"
if (!snapshot || (snapshot.length === 0 && effort === 'low')) return;
if (snapshot.includes(effort)) return;
throw new Error(`effort '${effort}' is not in Pi's applied model catalog.`);
```

宿主传的 `APP_EFFORTS` 是空 → pi 只放行 `low` 当占位值，其余全拒。**而探测脚本里我显式传了 6 档才成功**，所以没暴露这个问题。

### 修法：以宿主配置为准，不是以能力声明为准

```ts
const configured = new Set(this.cfg.efforts);
const usable = configured.size === 0 ? [] : levels.filter(id => configured.has(id));
```

- `APP_EFFORTS` 没配 → `effortLevels = []` → **UI 完全不画这个控件**
- 配了 → 只显示「既在能力声明里、又在配置里」的档位

宁可少一个功能，也不摆一个点了会报错的开关。

---

## 文案：不照搬引擎的 displayName

引擎给的是 `Minimal / Low / Medium / High / Extra High / Maximum`。英文单词看不出「差在哪里」。

改成能直接感受到的描述：

| id | 显示 |
|---|---|
| minimal | 最省 |
| low | 省 |
| medium | 标准 |
| high | 深入 |
| xhigh | 很深入 |
| max | 最深入 |

未切换过时引擎 `getEffort()` 返回 null，按钮取其**中间档**显示，不写「默认」——「默认」等于没说，用户还得点开才知道。

---

## 验收（两种配置都跑）

**默认（未配 `APP_EFFORTS`）**：
```
初始档位: null / 可选 []
当前模型不支持思考档位，跳过
```
UI 上不出现思考按钮。

**显式配置 `APP_EFFORTS=minimal,low,medium,high,xhigh,max`**：
```
初始档位: null / 可选 ["minimal","low","medium","high","xhigh","max"]
切到 max 后: max
切到 minimal 后: minimal
非法档位被拒绝: true
UI 思考按钮文案: 思考·最省
```

「非法档位被拒绝」这条是刻意的——不校验的话，一个不存在的档位会被静默传给引擎，报一个用户看不懂的错。

---

## 八个模式全部通过

| 模式 | 结果 |
|---|---|
| `1` | ✅ |
| `permission` | ✅ |
| `queue` | ✅ |
| `compact` | ✅ |
| `resume` | ✅ |
| `steer` | ✅ |
| `diff` | ✅ |
| `mode` | 档位 + 二次确认 + 计划开关 ✅ |

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/hostRuntime.ts` | `setEffort` / `refreshEffort` / `emitModes` 抽公共广播 |
| `apps/desktop/src/ModeControls.tsx` | 思考档位下拉 + `EFFORT_LABELS` |
| `apps/desktop/src/shared/ipc.ts` | `ModeState.effort` / `effortLevels`、`setEffort` 通道 |
| `apps/desktop/electron/main.ts` / `preload.ts` | IPC 接线 |
| `apps/desktop/electron/autotest.ts` | mode 测试加档位段 |
| `apps/desktop/src/App.tsx` / `devMock.ts` / `styles/app.css` | 接入与样式 |
| `apps/spike/src/probeModes.ts` | 一次性探测脚本（保留作参考） |

## 已知限制

- deepseek 未配置 `APP_EFFORTS`，所以**默认 UI 上看不到思考档位**——这不是 bug，是这个模型确实没声明档位
- 档位不跨会话记忆
- `setThinkingEnabled`（思考总开关）没接，目前只有档位没有开关

## 下一步（A 类剩余）

- 模型热切换 `setModel()`
- 后台任务 + 子任务进度
- 回退到某条消息
- 会话分支树 / 导出 HTML
- 额外工作目录
