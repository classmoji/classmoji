import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  redirect,
  useLocation,
  isRouteErrorResponse,
  useRouteError,
  useLoaderData,
  useRouteLoaderData,
} from 'react-router';
import React, { useEffect } from 'react';
import { ToastContainer } from 'react-toastify';
import { MantineProvider } from '@mantine/core';

import { prisma, getAuthSession } from '~/utils/db.server.ts';
import { classifyFormsPath } from '~/utils/formsPaths.ts';
import useStore from '~/store';

/**
 * Custom hook to access user data from the root loader
 * Can be used in any child route to get the current user
 */
export function useUser() {
  return useRouteLoaderData('root') as { user: import('~/types/pages.ts').PagesUser | null };
}

import 'react-toastify/dist/ReactToastify.css';
import '@mantine/core/styles.css';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import 'highlight.js/styles/atom-one-dark.css';
import '~/styles/blocknote-overrides.css';
import '~/styles/tailwind.css';

export const meta = (): Array<{ title: string }> => {
  return [{ title: 'Pages - Classmoji' }];
};

export const links = (): Array<{ rel: string; href: string; crossOrigin?: string }> => {
  return [
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
    {
      rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,100..900;1,100..900&display=swap',
    },
    {
      rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap',
    },
  ];
};

/** Internal namespace the class-site host middleware rewrites onto. */
const SITE_PATH_PREFIX = '/_site';

const isSitePath = (pathname: string): boolean =>
  pathname === SITE_PATH_PREFIX || pathname.startsWith(`${SITE_PATH_PREFIX}/`);

export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);

  // Class websites are public, anonymous and script-less. This MUST come before
  // any auth work: the redirect below would otherwise bounce every visitor to
  // the webapp login. These paths are only reachable via the host middleware's
  // internal rewrite, never from the canonical host.
  if (isSitePath(url.pathname)) {
    return { user: null, isSite: true };
  }

  // Health check, API routes, and root index don't require auth from here.
  // Their own route loaders handle responses appropriately.
  if (url.pathname === '/health' || url.pathname.startsWith('/api/') || url.pathname === '/') {
    // Still try to get user if available (non-blocking)
    try {
      const authData = await getAuthSession(request);
      if (authData) {
        const user = await prisma.user.findUnique({
          where: { id: authData.userId },
          include: { classroom_memberships: { include: { classroom: true } } },
        });
        return { user, isSite: false };
      }
    } catch {
      // Not authenticated — that's fine for these routes
    }
    return { user: null, isSite: false };
  }

  // Forms are classified BEFORE the page-view branch, because `/{class}/forms`
  // has the shape that branch matches and would otherwise be looked up as a
  // Page id of 'forms' — a query that can only ever miss, on a code path whose
  // public/private answer has nothing to do with forms.
  //
  // This does NOT weaken the gate. Admin forms paths (the list, the new-form
  // drawer, the builder, and every shape this classifier does not recognize)
  // fall through to the standard `getAuthSession` check below and are still
  // redirected to the webapp login when there is no session. Only the PUBLIC
  // fill surfaces — `/{class}/forms/{slug}` and its `/verify` page — are
  // exempted, because a waitlist link must open for a stranger.
  //
  // The exemption makes the route-level gates load-bearing rather than
  // belt-and-braces: for the exempted shapes this loader is no longer a second
  // wall, so `assertFormAdmin` in every forms loader AND action is the only
  // thing between anonymous and admin data. See app/utils/formsPaths.ts for the
  // full rule and its fail-closed default.
  const formsRoute = classifyFormsPath(url.pathname);

  if (formsRoute === 'public') {
    // Best-effort session, exactly like the public-page branch: a signed-in
    // member filling a public form should still see themselves in the chrome.
    const authData = await getAuthSession(request).catch(() => null);
    let user = null;
    if (authData) {
      user = await prisma.user
        .findUnique({
          where: { id: authData.userId },
          include: { classroom_memberships: { include: { classroom: true } } },
        })
        .catch(() => null);
    }
    return { user, isPublicAccess: true, isSite: false };
  }

  // Check if this is a page view route (/:classroomSlug/:pageId pattern)
  // Allow public pages to be viewed without authentication
  const pageViewMatch = formsRoute === null ? url.pathname.match(/^\/([^/]+)\/([^/]+)$/) : null;

  if (pageViewMatch) {
    const [, , pageId] = pageViewMatch;

    try {
      // Look up the page to check if it's public
      const page = await prisma.page.findUnique({
        where: { id: pageId },
        select: { is_public: true, is_draft: true },
      });

      // If page is public and not a draft, allow unauthenticated access
      if (page && page.is_public && !page.is_draft) {
        // Try to get auth anyway (user might be logged in)
        const authData = await getAuthSession(request).catch(() => null);
        let user = null;

        if (authData) {
          user = await prisma.user.findUnique({
            where: { id: authData.userId },
            include: {
              classroom_memberships: {
                include: { classroom: true },
              },
            },
          });
        }

        return { user, isPublicAccess: true, isSite: false };
      }
    } catch {
      // If lookup fails, continue with normal auth flow
    }
  }

  // Standard auth via Better Auth
  const authData = await getAuthSession(request);

  if (!authData) {
    // Redirect to main app login
    const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
    return redirect(`${webappUrl}?redirect=${encodeURIComponent(url.href)}`);
  }

  // Get full user with classroom memberships
  let user = null;
  try {
    user = await prisma.user.findUnique({
      where: { id: authData.userId },
      include: {
        classroom_memberships: {
          include: {
            classroom: true,
          },
        },
      },
    });
  } catch (error) {
    console.error('User lookup failed:', error);
    const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
    return redirect(webappUrl);
  }

  return { user, isSite: false };
};

