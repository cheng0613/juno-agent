/**
 * 搜索面板（Ctrl+K）。
 *
 * 搜标题和正文，点结果跳过去。输入防抖 200ms —— 每敲一个字就查库
 * 在会话多的时候会有明显卡顿。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostBridge, SearchHit } from './shared/ipc';

interface Props {
  /** 由 App 传入 —— 它负责在 dev 模式下换成 mock */
  host: HostBridge;
  onOpen: (sessionId: string) => void;
  onClose: () => void;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

export function SearchPanel({ host, onOpen, onClose }: Props): React.ReactElement {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开就聚焦 —— 按了 Ctrl+K 还要再点一下输入框很蠢
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 防抖查询
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void host
        .searchSessions(q)
        .then((r) => {
          setHits(r);
          setCursor(0);
        })
        .catch(() => setHits([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, host]);

  // 上下键选、回车打开
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = hits[cursor];
      if (target) {
        onOpen(target.id);
        onClose();
      }
    }
    // Esc 不在这里处理：统一走 App 的快捷键层，避免两处各关一次
  };

  const placeholder = useMemo(
    () => (loading ? '搜索中…' : '搜索会话标题和对话内容'),
    [loading],
  );

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div
        className="search-panel"
        data-testid="search-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="search-input-row">
          <input
            ref={inputRef}
            className="search-input"
            data-testid="search-input"
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="search-kbd">Esc</kbd>
        </div>

        {query.trim() && !loading && hits.length === 0 && (
          <p className="search-empty" data-testid="search-empty">
            没有找到匹配的会话
          </p>
        )}

        {hits.length > 0 && (
          <ul className="search-list" data-testid="search-list">
            {hits.map((h, i) => (
              <li key={h.id}>
                <button
                  type="button"
                  className={`search-hit${i === cursor ? ' is-cursor' : ''}`}
                  data-testid="search-hit"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => {
                    onOpen(h.id);
                    onClose();
                  }}
                >
                  <div className="search-hit-head">
                    <span className="search-hit-title">{h.title}</span>
                    <span className="search-hit-time">{timeAgo(h.updatedAt)}</span>
                  </div>
                  {/* 正文命中才显示原文 —— 否则用户不知道这条为什么被搜到 */}
                  {h.hit === 'content' && h.snippet && (
                    <p className="search-hit-snippet">{h.snippet}</p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="search-foot">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
