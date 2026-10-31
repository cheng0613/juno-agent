import { useEffect, useState } from 'react';

import type { ArchivedSession, HostBridge } from './shared/ipc';

/**
 * 已归档会话面板。
 *
 * 为什么必须做这个入口：归档功能没有恢复入口，等于删了一半 ——
 * 用户把会话归档后，界面上再也找不到它，只能认为丢了。
 *
 * 形态与设置/目录面板一致：右侧抽屉，不打断当前会话。
 */
export function ArchivedPanel({
  host,
  onClose,
  onRestored,
}: {
  host: HostBridge;
  onClose: () => void;
  /** 恢复成功后通知外层刷新侧栏列表 */
  onRestored: () => void;
}) {
  const [items, setItems] = useState<ArchivedSession[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void host
      .listArchived()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(load, [host]);

  const restore = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await host.unarchiveSession(id);
      // 本地先摘掉，再重新拉一次确认真实状态（可能有并发改动）
      setItems((prev) => (prev ? prev.filter((s) => s.id !== id) : prev));
      onRestored();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside
      data-testid="archived-panel"
      className="absolute right-0 z-30 flex w-[min(420px,55%)] flex-col border-l border-default bg-surface-elevated shadow-lg"
      style={{ top: 'var(--topbar-h, 37px)', bottom: 'var(--composer-h, 92px)' }}
    >
      <div className="flex items-center border-b border-default px-4 py-3">
        <span className="flex-1 text-13 text-text-primary">已归档</span>
        <button
          className="rounded px-2 py-0.5 text-16 leading-none text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          title="收起"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <p className="m-0 border-b border-default px-4 py-2 text-11 leading-relaxed text-text-tertiary">
        归档的会话不在侧栏显示，但对话都还在。恢复后会重新出现在列表里。
      </p>

      {error && (
        <p className="m-0 px-4 py-2 text-11 text-[var(--danger)]">{error}</p>
      )}

      <div className="flex-1 overflow-auto py-2">
        {items === null && (
          <p className="m-0 px-4 py-3 text-12 text-text-placeholder">加载中…</p>
        )}
        {items !== null && items.length === 0 && (
          <p data-testid="archived-empty" className="m-0 px-4 py-3 text-12 text-text-placeholder">
            没有已归档的会话
          </p>
        )}
        {items?.map((s) => (
          <div
            key={s.id}
            data-testid="archived-item"
            className="flex items-center gap-2 px-4 py-2 hover:bg-surface-hover"
          >
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-12 text-text-primary" title={s.title}>
                {s.title}
              </p>
              <p className="m-0 text-11 text-text-tertiary">
                归档于 {formatDate(s.archivedAt)}
              </p>
            </div>
            <button
              data-testid="archived-restore"
              className="shrink-0 rounded border border-[var(--border-strong)] px-2 py-0.5 text-11 text-text-secondary hover:border-[var(--brand)] hover:text-[var(--brand)] disabled:opacity-50"
              disabled={busyId === s.id}
              onClick={() => void restore(s.id)}
            >
              {busyId === s.id ? '恢复中…' : '恢复'}
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** 只到分钟，够用；归档时间不是需要精确到秒的信息 */
function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
