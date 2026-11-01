/**
 * ORCA worker 面板（右侧栏）。
 *
 * 设计目标来自用户的一句话：「要看到 worker 干活」。
 * 所以这里不是「任务列表」，而是**能直接看进去的工作台**：
 *   - 顶部胶囊列：一眼看出谁在干什么（状态色 + 运行中的转圈）
 *   - 中间对话：点开某个 worker 就看到它完整在干什么，和自己聊天一样
 *   - 底部输入：可以随时插话纠正
 *
 * 刻意不做的事：
 *   - 不显示 token / 耗时等数字（噪音，用户想知道的是「干完了没」）
 *   - done 状态不汇总到侧栏（Cindy 也是这么做的：完成是常态，不值得打扰）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chat } from './Chat';
import type { UiMessage, UiWorker } from './shared/ipc';

const STATUS_TEXT: Record<UiWorker['status'], string> = {
  idle: '待命',
  running: '干活中',
  done: '完成',
  error: '出错',
};

/**
 * 把长路径压成能看的样子。
 *
 * 工作目录动辄 `C:\Users\x\Desktop\proj\.juno\worktrees\developer`，
 * 完整显示会撑爆面板。**保留尾部**而不是开头 ——
 * 识别一个目录靠的是最后几段（worktrees/developer），不是盘符。
 */
export function tidyPath(p: string, keep = 3): string {
  if (!p) return '';
  // 同时处理 / 和 \（Windows 路径里的 \ 不能直接 split，先统一）
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= keep) return p;
  return `…/${parts.slice(-keep).join('/')}`;
}

export interface WorkerPanelProps {
  workers: UiWorker[];
  /** 当前选中的 worker id；null 表示没选 */
  activeWorkerId: string | null;
  /** 当前 worker 的对话；按 worker id 取，切回来不用重新加载 */
  messagesByWorker: Record<string, UiMessage[]>;
  liveByWorker: Record<string, string>;
  /** 哪些 worker 的轮正在跑（可能是我们没盯着的时候开始的） */
  busyWorkerIds: Set<string>;
  onSelect: (workerId: string) => void;
  onClose: () => void;
  onCreate: () => void;
  onRemove: (workerId: string) => void;
  onToggleIsolation: (workerId: string, isolated: boolean) => void;
  onSend: (workerId: string, text: string) => void;
  onCancel: (workerId: string) => void;
  /** 建 worker 正在进行中（防止连点建出好几个） */
  creating?: boolean;
  error?: string | null;
}

/**
 * 状态点。
 *
 * running 用 25% 透明度的实心圆而不是旋转动画 —— 8 个 worker 同时转圈很吵，
 * 而且这个界面上真正需要「实时感」的只有正在跑的那一个（面板里能看到流式）。
 */
function StatusDot({ status }: { status: UiWorker['status'] }) {
  return <span className={`orca-dot orca-dot-${status}`} aria-hidden />;
}

function WorkerPill({
  worker,
  active,
  onClick,
}: {
  worker: UiWorker;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`orca-pill${active ? ' active' : ''}${worker.status === 'error' ? ' has-error' : ''}`}
      onClick={onClick}
      data-testid="orca-pill"
      data-worker-id={worker.id}
      data-worker-status={worker.status}
      title={worker.workingDir ?? undefined}
    >
      <StatusDot status={worker.status} />
      <span className="orca-pill-label">{worker.label}</span>
      {/* 没隔离时要让用户看见风险，但不要一直闪 —— 一个角标足够 */}
      {!worker.isolated && (
        <span className="orca-pill-warn" title="和 Lead 共享目录，可能与其他 worker 互相覆盖">
          !
        </span>
      )}
    </button>
  );
}

