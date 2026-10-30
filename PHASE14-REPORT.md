# Phase 14：额外工作目录

A 类第八项。让会话除了主工作目录，还能读写别的地方。

---

## 一个必须分清的区别：只读 vs 可写

引擎里是**两个独立接口**，不是「加个目录」一个动作：

| 接口 | 引擎字段 | 含义 |
|---|---|---|
| `setExtraDirs` | `readOnlyRoots` | 能读，不能改 |
| `setWritableDirs` | `writableRoots` | 能读也能改 |

所以 UI 上是**两块分开的列表**。如果合并成一个，用户会以为「加进来就能写」，结果改不动文件还以为坏了——这类「以为是 bug 的体验问题」比真 bug 更消耗信任。

可写区特意用橙色标签 + 「谨慎添加」的提示。

---

## 设计上的三个取舍

**1. 落库用 JSON 列，不建关联表。** 目录数量很少，也不需要单独查询。migration v4 加两列 `extra_read_dirs` / `extra_write_dirs`，默认 `'[]'`。

**2. 先落库再动引擎。** 反过来会出现「UI 上看着设了，重启后没了」。引擎报错时至少设置还在，用户能重试。

**3. `resume()` 里必须重放。** 这些目录只存在于运行时，不重放的话重启一次就白设了——这是本项最容易漏掉的一环，也是验收里专门测的一条。

重放失败只 warn 不抛：目录可能已经被删了，不该让一个失效设置把会话拦在门外。

**去重与归一化**：`normalizeDirs` 统一 `path.resolve` 后去重，同一目录写成 `./foo` 和 `foo` 不会算两次。

---

## 面板打开时自己拉数据

一开始面板直接用 App 的 `extraDirs` state。问题是：如果目录被别处改过（另一个窗口、或重启后），state 是陈旧的。

改成**点开面板时重新 `readExtraDirs`**：

```tsx
onClick={() => {
  const next = !dirsOpen;
  setDirsOpen(next);
  if (next && activeId) void host.readExtraDirs(activeId).then(setExtraDirs);
}}
```

这既修了测试，也是更健壮的设计——面板显示的永远是当前真值。

---

## 验收：验「权限真的生效」，不是「记了一条配置」

```
设置后: {"read":["...\\outside-dir"],"write":[]}
面板条目数: 1
模型读到了标记内容: true        ← 关键
resume 后: {"read":["...\\outside-dir"],...}   ← 重启后仍在
清空后: {"read":[],"write":[]}
```

第二条最有说服力：在外部目录放一个唯一标记文件（`EXTRA-DIR-MARKER-7c3f`），让模型用 bash 读它。模型能念出标记内容，说明目录权限真的交给了引擎，而不只是我们记了条配置。

---

## 十二个模式全部通过

`1` / `permission` / `queue` / `resume` / `compact` / `steer` / `diff` / `mode` / `model` / `export` / `task` / `dirs` 全绿，`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `packages/host-core/src/db/schema.ts` | migration v4：两列 JSON |
| `apps/desktop/electron/hostRuntime.ts` | `setExtraDirs` / `readExtraDirs` / `reapplyExtraDirs` + 归一化工具 |
| `apps/desktop/src/ExtraDirsPanel.tsx` | 新文件：只读/可写两块面板 |
| `apps/desktop/src/shared/ipc.ts` | `ExtraDirs`、三条通道 |
| `apps/desktop/electron/main.ts` | IPC + `dialog.showOpenDialog` |
| `apps/desktop/electron/autotest.ts` | `runExtraDirsTest` |
| `apps/desktop/src/App.tsx` / `devMock.ts` / `styles/app.css` | 接入与样式 |

## 已知限制

- **diff 面板看不到额外目录的改动**——它只看主工作目录的 git 状态
- 权限记忆规则（Phase 5 的白名单）按 tool+subject 匹配，不区分目录；额外目录里的操作命中的是同一套规则
- 目录被删除后设置仍留着，只在 resume 时 warn
- 没有「最近用过的目录」快捷选择
- 额外目录不参与 `auto` 档的「工作区内自动放行」判定——那里只认主工作目录

## 下一步（A 类剩余）

- 回退到某条消息（`previewRewindFiles` / `commitRewindFiles`）——**风险最高的一项**
- 会话分支树（`getSessionTree` / `navigateSessionTree`）
- 图片（`image` 事件）
- `APP_MODELS` 的多端点部分（endpoint 字段目前没传给 pi）
