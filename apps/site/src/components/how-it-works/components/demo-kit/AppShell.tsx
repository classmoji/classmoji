import React, { type ReactNode } from 'react';
import {
  BotIcon,
  CalendarIcon,
  ChevronDownIcon,
  CircleDollarSignIcon,
  FileTextIcon,
  HashIcon,
  LayersIcon,
  LayoutGridIcon,
  PanelLeftIcon,
  RotateCwIcon,
  UserCheckIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { navGroups, navTop } from '../../data/appNav';
import type { NavId, ShellRole, ShellUser } from '../../types/app';
import { ui } from '../../utils/classes';
import { Avatar } from './Avatar';
import { GithubMark } from './GithubMark';
type AppShellProps = {
  active: NavId;
  role: ShellRole;
  user: ShellUser;
  title: string;
  /** Shown right after the title, e.g. the Repositories page's legend. */
  titleExtra?: ReactNode;
  actions?: ReactNode;
  collapsed?: boolean;
  children: ReactNode;
};
const ICONS: Record<NavId, LucideIcon> = {
  dashboard: LayoutGridIcon,
  calendar: CalendarIcon,
  modules: LayersIcon,
  repositories: FileTextIcon,
  quizzes: BotIcon,
  grades: HashIcon,
  resubmits: RotateCwIcon,
  tokens: CircleDollarSignIcon,
  students: UsersIcon,
  staff: UserCheckIcon,
};

/** Miniature Classmoji app shell: floating sidebar on the left, page title + content on the flat app background. */
export function AppShell({
  active,
  role,
  user,
  title,
  titleExtra,
  actions,
  collapsed = false,
  children,
}: AppShellProps) {
  const groups = navGroups.filter(g => role === 'staff' || !g.staffOnly);
  const renderItem = (item: { id: NavId; label: string }) => {
    const Icon = ICONS[item.id];
    const isActive = item.id === active;
    return (
      <div
        key={item.id}
        aria-current={isActive ? 'page' : undefined}
        className={`flex h-[26px] items-center gap-2 rounded-md text-[12.5px] ${collapsed ? 'w-8 justify-center' : 'px-2'} ${isActive ? `${ui.selected} font-medium ${ui.ink0} dark:text-accent-ink-dark` : ui.ink1}`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </div>
    );
  };
  return (
    <div className={`flex h-full gap-4 p-2 ${ui.app} ${ui.ink0}`}>
      <aside
        aria-label="Classmoji navigation"
        className={`flex shrink-0 flex-col rounded-2xl bg-panel py-2.5 shadow-card ring-1 ring-edge dark:bg-panel-dark dark:ring-edge-dark ${collapsed ? 'w-[52px] items-center px-1.5' : 'w-[172px] px-2.5'}`}
      >
        <div
          className={`flex h-8 items-center ${collapsed ? 'justify-center' : 'justify-between px-1.5'}`}
        >
          <span className="flex items-center gap-1.5 text-[15px] font-extrabold tracking-tight">
            <span aria-hidden>🍎</span>
            {!collapsed && 'classmoji'}
          </span>
          {!collapsed && <PanelLeftIcon className={`h-3.5 w-3.5 ${ui.ink4}`} aria-hidden />}
        </div>

        {!collapsed && (
          <div className="mt-2 flex h-8 items-center justify-between rounded-md border border-line-2 px-2.5 text-[12.5px] font-semibold dark:border-line-2-dark">
            CS52 26F
            <ChevronDownIcon className={`h-3.5 w-3.5 ${ui.ink3}`} aria-hidden />
          </div>
        )}

        <nav className={`mt-2 flex flex-col ${collapsed ? 'items-center' : ''}`}>
          {navTop.map(renderItem)}
          {groups.map(g => (
            <div key={g.label} className={`mt-3 flex flex-col ${collapsed ? 'items-center' : ''}`}>
              {collapsed ? (
                <span className="mb-2 h-px w-5 bg-line dark:bg-line-dark" aria-hidden />
              ) : (
                <p
                  className={`px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] ${ui.ink3}`}
                >
                  {g.label}
                </p>
              )}
              {g.items.map(renderItem)}
            </div>
          ))}
        </nav>

        <div
          className={`mt-auto flex w-full items-center gap-2 border-t pt-2.5 ${ui.divider} ${collapsed ? 'justify-center' : ''}`}
        >
          <Avatar initials={user.initials} />
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[12.5px] font-semibold">{user.name}</p>
                <p className={`truncate text-[11px] ${ui.ink3}`}>@{user.handle}</p>
              </div>
              <GithubMark className={`h-3.5 w-3.5 ${ui.ink0}`} />
            </>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col py-2 pr-2">
        <div className="flex h-8 items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-4">
            <h4 className={`truncate text-[15px] font-semibold ${ui.ink1}`}>{title}</h4>
            {titleExtra}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        <div className="mt-3 min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
