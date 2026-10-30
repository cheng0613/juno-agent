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

export function MessageRow({ msg, ok }: { msg: UiMessage; ok?: boolean }) {
  if (msg.role === 'tool_use' || msg.role === 'tool_result') {
    return <ToolCard msg={msg} ok={ok} />;
  }

  if (msg.role === 'user') {
    return (
      <div className="row-user">
        <div className="bubble-user">
          <Inline text={msg.text ?? ''} />
        </div>
      </div>
    );
  }

  if (msg.role === 'error') {
    return (
      <div className="bubble-error">
        <span className="badge err">错误</span>
        <span>{msg.text}</span>
      </div>
    );
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
      <Inline text={msg.text ?? ''} />
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
          <Inline text={liveText} />
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
