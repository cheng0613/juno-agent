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
 */
export function StatusLine({ status }: { status: TurnStatus | null }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!status) return;
    // 每秒重绘一次只为更新时长；token 数变了宿主会推新 status
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  if (!status) return null;

  return (
    <div className="status-line">
      <span className="status-spinner" />
      <span className="status-label">{status.label}…</span>
      <span className="status-spacer" />
      <span className="status-meta">
        {formatDuration(Date.now() - status.startedAt)}
        {status.tokens != null && status.tokens > 0 ? ` · ${formatTokens(status.tokens)} tokens` : ''}
      </span>
    </div>
  );
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
