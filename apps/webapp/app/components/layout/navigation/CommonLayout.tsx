import { Link, useNavigate, useParams, useLocation, useRouteLoaderData } from 'react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Breadcrumb,
  IconButton,
  Logo,
  IconChevron,
  IconCheck,
  IconPlus,
  IconGithub,
  IconFile,
  IconDocs,
  IconSupport,
} from '@classmoji/ui-components';
import { ProTierFeature, RequireRole, RecentViewers } from '~/components';
import { useRoleSettings, useSubscription, useRole } from '~/hooks';
import { routes, sidebarSections, DEMO_ORG_ID } from '~/constants';
import { roleSettings } from '~/constants/roleSettings';
import useStore from '~/store';
import tokenImage from '~/assets/images/token.png';
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

interface RouteLike {
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

const SIDEBAR_WIDTH = 220;

// Deterministic hue in [0, 360) from a string — used for per-classroom accent.
const hashHue = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 285;
  const str = String(value);
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
};

const getInitials = (name?: string | null, login?: string | null): string => {
  const source = (name && name.trim()) || login || '';
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

// Class pill square — prefers digits in the name (e.g. "67"); falls back to
// the first two letters when there are none (e.g. "Dev" → "DE").
const ClassSquare = ({ klass, size = 24 }: { klass: { name: string }; size?: number }) => {
  const name = klass.name || '';
  const digits = name.replace(/[^0-9]/g, '').slice(0, 2);
  const letters = name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  const label = digits || letters || '??';
  const hue = hashHue(klass.name);
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, Math.round(size / 3.4)),
        background: `linear-gradient(135deg, oklch(80% 0.11 ${hue}), oklch(65% 0.18 ${hue}))`,
        display: 'grid',
        placeItems: 'center',
        color: 'white',
        fontSize: Math.round(size * 0.46),
        fontWeight: 700,
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
};

interface SidebarNavItemProps {
  icon: React.ReactNode;
  label: string;
  to?: string;
  active?: boolean;
  onClick?: () => void;
  badge?: string | number;
  external?: boolean;
}

const SidebarNavItem = ({
  icon,
  label,
  to,
  active,
  onClick,
  badge,
  external,
}: SidebarNavItemProps) => {
  const className = active ? 'active' : '';
  const body = (
    <>
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {badge != null && (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            background: 'var(--violet-soft)',
            color: 'var(--violet-ink)',
            padding: '2px 6px',
            borderRadius: 6,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {badge}
        </span>
      )}
    </>
  );

  if (to && external) {
    return (
      <a href={to} className={className} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  }

  if (to) {
    return (
      <Link to={to} className={className} data-active={active || undefined}>
        {body}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {body}
    </button>
  );
};

interface ClassPillProps {
  classroom: { name: string; slug?: string; subtitle?: string } | null;
  memberships: MembershipWithOrganization[];
  currentMembershipId: string | number | null;
}

const ClassPill = ({ classroom, memberships, currentMembershipId }: ClassPillProps) => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!classroom) return null;

  const displayName = classroom.name || classroom.slug || 'Classroom';
  const subtitle = classroom.subtitle || classroom.slug || '';

  const handleSelect = (m: MembershipWithOrganization) => {
    setOpen(false);
    const settings = (roleSettings as Record<string, { path: string }>)[m.role];
    if (!settings?.path) return;
    const suffix = m.role === 'STUDENT' ? '' : '/dashboard';
    navigate(`${settings.path}/${m.organization.login}${suffix}`);
  };

  const sortedMemberships = [...memberships].sort((a, b) =>
    (a.organization.name || '').localeCompare(b.organization.name || '')
  );

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="class-switch"
        style={{ width: '100%', textAlign: 'left' }}
      >
        <ClassSquare klass={{ name: displayName }} size={24} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <div className="cs-name truncate">{displayName}</div>
          <div className="cs-sub truncate">{subtitle}</div>
        </span>
        <span
          className="cs-chev"
          style={{
            transform: open ? 'rotate(180deg)' : '',
            transition: 'transform 160ms',
            display: 'flex',
          }}
        >
          <IconChevron size={14} />
        </span>
      </button>

      {open && (
        <div
          className="reveal-enter"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-lg)',
            padding: 4,
            zIndex: 40,
          }}
        >
          {sortedMemberships.map(m => {
            const isCurrent = String(m.id) === String(currentMembershipId);
            const orgName = m.organization.name || m.organization.login;
            const term =
              m.organization.term && m.organization.year
                ? `${m.organization.term} ${m.organization.year}`
                : '';
            return (
              <button
                key={m.id}
                type="button"
                className="row-hover"
                onClick={() => handleSelect(m)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  textAlign: 'left',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: 'transparent',
                  border: 'none',
                }}
              >
                <ClassSquare klass={{ name: orgName }} size={20} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-0)' }}
                    className="truncate"
                  >
                    {orgName}
                  </div>
                  {term && (
                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }} className="truncate">
                      {term}
                    </div>
                  )}
                </span>
                {isCurrent && (
                  <span style={{ color: 'var(--ink-2)', display: 'flex' }}>
                    <IconCheck size={14} />
                  </span>
                )}
              </button>
            );
          })}
          <div style={{ borderTop: '1px solid var(--line)', margin: '4px 0' }} />
          <Link
            to="/select-organization"
            className="row-hover"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              color: 'var(--ink-2)',
              borderRadius: 8,
              fontSize: 12.5,
              textDecoration: 'none',
            }}
            onClick={() => setOpen(false)}
          >
            <IconPlus size={14} /> Join classroom
          </Link>
        </div>
      )}
    </div>
  );
};

