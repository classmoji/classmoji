/**
 * Unit tests for the four GitHub App installation webhooks.
 *
 * Both tasks write the column that decides whether a classroom can talk to
 * GitHub at all, and both are fed by deliveries that GitHub retries, delays and
 * replays. So the thing under test is not the happy path — it is what happens
 * when the delivery is a lie:
 *
 *  - `created` for an installation that has since been removed (404) must write
 *    nothing, or the org ends up pointing at an id that mints no token;
 *  - `created` whose live account does not match the payload's must write
 *    nothing, or one customer's org gets another's installation;
 *  - `deleted` must only clear the installation it names, or a replayed
 *    uninstall silently disconnects an org that has since reinstalled;
 *  - `suspend` is an uninstall for our purposes — a suspended installation
 *    mints no tokens — and has to be scoped the same way;
 *  - `unsuspend` puts the id back, but only after re-reading live state, so a
 *    replayed unsuspend for an installation since removed writes nothing.
 *
 * The GitHub call is stubbed at `GitHubProvider.getAppOctokit`; the identity
 * validation and the conditional clear are the REAL implementations from
 * `@classmoji/services`, running against a mocked Prisma client.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  updateMany: vi.fn(),
  getInstallation: vi.fn(),
}));

// `task()` normally returns a trigger handle; return the config so the test can
// call `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: {
      upsert: (...a: unknown[]) => mocks.upsert(...a),
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
    },
  }),
}));

const { GitHubProvider } = await import('@classmoji/services');
const {
  newInstallationHandlerTask,
  appUninstalledHandlerTask,
  appSuspendedHandlerTask,
  appUnsuspendedHandlerTask,
} = await import('../installation.ts');

const APP_ID = '424242';
const APP_SLUG = 'classmoji-test';
const ACCOUNT_ID = 9001;
const INSTALLATION_ID = 55501;

/** A live installation as `GET /app/installations/{id}` would return it. */
const liveInstallation = (overrides: Record<string, unknown> = {}) => ({
  id: INSTALLATION_ID,
  app_id: Number(APP_ID),
  app_slug: APP_SLUG,
  suspended_at: null,
  account: {
    id: ACCOUNT_ID,
    login: 'dartmouth-cs',
    type: 'Organization',
    avatar_url: 'https://avatars.example/1',
  },
  ...overrides,
});

const payload = () => ({
  installation: {
    id: INSTALLATION_ID,
    account: { id: ACCOUNT_ID, login: 'dartmouth-cs' },
  },
});

const runCreated = (p = payload()) =>
  (
    newInstallationHandlerTask as unknown as {
      run: (payload: unknown) => Promise<{ success: boolean; skipped?: string }>;
    }
  ).run(p);

const runDeleted = (p = payload()) =>
  (
    appUninstalledHandlerTask as unknown as {
      run: (payload: unknown) => Promise<{ success: boolean; cleared: number }>;
    }
  ).run(p);

const runSuspended = (p = payload()) =>
  (
    appSuspendedHandlerTask as unknown as {
      run: (payload: unknown) => Promise<{ success: boolean; cleared: number }>;
    }
  ).run(p);

const runUnsuspended = (p = payload()) =>
  (
    appUnsuspendedHandlerTask as unknown as {
      run: (payload: unknown) => Promise<{ success: boolean; skipped?: string }>;
    }
  ).run(p);

