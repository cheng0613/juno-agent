# Phase 16：图片输入

A 类第十项。先探底再动手——结果比预期好。

---

## 探底结论：真能用

动手前的怀疑：宿主没声明 `supportsImageInput`，引擎按 `m !== false` 默认当成支持，但 deepseek 走 `openai-completions` 端点，视觉输入很可能是假的。

写探测脚本实测了两种方式：

| 方式 | 结果 |
|---|---|
| `send` 里带 `{type:'image', path}` | 回答「红色」 |
| 让模型用 `read` 工具读图 | 回答「红色（色值约 #FF0000）」 |

**两种都成。** 所以不是假支持，可以做。

> 探测脚本自己造 PNG（zlib 压缩 + 手写 CRC32），不依赖任何外部图片文件——这样脚本换台机器也能跑。

---

## 只做入站，不做出站

pi **不发** `image` 事件（出站生成图只有 codex 有）。所以这轮只做「用户发图给模型看」。

这也决定了 UI：只有输入侧的粘贴/拖入和对话里的缩略图，没有「生成图片」入口。

---

## 为什么图片必须先落盘

pi 的 image block 要的是**本地路径**，它自己 `readFile` 后转 base64 发给模型。所以渲染层不能直接把 base64 丢给引擎。

链路：`data URI` → 主进程嗅探类型 → 落盘 → 传路径给 pi。

---

## 四个安全/健壮性细节

**1. 用魔数嗅探，不信声明的 mimeType。** data URI 里那个类型是调用方给的，写错会把 `.exe` 存成 `.png`。只认 PNG / JPEG / GIF / WebP 的文件头字节。

**2. 单张 8MB 上限。** 再大模型也吃不下，还会让请求明显变慢。

**3. 库里只存路径，不存 base64。** 存 base64 会让库迅速膨胀，而图片本来就在磁盘上，存两份没意义。回显时由主进程按路径读回来转 data URI。

**4. 图片读不回来就不带图，不能崩。** 文件可能已被清理，一条历史消息不该让整页挂掉。

---

## UI 上的两个判断

**粘贴时如果有图，吃掉这次粘贴。** 部分平台粘贴图片会同时塞进文件名之类的乱码文本，不吃掉的话输入框里会多出一堆垃圾。

**只发图不打字也能发。** `(!text && pendingImages.length === 0)` 才算空——很多人发图就是为了问「这是什么」。

---

## 验收：验模型真的看见了

```
图片 data URI 长度: 262
模型回答: "红色"
回答里提到红色: true
对话里图片数: 1
重载后带图消息数: 1
```

发一张纯红图，模型必须说出「红色」。**看不到图的模型会瞎猜或说看不到**——这比「发送没报错」有意义得多。

重载校验也做了：库里存路径、读回来转 data URI 这条往返是通的。

---

## 十四个模式全部通过

`1` / `permission` / `queue` / `resume` / `compact` / `steer` / `diff` / `mode` / `model` / `export` / `task` / `dirs` / `tree` / `image` 全绿，`tsc` 0 错误。

## 文件改动

| 文件 | 说明 |
|---|---|
| `apps/desktop/electron/imageAttachment.ts` | 新文件：魔数嗅探、大小限制、落盘 |
| `apps/desktop/electron/hostRuntime.ts` | `send` 支持 images，组装 pi 的 content blocks |
| `packages/host-core/src/recorder.ts` | `beginUserTurn` 增加 images 参数（只存路径） |
| `apps/desktop/electron/main.ts` | `mapRowsToUi` 把路径读回 data URI |
| `apps/desktop/src/App.tsx` | 粘贴/拖入、待发送缩略图条、只发图也能发 |
| `apps/desktop/src/Chat.tsx` | 用户气泡里的图片 |
| `apps/desktop/src/shared/ipc.ts` | `SendInput.images`、`UiMessage.images` |
| `apps/desktop/electron/autotest.ts` | `runImageTest`（现场造 PNG） |
| `apps/spike/src/probeImage.ts` | 一次性探测脚本 |

## 已知限制

- **不能生成图片**（pi 无此能力，只有 codex 有）
- 附件目录不随会话删除，长期会积累垃圾文件
- 没有点击放大查看（缩略图最大 220px）
- 不支持非图片文件附件（pdf / 代码文件等）
- 图片不进 `turn_diff`，也不参与压缩（压缩只压文本）

## 下一步（A 类剩余）

只剩一项：**回退时的文件回滚**（`previewRewindFiles` / `commitRewindFiles`）。

这就是 Phase 15 报告里点名的问题——回退只改对话分支，磁盘上的文件改动仍在。做完它，「回退」才算完整。
