import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chat } from './Chat';
import { DiffPanel } from './DiffPanel';
import { ExtraDirsPanel } from './ExtraDirsPanel';
import { ModeControls } from './ModeControls';
import { ArchivedPanel } from './ArchivedPanel';
import { SessionItem } from './SessionItem';
import { SettingsPanel } from './SettingsPanel';
import { StatusLine } from './StatusLine';
import { TaskCard } from './TaskCard';
import { TreePanel } from './TreePanel';import { createMockHost } from './devMock';
import type {
  ApprovalRequest,
  ContextUsage,
  ExtraDirs,
  HostBridge,
  InterruptedTurn,
  ModeState,
  PermissionModeChoice,
  SessionSummary,
  TaskInfo,
  TreeEntry,
  TurnDiffPayload,
  TurnStatus,
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
  /** 哪些会话正在跑（多会话并行时侧栏要显示出来） */
  const [busySessions, setBusySessions] = useState<Set<string>>(new Set());
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // 审批时是否记住这次选择；每次新审批重新开始
  const [remember, setRemember] = useState<'none' | 'session' | 'global'>('none');
  const [notice, setNotice] = useState<string | null>(null);

  // 提示条自动消失：它是个不阻塞的告知，不该让用户手动去点掉
  useEffect(() => {
    if (!notice) return;
    // 给足看/复制路径的时间；5000ms 对「已导出到 C:\...\xxx.html」这种长文本才够用
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [interrupted, setInterrupted] = useState<InterruptedTurn[]>([]);
  const [model, setModel] = useState('');
  /** 可选模型清单；只有一个时不显示选择器 */
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [dark, setDark] = useState(false);
  const [input, setInput] = useState('');
  // 正在跑的时候用户又输入的句子，排在这里，等本轮结束自动发出
  const [queued, setQueued] = useState<string[]>([]);
  const [compacting, setCompacting] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 待发送的图（data URI） */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  /** 子任务；引擎推的是全量快照，直接替换 */
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  /** 额外工作目录 */
  const [extraDirs, setExtraDirs] = useState<ExtraDirs>({ read: [], write: [] });
  const [dirsOpen, setDirsOpen] = useState(false);
  /** 分支树 */
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeBusy, setTreeBusy] = useState(false);
  /** 当前轮的状态行；null = 没在跑 */
  const [turnStatus, setTurnStatus] = useState<TurnStatus | null>(null);
  /** 设置面板：没 key 时全屏拦截，否则是侧边抽屉 */
  /** 已归档面板是否打开 */
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** 归档数量：有才在底栏显示入口 */
  const [archivedCount, setArchivedCount] = useState(0);
  const [settingsMode, setSettingsMode] = useState<'onboarding' | 'drawer' | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  /**
   * 验收专用的崩溃开关。
   * 验证错误边界必须有办法真的抛一次渲染异常，只看组件存在不算验。
   * 只在 preload 挂了 __autotestInject（即 APP_AUTOTEST 开启）时才能触发。
   */
  const [crashForTest, setCrashForTest] = useState(false);
  /** 上下文占用；null = 引擎没给，此时不画进度条 */
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  /** 本轮改动；null = 没有任何改动 */
  const [turnDiff, setTurnDiff] = useState<TurnDiffPayload | null>(null);
  /** 面板是否展开；关掉后面板不丢，顶栏还能再打开 */
  const [diffOpen, setDiffOpen] = useState(false);
  const [modes, setModes] = useState<ModeState>({
    permissionMode: 'ask',
    planMode: false,
    effort: null,
    effortLevels: [],
  });
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

  // 把崩溃开关挂到 window 上（仅验收环境有 __autotestInject）
  useEffect(() => {
    if (typeof window.__autotestInject === 'undefined') return;
    (window as unknown as { __crashForTest?: () => void }).__crashForTest = () =>
      setCrashForTest(true);
  }, []);

  /* ---------------- 首次拉状态 ---------------- */
  useEffect(() => {
    void (async () => {
      // 先看配置：没 key 就直接进向导，不去连引擎（连也一定失败）
      const settings = await host.readSettings().catch(() => null);
      const configured = settings?.hasKey ?? true;
      setHasKey(configured);
      if (!configured) {
        setSettingsMode('onboarding');
        return;
      }

      const boot = await host.bootstrap();
      setSessions(boot.sessions);
      setActiveId(boot.activeSessionId);
      setMessages(boot.messages);
      setModel(boot.model);
      void host.listModels().then((r) => setModels(r.models));
      setInterrupted(boot.interruptedTurns);
      if (boot.activeSessionId) {
        void host.contextUsage(boot.activeSessionId).then(setUsage);
        void host.readModes(boot.activeSessionId).then(setModes);
        void host.readExtraDirs(boot.activeSessionId).then(setExtraDirs);
      }
    })();
  }, [host]);

  /* ---------------- 事件流 ---------------- */
  useEffect(() => {
    const off = host.onEvent((event) => {
      switch (event.type) {
        case 'text': {
          // 多会话并行：后台会话的事件不能进当前会话的界面。
          // 不加这道判断的话，后台会话的流式文字会串到当前对话里。
          if (event.sessionId !== activeRef.current) return;

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
          // 多会话并行：后台会话的事件不能进当前会话的界面。
          // 不加这道判断的话，后台会话的流式文字会串到当前对话里。
          if (event.sessionId !== activeRef.current) return;

          if (!event.isFinal) return;
          setMessages((prev) => [
            ...prev,
            { id: `think-${event.turnId}-${prev.length}`, role: 'thinking', text: event.text },
          ]);
          return;
        }

        case 'tool_use': {
          // 多会话并行：后台会话的事件不能进当前会话的界面。
          // 不加这道判断的话，后台会话的流式文字会串到当前对话里。
          if (event.sessionId !== activeRef.current) return;

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
          // 多会话并行：后台会话的事件不能进当前会话的界面。
          // 不加这道判断的话，后台会话的流式文字会串到当前对话里。
          if (event.sessionId !== activeRef.current) return;

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
          // 多会话并行：先判断这条事件属不属于当前会话。
          // 不判断的话，后台会话跑完会把当前会话的 running 置 false ——
          // 界面显示「跑完了」，其实当前会话还在跑。
          const isCurrent = event.sessionId === activeRef.current;

          // 侧栏的运行标记按 sessionId 记，与当前会话无关
          setBusySessions((prev) => {
            const next = new Set(prev);
            if (event.state === 'running') next.add(event.sessionId);
            else next.delete(event.sessionId);
            return next;
          });

          if (!isCurrent) {
            // 后台会话：只更新侧栏标记。
            // 它跑完时顺手刷一下列表 —— 标题可能刚被自动生成，排序也变了
            if (event.state !== 'running') void host.listSessions().then(setSessions);
            return;
          }

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

        case 'status': {
          // 多会话并行：后台会话的事件不能进当前会话的界面。
          // 不加这道判断的话，后台会话的流式文字会串到当前对话里。
          if (event.sessionId !== activeRef.current) return;

          setTurnStatus(event.status);
          return;
        }

        case 'tasks': {
          setTasks(event.tasks);
          return;
        }

        case 'model': {
          setModel(event.modelId);
          return;
        }

        case 'modes': {
          setModes({
            permissionMode: event.permissionMode,
            planMode: event.planMode,
            effort: event.effort,
            effortLevels: event.effortLevels,
          });
          return;
        }

        case 'turn_diff': {
          // 只在有改动时弹面板；没改动不打扰人
          if (event.changes.length > 0) {
            setTurnDiff({
              tracked: event.tracked,
              changes: event.changes,
              diff: event.diff,
              truncated: event.truncated,
            });
            setDiffOpen(true);
          }
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
    // 只发图不打字也应该能发
    if ((!text && pendingImages.length === 0) || !activeId) return;

    setInput('');
    const images = pendingImages;
    setPendingImages([]);

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
      { id: `local-${Date.now()}`, role: 'user', text, ...(images.length > 0 ? { images } : {}) },
    ]);
    // 同样乐观置 running，防手快连敲两次 Enter 重复发送
    setRunning(true);
    await host.send({ sessionId: activeId, text, images }).catch(() => setRunning(false));
  }, [input, activeId, running, pendingImages, host]);

  /* 跑着时把这句话排到队尾，等本轮结束再发 */
  const queueInstead = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setQueued((prev) => [...prev, text]);
  }, [input]);

  /* 切档位 / 开关计划模式 */
  const changeMode = useCallback(
    async (mode: PermissionModeChoice) => {
      if (!activeId) return;
      try {
        await host.setPermissionMode(activeId, mode);
      } catch (error) {
        setNotice(`切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [activeId, host],
  );

  const togglePlanMode = useCallback(
    async (enabled: boolean) => {
      if (!activeId) return;
      try {
        await host.setPlanMode(activeId, enabled);
      } catch (error) {
        setNotice(`切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [activeId, host],
  );

  const changeEffort = useCallback(
    async (effort: string) => {
      if (!activeId) return;
      try {
        await host.setEffort(activeId, effort);
      } catch (error) {
        setNotice(`切换失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [activeId, host],
  );

  const switchModelTo = useCallback(
    async (modelId: string) => {
      if (!activeId || modelId === model) return;
      try {
        const result = await host.switchModel(activeId, modelId);
        // rebuild 意味着上下文可能被重建过，必须告知而不是假装无事发生
        if (result.rebuilt) setNotice('模型已切换；因为要重建会话，较早的上下文可能已丢失');
      } catch (error) {
        setNotice(`切换模型失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [activeId, model, host],
  );

  /**
   * 回到某一轮重来。
   *
   * 两件事必须同时做：把引擎切回那个节点、把原话放回输入框。
   * 只切不回填的话，用户得自己回忆刚才问的什么，等于白回退。
   */
  const replayFrom = useCallback(
    async (entryId: string, turnIndex?: number) => {
      if (!activeId || treeBusy) return;
      setTreeBusy(true);
      try {
        const result = await host.navigateTree(activeId, entryId, turnIndex);
        // 用引擎给的时间线，不从数据库重拉 ——
        // 库里还存着被丢弃那一支的消息，重拉会把它们又显示出来
        setMessages(result.messages);
        setLiveText('');
        liveRef.current = '';
        setScrollTick((n) => n + 1);
        if (result.draftText) setInput(result.draftText);
        setTreeOpen(false);
        // 回退后旧的改动面板/子任务不再对应当前状态：
        // 文件已经恢复到那一剂，还显示「+1 -1」会让人以为改还没来得及退
        setTurnDiff(null);
        setDiffOpen(false);
        setTasks([]);
        // 文件是否也回滚了，必须告诉用户 —— 他很可能以为「退回去=撤销了」
        if (result.filesRestored) {
          setNotice('已回到那一刻，磁盘文件也一并恢复');
        } else if (result.filesRestoreReason) {
          setNotice(`已回到那一刻，但文件没有回滚：${result.filesRestoreReason}`);
        }
        // 回退后上下文变了，占用条也要重算
        void host.contextUsage(activeId).then(setUsage);
      } catch (error) {
        setNotice(`回退失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setTreeBusy(false);
      }
    },
    [activeId, treeBusy, host],
  );

  const stopTask = useCallback(
    async (taskId: string) => {
      if (!activeId) return;
      try {
        await host.stopTask(activeId, taskId);
      } catch (error) {
        setNotice(`停止失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [activeId, host],
  );

  /**
   * 改额外目录并立即生效。
   *
   * 不先在本地撤销再写：权限一旦变了，界面应该反映引擎真实状态，
   * 所以写完重新读一次。
   */
  const applyExtraDirs = useCallback(
    async (next: ExtraDirs) => {
      if (!activeId) return;
      try {
        await host.setExtraDirs(activeId, next);
        setExtraDirs(await host.readExtraDirs(activeId));
      } catch (error) {
        setNotice(`设置失败：${error instanceof Error ? error.message : String(error)}`);
        // 失败时也重读，让界面回到真实状态
        setExtraDirs(await host.readExtraDirs(activeId));
      }
    },
    [activeId, host],
  );

  const exportHtml = useCallback(async () => {
    if (!activeId) return;
    setExporting(true);
    try {
      const filePath = await host.exportHtml(activeId);
      setNotice(`已导出到 ${filePath}`);
    } catch (error) {
      setNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  }, [activeId, host]);

  /* 从剪贴板/拖放里收图片 */
  const addImages = useCallback((files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        if (result) setPendingImages((prev) => [...prev, result]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

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

  const switchSessionRef = useRef<((id: string) => Promise<void>) | null>(null);

  /** 当前会话变了就通知宿主：它据此决定「后台完成」要不要弹通知 */
  useEffect(() => {
    void host.setCurrentSession(activeId);
  }, [host, activeId]);

  /** 点系统通知后，宿主会要求切到对应会话 */
  useEffect(() => {
    return host.onFocusSession((sessionId) => {
      void switchSessionRef.current?.(sessionId);
    });
  }, [host]);

  const switchSession = async (id: string) => {
    if (id === activeId) return;
    const rows = await host.loadSession(id);
    setActiveId(id);
    setMessages(rows);
    setLiveText('');
    liveRef.current = '';
    setScrollTick((n) => n + 1);
    setUsage(null);
    // 改动面板属于上一轮的，切会话必须清掉，否则会误以为新会话改过文件
    setTurnDiff(null);
    setDiffOpen(false);
    // 子任务也属于上一会话
    setTasks([]);
    void host.contextUsage(id).then(setUsage);
    void host.readModes(id).then(setModes);
    void host.readExtraDirs(id).then(setExtraDirs);
    setDirsOpen(false);
  };

  /* ---------------- 会话管理 ---------------- */

  /** 归档数只用来决定「要不要显示入口」，拿不到就当 0，不报错 */
  const refreshArchivedCount = useCallback(() => {
    void host
      .listArchived()
      .then((rows) => setArchivedCount(rows.length))
      .catch(() => setArchivedCount(0));
  }, [host]);

  useEffect(() => {
    refreshArchivedCount();
  }, [refreshArchivedCount, sessions.length]);


  /** 重命名：只改本地列表，不重拉 —— 改名不影响会话内容 */
  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await host.renameSession(sessionId, title);
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title } : s)));
      } catch (error) {
        setNotice(`重命名失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [host],
  );

  /** 置顶：要重拉列表，因为排序变了 */
  const pinSession = useCallback(
    async (sessionId: string, pinned: boolean) => {
      try {
        await host.pinSession(sessionId, pinned);
        setSessions(await host.listSessions());
      } catch (error) {
        setNotice(`操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [host],
  );

  /**
   * 归档：从侧栏移走，但可恢复。
   * 归档的是当前会话时要切到另一个，否则界面会挂在一个已归档会话上。
   */
  const archiveSession = useCallback(
    async (sessionId: string) => {
      try {
        await host.archiveSession(sessionId);
        const remaining = await host.listSessions();
        setSessions(remaining);
        // 归档后必须刷新计数，否则底栏的「已归档 N」入口不会出现
        refreshArchivedCount();
        if (sessionId === activeId) {
          const next = remaining[0];
          if (next) await switchSession(next.id);
          else setActiveId(null);
        }
      } catch (error) {
        setNotice(`归档失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [host, activeId, switchSession, refreshArchivedCount],
  );

  /** 彻底删除：不可恢复，UI 已做过二次确认 */
  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await host.deleteSession(sessionId);
        const remaining = await host.listSessions();
        setSessions(remaining);
        if (sessionId === activeId) {
          const next = remaining[0];
          if (next) await switchSession(next.id);
          else setActiveId(null);
        }
      } catch (error) {
        setNotice(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [host, activeId, switchSession],
  );

  // 让 onFocusSession 能调到最新的 switchSession
  switchSessionRef.current = switchSession;

  const newSession = async () => {
    const boot = await host.createSession();
    setSessions(boot.sessions);
    setActiveId(boot.activeSessionId);
    setMessages(boot.messages);
    // 新会话还没有上下文，不画进度条
    setUsage(null);
    setTurnDiff(null);
    setDiffOpen(false);
    setTasks([]);
    setExtraDirs({ read: [], write: [] });
    setDirsOpen(false);
    setTree([]);
    setTreeOpen(false);
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
    <>
      {/* 验收专用：真的抛一次渲染异常，验证错误边界接得住 */}
      {crashForTest && <CrashForTest />}
      <div className="shell">
      {/* 首次启动没 key：全屏拦截，不让人看着界面发不了消息 */}
      {settingsMode === 'onboarding' && (
        <SettingsPanel
          host={host}
          mode="onboarding"
          onSaved={() => {
            // 配置只在启动时读，保存后重启才能生效
            setHasKey(true);
            void host.restartApp();
          }}
        />
      )}

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
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeId}
              busy={busySessions.has(s.id)}
              onSelect={() => void switchSession(s.id)}
              onRename={(title) => void renameSession(s.id, title)}
              onPin={(pinned) => void pinSession(s.id, pinned)}
              onArchive={() => void archiveSession(s.id)}
              onDelete={() => void deleteSession(s.id)}
            />
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="ghost" onClick={toggleTheme}>
            {dark ? '浅色' : '深色'}
          </button>
          {archivedCount > 0 && (
            <button
              data-testid="archived-entry"
              className="ghost"
              title="查看并恢复已归档的会话"
              onClick={() => setArchivedOpen(true)}
            >
              已归档 {archivedCount}
            </button>
          )}
          <button
            className="ghost"
            title="设置（模型、密钥、审批策略）"
            onClick={() => setSettingsMode('drawer')}
          >
            设置
          </button>
        </div>
      </aside>

      {settingsMode === 'drawer' && (
        <SettingsPanel
          host={host}
          mode="drawer"
          onClose={() => setSettingsMode(null)}
          onSaved={() => {
            // 不关面板：还要问「现在重启还是稍后」。
            // 真重启的话整个窗口会重开，面板自然就没了。
          }}
          restartOnSave
          busy={running}
        />
      )}

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
          {/*
            顶栏只留「状态」，不放操作。
            操作类控件全部移到输入框底部 —— 它们是对「这次发送」的设定，
            应该紧贴输入位置，而不是让人在屏幕两端来回跳。
          */}
          {usage && (
            <UsageMeter
              usage={usage}
              onCompact={() => void compactNow()}
              compacting={compacting}
              disabled={running}
            />
          )}
        </div>

        <div className="scroller" ref={scrollerRef}>
          <Chat messages={messages} liveText={liveText} running={running} />
          {tasks.length > 0 && (
            <TaskCard
              tasks={tasks}
              onStop={(taskId) => void stopTask(taskId)}
            />
          )}
        </div>

        <div className="composer-wrap">
          <StatusLine status={turnStatus} />
          {pendingImages.length > 0 && (
            <div className="attach-strip">
              {pendingImages.map((src, i) => (
                <span className="attach-item" key={i}>
                  <img className="attach-thumb" src={src} alt="待发送图片" />
                  <button
                    className="attach-x"
                    title="移除"
                    onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
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
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length === 0) return;
                // 有图就吃掉这次粘贴，不然同时还会粘进一堆乱码（部分平台粘贴图片会给文件名）
                if (files.some((f) => f.type.startsWith('image/'))) {
                  e.preventDefault();
                  addImages(files);
                }
              }}
              onDrop={(e) => {
                const files = [...e.dataTransfer.files];
                if (files.length === 0) return;
                e.preventDefault();
                addImages(files);
              }}
              onDragOver={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />

            {/*
              工具栏放在输入框内部底部 —— 这些控件都是对「这次发送」的设定，
              应该紧贴输入位置，而不是让人在屏幕两端来回跳。
              左边：能力类（权限/思考/模型）；右边：发送类。
            */}
            <div className="composer-bar">
              <ModeControls
                modes={modes}
                disabled={!activeId}
                onChange={(mode) => void changeMode(mode)}
                onPlanToggle={(enabled) => void togglePlanMode(enabled)}
                onEffort={(effort) => void changeEffort(effort)}
              />

              {models.length > 1 && (
                <select
                  className="model-select bar-select"
                  value={model}
                  disabled={running}
                  title="切换模型（当前会话）"
                  onChange={(e) => void switchModelTo(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}

              {turnDiff && (
                <button
                  className="ghost bar-action"
                  title="展开本轮文件改动"
                  onClick={() => setDiffOpen(true)}
                >
                  改动 {turnDiff.changes.length}
                </button>
              )}
              <button
                className="ghost bar-action"
                disabled={!activeId}
                title="回到之前某一轮重新提问"
                onClick={() => {
                  const next = !treeOpen;
                  setTreeOpen(next);
                  if (next && activeId) {
                    void host.sessionTree(activeId).then(setTree).catch(() => setTree([]));
                  }
                }}
              >
                分支
              </button>
              <button
                className="ghost bar-action"
                disabled={!activeId}
                title="让它也能访问别的目录"
                onClick={() => {
                  const next = !dirsOpen;
                  setDirsOpen(next);
                  if (next && activeId) void host.readExtraDirs(activeId).then(setExtraDirs);
                }}
              >
                目录
                {extraDirs.read.length + extraDirs.write.length > 0
                  ? ` ${extraDirs.read.length + extraDirs.write.length}`
                  : ''}
              </button>
              <button
                className="ghost bar-action"
                disabled={!activeId || messages.length === 0 || exporting}
                title="把这段对话导出成一个 HTML 文件"
                onClick={() => void exportHtml()}
              >
                {exporting ? '导出中…' : '导出'}
              </button>
              <button
                className="ghost bar-action"
                disabled={!activeId || running || compacting || messages.length === 0}
                title="把较早的对话换成一页摘要，腾出上下文空间"
                onClick={() => void compactNow()}
              >
                {compacting ? '压缩中…' : '压缩'}
              </button>

              <span className="bar-spacer" />

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
                <button className="send" disabled={!input.trim() && pendingImages.length === 0} onClick={() => void send()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {turnDiff && diffOpen && (
          <DiffPanel payload={turnDiff} onClose={() => setDiffOpen(false)} />
        )}
        {archivedOpen && (
          <ArchivedPanel
            host={host}
            onClose={() => setArchivedOpen(false)}
            onRestored={() => {
              void host.listSessions().then(setSessions);
              refreshArchivedCount();
            }}
          />
        )}
        {archivedOpen && (
          <ArchivedPanel
            host={host}
            onClose={() => setArchivedOpen(false)}
            onRestored={() => {
              void host.listSessions().then(setSessions);
              refreshArchivedCount();
            }}
          />
        )}
        {dirsOpen && (
          <ExtraDirsPanel
            dirs={extraDirs}
            disabled={!activeId}
            onChange={(next) => void applyExtraDirs(next)}
            onClose={() => setDirsOpen(false)}
            onPick={() => host.pickDir()}
          />
        )}
        {treeOpen && (
          <TreePanel
            roots={tree}
            busy={treeBusy}
            onNavigate={(entryId, turnIndex) => void replayFrom(entryId, turnIndex)}
            onClose={() => setTreeOpen(false)}
          />
        )}
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
    </>
  );
}

/** 只在验收里被渲染：无条件抛错，用来验证错误边界。 */
function CrashForTest(): never {
  throw new Error('autotest-render-crash');
}
