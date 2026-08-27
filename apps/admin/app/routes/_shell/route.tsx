import { useState } from 'react';
import { NavLink, Outlet, useLoaderData } from 'react-router';
import { signOut } from '@classmoji/auth/client';
import { IconLogout } from '@tabler/icons-react';
import { requirePlatformAdmin } from '~/utils/db.server';
import type { LoaderFunctionArgs } from 'react-router';

/**
 * Shell for every admin page: gate + header + tabs.
 *
 * Pathless (`_shell`) so it wraps `/` and `/classrooms` without adding a URL
 * segment. `api.auth.$` and `health` sit outside it deliberately — neither
 * should render chrome or require an admin session.
 *
 * Child loaders re-run `requirePlatformAdmin` rather than trusting this one.
 * Guarding once in a layout is the classic way to leave a data route reachable
 * on its own.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { user } = await requirePlatformAdmin(request);
  return {
    admin: { login: user.login, name: user.name },
    webappUrl: process.env.WEBAPP_URL ?? 'http://localhost:3000',
  };
}

const TABS = [
  { to: '/', label: 'Users', end: true },
  { to: '/classrooms', label: 'Classrooms', end: false },
];

const AdminShell = () => {
  const { admin, webappUrl } = useLoaderData<typeof loader>();
  const [signingOut, setSigningOut] = useState(false);

  /**
   * Ends the session everywhere, not just here — it is one shared cookie, so
   * signing out of admin signs you out of the webapp too. That is the intent:
   * this app has account-takeover powers and "log out" should mean it.
   *
   * Lands on the webapp, which is the sign-in page. Returning here instead
   * would just render the not-authorized screen.
   */
  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // Full navigation, not navigate(): different origin, and we want a clean
      // document load with the cookie gone.
      window.location.href = webappUrl;
    }
  };

  return (
    <div className="min-h-screen">
      {/* Deliberately not the webapp's CommonLayout: no classroom sidebar, no
          class switcher. This is a platform-wide tool and should not look like
          it is scoped to a classroom. */}
      <header className="border-b border-line bg-panel">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-accent-soft text-accent-ink text-[11px] font-semibold shrink-0">
                CM
              </span>
              <span className="text-sm font-semibold text-ink-0">Platform Admin</span>
              <span className="text-xs text-ink-4 truncate">{admin.name ?? admin.login}</span>
            </div>
            <div className="flex items-center gap-4 shrink-0">
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

          <nav className="flex gap-1 -mb-px">
            {TABS.map(tab => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  [
                    'px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                    isActive
                      ? 'border-accent text-ink-0'
                      : 'border-transparent text-ink-3 hover:text-ink-1',
                  ].join(' ')
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
};

export default AdminShell;
