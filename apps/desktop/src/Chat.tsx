import type { UiMessage } from './shared/ipc';

/** 工具卡片：默认折叠，成功的只显示一行，失败的直接展开 */
function ToolCard({ msg, ok }: { msg: UiMessage; ok?: boolean }) {
  const isResult = msg.role === 'tool_result';
  const failed = msg.isError === true;

  if (msg.role === 'tool_use') {
    // ok === undefined 表示结果还没回来
    const state = ok === undefined ? 'pending' : ok ? 'ok' : 'err';
    return (
      <div className="tool-card">
        <span className={`dot ${state}`} />
        <span className="tool-name">{msg.toolName}</span>
        <span className="tool-arg">{oneLine(msg.input)}</span>
      </div>
    );
  }

  if (isResult) {
    return (
      <details className="tool-result" open={failed}>
        <summary>
          <span className={`dot ${failed ? 'err' : 'ok'}`} />
          <span className="tool-name">{failed ? '失败' : '输出'}</span>
          <span className="tool-arg">{firstLine(msg.output)}</span>
        </summary>
        <pre className={failed ? 'err' : ''}>{msg.output}</pre>
      </details>
    );
  }

  return null;
}

function oneLine(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const preferred = rec.command ?? rec.path ?? rec.file_path ?? rec.query;
  const text = typeof preferred === 'string' ? preferred : JSON.stringify(rec);
  return text.replace(/\s+/g, ' ').slice(0, 120);
}

function firstLine(text = ''): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** 12_345 → 12.3k，边界值保留一位小数就够，不必展示完整数字 */
function compactTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 极轻量的行内 Markdown：处理 `code` 与 **粗体**，避免引第三方解析器 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/**
 * 围栏代码块渲染。
 *
 * 之前只做了行内 `code`，不支持 ``` 包裹的多行代码 ——
 * 模型输出代码块时会原样显示那三个反引号，很难看。
 *
 * 不做语法高亮：要引 shiki/highlight.js，包体积和启动时间都变重。
 * 先保证「代码看起来是代码」（等宽字体 + 底色 + 横向滚动）。
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="code-block" data-testid="code-block">
      {lang && <span className="code-lang">{lang}</span>}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * 富文本：先按 ``` 切出代码块，剩下的交给行内渲染。
 *
 * 分割用正则捕获组：split 后奇数下标就是围栏内容。
 */
/**
 * 块级 Markdown：标题 / 列表 / 引用 / 分割线 / 表格。
 *
 * 为什么不做完整的 Markdown 解析器：引 remark/marked 会带进上百 KB，
 * 而且我们要的只是「模型常见的几种块」——它们占了实际输出的 95%。
 * 遇到不认的行就当普通段落，不会崩。
 */
