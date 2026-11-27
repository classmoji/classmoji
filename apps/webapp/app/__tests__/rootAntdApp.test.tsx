import { App as AntdApp } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every dialog and toast in the webapp comes from `App.useApp()`, which only
 * works under antd's `<App>`; outside it `modal.confirm` is undefined and a
 * click that should ask first throws instead. The root layout is that `<App>`.
 * This renders the root with a route in place of `<Outlet />` and checks what
 * the route gets from `App.useApp()`.
 */

const NOT_RENDERED = 'the route never rendered';
let seen: string = NOT_RENDERED;

/** Stands in for a route: records what kind of `modal.confirm` it would call. */
const Route = () => {
  const { modal, message } = AntdApp.useApp();
  seen = `${typeof modal.confirm}/${typeof message.success}`;
  return null;
};

vi.mock('react-router', async () => ({
  ...(await vi.importActual<typeof import('react-router')>('react-router')),
  Outlet: () => <Route />,
  Links: () => null,
  Meta: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
  useLocation: () => ({ pathname: '/' }),
}));

// What root.tsx imports for its loader and chrome; none of it is under test.
vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({}),
}));
vi.mock('@classmoji/auth/server', () => ({ auth: { api: {} }, getAuthSession: vi.fn() }));
vi.mock('@classmoji/auth/secret', () => ({ COOKIE_DOMAIN: null }));
vi.mock('@classmoji/services', () => ({ GitHubProvider: {}, ClassmojiService: {} }));
vi.mock('@classmoji/ui-components', () => ({
  CalloutProvider: ({ children }: { children: React.ReactNode }) => children,
  CalloutSlot: () => null,
}));
vi.mock('~/components/ErrorBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('~/components/features/operations/OperationProgress', () => ({ default: () => null }));
vi.mock('~/components/features/onboarding', () => ({
  OnboardingTour: () => null,
  InClassroomTour: () => null,
}));
vi.mock('~/components/features/admin/ImpersonationBanner', () => ({ default: () => null }));
vi.mock('~/components/layout/NavigationProgress', () => ({ default: () => null }));
vi.mock('~/hooks', () => ({
  useNotifiedFetcher: () => ({}),
  useDarkMode: () => ({ isDarkMode: false, accent: '#21883d' }),
}));
vi.mock('~/store', () => ({
  default: (select: (state: Record<string, unknown>) => unknown) =>
    select({
      setClassroom: () => {},
      classroom: null,
      setRole: () => {},
      setUser: () => {},
      setMembership: () => {},
      membership: null,
      setSubscription: () => {},
    }),
}));
vi.mock('~/utils/sentry.client', () => ({ captureRouteError: vi.fn(), setSentryUser: vi.fn() }));

const { default: Root } = await import('../root.tsx');

const LOADER_DATA = {
  user: null,
  session: null,
  impersonationReturnUrl: null,
  impersonationCookieDomain: null,
  sentry: null,
};

beforeEach(() => {
  seen = NOT_RENDERED;
});

describe('root layout: antd App', () => {
  it('gives every route a working App.useApp()', () => {
    renderToStaticMarkup(
      <Root {...({ loaderData: LOADER_DATA } as unknown as Parameters<typeof Root>[0])} />
    );
    expect(seen).toBe('function/function');
  });
});
