import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chat } from './Chat';
import { createMockHost } from './devMock';
import type {
  ApprovalRequest,
  ContextUsage,
  HostBridge,
  InterruptedTurn,
  SessionSummary,
  UiMessage,
} from './shared/ipc';

declare global {
  interface Window {
    host?: HostBridge;
  }
}

const THEME_KEY = 'app-theme';

/**
 * 上下文占用条。
 *
 * 只有超过 60% 才变色：平时它只是个背景信息，不该抢注意力；
 * 快满的时候才该让人一眼看到。
 */
function UsageMeter({
  usage,
  onCompact,
  compacting,
  disabled,
}: {
  usage: ContextUsage;
  onCompact: () => void;
  compacting: boolean;
  disabled: boolean;
}) {
  const pct = Math.round(usage.percentage);
  const level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low';
  const label = `${pct}% · ${fmtTokens(usage.totalTokens)} / ${fmtTokens(usage.maxTokens)} tokens`;

  return (
    <button
      className={`usage usage-${level}`}
      onClick={onCompact}
      disabled={disabled || compacting}
      title={`${label}\n点击压缩上下文`}
    >
      <span className="usage-bar">
        <span className="usage-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="usage-pct">{pct}%</span>
    </button>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function App() {
  // 有 Electron preload 就用真的，否则用 mock（浏览器里改样式用）
  const host = useMemo<HostBridge>(() => window.host ?? createMockHost(), []);
  const isMock = !window.host;

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [liveText, setLiveText] = useState('');
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // 审批时是否记住这次选择；每次新审批重新开始
  const [remember, setRemember] = useState<'none' | 'session' | 'global'>('none');
  const [notice, setNotice] = useState<string | null>(null);

  // 提示条自动消失：它是个不阻塞的告知，不该让用户手动去点掉
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const [interrupted, setInterrupted] = useState<InterruptedTurn[]>([]);
  const [model, setModel] = useState('');
  const [dark, setDark] = useState(false);
  const [input, setInput] = useState('');
  // 正在跑的时候用户又输入的句子，排在这里，等本轮结束自动发出
  const [queued, setQueued] = useState<string[]>([]);
  const [compacting, setCompacting] = useState(false);
  /** 上下文占用；null = 引擎没给，此时不画进度条 */
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  // 递增即表示「强制滚到底」：只有切会话/续跑这类主动跳转才用，
  // 流式输出仍然走「贴底才跟随」的保守策略
  const [scrollTick, setScrollTick] = useState(0);

  const liveRef = useRef('');
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const scrollerRef = useRef<HTMLDivElement>(null);

  /* ---------------- 主题 ---------------- */
  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initial = saved ? saved === 'dark' : prefersDark;
    setDark(initial);
    document.documentElement.classList.toggle('dark', initial);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
  };

  /* ---------------- 首次拉状态 ---------------- */
  useEffect(() => {
    void (async () => {
      const boot = await host.bootstrap();
      setSessions(boot.sessions);
      setActiveId(boot.activeSessionId);
      setMessages(boot.messages);
      setModel(boot.model);
      setInterrupted(boot.interruptedTurns);
      if (boot.activeSessionId) {
        void host.contextUsage(boot.activeSessionId).then(setUsage);
      }
    })();
  }, [host]);

  /* ---------------- 事件流 ---------------- */
  useEffect(() => {
    const off = host.onEvent((event) => {
      switch (event.type) {
        case 'text': {
          if (event.isFinal) {
            // 终态文本整条替换，避免增量拼接重复
            liveRef.current = event.text;
            setLiveText(event.text);
          } else {
            liveRef.current += event.text;
            setLiveText(liveRef.current);
          }
          return;
        }

        case 'thinking': {
          if (!event.isFinal) return;
          setMessages((prev) => [
            ...prev,
            { id: `think-${event.turnId}-${prev.length}`, role: 'thinking', text: event.text },
          ]);
          return;
        }

        case 'tool_use': {
          setMessages((prev) => [
            ...prev,
            {
              id: `use-${event.toolUseId}`,
              role: 'tool_use',
              toolName: event.toolName,
              toolUseId: event.toolUseId,
              input: event.input,
            },
          ]);
          return;
        }

        case 'tool_result': {
          setMessages((prev) => [
            ...prev,
            {
              id: `res-${event.toolUseId}`,
              role: 'tool_result',
              toolUseId: event.toolUseId,
              output: event.output,
              isError: event.isError,
            },
          ]);
          return;
        }

        case 'turn': {
          if (event.state === 'running') {
            setRunning(true);
            liveRef.current = '';
            setLiveText('');
            return;
          }
          // 收口：重新从数据库拉一次，拿到权威的 message id 与顺序
          setRunning(false);
          liveRef.current = '';
          setLiveText('');
          const sid = activeRef.current;
          if (sid) {
            void host.loadSession(sid).then((rows) => setMessages(rows));
            // 一轮跑完上下文就变了，占用条跟着刷新
            void host.contextUsage(sid).then(setUsage);
          }
          return;
        }

        case 'approval': {
          setRemember('none');
          setApproval(event.request);
          return;
        }

        case 'approval_settled': {
          setApproval((cur) => (cur?.requestId === event.requestId ? null : cur));
          return;
        }

        case 'session_title': {
          // 只改本地列表，不重拉 —— 标题不改变会话内容
          setSessions((prev) =>
            prev.map((s) => (s.id === event.sessionId ? { ...s, title: event.title } : s)),
          );
          return;
        }

        case 'steer': {
          // 插话已经在发送时乐观插入了，这里只防止重复（重载后会换成库里的那条）
          return;
        }

        case 'compact': {
          // 先本地插一条分隔线给即时反馈；turn 收口时会从库里重拉，
          // 那时会换成持久化的那一行（id 不同，不会重复）
          setMessages((prev) => [
            ...prev,
            {
              id: `compact-live-${Date.now()}`,
              role: 'compact_boundary' as const,
              compact: {
                trigger: event.trigger,
                preTokens: event.preTokens,
                postTokens: event.postTokens,
              },
            },
          ]);
          return;
        }

        case 'error': {
          setMessages((prev) => [
            ...prev,
            { id: `err-${prev.length}-${Date.now()}`, role: 'error', text: event.message },
          ]);
          return;
        }
      }
    });

    return off;
  }, [host]);

  /* ---------------- 自动滚动 ---------------- */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  /* 主动跳转：切会话、续跑后必须直接到底，否则用户以为没反应 */
  useEffect(() => {
    if (scrollTick === 0) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollTick]);

  /* ---------------- 发送 ---------------- */
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId) return;

    setInput('');

    // 跑着的时候按 Enter 默认「插话」：把它当成一句纠正，塞进当前这轮。
    // 这比排队更符合直觉 —— 用户跑着时打字，十有八九是「不对，改成……」，
    // 而不是「排队，等它跑完再说」。真要排队使底部的排队按钮。
    if (running) {
      setMessages((prev) => [
        ...prev,
        { id: `steer-${Date.now()}`, role: 'user_steer' as const, text },
      ]);
      try {
        await host.steer(activeId, text);
      } catch (error) {
        // 最常见的情况：这一轮刚好跑完了，引擎那边已经没有可以插话的轮
        setNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // 乐观插入，等 turn 收口后由数据库结果覆盖
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', text },
    ]);
    // 同样乐观置 running，防手快连敲两次 Enter 重复发送
    setRunning(true);
    await host.send({ sessionId: activeId, text }).catch(() => setRunning(false));
  }, [input, activeId, running, host]);

  /* 跑着时把这句话排到队尾，等本轮结束再发 */
  const queueInstead = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setQueued((prev) => [...prev, text]);
  }, [input]);

  /* 手动压缩上下文 */
  const compactNow = useCallback(async () => {
    if (!activeId || running || compacting) return;
    setCompacting(true);
    try {
      const result = await host.compact(activeId);
      // noop 是良性结果（上下文本来就小），不能报成失败
      if (result.noop) setNotice('上下文还很小，暂时不需要压缩');
    } catch (error) {
      setNotice(`压缩失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCompacting(false);
      // 压缩就是为了降占用，压完必须重算，否则进度条还停在压缩前
      if (activeId) void host.contextUsage(activeId).then(setUsage);
    }
  }, [activeId, running, compacting, host]);

  /* 队列保底：本轮结束后自动发出下一条 */
  useEffect(() => {
    if (running || queued.length === 0 || !activeId) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', text: next },
    ]);
    // 必须先乐观置 running。
    // 主进程的 turn:running 要绕一圈 IPC 才回来，这中间 running 仍是 false，
    // effect 会因为 setQueued 重新跑一次，把剩下的条目一口气全发出去。
    setRunning(true);
    void host.send({ sessionId: activeId, text: next }).catch(() => setRunning(false));
  }, [running, queued, activeId, host]);

  const switchSession = async (id: string) => {
    if (id === activeId) return;
    const rows = await host.loadSession(id);
    setActiveId(id);
    setMessages(rows);
    setLiveText('');
    liveRef.current = '';
    setScrollTick((n) => n + 1);
    setUsage(null);
    void host.contextUsage(id).then(setUsage);
  };

  const newSession = async () => {
    const boot = await host.createSession();
    setSessions(boot.sessions);
    setActiveId(boot.activeSessionId);
    setMessages(boot.messages);
    // 新会话还没有上下文，不画进度条
    setUsage(null);
  };

  const answer = async (behavior: 'allow' | 'deny') => {
    if (!approval) return;
    const requestId = approval.requestId;
    setApproval(null);
    await host.approve({ requestId, behavior, remember });
  };

  /**
   * 继续一个被中断的轮。
   *
   * 先切到那一轮所属的会话再续跑 —— 否则用户在 A 会话点「继续」，
   * 实际跑到 B 会话去了，只看到侧栏闪一下，以为没反应。
   */
  const resumeTurn = async (turn: InterruptedTurn) => {
    setInterrupted((prev) => prev.filter((t) => t.turnId !== turn.turnId));
    if (turn.sessionId !== activeId) await switchSession(turn.sessionId);
    await host.resumeTurn(turn.turnId);
    setScrollTick((n) => n + 1);
  };

  const dismissTurn = async (turnId: string) => {
    setInterrupted((prev) => prev.filter((t) => t.turnId !== turnId));
    await host.dismissTurn(turnId);
  };

  return (
    <div className="shell">
      {/* ---------------- 侧边栏 ---------------- */}
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">Agent</span>
          {isMock && <span className="badge">预览模式</span>}
        </div>

        <button className="btn-new" onClick={newSession}>
          + 新会话
        </button>

        <nav className="session-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`session-item${s.id === activeId ? ' active' : ''}`}
              onClick={() => void switchSession(s.id)}
            >
              <span className="session-title">{s.title}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="ghost" onClick={toggleTheme}>
            {dark ? '浅色' : '深色'}
          </button>
          <span className="model">{model}</span>
        </div>
      </aside>

      {/* ---------------- 主区 ---------------- */}
      <main className="main">
        {interrupted.length > 0 && (
          <div className="resume-banner">
            <div className="resume-head">
              <span className="badge warn">未完成</span>
              <span>
                上个进程退出时有 {interrupted.length} 轮没跑完，进度已保存
              </span>
            </div>

            {interrupted.map((t) => (
              <div className="resume-row" key={t.turnId}>
                <div className="resume-info">
                  <span className="resume-title">{t.sessionTitle}</span>
                  <span className="resume-text">
                    {t.userText ?? '（原文已丢失）'}
                  </span>
                </div>
                <button className="btn ghost" onClick={() => void dismissTurn(t.turnId)}>
                  忽略
                </button>
                <button className="btn primary" onClick={() => void resumeTurn(t)}>
                  继续
                </button>
              </div>
            ))}
          </div>
        )}

        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button className="ghost" onClick={() => setNotice(null)}>
              知道了
            </button>
          </div>
        )}

        <div className="topbar">
          <span className="topbar-title">
            {sessions.find((s) => s.id === activeId)?.title ?? '会话'}
          </span>
          {usage && <UsageMeter usage={usage} onCompact={() => void compactNow()} compacting={compacting} disabled={running} />}
          <button
            className="ghost topbar-action"
            disabled={!activeId || running || compacting || messages.length === 0}
            title="把较早的对话换成一页摘要，腾出上下文空间"
            onClick={() => void compactNow()}
          >
            {compacting ? '压缩中…' : '压缩上下文'}
          </button>
        </div>

        <div className="scroller" ref={scrollerRef}>
          <Chat messages={messages} liveText={liveText} running={running} />
        </div>

        <div className="composer-wrap">
          {queued.length > 0 && (
            <div className="queue-strip">
              <span className="queue-label">排队中 {queued.length}</span>
              {queued.map((text, i) => (
                <span className="queue-item" key={`${i}-${text}`}>
                  <span className="queue-text">{text}</span>
                  <button
                    className="queue-x"
                    title="取消这条"
                    onClick={() => setQueued((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="composer">
            <textarea
              rows={1}
              value={input}
              placeholder={
                running
                  ? '这一轮还在跑：Enter 插话纠正，Shift+Enter 换行'
                  : '问点什么…（Enter 发送，Shift+Enter 换行）'
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {running ? (
              <>
                <button
                  className="ghost queue-btn"
                  disabled={!input.trim()}
                  title="不想打断，等这一轮跑完再发"
                  onClick={queueInstead}
                >
                  排队
                </button>
                <button className="send stop" onClick={() => void host.cancel(activeId ?? '')}>
                  <span className="square" />
                </button>
              </>
            ) : (
              <button className="send" disabled={!input.trim()} onClick={() => void send()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </main>

      {/* ---------------- 审批弹层 ---------------- */}
      {approval && (
        <div className="overlay">
          <div className="approval" role="dialog" aria-modal="true">
            <div className="approval-head">
              <span className="badge warn">需要授权</span>
              <span className="approval-tool">{approval.toolName}</span>
            </div>

            <p className="approval-text">
              这个工具会修改你的文件或在系统上执行操作，确认后才继续。
            </p>

            {approval.input && (
              <pre className="approval-code">
                {String(
                  (approval.input as Record<string, unknown>).command ??
                    JSON.stringify(approval.input, null, 2),
                )}
              </pre>
            )}

            {approval.rememberKey && (
              <div className="remember-row">
                <span className="remember-label">记住</span>
                {(
                  [
                    ['none', '仅本次'],
                    ['session', '本会话'],
                    ['global', '始终'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`seg${remember === value ? ' on' : ''}`}
                    onClick={() => setRemember(value)}
                  >
                    {label}
                  </button>
                ))}
                {remember !== 'none' && (
                  <code className="remember-key">{approval.rememberKey}</code>
                )}
              </div>
            )}

            <div className="approval-actions">
              <button className="btn ghost" onClick={() => void answer('deny')}>
                拒绝
              </button>
              <button className="btn primary" onClick={() => void answer('allow')}>
                允许
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
