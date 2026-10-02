import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What the root loader returns on every document load and revalidation: the
 * fields the client reads.
 *
 *   - Each membership: `id`, `role` and its classroom.
 *   - A classroom's git organization: `id`, `provider`, `provider_id`, `login`.
 *   - `session`: the session id and `impersonatedBy`, and the user's name and
 *     email (what the impersonation banner reads).
 *   - The top-level keys the app reads, and no others.
 *
 * Prisma is stubbed with a findUnique that applies the query's own
 * include/select to full rows, so the assertions hold for what the query
 * would really return rather than for whatever the stub hands back.
 */

type Row = Record<string, unknown>;

/** Applies a Prisma-style `select` or `include` to a full row. */
const project = (row: Row, query: { select?: Row; include?: Row }): Row => {
  const relations = new Set([
    'accounts',
    'classroom_memberships',
    'classroom',
    'git_organization',
    'settings',
  ]);
  const out: Row = {};
  if (query.select) {
    for (const [key, spec] of Object.entries(query.select)) {
      if (!spec) continue;
      out[key] = spec === true ? row[key] : applyNested(row[key], spec as Row);
    }
    return out;
  }
  for (const [key, value] of Object.entries(row)) {
    if (!relations.has(key)) out[key] = value;
  }
  for (const [key, spec] of Object.entries(query.include ?? {})) {
    if (!spec) continue;
    out[key] = spec === true ? row[key] : applyNested(row[key], spec as Row);
  }
  return out;
};

const applyNested = (value: unknown, spec: Row): unknown => {
  if (Array.isArray(value)) return value.map(v => project(v as Row, spec));
  if (value && typeof value === 'object') return project(value as Row, spec);
  return value;
};

const GIT_ORG_ROW = {
  id: 'org-1',
  provider: 'GITHUB',
  provider_id: '4242',
  login: 'test-org',
  base_url: null,
  github_installation_id: '999',
  access_token: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const CLASSROOM_ROW = {
  id: 'class-1',
  slug: 'test-class',
  name: 'Test Class',
  git_org_id: 'org-1',
  status: 'ACTIVE',
  is_example: false,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
  git_organization: GIT_ORG_ROW,
  settings: {
    quizzes_enabled: true,
    slides_enabled: true,
    show_modules: true,
    show_pages: true,
    show_repos: true,
    theme: null,
    updated_at: new Date('2026-01-03T00:00:00Z'),
  },
};

const USER_ROW = {
  id: 'user-1',
  name: 'Student Name',
  email: 'student@example.edu',
  emailVerified: true,
  // Git identity lives on the Github account, not the user row.
  accounts: [
    {
      provider_id: 'github',
      account_id: '1001',
      username: 'student-login',
      image: null,
      email: null,
      access_token: 'gho_secret',
    },
  ],
  classroom_memberships: [
    {
      id: 'mem-1',
      classroom_id: 'class-1',
      user_id: 'user-1',
      role: 'STUDENT',
      is_grader: false,
      has_accepted_invite: true,
      comment: null,
      letter_grade: null,
      pin_order: null,
      tour_completed_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      classroom: CLASSROOM_ROW,
    },
  ],
};

const authSession = ({ impersonatedBy }: { impersonatedBy?: string } = {}) => ({
  session: {
    id: 'sess-1',
    userId: 'user-1',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    ...(impersonatedBy ? { impersonatedBy } : {}),
  },
  user: { id: 'user-1', name: 'Student Name', email: 'student@example.edu' },
});

const findUniqueMock = vi.fn();
const getAuthSessionMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    user: { findUnique: (...a: unknown[]) => findUniqueMock(...a) },
    // Password (credential) accounts, for has_password.
    account: { count: async () => 0 },
  }),
}));

vi.mock('@classmoji/auth/server', () => ({
  auth: { api: { getSession: (...a: unknown[]) => getSessionMock(...a) } },
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

vi.mock('@classmoji/auth/secret', () => ({ COOKIE_DOMAIN: null }));

vi.mock('@classmoji/services', () => ({
  GitHubProvider: { getUserOctokit: vi.fn() },
  ClassmojiService: { subscription: { getCurrent: vi.fn(async () => null) } },
}));

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => false }));

// The component tree root.tsx renders; none of it runs in a loader test.
vi.mock('@ant-design/v5-patch-for-react-19', () => ({}));
vi.mock('@classmoji/ui-components', () => ({
  CalloutProvider: () => null,
  CalloutSlot: () => null,
}));
vi.mock('~/components/features/operations/OperationProgress', () => ({ default: () => null }));
vi.mock('~/components/ErrorBoundary', () => ({ default: () => null }));
vi.mock('~/components/features/syllabus-bot', () => ({ SyllabusBotRoot: () => null }));
vi.mock('~/components/features/onboarding', () => ({
  OnboardingTour: () => null,
  InClassroomTour: () => null,
}));
vi.mock('~/components/features/admin/ImpersonationBanner', () => ({ default: () => null }));
vi.mock('~/components/layout/NavigationProgress', () => ({ default: () => null }));
vi.mock('~/hooks', () => ({ useNotifiedFetcher: vi.fn(), useDarkMode: vi.fn() }));
vi.mock('~/store', () => ({ default: vi.fn() }));

