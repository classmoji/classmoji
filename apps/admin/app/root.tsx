import { useState } from 'react';
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
  useRouteLoaderData,
} from 'react-router';
import { signOut } from '@classmoji/auth/client';

import '@fontsource-variable/mona-sans';
import '~/styles/tailwind.css';

export const meta = () => [{ title: 'Admin · Classmoji' }];

/**
 * Deliberately auth-free: it runs before every child loader, including the ones
 * that throw 401/403, so the ErrorBoundary below still has a webapp URL to send
 * a rejected visitor to.
 */
export const loader = () => ({
  webappUrl: process.env.WEBAPP_URL ?? 'http://localhost:3000',
});

/**
 * Pre-paint theme script. Runs before first paint so the page never flashes
 * light-then-dark.
 *
 * Deliberately simpler than the webapp's: that one reads the `cm-tweaks`
 * localStorage blob written by its Tweaks panel (accent picker, UI scale,
 * contrast). This app has no Tweaks panel, so it just follows the OS and fixes
 * the accent at the Classmoji green defined in tokens.css.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var apply = function (isDark) {
      var root = document.documentElement;
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
      root.classList.toggle('dark', isDark);
    };
    apply(mq.matches);
    mq.addEventListener('change', function (e) { apply(e.matches); });
  } catch (e) {}
})();
`;

const Document = ({ children }: { children: React.ReactNode }) => (
  <html lang="en" suppressHydrationWarning>
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {/* Internal tool with account-takeover powers — keep it out of indexes. */}
      <meta name="robots" content="noindex, nofollow" />
      <Meta />
      <Links />
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
    </head>
    <body suppressHydrationWarning>
      {children}
      <ScrollRestoration />
      <Scripts />
    </body>
  </html>
);

const App = () => (
  <Document>
    <Outlet />
  </Document>
);

export const ErrorBoundary = () => {
  const error = useRouteError();
  // The root loader takes no auth, so this survives a child loader throwing.
  const rootData = useRouteLoaderData<typeof loader>('root');
  const webappUrl = rootData?.webappUrl ?? 'http://localhost:3000';
  const [signingOut, setSigningOut] = useState(false);

  // Without this a rejected visitor is stuck: signed in as the wrong account,
  // no nav rendered, and no way to switch. Signing out drops the shared cookie
  // and returns them to the webapp's sign-in.
  const switchAccount = async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      window.location.href = webappUrl;
    }
  };

  // requirePlatformAdmin throws bare 401/403 Responses. Render them here rather
  // than redirecting to the webapp's sign-in: a signed-in non-admin sent to
  // login would just bounce straight back and loop.
  if (isRouteErrorResponse(error)) {
    const denied = error.status === 401 || error.status === 403;
    return (
      <Document>
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="rounded-2xl bg-panel ring-1 ring-line p-8 max-w-md text-center">
            <h1 className="text-lg font-semibold text-ink-0 mb-2">
              {denied ? 'Not authorized' : `Error ${error.status}`}
            </h1>
            <p className="text-sm text-ink-2">
              {denied
                ? 'This tool is restricted to platform admins.'
                : (error.statusText ?? 'Something went wrong.')}
            </p>
            {denied ? (
              <div className="mt-5 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={switchAccount}
                  disabled={signingOut}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-1 hover:bg-nav-hover transition-colors disabled:opacity-60"
                >
                  {signingOut ? 'Signing out…' : 'Sign in as someone else'}
                </button>
                <a
                  href={webappUrl}
                  className="text-sm text-ink-2 hover:text-ink-0 transition-colors"
                >
                  Back to Classmoji →
                </a>
              </div>
            ) : null}
          </div>
        </div>
      </Document>
    );
  }

  return (
    <Document>
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 max-w-2xl">
          <h1 className="text-lg font-semibold text-ink-0 mb-2">Unexpected error</h1>
          {import.meta.env.MODE === 'development' && error instanceof Error ? (
            <pre className="text-xs text-ink-2 overflow-x-auto whitespace-pre-wrap">
              {error.stack ?? error.message}
            </pre>
          ) : null}
        </div>
      </div>
    </Document>
  );
};

export default App;
