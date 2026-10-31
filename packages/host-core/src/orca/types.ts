/**
 * ORCA 协作的共享契约。
 *
 * 设计对齐上游 Cindy 的 packages/maker-shared/src/orcaTeam.ts：
 *   - 角色名沿用它们的预定义集合（developer/designer/reviewer/tester/merger）
 *   - 并发上限沿用它们的默认值（软 5 / 硬 8）
 *
 * 两者的数值不是拍脑袋 —— 本地实测：
 *   5 个并发 → 1.3GB，延迟几乎不涨
 *   8 个并发 → 2.2GB，延迟 +28% 且方差变大
 * 和 Cindy 的默认值完全吻合。
 */

/** 预定义角色。自定义角色只要不超过长度上限也行 */
export const ORCA_PREDEFINED_ROLES = [
  'developer',
  'designer',
  'reviewer',
  'tester',
  'merger',
] as const;

export type OrcaPredefinedRole = (typeof ORCA_PREDEFINED_ROLES)[number];

export const ORCA_ROLE_MAX_LENGTH = 32;
export const ORCA_LABEL_MAX_LENGTH = 32;

/**
 * 并发上限。
 *
 * soft：超过这个数就是「该考虑清理了」，但还能建
 * hard：硬上限，再建就拒绝
 *
 * 实测数据见 docs/BENCH-PARALLEL.md。第一版不开放给用户调 ——
 * 这些值需要真实使用校准，不是配置项。
 */
export const ORCA_WORKER_SOFT_LIMIT = 5;
export const ORCA_WORKER_HARD_LIMIT = 8;

export type OrcaRole = 'lead' | 'worker';
export type OrcaTeamStatus = 'active' | 'completed' | 'cancelled' | 'failed';
export type OrcaWorkerStatus = 'idle' | 'running' | 'done' | 'error';

/** 建 worker 时的配置 */
export interface OrcaWorkerConfig {
  role: string;
  label?: string;
  /** 模型；不传就继承 lead */
  model?: string;
  /** 工作目录；不传就继承 lead */
  workingDir?: string;
}

export interface OrcaTeamRecord {
  id: string;
  leadSessionId: string;
  status: OrcaTeamStatus;
  createdAt: number;
  completedAt: number | null;
}

export interface OrcaWorkerRecord {
  id: string;
  teamId: string;
  sessionId: string;
  role: string;
  label: string | null;
  status: OrcaWorkerStatus;
  focused: boolean;
  idleSince: number | null;
  createdAt: number;
  updatedAt: number;
}

/** worker 在 UI 上显示什么名字：`role · label`，没 label 就只显示 role */
export function orcaWorkerDisplayName(role: string, label: string | null | undefined): string {
  return label ? `${role} · ${label}` : role;
}

/** 会话标题：让侧栏（如果显示的话）能一眼看出这是 worker */
export function orcaWorkerSessionTitle(role: string, label: string | null | undefined): string {
  return orcaWorkerDisplayName(role, label);
}

/**
 * 规范化角色名。
 *
 * 只做 trim + 长度截断，不做白名单校验 —— 预定义角色只是建议，
 * 用户想用「翻译员」也行。校验交给 UI 提示，不在这里拒绝。
 */
export function normalizeOrcaRole(raw: string): string {
  return raw.trim().slice(0, ORCA_ROLE_MAX_LENGTH) || 'developer';
}

export function normalizeOrcaLabel(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed ? trimmed.slice(0, ORCA_LABEL_MAX_LENGTH) : null;
}

/**
 * 生成一个不冲突的 label。
 *
 * 撞名时追加序号：developer-1、developer-2。上游同样这么做（createWorkerLabel）。
 */
export function createWorkerLabel(role: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((l) => l.toLowerCase()));
  if (!taken.has(role.toLowerCase())) return role;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${role}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${role}-${Date.now()}`;
}
