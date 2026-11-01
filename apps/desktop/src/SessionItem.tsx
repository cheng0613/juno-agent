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
  workersRunning = 0,
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
  /** 这个会话底下有几个 worker 在跑；切走了也能看到那边在干活 */
  workersRunning?: number;
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

  /**
   * 卡片第二行。
   *
   * 摘要和标题重复时不显示（标题通常就是从用户第一句切的）——
   * 那样两行一模一样的字，卡片变成噪声。
   * 空会话时给一句谈的占位，不重复左上角的模型标。
   */
  const isEmpty = !session.preview?.trim();
  const previewText = (() => {
    const p = session.preview?.trim();
    // 左上角已经有模型标了，这里再写一遍模型名是重复的
    if (!p) return '还没有对话';
    const normalize = (v: string) => v.replace(/[\s…⋯.。！？!?]+$/g, '').trim();
    const a = normalize(p);
    const b = normalize(session.title);
    if (a === b) return '还没有后续内容';
    // 标题是摘要的前缀时也算重复（标题就是截短版）
    if (a.startsWith(b) || b.startsWith(a)) return '还没有后续内容';
    return p;
  })();

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
            className={`session-card${active ? ' is-active' : ''}`}
            title={session.preview ? `${session.title}
${session.preview}` : session.title}
            onClick={onSelect}
            onDoubleClick={() => setEditing(true)}
            data-testid="session-card"
          >
            {/* 第一行：模型标 + 标题 + 时间 */}
            <span className="session-card-head">
              {session.pinned && <span className="session-pin" title="已置顶">📌</span>}
              <span className="session-model-mark" title={session.model}>
                {(session.model.split('/').pop() ?? '?').charAt(0).toUpperCase()}
              </span>
              <span className="session-card-title">{session.title}</span>
              {busy && (
                <span
                  data-testid="session-busy"
                  className="session-busy shrink-0"
                  title="这个会话正在跑"
                />
              )}
              {workersRunning > 0 && (
                <span
                  className="session-worker-badge"
                  data-testid="session-workers-running"
                  title={`${workersRunning} 个 worker 在跑`}
                >
                  {workersRunning}
                </span>
              )}
              <span className="session-card-time">{relativeTime(session.updatedAt)}</span>
            </span>

            {/* 第二行：摘要。没摘要时用模型名占位，卡片高度才一致 */}
            <span className={`session-card-preview${isEmpty ? ' is-empty' : ''}`}>
              {previewText}
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

/**
 * 相对时间：侧栏卡片右上的「12 小时」「2 天」。
 *
 * 为什么不显示绝对时间：侧栏宽度有限，`2026-11-01 15:30` 太长，
 * 而且用户真正关心的是「多久前」—— 判断哪个是刚聊完的。
 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月`;
  return `${Math.floor(month / 12)} 年`;
}
