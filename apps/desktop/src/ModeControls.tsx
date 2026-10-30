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
    label: '每次询问',
    hint: '只读工具直接跑；改文件、执行命令、调 MCP 都先问你',
  },
  {
    id: 'auto',
    label: '自动放行工作区内',
    hint: '工作区内写文件和常用安全命令不再问；区外写入和危险命令仍会问',
  },
  {
    id: 'bypassPermissions',
    label: '全放行',
    hint: '任何文件都能改、任何命令都能跑，不再确认。只在你完全信任任务时用',
    dangerous: true,
  },
];

export function modeLabel(mode: PermissionModeChoice): string {
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode;
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
}: {
  modes: ModeState;
  disabled: boolean;
  onChange: (mode: PermissionModeChoice) => void;
  onPlanToggle: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外面收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

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
      >
        {current?.label ?? modes.permissionMode}
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
            PERMISSION_MODES.map((mode) => (
              <button
                key={mode.id}
                className={`mode-item${mode.id === modes.permissionMode ? ' active' : ''}${
                  mode.dangerous ? ' dangerous' : ''
                }`}
                onClick={() => pick(mode.id)}
              >
                <span className="mode-item-label">{mode.label}</span>
                <span className="mode-item-hint">{mode.hint}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
