import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Quiz import on create-classroom follows whether the NEW classroom shows
 * quizzes: the AI agent is configured and `entitlement.quizzesVisible` holds
 * (Pro, quizzes not switched off).
 *
 * The wizard offers "Include Quizzes" to Pro creators only, where the agent is
 * configured, but the flag arrives in the request body, so the action decides
 * again once the classroom and its owner membership exist, and after the
 * settings copy — a copied `quizzes_enabled: false` counts. Hidden quizzes (or
 * a failed lookup) mean every repository is cloned with `includeQuizzes:
 * false`. The flag is cleared on the configs the job row also stores, so the
 * background import cannot bring it back either.
 *
 * `~/utils/classroomProFlag.server` is NOT mocked: the action's answer comes
 * from the real helper, over the agent check and the entitlement service.
 */

const mocks = vi.hoisted(() => ({
  isAIAgentConfigured: vi.fn(),
  getAuthSession: vi.fn(),
  findByLogin: vi.fn(),
  membershipCreate: vi.fn(),
  quizzesVisible: vi.fn(),
  importClassroomConfig: vi.fn(),
  cloneModulesWithRelations: vi.fn(),
  importJobCreate: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
}));

// `checkAuth` normally resolves the session; the action never reads what it
// injects, so the wrapper is the identity.
vi.mock('~/utils/helpers', () => ({
  checkAuth: (fn: (args: unknown) => unknown) => fn,
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => mocks.isAIAgentConfigured(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findByLogin: (...a: unknown[]) => mocks.findByLogin(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
    classroomConfigImport: {
      importClassroomConfig: (...a: unknown[]) => mocks.importClassroomConfig(...a),
    },
    repositoryImport: {
      cloneModulesWithRelations: (...a: unknown[]) => mocks.cloneModulesWithRelations(...a),
    },
    emojiMapping: { ensureDefaultScale: vi.fn().mockResolvedValue(undefined) },
    templateImport: { groupTemplateRefs: vi.fn(() => []) },
  },
  ClassroomSlugUnavailableError: class ClassroomSlugUnavailableError extends Error {},
  GitHubProvider: {
    getUserOctokit: () => ({
      rest: {
        users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'instructor' } }) },
        // The content repo does not exist yet — the normal path to creation.
        repos: { get: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { status: 404 })) },
      },
      graphql: vi.fn().mockResolvedValue({
        organization: { login: 'cs52-org', viewerCanAdminister: true },
      }),
    }),
  },
  // The transaction runs for real against the fake `tx` below.
  createWithUniqueClassroomSlug: async (
    _opts: unknown,
    build: (slug: string) => Promise<unknown>
  ) => ({ result: await build('web-dev') }),
  describeTokenMintError: vi.fn(() => 'mint failed'),
  getGitProvider: vi.fn(),
  ensureClassroomTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@classmoji/services/import-progress', () => ({
  applyPhaseUpdates: vi.fn(() => ({})),
  buildInitialProgress: vi.fn(() => ({})),
  buildSummaryParts: vi.fn(() => []),
  withCounts: vi.fn(() => ({})),
  withIdMaps: vi.fn(() => ({})),
}));

vi.mock('@classmoji/tasks', () => ({ default: {} }));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'org-1',
        provider: 'GITHUB',
        login: 'cs52-org',
        github_installation_id: '99',
      }),
    },
    classroom: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // The requester owns the source classroom.
    classroomMembership: { findMany: vi.fn().mockResolvedValue([{ role: 'OWNER' }]) },
    repository: {
      findMany: vi.fn().mockResolvedValue([{ id: 'repo-1', template: null }, { id: 'repo-2' }]),
    },
    importJob: {
      create: (...a: unknown[]) => mocks.importJobCreate(...a),
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        classroom: {
          create: vi.fn().mockResolvedValue({ id: 'new-classroom', slug: 'web-dev' }),
        },
        classroomSettings: { create: vi.fn().mockResolvedValue({}) },
        classroomMembership: { create: (...a: unknown[]) => mocks.membershipCreate(...a) },
      }),
  }),
}));

vi.mock('@classmoji/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@classmoji/utils')>()),
  defaultContentRepoName: vi.fn((ns: string) => `content-${ns}`),
  sanitizeRepoName: vi.fn((n: string) => n),
  suggestContentNamespace: vi.fn(({ slug }: { slug: string }) => slug),
}));

vi.mock('~/constants', () => ({ ActionTypes: {} }));

const { action } = await import('../action.ts');

const REPOS = [
  { id: 'repo-1', includeQuizzes: true },
  { id: 'repo-2', includeQuizzes: false },
];

