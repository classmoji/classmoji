import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How the root loader treats the setup wizard's paths for a signed-out
 * visitor. While the wizard is on (`SETUP_GITHUB_APP` set, not a production
 * build), `/setup` and the paths under it need no session and every other page
 * leads to `/setup`. While it is off, they are like any other path. A path that
 * only starts with the same letters (`/setupx`) is never one of them.
 */

const getAuthSessionMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({}),
}));
vi.mock('@classmoji/auth/server', () => ({
  auth: { api: { getSession: (...a: unknown[]) => getSessionMock(...a) } },
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));
vi.mock('@classmoji/auth/secret', () => ({ COOKIE_DOMAIN: null }));
vi.mock('@classmoji/services', () => ({
  GitHubProvider: { getUserOctokit: vi.fn() },
  ClassmojiService: {},
}));

// The component tree root.tsx renders; none of it runs in a loader test.
vi.mock('@ant-design/v5-patch-for-react-19', () => ({}));
vi.mock('@classmoji/ui-components', () => ({
  CalloutProvider: () => null,
  CalloutSlot: () => null,
}));
vi.mock('~/components/features/operations/OperationProgress', () => ({ default: () => null }));
vi.mock('~/components/ErrorBoundary', () => ({ default: () => null }));
vi.mock('~/components/features/onboarding', () => ({
  OnboardingTour: () => null,
  InClassroomTour: () => null,
}));
vi.mock('~/components/features/admin/ImpersonationBanner', () => ({ default: () => null }));
vi.mock('~/components/layout/NavigationProgress', () => ({ default: () => null }));
vi.mock('~/hooks', () => ({ useNotifiedFetcher: vi.fn(), useDarkMode: vi.fn() }));
vi.mock('~/store', () => ({ default: vi.fn() }));
vi.mock('~/utils/sentry.client', () => ({ captureRouteError: vi.fn(), setSentryUser: vi.fn() }));

const { loader } = await import('../root.tsx');
const { routerArgs } = await import('./support/routerUrl.ts');

const load = async (path: string) =>
  (await loader(
    routerArgs(`http://localhost${path}`) as unknown as Parameters<typeof loader>[0]
  )) as Response | Record<string, unknown>;

const redirectedTo = (result: Response | Record<string, unknown>) =>
  result instanceof Response ? result.headers.get('Location') : null;

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.SETUP_GITHUB_APP;
  process.env.NODE_ENV = 'development';
  process.env.SENTRY_DSN = '';
  vi.clearAllMocks();
  getAuthSessionMock.mockResolvedValue(null);
  getSessionMock.mockResolvedValue(null);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

const SETUP_PATHS = [
  '/setup',
  '/setup/callback',
  `/setup/callback.data?_routes=routes/setup.callback`,
];
const LOOKALIKE_PATHS = ['/setupx', '/setup-something'];

describe('root loader: setup paths while the wizard is on', () => {
  beforeEach(() => {
    process.env.SETUP_GITHUB_APP = 'true';
  });

  for (const path of SETUP_PATHS) {
    it(`serves ${path} without a session`, async () => {
      const result = await load(path);
      expect(result).not.toBeInstanceOf(Response);
      expect((result as Record<string, unknown>).user).toBeNull();
      expect(getAuthSessionMock).not.toHaveBeenCalled();
    });
  }

  for (const path of ['/', '/admin/some-class/dashboard', ...LOOKALIKE_PATHS]) {
    it(`sends ${path} to /setup`, async () => {
      expect(redirectedTo(await load(path))).toBe('/setup');
    });
  }
});

describe('root loader: setup paths while the wizard is off', () => {
  for (const path of [...SETUP_PATHS, ...LOOKALIKE_PATHS]) {
    it(`treats ${path} like any other path for a signed-out visitor`, async () => {
      expect(redirectedTo(await load(path))).toBe('/');
      expect(getAuthSessionMock).toHaveBeenCalled();
    });
  }

  it('leaves the home page to the signed-out visitor', async () => {
    const result = await load('/');
    expect(result).not.toBeInstanceOf(Response);
    expect((result as Record<string, unknown>).user).toBeNull();
  });

  describe('on a production build with the switch set', () => {
    beforeEach(() => {
      process.env.SETUP_GITHUB_APP = 'true';
      process.env.NODE_ENV = 'production';
    });

    it('does not send the home page to /setup', async () => {
      const result = await load('/');
      expect(result).not.toBeInstanceOf(Response);
      expect((result as Record<string, unknown>).user).toBeNull();
    });

    for (const path of SETUP_PATHS) {
      it(`treats ${path} like any other path for a signed-out visitor`, async () => {
        expect(redirectedTo(await load(path))).toBe('/');
      });
    }
  });

  // Only a development server with the exact value `.env.example` ships.
  for (const [label, env] of [
    ['an empty NODE_ENV', { SETUP_GITHUB_APP: 'true', NODE_ENV: '' }],
    ['a NODE_ENV other than development', { SETUP_GITHUB_APP: 'true', NODE_ENV: 'test' }],
    ['a switch value other than "true"', { SETUP_GITHUB_APP: '1', NODE_ENV: 'development' }],
    ['the switch set to "false"', { SETUP_GITHUB_APP: 'false', NODE_ENV: 'development' }],
  ] as const) {
    it(`stays off with ${label}`, async () => {
      Object.assign(process.env, env);
      expect(redirectedTo(await load('/setup/callback'))).toBe('/');
      const home = await load('/');
      expect(home).not.toBeInstanceOf(Response);
    });
  }
});
