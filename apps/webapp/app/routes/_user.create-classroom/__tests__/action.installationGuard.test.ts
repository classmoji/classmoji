import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The installation guard inside the create-classroom action.
 *
 * It is the last thing standing between a GitOrganization row with no
 * `github_installation_id` and a half-built classroom: `getGitProvider` throws
 * on such a row, and it throws AFTER the transaction has created the classroom,
 * its settings and the owner membership — leaving a wreck that also holds the
 * slug the retry wants.
 *
 * Two properties are pinned here, both of which used to be wrong.
 *
 * 1. The repair is asked with `bypassCooldown`. The service keeps a 15 s
 *    per-org cooldown for mashed buttons; honouring it on a deliberate form
 *    submit made the action say "GitHub is rate limiting" about a limit that
 *    only ever existed in this process, with GitHub never asked.
 * 2. A repaired row whose `login` has MOVED is refused. The org-admin check
 *    upstream ran against the old login; adopting the new one would provision
 *    into an organization nobody verified this user administers.
 */

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  getAuthenticated: vi.fn(),
  findByLogin: vi.fn(),
  repairInstallation: vi.fn(),
  graphql: vi.fn(),
  findUniqueGitOrg: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
}));

// `checkAuth` normally resolves the session and injects `user`; the action here
// never reads that argument, so the wrapper is the identity.
vi.mock('~/utils/helpers', () => ({
  checkAuth: (fn: (args: unknown) => unknown) => fn,
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findByLogin: (...a: unknown[]) => mocks.findByLogin(...a) },
    gitOrganization: {
      repairInstallation: (...a: unknown[]) => mocks.repairInstallation(...a),
    },
  },
  ClassroomSlugUnavailableError: class ClassroomSlugUnavailableError extends Error {},
  GitHubProvider: {
    getUserOctokit: () => ({
      rest: { users: { getAuthenticated: (...a: unknown[]) => mocks.getAuthenticated(...a) } },
      graphql: (...a: unknown[]) => mocks.graphql(...a),
    }),
  },
  createWithUniqueClassroomSlug: vi.fn(),
  describeTokenMintError: vi.fn(() => 'mint failed'),
  getGitProvider: vi.fn(),
  ensureClassroomTeam: vi.fn(),
}));

vi.mock('@classmoji/services/import-progress', () => ({
  applyPhaseUpdates: vi.fn(),
  buildInitialProgress: vi.fn(),
  buildSummaryParts: vi.fn(),
  withCounts: vi.fn(),
  withIdMaps: vi.fn(),
}));

vi.mock('@classmoji/tasks', () => ({ default: {} }));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: { findUnique: (...a: unknown[]) => mocks.findUniqueGitOrg(...a) },
    classroom: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

vi.mock('@classmoji/utils', () => ({
  defaultContentRepoName: vi.fn((ns: string) => `content-${ns}`),
  sanitizeRepoName: vi.fn((n: string) => n),
  suggestContentNamespace: vi.fn(({ slug }: { slug: string }) => slug),
}));

vi.mock('~/constants', () => ({ ActionTypes: {} }));

const { action } = await import('../action.ts');

const GIT_ORG = {
  id: 'org-1',
  provider: 'GITHUB',
  login: 'cs52-org',
  github_installation_id: null,
};

/**
 * The name deliberately slugifies to nothing. The slug check sits immediately
 * AFTER the guard, so its refusal is the cheapest available proof that the
 * guard let the request through — without dragging the whole provisioning
 * transaction into a unit test.
 */
const PAST_THE_GUARD =
  'That name has no letters or numbers to build a URL from — add some, or set a slug';

const call = (body: Record<string, unknown> = {}) =>
  (
    action as unknown as (args: { request: Request; params: Record<string, string> }) => Promise<{
      error?: string;
    }>
  )({
    request: new Request('http://localhost/create-classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_org_id: 'org-1', name: '???', ...body }),
    }),
    params: {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({ userId: 'user-1', token: 'gh-token' });
  mocks.getAuthenticated.mockResolvedValue({ data: { login: 'instructor' } });
  mocks.findByLogin.mockResolvedValue({ id: 'user-1', login: 'instructor' });
  mocks.findUniqueGitOrg.mockResolvedValue({ ...GIT_ORG });
  mocks.graphql.mockResolvedValue({
    organization: { login: 'cs52-org', viewerCanAdminister: true },
  });
  mocks.repairInstallation.mockResolvedValue({
    status: 'connected',
    org: { ...GIT_ORG, github_installation_id: '4242' },
  });
});

describe('create-classroom installation guard', () => {
  it('bypasses the local cooldown — a form submit is deliberate, not a poll', async () => {
    await call();
    expect(mocks.repairInstallation).toHaveBeenCalledWith('org-1', { bypassCooldown: true });
  });

  it('carries on once the repair hands back an installation id', async () => {
    const result = await call();
    expect(result.error).toBe(PAST_THE_GUARD);
  });

  it('refuses when the repaired row came back under a different login', async () => {
    mocks.repairInstallation.mockResolvedValue({
      status: 'connected',
      org: { ...GIT_ORG, login: 'cs52-org-renamed', github_installation_id: '4242' },
    });

    const result = await call();
    expect(result.error).toBe(
      'The GitHub organization for this classroom has changed name; reload and try again.'
    );
  });

  // `already-connected` is the same adoption path, and the same trap.
  it('refuses a moved login on an already-connected answer too', async () => {
    mocks.repairInstallation.mockResolvedValue({
      status: 'already-connected',
      org: { ...GIT_ORG, login: 'somewhere-else', github_installation_id: '4242' },
    });

    const result = await call();
    expect(result.error).toBe(
      'The GitHub organization for this classroom has changed name; reload and try again.'
    );
  });

  it('names GitHub in the rate-limited message, since only GitHub can cause it now', async () => {
    mocks.repairInstallation.mockResolvedValue({ status: 'rate-limited', retryAfterSeconds: 37 });

    const result = await call();
    expect(result.error).toBe(
      'GitHub is rate limiting installation checks; try again in 37 seconds.'
    );
  });

  it('asks the owner to install the app on every other outcome', async () => {
    for (const status of ['not-installed', 'suspended', 'wrong-app', 'not-found', 'error']) {
      mocks.repairInstallation.mockResolvedValue({ status });
      const result = await call();
      expect(result.error).toBe(
        'Connect the Classmoji GitHub app to cs52-org before creating a classroom.'
      );
    }
  });

  // A "connected" answer carrying no id is a contradiction, and adopting it
  // would put the wreck back — the guard exists to keep that row out.
  it('refuses a connected answer that carries no installation id', async () => {
    mocks.repairInstallation.mockResolvedValue({ status: 'connected', org: { ...GIT_ORG } });

    const result = await call();
    expect(result.error).toBe(
      'Connect the Classmoji GitHub app to cs52-org before creating a classroom.'
    );
  });

  it('never asks about an org that already has an installation id', async () => {
    mocks.findUniqueGitOrg.mockResolvedValue({ ...GIT_ORG, github_installation_id: '99' });

    const result = await call();
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
    expect(result.error).toBe(PAST_THE_GUARD);
  });

  it('never asks about a non-GitHub org', async () => {
    mocks.findUniqueGitOrg.mockResolvedValue({ ...GIT_ORG, provider: 'GITLAB' });

    await call();
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });
});
