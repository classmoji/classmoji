import { Avatar, Tooltip } from 'antd';
import { Link, useParams, useLocation, useRouteLoaderData } from 'react-router';
import { useEffect, useState } from 'react';
import { IconFileText, IconMenu2, IconLogout, IconApple } from '@tabler/icons-react';
import { signOut } from '@classmoji/auth/client';
import useLocalStorageState from 'use-local-storage-state';
import { Logo, CalloutSlot } from '@classmoji/ui-components';
import { ProTierFeature, RequireRole, RecentViewers } from '~/components';
import { useRoleSettings, useSubscription, useRole, useDarkMode } from '~/hooks';
import { routes, routeCategories, DEMO_ORG_ID, getThemeByKey } from '~/constants';
import OrgSelect from './OrgSelect';
import useStore from '~/store';
import tokenImage from '~/assets/images/token.png';
import githubLogo from '~/assets/images/github_logo.svg';
import ProfileDropdown from '../../features/profile/ProfileDropdown';
import type { AppUser, MembershipWithOrganization } from '~/types';

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

interface CommonLayoutProps {
  children: React.ReactNode;
  menuPages?: MenuPage[];
  recentViewers?: Viewer[];
  groupViewersByRole?: boolean;
  pagesUrl?: string;
}

const CommonLayout = ({
  children,
  menuPages = [],
  recentViewers = [],
  groupViewersByRole = false,
  pagesUrl: _pagesUrl = 'http://localhost:7100',
}: CommonLayoutProps) => {
  const [collapsed, setCollapsed] = useLocalStorageState('classmoji-collapsed', {
    defaultValue: false,
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const { classroom } = useStore();
  const params = useParams();

  const location = useLocation();
  const { pathname } = location;
  const { role } = useRole();
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
  const setAskMojiOpen = useStore(s => s.setAskMojiOpen);
  const { isDarkMode, background: tweaksBackground } = useDarkMode();
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
      <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Available Tokens</span>
      <div className="flex items-center gap-1.5">
        <img src={tokenImage} alt="token" className="h-4 w-4" />
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {tokenBalance}
        </span>
      </div>
    </div>
  );

  const renderNavItem = (item: NavItem, key: string) => {
    const to = `${roleSettings?.path}/${params.class}${item.link}`;
    const active =
      (pathname.includes(item.link) && !pathname.includes('settings')) ||
      (item.link.includes('setting') && pathname.includes('settings'));

    const isDemoClassroom = Number(classroom?.id) === DEMO_ORG_ID;

    if (item.isProTier && !isProTier && isDemoClassroom === false) return null;
    if (item.link === '/quizzes' && !isProTier && isDemoClassroom === false) return null;
    if (item.link === '/quizzes' && classroom?.settings?.quizzes_enabled === false) return null;
    if (item.link === '/quizzes' && !aiAgentAvailable) return null;

    // Hide slides if disabled in classroom settings
    if (item.link === '/slides' && classroom?.settings?.slides_enabled === false) return null;

    return (
      <RequireRole roles={item.roles} key={key}>
        <Link
          to={to}
          prefetch={item.label === 'Dashboard' ? 'render' : 'intent'}
          className={`
            group flex items-center gap-2.5 rounded-md transition-colors duration-150
            ${collapsed ? 'justify-center p-2 mx-1.5' : 'px-2 py-1.5 mx-1.5'}
            ${
              active
                ? ''
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/70 dark:hover:bg-neutral-800/60'
            }
          `}
          style={
            active
              ? { backgroundColor: 'var(--accent-soft)', color: 'var(--accent-ink)' }
              : undefined
          }
          data-active={active || undefined}
        >
          {collapsed ? (
            <Tooltip title={item.label} placement="right">
              <div className="flex flex-col items-center">
                <item.icon size={20} strokeWidth={1.75} />
                {isDemoClassroom && item.isProTier && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">Pro</span>
                )}
              </div>
            </Tooltip>
          ) : (
            <>
              <item.icon size={20} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1">{item.label}</span>
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
    if (item.isProTier && !isProTier && !isDemoClassroom) return false;
    if (item.link === '/quizzes' && !isProTier && !isDemoClassroom) return false;
    if (item.link === '/quizzes' && classroom?.settings?.quizzes_enabled === false) return false;
    if (item.link === '/quizzes' && !aiAgentAvailable) return false;

    return true;
  };

  // Render dynamic menu pages for students and assistants
  const renderMenuPages = () => {
    if (!menuPages || menuPages.length === 0) return null;
    if (role !== 'STUDENT' && role !== 'ASSISTANT') return null;

    const menuPageItems = menuPages.map((page: MenuPage) => {
      return (
        <Link
          key={page.id}
          to={`${roleSettings?.path}/${params.class}/pages/${page.id}`}
          className={`
            group flex items-center gap-2.5 rounded-md transition-colors duration-150 w-full
            ${collapsed ? 'justify-center p-2 mx-1.5' : 'px-2 py-1.5 mx-1.5'}
            text-gray-700 dark:text-gray-300 hover:bg-gray-100/70 dark:hover:bg-neutral-800/60
          `}
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
      <div key="menu-pages" className={collapsed ? 'pt-3' : 'pt-4'}>
        <hr className="mx-4 mb-3 border-t border-gray-200 dark:border-gray-700" />
        <div className="space-y-1">{menuPageItems}</div>
      </div>
    );
  };

  const renderAskMoji = () => {
    if (!askMojiEnabled) return null;
    if (role === 'OWNER') return null;

    const baseClasses = `group flex items-center gap-2.5 rounded-md transition-colors duration-150 w-full text-gray-700 dark:text-gray-300 hover:bg-gray-100/70 dark:hover:bg-neutral-800/60 ${
      collapsed ? 'justify-center p-2 mx-1.5' : 'px-2 py-1.5 mx-1.5'
    }`;

    return (
      <button
        key="ask-moji"
        type="button"
        onClick={() => setAskMojiOpen(true)}
        className={baseClasses}
      >
        {collapsed ? (
          <Tooltip title="Ask Moji" placement="right">
            <IconApple size={20} strokeWidth={1.75} />
          </Tooltip>
        ) : (
          <>
            <IconApple size={20} strokeWidth={1.75} className="shrink-0" />
            <div className="flex-1 flex flex-col text-left leading-tight">
              <span>Ask Moji</span>
              <span className="text-xs text-gray-400 dark:text-gray-500">Course Assistant</span>
            </div>
          </>
        )}
      </button>
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

      return (
        <div key={categoryKey} className={collapsed ? 'pt-3' : 'pt-4'}>
          <hr className="mx-4 mb-3 border-t border-gray-200 dark:border-gray-700" />
          <div className="space-y-1">{categoryItems}</div>
        </div>
      );
    }),

    // Add dynamic menu pages after Assessment category (for students only)
    renderMenuPages(),
  ];

  return (
    <div
      className="flex h-screen p-2"
      style={{
        backgroundColor: tweaksBgActive ? 'var(--paper)' : themeBackground,
        backgroundImage: tweaksBgActive
          ? 'radial-gradient(1200px 800px at 85% -10%, var(--bg-stop-1) 0%, transparent 60%), radial-gradient(900px 700px at -10% 110%, var(--bg-stop-2) 0%, transparent 55%), linear-gradient(175deg, var(--bg-stop-3a) 0%, var(--bg-stop-3b) 55%, var(--bg-stop-3c) 100%)'
          : undefined,
      }}
    >
      {/* Floating Sidebar */}
      <div
        data-cm-sidebar
        className={`fixed top-7 left-5 bottom-7 ${
          tweaksBgActive ? '' : 'bg-sidebar'
        } rounded-2xl ring-1 ring-stone-200 dark:ring-neutral-800 z-30 transition-transform duration-300 ease-in-out flex flex-col overflow-hidden lg:translate-x-0 ${
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
          <Link to="/select-organization" className="flex items-center">
            {collapsed ? (
              <Logo size={32} variant="icon" theme={isDarkMode ? 'dark' : 'light'} />
            ) : (
              <Logo size={32} variant="full" theme={isDarkMode ? 'dark' : 'light'} />
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
              className="hidden lg:inline-flex p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
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
                className={collapsed ? 'scale-x-[-1]' : ''}
              >
                <path d="M4 6 L20 6" />
                <path d="M4 12 L13 12" />
                <path d="M16 9 L19 12 L16 15" />
                <path d="M4 18 L20 18" />
              </svg>
            </button>
          </Tooltip>
        </div>

        {/* Class selector */}
        {!collapsed && memberships.length > 0 && (
          <div className="px-3 pb-3 shrink-0">
            <div className="rounded-md border border-stone-200 dark:border-neutral-700 hover:border-stone-300 dark:hover:border-gray-600 transition-colors">
              <OrgSelect memberships={memberships} />
            </div>
          </div>
        )}

        {/* Token chip (student + pro tier) */}
        {!collapsed && (
          <ProTierFeature>
            <RequireRole roles={['STUDENT']}>
              <div className="px-3 pb-3 shrink-0">
                <TokenSection />
              </div>
            </RequireRole>
          </ProTierFeature>
        )}

        {/* Recent viewers */}
        {!collapsed && recentViewers?.length >= 2 && (
          <>
            <div className="mx-4 h-px bg-stone-200 dark:bg-neutral-800 shrink-0" />
            <div className="px-3 pb-3 pt-3 shrink-0">
              <RecentViewers viewers={recentViewers} groupByRole={groupViewersByRole} />
            </div>
          </>
        )}

        {/* Navigation */}
        <div className="mx-4 h-px bg-stone-200 dark:bg-neutral-800 shrink-0" />
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2">
          <div className="space-y-1">{tabs}</div>
        </nav>

        {/* Bottom row: profile + GitHub + collapse */}
        <div className="mx-4 h-px bg-stone-200 dark:bg-neutral-800 shrink-0" />
        <div
          className={`px-2 py-2 shrink-0 flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}
        >
          <ProfileDropdown placement="topLeft">
            <button
              type="button"
              className={`flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors text-left min-w-0 ${collapsed ? 'justify-center' : 'flex-1'}`}
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
                  <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate leading-tight">
                    {user?.name}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 capitalize truncate leading-tight">
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
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors shrink-0"
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
          <Tooltip title="Log out">
            <button
              type="button"
              aria-label="Log out"
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0"
              onClick={async () => {
                await signOut();
                window.location.href = window.location.origin;
              }}
            >
              <IconLogout size={18} strokeWidth={1.75} />
            </button>
          </Tooltip>
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
            className="fixed top-4 left-4 z-40 p-1 lg:hidden"
          >
            <IconMenu2 size={24} className="text-gray-800 dark:text-gray-200" strokeWidth={1.75} />
          </button>
        )}

        {/* Content area — bare canvas on dashboard, floating white card elsewhere */}
        <div
          className={`flex-1 overflow-auto relative min-w-0 ${
            pathname.includes('/dashboard') ||
            pathname.includes('/modules') ||
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
            pathname.match(/\/repositories(\/|$)/)
              ? ''
              : 'bg-panel rounded-2xl ring-1 ring-stone-200 dark:ring-neutral-800'
          }`}
        >
          <div
            className={
              pathname.includes('/pages/') && !pathname.endsWith('/pages/new')
                ? 'min-h-full'
                : 'px-4 pt-14 pb-4 sm:px-6 lg:px-8 lg:pt-6 lg:pb-6 min-h-full'
            }
          >
            <CalloutSlot />
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