function MarkdownBlocks({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const pushPara = (buf: string[]) => {
    if (buf.length === 0) return;
    out.push(
      <p key={`p${key++}`} className="md-p">
        <Inline text={buf.join('\n')} />
      </p>,
    );
  };

  let para: string[] = [];

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // 空行：断开段落
    if (line.trim() === '') {
      pushPara(para);
      para = [];
      i += 1;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      pushPara(para);
      para = [];
      out.push(<hr key={`hr${key++}`} className="md-hr" />);
      i += 1;
      continue;
    }

    // 标题 ###
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      pushPara(para);
      para = [];
      const level = Math.min(h[1]!.length + 2, 6); // # → h3（h1/h2 留给页面）
      const Tag = `h${level}` as 'h3';
      out.push(
        <Tag key={`h${key++}`} className={`md-h md-h${h[1]!.length}`}>
          <Inline text={h[2] ?? ''} />
        </Tag>,
      );
      i += 1;
      continue;
    }

    // 表格：当前行有 |，下一行是 |---|
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      pushPara(para);
      para = [];
      const split = (row: string) =>
        row
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = split(line);
      i += 2; // 跳过分隔行
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(split(lines[i]!));
        i += 1;
      }
      out.push(
        <div key={`tbl${key++}`} className="md-table-wrap">
          <table className="md-table" data-testid="md-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>
                    <Inline text={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, ci) => (
                    <td key={ci}>
                      <Inline text={r[ci] ?? ''} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      pushPara(para);
      para = [];
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      out.push(
        <ul key={`ul${key++}`} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>
              <Inline text={it} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      pushPara(para);
      para = [];
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      out.push(
        <ol key={`ol${key++}`} className="md-ol">
          {items.map((it, j) => (
            <li key={j}>
              <Inline text={it} />
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      pushPara(para);
      para = [];
      const items: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(
        <blockquote key={`bq${key++}`} className="md-quote">
          <Inline text={items.join('\n')} />
        </blockquote>,
      );
      continue;
    }

    para.push(line);
    i += 1;
  }
  pushPara(para);

  return <>{out}</>;
}

function RichText({ text }: { text: string }) {
  // ```lang\n内容\n``` —— lang 可省略
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  if (parts.length === 1) return <MarkdownBlocks text={text} />;

  const nodes: React.ReactNode[] = [];
  // split 带两个捕获组时，每段是 [文本, lang, code, 文本, lang, code, ...]
  for (let i = 0; i < parts.length; i += 3) {
    const before = parts[i];
    if (before) nodes.push(<MarkdownBlocks key={`t${i}`} text={before} />);
    const lang = parts[i + 1] ?? '';
    const code = parts[i + 2];
    if (typeof code === 'string') {
      nodes.push(<CodeBlock key={`c${i}`} code={code.replace(/\n$/, '')} lang={lang} />);
    }
  }
  return <>{nodes}</>;
}

/**
 * 错误卡片。
 *
 * 直接甩原始错误（`401 Unauthorized … signature verification failed …
 * 127.0.0.1:57889`）等于把排查工作丢给用户：
 * 那个 127.0.0.1 是 pi 内部的 loopback 代理，用户会以为是我们坏了。
 *
 * 所以分三层：
 *   1. 人话标题（发生了什么）
 *   2. 提示（为什么 + 该做什么）+ 可选的动作按钮
 *   3. 可折叠的原始错误（排查时才展开）
 */
function ErrorCard({ msg }: { msg: UiMessage }) {
  const d = msg.diagnosis;
  const raw = d?.raw || msg.text || '';

  if (!d) {
    // 旧数据（诊断层之前存的消息）没有 diagnosis —— 退回原样显示
    return (
      <div className="bubble-error">
        <span className="badge err">错误</span>
        <span>{raw}</span>
      </div>
    );
  }

  return (
    <div className="err-card" data-testid="error-card" role="alert">
      <div className="err-card-head">
        <span className="err-card-icon" aria-hidden>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="8" r="6.3" />
            <path d="M8 4.8v3.6M8 11.2v.2" />
          </svg>
        </span>
        <span className="err-card-title" data-testid="error-title">
          {d.title}
        </span>
      </div>

      {d.hint && <p className="err-card-hint">{d.hint}</p>}

      {d.action && (
        <div className="err-card-actions">
          {d.action === 'open-settings' && (
            <button
              type="button"
              className="err-card-btn primary"
              data-testid="error-action-settings"
              onClick={() => {
                // 渲染层通过自定义事件告诉 App 打开设置；Chat 拿不到 App 的 state
                window.dispatchEvent(new CustomEvent('juno:open-settings'));
              }}
            >
              打开设置
            </button>
          )}
          {d.action === 'check-network' && (
            <button
              type="button"
              className="err-card-btn primary"
              data-testid="error-action-settings"
              onClick={() => window.dispatchEvent(new CustomEvent('juno:open-settings'))}
            >
              检查接口地址
            </button>
          )}
          {d.action === 'restart-app' && (
            <button
              type="button"
              className="err-card-btn primary"
              data-testid="error-action-restart"
              onClick={() => window.dispatchEvent(new CustomEvent('juno:restart-app'))}
            >
              重启应用
            </button>
          )}
        </div>
      )}

      {raw && (
        <details className="err-card-raw">
          <summary>技术细节</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </div>
  );
}

export function MessageRow({ msg, ok }: { msg: UiMessage; ok?: boolean }) {
  if (msg.role === 'tool_use' || msg.role === 'tool_result') {
    return <ToolCard msg={msg} ok={ok} />;
  }

  if (msg.role === 'user_steer') {
    // 插话不画右侧气泡，而是靠左一条带「插话」标记的窄条 ——
    // 它属于上面那一轮中途的补充，不是一次新提问
    return (
      <div className="row-steer">
        <span className="steer-badge">插话</span>
        <div className="bubble-steer">
          <RichText text={msg.text ?? ''} />
        </div>
      </div>
    );
  }

  if (msg.role === 'user') {
    return (
      <div className="row-user">
        <div className="bubble-user">
          {msg.images && msg.images.length > 0 && (
            <div className="bubble-images">
              {msg.images.map((src, i) => (
                <img className="bubble-image" src={src} alt="用户发的图片" key={i} />
              ))}
            </div>
          )}
          {/* 用户消息原样显示，**不解析 Markdown** ——
              用户写什么就该看到什么。把用户写的「## 标题」渲染成真标题，
              等于替他改了内容。 */}
          {msg.text ? <span className="user-raw">{msg.text}</span> : null}
        </div>
      </div>
    );
  }

  if (msg.role === 'error') {
    return <ErrorCard msg={msg} />;
  }

  if (msg.role === 'thinking') {
    return (
      <details className="thinking">
        <summary>思考过程</summary>
        <div>{msg.text}</div>
      </details>
    );
  }

  if (msg.role === 'compact_boundary') {
    const c = msg.compact;
    return (
      <div className="compact-line" title="这之前的对话已被摘要代替，原始记录仍保留在上面">
        <span className="compact-rule" />
        <span className="compact-text">
          上下文已压缩
          {c?.trigger === 'manual' ? '（手动）' : ''}
          {c && c.preTokens != null && c.postTokens != null
            ? ` · ${compactTokens(c.preTokens)} → ${compactTokens(c.postTokens)} tokens`
            : ''}
        </span>
        <span className="compact-rule" />
      </div>
    );
  }

  return (
    <div className={`bubble-ai${msg.streaming ? ' streaming' : ''}`}>
      <RichText text={msg.text ?? ''} />
    </div>
  );
}

export function Chat({
  messages,
  liveText,
  running,
}: {
  messages: UiMessage[];
  liveText: string;
  running: boolean;
}) {
  const empty = messages.length === 0 && !liveText;

  // tool_use 卡片的状态由「有没有对应 tool_result」决定 —— 结果可能晚于卡片到达
  const resultByToolId = new Map<string, boolean>();
  for (const m of messages) {
    if (m.role === 'tool_result' && m.toolUseId) {
      resultByToolId.set(m.toolUseId, m.isError !== true);
    }
  }

  return (
    <div className="chat">
      {empty && (
        <div className="empty">
          <h2>有什么可以帮你？</h2>
          <p>它可以在你的工作目录里读写文件、执行命令。</p>
        </div>
      )}

      {messages.map((m) => (
        <MessageRow
          key={m.id}
          msg={m}
          ok={m.toolUseId ? resultByToolId.get(m.toolUseId) : undefined}
        />
      ))}

      {liveText && (
        <div className="bubble-ai streaming">
          <RichText text={liveText} />
        </div>
      )}

      {running && !liveText && (
        <div className="bubble-ai working">
          <span className="spinner" />
          <span>正在处理…</span>
        </div>
      )}
    </div>
  );
}