export function WorkerPanel(props: WorkerPanelProps) {
  const {
    workers,
    activeWorkerId,
    messagesByWorker,
    liveByWorker,
    busyWorkerIds,
    onSelect,
    onClose,
    onCreate,
    onRemove,
    onToggleIsolation,
    onSend,
    onCancel,
    creating = false,
    error = null,
  } = props;

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = useMemo(
    () => workers.find((w) => w.id === activeWorkerId) ?? null,
    [workers, activeWorkerId],
  );

  const messages = active ? (messagesByWorker[active.id] ?? []) : [];
  const liveText = active ? (liveByWorker[active.id] ?? '') : '';
  const running = active ? busyWorkerIds.has(active.id) || active.status === 'running' : false;

  // 切 worker 时若有草稿，清掉 —— 免得把对 A 说的话发给了 B
  useEffect(() => {
    setDraft('');
  }, [activeWorkerId]);

  // 新内容进来时滚到底。只在贴底时才自动滚，否则用户往上翻会被拽回来
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, liveText]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !active) return;
    setDraft('');
    onSend(active.id, text);
  }, [draft, active, onSend]);

  return (
    <aside className="orca-panel" data-testid="orca-panel">
      <div className="orca-head">
        <span className="orca-title">
          协同
          {workers.length > 0 && <span className="orca-count">{workers.length}</span>}
        </span>
        <div className="orca-head-actions">
          <button
            type="button"
            className="orca-btn"
            onClick={onCreate}
            disabled={creating}
            data-testid="orca-create"
          >
            {creating ? '创建中…' : '+ Worker'}
          </button>
          <button type="button" className="orca-btn ghost" onClick={onClose} title="收起面板">
            ✕
          </button>
        </div>
      </div>

      {/* 胶囊列一直显示，即使没选中某个 worker —— 它是「谁在干活」的总览 */}
      <div className="orca-pills" data-testid="orca-pills">
        {workers.length === 0 ? (
          <span className="orca-empty-hint">还没有 worker。点「+ Worker」派一个。</span>
        ) : (
          workers.map((w) => (
            <WorkerPill
              key={w.id}
              worker={w}
              active={w.id === activeWorkerId}
              onClick={() => onSelect(w.id)}
            />
          ))
        )}
      </div>

      {error && (
        <div className="orca-error" data-testid="orca-error">
          {error}
        </div>
      )}

      {active ? (
        <>
          <div className="orca-meta">
            <span className="orca-meta-role">{active.role}</span>
            <span className="orca-meta-status">
              <StatusDot status={active.status} />
              {STATUS_TEXT[active.status]}
            </span>
            <button
              type="button"
              className="orca-meta-toggle"
              onClick={() => onToggleIsolation(active.id, !active.isolated)}
              title={
                active.isolated
                  ? '当前是独立工作区，点一下改成和 Lead 共享目录'
                  : '当前和 Lead 共享目录，点一下改成独立工作区'
              }
              data-testid="orca-isolation-toggle"
              data-isolated={active.isolated ? '1' : '0'}
            >
              {active.isolated ? '独立工作区' : '共享目录'}
            </button>
            <button
              type="button"
              className="orca-meta-remove"
              onClick={() => onRemove(active.id)}
              title="移出协同（会话保留）"
              data-testid="orca-remove"
            >
              移出
            </button>
          </div>

          {/* 工作目录：多个 worker 时最需要知道「它到底在哪干活」。
              路径太长，只显示尾部几段，完整路径放 title 里。 */}
          {active.workingDir && (
            <div className="orca-workdir" data-testid="orca-workdir" title={active.workingDir}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                <path d="M1.8 4.2h4.4l1.2 1.6h6.8v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
              </svg>
              <span className="orca-workdir-path">{tidyPath(active.workingDir)}</span>
            </div>
          )}

          {!active.isolated && (
            <div className="orca-warn" data-testid="orca-shared-warn">
              和 Lead 共享目录。如果同时有别的 worker 也在改，可能互相覆盖。
            </div>
          )}

          <div className="orca-chat" ref={scrollRef} onScroll={onScroll}>
            {messages.length === 0 && !liveText ? (
              <div className="orca-chat-empty">
                还没派活。在下面输入，或者让 Lead 用工具派给它。
              </div>
            ) : (
              <Chat messages={messages} liveText={liveText} running={running} />
            )}
          </div>

          <div className="orca-composer">
            <textarea
              ref={inputRef}
              className="orca-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={running ? '插话纠正…' : `给 ${active.label} 派活…（Enter 发送）`}
              rows={2}
              data-testid="orca-input"
            />
            {running ? (
              <button
                type="button"
                className="orca-send stop"
                onClick={() => onCancel(active.id)}
                data-testid="orca-stop"
              >
                停
              </button>
            ) : (
              <button
                type="button"
                className="orca-send"
                onClick={send}
                disabled={!draft.trim()}
                data-testid="orca-send"
              >
                发
              </button>
            )}
          </div>
        </>
      ) : (
        workers.length > 0 && (
          <div className="orca-placeholder">选一个 worker 看它在干什么</div>
        )
      )}
    </aside>
  );
}