/**
 * Flash-free dark mode: set the `dark` class before first paint.
 *
 * CSP COUPLING — DO NOT EDIT THIS STRING. `SiteDocument` inlines it on every
 * class-site page, and its exact bytes are sha256-hashed in the site CSP
 * (`app/site/headers.server.ts`, `DARK_MODE_SCRIPT_HASH`). Change one character
 * and the browser blocks the site's only script. `tests/unit/site-headers.spec`
 * re-derives the hash from this literal and fails on drift. The embed/canonical
 * `App` document uses `APP_DARK_MODE_SCRIPT` below instead — which is NOT under
 * the CSP — so its theme-param behavior lives there, leaving this untouched.
 */
const DARK_MODE_SCRIPT = `
              (function() {
                try {
                  var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                  if (isDark) {
                    document.documentElement.classList.add('dark');
                  }
                  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                    if (e.matches) {
                      document.documentElement.classList.add('dark');
                    } else {
                      document.documentElement.classList.remove('dark');
                    }
                  });
                } catch (error) { console.log(error); }
              })();
            `;

/**
 * Flash-free dark mode for the hydrating `App` document (canonical + embed).
 *
 * When the webapp frames a page it passes its RESOLVED appearance as `?theme=`.
 * If it is exactly 'dark' or 'light' we honour it and DO NOT attach the
 * prefers-color-scheme listener, so the embedded reader matches the app even
 * when the app theme differs from the OS. With no such param (the canonical
 * pages host, opened directly) this is the OS-driven behavior of
 * `DARK_MODE_SCRIPT`. Class sites never carry the param and keep `DARK_MODE_SCRIPT`.
 *
 * FORCED LIGHT IS A POSITIVE MARKER. `?theme=light` adds a `light` class as well
 * as removing `dark`, because "no dark class" cannot be told apart from "nobody
 * expressed a preference" — and something has to be able to tell, or a rule
 * keyed on `prefers-color-scheme` darkens a deliberately-light embed on a
 * dark-mode machine. The forms canvas is the rule that needs it today (see
 * `components/forms/FormCanvas.tsx`); every Tailwind `dark:` utility in this app
 * is in the same position, compiling to a media query for want of a
 * `@custom-variant dark`. Only this branch sets `light`, and this branch returns
 * before the OS listener is attached, so `light` and `dark` are never both
 * present.
 */
const APP_DARK_MODE_SCRIPT = `
              (function() {
                try {
                  var forced = new URLSearchParams(window.location.search).get('theme');
                  if (forced === 'dark' || forced === 'light') {
                    if (forced === 'dark') {
                      document.documentElement.classList.remove('light');
                      document.documentElement.classList.add('dark');
                    } else {
                      document.documentElement.classList.remove('dark');
                      document.documentElement.classList.add('light');
                    }
                    return;
                  }
                  var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                  if (isDark) {
                    document.documentElement.classList.add('dark');
                  }
                  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                    if (e.matches) {
                      document.documentElement.classList.add('dark');
                    } else {
                      document.documentElement.classList.remove('dark');
                    }
                  });
                } catch (error) { console.log(error); }
              })();
            `;