const CommonLayout = ({
  children,
  menuPages = [],
  recentViewers = [],
  groupViewersByRole = false,
  pagesUrl: _pagesUrl = 'http://localhost:7100',
}: CommonLayoutProps) => {
  const { classroom, membership, tokenBalance } = useStore();
  const params = useParams();
  const location = useLocation();
  const { pathname } = location;
  const { role } = useRole();
  const roleSettingsForRole = useRoleSettings();
  const rootData = useRouteLoaderData('root') as
    | {
        user?: AppUser | null;
        memberships?: MembershipWithOrganization[];
        aiAgentAvailable?: boolean;
      }
    | undefined;
  const { user, memberships = [], aiAgentAvailable = false } = rootData ?? {};
  const { isProTier } = useSubscription();

  const basePath = roleSettingsForRole?.path ?? '';
  const classParam = params.class ?? '';
  const classroomHue = useMemo(
    () => hashHue(classroom?.name || classroom?.login || classroom?.id),
    [classroom?.name, classroom?.login, classroom?.id]
  );
  const classroomDisplaySlug =
    (classroom as { slug?: string } | null | undefined)?.slug || classParam || classroom?.name || '';

  // Access gate — mirrors previous logic.
  const hasAccessToItem = (item: RouteLike | undefined): item is RouteLike => {
    if (!item) return false;
    if (!item.roles || !role || !item.roles.includes(role)) return false;
    const isDemoClassroom = Number(classroom?.id) === DEMO_ORG_ID;
    if (item.isProTier && !isProTier && !isDemoClassroom) return false;
    if (item.link === '/quizzes' && !isProTier && !isDemoClassroom) return false;
    if (item.link === '/quizzes' && classroom?.settings?.quizzes_enabled === false) return false;
    if (item.link === '/quizzes' && !aiAgentAvailable) return false;
    if (item.link === '/slides' && classroom?.settings?.slides_enabled === false) return false;
    return true;
  };

  // First path segment after `/:role/:class` — used for active-link matching.
  const activeSegment = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    return parts[2] ?? '';
  }, [pathname]);

  const renderNavLink = (item: RouteLike, key: string) => {
    const itemSegment = item.link.replace(/^\//, '').split('/')[0];
    const active =
      itemSegment === activeSegment ||
      (itemSegment === 'dashboard' && activeSegment === '');
    const isDemoClassroom = Number(classroom?.id) === DEMO_ORG_ID;
    if (item.isProTier && !isProTier && !isDemoClassroom) return null;
    if (item.link === '/quizzes' && !isProTier && !isDemoClassroom) return null;
    if (item.link === '/quizzes' && classroom?.settings?.quizzes_enabled === false) return null;
    if (item.link === '/quizzes' && !aiAgentAvailable) return null;
    if (item.link === '/slides' && classroom?.settings?.slides_enabled === false) return null;

    const IconComp = item.icon;
    const to = `${basePath}/${classParam}${item.link}`;

    return (
      <RequireRole roles={item.roles} key={key}>
        <SidebarNavItem
          icon={<IconComp size={16} />}
          label={item.label}
          to={to}
          active={active}
        />
      </RequireRole>
    );
  };

  const renderGroup = (keys: readonly string[], prefix: string) => {
    const nodes: React.ReactNode[] = [];
    keys.forEach((k, i) => {
      const item = routes[k];
      if (!hasAccessToItem(item)) return;
      const node = renderNavLink(item, `${prefix}-${i}`);
      if (node) nodes.push(node);
    });
    return nodes;
  };

  const topKeys = role
    ? (sidebarSections.top as Record<string, readonly string[]>)[role] ?? []
    : [];
  const courseworkKeys = role
    ? (sidebarSections.coursework as Record<string, readonly string[]>)[role] ?? []
    : [];
  const referenceKeys = role
    ? (sidebarSections.reference as Record<string, readonly string[]>)[role] ?? []
    : [];

  // Menu pages — for students/assistants, shown below course nav.
  const renderMenuPages = () => {
    if (!menuPages || menuPages.length === 0) return null;
    if (role !== 'STUDENT' && role !== 'ASSISTANT') return null;
    return menuPages.map(page => (
      <SidebarNavItem
        key={page.id}
        icon={<IconFile size={16} />}
        label={page.title}
        to={`${basePath}/${classParam}/pages/${page.id}`}
        active={pathname.includes(`/pages/${page.id}`)}
      />
    ));
  };

  // Trail: derive from pathname segments after `/:role/:class`.
  const trail = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    // parts[0]=role, parts[1]=class, rest are feature segments
    const rest = parts.slice(2);
    if (rest.length === 0) return [] as string[];
    const labels: string[] = [];
    const isIdSegment = (seg: string): boolean =>
      /^[0-9a-f-]{8,}$/i.test(seg) || /^\d+$/.test(seg) || /^[a-z]_[A-Za-z0-9]+$/.test(seg);
    const titlecase = (seg: string): string =>
      seg
        .replace(/-/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    for (const seg of rest) {
      const routeMatch = Object.values(routes).find(r => r.link === `/${seg}`);
      if (routeMatch) {
        labels.push(routeMatch.label);
        continue;
      }
      if (isIdSegment(seg)) continue;
      labels.push(titlecase(seg));
    }
    return labels;
  }, [pathname]);

  const userInitials = getInitials(user?.name, user?.login);
  const userHue = hashHue(user?.id ?? user?.login ?? 'user');

  const handleGithubClick = () => {
    const login = classroom?.git_organization?.login;
    if (!login) return;
    window.open(`https://github.com/orgs/${login}/repositories`, '_blank');
  };

  const TokenSection = () => (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
        Available Tokens
      </span>
      <div className="flex items-center gap-2 bg-primary-50 dark:bg-primary-900/20 rounded-full px-3 py-1 shadow-xs border border-primary-200 dark:border-primary-800/50">
        <img src={tokenImage} alt="token" className="h-5 w-5" />
        <span className="text-lg font-bold text-primary-900 dark:text-primary-400">
          {tokenBalance}
        </span>
      </div>
    </div>
  );

  const topbarAction = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {recentViewers?.length > 0 && (
        <>
          <RecentViewers viewers={recentViewers} groupByRole={groupViewersByRole} />
          <div style={{ height: 20, width: 1, background: 'var(--line)' }} />
        </>
      )}
      <ProTierFeature>
        <RequireRole roles={['STUDENT']}>
          <>
            <TokenSection />
            <div style={{ height: 20, width: 1, background: 'var(--line)' }} />
          </>
        </RequireRole>
      </ProTierFeature>
      {classroom?.git_organization?.login && (
        <IconButton
          label="View on GitHub"
          icon={<IconGithub size={16} />}
          onClick={handleGithubClick}
        />
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-1)' }}>
      {/* Sidebar */}
      <aside
        className="sidebar"
        style={{
          width: SIDEBAR_WIDTH,
          flexShrink: 0,
          height: '100vh',
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 30,
        }}
      >
        {/* Brand */}
        <div className="brand">
          <Link
            to="/select-organization"
            style={{ display: 'flex', alignItems: 'center', textDecoration: 'none', color: 'var(--ink-0)' }}
          >
            <Logo size={26} variant="full" />
          </Link>
        </div>

        {/* User card */}
        <div className="user-card">
          {user?.avatar_url ? (
            <Avatar
              initials={userInitials}
              hue={userHue}
              size={34}
              src={user.avatar_url}
            />
          ) : (
            <span className="av">{userInitials}</span>
          )}
          <span style={{ minWidth: 0, flex: 1 }}>
            <div className="name truncate">{user?.name || user?.login}</div>
            <div className="role" style={{ textTransform: 'capitalize' }}>
              {role ? role.toLowerCase() : 'Member'}
            </div>
          </span>
        </div>

        {/* Class switcher */}
        <ClassPill
          classroom={
            classroom
              ? {
                  name: classroom.name || classroom.login || '',
                  slug: (classroom as { slug?: string }).slug || classroom.login,
                  subtitle:
                    classroom.term && classroom.year
                      ? `${classroom.term} ${classroom.year}`
                      : classroom.login,
                }
              : null
          }
          memberships={memberships}
          currentMembershipId={membership?.id ?? null}
        />

        {/* Scrollable nav area */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {/* Top group */}
          {topKeys.length > 0 && (
            <nav className="nav">{renderGroup(topKeys, 'top')}</nav>
          )}

          {/* Coursework section */}
          {courseworkKeys.length > 0 && (
            <>
              <div className="nav-section">
                <span className="caps">Coursework</span>
              </div>
              <nav className="nav">
                {renderGroup(courseworkKeys, 'coursework')}
                {renderMenuPages()}
              </nav>
            </>
          )}

          {/* Reference section */}
          {referenceKeys.length > 0 && (
            <>
              <div className="nav-section">
                <span className="caps">Reference</span>
              </div>
              <nav className="nav">{renderGroup(referenceKeys, 'reference')}</nav>
            </>
          )}
        </div>

        {/* Footer nav */}
        <div className="sidebar-foot">
          <nav className="nav">
            {renderGroup(sidebarSections.footer, 'footer')}
            <SidebarNavItem
              icon={<IconDocs size={16} />}
              label="Docs"
              to="https://docs.classmoji.dev"
              external
            />
            <SidebarNavItem
              icon={<IconSupport size={16} />}
              label="Support"
              to="mailto:support@classmoji.dev"
              external
            />
          </nav>

          {/* Profile dropdown trigger */}
          <div style={{ paddingTop: 6 }}>
            <ProfileDropdown placement="topRight">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px',
                  borderRadius: 9,
                  cursor: 'pointer',
                }}
                className="row-hover"
              >
                <Avatar
                  initials={userInitials}
                  hue={userHue}
                  size={24}
                  src={user?.avatar_url ?? undefined}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-1)' }}
                    className="truncate"
                  >
                    {user?.login ? `@${user.login}` : user?.name}
                  </div>
                </span>
                <IconChevron size={12} />
              </div>
            </ProfileDropdown>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div
        style={{
          marginLeft: SIDEBAR_WIDTH,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}
      >
        {/* Breadcrumb topbar */}
        <Breadcrumb
          classroomSlug={classroomDisplaySlug}
          classroomHue={classroomHue}
          trail={trail}
          action={topbarAction}
        />

        {/* Content — transparent so body gradient shows through */}
        <main
          className="main flex-1 overflow-auto relative min-w-0"
          style={{ flex: 1, background: 'transparent' }}
        >
          <div className={pathname.includes('/pages/') ? 'min-h-full' : 'px-6 pb-10 min-h-full'}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default CommonLayout;
