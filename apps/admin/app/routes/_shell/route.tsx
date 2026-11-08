import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLoaderData } from 'react-router';
import { signOut } from '@classmoji/auth/client';
import { COOKIE_DOMAIN } from '@classmoji/auth/secret';
import { IconLogout, IconSearch } from '@tabler/icons-react';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { CommandPalette } from '~/components/CommandPalette';
import type { LoaderFunctionArgs, ShouldRevalidateFunction } from 'react-router';

/**
 * Shell for every admin page: gate + header + tabs + ⌘K.
 *
 * Pathless (`_shell`) so it wraps `/` and `/classrooms` without adding a URL
 * segment. `api.*` and `health` sit outside it deliberately — neither should
 * render chrome.
 *
 * Child loaders re-run `requirePlatformAdmin` rather than trusting this one.
 * Guarding once in a layout is the classic way to leave a data route reachable
 * on its own.
 */

/** The Feedback tab's badge: bug reports without a status, cached a minute per process. */
let badgeCache: { at: number; bugs: number } | null = null;
const BADGE_TTL_MS = 60_000;

const loadBadges = async () => {
  if (badgeCache && Date.now() - badgeCache.at < BADGE_TTL_MS) return badgeCache;
  const bugs = await prisma.feedbackPost.count({
    where: { category: 'BUG', status: null, duplicate_of_id: null },
  });
  badgeCache = { at: Date.now(), bugs };
  return badgeCache;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { user } = await requirePlatformAdmin(request);
  const badges = await loadBadges();
  return {
    admin: { id: user.id, login: user.login, name: user.name },
    webappUrl: process.env.WEBAPP_URL ?? 'http://localhost:3000',
    // Scope for the "View as" return breadcrumb: the session cookie's own
    // resolution, so it reaches the webapp exactly when the session does.
    cookieDomain: COOKIE_DOMAIN,
    badges: { feedback: badges.bugs },
  };
}

/** Badges refresh on navigation between sections, not on every search keystroke. */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (formMethod && formMethod !== 'GET') return defaultShouldRevalidate;
  return currentUrl.pathname !== nextUrl.pathname;
};

const TABS = [
  { to: '/', label: 'Home', end: true },
  { to: '/people', label: 'People', end: false },
  { to: '/classrooms', label: 'Classrooms', end: false },
  { to: '/feedback', label: 'Feedback', end: false, badge: 'feedback' as const },
  { to: '/ops', label: 'Ops', end: false },
];

const BADGE_TITLE = {
  feedback: 'Bug reports without a status',
};

const AdminShell = () => {
  const { admin, webappUrl, badges } = useLoaderData<typeof loader>();
  const [signingOut, setSigningOut] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Ends the session everywhere, not just here — it is one shared cookie, so
   * signing out of admin signs you out of the webapp too. That is the intent:
   * this app has account-takeover powers and "log out" should mean it.
   */
  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      window.location.href = webappUrl;
    }
  };

  return (
    <div className="min-h-screen">
      {/* Deliberately not the webapp's CommonLayout: no classroom sidebar, no
          class switcher. This is a platform-wide tool. */}
      <header className="border-b border-line bg-panel">
        <div className="px-4 sm:px-6">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-accent-soft text-accent-ink text-[11px] font-semibold shrink-0">
                CM
              </span>
              <span className="text-sm font-semibold text-ink-0 shrink-0">Platform Admin</span>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="ml-2 hidden sm:flex items-center justify-between gap-6 w-72 rounded-md border border-line bg-paper px-2.5 py-1 text-sm text-ink-4 hover:border-line-strong transition-colors"
              >
                <span className="flex items-center gap-2">
                  <IconSearch size={14} />
                  Search people, classes, posts…
                </span>
                <kbd className="text-[11px] font-semibold text-ink-3 border border-line-strong rounded px-1.5 bg-panel">
                  ⌘K
                </kbd>
              </button>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <span className="hidden md:inline text-xs text-ink-4 truncate">
                {admin.name ?? admin.login}
              </span>
              <a href={webappUrl} className="text-sm text-ink-2 hover:text-ink-0 transition-colors">
                Back to Classmoji →
              </a>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm text-ink-2 hover:text-ink-0 hover:bg-nav-hover transition-colors disabled:opacity-60"
              >
                <IconLogout size={15} strokeWidth={1.75} />
                {signingOut ? 'Signing out…' : 'Log out'}
              </button>
            </div>
          </div>

          <nav className="flex gap-1 -mb-px overflow-x-auto">
            {TABS.map(tab => {
              const count = tab.badge ? badges[tab.badge] : 0;
              return (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) =>
                    [
                      'inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors',
                      isActive
                        ? 'border-accent text-ink-0'
                        : 'border-transparent text-ink-3 hover:text-ink-1',
                    ].join(' ')
                  }
                >
                  {tab.label}
                  {tab.badge && count > 0 ? (
                    <span
                      title={BADGE_TITLE[tab.badge]}
                      className="rounded-full border border-rose-bord bg-rose-bg text-rose-ink px-1.5 text-[11px] font-semibold leading-[1.5] tabular-nums"
                    >
                      {count}
                    </span>
                  ) : null}
                </NavLink>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-6">
        <Outlet />
      </main>

      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
};

export default AdminShell;