const { loader } = await import('../root.tsx');

const load = async (path: string) =>
  (await loader({
    request: new Request(`http://localhost${path}`),
  } as unknown as Parameters<typeof loader>[0])) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockImplementation(async (query: { include?: Row; select?: Row }) =>
    project(USER_ROW, query)
  );
  getAuthSessionMock.mockResolvedValue({
    userId: 'user-1',
    token: 'ghu_token',
    userLogin: 'student-login',
    session: authSession(),
  });
  getSessionMock.mockResolvedValue(authSession());
});

describe('root loader payload', () => {
  it('selects the membership and git organization fields the client reads', async () => {
    await load('/student/test-class/dashboard');

    const { include } = findUniqueMock.mock.calls[0][0];
    const membershipSelect = include.classroom_memberships.select;
    expect(Object.keys(membershipSelect).sort()).toEqual(['classroom', 'id', 'role']);
    expect(membershipSelect.classroom.include.git_organization).toEqual({
      select: { id: true, provider: true, provider_id: true, login: true },
    });
  });

  it('returns memberships, classrooms and organizations as the client reads them', async () => {
    const data = await load('/student/test-class/dashboard');

    const [membership] = data.memberships as Array<Row & { organization: Row }>;
    expect(Object.keys(membership).sort()).toEqual(['classroom', 'id', 'organization', 'role']);
    expect(membership).toMatchObject({ id: 'mem-1', role: 'STUDENT' });
    expect(membership.organization).toMatchObject({
      id: 'class-1',
      slug: 'test-class',
      login: 'test-class',
      avatar_url: 'https://avatars.githubusercontent.com/u/4242?v=4',
    });
    expect(membership.organization.git_organization).toEqual({
      id: 'org-1',
      provider: 'GITHUB',
      provider_id: '4242',
      login: 'test-org',
    });
    expect((membership.organization.settings as Row).updated_at).toBeInstanceOf(Date);
    expect(membership.organization.updated_at).toBeInstanceOf(Date);

    const [organization] = data.organizations as Row[];
    expect(organization.git_organization).toEqual(membership.organization.git_organization);
  });

  it('returns the git identity from the accounts, without the account rows', async () => {
    const data = await load('/student/test-class/dashboard');
    const user = data.user as Row;

    expect(user).toMatchObject({
      login: 'student-login',
      logins: { GITHUB: 'student-login', GITLAB: null },
      has_github: true,
      has_gitlab: false,
      has_password: false,
      provider: 'GITHUB',
    });
    expect(user).not.toHaveProperty('accounts');
    expect(JSON.stringify(data)).not.toMatch(/gho_secret/);
    expect(data.gitMode).toBe('GITHUB');
  });

  it('returns the session fields the impersonation banner reads', async () => {
    const data = await load('/student/test-class/dashboard');

    expect(data.session).toEqual({
      session: { id: 'sess-1', impersonatedBy: undefined },
      user: { name: 'Student Name', email: 'student@example.edu' },
    });
  });

  it('keeps the "View As" flag for an impersonated session', async () => {
    getAuthSessionMock.mockResolvedValue({
      userId: 'user-1',
      token: null,
      userLogin: 'student-login',
      session: authSession({ impersonatedBy: 'admin-1' }),
    });
    getSessionMock.mockResolvedValue(authSession({ impersonatedBy: 'admin-1' }));

    const data = await load('/student/test-class/dashboard');

    expect((data.session as { session: Row }).session.impersonatedBy).toBe('admin-1');
  });

  it('returns only the top-level fields the app reads, signed in or not', async () => {
    const signedIn = await load('/student/test-class/dashboard');
    expect(Object.keys(signedIn).sort()).toEqual(
      [
        'aiAgentAvailable',
        'gitMode',
        'impersonationCookieDomain',
        'impersonationReturnUrl',
        'memberships',
        'organizations',
        'session',
        'user',
      ].sort()
    );

    getAuthSessionMock.mockResolvedValue(null);
    getSessionMock.mockResolvedValue(null);
    const signedOut = await load('/');
    expect(Object.keys(signedOut).sort()).toEqual(['memberships', 'organizations', 'user']);

    expect(await load('/test-class/pages/page-1')).toEqual({ user: null });
  });
});
