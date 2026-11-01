/**
 * 「开启协同」弹窗。
 *
 * 结构照搬 Cindy 的 OrcaWorkerCreateDialog：
 *   角色胶囊（预定义 + 自定义）→ 项目 → 模型 → 权限模式 → 初始任务 → 主按钮
 *
 * 为什么做成弹窗而不是「点一下直接建」：
 * 建 worker 要花的不是一次点击，而是**给它配一整套工作条件**
 * （什么角色、用哪个模型、在哪个目录、多少权限）。
 * 默认值全部预填好，不想改的人直接点主按钮就行 ——
 * 但想改的人不用「建了再改」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { PERMISSION_MODES } from './ModeControls';
import type { PermissionModeChoice } from './shared/ipc';

/** 与 host-core 的预定义角色保持一致 */
export const ORCA_ROLES = ['developer', 'designer', 'reviewer', 'tester', 'merger'] as const;

export interface WorkerDraft {
  role: string;
  /** 自定义角色名；空表示用胶囊选中的那个 */
  customRole: string;
  label: string;
  model: string;
  permissionMode: PermissionModeChoice;
  firstTask: string;
  /** 是否独立 worktree */
  isolate: boolean;
}

export interface WorkerDialogProps {
  /** 可选模型；空数组表示只有继承 Lead 一个选项 */
  models: Array<{ id: string; label: string }>;
  /** Lead 当前用的模型，作为默认值 */
  inheritedModel: string;
  /** 是否能把工作目录隔离出去（非 git 仓库时为 false，要提示用户） */
  canIsolate: boolean;
  submitting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (draft: WorkerDraft) => void;
}

