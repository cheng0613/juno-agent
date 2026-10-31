# Phase 24：会话管理（B 类第一项）

侧栏一堆「新会话」，改不了名、删不掉、找不着。这是每天都在磨损体验的东西。

---

## 四项能力

| 操作 | 说明 |
|---|---|
| **重命名** | 双击标题就地编辑（不弹对话框） |
| **置顶** | 排序时永远在最前，不被新会话挤下去 |
| **归档** | 从侧栏移走，可恢复 |
| **删除** | 彻底删除，**二次确认** |

---

## 三个设计决策

### 1. 归档而不是只有删除

删错了整个会话的对话就永久没了，太重。归档满足「先清干净侧栏」的需求，又留了后路。

所以是两档破坏性：
- 归档 → 从列表消失，可恢复
- 删除 → 外键 CASCADE 一起删 messages / turns / usage_events，不可恢复

### 2. 重命名做成就地编辑

弹对话框会打断视线，而改名通常只是改一两个字。双击 → 直接改 → 回车生效。

细节：
- 空标题**不改**（避免误操作把名字清成空白），抛错
- 上限 120 字
- **不动 `updated_at`** —— 改名不是「有新活动」，否则侧栏会自己跳位

### 3. 置顶用时间戳不用布尔

`pinned_at: INTEGER` 而不是 `pinned: BOOLEAN`。多个置顶会话之间也需要排序，存时间戳天然按置顶先后排。

排序 SQL：

```sql
ORDER BY pinned_at IS NULL, pinned_at DESC, updated_at DESC
```

`pinned_at IS NULL` 排在前（0 < 1），置顶的按置顶时间新→旧，其余按最近活动。

---

## 迁移

migration v6：加 `pinned_at` / `archived_at` 两列，默认 NULL。

列表查询加 `WHERE archived_at IS NULL`。

---

## UI

会话项悬停出现「⋯」菜单：

```
┌──────────────┐
│ 置顶          │
│ 重命名        │
│ 归档          │
│ 删除…         │  ← 红色
└──────────────┘
```

点「删除…」**不直接删**，先在菜单内展开确认：

```
┌──────────────────────┐
│ 删除后这个会话的对话   │
│ 无法恢复。            │
│           [取消][删除] │
└──────────────────────┘
```

用内联确认而不是全屏对话框——删除的是侧栏里一个小东西，弹全屏太隆重。

---

## 撞到的两个问题

### 问题 1：菜单按钮打开就消失

「⋯」用 `group-hover:opacity-100` 控制显隐。菜单打开后鼠标移开，按钮跟着消失，看着像菜单悬空。

修：菜单打开时强制 `opacity-100`。

```tsx
className={... ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}}
```

### 问题 2：测试里界面只有 1 个会话

第一版测试用 `runtime.createSession()` 直接建会话——**React 的 `sessions` state 不知道**，界面只显示 bootstrap 时那一个。

改成走真实 UI 路径（点「+ 新会话」按钮）：

```
UI 建出 3 个会话: 新会话, 新会话, 改过名的甲
界面会话项数: 3
```

这类「测试绕过 UI 导致验不到 UI」的问题在之前的阶段也踩过（附件、导出、队列）。**凡是要验界面的，必须走界面路径建数据。**

---

## 验收

```
重命名后: 改过名的甲
空标题被拒绝: true
置顶前顺序: 乙 > 甲
置顶后顺序: 甲 > 乙          ← 排序真的变了
归档后列表: 新会话, 改过名的甲   ← 乙消失了
归档列表: 会话乙              ← 但能找回
恢复后列表: 会话乙, 改过名的甲
界面会话项数: 3
菜单项数: 4
删除确认按钮出现: 1           ← 不是直接删
删除前 3 个 → 删除后 2 个
```

---

## 22 个模式全部通过

`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/src/SessionItem.tsx` | 新文件：会话项 + 就地重命名 + 菜单 |
| `packages/host-core/src/db/schema.ts` | migration v6：`pinned_at` / `archived_at` |
| `apps/desktop/electron/hostRuntime.ts` | `renameSession` / `setSessionPinned` / `archiveSession` / `unarchiveSession` / `listArchivedSessions` / `deleteSession`；列表排序 |
| `apps/desktop/src/App.tsx` | 替换侧栏渲染 + 四个动作 |
| `apps/desktop/src/shared/ipc.ts` | `SessionSummary.pinned`、`ArchivedSession`、七条通道 |
| `apps/desktop/electron/autotest.ts` | `runSessionOrgTest` |

## 已知限制

- **没有「归档列表」的 UI 入口**——后端有 `listArchivedSessions`，但界面上没地方看和恢复。归档后目前只能通过代码找回。
- 删除正在运行的会话时，那一轮会被打断（`this.session = null`），但没有提示
- 归档面板没有搜索/筛选，归档多了要自己翻
- 重命名不校验重名（两个会话可以同名）
- 没有拖拽排序、没有批量操作
- 归档不会清理工作区文件

## B 类剩余

- **归档列表 UI**（上面的已知限制，半天就能补）
- **多会话并行**（切会话会打断当前轮，是 ORCA 的前置）
- 草稿持久化、快捷键、通知、附件、项目分组
