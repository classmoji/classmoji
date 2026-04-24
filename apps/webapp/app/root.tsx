import '@ant-design/v5-patch-for-react-19';
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  redirect,
  useRouteError,
  isRouteErrorResponse,
} from 'react-router';
import axios from 'axios';

import React, { useEffect } from 'react';
import dayjs from 'dayjs';
import { ToastContainer, cssTransition } from 'react-toastify';
import { ConfigProvider, theme } from 'antd';
import { IconMoodSad } from '@tabler/icons-react';
import { auth as triggerAuth } from '@trigger.dev/sdk';

import { GitHubProvider, ClassmojiService } from '@classmoji/services';
import { auth, getAuthSession } from '@classmoji/auth/server';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import type { Route } from './+types/root';
import type { MembershipWithOrganization, AppUser, Role } from '~/types';
import type { ThemeConfig } from 'antd';
import { useNotifiedFetcher, useDarkMode } from './hooks';
import antdTheme from './config/antd';
import antdDarkTheme from './config/antdDark';
import useStore from './store';
import { getRoleFromPath } from './constants/roleSettings';

import { FetcherContext, UserContext } from '~/contexts';

import RenderErrorBoundary from './components/ErrorBoundary';
import { SyllabusBotRoot } from './components/features/syllabus-bot';
import ImpersonationBanner from './components/features/admin/ImpersonationBanner';

import relativeTime from 'dayjs/plugin/relativeTime';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
dayjs.extend(relativeTime);
dayjs.extend(isSameOrBefore);

import getPrisma from '@classmoji/database';
import '@fontsource/quicksand/700.css';
import 'react-toastify/dist/ReactToastify.css';
import '~/styles/tailwind.css';
import '~/styles/global.css';

React.useLayoutEffect = React.useEffect;

const ToastFade = cssTransition({
  enter: 'toast-fade-in',
  exit: 'toast-fade-out',
  collapse: false,
});

