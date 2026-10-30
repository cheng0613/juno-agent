import { useState } from 'react';

import type { TreeEntry } from './shared/ipc';

/**
 * 会话分支树。
 *
 * 语义是「回到某一轮重问」，不是「切换分支视角」——
 * 引擎会把那句话原文放回输入框，用户改完再发就长出新枝。
 * 所以按钮文案写「从这里重来」，而不是「切换」。
 *
 * 样式走 Tailwind utility；悬停显隐用 group-hover。
 */
export function TreePanel({
  roots,
  busy,
  onNavigate,
  onClose,
}: {
  roots: TreeEntry[];
  busy: boolean;
  onNavigate: (entryId: string, turnIndex?: number) => void;
  onClose: () => void;
}) {
  return (
    <aside
      data-testid="tree-panel"
      className="absolute right-0 z-30 flex w-[min(460px,58%)] flex-col border-l border-default bg-surface-elevated shadow-lg"
      style={{ top: 'var(--topbar-h, 37px)', bottom: 'var(--composer-h, 92px)' }}
    >
      <div className="flex items-center border-b border-default px-4 py-3">
        <span className="flex-1 text-13 text-text-primary">从这里重来</span>
        <button
          className="rounded px-2 py-0.5 text-16 leading-none text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          title="收起"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="m-0 border-b border-default px-4 py-2 text-11 leading-relaxed text-text-tertiary">
        选一个你问过的问题，会退回那一刻并把原话放回输入框。改完再发就是另一条路。
      </p>
      <div className="flex-1 overflow-auto py-2">
        {roots.length === 0 ? (
          <p className="m-0 px-4 py-3 text-12 text-text-placeholder">这段对话还没有可回退的地方</p>
        ) : (
          roots.map((root) => (
            <TreeRow key={root.id} node={root} depth={0} busy={busy} onNavigate={onNavigate} />
          ))
        )}
      </div>
    </aside>
  );
}

function TreeRow({
  node,
  depth,
  busy,
  onNavigate,
}: {
  node: TreeEntry;
  depth: number;
  busy: boolean;
  onNavigate: (entryId: string, turnIndex?: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const isUser = node.role === 'user';
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        data-testid="tree-row"
        className={`group flex items-center gap-1 py-0.5 pr-2 text-12 hover:bg-surface-hover ${
          node.active ? '' : 'opacity-45'
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {hasChildren ? (
          <button
            className="w-3.5 shrink-0 cursor-pointer border-0 bg-transparent p-0 text-11 leading-none text-text-tertiary"
            title={open ? '收起' : '展开'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span
          className={`shrink-0 rounded px-[4px] text-11 ${
            isUser
              ? 'bg-[var(--ink)] text-[var(--text-inverse)]'
              : 'bg-surface-chip text-text-tertiary'
          }`}
        >
          {isUser ? '你' : '它'}
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${isUser ? 'text-text-primary' : 'text-text-secondary'}`}
          title={node.preview}
        >
          {node.preview || '（无内容）'}
        </span>
        {isUser && (
          <button
            data-testid="tree-replay"
            className="shrink-0 rounded border border-[var(--border-strong)] bg-transparent px-2 py-px text-11 text-text-secondary opacity-0 group-hover:opacity-100 hover:border-[var(--brand)] hover:text-[var(--brand)] disabled:cursor-default disabled:opacity-40"
            disabled={busy}
            title="退回到这里，并把这句原话放回输入框"
            onClick={() => onNavigate(node.id, node.turnIndex)}
          >
            重来
          </button>
        )}
      </div>
      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            busy={busy}
            onNavigate={onNavigate}
          />
        ))}
    </div>
  );
}
