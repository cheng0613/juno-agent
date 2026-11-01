import { useEffect, useState } from 'react';

import type { TurnStatus } from './shared/ipc';

/**
 * 输入框上方的状态行。
 *
 * 存在的理由：现在只有一个转圈，用户不知道「在跑什么、跑了多久」。
 * 长时间任务里这种不确定感比慢更难受。
 *
 * 时长在客户端自己走：靠宿主每秒推一次 IPC 太浪费，
 * 而且网络/进程抖动会让秒数跳。
 *
 * 样式用 Tailwind utility（与上游 Cindy 一致的写法）；
 * 旋转动画比较特殊，留在 app.css 里。
 */
export function StatusLine({ status }: { status: TurnStatus | null }) {
  const [, forceTick] = useState(0);
  /** 本地记录收到这个 status 的时刻，用来把 idleMs 往后推 */
  const [seenAt, setSeenAt] = useState(0);

  useEffect(() => {
    if (!status) return;
    setSeenAt(Date.now());
    // 每秒重绘一次只为更新时长；token 数变了宿主会推新 status
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  if (!status) return null;

  // 宿主只在有事件时推；两次推送之间的空闲要本地累加，
  // 否则「多久没动静」会一直显示推送那一刻的值。
  const idleMs = status.idleMs + (seenAt ? Date.now() - seenAt : 0);
  const stalled = idleMs >= status.stallAfterMs;

  return (
    <div
      data-testid="status-line"
      className={`status-line${stalled ? ' is-stalled' : ''}`}
    >
      {/* 星形图标 + 橙色：表达「AI 在干活」，不是一个中性的加载中。
          不用转圈：转圈会让人盯着看，而这件事可能要跑几分钟。 */}
      <span className="status-spark" aria-hidden>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.6l1.2 3.4 3.4 1.2-3.4 1.2L8 10.8 6.8 7.4 3.4 6.2l3.4-1.2z" />
          <path d="M12.6 10.2l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" opacity=".7" />
        </svg>
      </span>
      <span data-testid="status-label" className="status-label">
        {stalled ? `已经 ${formatIdle(idleMs)}没有任何响应` : `${status.label}…`}
      </span>
      <span className="status-spacer" />
      {/* 不显示已跑多久 —— 秒数只会让人焦虑（「怎么还没好」），
          尤其跑到 30s、60s 的时候。卡住时才提示时长。 */}
      {status.tokens != null && status.tokens > 0 && (
        <span data-testid="status-meta" className="status-meta">
          {formatTokens(status.tokens)} tokens
        </span>
      )}
    </div>
  );
}

/** 卡住时的时长说法：不足一分钟就报秒，别硬凑成「1 分钟」 */
function formatIdle(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分钟`;
}

/** 1.2s / 1m 23s / 1h 05m —— 超过一分钟就不显示秒了，秒数在长任务里没意义 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
