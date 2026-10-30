/**
 * 主进程 ↔ 渲染进程 的唯一契约。
 *
 * 这个文件被两边同时引用，所以：
 *   - 只能放纯常量与类型，不能 import 任何 node/electron 模块
 *   - 渲染层只能通过这里声明的通道访问宿主，不存在第二个入口
 */

export const IPC = {
  /** 渲染 → 主：拿初始状态（会话列表 + 当前会话消息） */
  bootstrap: 'host:bootstrap',
  /** 渲染 → 主：新建会话 */
  createSession: 'host:create-session',
  /** 渲染 → 主：切换会话，取回历史 */
  loadSession: 'host:load-session',
  /** 渲染 → 主：发一条消息 */
  send: 'host:send',
  /** 渲染 → 主：回答审批 */
  approve: 'host:approve',
  /** 渲染 → 主：中断当前轮 */
  cancel: 'host:cancel',
  /** 渲染 → 主：继续一个被中断的轮 */
  resumeTurn: 'host:resume-turn',
  /** 渲染 → 主：忽略一个被中断的轮 */
  dismissTurn: 'host:dismiss-turn',
  /** 渲染 → 主：手动压缩会话上下文 */
  compact: 'host:compact',
  /** 渲染 → 主：轮进行中插话纠正 */
  steer: 'host:steer',
  /** 渲染 → 主：当前上下文占用 */
  contextUsage: 'host:context-usage',
  /** 主 → 渲染：宿主状态事件流 */
  event: 'host:event',
} as const;

export type ApprovalKind = 'permission' | 'ask_user_question' | 'plan_review';

/** 审批请求。注意这里只传渲染层需要的字段，不透传内部对象 */
export interface ApprovalRequest {
  requestId: string;
  kind: ApprovalKind;
  /** permission 才有 */
  toolName?: string;
  /** permission 的工具入参，已裁剪到安全大小 */
  input?: Record<string, unknown>;
  /** 一行摘要，用于卡片标题 */
  summary?: string;
  /** 被记住时代表什么，比如 `bash: git`；仅用于展示 */
  rememberKey?: string;
}

/** 渲染层看到的消息形状 —— 与数据库行解耦，只保留 UI 需要的 */
export interface UiMessage {
  id: string;
  role:
    | 'user'
    | 'user_steer'
    | 'assistant'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'error'
    | 'compact_boundary';
  text?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  /** 仍在流式生成中 */
  streaming?: boolean;
  /** compact_boundary 专用：谁触发的、压缩前后的 token 估算 */
  compact?: { trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null };
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  status: string;
  updatedAt: number;
}

export interface BootstrapResult {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  messages: UiMessage[];
  /** 上次进程被中断、尚未收口的轮 */
  interruptedTurns: InterruptedTurn[];
  model: string;
}

/**
 * 一个被中断的轮。
 *
 * hasOutput 决定「继续」的语义：
 *   - 有产出 → 发一句续跑指令，接在已有上下文后面
 *   - 零产出 → 重发用户原文，否则模型不知道要干什么
 */
export interface InterruptedTurn {
  turnId: string;
  sessionId: string;
  sessionTitle: string;
  startedAt: number;
  /** 触发这一轮的用户原文，可能为 null（历史数据缺 client_id） */
  userText: string | null;
  hasOutput: boolean;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';

/** 一个文件的改动摘要 */
export interface FileChange {
  /** 相对工作目录的路径 */
  path: string;
  status: ChangeStatus;
  insertions: number;
  deletions: number;
}

/** 本轮改动了哪些文件 */
export interface TurnDiffPayload {
  /** false = 工作目录不是 git 仓库，只有「碰过的路径」没有行级 diff */
  tracked: boolean;
  changes: FileChange[];
  diff: string;
  truncated: boolean;
}

/** 宿主 → 渲染 的事件 */
export type HostEvent =
  | { type: 'text'; turnId: string; text: string; isFinal: boolean }
  | { type: 'thinking'; turnId: string; text: string; isFinal: boolean }
  | { type: 'tool_use'; turnId: string; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; turnId: string; toolUseId: string; output: string; isError: boolean }
  | { type: 'turn'; turnId: string; state: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'; message?: string }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval_settled'; requestId: string }
  | { type: 'session_title'; sessionId: string; title: string }
  | { type: 'compact'; turnId: string | null; trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null }
  | { type: 'steer'; turnId: string; text: string }
  | ({ type: 'turn_diff'; turnId: string } & TurnDiffPayload)
  | { type: 'error'; message: string };

/** 手动压缩的结果 —— noop 表示上下文太小，不是错误 */
export interface CompactResult {
  noop: boolean;
  preTokens?: number;
  postTokens?: number;
}

/**
 * 上下文占用。
 *
 * 有意只取这三个字段：引擎返回的 categories / gridRows 是给「分项饼图」用的，
 * 我们只画一根进度条，多余的字段过 IPC 只是浪费。
 */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  /** 0-100，已经夹紧过 */
  percentage: number;
}

export interface SendInput {
  sessionId: string;
  text: string;
}

export interface ApproveInput {
  requestId: string;
  behavior: 'allow' | 'deny';
  /** ask_user_question 的回答 */
  answers?: Record<string, string>;
  /** 记住这次选择：none = 仅本次（默认）、session = 本会话、global = 始终 */
  remember?: 'none' | 'session' | 'global';
}

/** preload 暴露到 window 上的 API 形状 */
export interface HostBridge {
  bootstrap(): Promise<BootstrapResult>;
  createSession(): Promise<BootstrapResult>;
  loadSession(sessionId: string): Promise<UiMessage[]>;
  send(input: SendInput): Promise<void>;
  approve(input: ApproveInput): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  resumeTurn(turnId: string): Promise<void>;
  dismissTurn(turnId: string): Promise<void>;
  compact(sessionId: string): Promise<CompactResult>;
  /** 轮在进行中时插一句话纠正方向 */
  steer(sessionId: string, text: string): Promise<void>;
  /** 当前上下文占用；拿不到时返回 null（不报错，UI 自己隐藏） */
  contextUsage(sessionId: string): Promise<ContextUsage | null>;
  onEvent(listener: (event: HostEvent) => void): () => void;
}
