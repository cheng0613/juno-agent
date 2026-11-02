import { useEffect, useRef, useState } from 'react';

import type { ModeState, PermissionModeChoice } from './shared/ipc';

/**
 * 权限档位的展示定义。
 *
 * 只列 pi 真实支持的三档。文案要说清「会替你做什么」，
 * 不能只写「Auto-review」这种术语 —— 用户看不懂就不会去动它，
 * 最后永远停在最不安全或最烦人的那一档。
 */
export const PERMISSION_MODES: Array<{
  id: PermissionModeChoice;
  label: string;
  hint: string;
  dangerous?: boolean;
}> = [
  {
    id: 'ask',
    label: '默认权限',
    hint: '只读工具直接执行；写文件、跑命令和 MCP 工具每次都询问。',
  },
  {
    id: 'auto',
    label: '自动审批',
    hint: '工作区内写文件和常用安全命令不再问；区外写入和危险命令仍会问。',
  },
  {
    id: 'bypassPermissions',
    label: '完全访问',
    hint: '任何文件都能改、任何命令都能跑，不再确认。只在你完全信任任务时用。',
    dangerous: true,
  },
];

/** 权限档位的图标。手代表「要问你」，星星代表「自动」，警告代表风险。 */
export function permissionIcon(id: PermissionModeChoice, size = 14) {
  const p = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (id === 'ask') {
    return (
      <svg {...p}>
        <path d="M5.2 7.4V4.2a1.2 1.2 0 0 1 2.4 0v2.6M7.6 6.2V3.4a1.2 1.2 0 0 1 2.4 0v3M10 6.6V4.6a1.2 1.2 0 0 1 2.4 0v4.6c0 2.4-1.8 4.2-4.2 4.2S4 11.6 4 9.2V7.6a1.1 1.1 0 0 1 2.2 0v1.2" />
      </svg>
    );
  }
  if (id === 'auto') {
    return (
      <svg {...p}>
        <path d="M8 1.8l1.5 3.9 3.9.3-3 2.6 1 4.1L8 10.5l-3.4 2.2 1-4.1-3-2.6 3.9-.3z" />
      </svg>
    );
  }
  // claude-code 独有：自动接受文件编辑，其余操作仍问
  if (id === 'acceptEdits') {
    return (
      <svg {...p}>
        <path d="M11.4 2.2l2.4 2.4-8.2 8.2H3.2v-2.4z" />
        <path d="M9.6 4l2.4 2.4" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <path d="M8 2.2L14.4 13H1.6z" />
      <path d="M8 6.4v2.8M8 11.2v.2" />
    </svg>
  );
}

export function modeLabel(mode: PermissionModeChoice): string {
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode;
}

/**
 * 思考档位的中文名。
 *
 * 不直接用引擎给的 displayName（Minimal / Low / …）：
 * 英文单词看不出「差在哪里」。用能直接感受到的描述。
 */
export const EFFORT_LABELS: Record<string, string> = {
  minimal: '最省',
  low: '省',
  medium: '标准',
  high: '深入',
  xhigh: '很深入',
  max: '最深入',
  ultra: '极致',
};

export function effortLabel(id: string): string {
  return EFFORT_LABELS[id] ?? id;
}

/**
 * 权限档位 + 计划模式控制条。
 *
 * 全放行要二次确认：它是唯一一个「点错一次就把整台机器交出去」的开关，
 * 不该和其它选项一样是一键切换。
 */
export function ModeControls({
  modes,
  disabled,
  onChange,
  onPlanToggle,
  onEffort,
}: {
  modes: ModeState;
  disabled: boolean;
  onChange: (mode: PermissionModeChoice) => void;
  onPlanToggle: (enabled: boolean) => void;
  onEffort: (effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外面收起（两个菜单都收）
  useEffect(() => {
    if (!open && !effortOpen) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEffortOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, effortOpen]);

  const current = PERMISSION_MODES.find((m) => m.id === modes.permissionMode);

  const pick = (id: PermissionModeChoice) => {
    if (id === 'bypassPermissions') {
      setConfirming(true);
      return;
    }
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="mode-controls" ref={boxRef}>
      <button
        className={`ghost mode-btn${modes.permissionMode === 'bypassPermissions' ? ' danger' : ''}`}
        disabled={disabled}
        title={current?.hint ?? ''}
        onClick={() => {
          setOpen((v) => !v);
          setConfirming(false);
        }}
        data-testid="permission-trigger"
        data-mode={modes.permissionMode}
        data-mode-count={modes.permissionModes.length}
      >
        <span className="mode-btn-icon">{permissionIcon(modes.permissionMode)}</span>
        {current?.label ?? modes.permissionMode}
        <span className="mode-btn-caret">▾</span>
      </button>

      <button
        className={`ghost mode-btn${modes.planMode ? ' on' : ''}`}
        disabled={disabled}
        title={
          modes.planMode
            ? '计划模式已开：只读不写，先给方案'
            : '开启后只读文件、不执行写操作，先出方案再动手'
        }
        onClick={() => onPlanToggle(!modes.planMode)}
      >
        计划{modes.planMode ? ' ✓' : ''}
      </button>

      {/* 档位由引擎给：模型不支持就完全不画，不摆假开关 */}
      {modes.effortLevels.length > 0 && (
        <div className="mode-effort">
          <button
            className="ghost mode-btn"
            disabled={disabled}
            title="思考档位：越高想得越深，也越慢"
            onClick={() => {
              setEffortOpen((v) => !v);
              setOpen(false);
            }}
          >
            {/* 未切过时引擎给 null，取中间档当显示值，别写「默认」让人猜 */}
            思考·{effortLabel(modes.effort ?? modes.effortLevels[Math.floor(modes.effortLevels.length / 2)] ?? '')}
          </button>
          {effortOpen && (
            <div className="mode-menu mode-menu-narrow">
              {modes.effortLevels.map((level) => (
                <button
                  key={level}
                  className={`mode-item${level === modes.effort ? ' active' : ''}`}
                  onClick={() => {
                    onEffort(level);
                    setEffortOpen(false);
                  }}
                >
                  <span className="mode-item-label">{effortLabel(level)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="mode-menu">
          {confirming ? (
            <div className="mode-confirm">
              <p className="mode-confirm-title">确定要全放行吗？</p>
              <p className="mode-confirm-body">
                打开后它可以直接改任何文件、跑任何命令，不再征求你同意。只在完全信任的任务上用。
              </p>
              <div className="mode-confirm-actions">
                <button className="btn ghost" onClick={() => setConfirming(false)}>
                  取消
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    onChange('bypassPermissions');
                    setConfirming(false);
                    setOpen(false);
                  }}
                >
                  确认全放行
                </button>
              </div>
            </div>
          ) : (
            /*
             * 档位来自宿主上报的 capabilities.permissionModes ——
             * 三个 harness 支持的档位不一样（claude-code 多一个 acceptEdits）。
             * 取不到时回落到内置默认，不因为拿不到能力就不画控件。
             */
            (modes.permissionModes.length > 0
              ? modes.permissionModes.map((m) => ({
                  id: m.id as PermissionModeChoice,
                  label: m.label,
                  hint: m.description,
                  dangerous: m.id === 'bypassPermissions',
                }))
              : PERMISSION_MODES
            ).map((mode) => (
              <button
                key={mode.id}
                className={`mode-item${mode.id === modes.permissionMode ? ' active' : ''}${
                  mode.dangerous ? ' dangerous' : ''
                }`}
                onClick={() => pick(mode.id)}
                title={mode.hint}
                data-testid={`mode-perm-${mode.id}`}
              >
                <span className="mode-item-icon">{permissionIcon(mode.id)}</span>
                <span className="mode-item-label">{mode.label}</span>
                {mode.id === modes.permissionMode && (
                  <span className="mode-item-check">✓</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
