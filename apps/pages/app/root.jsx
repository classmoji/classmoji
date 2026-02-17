import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  redirect,
  useRouteError,
  useLoaderData,
  useRouteLoaderData,
} from 'react-router';
import React, { useEffect } from 'react';
import { ToastContainer } from 'react-toastify';
import { MantineProvider } from '@mantine/core';

import { prisma, getAuthSession } from '~/utils/db.server.js';
import useStore from '~/store';

/**
 * Custom hook to access user data from the root loader
 * Can be used in any child route to get the current user
 */
export function useUser() {
  return useRouteLoaderData('root');
}

import 'react-toastify/dist/ReactToastify.css';
import '@mantine/core/styles.css';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import 'highlight.js/styles/atom-one-dark.css';
import '~/styles/blocknote-overrides.css';
import '~/styles/tailwind.css';

export const meta = () => {
  return [{ title: 'Pages - Classmoji' }];
};

export const links = () => {
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

export const loader = async ({ request }) => {
  const url = new URL(request.url);

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
        return { user };
      }
    } catch {
      // Not authenticated — that's fine for these routes
    }
    return { user: null };
  }

  // Check if this is a page view route (/:classroomSlug/:pageId pattern)
  // Allow public pages to be viewed without authentication
  const pageViewMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)$/);

  if (pageViewMatch) {
    const [, classroomSlug, pageId] = pageViewMatch;

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

        return { user, isPublicAccess: true };
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

  return { user };
};

const App = () => {
  const { user } = useLoaderData();
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
        {/* Flash-free dark mode: add 'dark' class before first paint based on system preference */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
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
            `,
          }}
        />
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
            fontFamily: "'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
            fontFamilyMonospace: "'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
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

// Error boundary
export function ErrorBoundary() {
  const error = useRouteError();
  const isDevelopment = import.meta.env.MODE === 'development';

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
            Something went wrong
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {isDevelopment ? error?.message : 'Please try refreshing the page.'}
          </p>
          <div className="flex gap-4">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-black text-white rounded-md hover:bg-gray-800"
            >
              Refresh
            </button>
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

export default App;
