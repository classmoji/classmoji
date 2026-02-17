import { Avatar, Tooltip } from 'antd';
import { Link, useParams, useLocation, useRouteLoaderData } from 'react-router';
import { useEffect } from 'react';
import { IconLayoutSidebarLeftCollapse, IconFileText } from '@tabler/icons-react';
import useLocalStorageState from 'use-local-storage-state';
import { Logo } from '@classmoji/ui-components';
import { ProTierFeature, RequireRole, RecentViewers } from '~/components';
import { useRoleSettings, useSubscription, useRole } from '~/hooks';
import { routes, routeCategories, DEMO_ORG_ID } from '~/constants';
import OrgSelect from './OrgSelect';
import useStore from '~/store';
import tokenImage from '~/assets/images/token.png';
import githubLogo from '~/assets/images/github_logo.svg';
import ProfileDropdown from '../../features/profile/ProfileDropdown';

const CommonLayout = ({
  children,
  menuPages = [],
  recentViewers = [],
  groupViewersByRole = false,
  pagesUrl = 'http://localhost:7100',
}) => {
  const [collapsed, setCollapsed] = useLocalStorageState('classmoji-collapsed', {
    defaultValue: false,
  });
  const { classroom } = useStore(state => state);
  const params = useParams();

  const location = useLocation();
  const { pathname } = location;
  const { role } = useRole();
  const roleSettings = useRoleSettings();
  const { user, memberships, aiAgentAvailable } = useRouteLoaderData('root');
  const { isProTier } = useSubscription();
  const { tokenBalance } = useStore(state => state);

  useEffect(() => {
    const handle = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        setCollapsed(!collapsed);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [collapsed, setCollapsed]);

  const siderWidth = collapsed ? 64 : 200;

  const TokenSection = () => (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Available Tokens</span>
      <div className="flex items-center gap-2 bg-primary-50 dark:bg-primary-900/20 rounded-full px-3 py-1 shadow-xs border border-primary-200 dark:border-primary-800/50">
        <img src={tokenImage} alt="token" className="h-5 w-5" />
        <span className="text-lg font-bold text-primary-900 dark:text-primary-400">
          {tokenBalance}
        </span>
      </div>
    </div>
  );

  const renderNavItem = (item, key) => {
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
          to={`${roleSettings?.path}/${params.class}${item.link}`}
          prefetch={item.label === 'Dashboard' ? 'render' : 'intent'}
          className={`
            group flex items-center gap-3 rounded-lg transition-all duration-150
            ${collapsed ? 'justify-center p-3 mx-2' : 'px-3 py-[7px] mx-2'}
            ${
              active
                ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 font-semibold'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
            }
          `}
          data-active={active || undefined}
        >
          {collapsed ? (
            <Tooltip title={item.label} placement="right">
              <div className="flex flex-col items-center">
                <item.icon
                  size={20}
                  strokeWidth={1.75}
                  className={active ? 'text-primary-700 dark:text-primary-400' : ''}
                />
                {isDemoClassroom && item.isProTier && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">Pro</span>
                )}
              </div>
            </Tooltip>
          ) : (
            <>
              <item.icon
                size={20}
                strokeWidth={1.75}
                className={`shrink-0 ${active ? 'text-primary-700 dark:text-primary-400' : ''}`}
              />
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
  const hasAccessToItem = item => {
    if (!item) return false;
    if (!item.roles || !item.roles.includes(role)) return false;

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

    const menuPageItems = menuPages.map(page => {
      return (
        <Link
          key={page.id}
          to={`${roleSettings?.path}/${params.class}/pages/${page.id}`}
          className={`
            group flex items-center gap-3 rounded-lg transition-all duration-150 w-full
            ${collapsed ? 'justify-center p-3 mx-2' : 'px-3 py-[7px] mx-2'}
            text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800
          `}
        >
          {collapsed ? (
            <Tooltip title={page.title} placement="right">
              <IconFileText
                size={20}
                strokeWidth={1.75}
              />
            </Tooltip>
          ) : (
            <>
              <IconFileText
                size={20}
                strokeWidth={1.75}
                className="shrink-0"
              />
              <span className="flex-1 truncate">{page.title}</span>
            </>
          )}
        </Link>
      );
    });

    return (
      <div key="menu-pages" className={collapsed ? '' : 'pt-5'}>
        {!collapsed && (
          <div className="px-4 mb-3">
            <h4 className="text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
              Pages
            </h4>
          </div>
        )}
        <div className="space-y-0.5">{menuPageItems}</div>
      </div>
    );
  };

  const tabs = [
    // Dashboard (uncategorized)
    renderNavItem(routes.dashboard, 'dashboard'),

    // Calendar (directly under dashboard)
    renderNavItem(routes.calendar, 'calendar'),

    // Render categorized sections
    ...Object.entries(routeCategories).map(([categoryKey, category]) => {
      // First filter to only items the user has access to
      const accessibleItems = category.items
        .map(routeKey => routes[routeKey])
        .filter(hasAccessToItem);

      // If no accessible items, don't render the category at all
      if (accessibleItems.length === 0) return null;

      const categoryItems = accessibleItems.map((item, index) =>
        renderNavItem(item, `${categoryKey}-${index}`)
      );

      return (
        <div key={categoryKey} className={collapsed ? '' : 'pt-5'}>
          {/* Category Header - only show when expanded */}
          {!collapsed && (
            <div className="px-4 mb-3">
              <h4 className="text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                {category.label}
              </h4>
            </div>
          )}
          <div className="space-y-0.5">{categoryItems}</div>
        </div>
      );
    }),

    // Add dynamic menu pages after Assessment category (for students only)
    renderMenuPages(),
  ];

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      {/* Fixed Sidebar */}
      <div
        className="fixed top-0 left-0 h-full bg-lightGray dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 z-30 transition-all duration-300 ease-in-out flex flex-col"
        style={{ width: siderWidth }}
      >
        {/* Sidebar Header */}
        <div
          className={`flex items-center ${collapsed ? 'justify-center' : 'justify-start'} h-[53px] px-4 py-3 border-b border-gray-200 dark:border-gray-800`}
        >
          {collapsed ? <Logo size={32} variant="icon" /> : <Logo size={32} variant="full" />}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-2">
          <div className="space-y-0.5">{tabs}</div>
        </nav>

        {/* User Profile Section */}
        <div className="p-3 border-t border-gray-100 dark:border-gray-800">
          <ProfileDropdown placement="topRight">
            <div
              className={`
                flex items-center gap-3 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800
                transition-colors cursor-pointer
                ${collapsed ? 'justify-center' : ''}
              `}
            >
              <Avatar
                src={user?.avatar_url}
                size={32}
                className="bg-gray-100 dark:bg-gray-800 shrink-0"
                shape="circle"
              />
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                    {user?.name}
                  </p>
                  <p className="text-gray-500 dark:text-gray-400 text-xs truncate">
                    @{user?.login}
                  </p>
                </div>
              )}
            </div>
          </ProfileDropdown>
        </div>
      </div>

      {/* Main Content Area */}
      <div
        className="flex-1 flex flex-col transition-all duration-300 ease-in-out min-w-0"
        style={{ marginLeft: siderWidth }}
      >
        {/* Fixed Header */}
        <div
          className="fixed right-0 h-[53px] bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 z-20"
          style={{
            marginLeft: siderWidth,
            width: `calc(100% - ${siderWidth}px)`,
            transition: 'margin-left 300ms ease-in-out, width 300ms ease-in-out',
          }}
        >
          <div className="flex justify-between items-center px-1 h-full">
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <IconLayoutSidebarLeftCollapse
                size={20}
                className={`text-gray-700 dark:text-gray-300 transition-all duration-300 ${
                  collapsed ? 'rotate-180' : ''
                }`}
              />
            </button>
            <div className="flex items-center gap-4">
              {recentViewers?.length > 0 && (
                <>
                  <RecentViewers viewers={recentViewers} groupByRole={groupViewersByRole} />
                  <div className="h-6 w-px bg-gray-200 dark:bg-gray-700" />
                </>
              )}
              <ProTierFeature>
                <RequireRole roles={['STUDENT']}>
                  <>
                    <TokenSection />
                    <div className="h-6 w-px bg-gray-200 dark:bg-gray-700" />
                  </>
                </RequireRole>
              </ProTierFeature>
              <div className="flex items-center gap-2">
                <Tooltip title="View on GitHub">
                  <button
                    className="p-2 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors border border-gray-200 dark:border-gray-700 hover:border-primary-300 dark:hover:border-primary-800 cursor-pointer"
                    onClick={() =>
                      window.open(
                        `https://github.com/orgs/${classroom?.git_organization?.login}/repositories`,
                        '_blank'
                      )
                    }
                  >
                    <img
                      src={githubLogo}
                      alt="GitHub"
                      className="w-[18px] h-[18px]"
                    />
                  </button>
                </Tooltip>
                <div className="h-6 w-px bg-gray-200 dark:bg-gray-700" />
                <OrgSelect memberships={memberships} />
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 bg-white dark:bg-gray-900 pt-11 overflow-auto relative min-w-0">
          <div className={pathname.includes('/pages/') ? 'min-h-full' : 'px-8 py-6 min-h-full'}>
            {children}
          </div>
        </div>
      </div>

      {/* Mobile Overlay */}
      {!collapsed && (
        <button
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setCollapsed(true)}
        />
      )}
    </div>
  );
};

export default CommonLayout;
