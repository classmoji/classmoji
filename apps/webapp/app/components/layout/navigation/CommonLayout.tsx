import { Avatar, Tooltip } from 'antd';
import { Link, useParams, useLocation, useRouteLoaderData } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { IconFileText, IconMenu2, IconApple, IconSparkles } from '@tabler/icons-react';
import useLocalStorageState from 'use-local-storage-state';
import { Logo } from '@classmoji/ui-components';
import { RequireRole, RecentViewers } from '~/components';
import { useRoleSettings, useSubscription, useRole, useDarkMode } from '~/hooks';
import { routes, routeCategories, DEMO_ORG_ID, getThemeByKey } from '~/constants';
import OrgSelect from './OrgSelect';
import useStore from '~/store';
import tokenImage from '~/assets/images/token.png';
import githubLogo from '~/assets/images/github_logo.svg';
import ProfileDropdown from '../../features/profile/ProfileDropdown';
import { LockedBanner } from '~/components/features/classroom/LockedBanner';
import type { AppUser, MembershipWithOrganization } from '~/types';

// Lean owner navigation. New/imported instructors land in a small core that
// maps to the GitHub-Classroom mental model (roster + repos + grades); the rest
// of the platform stays one click away behind the "Show all features" toggle.
// Other roles (student/assistant) are never reduced. Keyed by `route.link`.
const OWNER_CORE_LINKS = new Set([
  '/dashboard',
  '/repos',
  '/students',
  '/teams',
  '/assistants',
  '/grades',
  '/settings/general',
]);

interface MenuPage {
  id: string;
  title: string;
}

interface Viewer {
  user: { id: string; name?: string | null; login?: string | null; avatar_url?: string | null };
  lastViewedAt: string | Date;
  role?: string | null;
}

interface NavItem {
  link: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  roles: string[];
  isProTier?: boolean;
}

interface NavVisibility {
  showModules?: boolean;
  showPages?: boolean;
  showRepos?: boolean;
}

interface CommonLayoutProps {
  children: React.ReactNode;
  menuPages?: MenuPage[];
  recentViewers?: Viewer[];
  groupViewersByRole?: boolean;
  pagesUrl?: string;
  /**
   * Student-nav visibility, passed fresh from the layout loader. Preferred over
   * the Zustand store so the sidebar reflects a settings change on the next
   * navigation/revalidation rather than depending on the root-loader→store sync.
   */
  navVisibility?: NavVisibility;
}

