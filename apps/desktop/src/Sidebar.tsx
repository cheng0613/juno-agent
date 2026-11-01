/**
 * 左侧栏。
 *
 * 结构对齐 Cindy：46px 顶栏 + 导航行 + 会话区 + 底部用户卡。
 *
 * 为什么导航行做成数据驱动（NAV_ITEMS）而不是写死 JSX：
 * 后期要加「插件 / 伙伴 / 自动化」。写死的话，每加一个都要改渲染逻辑、
 * 改布局、改选中判断；做成数组后，加一个入口就是加一条数据。
 * Cindy 那边更彻底（插件能自己注册侧栏入口），我们先把结构留出来。
 */
import type { ReactNode } from 'react';

import { SessionItem } from './SessionItem';
import type { SessionSummary, UiWorker } from './shared/ipc';

/** 侧栏视图。后期加「插件 / 伙伴 / 自动化」就往这里加 */
export type SidebarView = 'sessions';

export interface NavItem {
  id: SidebarView;
  label: string;
  icon: ReactNode;
  /** 行尾的计数徽标（如未读数） */
  badge?: number | undefined;
}

const icon = (path: string) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={path} />
  </svg>
);

/** 会话图标：Cindy 用「列表」意象 */
const SESSIONS_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="4" y="4" width="8" height="8" rx="1.6" />
    <path d="M6 1.8v2.2M10 1.8v2.2M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2" />
  </svg>
);

export const NEW_CHAT_ICON = icon('M8 3.2v9.6M3.2 8h9.6');
const SEARCH_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden
  >
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.4 10.4l3 3" />
  </svg>
);

export const SIDEBAR_ICON = {
  newChat: NEW_CHAT_ICON,
  search: SEARCH_ICON,
  sessions: SESSIONS_ICON,
};

