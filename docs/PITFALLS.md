# 踩坑记录

## 1. 文件是 CRLF，脚本替换会静默失败

**现象**：用 node 脚本做 `str.replace(a, b)`，脚本不报错但文件没变。
一次改十处，可能只成功两处，而且**没有任何提示**。

**原因**：仓库里 27 个源文件是 **CRLF** 换行，5 个是 LF。
在模板字符串里写 `\n` 永远匹配不上 CRLF 的文件。

```js
// ❌ 失败（文件是 CRLF）
s.replace('foo\nbar', 'foo\nbaz')

// ✅ 成功
s.replace('foo\r\nbar', 'foo\r\nbaz')
```

**后果**：我曾经连"已修复"的代码其实一行没改就写进报告，被用户追问才发现。

**对策**：
1. 改代码优先用 `edit` 工具（它做精确匹配，不受换行影响）
2. 非用脚本不可时，**改完必须验证**（`grep -c` 或 `git diff`）
3. 或者统一换行：`node -e "..."` 里先 `s.split('\r\n').join('\n')` 再处理

**检查哪些文件是 CRLF**：
```bash
file apps/desktop/src/*.tsx apps/desktop/electron/*.ts | grep CRLF
```

---

## 2. `taskkill /F /IM pi.exe` 会杀掉 Cindy 自己

Cindy 运行时进程也叫 `pi.exe`（`%APPDATA%/Cindy/pi/<ver>/pi.exe`），
按名字杀会把用户的 Cindy 一起终止。

**只按 PID 树终止**：`taskkill /F /T /PID <pid>`

---

## 3. 验 UI 必须走 UI 路径建数据

直接调 `runtime.createSession()` / `archiveSession()` / `renameSession()`
**只改宿主状态，不更新 React state**。

表现：界面上什么都不变，测试断言失败，但数据库里是对的。

**对策**：点真实按钮（`data-testid`），或者等 React 自己刷新。

这个坑记了三次（Phase 24 / Orca / mode 测试）。

---

## 4. `grep` 中文在构建产物里搜不到

esbuild 会把中文转成 `\uXXXX` 转义，`grep "中文"` 在 `dist-electron/main.js`
里永远匹配不到。用英文标识符或 `grep -c` 计数代替。

---

## 5. 注释没闭合会静默吃掉后面所有代码

```js
/* ---- 2. 建 worker ----
 * 说明...
 */
```
如果写成 `/* ---- 2. 建 worker ----`（少了 `*/`），
**后面整段代码都被注释掉**，表现是「日志完全不打印」，很难查。

---

## 6. 两个请求并发时"谁先到"会影响结果

`bootstrap` 和 `readModes` 同时发，`readModes` 可能先到 ——
那时会话还没 attach，`capabilities` 是空的。

表现：权限档位显示内置默认值，看起来"正常"，实际读错了。

**对策**：有依赖关系的状态**一次返回**，不要拆成两个请求。
（`BootstrapResult.modes` 就是这么改的）
