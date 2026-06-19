import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  useLoaderData,
  useRouteLoaderData,
} from 'react-router';
import React, { useEffect } from 'react';

import useStore from '~/store';
import type { SlideUser } from '~/store';
import type { loader } from './root.server';

/**
 * Custom hook to access user data from the root loader
 * Can be used in any child route to get the current user
 */
export function useUser() {
  return useRouteLoaderData('root');
}

import '~/styles/tailwind.css';
import '~/styles/global.css';

export { loader } from './root.server';

export const meta = () => {
  return [{ title: 'Slides - Classmoji' }];
};

const App = () => {
  const { user } = useLoaderData<typeof loader>() as { user: SlideUser | null };
  const setUser = useStore(state => state.setUser);

  // Populate Zustand store with user from loader
  // This runs on initial load and whenever user changes
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
                  // Listen for system preference changes
                  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                    if (e.matches) {
                      document.documentElement.classList.add('dark');
                    } else {
                      document.documentElement.classList.remove('dark');
                    }
                  });
                } catch (error: unknown) { console.log(error); }
              })();
            `,
          }}
        />
      </head>
      <body className="bg-white dark:bg-gray-900" suppressHydrationWarning>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
};

// Error boundary
export function ErrorBoundary() {
  const error = useRouteError() as { message?: string; stack?: string } | undefined;
  const isDevelopment = import.meta.env.MODE === 'development';

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="bg-gray-50 dark:bg-gray-900">
        <div className="min-h-screen flex flex-col items-center justify-center px-4">
          <div className="text-6xl mb-4 text-center">🔧</div>
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
