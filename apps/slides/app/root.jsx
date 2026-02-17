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

import prisma from '@classmoji/database';
import { getAuthSession } from '@classmoji/auth/server';
import useStore from '~/store';

/**
 * Custom hook to access user data from the root loader
 * Can be used in any child route to get the current user
 */
export function useUser() {
  return useRouteLoaderData('root');
}

import 'react-toastify/dist/ReactToastify.css';
import '~/styles/tailwind.css';
import '~/styles/global.css';

export const meta = () => {
  return [{ title: 'Slides - Classmoji' }];
};

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // Allow public access to /follow routes with valid shareCode
  // These routes handle their own authorization via shareCode validation
  const isFollowRoute = url.pathname.match(/^\/[^/]+\/follow$/);
  const hasShareCode = url.searchParams.has('shareCode');

  if (isFollowRoute && hasShareCode) {
    // Skip auth for public follow links - route will validate shareCode
    return { user: null, isPublicAccess: true };
  }

  // Check if this is a potential slideId route (UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
  // Routes: /$slideId, /$slideId/follow, /$slideId/present, /$slideId/speaker
  // Excludes: /$classroomSlug/new, /$classroomSlug/$slideId/delete, /content/*
  const slideIdMatch = url.pathname.match(/^\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(?:follow|present|speaker))?$/i);

  if (slideIdMatch) {
    const potentialSlideId = slideIdMatch[1];

    // Check if this slide exists and is public
    try {
      const slide = await prisma.slide.findUnique({
        where: { id: potentialSlideId },
        select: { is_public: true, is_draft: true },
      });

      // If slide is public (and not draft), allow unauthenticated access
      // The child route will handle the actual authorization
      if (slide && slide.is_public && !slide.is_draft) {
        return { user: null, isPublicAccess: true };
      }
    } catch {
      // If lookup fails, continue with normal auth flow
    }
  }

  // Use Better Auth for authentication
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
                } catch (error) { console.log(error); }
              })();
            `,
          }}
        />
      </head>
      <body className="bg-white dark:bg-gray-900" suppressHydrationWarning>
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
