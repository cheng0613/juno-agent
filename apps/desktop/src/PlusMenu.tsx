/**
 * 输入框左下角的「+」菜单。
 *
 * 为什么要收起来：底部原本并排摆了「每次询问 计划 分支 目录 导出 压缩」六项，
 * 全平铺的结果是**每一项都不显眼** —— 用户根本记不住哪个在哪。
 * Cindy 的做法是把低频的收进「+」，只留高频的（权限、模型、发送）常驻。
 *
 * 这条边界的判断标准：这次发送**立刻就用到**的常驻，其余收进去。
 */
import { useEffect, useRef, useState } from 'react';

export interface PlusMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** 右侧的补充信息，比如「已开」「3 项」 */
  hint?: string;
  disabled?: boolean;
  /** 选中态：比如计划模式开着时时显示 */
  active?: boolean;
  onClick: () => void;
}

/** 一份能复用的 16px 线性图标集 */
const I = (d: string) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

export const PLUS_ICONS = {
  plan: I('M2.6 8.4l3.2 3.2 6.4-6.8'),
  branch: I('M4 2.6v10.8M4 5.4c0-1.6 1.3-2.8 3-2.8h5M4 11c0 1.6 1.3 2.8 3 2.8h5'),
  folder: I('M1.8 4.2h4.4l1.2 1.6h6.8v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z'),
  export: I('M8 1.8v8.4M4.6 6.6L8 10.2l3.4-3.6M2.2 12.2v1.4a.8.8 0 0 0 .8.8h10a.8.8 0 0 0 .8-.8v-1.4'),
  compact: I('M3 5.4h10M3 10.6h10'),
  effort: I('M8 1.8l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 11l-3.7 2.4 1.1-4.3L2 6.3l4.4-.3z'),
};

export function PlusMenu({ items }: { items: PlusMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点外面关掉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="plus-wrap" ref={boxRef}>
      <button
        type="button"
        className={`plus-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="更多"
        aria-label="更多选项"
        aria-expanded={open}
        data-testid="plus-menu-trigger"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>

      {open && (
        <div className="plus-menu" role="menu" data-testid="plus-menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`plus-item${item.active ? ' active' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              data-testid={`plus-${item.id}`}
            >
              <span className="plus-item-icon">{item.icon}</span>
              <span className="plus-item-label">{item.label}</span>
              {item.hint && <span className="plus-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
