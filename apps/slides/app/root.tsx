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

import { CalloutProvider, CalloutSlot } from '@classmoji/ui-components';
import {
  SENTRY_CONFIG_ELEMENT_ID,
  serializeSentryConfig,
  type SentryBrowserConfig,
} from '@classmoji/utils/sentry';
import useStore from '~/store';
import type { SlideUser } from '~/store';
import { captureRouteError, setSentryUser } from '~/utils/sentry.client';
import { useNonce } from '~/utils/cspNonce';
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

/**
 * The browser's Sentry settings as a JSON data block, read by entry.client.tsx
 * before hydration. Rendered by both documents (App and the ErrorBoundary).
 */
const SentryConfigScript = ({ config }: { config: SentryBrowserConfig | null | undefined }) =>
  config ? (
    <script
      type="application/json"
      id={SENTRY_CONFIG_ELEMENT_ID}
      dangerouslySetInnerHTML={{ __html: serializeSentryConfig(config) }}
    />
  ) : null;

/**
 * The CSP nonce for Vite's module preloads, which read it from this tag
 * (entry.server.tsx sets the policy). Browsers blank the attribute once the
 * policy applies, so hydration finds it empty.
 */
const CspNonceMeta = ({ nonce }: { nonce: string | undefined }) => (
  <meta property="csp-nonce" nonce={nonce} suppressHydrationWarning />
);

const App = () => {
  const nonce = useNonce();
  const { user, sentry } = useLoaderData<typeof loader>() as {
    user: SlideUser | null;
    sentry?: SentryBrowserConfig | null;
  };
  const setUser = useStore(state => state.setUser);

  // Populate Zustand store with user from loader
  // This runs on initial load and whenever user changes
  useEffect(() => {
    setUser(user);
  }, [user, setUser]);

  const userId = user?.id;
  useEffect(() => {
    setSentryUser(userId);
  }, [userId]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <CspNonceMeta nonce={nonce} />
        <Meta />
        <Links nonce={nonce} />
        <SentryConfigScript config={sentry} />
        {/* Flash-free dark mode: add 'dark' class before first paint based on system preference */}
        <script
          nonce={nonce}
          suppressHydrationWarning
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
                  // NOTE: this string is injected verbatim as JavaScript — no
                  // TypeScript syntax here, or every page logs a SyntaxError.
                } catch (error) { console.log(error); }
              })();
            `,
          }}
        />
      </head>
      <body className="bg-white dark:bg-gray-900" suppressHydrationWarning>
        {/* One notification surface, shared with the webapp: slides used to
            reach for antd's message API, which renders its own chrome and
            ignores the theme entirely. */}
        <CalloutProvider>
          <CalloutSlot />
          <Outlet />
        </CalloutProvider>
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
};

// Error boundary
export function ErrorBoundary() {
  const nonce = useNonce();
  const routeError = useRouteError();
  const error = routeError as { message?: string; stack?: string } | undefined;
  // Present unless the root loader itself threw; carries the Sentry settings.
  const rootData = useRouteLoaderData<typeof loader>('root') as
    | { user?: { id?: string } | null; sentry?: SentryBrowserConfig | null }
    | undefined;
  const isDevelopment = import.meta.env.MODE === 'development';

  const userId = rootData?.user?.id;
  useEffect(() => {
    setSentryUser(userId);
    captureRouteError(routeError);
  }, [routeError, userId]);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <CspNonceMeta nonce={nonce} />
        <Meta />
        <Links nonce={nonce} />
        <SentryConfigScript config={rootData?.sentry} />
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
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default App;
