import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chat } from './Chat';
import { DiffPanel } from './DiffPanel';
import { ExtraDirsPanel } from './ExtraDirsPanel';
import { ModeControls } from './ModeControls';
import { PlusMenu, PLUS_ICONS } from './PlusMenu';
import { ArchivedPanel } from './ArchivedPanel';
import { Sidebar } from './Sidebar';
import { SettingsPanel } from './SettingsPanel';
import { StatusLine } from './StatusLine';
import { TaskCard } from './TaskCard';
import { TreePanel } from './TreePanel';
import { WorkerDialog, type WorkerDraft } from './WorkerDialog';
import { WorkerPanel } from './WorkerPanel';
import { createMockHost } from './devMock';
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
  UiWorker,
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
  /** 侧栏折叠态。窄窗口自己收，用户也能手动切 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  /* ---- ORCA 协作 ---- */
  /** 当前 Lead 的 worker 列表（由宿主投影推送，不自己推导） */
  const [workers, setWorkers] = useState<UiWorker[]>([]);
  /**
   * 跨会话的 worker 总览：leadSessionId → workers。
   *
   * 为什么要单独存一份：workers 只记当前 Lead 的，切走就丢，
   * 于是「另一个会话里的 worker 还在跑」这件事在界面上完全看不出来。
   * 多会话并行时这恰恰是最需要知道的。
   */
  const [workersByLead, setWorkersByLead] = useState<Record<string, UiWorker[]>>({});
  /** 面板里选中的 worker */
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null);
  /** 是否展开右侧面板 */
  const [orcaOpen, setOrcaOpen] = useState(false);
  /** 每个 worker 的对话缓存：切来切去不用重新拉 */
  const workerMsgs = useRef<Map<string, UiMessage[]>>(new Map());
  /** worker 的流式文字，和主对话分开存（否则会串台） */
  const workerLive = useRef<Map<string, string>>(new Map());
  /**
   * worker 对话 + 流式文字的快照。
   *
   * 为什么不直接传 ref：ref 变了 React 不会重渲染，面板就永远是打开那一刻的样子。
   * 所以每次 worker 内容变化都把 ref 里的值拷进 state 一份。
   * 数据量不大（就几个 worker），拷一下比引入 useSyncExternalStore 简单。
   */
  const [workerView, setWorkerView] = useState<{
    msgs: Record<string, UiMessage[]>;
    live: Record<string, string>;
  }>({ msgs: {}, live: {} });

  /** 把 ref 里的最新内容同步到 state */
  const syncWorkerView = useCallback(() => {
    setWorkerView({
      msgs: Object.fromEntries(workerMsgs.current),
      live: Object.fromEntries(workerLive.current),
    });
  }, []);
  const [workerBusy, setWorkerBusy] = useState<Set<string>>(new Set());
  const [creatingWorker, setCreatingWorker] = useState(false);
  /** 「开启协同」弹窗是否打开 */
  const [workerDialogOpen, setWorkerDialogOpen] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);
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
  /**
   * 忽略这个时间点之前启动的 turn_diff 事件。
   *
   * 背景：diff 是异步算的（轮结束后宿主要跑 git diff，要几百毫秒）。
   * 用户回退时我们清空了 turnDiff，但那时上一轮的计算可能还在跑，
   * 算完才推过来 —— 结果回退后界面上又出现了「已回滚的改动」。
   * 所以回退时记下时间，早于它的 diff 一律丢掉。
   */
  const ignoreDiffBeforeRef = useRef(0);
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
  /**
   * 按会话缓存的流式文本。
   *
   * 为什么要缓存而不是丢弃：多会话并行时用户会切来切去，
   * 切回去应该能看到「它还在写」，而不是一片空白直到跑完。
   *
   * 内存代价可忽略：每个会话最多几十 KB 文本，并发 5 个也就几百 KB。
   * 轮结束时清掉（内容已落库，再留着会跟历史重复）。
   */
  const liveBySession = useRef<Map<string, string>>(new Map());
  const activeRef = useRef<string | null>(null);
  /** sessionId → workerId。text 事件只带 sessionId，得能反查是不是 worker */
  const workerBySessionRef = useRef<Map<string, string>>(new Map());
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
  // worker 列表变了就更新反查表：text 事件只带 sessionId，
  // 得靠这张表判断「这条文字是 worker 写的还是主会话写的」
  useEffect(() => {
    const map = new Map<string, string>();
    for (const w of workers) map.set(w.sessionId, w.id);
    workerBySessionRef.current = map;
  }, [workers]);

  useEffect(() => {
    const off = host.onEvent((event) => {
      switch (event.type) {
        case 'text': {
          // 不管是不是当前会话都先缓存 —— 用户随时可能切过去看它写到哪了
          const cached = event.isFinal
            ? event.text
            : (liveBySession.current.get(event.sessionId) ?? '') + event.text;
          liveBySession.current.set(event.sessionId, cached);

          // worker 的流式输出去 worker 面板，不能进主对话。
          // worker 就是个会话，不区分的话「看到 worker 干活」会变成
          // 「主对话里莫名其妙多出别人写的字」。
          const w = workerBySessionRef.current.get(event.sessionId);
          if (w) {
            const buf = event.isFinal
              ? event.text
              : (workerLive.current.get(w) ?? '') + event.text;
            workerLive.current.set(w, buf);
            syncWorkerView();
            return;
          }

          // 后台会话只缓存、不上屏（否则会串到当前对话里）
          if (event.sessionId !== activeRef.current) return;

          liveRef.current = cached;
          setLiveText(cached);
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
          // 内容已落库，缓存必须清掉，否则下次切回来会看到重复的一份
          liveBySession.current.delete(event.sessionId);
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

        case 'workers': {
          // 总览无条件存：后台 Lead 的 worker 也要能看见
          setWorkersByLead((prev) => ({ ...prev, [event.leadSessionId]: event.workers }));

          // 面板只跟当前 Lead —— 后台 Lead 的推送不该覆盖当前面板
          if (event.leadSessionId !== activeRef.current) return;
          setWorkers(event.workers);
          setWorkerBusy(
            new Set(event.workers.filter((w) => w.status === 'running').map((w) => w.id)),
          );
          // 面板开着但没选中：自动选第一个跑着的，让用户「看到有人在干活」
          setActiveWorkerId((prev) => {
            if (prev && event.workers.some((w) => w.id === prev)) return prev;
            const running = event.workers.find((w) => w.status === 'running');
            return running?.id ?? event.workers[0]?.id ?? null;
          });
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
          // 回退后到达的旧 diff 直接丢：它的内容已经被回滚掉了，
          // 再显示会让人以为「改还没来得及退」
          if (Date.now() < ignoreDiffBeforeRef.current) return;
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
        // 丢掉之前启动、回退后才算完的 diff（异步计算有延迟）
        ignoreDiffBeforeRef.current = Date.now() + 2000;
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
    // 切过去时把该会话还在流的文本接上 —— 这就是「看着它干活」
    const cached = liveBySession.current.get(id) ?? '';
    setLiveText(cached);
    liveRef.current = cached;
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
    // worker 属于 Lead，切会话必须重拉 —— 否则会显示上一个会话的工人
    void loadWorkers(id);
  };

  /* ---------------- ORCA 操作 ---------------- */

  /** 拉某个 Lead 的 worker 列表 */
  const loadWorkers = useCallback(async (leadId: string) => {
    try {
      const list = await host.listWorkers(leadId);
      setWorkers(list);
      setWorkerBusy(new Set(list.filter((w) => w.status === 'running').map((w) => w.id)));
      setActiveWorkerId((prev) => {
        if (prev && list.some((w) => w.id === prev)) return prev;
        const running = list.find((w) => w.status === 'running');
        return running?.id ?? list[0]?.id ?? null;
      });
    } catch (error) {
      setWorkerError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  /** 打开面板：先把现有 worker 拉一遍，不然要等下次事件才有内容 */
  const openOrca = useCallback(async () => {
    setOrcaOpen(true);
    setWorkerError(null);
    if (activeId) await loadWorkers(activeId);
  }, [activeId, loadWorkers]);

  /** 建一个 worker。建完立刻选中它，让用户看见「新的人来了」 */
  /** 打开「开启协同」弹窗。真正的建在 submitWorker 里 */
  const createWorker = useCallback(() => {
    if (!activeId || creatingWorker) return;
    setWorkerError(null);
    setWorkerDialogOpen(true);
  }, [activeId, creatingWorker]);

  /** 弹窗提交：带上角色 / 模型 / 权限 / 初始任务去建 */
  const submitWorker = useCallback(
    async (draft: WorkerDraft) => {
      if (!activeId || creatingWorker) return;
      setCreatingWorker(true);
      setWorkerError(null);
      try {
        const w = await host.createWorker(activeId, {
          role: draft.role,
          ...(draft.label ? { label: draft.label } : {}),
          model: draft.model,
          permissionMode: draft.permissionMode,
          isolate: draft.isolate,
          ...(draft.firstTask ? { firstTask: draft.firstTask } : {}),
        });
        setActiveWorkerId(w.id);
        await loadWorkers(activeId);
        // worker 会话会出现在会话表里，必须重拉一次才能把它从主列表过滤掉
        setSessions(await host.listSessions());
        setWorkerDialogOpen(false);
      } catch (error) {
        setWorkerError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingWorker(false);
      }
    },
    [activeId, creatingWorker, loadWorkers],
  );

  const removeWorker = useCallback(
    async (workerId: string) => {
      if (!activeId) return;
      try {
        await host.removeWorker(workerId);
        workerMsgs.current.delete(workerId);
        workerLive.current.delete(workerId);
        await loadWorkers(activeId);
      } catch (error) {
        setWorkerError(error instanceof Error ? error.message : String(error));
      }
    },
    [activeId, loadWorkers],
  );

  const toggleIsolation = useCallback(
    async (workerId: string, isolated: boolean) => {
      if (!activeId) return;
      try {
        await host.setWorkerIsolation(workerId, isolated);
        await loadWorkers(activeId);
      } catch (error) {
        setWorkerError(error instanceof Error ? error.message : String(error));
      }
    },
    [activeId, loadWorkers],
  );

  /** 选中某个 worker：拉它的对话（缓存过就不重拉） */
  const selectWorker = useCallback(async (workerId: string) => {
    setActiveWorkerId(workerId);
    setWorkerError(null);
    if (workerMsgs.current.has(workerId)) return;
    const w = workers.find((x) => x.id === workerId);
    if (!w) return;
    try {
      const rows = await host.loadSession(w.sessionId);
      workerMsgs.current.set(workerId, rows);
      syncWorkerView();
    } catch (error) {
      setWorkerError(error instanceof Error ? error.message : String(error));
    }
  }, [workers]);

  /** 给 worker 派活 */
  const sendToWorker = useCallback(
    async (workerId: string, text: string) => {
      const w = workers.find((x) => x.id === workerId);
      if (!w) return;
      try {
        await host.send({ sessionId: w.sessionId, text });
        // 立刻把用户这句话塞进本地缓存：不等宿主回推，界面要先有反应
        const rows = workerMsgs.current.get(workerId) ?? [];
        workerMsgs.current.set(workerId, [
          ...rows,
          { role: 'user', text } as UiMessage,
        ]);
        setWorkerBusy((prev) => new Set(prev).add(workerId));
        syncWorkerView();
      } catch (error) {
        setWorkerError(error instanceof Error ? error.message : String(error));
      }
    },
    [workers],
  );

  const cancelWorker = useCallback(
    async (workerId: string) => {
      const w = workers.find((x) => x.id === workerId);
      if (!w) return;
      try {
        await host.cancel(w.sessionId);
      } catch (error) {
        setWorkerError(error instanceof Error ? error.message : String(error));
      }
    },
    [workers],
  );


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
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        busySessions={busySessions}
        archivedCount={archivedCount}
        dark={dark}
        isMock={isMock}
        view="sessions"
        onNewSession={() => void newSession()}
        onCreate={() => void newSession()}
        onSelect={(id) => void switchSession(id)}
        onRename={(id, title) => void renameSession(id, title)}
        onPin={(id, p) => void pinSession(id, p)}
        onArchive={(id) => void archiveSession(id)}
        onDelete={(id) => void deleteSession(id)}
        onOpenArchived={() => setArchivedOpen(true)}
        onOpenSettings={() => setSettingsMode('drawer')}
        onToggleTheme={toggleTheme}
        onToggleOrca={() => void (orcaOpen ? setOrcaOpen(false) : openOrca())}
        orcaOpen={orcaOpen}
        workerCount={workers.length}
        workerRunning={workers.filter((w) => w.status === 'running').length}
        workersByLead={workersByLead}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
      />


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
        <div className="main-col">
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
              {/* 左边：低频功能收进「+」，高频的权限档位常驻 */}
              <PlusMenu
                items={[
                  {
                    id: 'plan',
                    label: '计划模式',
                    icon: PLUS_ICONS.plan,
                    active: modes.planMode,
                    hint: modes.planMode ? '已开' : undefined,
                    disabled: !activeId,
                    onClick: () => void togglePlanMode(!modes.planMode),
                  },
                  {
                    id: 'branch',
                    label: '对话分支',
                    icon: PLUS_ICONS.branch,
                    disabled: !activeId,
                    onClick: () => {
                      const next = !treeOpen;
                      setTreeOpen(next);
                      if (next && activeId) {
                        void host.sessionTree(activeId).then(setTree).catch(() => setTree([]));
                      }
                    },
                  },
                  {
                    id: 'dirs',
                    label: '额外目录',
                    icon: PLUS_ICONS.folder,
                    hint:
                      extraDirs.read.length + extraDirs.write.length > 0
                        ? `${extraDirs.read.length + extraDirs.write.length} 项`
                        : undefined,
                    disabled: !activeId,
                    onClick: () => {
                      const next = !dirsOpen;
                      setDirsOpen(next);
                      if (next && activeId) void host.readExtraDirs(activeId).then(setExtraDirs);
                    },
                  },
                  {
                    id: 'diff',
                    label: '本轮改动',
                    icon: PLUS_ICONS.export,
                    hint: turnDiff ? String(turnDiff.changes.length) : undefined,
                    disabled: !turnDiff,
                    onClick: () => setDiffOpen(true),
                  },
                  {
                    id: 'export',
                    label: '导出对话',
                    icon: PLUS_ICONS.export,
                    disabled: !activeId || messages.length === 0 || exporting,
                    hint: exporting ? '导出中…' : undefined,
                    onClick: () => void exportHtml(),
                  },
                  {
                    id: 'compact',
                    label: '压缩上下文',
                    icon: PLUS_ICONS.compact,
                    disabled: !activeId || running || compacting || messages.length === 0,
                    hint: compacting ? '压缩中…' : undefined,
                    onClick: () => void compactNow(),
                  },
                ]}
              />

              <ModeControls
                modes={modes}
                disabled={!activeId}
                onChange={(mode) => void changeMode(mode)}
                onPlanToggle={(enabled) => void togglePlanMode(enabled)}
                onEffort={(effort) => void changeEffort(effort)}
              />

              <span className="bar-spacer" />

              {models.length > 1 && (
                <select
                  className="model-select bar-select"
                  value={model}
                  disabled={running}
                  title="切换模型（当前会话）"
                  onChange={(e) => void switchModelTo(e.target.value)}
                  data-testid="model-select"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}

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
                  <button
                    className="send stop"
                    onClick={() => void host.cancel(activeId ?? '')}
                    data-testid="send-stop"
                    aria-label="停止"
                  >
                    <span className="square" />
                  </button>
                </>
              ) : (
                <button
                  className="send"
                  disabled={!input.trim() && pendingImages.length === 0}
                  onClick={() => void send()}
                  data-testid="send"
                  aria-label="发送"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
        </div>

        {orcaOpen && (
          <WorkerPanel
            workers={workers}
            activeWorkerId={activeWorkerId}
            messagesByWorker={Object.fromEntries(workerMsgs.current)}
            liveByWorker={Object.fromEntries(workerLive.current)}
            busyWorkerIds={workerBusy}
            onSelect={(id) => void selectWorker(id)}
            onClose={() => setOrcaOpen(false)}
            onCreate={() => void createWorker()}
            onRemove={(id) => void removeWorker(id)}
            onToggleIsolation={(id, iso) => void toggleIsolation(id, iso)}
            onSend={(id, text) => void sendToWorker(id, text)}
            onCancel={(id) => void cancelWorker(id)}
            creating={creatingWorker}
            error={workerError}
          />
        )}
      </main>

      {workerDialogOpen && (
        <WorkerDialog
          models={models}
          inheritedModel={model}
          canIsolate
          submitting={creatingWorker}
          error={workerError}
          onCancel={() => setWorkerDialogOpen(false)}
          onSubmit={(draft) => void submitWorker(draft)}
        />
      )}

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
