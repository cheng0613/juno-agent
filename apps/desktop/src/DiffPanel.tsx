import type { FileChange, TurnDiffPayload } from './shared/ipc';

/**
 * 本轮改动面板。
 *
 * 设计取舍：默认只列文件名 + 增删行数，点开才看 diff。
 * 因为绝大多数时候用户只关心「它动了哪几个文件」，
 * 一上来就铺几百行 diff 反而看不清重点。
 *
 * 样式用 Tailwind utility（与上游 Cindy 一致）。
 * 少数 utility 表达不了的（RTL 路径截断、diff 行着色）留在 app.css。
 */
export function DiffPanel({
  payload,
  onClose,
}: {
  payload: TurnDiffPayload;
  onClose: () => void;
}) {
  const totalAdd = payload.changes.reduce((n, c) => n + c.insertions, 0);
  const totalDel = payload.changes.reduce((n, c) => n + c.deletions, 0);

  return (
    <aside
      data-testid="diff-panel"
      className="absolute right-0 z-30 flex w-[min(460px,60%)] flex-col border-l border-default bg-surface-elevated shadow-lg"
      style={{
        top: 'var(--topbar-h, 37px)',
        bottom: 'var(--composer-h, 92px)',
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-default px-4 py-3">
        <span className="flex-1 text-13 tabular-nums text-text-primary">
          {payload.changes.length} 个文件改动
          {totalAdd > 0 && <span className="text-[var(--success)]"> +{totalAdd}</span>}
          {totalDel > 0 && <span className="text-[var(--danger)]"> −{totalDel}</span>}
        </span>
        <button
          className="shrink-0 rounded px-2 py-0.5 text-16 leading-none text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          title="收起"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {!payload.tracked && (
        <p className="m-0 border-b border-default px-4 py-2 text-11 text-text-tertiary">
          当前目录不是 git 仓库，只能列出碰过的文件，看不到具体改动。
        </p>
      )}

      <div className="flex-1 overflow-auto py-2">
        {payload.changes.map((change) => (
          <details
            key={change.path}
            data-testid="diff-file"
            className="border-b border-default"
          >
            <summary className="diff-summary flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-12 hover:bg-surface-hover">
              <StatusDot status={change.status} />
              <span className="diff-path flex-1 font-mono text-text-primary">{change.path}</span>
              <span className="inline-flex shrink-0 gap-1 font-mono text-11 tabular-nums">
                {change.insertions > 0 && (
                  <span className="text-[var(--success)]">+{change.insertions}</span>
                )}
                {change.deletions > 0 && (
                  <span className="text-[var(--danger)]">−{change.deletions}</span>
                )}
              </span>
            </summary>
            <DiffBody payload={payload} file={change.path} />
          </details>
        ))}
      </div>

      {payload.truncated && (
        <p className="m-0 border-t border-default px-4 py-2 text-11 text-text-tertiary">
          改动太多，diff 已截断。
        </p>
      )}
    </aside>
  );
}

function StatusDot({ status }: { status: FileChange['status'] }) {
  const label =
    status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : 'M';
  const color =
    status === 'added'
      ? 'text-[var(--success)]'
      : status === 'deleted'
        ? 'text-[var(--danger)]'
        : status === 'renamed'
          ? 'text-[var(--brand)]'
          : 'text-[var(--warning)]';
  return (
    <span className={`w-4 shrink-0 rounded text-center font-mono text-11 ${color}`}>
      {label}
    </span>
  );
}

/**
 * 从合并后的 diff 里切出属于这个文件的那一段。
 *
 * 为什么不在主进程按文件拆好：一整段 unified diff 只有几 KB，
 * 而按文件拆要多跑 N 次 git（或者写个解析器），得不偿失。
 * 前端切一次的成本可以忽略。
 */
function DiffBody({ payload, file }: { payload: TurnDiffPayload; file: string }) {
  if (!payload.diff) {
    return <p className="m-0 px-4 py-2 text-11 text-text-tertiary">这个文件没有可显示的行级改动。</p>;
  }

  const sections = splitByFile(payload.diff);
  const section = sections.get(file) ?? sections.get(`b/${file}`) ?? '';
  if (!section) {
    return (
      <p className="m-0 px-4 py-2 text-11 text-text-tertiary">
        没有这个文件的 diff 片段（可能是新增或重命名）。
      </p>
    );
  }

  return (
    <pre className="diff-body m-0 max-h-[420px] overflow-auto bg-surface-sunken py-2 font-mono text-11 leading-normal">
      {section.split('\n').map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'dl-meta';
  if (line.startsWith('@@')) return 'dl-hunk';
  if (line.startsWith('+')) return 'dl-add';
  if (line.startsWith('-')) return 'dl-del';
  return 'dl-ctx';
}

/** 把一段合并 diff 按目标文件切开 */
function splitByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) out.set(current, buffer.join('\n'));
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      // diff --git a/foo b/foo —— 取 b 后面的路径
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = match ? match[2]! : null;
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}
