import { useEffect, useRef, useState } from 'react';

import type { SessionSummary } from './shared/ipc';

/**
 * 侧栏的一个会话项。
 *
 * 三个交互：
 *   - 单击切换
 *   - 双击标题 / 菜单「重命名」→ 就地编辑（不弹对话框，改完回车即生效）
 *   - 悬停出现「⋯」菜单：置顶、重命名、归档、删除
 *
 * 为什么重命名要做成就地编辑：弹对话框会打断视线，
 * 而改名通常只是改一两个字，就地改最快。
 */
export function SessionItem({
  session,
  active,
  busy,
  onSelect,
  onRename,
  onPin,
  onArchive,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  /** 这个会话正在跑（可能是后台会话） */
  busy?: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onPin: (pinned: boolean) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // 点外面关菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // 外部改了标题（比如自动生成）要与本地同步
  useEffect(() => {
    if (!editing) setDraft(session.title);
  }, [session.title, editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === session.title) {
      setDraft(session.title);
      return;
    }
    onRename(next);
  };

  const closeMenu = () => {
    setMenuOpen(false);
    setConfirmDelete(false);
  };

  return (
    <div
      data-testid="session-item"
      data-session-id={session.id}
      className={`group relative flex items-center rounded-md ${
        active ? 'bg-[var(--surface-active)]' : 'hover:bg-surface-hover'
      }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          data-testid="session-rename-input"
          className="w-full rounded border border-[var(--border-focus)] bg-surface px-3 py-2 text-14 text-text-primary outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              setDraft(session.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <>
          <button
            className={`min-w-0 flex-1 overflow-hidden rounded-md px-3 py-2 text-left text-14 ${
              active ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'
            }`}
            title={session.title}
            onClick={onSelect}
            onDoubleClick={() => setEditing(true)}
          >
            <span className="flex items-center gap-1">
              {session.pinned && <span className="shrink-0 text-11 text-text-tertiary">📌</span>}
              {busy && (
                <span
                  data-testid="session-busy"
                  className="session-busy shrink-0"
                  title="这个会话正在跑"
                />
              )}
              <span className="truncate">{session.title}</span>
            </span>
          </button>

          <div className="relative shrink-0" ref={menuRef}>
            <button
              data-testid="session-menu-btn"
              className={`mr-1 rounded px-1.5 py-0.5 text-13 leading-none text-text-tertiary hover:bg-surface-hover hover:text-text-primary ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              title="更多操作"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              ⋯
            </button>

            {menuOpen && (
              <div
                data-testid="session-menu"
                className="absolute right-0 top-full z-40 mt-1 w-36 rounded-md border border-[var(--border-strong)] bg-surface-elevated p-1 shadow-lg"
              >
                {confirmDelete ? (
                  <div className="px-2 py-1.5">
                    <p className="m-0 mb-2 text-11 leading-relaxed text-text-secondary">
                      删除后这个会话的对话无法恢复。
                    </p>
                    <div className="flex justify-end gap-1">
                      <button
                        className="rounded px-2 py-0.5 text-11 text-text-secondary hover:bg-surface-hover"
                        onClick={() => setConfirmDelete(false)}
                      >
                        取消
                      </button>
                      <button
                        data-testid="session-delete-confirm"
                        className="rounded bg-[var(--danger)] px-2 py-0.5 text-11 text-white"
                        onClick={() => {
                          closeMenu();
                          onDelete();
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ) : (
                  [
                    {
                      key: 'pin',
                      label: session.pinned ? '取消置顶' : '置顶',
                      run: () => onPin(!session.pinned),
                    },
                    { key: 'rename', label: '重命名', run: () => setEditing(true) },
                    { key: 'archive', label: '归档', run: onArchive },
                  ].map((item) => (
                    <button
                      key={item.key}
                      data-testid={`session-menu-${item.key}`}
                      className="block w-full rounded px-2 py-1.5 text-left text-12 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                      onClick={() => {
                        closeMenu();
                        item.run();
                      }}
                    >
                      {item.label}
                    </button>
                  ))
                )}
                {!confirmDelete && (
                  <button
                    data-testid="session-menu-delete"
                    className="block w-full rounded px-2 py-1.5 text-left text-12 text-[var(--danger)] hover:bg-surface-hover"
                    onClick={() => setConfirmDelete(true)}
                  >
                    删除…
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
