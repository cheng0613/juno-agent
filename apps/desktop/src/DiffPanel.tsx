import type { FileChange, TurnDiffPayload } from './shared/ipc';

/**
 * 本轮改动面板。
 *
 * 设计取舍：默认只列文件名 + 增删行数，点开才看 diff。
 * 因为绝大多数时候用户只关心「它动了哪几个文件」，
 * 一上来就铺几百行 diff 反而看不清重点。
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
    <aside className="diff-panel">
      <div className="diff-head">
        <span className="diff-title">
          {payload.changes.length} 个文件改动
          {totalAdd > 0 && <span className="diff-add"> +{totalAdd}</span>}
          {totalDel > 0 && <span className="diff-del"> −{totalDel}</span>}
        </span>
        <button className="ghost diff-close" title="收起" onClick={onClose}>
          ×
        </button>
      </div>

      {!payload.tracked && (
        <p className="diff-note">
          当前目录不是 git 仓库，只能列出碰过的文件，看不到具体改动。
        </p>
      )}

      <div className="diff-files">
        {payload.changes.map((change) => (
          <details className="diff-file" key={change.path}>
            <summary>
              <StatusDot status={change.status} />
              <span className="diff-path">{change.path}</span>
              <span className="diff-stat">
                {change.insertions > 0 && <span className="diff-add">+{change.insertions}</span>}
                {change.deletions > 0 && <span className="diff-del">−{change.deletions}</span>}
              </span>
            </summary>
            <DiffBody payload={payload} file={change.path} />
          </details>
        ))}
      </div>

      {payload.truncated && <p className="diff-note">改动太多，diff 已截断。</p>}
    </aside>
  );
}

function StatusDot({ status }: { status: FileChange['status'] }) {
  const label =
    status === 'added'
      ? 'A'
      : status === 'deleted'
        ? 'D'
        : status === 'renamed'
          ? 'R'
          : 'M';
  return <span className={`diff-status diff-status-${status}`}>{label}</span>;
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
    return <p className="diff-note">这个文件没有可显示的行级改动。</p>;
  }

  const sections = splitByFile(payload.diff);
  const section = sections.get(file) ?? sections.get(`b/${file}`) ?? '';
  if (!section) {
    return <p className="diff-note">没有这个文件的 diff 片段（可能是新增或重命名）。</p>;
  }

  return (
    <pre className="diff-body">
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