const call = (
  repositories: Array<{ id: string; includeQuizzes?: boolean }> = REPOS,
  config: Record<string, boolean> = {}
) =>
  (
    action as unknown as (args: { request: Request; params: Record<string, string> }) => Promise<{
      error?: string;
      success?: string;
    }>
  )({
    request: new Request('http://localhost/create-classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        git_org_id: 'org-1',
        name: 'Web Dev',
        importConfig: {
          sourceClassroomId: 'source-1',
          repositories,
          config,
          // Modules alone: pure DB here, and enough to write the job row.
          content: { modules: true },
        },
      }),
    }),
    params: {},
  });

/** The repository configs as the clone saw them, and as the job row stored them. */
const clonedConfigs = () => mocks.cloneModulesWithRelations.mock.calls[0]?.[1];
const storedConfigs = () =>
  (mocks.importJobCreate.mock.calls[0]?.[0] as { data: { selections: { repositories: unknown } } })
    .data.selections.repositories;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TRIGGER_SECRET_KEY', '');
  vi.stubEnv('TRIGGER_ACCESS_TOKEN', '');
  mocks.isAIAgentConfigured.mockReturnValue(true);
  mocks.getAuthSession.mockResolvedValue({ userId: 'user-1', token: 'gh-token' });
  mocks.findByLogin.mockResolvedValue({ id: 'user-1', login: 'instructor' });
  mocks.membershipCreate.mockResolvedValue({});
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.importClassroomConfig.mockResolvedValue({
    settings_fields: [],
    emoji_mappings: 0,
    letter_grade_mappings: 0,
    calendar_events: 0,
  });
  mocks.cloneModulesWithRelations.mockResolvedValue({
    repositories: [{ id: 'new-repo-1' }, { id: 'new-repo-2' }],
    assignments: [],
    quizzes: [],
    idMaps: { repositories: {}, quizzes: {} },
  });
  mocks.importJobCreate.mockResolvedValue({ id: 'job-1' });
});

describe('create-classroom quiz import', () => {
  const CLEARED = [
    { id: 'repo-1', includeQuizzes: false },
    { id: 'repo-2', includeQuizzes: false },
  ];

  it('clears includeQuizzes where the new classroom hides quizzes, in the clone and the job row', async () => {
    mocks.quizzesVisible.mockResolvedValue(false);

    const result = await call();

    expect(result.error).toBeUndefined();
    expect(clonedConfigs()).toEqual(CLEARED);
    expect(storedConfigs()).toEqual(CLEARED);
  });

  it('keeps the flags as asked where the new classroom shows quizzes', async () => {
    await call();

    expect(clonedConfigs()).toEqual(REPOS);
    expect(storedConfigs()).toEqual(REPOS);
  });

  it('clears includeQuizzes without asking the entitlement when the AI agent is not configured', async () => {
    mocks.isAIAgentConfigured.mockReturnValue(false);

    const result = await call();

    expect(result.error).toBeUndefined();
    expect(clonedConfigs()).toEqual(CLEARED);
    expect(storedConfigs()).toEqual(CLEARED);
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });

  it('decides on the classroom just created, after its owner membership exists', async () => {
    mocks.quizzesVisible.mockResolvedValue(false);

    await call();

    expect(mocks.quizzesVisible).toHaveBeenCalledExactlyOnceWith('new-classroom');
    expect(mocks.membershipCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        classroom_id: 'new-classroom',
        role: 'OWNER',
        has_accepted_invite: true,
      }),
    });
    expect(mocks.membershipCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.quizzesVisible.mock.invocationCallOrder[0]
    );
  });

  it('decides after the settings copy, so a copied quizzes switch counts', async () => {
    // The copy may carry `quizzes_enabled: false` from the source classroom;
    // asking before it had landed would read the new classroom's default.
    await call(REPOS, { settings: true });

    expect(mocks.importClassroomConfig).toHaveBeenCalledOnce();
    expect(mocks.importClassroomConfig.mock.calls[0][1]).toBe('new-classroom');
    expect(mocks.importClassroomConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.quizzesVisible.mock.invocationCallOrder[0]
    );
  });

  it('copies no quizzes when the visibility lookup fails, and still creates the classroom', async () => {
    mocks.quizzesVisible.mockRejectedValue(new Error('db down'));

    const result = await call();

    expect(result.error).toBeUndefined();
    expect(result.success).toBeDefined();
    expect(clonedConfigs()).toEqual(CLEARED);
  });

  it('skips the lookup when no quizzes were asked for', async () => {
    const plain = [{ id: 'repo-1', includeQuizzes: false }, { id: 'repo-2' }];

    await call(plain);

    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
    expect(clonedConfigs()).toEqual(plain);
  });
});
