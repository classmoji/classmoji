/**
 * Unit tests for GitHub App installation repair.
 *
 * 45 orgs with real classrooms carry a NULL `github_installation_id`, and every
 * path that tries to put one back is a chance to put back the WRONG one. These
 * tests are mostly about refusals:
 *
 *  - a login is not an identity. GitHub org logins are renamed and recycled, so
 *    `GET /orgs/{login}/installation` answering 200 proves nothing until the
 *    account id matches. Adopting that answer would hand one customer's org to
 *    whoever now owns the name.
 *  - "not installed" may only be concluded after the account-id scan comes up
 *    empty; a 404 on the login alone means the login moved, not that the app is
 *    gone.
 *  - the write is conditional on the column still being NULL, because the
 *    repair races the `installation.created` webhook and the user's other tabs.
 *  - a rate limit is not a "no". It has to surface as "try again in N", never
 *    as "go install the app".
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  upsert: vi.fn(),
  getOrgInstallation: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: {
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
      upsert: (...a: unknown[]) => mocks.upsert(...a),
    },
  }),
}));

const { GitHubProvider } = await import('../../git/GitHubProvider.ts');
const {
  GitHubRateLimitedError,
  validateInstallationIdentity,
  lookupInstallationForOrg,
  listAppInstallations,
  claimInstallationIfNull,
  clearInstallationIfMatches,
  repairInstallation,
  syncUserInstallations,
  __resetRepairThrottleForTests,
  __repairCooldownCountForTests,
} = await import('../gitOrganization.service.ts');

const APP_ID = '424242';
const APP_SLUG = 'classmoji-test';
const PROVIDER_ID = '9001';
const INSTALLATION_ID = 55501;
const ORG_ID = 'git-org-uuid-1';

const installation = (overrides: Record<string, unknown> = {}) => ({
  id: INSTALLATION_ID,
  app_id: Number(APP_ID),
  app_slug: APP_SLUG,
  suspended_at: null,
  account: {
    id: Number(PROVIDER_ID),
    login: 'dartmouth-cs',
    type: 'Organization',
    avatar_url: 'https://avatars.example/1',
  },
  ...overrides,
});

/** A GitOrganization row with no installation id — the thing being repaired. */
const disconnectedOrg = (overrides: Record<string, unknown> = {}) => ({
  id: ORG_ID,
  provider: 'GITHUB',
  provider_id: PROVIDER_ID,
  login: 'dartmouth-cs',
  github_installation_id: null,
  ...overrides,
});

const octokitStub = () =>
  ({
    rest: {
      apps: {
        getOrgInstallation: mocks.getOrgInstallation,
        listInstallations: 'LIST',
        listInstallationsForAuthenticatedUser: 'USER_LIST',
      },
    },
    paginate: mocks.paginate,
  }) as never;

