# Phase 11：模型热切换 + 多模型配置

A 类第五项。这个功能原本被卡住——不是没接线，是**没有第二个模型可选**。

---

## 动手前发现的前提缺失

`setModel()` 在引擎里现成，`switchModel: { supported: true }`。但一看模型清单：

```ts
availableModels: [],
```

我们只在 `capabilityAdditions.availableModels` 里挂了一个写死的 `opts.model`。而 pi 的切换来源就是这份清单——**一个模型意味着没有可切的东西**。

所以这一轮真正做的是「多模型配置」，切换只是它的自然结果。这也顺带解决了未来设置页的一半工作。

---

## 配置格式

`APP_MODELS` 是 JSON 数组：

```json
[
  {"id": "deepseek-v4.1-flash-1017", "label": "DeepSeek"},
  {"id": "gpt-4o", "label": "GPT-4o",
   "endpoint": "https://api.openai.com/v1",
   "api": "openai-completions",
   "contextWindow": 128000}
]
```

只写 id 也行，其余字段回落到单模型那套 env。

**解析失败时退回单模型，不报错。** 配置写错导致启动失败，比少一个切换按钮严重得多。

---

## 切换时的三种情况

引擎的 `previewModelSwitch()` 会先告诉你「会怎么切」：

| action | 含义 | 处理 |
|---|---|---|
| `hot` | 当前运行时能直接服务 | 直接切，历史保留 |
| `refresh` | 需要刷新模型目录 | 直接切，历史保留 |
| `rebuild` | 必须重建会话 | 切，但**弹提示告知上下文可能丢失** |
| `unavailable` | 当下切不了 | 直接报错，附带引擎给的原因 |

**`rebuild` 必须告知用户。** 前三种都可能丢历史，只有 `rebuild` 会让上下文真的重建——不提示的话，用户会困惑「我刚说的话它怎么不记得了」。

**`preview` 本身失败不影响切换。** 预检只是预判，不是前置条件；预检挂了仍然尝试切。

---

## UI：只有一个模型就不摆下拉

```tsx
{models.length > 1 ? <select>…</select> : <span>{model}</span>}
```

一个只有一个选项的下拉是纯认知负担。这和上一轮「没配 `APP_EFFORTS` 就不画档位开关」是同一个原则：**不摆点了没意义的东西**。

---

## 验收：先发现了一个假通过

第一版测试用的两个 id 指向同一端点（`deepseek-v4.1-flash-1017` 和 `...-alt`）。切换成功、UI 跟随、切完还能对话——看起来全绿。

但 `-alt` 这个 id 在端点上**根本不存在**，它却「能正常对话」。说明它是被 `extraModels` 挂进 pi 的 models.json 后就认了，而端点对未知 model 名不校验。

**这是假通过**——它验的是「没报错」，不是「真的换过去了」。

补了一条更有意义的断言：

```
未知模型被拒绝: true
拒绝后的当前模型: deepseek-v4.1-flash-1017-alt   ← 没被污染
```

现在验的是「越界会被挡下，且挡下后状态不变」，这才是切换逻辑该保证的东西。

```
可选模型: [{…DeepSeek Flash}, {…DeepSeek 备用}]
侧栏下拉数量: 1
切换结果: {"rebuilt":false}
切换后当前模型: deepseek-v4.1-flash-1017-alt
UI 下拉当前值: deepseek-v4.1-flash-1017-alt
切换后对话正常
未知模型被拒绝: true
```

---

## 九个模式全部通过

| 模式 | 结果 |
|---|---|
| `1` / `permission` / `queue` / `compact` / `resume` / `steer` / `diff` / `mode` / `model` | 全绿 ✅ |

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/modelCatalog.ts` | 新文件：`APP_MODELS` 解析，失败回落 |
| `packages/host-core/src/host.ts` | `PiHostOptions.extraModels` → `availableModels` |
| `apps/desktop/electron/hostRuntime.ts` | `listModels` / `switchModel`（含 preview 分支） |
| `apps/desktop/electron/main.ts` / `preload.ts` | 两条 IPC |
| `apps/desktop/electron/autotest.ts` | `runModelTest` |
| `apps/desktop/src/shared/ipc.ts` | `model` 事件、两个方法 |
| `apps/desktop/src/App.tsx` | 模型下拉（多模型才显示）、`rebuild` 提示 |
| `apps/desktop/src/devMock.ts` / `styles/app.css` | mock 与样式 |

## 已知限制

- **只切模型 id，不切端点**：`APP_MODELS` 里虽然支持 `endpoint` / `api` 字段，但宿主目前只把 id 和 contextWindow 传给 pi，多端点要等设置页一起做
- 当前模型不持久化到会话列表，重开应用回到 `APP_MODEL`
- `rebuilt` 只在 `switchModel` 的返回值里，UI 弹的是提示条（3.5 秒消失），不是阻塞确认
- 切模型后不做上下文迁移——`rebuild` 场景下历史会真的丢

## 下一步（A 类剩余）

- 后台任务 + 子任务进度（`listBackgroundTasks` / `agent_task_update`）
- 回退到某条消息（`previewRewindFiles` / `commitRewindFiles`）
- 会话分支树 / 导出 HTML
- 额外工作目录（`setExtraDirs` / `setWritableDirs`）
- 图片（`image` 事件）
