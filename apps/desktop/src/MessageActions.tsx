/**
 * 消息悬停操作条。
 *
 * 对齐 Cindy 的规格：
 *   - 按钮 24×24（h-6 w-6），图标 14px
 *   - 只在悬停该条消息时出现，200ms 防抖 + 150ms 淡出
 *   - 用户消息操作条右对齐、时间在左；模型消息反过来
 *
 * 目前只做「复制」和「时间」两项 —— 分支/编辑要引擎能力支持，
 * 先不摆一个点了会报错的按钮。
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  text: string;
  /** 消息时间（毫秒）。没有就不显示 */
  at?: number;
  /** 用户消息的操作条在气泡下方、右对齐 */
  align: 'left' | 'right';
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function MessageActions({ text, at, align }: Props): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className={`msg-actions msg-actions-${align}`} data-testid="msg-actions">
      {at !== undefined && <span className="msg-time">{fmtTime(at)}</span>}
      <button
        type="button"
        className="msg-act-btn"
        title="复制"
        data-testid="msg-copy"
        onClick={copy}
      >
        {copied ? '✓' : '⧉'}
      </button>
    </div>
  );
}