const App = () => {
  const { user } = useLoaderData<typeof loader>();
  const setUser = useStore(state => state.setUser);

  // Populate Zustand store with user from loader
  useEffect(() => {
    setUser(user);
  }, [user, setUser]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,100..900;1,100..900&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap"
          rel="stylesheet"
        />
        {/* Flash-free dark mode: honour an explicit `?theme=` (the webapp's
            resolved appearance when embedded), else follow system preference. */}
        <script dangerouslySetInnerHTML={{ __html: APP_DARK_MODE_SCRIPT }} />
        {/* React Refresh preamble for dev mode — required for dynamic imports of JSX files.
            Must be a synchronous (non-module) script so it runs before any ESM modules load. */}
        {import.meta.env.DEV && (
          <script
            dangerouslySetInnerHTML={{
              __html: `
                window.$RefreshReg$ = () => {};
                window.$RefreshSig$ = () => (type) => type;
                window.__vite_plugin_react_preamble_installed__ = true;
              `,
            }}
          />
        )}
      </head>
      <body className="bg-white dark:bg-[#191919]" suppressHydrationWarning>
        <MantineProvider
          theme={{
            fontFamily:
              "'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
            fontFamilyMonospace:
              "'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
          }}
        >
          <ToastContainer
            position="top-center"
            autoClose={3000}
            hideProgressBar
            newestOnTop={false}
            closeOnClick
            pauseOnFocusLoss
            draggable
            pauseOnHover
            theme="colored"
          />
          <Outlet />
        </MantineProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
};

/**
 * Document shell for class websites (/_site/*).
 *
 * Deliberately script-less: no <Scripts/>, no <ScrollRestoration/>, no
 * hydration, no Mantine/Toast providers, no dev-only preamble. Whatever ships
 * here is the whole page. <Links/> stays because it carries the app's CSS
 * bundle (Tailwind + BlockNote/Mantine styles) that renders page content.
 */
const SiteDocument = () => {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,100..900;1,100..900&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: DARK_MODE_SCRIPT }} />
      </head>
      <body className="bg-white dark:bg-[#191919]" suppressHydrationWarning>
        <Outlet />
      </body>
    </html>
  );
};

/**
 * Top-level document switch.
 *
 * Branching between two whole components — rather than an early return inside
 * one — keeps hook order stable: App's hooks never run for site requests and
 * SiteDocument never runs App's.
 */
const Root = () => {
  const data = useLoaderData<typeof loader>();
  return data?.isSite ? <SiteDocument /> : <App />;
};

// Error boundary
export function ErrorBoundary() {
  const routeError = useRouteError();
  const error = routeError as { message?: string; stack?: string } | undefined;
  const location = useLocation();
  const isDevelopment = import.meta.env.MODE === 'development';

  /**
   * A 404 is a bad address, not a broken server, and telling someone to "try
   * again in a moment" is advice that can never work — it reads as an outage we
   * are about to fix.
   *
   * Every site route now throws its own 404 into the class-site layout's
   * boundary (see `site/not-found.tsx`), so this is the BACKSTOP for whatever
   * still reaches the root: a 404 thrown above the layout, or one on the editor
   * app's own tree.
   */
  const isNotFound = isRouteErrorResponse(routeError) && routeError.status === 404;

  // The loader may be what threw, so the site flag is derived from the URL
  // rather than loader data.
  if (isSitePath(location.pathname)) {
    // Script-less error document: no <Scripts/>, no JS-dependent controls.
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <Meta />
          <Links />
        </head>
        <body className="bg-gray-50 dark:bg-[#191919]">
          <div className="min-h-screen flex flex-col items-center justify-center px-4">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              {isNotFound ? 'Not found' : 'This page is unavailable'}
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              {isNotFound
                ? 'That address does not match anything on this site.'
                : isDevelopment
                  ? error?.message
                  : 'Try again in a moment.'}
            </p>
            {isDevelopment && error?.stack && (
              <pre className="mt-4 p-4 bg-gray-100 rounded-md text-xs overflow-auto max-w-2xl">
                {error.stack}
              </pre>
            )}
          </div>
        </body>
      </html>
    );
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="bg-gray-50 dark:bg-[#191919]">
        <div className="min-h-screen flex flex-col items-center justify-center px-4">
          <div className="text-6xl mb-4 text-center">📄</div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            {isNotFound ? 'Not found' : 'Something went wrong'}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {isNotFound
              ? 'That address does not match anything here.'
              : isDevelopment
                ? error?.message
                : 'Please try refreshing the page.'}
          </p>
          <div className="flex gap-4">
            {/* Reloading a 404 reproduces the 404. Only the way back out is
                worth offering. */}
            {isNotFound ? null : (
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-black text-white rounded-md hover:bg-gray-800"
              >
                Refresh
              </button>
            )}
            <button
              onClick={() => window.history.back()}
              className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Go Back
            </button>
          </div>
          {isDevelopment && error?.stack && (
            <pre className="mt-4 p-4 bg-gray-100 rounded-md text-xs overflow-auto max-w-2xl">
              {error.stack}
            </pre>
          )}
        </div>
        <Scripts />
      </body>
    </html>
  );
}

export default Root;