const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`http ${status}`), { status, response: { headers } });

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.updateMany.mockReset();
  mocks.upsert.mockReset().mockResolvedValue({});
  mocks.getOrgInstallation.mockReset();
  mocks.paginate.mockReset().mockResolvedValue([]);
  process.env.GITHUB_APP_ID = APP_ID;
  process.env.GITHUB_APP_NAME = APP_SLUG;
  __resetRepairThrottleForTests();
  vi.spyOn(GitHubProvider, 'getAppOctokit').mockReturnValue(octokitStub());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('validateInstallationIdentity', () => {
  it('accepts a live organization installation of this app', () => {
    const result = validateInstallationIdentity(installation(), { providerId: PROVIDER_ID });
    expect(result).toEqual({
      ok: true,
      synced: {
        provider_id: PROVIDER_ID,
        login: 'dartmouth-cs',
        github_installation_id: String(INSTALLATION_ID),
        avatar_url: 'https://avatars.example/1',
      },
    });
  });

  it('refuses a personal-account installation', () => {
    const result = validateInstallationIdentity(
      installation({ account: { id: Number(PROVIDER_ID), login: 'someone', type: 'User' } }),
      { providerId: PROVIDER_ID }
    );
    expect(result).toEqual({ ok: false, reason: 'not-organization' });
  });

  it('refuses an installation belonging to a different account', () => {
    const result = validateInstallationIdentity(installation(), { providerId: '7777' });
    expect(result).toEqual({ ok: false, reason: 'account-mismatch' });
  });

  it('refuses another app id', () => {
    const result = validateInstallationIdentity(installation({ app_id: 111 }), {
      providerId: PROVIDER_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong-app' });
  });

  it('refuses another app slug', () => {
    const result = validateInstallationIdentity(installation({ app_slug: 'someone-elses-app' }), {
      providerId: PROVIDER_ID,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong-app' });
  });

  it('matches the app slug regardless of case or stray whitespace', () => {
    // GITHUB_APP_NAME is hand-entered per environment; a capital letter or a
    // trailing space in the secret must not read as "somebody else's app" and
    // disconnect every org on the platform.
    process.env.GITHUB_APP_NAME = `  ${APP_SLUG.toUpperCase()} `;

    const result = validateInstallationIdentity(installation({ app_slug: APP_SLUG }), {
      providerId: PROVIDER_ID,
    });

    expect(result).toMatchObject({ ok: true });
  });

  it('still refuses an installation with no app slug at all when one is expected', () => {
    const result = validateInstallationIdentity(installation({ app_slug: undefined }), {
      providerId: PROVIDER_ID,
    });

    expect(result).toEqual({ ok: false, reason: 'wrong-app' });
  });

  it('skips the slug check when GITHUB_APP_NAME is not configured', () => {
    delete process.env.GITHUB_APP_NAME;
    const result = validateInstallationIdentity(installation({ app_slug: 'anything' }), {
      providerId: PROVIDER_ID,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('refuses a suspended installation', () => {
    const result = validateInstallationIdentity(
      installation({ suspended_at: '2026-09-01T00:00:00Z' }),
      { providerId: PROVIDER_ID }
    );
    expect(result).toEqual({ ok: false, reason: 'suspended' });
  });
});

describe('lookupInstallationForOrg', () => {
  const org = { provider_id: PROVIDER_ID, login: 'dartmouth-cs' };

  it('finds the installation from the login lookup', async () => {
    mocks.getOrgInstallation.mockResolvedValue({ data: installation() });

    const result = await lookupInstallationForOrg(octokitStub(), org);

    expect(result).toMatchObject({ status: 'found' });
    expect(mocks.paginate).not.toHaveBeenCalled();
  });

  it('falls back to the account-id scan when the login 404s', async () => {
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.paginate.mockResolvedValue([installation({ account: { ...installation().account } })]);

    const result = await lookupInstallationForOrg(octokitStub(), org);

    expect(result).toMatchObject({ status: 'found' });
    expect(mocks.paginate).toHaveBeenCalledWith('LIST', { per_page: 100 });
  });

  it('never adopts the installation of the account that now holds the login', async () => {
    // The login resolves, but to a different account — and no installation
    // anywhere carries our account id. That is a moved org, not a repair.
    mocks.getOrgInstallation.mockResolvedValue({
      data: installation({
        account: { id: 424243, login: 'dartmouth-cs', type: 'Organization', avatar_url: '' },
      }),
    });
    mocks.paginate.mockResolvedValue([]);

    const result = await lookupInstallationForOrg(octokitStub(), org);

    expect(result).toEqual({ status: 'login-moved' });
  });

  it('still finds us by account id when someone else took our login', async () => {
    mocks.getOrgInstallation.mockResolvedValue({
      data: installation({
        account: { id: 424243, login: 'dartmouth-cs', type: 'Organization', avatar_url: '' },
      }),
    });
    mocks.paginate.mockResolvedValue([
      installation({
        account: {
          id: Number(PROVIDER_ID),
          login: 'dartmouth-cs-2',
          type: 'Organization',
          avatar_url: '',
        },
      }),
    ]);

    const result = await lookupInstallationForOrg(octokitStub(), org);

    expect(result).toMatchObject({ status: 'found', synced: { login: 'dartmouth-cs-2' } });
  });

  it('uses a preloaded installation list instead of re-paginating', async () => {
    // What makes a 45-org sweep affordable: the account-id scan is read once
    // per run and handed in, not repeated per org.
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));

    const result = await lookupInstallationForOrg(octokitStub(), org, {
      installations: [installation()],
    });

    expect(result).toMatchObject({ status: 'found' });
    expect(mocks.paginate).not.toHaveBeenCalled();
  });

  it('reports not-installed only after the id scan comes up empty', async () => {
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.paginate.mockResolvedValue([]);

    const result = await lookupInstallationForOrg(octokitStub(), org);

    expect(result).toEqual({ status: 'not-installed' });
  });

  it('reports suspended rather than not-installed', async () => {
    mocks.getOrgInstallation.mockResolvedValue({
      data: installation({ suspended_at: '2026-09-01T00:00:00Z' }),
    });
    mocks.paginate.mockResolvedValue([installation({ suspended_at: '2026-09-01T00:00:00Z' })]);

    const result = await lookupInstallationForOrg(octokitStub(), org);

    expect(result).toEqual({ status: 'suspended' });
  });

  it('raises a typed rate-limit error on a primary limit (403 + remaining 0)', async () => {
    const reset = Math.floor(Date.now() / 1000) + 90;
    mocks.getOrgInstallation.mockRejectedValue(
      httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
    );

    await expect(lookupInstallationForOrg(octokitStub(), org)).rejects.toBeInstanceOf(
      GitHubRateLimitedError
    );
    expect(mocks.paginate).not.toHaveBeenCalled();
  });

  it('raises a typed rate-limit error on a secondary limit (429 + retry-after)', async () => {
    mocks.getOrgInstallation.mockRejectedValue(httpError(429, { 'retry-after': '30' }));

    await expect(lookupInstallationForOrg(octokitStub(), org)).rejects.toMatchObject({
      name: 'GitHubRateLimitedError',
      retryAfterSeconds: 30,
    });
  });

  it('propagates a non-404, non-rate-limit failure', async () => {
    mocks.getOrgInstallation.mockRejectedValue(httpError(500));

    await expect(lookupInstallationForOrg(octokitStub(), org)).rejects.toThrow('http 500');
  });
});

describe('listAppInstallations', () => {
  it('paginates the app-wide installation list', async () => {
    mocks.paginate.mockResolvedValue([installation()]);

    await expect(listAppInstallations(octokitStub())).resolves.toEqual([installation()]);
    expect(mocks.paginate).toHaveBeenCalledWith('LIST', { per_page: 100 });
  });

  it('reports a throttle as a rate limit rather than a bare 403', async () => {
    // A sweep preloads this list once; if a throttle here came back as a
    // generic failure the sweep would report `error` and lose the retry-after.
    mocks.paginate.mockRejectedValue(httpError(403, { 'retry-after': '61' }));

    await expect(listAppInstallations(octokitStub())).rejects.toMatchObject({
      name: 'GitHubRateLimitedError',
      retryAfterSeconds: 61,
    });
  });
});

describe('claimInstallationIfNull', () => {
  const args = {
    orgId: ORG_ID,
    providerId: PROVIDER_ID,
    installationId: String(INSTALLATION_ID),
    login: 'dartmouth-cs',
  };

  it('writes only while the column is still NULL', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(claimInstallationIfNull(args)).resolves.toEqual({ claimed: true });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: ORG_ID,
        provider: 'GITHUB',
        provider_id: PROVIDER_ID,
        github_installation_id: null,
      },
      data: { github_installation_id: String(INSTALLATION_ID), login: 'dartmouth-cs' },
    });
  });

  it('rereads the row when somebody else claimed it first', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const winner = disconnectedOrg({ github_installation_id: '77777' });
    mocks.findUnique.mockResolvedValue(winner);

    await expect(claimInstallationIfNull(args)).resolves.toEqual({
      claimed: false,
      current: winner,
    });
  });
});

describe('clearInstallationIfMatches', () => {
  it('scopes the clear to the installation that was actually removed', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      clearInstallationIfMatches({ providerId: PROVIDER_ID, installationId: '55501' })
    ).resolves.toBe(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        provider: 'GITHUB',
        provider_id: PROVIDER_ID,
        github_installation_id: '55501',
      },
      data: { github_installation_id: null },
    });
  });

  it('clears nothing when the stored id has already moved on', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      clearInstallationIfMatches({ providerId: PROVIDER_ID, installationId: '55501' })
    ).resolves.toBe(0);
  });
});