export const meta = () => {
  return [{ title: 'Classmoji' }];
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);

  // Redirect to setup wizard if requested
  if (process.env.SETUP_GITHUB_APP && !url.pathname.startsWith('/setup')) {
    return redirect('/setup');
  }

  // Setup routes are public - bypass all auth and Trigger.dev logic
  if (url.pathname.startsWith('/setup')) {
    return { user: null };
  }

  // Create Trigger.dev public token for task monitoring (non-fatal if not configured)
  let publicToken = null;
  try {
    publicToken = await triggerAuth.createPublicToken({
      expirationTime: '1hr',
      scopes: {
        read: {
          runs: true,
        },
      },
    });
  } catch {
    // Trigger.dev not configured - skip public token
  }

  if (url.pathname.endsWith('/invitation')) return { user: null };

  // Check if this is a public page route (e.g., /org-name/pages/page-id)
  const isPublicPageRoute = /^\/[^/]+\/pages\/[^/]+$/.test(url.pathname);
  if (isPublicPageRoute) return { user: null, publicToken };

  // Routes that don't require full auth (registration flow)
  const publicRoutes = ['/', '/select-registration', '/registration', '/login', '/test-login'];
  const isPublicRoute = publicRoutes.some(
    route =>
      url.pathname === route ||
      url.pathname.startsWith('/login') ||
      url.pathname.startsWith('/test-login')
  );

  // Get auth session (works for both OAuth and test-login sessions)
  const authData = await getAuthSession(request);

  // Also try Better Auth's session for impersonation detection
  const betterAuthSession = await auth.api.getSession({ headers: request.headers });

  // Use authData for authentication check (supports test-login)
  const session = authData?.session || betterAuthSession;

  if (!authData?.userId) {
    if (!isPublicRoute) return redirect('/');
    return { user: null, organizations: [], publicToken, memberships: [] };
  }

  // Check if we're impersonating - if so, fetch the impersonated user directly
  const isImpersonating = !!betterAuthSession?.session?.impersonatedBy;

  let user: AppUser | null = null;

  if (isImpersonating) {
    // When impersonating, fetch the impersonated user directly by their session user ID
    user = await getPrisma().user.findUnique({
      where: { id: authData.userId },
      include: {
        classroom_memberships: {
          include: {
            classroom: {
              include: {
                git_organization: true,
                settings: {
                  select: {
                    quizzes_enabled: true,
                    slides_enabled: true,
                    theme: true,
                    updated_at: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Fetch subscription for impersonated user
    const subscription = await ClassmojiService.subscription.getCurrent(authData.userId);
    if (user && subscription) {
      user.subscription = subscription;
    }
  } else {
    // Normal flow - first try to look up user by ID if we have a valid session
    // This avoids GitHub API calls when user is already in our database
    if (authData.userId) {
      user = await getPrisma().user.findUnique({
        where: { id: authData.userId },
        include: {
          classroom_memberships: {
            include: {
              classroom: {
                include: {
                  git_organization: true,
                  settings: {
                    select: {
                      quizzes_enabled: true,
                      slides_enabled: true,
                      theme: true,
                      updated_at: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (user) {
        // User found in DB - fetch subscription
        const subscription = await ClassmojiService.subscription.getCurrent(authData.userId);
        if (subscription) {
          user.subscription = subscription;
        }
      }
    }

    // If no user found by ID, fall back to GitHub API lookup (new user registration flow)
    if (!user) {
      const accessToken = authData?.token || null;

      // NOTE: Do NOT fall back to auth.api.getAccessToken() here.
      // BetterAuth's refresh silently fails for GitHub App tokens (HTTP 200 errors)
      // and can corrupt the DB by storing undefined tokens. Our getAuthSession()
      // already handles refresh properly via getValidGitHubToken().

      if (accessToken) {
        const octokit = GitHubProvider.getUserOctokit(accessToken);
        const { data: githubUser } = await octokit.rest.users.getAuthenticated();

        // Fetch subscription
        const subscription = await ClassmojiService.subscription.getCurrent(authData.userId);

        user = await getPrisma().user.findUnique({
          where: { login: githubUser.login },
          include: {
            classroom_memberships: {
              include: {
                classroom: {
                  include: {
                    git_organization: true,
                    settings: {
                      select: {
                        quizzes_enabled: true,
                        slides_enabled: true,
                        theme: true,
                        updated_at: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        // User authenticated with GitHub but not in our DB yet - redirect to registration
        if (!user && !isPublicRoute) {
          const next = url.pathname !== '/' ? `?next=${encodeURIComponent(url.pathname)}` : '';
          return redirect(`/registration${next}`);
        }

        if (user && subscription) {
          user.subscription = subscription;
        }
      }
    }
  }

  // For backward compat, map classroom_memberships to format expected by UI
  // TODO: Update UI to use classroom_memberships directly
  const memberships = user?.classroom_memberships?.map(m => {
    // Construct avatar URL from GitHub org ID
    const gitOrgProviderId = m.classroom.git_organization?.provider_id;
    const avatar_url = gitOrgProviderId
      ? `https://avatars.githubusercontent.com/u/${gitOrgProviderId}?v=4`
      : null;

    return {
      ...m,
      organization: {
        ...m.classroom,
        login: m.classroom.slug, // Use slug as "login" for URL compat
        avatar_url, // Add avatar from git_organization
      },
    };
  });

  // Attach memberships to user for Zustand store sync
  if (user) {
    user.memberships = memberships;
  }

  const organizations = memberships?.map(({ organization }) => organization) || [];

  return {
    user,
    organizations,
    publicToken,
    memberships,
    session,
    aiAgentAvailable: isAIAgentConfigured(),
  };
};

const App = ({ loaderData }: Route.ComponentProps) => {
  const { fetcher, notify } = useNotifiedFetcher();
  const { user, session } = loaderData;
  const { isDarkMode, accent } = useDarkMode();
  const { pathname } = useLocation();
  const {
    setClassroom,
    classroom,
    setRole,
    setUser,
    setMembership,
    membership: _membership,
    setSubscription,
  } = useStore(state => state);

  // Sync classroom from URL and memberships (handles initial load + revalidation)
  // Extract classroom slug and role from pathname to only trigger when these actually change
  const path = pathname.split('/');
  const rolePrefix = path[1]; // e.g., 'admin', 'student', 'assistant'
  const classroomSlug = path[2];

  useEffect(() => {
    if (classroomSlug && user?.memberships) {
      const roleFromUrl = getRoleFromPath(rolePrefix);

      // Find membership matching BOTH classroom AND role from URL
      // membership.organization.login is mapped from classroom.slug in the loader
      let membership = user.memberships.find(
        (m: MembershipWithOrganization) =>
          m.organization.login === classroomSlug && m.role === roleFromUrl
      );

      // If no exact role match found, check if user is OWNER (owners can access all routes)
      // This allows OWNER to access /student routes without a separate STUDENT membership
      if (!membership && roleFromUrl) {
        membership = user.memberships.find(
          (m: MembershipWithOrganization) =>
            m.organization.login === classroomSlug && m.role === 'OWNER'
        );
        // If found an OWNER membership accessing another role's route, use the URL role for display
        // but keep the OWNER membership for permissions
        if (membership) {
          setClassroom(membership.organization);
          setRole(roleFromUrl as Role | null); // Use URL role for navigation display
          setMembership({ ...membership, role: roleFromUrl as Role }); // Override role for UI
          return;
        }
      }

      if (membership) {
        setClassroom(membership.organization);
        setRole(membership.role);
        setMembership(membership);
      }
    }
  }, [classroomSlug, rolePrefix, user?.memberships, setClassroom, setRole, setMembership]); // Only run when classroom/role changes, not entire pathname

  useEffect(() => {
    if (user) {
      setUser(user);
    }
  }, [user, setUser]);

  useEffect(() => {
    const fetchSubscription = async () => {
      const subscription = await axios.get(`/api/get-org-subscription?orgLogin=${classroom!.slug}`);
      setSubscription(subscription.data);
    };
    if (classroom) fetchSubscription();
  }, [classroom, setSubscription]);

  return (
    <html lang="en" className={isDarkMode ? 'dark' : ''} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap"
          rel="stylesheet"
        />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var root = document.documentElement;
                  var saved = null;
                  try { saved = JSON.parse(localStorage.getItem('cm-tweaks') || 'null'); } catch (e) {}
                  var theme;
                  if (saved && (saved.theme === 'light' || saved.theme === 'dark')) {
                    theme = saved.theme;
                  } else {
                    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  }
                  root.setAttribute('data-theme', theme);
                  if (theme === 'dark') root.classList.add('dark');
                  var accent = (saved && typeof saved.accent === 'string') ? saved.accent : '#6d5efc';
                  root.style.setProperty('--accent', accent);
                  var bgKey = (saved && typeof saved.background === 'string') ? saved.background : 'default';
                  var PRESETS = {
                    aurora: { light: ['#ffc9dd','#b9c9ff','#e4d4ff','#dce5ff','#ffcedd','#fbeaf2','#f0e3fa','#fdf4f8'], dark: ['#3a1a44','#0e0a26','#17102c','#241a44','#0e0a22','#170f1e','#1e1530','#1a1226'] },
                    mint:   { light: ['#b9e7cc','#a8dec1','#cfe8d8','#dcecdf','#b7d9c4','#e8f3ec','#d9ebe1','#f2f8f4'], dark: ['#123629','#061510','#0c2118','#102c22','#04100b','#0a1812','#0e2119','#0c1b14'] },
                    peach:  { light: ['#ffcea1','#ffb589','#ffdcbd','#ffe4cc','#ffc395','#fcebd8','#f6dcbf','#fdf3e7'], dark: ['#3b1f12','#160b07','#1e1109','#26160d','#0f0805','#1a110a','#261a10','#1d140c'] },
                    slate:  { light: ['#d6dce6','#c3cbd9','#d0d7e1','#dde2eb','#c6ccd8','#edf0f5','#e0e5ee','#f5f7fa'], dark: ['#21252f','#0a0c14','#10131c','#171a24','#0a0b10','#0f1117','#161a22','#111319'] },
                    dusk:   { light: ['#b4c3f0','#8fa3db','#bcc7e7','#c9d2ed','#9dadd8','#dfe6f7','#ced8ef','#ecf0fa'], dark: ['#232a5a','#050825','#0a1030','#121a40','#050720','#0c1029','#131838','#0e1330'] }
                  };
                  var keys = ['--bg-stop-1','--bg-stop-2','--bg-stop-3a','--bg-stop-3b','--bg-stop-3c','--paper','--paper-2','--sidebar'];
                  if (PRESETS[bgKey]) {
                    var arr = PRESETS[bgKey][theme === 'dark' ? 'dark' : 'light'];
                    for (var i = 0; i < 8; i++) root.style.setProperty(keys[i], arr[i]);
                  }
                  root.setAttribute('data-bg', bgKey);
                } catch (error) { /* noop */ }
              })();
            `,
          }}
        />
      </head>
      <body className={isDarkMode ? 'bg-gray-900' : 'bg-white'} suppressHydrationWarning>
        <RenderErrorBoundary>
          <ConfigProvider
            theme={
              {
                ...(isDarkMode ? antdDarkTheme : antdTheme),
                token: {
                  ...(isDarkMode ? antdDarkTheme : antdTheme).token,
                  colorPrimary: accent,
                  colorLink: accent,
                },
                components: {
                  ...(isDarkMode ? antdDarkTheme : antdTheme).components,
                  Button: {
                    ...((isDarkMode ? antdDarkTheme : antdTheme).components?.Button ?? {}),
                    colorPrimary: accent,
                    colorPrimaryHover: accent,
                    colorPrimaryActive: accent,
                  },
                  Tabs: {
                    ...((isDarkMode ? antdDarkTheme : antdTheme).components?.Tabs ?? {}),
                    inkBarColor: accent,
                    itemSelectedColor: accent,
                    itemHoverColor: accent,
                  },
                  Switch: {
                    ...((isDarkMode ? antdDarkTheme : antdTheme).components?.Switch ?? {}),
                    colorPrimary: accent,
                    colorPrimaryHover: accent,
                  },
                },
                algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
              } as ThemeConfig
            }
            renderEmpty={() => (
              <div className="flex justify-center flex-col items-center gap-2 py-4">
                <IconMoodSad size={25} />
                <p>No data found</p>
              </div>
            )}
          >
            <UserContext.Provider value={{ user }}>
              <FetcherContext.Provider value={{ fetcher, notify }}>
                <ToastContainer
                  position="bottom-center"
                  autoClose={4000}
                  hideProgressBar
                  newestOnTop={false}
                  closeOnClick={false}
                  pauseOnFocusLoss
                  draggable={false}
                  pauseOnHover
                  icon={false}
                  theme="light"
                  transition={ToastFade}
                />

                <ImpersonationBanner
                  key={(session as Record<string, Record<string, string>>)?.session?.id}
                  session={session}
                />
                <Outlet />
                <SyllabusBotRoot />
                <ScrollRestoration />
                <Scripts />
              </FetcherContext.Provider>
            </UserContext.Provider>
          </ConfigProvider>
        </RenderErrorBoundary>
      </body>
    </html>
  );
};

// Root-level ErrorBoundary for loader/action errors
export function ErrorBoundary() {
  const error = useRouteError();
  const isDevelopment = import.meta.env.MODE === 'development';
  const [isDarkMode, setIsDarkMode] = React.useState(false);

  // Synchronous error message extraction
  // isRouteErrorResponse handles Response objects thrown from loaders/actions
  let errorMessage;
  let errorStatus = null;

  if (isRouteErrorResponse(error)) {
    // React Router route error - error.data contains the response body text
    errorMessage = error.data || error.statusText || `Error ${error.status}`;
    errorStatus = error.status;
  } else if (error instanceof Error) {
    errorMessage = error.message;
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else {
    errorMessage = 'An unexpected error occurred';
  }

  // Detect dark mode preference using media query
  React.useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
    mediaQuery.addEventListener('change', handler);

    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return (
    <html lang="en" className={isDarkMode ? 'dark' : ''} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var root = document.documentElement;
                  var saved = null;
                  try { saved = JSON.parse(localStorage.getItem('cm-tweaks') || 'null'); } catch (e) {}
                  var theme;
                  if (saved && (saved.theme === 'light' || saved.theme === 'dark')) {
                    theme = saved.theme;
                  } else {
                    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  }
                  root.setAttribute('data-theme', theme);
                  if (theme === 'dark') root.classList.add('dark');
                  var accent = (saved && typeof saved.accent === 'string') ? saved.accent : '#6d5efc';
                  root.style.setProperty('--accent', accent);
                  var bgKey = (saved && typeof saved.background === 'string') ? saved.background : 'default';
                  var PRESETS = {
                    aurora: { light: ['#ffc9dd','#b9c9ff','#e4d4ff','#dce5ff','#ffcedd','#fbeaf2','#f0e3fa','#fdf4f8'], dark: ['#3a1a44','#0e0a26','#17102c','#241a44','#0e0a22','#170f1e','#1e1530','#1a1226'] },
                    mint:   { light: ['#b9e7cc','#a8dec1','#cfe8d8','#dcecdf','#b7d9c4','#e8f3ec','#d9ebe1','#f2f8f4'], dark: ['#123629','#061510','#0c2118','#102c22','#04100b','#0a1812','#0e2119','#0c1b14'] },
                    peach:  { light: ['#ffcea1','#ffb589','#ffdcbd','#ffe4cc','#ffc395','#fcebd8','#f6dcbf','#fdf3e7'], dark: ['#3b1f12','#160b07','#1e1109','#26160d','#0f0805','#1a110a','#261a10','#1d140c'] },
                    slate:  { light: ['#d6dce6','#c3cbd9','#d0d7e1','#dde2eb','#c6ccd8','#edf0f5','#e0e5ee','#f5f7fa'], dark: ['#21252f','#0a0c14','#10131c','#171a24','#0a0b10','#0f1117','#161a22','#111319'] },
                    dusk:   { light: ['#b4c3f0','#8fa3db','#bcc7e7','#c9d2ed','#9dadd8','#dfe6f7','#ced8ef','#ecf0fa'], dark: ['#232a5a','#050825','#0a1030','#121a40','#050720','#0c1029','#131838','#0e1330'] }
                  };
                  var keys = ['--bg-stop-1','--bg-stop-2','--bg-stop-3a','--bg-stop-3b','--bg-stop-3c','--paper','--paper-2','--sidebar'];
                  if (PRESETS[bgKey]) {
                    var arr = PRESETS[bgKey][theme === 'dark' ? 'dark' : 'light'];
                    for (var i = 0; i < 8; i++) root.style.setProperty(keys[i], arr[i]);
                  }
                  root.setAttribute('data-bg', bgKey);
                } catch (error) { /* noop */ }
              })();
            `,
          }}
        />
      </head>
      <body className={isDarkMode ? 'bg-gray-900' : 'bg-white'} suppressHydrationWarning>
        <ConfigProvider
          theme={
            {
              token: isDarkMode
                ? {
                    colorPrimary: '#1f883d',
                    colorText: '#e5e7eb',
                    colorBgContainer: '#1f2937',
                  }
                : {
                    colorPrimary: '#1f883d',
                    colorText: '#374151',
                  },
              components: {
                Button: isDarkMode
                  ? {
                      colorBgContainer: '#1f883d',
                      colorText: '#ffffff',
                      colorBgContainerHover: '#1a7f37',
                    }
                  : {
                      colorBgContainer: '#1f883d',
                      colorText: '#ffffff',
                      colorBgContainerHover: '#1a7f37',
                    },
                Result: isDarkMode
                  ? {
                      colorText: '#e5e7eb',
                      colorTextHeading: '#e5e7eb',
                      colorTextDescription: '#9ca3af',
                      colorError: '#ef4444',
                    }
                  : {},
              },
            } as ThemeConfig
          }
          {...({
            algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
          } as ThemeConfig)}
        >
          <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-[#0f1419] px-4">
            <div className="max-w-2xl w-full">
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 mb-4">
                  <svg
                    className="w-8 h-8 text-red-600 dark:text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  Something went wrong
                </h1>
                <p className="text-gray-600 dark:text-gray-400">
                  {errorMessage ||
                    'We encountered an unexpected error. Our team has been notified and is working on a fix.'}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => (window.location.href = '/')}
                  className="px-5 py-2.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-neutral-800 hover:bg-gray-50 dark:hover:bg-neutral-700 transition-colors"
                >
                  Back to Home
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="px-5 py-2.5 text-sm font-medium rounded-lg bg-gray-900 dark:bg-primary text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-primary-400 transition-colors"
                >
                  Try Again
                </button>
              </div>

              {isDevelopment && !!error && (
                <div className="mt-8" key="dev-error">
                  <pre className="p-4 bg-gray-900 dark:bg-neutral-950 rounded-lg text-xs overflow-auto max-h-80 border border-gray-200 dark:border-neutral-800">
                    <code className="text-red-400">
                      {errorStatus
                        ? `Response ${errorStatus}: ${errorMessage}`
                        : (error instanceof Error ? error.stack : null) || errorMessage}
                    </code>
                  </pre>
                </div>
              )}
            </div>
          </div>
        </ConfigProvider>
        <Scripts />
      </body>
    </html>
  );
}

export default App;
