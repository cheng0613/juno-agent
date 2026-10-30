import { useState } from 'react';

import type { TreeEntry } from './shared/ipc';

/**
 * 会话分支树。
 *
 * 语义是「回到某一轮重问」，不是「切换分支视角」——
 * 引擎会把那句话原文放回输入框，用户改完再发就长出新枝。
 * 所以按钮文案写「从这里重来」，而不是「切换」。
 */
export function TreePanel({
  roots,
  busy,
  onNavigate,
  onClose,
}: {
  roots: TreeEntry[];
  busy: boolean;
  onNavigate: (entryId: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="tree-panel">
      <div className="tree-head">
        <span className="tree-title">从这里重来</span>
        <button className="ghost tree-close" title="收起" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="tree-note">
        选一个你问过的问题，会退回那一刻并把原话放回输入框。改完再发就是另一条路。
      </p>
      <div className="tree-body">
        {roots.length === 0 ? (
          <p className="tree-empty">这段对话还没有可回退的地方</p>
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
  onNavigate: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const isUser = node.role === 'user';
  const hasChildren = node.children.length > 0;

  return (
    <div className="tree-node">
      <div
        className={`tree-row${node.active ? ' active' : ''}${isUser ? ' user' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {hasChildren ? (
          <button
            className="tree-toggle"
            title={open ? '收起' : '展开'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tree-toggle" />
        )}
        <span className={`tree-role ${isUser ? 'user' : 'ai'}`}>{isUser ? '你' : '它'}</span>
        <span className="tree-preview" title={node.preview}>
          {node.preview || '（无内容）'}
        </span>
        {isUser && (
          <button
            className="tree-replay"
            disabled={busy}
            title="退回到这里，并把这句原话放回输入框"
            onClick={() => onNavigate(node.id)}
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