describe('repairInstallation', () => {
  it('connects an org whose installation is live', async () => {
    const repaired = disconnectedOrg({ github_installation_id: String(INSTALLATION_ID) });
    mocks.findUnique.mockResolvedValueOnce(disconnectedOrg()).mockResolvedValueOnce(repaired);
    mocks.getOrgInstallation.mockResolvedValue({ data: installation() });
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({
      status: 'connected',
      org: repaired,
    });
  });

  it('short-circuits an org that already has an installation id', async () => {
    const connected = disconnectedOrg({ github_installation_id: '123' });
    mocks.findUnique.mockResolvedValue(connected);

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({
      status: 'already-connected',
      org: connected,
    });
    expect(mocks.getOrgInstallation).not.toHaveBeenCalled();
  });

  it('reports already-connected when the conditional write loses the race', async () => {
    const winner = disconnectedOrg({ github_installation_id: '77777' });
    mocks.findUnique.mockResolvedValueOnce(disconnectedOrg()).mockResolvedValueOnce(winner);
    mocks.getOrgInstallation.mockResolvedValue({ data: installation() });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({
      status: 'already-connected',
      org: winner,
    });
  });

  it('refuses a non-GitHub org without calling GitHub', async () => {
    mocks.findUnique.mockResolvedValue(disconnectedOrg({ provider: 'GITLAB' }));

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({ status: 'not-github' });
    expect(mocks.getOrgInstallation).not.toHaveBeenCalled();
  });

  it('passes a not-installed lookup straight through', async () => {
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.paginate.mockResolvedValue([]);

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({ status: 'not-installed' });
  });

  it('turns a GitHub rate limit into a retry-after answer, not a refusal', async () => {
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(httpError(429, { 'retry-after': '42' }));

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({
      status: 'rate-limited',
      retryAfterSeconds: 42,
    });
  });

  it('reports an unexpected failure as an error', async () => {
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(httpError(500));

    await expect(repairInstallation(ORG_ID)).resolves.toMatchObject({ status: 'error' });
  });

  it('refuses a second lookup for the same org inside the cooldown', async () => {
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.paginate.mockResolvedValue([]);

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({ status: 'not-installed' });

    const second = await repairInstallation(ORG_ID);
    expect(second).toMatchObject({ status: 'rate-limited' });
    expect(mocks.getOrgInstallation).toHaveBeenCalledTimes(1);
  });

  it('serves concurrent callers from one in-flight lookup', async () => {
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.paginate.mockResolvedValue([]);

    const [a, b, c] = await Promise.all([
      repairInstallation(ORG_ID),
      repairInstallation(ORG_ID),
      repairInstallation(ORG_ID),
    ]);

    expect([a, b, c]).toEqual([
      { status: 'not-installed' },
      { status: 'not-installed' },
      { status: 'not-installed' },
    ]);
    expect(mocks.getOrgInstallation).toHaveBeenCalledTimes(1);
  });

  it('does not spend the cooldown on an org it never asked GitHub about', async () => {
    const connected = disconnectedOrg({ github_installation_id: '123' });
    mocks.findUnique.mockResolvedValue(connected);

    await repairInstallation(ORG_ID);
    await expect(repairInstallation(ORG_ID)).resolves.toMatchObject({
      status: 'already-connected',
    });
  });

  it('surfaces a 403 rate limit immediately instead of sleeping until reset', async () => {
    // The `octokit` umbrella's throttling plugin would answer a primary limit
    // by scheduling a retry for time-until-reset — up to an hour — inside a
    // request handler. `getAppOctokit` disables that, so the 403 arrives here
    // with its headers and becomes a retry-after answer. Fake timers make the
    // regression loud: if anything waits, nothing resolves and no timer is
    // pending to explain why.
    vi.useFakeTimers();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(
      httpError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
    );

    // No timer is advanced anywhere in this test.
    const result = await repairInstallation(ORG_ID);

    expect(result).toEqual({ status: 'rate-limited', retryAfterSeconds: 3600 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures the cooldown from when the lookup finished, not when it started', async () => {
    vi.useFakeTimers();
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.paginate.mockResolvedValue([]);

    let finish: () => void = () => {};
    mocks.getOrgInstallation.mockImplementation(
      () =>
        new Promise((_resolve, rejectLookup) => {
          finish = () => rejectLookup(httpError(404));
        })
    );

    const first = repairInstallation(ORG_ID);
    // GitHub takes 14s to answer. Stamped only at the start, the cooldown would
    // now have one second left on it and the next click would sail through.
    await vi.advanceTimersByTimeAsync(14_000);
    finish();
    await expect(first).resolves.toEqual({ status: 'not-installed' });

    const second = await repairInstallation(ORG_ID);

    expect(second).toEqual({ status: 'rate-limited', retryAfterSeconds: 15 });
    expect(mocks.getOrgInstallation).toHaveBeenCalledTimes(1);
  });

  it('drops expired cooldown stamps rather than holding one per org forever', async () => {
    vi.useFakeTimers();
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.paginate.mockResolvedValue([]);

    await repairInstallation('org-a');
    await repairInstallation('org-b');
    expect(__repairCooldownCountForTests()).toBe(2);

    await vi.advanceTimersByTimeAsync(16_000);
    await repairInstallation('org-c');

    // a and b expired and were swept on the way in; only c's stamp is live.
    expect(__repairCooldownCountForTests()).toBe(1);
  });

  it('lets a sweep past the local cooldown with bypassCooldown', async () => {
    // A re-triggered sweep asks about each org once per run; being refused
    // because the previous run (or the instructor's own button) touched the
    // same org seconds ago would abort the repair for no benefit.
    mocks.findUnique.mockResolvedValue(disconnectedOrg());
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.paginate.mockResolvedValue([]);

    await expect(repairInstallation(ORG_ID)).resolves.toEqual({ status: 'not-installed' });
    await expect(repairInstallation(ORG_ID, { bypassCooldown: true })).resolves.toEqual({
      status: 'not-installed',
    });

    expect(mocks.getOrgInstallation).toHaveBeenCalledTimes(2);
  });

  it('reuses a caller-supplied Octokit and installation list', async () => {
    const repaired = disconnectedOrg({ github_installation_id: String(INSTALLATION_ID) });
    mocks.findUnique.mockResolvedValueOnce(disconnectedOrg()).mockResolvedValueOnce(repaired);
    mocks.getOrgInstallation.mockRejectedValue(httpError(404));
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repairInstallation(ORG_ID, {
        appOctokit: octokitStub(),
        installations: [installation()],
      })
    ).resolves.toEqual({ status: 'connected', org: repaired });

    // Neither a fresh app client nor a fresh paginated scan per org.
    expect(GitHubProvider.getAppOctokit).not.toHaveBeenCalled();
    expect(mocks.paginate).not.toHaveBeenCalled();
  });
});

describe('syncUserInstallations', () => {
  const otherAccount = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    login: `org-${id}`,
    type: 'Organization',
    avatar_url: '',
    ...overrides,
  });

  it('upserts only the installations that pass the identity gate', async () => {
    // `GET /user/installations` is scoped to the USER, so it lists every
    // installation they administer — other apps included — and suspended ones.
    // Writing those straight through is how an org ends up "connected" to an id
    // that mints no token.
    mocks.paginate.mockResolvedValue([
      installation(),
      installation({ id: 2, suspended_at: '2026-09-01T00:00:00Z', account: otherAccount(9002) }),
      installation({ id: 3, app_slug: 'some-other-app', account: otherAccount(9003) }),
      installation({ id: 4, account: otherAccount(9004, { type: 'User' }) }),
    ]);

    const synced = await syncUserInstallations(octokitStub());

    expect(synced).toEqual([
      {
        provider_id: PROVIDER_ID,
        login: 'dartmouth-cs',
        github_installation_id: String(INSTALLATION_ID),
        avatar_url: 'https://avatars.example/1',
      },
    ]);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_provider_id: { provider: 'GITHUB', provider_id: PROVIDER_ID } },
      })
    );
    // The suspended and wrong-app rows are worth a line each; a personal
    // account is the documented filter, not an anomaly, so it stays quiet.
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