beforeEach(() => {
  mocks.upsert.mockReset().mockResolvedValue({});
  mocks.updateMany.mockReset().mockResolvedValue({ count: 0 });
  mocks.getInstallation.mockReset();
  process.env.GITHUB_APP_ID = APP_ID;
  process.env.GITHUB_APP_NAME = APP_SLUG;
  vi.spyOn(GitHubProvider, 'getAppOctokit').mockReturnValue({
    rest: { apps: { getInstallation: mocks.getInstallation } },
  } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('newInstallationHandlerTask', () => {
  it('writes the installation id when GitHub confirms it is live for this account', async () => {
    mocks.getInstallation.mockResolvedValue({ data: liveInstallation() });

    const result = await runCreated();

    expect(result).toEqual({ success: true });
    expect(mocks.getInstallation).toHaveBeenCalledWith({ installation_id: INSTALLATION_ID });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_provider_id: { provider: 'GITHUB', provider_id: String(ACCOUNT_ID) },
        },
        update: {
          github_installation_id: String(INSTALLATION_ID),
          login: 'dartmouth-cs',
        },
        create: {
          provider: 'GITHUB',
          provider_id: String(ACCOUNT_ID),
          login: 'dartmouth-cs',
          github_installation_id: String(INSTALLATION_ID),
        },
      })
    );
  });

  it('records the login GitHub reports now, not the one in the stale payload', async () => {
    mocks.getInstallation.mockResolvedValue({
      data: liveInstallation({
        account: {
          id: ACCOUNT_ID,
          login: 'dartmouth-cs-renamed',
          type: 'Organization',
          avatar_url: '',
        },
      }),
    });

    await runCreated();

    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ login: 'dartmouth-cs-renamed' }),
      })
    );
  });

  it('skips a stale delivery whose installation no longer exists (404)', async () => {
    mocks.getInstallation.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    const result = await runCreated();

    expect(result).toEqual({ success: true, skipped: 'stale' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('skips when the live installation belongs to a different account', async () => {
    mocks.getInstallation.mockResolvedValue({
      data: liveInstallation({
        account: { id: 7777, login: 'someone-else', type: 'Organization', avatar_url: '' },
      }),
    });

    const result = await runCreated();

    expect(result).toEqual({ success: true, skipped: 'account-mismatch' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('skips a suspended installation', async () => {
    mocks.getInstallation.mockResolvedValue({
      data: liveInstallation({ suspended_at: '2026-09-01T00:00:00Z' }),
    });

    const result = await runCreated();

    expect(result).toEqual({ success: true, skipped: 'suspended' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('skips a personal-account installation', async () => {
    mocks.getInstallation.mockResolvedValue({
      data: liveInstallation({
        account: { id: ACCOUNT_ID, login: 'someuser', type: 'User', avatar_url: '' },
      }),
    });

    const result = await runCreated();

    expect(result).toEqual({ success: true, skipped: 'not-organization' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('skips an installation of a different GitHub App', async () => {
    mocks.getInstallation.mockResolvedValue({ data: liveInstallation({ app_id: 999999 }) });

    const result = await runCreated();

    expect(result).toEqual({ success: true, skipped: 'wrong-app' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('skips an installation whose app slug is not ours', async () => {
    mocks.getInstallation.mockResolvedValue({ data: liveInstallation({ app_slug: 'other-app' }) });

    const result = await runCreated();

    expect(result).toEqual({ success: true, skipped: 'wrong-app' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rethrows a non-404 GitHub failure so Trigger retries it', async () => {
    mocks.getInstallation.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    await expect(runCreated()).rejects.toThrow('boom');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe('appUninstalledHandlerTask', () => {
  it('clears only the row still holding THIS installation id', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const result = await runDeleted();

    expect(result).toEqual({ success: true, cleared: 1 });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        provider: 'GITHUB',
        provider_id: String(ACCOUNT_ID),
        github_installation_id: String(INSTALLATION_ID),
      },
      data: { github_installation_id: null },
    });
  });

  it('clears nothing when the org has since reinstalled under a new id', async () => {
    // The WHERE no longer matches, so Prisma reports zero rows — the stale
    // delivery is a no-op instead of disconnecting a working org.
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const result = await runDeleted();

    expect(result).toEqual({ success: true, cleared: 0 });
  });
});

describe('appSuspendedHandlerTask', () => {
  it('clears the id, scoped to the installation that was suspended', async () => {
    // A suspended installation still exists but mints no tokens, so leaving the
    // id in place would show the org as connected while every call fails.
    mocks.updateMany.mockResolvedValue({ count: 1 });

    const result = await runSuspended();

    expect(result).toEqual({ success: true, cleared: 1 });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        provider: 'GITHUB',
        provider_id: String(ACCOUNT_ID),
        github_installation_id: String(INSTALLATION_ID),
      },
      data: { github_installation_id: null },
    });
  });

  it('clears nothing when the stored id has already moved on', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(runSuspended()).resolves.toEqual({ success: true, cleared: 0 });
  });

  it('never touches the org row directly', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await runSuspended();

    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe('appUnsuspendedHandlerTask', () => {
  it('writes the id back once GitHub confirms the installation is live again', async () => {
    mocks.getInstallation.mockResolvedValue({ data: liveInstallation() });

    const result = await runUnsuspended();

    expect(result).toEqual({ success: true });
    expect(mocks.getInstallation).toHaveBeenCalledWith({ installation_id: INSTALLATION_ID });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_provider_id: { provider: 'GITHUB', provider_id: String(ACCOUNT_ID) },
        },
        update: {
          github_installation_id: String(INSTALLATION_ID),
          login: 'dartmouth-cs',
        },
      })
    );
  });

  it('writes nothing when the installation is still suspended', async () => {
    // A replayed `unsuspend` for an installation that has since been suspended
    // again would otherwise re-connect an org to an id that mints no token.
    mocks.getInstallation.mockResolvedValue({
      data: liveInstallation({ suspended_at: '2026-09-01T00:00:00Z' }),
    });

    const result = await runUnsuspended();

    expect(result).toEqual({ success: true, skipped: 'suspended' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('skips a stale delivery whose installation no longer exists (404)', async () => {
    mocks.getInstallation.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    const result = await runUnsuspended();

    expect(result).toEqual({ success: true, skipped: 'stale' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('skips when the live installation belongs to a different account', async () => {
    mocks.getInstallation.mockResolvedValue({
      data: liveInstallation({
        account: { id: 7777, login: 'someone-else', type: 'Organization', avatar_url: '' },
      }),
    });

    const result = await runUnsuspended();

    expect(result).toEqual({ success: true, skipped: 'account-mismatch' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rethrows a non-404 GitHub failure so Trigger retries it', async () => {
    mocks.getInstallation.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    await expect(runUnsuspended()).rejects.toThrow('boom');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