const CommonLayout = ({
  children,
  menuPages = [],
  recentViewers = [],
  groupViewersByRole = false,
  pagesUrl: _pagesUrl = 'http://localhost:7100',
  navVisibility,
}: CommonLayoutProps) => {
  const [collapsed, setCollapsed] = useLocalStorageState('classmoji-collapsed', {
    defaultValue: false,
  });
  // Owner-only "Show all features" toggle. Defaults to the lean core so a fresh
  // classroom isn't a wall of links; sticky once expanded.
  const [showAllNav, setShowAllNav] = useLocalStorageState('classmoji-nav-show-all', {
    defaultValue: false,
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const { classroom } = useStore();
  const params = useParams();

  const location = useLocation();
  const { pathname } = location;

  // The page content scrolls inside an inner overflow-auto div, so the
  // window-level <ScrollRestoration/> never resets it and scroll positions
  // bled across nav sections. Reset whenever the section (/role/class/section)
  // changes; deeper segments (nested modals/drawers over a list) keep scroll.
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const sectionKey = pathname.split('/').slice(0, 4).join('/');
  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [sectionKey]);

  const { role } = useRole();
  // Owner viewing the reduced core nav (no "Show all features"). Drives both the
  // item filtering and the flat, divider-less layout for the short list.
  const leanNav = role === 'OWNER' && !showAllNav;
  const roleSettings = useRoleSettings();
  const rootData = useRouteLoaderData('root') as
    | {
        user?: AppUser | null;
        memberships?: MembershipWithOrganization[];
        aiAgentAvailable?: boolean;
      }
    | undefined;
  const { user, memberships = [], aiAgentAvailable = false } = rootData ?? {};
  const { isProTier } = useSubscription();
  const { tokenBalance } = useStore();
  const askMojiEnabled = useStore(s => s.askMojiEnabled);
  const isAskMojiOpen = useStore(s => s.isAskMojiOpen);
  const askMojiActive = useStore(s => s.askMojiActive);
  const setAskMojiOpen = useStore(s => s.setAskMojiOpen);
  const { isDarkMode, background: tweaksBackground } = useDarkMode();

  // Effective student-nav visibility: prefer the fresh value from the layout
  // loader (navVisibility), fall back to the store. Defaults match the schema
  // (modules, pages, repos all on).
  const storeSettings = classroom?.settings as
    | { show_modules?: boolean; show_pages?: boolean; show_repos?: boolean }
    | undefined;
  const showModules = navVisibility?.showModules ?? storeSettings?.show_modules ?? true;
  const showPages = navVisibility?.showPages ?? storeSettings?.show_pages ?? true;
  const showRepos = navVisibility?.showRepos ?? storeSettings?.show_repos ?? true;

  const themeColors = getThemeByKey(classroom?.settings?.theme);
  const themeBackground = isDarkMode ? themeColors.darkBackground : themeColors.background;
  // When a non-default personal background preset is picked, let the preset's
  // paper/sidebar CSS vars drive the shell so the choice is visible.
  const tweaksBgActive = tweaksBackground !== 'default';

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        setCollapsed(!collapsed);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [collapsed, setCollapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const siderWidth = collapsed ? 64 : 240;

  const TokenSection = () => (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="text-sm font-medium text-ink-2">Available Tokens</span>
      <div className="flex items-center gap-1.5">
        <img src={tokenImage} alt="token" className="h-4 w-4" />
        <span className="text-sm font-semibold text-ink-0">{tokenBalance}</span>
      </div>
    </div>
  );

  const renderNavItem = (item: NavItem, key: string) => {
    const to = `${roleSettings?.path}/${params.class}${item.link}`;
    const active =
      (pathname.includes(item.link) && !pathname.includes('settings')) ||
      (item.link.includes('setting') && pathname.includes('settings'));

    const isDemoClassroom = Number(classroom?.id) === DEMO_ORG_ID;

    // Lean owner nav: until "Show all features" is on, the OWNER sees only the
    // core set. Other roles keep their full nav.
    if (leanNav && !OWNER_CORE_LINKS.has(item.link)) return null;

    if (item.isProTier && !isProTier && isDemoClassroom === false) return null;
    if (item.link === '/quizzes' && !isProTier && isDemoClassroom === false) return null;
    if (item.link === '/quizzes' && classroom?.settings?.quizzes_enabled === false) return null;
    if (item.link === '/quizzes' && !aiAgentAvailable) return null;

    // Hide slides if disabled in classroom settings
    if (item.link === '/slides' && classroom?.settings?.slides_enabled === false) return null;

    // Student navigation visibility toggles. OWNER always sees these to manage
    // them; students/assistants only when the instructor enables them.
    if (item.link === '/modules' && role !== 'OWNER' && !showModules) return null;
    if (item.link === '/repos' && role !== 'OWNER' && !showRepos) return null;

    // Students see the repositories section framed as "Modules".
    const displayLabel = item.link === '/repos' && role === 'STUDENT' ? 'Modules' : item.label;

    return (
      <RequireRole roles={item.roles} key={key}>
        <Link
          to={to}
          prefetch={item.label === 'Dashboard' ? 'render' : 'intent'}
          className={`
            group flex items-center gap-2.5 rounded-md transition-colors duration-150
            ${collapsed ? 'justify-center p-2 mx-1.5' : 'px-2 py-1.5 mx-1.5'}
            ${active ? '' : 'hover:bg-nav-hover'}
          `}
          style={{
            color: active ? 'var(--ink-0)' : 'var(--ink-1)',
            ...(active ? { backgroundColor: 'var(--accent-soft)' } : {}),
          }}
          data-active={active || undefined}
          data-tour-nav={item.link}
        >
          {collapsed ? (
            <Tooltip title={displayLabel} placement="right">
              <div className="flex flex-col items-center">
                <item.icon size={20} strokeWidth={1.75} />
                {isDemoClassroom && item.isProTier && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Pro</span>
                )}
              </div>
            </Tooltip>
          ) : (
            <>
              <item.icon size={20} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1">{displayLabel}</span>
              {isDemoClassroom && item.isProTier && (
                <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 rounded-sm">
                  Pro
                </span>
              )}
            </>
          )}
        </Link>
      </RequireRole>
    );
  };

  // Helper to check if user has access to a route item
  const hasAccessToItem = (item: NavItem) => {
    if (!item) return false;
    if (!item.roles || !role || !item.roles.includes(role)) return false;

    const isDemoClassroom = Number(classroom?.id) === DEMO_ORG_ID;
    // Lean owner nav (mirror of renderNavItem) so empty categories collapse.
    if (leanNav && !OWNER_CORE_LINKS.has(item.link)) return false;
    if (item.isProTier && !isProTier && !isDemoClassroom) return false;
    if (item.link === '/quizzes' && !isProTier && !isDemoClassroom) return false;
    if (item.link === '/quizzes' && classroom?.settings?.quizzes_enabled === false) return false;
    if (item.link === '/quizzes' && !aiAgentAvailable) return false;

    // Student navigation visibility toggles (OWNER always retains access).
    if (item.link === '/modules' && role !== 'OWNER' && !showModules) return false;
    if (item.link === '/repos' && role !== 'OWNER' && !showRepos) return false;

    return true;
  };

  // Render dynamic menu pages for students and assistants
  const renderMenuPages = () => {
    if (!menuPages || menuPages.length === 0) return null;
    if (role !== 'STUDENT' && role !== 'ASSISTANT') return null;
    // Instructors can hide student-facing pages from the sidebar.
    if (!showPages) return null;

    const menuPageItems = menuPages.map((page: MenuPage) => {
      return (
        <Link
          key={page.id}
          to={`${roleSettings?.path}/${params.class}/pages/${page.id}`}
          className={`
            group flex items-center gap-2.5 rounded-md transition-colors duration-150 w-full
            ${collapsed ? 'justify-center p-2 mx-1.5' : 'px-2 py-1.5 mx-1.5'}
            hover:bg-gray-100/70 dark:hover:bg-neutral-800/60
          `}
          style={{ color: isDarkMode ? '#d1d5db' : '#374151' }}
        >
          {collapsed ? (
            <Tooltip title={page.title} placement="right">
              <IconFileText size={20} strokeWidth={1.75} />
            </Tooltip>
          ) : (
            <>
              <IconFileText size={20} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1 truncate">{page.title}</span>
            </>
          )}
        </Link>
      );
    });

    return (
      <div key="menu-pages" className={collapsed ? 'pt-3' : 'pt-5'}>
        {!collapsed && (
          <div className="px-3.5 mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4 select-none">
            Pages
          </div>
        )}
        <div className="space-y-0.5">{menuPageItems}</div>
      </div>
    );
  };

  const renderAskMoji = () => {
    if (!askMojiEnabled) return null;

    const baseClasses = `group flex items-center gap-2.5 rounded-md transition-colors duration-150 ${
      collapsed
        ? 'justify-center p-2 mx-1.5 w-[calc(100%-12px)]'
        : 'px-2 py-1.5 mx-1.5 w-[calc(100%-12px)] text-left'
    } ${isAskMojiOpen ? '' : 'hover:bg-nav-hover'}`;

    return (
      <button
        key="ask-moji"
        type="button"
        data-askmoji-trigger
        onClick={() => setAskMojiOpen(!isAskMojiOpen)}
        className={baseClasses}
        style={{
          color: isAskMojiOpen ? 'var(--ink-0)' : 'var(--ink-1)',
          ...(isAskMojiOpen ? { backgroundColor: 'var(--nav-hover)' } : {}),
        }}
      >
        {collapsed ? (
          <Tooltip title="Ask Moji" placement="right">
            <div className="relative">
              <IconApple size={20} strokeWidth={1.75} />
              {askMojiActive && (
                <span
                  className="absolute -right-1 -top-1 rounded-full"
                  style={{ width: 6, height: 6, background: '#5DCAA5' }}
                />
              )}
            </div>
          </Tooltip>
        ) : (
          <>
            <IconApple size={20} strokeWidth={1.75} className="shrink-0" />
            <div className="flex-1 flex flex-col text-left leading-tight">
              <span className="flex items-center gap-1.5">
                Ask Moji
                {askMojiActive && (
                  <span
                    className="rounded-full"
                    style={{ width: 5, height: 5, background: '#5DCAA5' }}
                  />
                )}
              </span>
              <span className="text-xs text-ink-4">Course Assistant</span>
            </div>
          </>
        )}
      </button>
    );
  };

  // Owner-only reveal at the foot of the nav. Lives next to the items it
  // controls so a missing feature is discoverable here, not buried in Settings.
  const renderShowAllToggle = () => {
    if (role !== 'OWNER') return null;

    const label = showAllNav ? 'Show fewer' : 'Show all features';

    return (
      <div key="show-all-toggle" className={leanNav ? '' : collapsed ? 'pt-3' : 'pt-4'}>
        <button
          type="button"
          onClick={() => setShowAllNav(!showAllNav)}
          aria-pressed={showAllNav}
          className={`group flex items-center gap-2.5 rounded-md transition-colors duration-150 w-[calc(100%-12px)] ${
            collapsed ? 'justify-center p-2 mx-1.5' : 'px-2 py-1.5 mx-1.5 text-left'
          } hover:bg-nav-hover`}
          style={{ color: 'var(--ink-1)' }}
        >
          {collapsed ? (
            <Tooltip title={label} placement="right">
              <IconSparkles size={20} strokeWidth={1.75} />
            </Tooltip>
          ) : (
            <>
              <IconSparkles size={20} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1">{label}</span>
            </>
          )}
        </button>
      </div>
    );
  };

  const tabs = [
    // Dashboard (uncategorized)
    renderNavItem(routes.dashboard, 'dashboard'),

    // Calendar (directly under dashboard)
    renderNavItem(routes.calendar, 'calendar'),

    // Ask Moji — course assistant trigger (rendered when classroom enables it)
    renderAskMoji(),

    // Render categorized sections
    ...Object.entries(routeCategories).map(([categoryKey, category]) => {
      // First filter to only items the user has access to
      const accessibleItems = category.items
        .map(routeKey => (routes as Record<string, (typeof routes)[keyof typeof routes]>)[routeKey])
        .filter(hasAccessToItem);

      // If no accessible items, don't render the category at all
      if (accessibleItems.length === 0) return null;

      const categoryItems = accessibleItems.map((item, index) =>
        renderNavItem(item, `${categoryKey}-${index}`)
      );

      // Lean nav is a short, flat list — skip the section labels/spacing that
      // only make sense when the full set is grouped into sections. Expanded nav
      // groups each category under a small muted label (no full-width rule);
      // collapsed (icon-only) mode has no room for a label, so the extra top
      // spacing alone carries the grouping.
      return (
        <div key={categoryKey} className={leanNav ? '' : collapsed ? 'pt-3' : 'pt-5'}>
          {!leanNav && !collapsed && (
            <div className="px-3.5 mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4 select-none">
              {category.label}
            </div>
          )}
          <div className="space-y-0.5">{categoryItems}</div>
        </div>
      );
    }),

    // Add dynamic menu pages after Assessment category (for students only)
    renderMenuPages(),

    // Owner-only "Show all features" reveal at the foot of the nav
    renderShowAllToggle(),
  ];

  return (
    <div
      className="flex h-screen p-2"
      style={{
        backgroundColor: tweaksBgActive ? 'var(--paper)' : themeBackground,
      }}
    >
      {/* Floating Sidebar */}
      <div
        data-cm-sidebar
        className={`fixed top-0 left-0 bottom-0 lg:top-7 lg:left-5 lg:bottom-7 ${
          tweaksBgActive ? '' : 'bg-sidebar'
        } rounded-none lg:rounded-2xl ring-1 ring-line z-30 transition-transform duration-300 ease-in-out flex flex-col overflow-hidden lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-[110%]'
        }`}
        style={{
          width: siderWidth,
          ...(tweaksBgActive ? { backgroundColor: 'var(--sidebar)' } : {}),
        }}
      >
        {/* Sidebar Header — Logo + collapse toggle */}
        <div
          className={`flex items-center px-4 py-3 shrink-0 ${
            collapsed ? 'flex-col gap-2' : 'justify-between gap-2 h-[53px]'
          }`}
        >
          <Link
            to="/select-organization"
            className="flex items-center text-[#0d0d10] dark:text-white"
          >
            {collapsed ? (
              <Logo size={28} variant="icon" theme="current" />
            ) : (
              <Logo size={28} variant="full" theme="current" />
            )}
          </Link>
          <Tooltip
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            placement={collapsed ? 'right' : 'bottom'}
          >
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden lg:inline-flex p-1.5 rounded-md text-ink-3 hover:text-ink-0 hover:bg-nav-hover transition-colors"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <path d="M9 3L9 21" />
                {collapsed ? <path d="M15 9L18 12L15 15" /> : <path d="M16 9L13 12L16 15" />}
              </svg>
            </button>
          </Tooltip>
        </div>

        {/* Class selector */}
        {!collapsed && memberships.length > 0 && (
          <div className="px-3 pb-3 shrink-0">
            <div className="rounded-md border border-line hover:border-line-2 transition-colors">
              <OrgSelect memberships={memberships} />
            </div>
          </div>
        )}

        {/* Token chip (student + pro tier) */}
        {!collapsed && (
          <RequireRole roles={['STUDENT']}>
            <div className="px-3 pb-3 shrink-0">
              <TokenSection />
            </div>
          </RequireRole>
        )}

        {/* Navigation — the bordered class selector above already separates this
            zone, so no top divider here (the footer keeps its divider). */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-0.5 no-scrollbar">
          <div className="space-y-0.5">{tabs}</div>
        </nav>

        {/* Bottom row: profile + GitHub + collapse */}
        <div className="mx-4 h-px bg-line shrink-0" />
        <div
          className={`px-2 py-2 shrink-0 flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}
        >
          <ProfileDropdown placement="topLeft">
            <button
              type="button"
              className={`flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-nav-hover transition-colors text-left min-w-0 ${collapsed ? 'justify-center' : 'flex-1'}`}
            >
              <Avatar
                src={user?.avatar_url}
                size={32}
                className="bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300 shrink-0 font-semibold"
              >
                {user?.name?.[0]?.toUpperCase() ?? '?'}
              </Avatar>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm text-ink-0 truncate leading-tight">
                    {user?.name}
                  </div>
                  <div className="text-xs text-ink-3 capitalize truncate leading-tight">
                    {role ? role.toLowerCase() : ''}
                  </div>
                </div>
              )}
            </button>
          </ProfileDropdown>
          {classroom?.git_organization?.login && (
            <Tooltip title="View on GitHub">
              <button
                type="button"
                className="p-1.5 rounded-lg hover:bg-nav-hover transition-colors shrink-0"
                onClick={() =>
                  window.open(
                    `https://github.com/orgs/${classroom.git_organization?.login}/repositories`,
                    '_blank'
                  )
                }
              >
                <img src={githubLogo} alt="GitHub" className="w-[18px] h-[18px] dark:invert" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div
        data-cm-main
        className="flex-1 flex flex-col transition-all duration-300 ease-in-out min-w-0 lg:ml-[calc(var(--sider-width)+1.5rem)]"
        style={{ '--sider-width': `${siderWidth}px` } as React.CSSProperties}
      >
        {/* Mobile-only hamburger (when sidebar is closed) */}
        {!mobileOpen && (
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="fixed top-[max(0.75rem,env(safe-area-inset-top))] left-[max(0.75rem,env(safe-area-inset-left))] z-40 p-2 lg:hidden"
          >
            <IconMenu2 size={24} className="text-ink-1" strokeWidth={1.75} />
          </button>
        )}

        {/* Content area — bare canvas on dashboard, floating white card elsewhere */}
        <div
          ref={contentScrollRef}
          // overflow-x-hidden: the page itself must never scroll sideways, so a
          // too-wide child (e.g. a dense table) can't push a page header's
          // action buttons off-screen. Wide tables scroll inside their own card
          // via antd's scroll.x; vertical page scroll stays on this container.
          className={`flex-1 overflow-y-auto overflow-x-hidden relative min-w-0 ${
            pathname.includes('/dashboard') ||
            pathname.includes('/modules') ||
            pathname.includes('/repos') ||
            pathname.includes('/quizzes') ||
            pathname.includes('/calendar') ||
            pathname.includes('/assignments') ||
            pathname.includes('/regrade-requests') ||
            pathname.includes('/settings') ||
            pathname.includes('/students') ||
            pathname.includes('/assistants') ||
            pathname.includes('/tokens') ||
            pathname.includes('/teams') ||
            pathname.includes('/grading') ||
            pathname.includes('/repo-health') ||
            pathname.includes('/submissions/') ||
            pathname.match(/\/slides(\/|$)/) ||
            pathname.match(/\/pages(\/|$)/) ||
            pathname.match(/\/grades(\/|$)/) ||
            pathname.match(/\/gitrepos(\/|$)/)
              ? ''
              : 'bg-panel rounded-2xl ring-1 ring-line'
          }`}
        >
          <div
            className={
              pathname.includes('/pages/') && !pathname.endsWith('/pages/new')
                ? 'min-h-full'
                : 'px-4 pt-14 pb-4 sm:px-6 lg:px-8 lg:pt-6 lg:pb-6 min-h-full'
            }
          >
            {classroom?.status === 'LOCKED' && role !== 'OWNER' && <LockedBanner />}
            {/* Recently-viewed: route-specific, so it lives with the content
                (not the left nav). Rendered in-flow at the top-right above the
                page so it never overlaps a page's header action buttons. */}
            {recentViewers?.length >= 2 && (
              <div className="hidden sm:flex justify-end -mt-1 mb-1">
                <RecentViewers viewers={recentViewers} groupByRole={groupViewersByRole} />
              </div>
            )}
            {children}
          </div>
        </div>
      </div>

      {/* Mobile Overlay */}
      {mobileOpen && (
        <button
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
        />
      )}
    </div>
  );
};

export default CommonLayout;