export interface SidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  busySessions: Set<string>;
  archivedCount: number;
  dark: boolean;
  isMock: boolean;
  /** 当前侧栏视图；后期有多个视图时切换 */
  view: SidebarView;
  onNewSession: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenArchived: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onToggleOrca: () => void;
  orcaOpen: boolean;
  workerCount: number;
  /** 其中正在跑的；侧栏用「2 跑」而不是总数，一眼看出是否还有活在干 */
  workerRunning: number;
  /** 跨会话 worker 总览：leadSessionId → workers */
  workersByLead: Record<string, UiWorker[]>;
  /** 折叠态（窄屏或用户手动收起） */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    sessions,
    activeId,
    busySessions,
    archivedCount,
    dark,
    isMock,
    view,
    onCreate,
    onSelect,
    onRename,
    onPin,
    onArchive,
    onDelete,
    onOpenArchived,
    onOpenSettings,
    onToggleTheme,
    onToggleOrca,
    orcaOpen,
    workerCount,
    workerRunning,
    workersByLead,
    collapsed,
    onToggleCollapsed,
  } = props;

  // worker 不进主列表 —— 它们属于 Lead，在右侧协同面板里
  const visible = sessions.filter((s) => s.orcaRole !== 'worker');

  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed" data-testid="sidebar">
        <div className="chrome">
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleCollapsed}
            title="展开侧栏"
            data-testid="sidebar-expand"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M6 2.5v11" />
            </svg>
          </button>
        </div>
        <nav className="rail">
          <button type="button" className="icon-btn" onClick={onCreate} title="新会话">
            <span className="rail-icon">{NEW_CHAT_ICON}</span>
          </button>
          <button type="button" className="icon-btn on" title="会话">
            <span className="rail-icon">{SESSIONS_ICON}</span>
          </button>
          <button type="button" className="icon-btn" onClick={onOpenSettings} title="设置">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
            </svg>
          </button>
        </nav>
        <div className="rail-spacer" />
        <button
          type="button"
          className="rail-avatar"
          onClick={onOpenSettings}
          title="Juno"
        >
          J
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" data-testid="sidebar">
      {/* 46px 顶栏：与 Cindy 一致（它的注释写明红绿灯心 y=23 同轴）。
          右侧留出窗口控制区，避免拖拽区域被按钮挡住。 */}
      <div className="chrome" style={{ WebkitAppRegion: 'drag' } as never}>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleCollapsed}
          title="收起侧栏"
          data-testid="sidebar-collapse"
          style={{ WebkitAppRegion: 'no-drag' } as never}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M6 2.5v11" />
          </svg>
        </button>
        {isMock && <span className="badge">预览模式</span>}
      </div>

      {/* 导航行：新建固定在第一，其余按当前视图高亮。
          后期「插件 / 伙伴 / 自动化」加进来时，各自一行、同一套样式。 */}
      <nav className="nav" data-testid="sidebar-nav">
        <button
          type="button"
          className="nav-row"
          onClick={onCreate}
          data-testid="nav-new"
        >
          <span className="nav-ico">{NEW_CHAT_ICON}</span>
          新建
        </button>
        <button
          type="button"
          className={`nav-row${view === 'sessions' ? ' active' : ''}`}
          data-testid="nav-sessions"
          data-active={view === 'sessions' ? '1' : '0'}
        >
          <span className="nav-ico">{SESSIONS_ICON}</span>
          会话
        </button>
        {/* 协同是「开/关面板」的开关，不是导航位置 ——
            所以用轻量的 pressed 态，不占深色胶囊（那是「你在这里」的语义） */}
        <button
          type="button"
          className={`nav-row${orcaOpen ? ' is-open' : ''}`}
          onClick={onToggleOrca}
          data-testid="orca-toggle"
          data-active={orcaOpen ? '1' : '0'}
          aria-pressed={orcaOpen}
        >
          <span className="nav-ico">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="4.2" r="2.2" />
              <circle cx="4" cy="11.6" r="2.2" />
              <circle cx="12" cy="11.6" r="2.2" />
              <path d="M8 6.4v2.2M6.4 10l-1 .8M9.6 10l1 .8" />
            </svg>
          </span>
          协同
          {workerRunning > 0 ? (
            <span className="nav-count running" data-testid="nav-worker-running">
              {workerRunning} 跑
            </span>
          ) : (
            workerCount > 0 && <span className="nav-count">{workerCount}</span>
          )}
        </button>
        <button type="button" className="nav-row" data-testid="nav-search">
          <span className="nav-ico">{SEARCH_ICON}</span>
          搜索
        </button>
      </nav>

      <div className="section-head">
        <span>最近</span>
        {archivedCount > 0 && (
          <button
            type="button"
            className="link-btn"
            onClick={onOpenArchived}
            data-testid="archived-entry"
            title="查看并恢复已归档的会话"
          >
            已归档 {archivedCount}
          </button>
        )}
      </div>

      <nav className="session-list" data-testid="session-list">
        {visible.map((s) => (
          <SessionItem
            key={s.id}
            session={s}
            active={s.id === activeId}
            busy={busySessions.has(s.id)}
            workersRunning={(workersByLead[s.id] ?? []).filter((w) => w.status === 'running').length}
            onSelect={() => onSelect(s.id)}
            onRename={(title) => onRename(s.id, title)}
            onPin={(pinned) => onPin(s.id, pinned)}
            onArchive={() => onArchive(s.id)}
            onDelete={() => onDelete(s.id)}
          />
        ))}
      </nav>

      {/* 底部用户卡：Cindy 是圆角卡片，不是一行裸文字 */}
      <button
        type="button"
        className="usercard"
        onClick={onOpenSettings}
        data-testid="usercard"
        title="设置（模型、密钥、审批策略）"
      >
        <span className="usercard-avatar">J</span>
        <span className="usercard-text">
          <span className="usercard-name">Juno</span>
          <span className="usercard-sub">本地 · 设置</span>
        </span>
        <span
          className="usercard-theme"
          role="button"
          tabIndex={0}
          title={dark ? '切换到浅色' : '切换到深色'}
          data-testid="theme-toggle"
          onClick={(e) => {
            // 卡片本身是「打开设置」，这里只切主题，别冒泡
            e.stopPropagation();
            onToggleTheme();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              onToggleTheme();
            }
          }}
        >
          {dark ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="8" r="3" />
              <path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M13.5 9.6A6 6 0 016.4 2.5a6 6 0 107.1 7.1z" />
            </svg>
          )}
        </span>
      </button>
    </aside>
  );
}