export function WorkerDialog(props: WorkerDialogProps) {
  const {
    models,
    inheritedModel,
    canIsolate,
    submitting = false,
    error = null,
    onCancel,
    onSubmit,
  } = props;

  const [role, setRole] = useState<string>(ORCA_ROLES[0]);
  const [customRole, setCustomRole] = useState('');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState(inheritedModel);
  const [permissionMode, setPermissionMode] = useState<PermissionModeChoice>(
    canIsolate ? 'bypassPermissions' : 'auto',
  );
  const [firstTask, setFirstTask] = useState('');
  const [isolate, setIsolate] = useState(canIsolate);
  const [modelOpen, setModelOpen] = useState(false);

  const customRef = useRef<HTMLInputElement>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  // 弹出就把焦点放在「初始任务」——多数人建 worker 是有活要派的，
  // 角色和模型通常不改。少一次点击。
  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  // Esc 关闭。弹窗开着却关不掉是最烦的交互之一。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const effectiveRole = customRole.trim() || role;
  const canSubmit = effectiveRole.length > 0 && !submitting;

  const modelOptions = useMemo(() => {
    const list = models.length > 0 ? models : [{ id: inheritedModel, label: inheritedModel }];
    return list;
  }, [models, inheritedModel]);

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      role: effectiveRole,
      customRole,
      label: label.trim(),
      model,
      permissionMode,
      firstTask: firstTask.trim(),
      isolate,
    });
  };

  return (
    <div
      className="dialog-scrim"
      data-testid="worker-dialog"
      onMouseDown={(e) => {
        // 点遮罩关闭，但点弹窗内部不关
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="开启协同">
        <div className="dialog-head">
          <span className="dialog-title">开启协同</span>
          <button
            type="button"
            className="dialog-close"
            onClick={onCancel}
            disabled={submitting}
            aria-label="关闭"
            data-testid="worker-dialog-close"
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          {/* ---- 角色 ---- */}
          <div className="field">
            <label className="field-label">
              角色名
              <span
                className="field-hint-icon"
                title="角色只是给这个 worker 一个身份标签，会影响它的工作风格。不影响权限。"
              >
                ⓘ
              </span>
            </label>
            <div className="chip-row" data-testid="worker-role-chips">
              {ORCA_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`chip${!customRole.trim() && role === r ? ' active' : ''}`}
                  onClick={() => {
                    setRole(r);
                    setCustomRole('');
                  }}
                  data-testid={`worker-role-${r}`}
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="input-wrap">
              <span className="input-prefix">+</span>
              <input
                ref={customRef}
                className="text-input"
                placeholder="自定义角色名（可选）"
                value={customRole}
                onChange={(e) => setCustomRole(e.target.value)}
                maxLength={32}
                data-testid="worker-custom-role"
              />
            </div>
          </div>

          {/* ---- 名字（Cindy 没有，但没有它多个 worker 分不清） ---- */}
          <div className="field">
            <label className="field-label">名字（可选）</label>
            <input
              className="text-input"
              placeholder="留空则用角色名，重名自动加序号"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={32}
              data-testid="worker-label"
            />
          </div>

          {/* ---- 项目 / 工作目录 ---- */}
          <div className="field">
            <label className="field-label">项目</label>
            <div className="project-row">
              <span className="project-pick">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <path d="M1.8 4.2h4.4l1.2 1.6h6.8v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
                </svg>
                当前项目
              </span>
            </div>
            <p className="field-note" data-testid="worker-workdir-note">
              {canIsolate
                ? `将在独立工作区里干活（git worktree），不会和 Lead 或其他 worker 互相覆盖。`
                : `当前目录不是 git 仓库，无法新建隔离工作区。Worker 将和 Lead 共用同一个目录，共享文件。`}
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={isolate}
                disabled={!canIsolate}
                onChange={(e) => {
                  setIsolate(e.target.checked);
                  // 隔离和权限是配套的：没隔离就不该默认全放行
                  setPermissionMode(e.target.checked ? 'bypassPermissions' : 'auto');
                }}
                data-testid="worker-isolate"
              />
              使用独立工作区
            </label>
          </div>

          {/* ---- 模型 ---- */}
          <div className="field">
            <label className="field-label">模型</label>
            <div className="select-wrap">
              <button
                type="button"
                className="select-trigger"
                onClick={() => setModelOpen((v) => !v)}
                data-testid="worker-model-trigger"
              >
                <span className="select-icon">J</span>
                <span className="select-value">
                  {modelOptions.find((m) => m.id === model)?.label ?? model}
                </span>
                <span className="select-caret">▾</span>
              </button>
              {modelOpen && (
                <div className="select-menu" data-testid="worker-model-menu">
                  {modelOptions.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`select-item${m.id === model ? ' active' : ''}`}
                      onClick={() => {
                        setModel(m.id);
                        setModelOpen(false);
                      }}
                      data-testid={`worker-model-${m.id}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ---- 权限模式 ---- */}
          <div className="field">
            <div className="perm-row">
              <span className="perm-label">权限模式</span>
              <div className="select-wrap">
                <button
                  type="button"
                  className={`perm-trigger${permissionMode === 'bypassPermissions' ? ' danger' : ''}`}
                  onClick={() => {
                    const idx = PERMISSION_MODES.findIndex((m) => m.id === permissionMode);
                    const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!;
                    setPermissionMode(next.id);
                  }}
                  title={PERMISSION_MODES.find((m) => m.id === permissionMode)?.hint}
                  data-testid="worker-permission"
                  data-mode={permissionMode}
                >
                  {permissionMode === 'bypassPermissions' && <span className="perm-warn">⚠</span>}
                  {PERMISSION_MODES.find((m) => m.id === permissionMode)?.label}
                  <span className="select-caret">▾</span>
                </button>
              </div>
            </div>
          </div>

          {/* ---- 初始任务 ---- */}
          <div className="field">
            <label className="field-label">初始任务（可选）</label>
            <textarea
              ref={taskRef}
              className="text-area"
              rows={4}
              placeholder="给这个 Worker 的可选第一条任务"
              value={firstTask}
              onChange={(e) => setFirstTask(e.target.value)}
              data-testid="worker-first-task"
            />
          </div>

          {error && (
            <div className="dialog-error" data-testid="worker-dialog-error">
              {error}
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <button
            type="button"
            className="dialog-primary"
            onClick={submit}
            disabled={!canSubmit}
            data-testid="worker-submit"
          >
            {submitting ? '创建中…' : '开启协同'}
          </button>
        </div>
      </div>
    </div>
  );
}
