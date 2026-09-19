/**
 * Unit tests for the operator installation-repair sweep.
 *
 * The task's whole job is to be safe to point at production, so what is tested
 * is the safety, not the happy path:
 *
 *  - the default payload must WRITE NOTHING — a dry run reads through
 *    `lookupInstallationForOrg` and never reaches `repairInstallation`;
 *  - an applying run must go through `repairInstallation` for every org, so the
 *    write is the same conditional claim the UI button uses and never a raw
 *    update from this task;
 *  - a rate limit must STOP the sweep and hand back what it already learned,
 *    rather than marching through the remaining orgs turning one throttle into
 *    45 false "not installed" verdicts;
 *  - the scan must never pick up an example-course org or an org outside an
 *    explicitly requested subset;
 *  - the payload must be validated STRICTLY, because the safe default and the
 *    dangerous mode are one key apart and `{ "limt": 5 }` would otherwise be an
 *    applying sweep of everything;
 *  - the GitHub budget must be spent once per RUN, not once per org: one app
 *    client, one `GET /app/installations`.
 *
 * Prisma is mocked; the two service entry points are mocked so each test can
 * choose an outcome, but `GitHubRateLimitedError` is the REAL class, because
 * the stop-early branch turns on `instanceof`.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findManyOrgs: vi.fn(),
  findManyMemberships: vi.fn(),
  lookupInstallationForOrg: vi.fn(),
  listAppInstallations: vi.fn(),
  repairInstallation: vi.fn(),
  getAppOctokit: vi.fn(),
}));

interface SchemaTaskConfig {
  schema: (payload: unknown) => unknown;
  run: (payload: never) => unknown;
  [key: string]: unknown;
}

// `task()`/`schemaTask()` normally return a trigger handle; return the config so
// the test can call `run` directly. `schemaTask` keeps the real contract — the
// schema runs BEFORE `run` — so a rejected payload is rejected here too.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  schemaTask: (config: SchemaTaskConfig) => ({
    ...config,
    run: async (payload: unknown) => config.run(config.schema(payload) as never),
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: { findMany: (...a: unknown[]) => mocks.findManyOrgs(...a) },
    classroomMembership: { findMany: (...a: unknown[]) => mocks.findManyMemberships(...a) },
  }),
}));

vi.mock('@classmoji/services', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    GitHubProvider: { getAppOctokit: (...a: unknown[]) => mocks.getAppOctokit(...a) },
    lookupInstallationForOrg: (...a: unknown[]) => mocks.lookupInstallationForOrg(...a),
    listAppInstallations: (...a: unknown[]) => mocks.listAppInstallations(...a),
    repairInstallation: (...a: unknown[]) => mocks.repairInstallation(...a),
  };
});

const { GitHubRateLimitedError } = await import('@classmoji/services');
const { gitOrgInstallationRepairTask } = await import('../gitOrgInstallationRepair.ts');

interface RepairReport {
  dryRun: boolean;
  candidates: number;
  scanned: number;
  results: Array<{
    orgId: string;
    login: string;
    classrooms: number;
    owners: number;
    outcome: string;
    installationId?: string;
    message?: string;
  }>;
  summary: { byOutcome: Record<string, number> };
  unmatchedOrgIds: string[];
  stoppedEarly?: boolean;
  retryAfterSeconds?: number;
}

/** The single app client and single installation list a run is allowed. */
const APP_OCTOKIT = { rest: {} };
const INSTALLATIONS = [{ id: 55501 }];

const runTask = (payload: unknown = {}): Promise<RepairReport> =>
  (
    gitOrgInstallationRepairTask as unknown as {
      run: (payload: unknown) => Promise<RepairReport>;
    }
  ).run(payload);

/** An org row as the task's `select` shapes it. */
const orgRow = (n: number, classroomIds: string[] = [`c${n}`]) => ({
  id: `org-${n}`,
  login: `org${n}`,
  provider_id: `${9000 + n}`,
  classrooms: classroomIds.map(id => ({ id })),
});

const foundLookup = (installationId: string) => ({
  status: 'found' as const,
  installation: { id: installationId },
  synced: {
    provider_id: '9001',
    login: 'org1',
    github_installation_id: installationId,
    avatar_url: '',
  },
});

beforeEach(() => {
  mocks.findManyOrgs.mockReset().mockResolvedValue([]);
  mocks.findManyMemberships.mockReset().mockResolvedValue([]);
  mocks.lookupInstallationForOrg.mockReset();
  mocks.listAppInstallations.mockReset().mockResolvedValue(INSTALLATIONS);
  mocks.repairInstallation.mockReset();
  mocks.getAppOctokit.mockReset().mockReturnValue(APP_OCTOKIT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scan query', () => {
  it('asks only for GitHub orgs with a null id and a non-example classroom', async () => {
    await runTask();

    expect(mocks.findManyOrgs).toHaveBeenCalledTimes(1);
    expect(mocks.findManyOrgs.mock.calls[0][0]).toMatchObject({
      where: {
        provider: 'GITHUB',
        github_installation_id: null,
        classrooms: { some: { is_example: false } },
      },
      orderBy: { login: 'asc' },
    });
    // No `id: { in: … }` unless a subset was asked for.
    expect(mocks.findManyOrgs.mock.calls[0][0].where).not.toHaveProperty('id');
  });

  it('counts only non-example classrooms per org', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1, ['c1', 'c2'])]);
    mocks.lookupInstallationForOrg.mockResolvedValue({ status: 'not-installed' });

    const report = await runTask();

    expect(mocks.findManyOrgs.mock.calls[0][0].select.classrooms).toMatchObject({
      where: { is_example: false },
    });
    expect(report.results[0].classrooms).toBe(2);
  });

  it('restricts the scan to an explicit orgIds subset', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(2)]);
    mocks.lookupInstallationForOrg.mockResolvedValue({ status: 'not-installed' });

    const report = await runTask({ orgIds: ['org-2'] });

    expect(mocks.findManyOrgs.mock.calls[0][0].where).toMatchObject({
      id: { in: ['org-2'] },
      provider: 'GITHUB',
      github_installation_id: null,
      classrooms: { some: { is_example: false } },
    });
    expect(report.results.map(r => r.orgId)).toEqual(['org-2']);
  });

  it('passes a limit through as `take`', async () => {
    await runTask({ limit: 5 });

    expect(mocks.findManyOrgs.mock.calls[0][0].take).toBe(5);
  });

  it('reports the number of distinct OWNERs per org', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1, ['c1', 'c2'])]);
    // One person owning two classrooms is ONE person to contact.
    mocks.findManyMemberships.mockResolvedValue([
      { user_id: 'u1', classroom_id: 'c1' },
      { user_id: 'u1', classroom_id: 'c2' },
      { user_id: 'u2', classroom_id: 'c2' },
    ]);
    mocks.lookupInstallationForOrg.mockResolvedValue({ status: 'not-installed' });

    const report = await runTask();

    expect(mocks.findManyMemberships).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { classroom_id: { in: ['c1', 'c2'] }, role: 'OWNER' },
      })
    );
    expect(report.results[0].owners).toBe(2);
  });

  it('skips the membership query entirely when nothing matched', async () => {
    const report = await runTask();

    expect(mocks.findManyMemberships).not.toHaveBeenCalled();
    expect(report).toMatchObject({ dryRun: true, scanned: 0, results: [] });
  });
});

describe('dry run (the default)', () => {
  it('writes nothing and reports what it would have done', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2)]);
    mocks.lookupInstallationForOrg
      .mockResolvedValueOnce(foundLookup('55501'))
      .mockResolvedValueOnce({ status: 'not-installed' });

    const report = await runTask();

    expect(report.dryRun).toBe(true);
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
    expect(mocks.lookupInstallationForOrg).toHaveBeenCalledTimes(2);
    expect(report.results).toEqual([
      {
        orgId: 'org-1',
        login: 'org1',
        classrooms: 1,
        owners: 0,
        outcome: 'would-connect',
        installationId: '55501',
      },
      { orgId: 'org-2', login: 'org2', classrooms: 1, owners: 0, outcome: 'not-installed' },
    ]);
    expect(report.summary.byOutcome).toEqual({ 'would-connect': 1, 'not-installed': 1 });
  });

  it('treats an explicit dryRun:true the same as the default', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1)]);
    mocks.lookupInstallationForOrg.mockResolvedValue(foundLookup('55501'));

    const report = await runTask({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(mocks.repairInstallation).not.toHaveBeenCalled();
  });

  it('records a lookup failure as `error` and keeps going', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2)]);
    mocks.lookupInstallationForOrg
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'not-installed' });

    const report = await runTask();

    expect(report.results.map(r => r.outcome)).toEqual(['error', 'not-installed']);
    expect(report.stoppedEarly).toBeUndefined();
  });
});

describe('applying run', () => {
  it('goes through repairInstallation once per org', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2)]);
    mocks.repairInstallation
      .mockResolvedValueOnce({
        status: 'connected',
        org: { github_installation_id: '55501' },
      })
      .mockResolvedValueOnce({ status: 'not-installed' });

    const report = await runTask({ dryRun: false });

    expect(report.dryRun).toBe(false);
    expect(mocks.lookupInstallationForOrg).not.toHaveBeenCalled();
    expect(mocks.repairInstallation).toHaveBeenCalledTimes(2);
    expect(mocks.repairInstallation).toHaveBeenNthCalledWith(1, 'org-1', {
      appOctokit: APP_OCTOKIT,
      installations: INSTALLATIONS,
      bypassCooldown: true,
    });
    expect(mocks.repairInstallation).toHaveBeenNthCalledWith(2, 'org-2', {
      appOctokit: APP_OCTOKIT,
      installations: INSTALLATIONS,
      bypassCooldown: true,
    });
    expect(report.results).toEqual([
      {
        orgId: 'org-1',
        login: 'org1',
        classrooms: 1,
        owners: 0,
        outcome: 'connected',
        installationId: '55501',
      },
      { orgId: 'org-2', login: 'org2', classrooms: 1, owners: 0, outcome: 'not-installed' },
    ]);
  });

  it('reports an org another writer had already connected', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1)]);
    mocks.repairInstallation.mockResolvedValue({
      status: 'already-connected',
      org: { github_installation_id: '77701' },
    });

    const report = await runTask({ dryRun: false });

    expect(report.results[0]).toMatchObject({
      outcome: 'already-connected',
      installationId: '77701',
    });
  });
});

describe('rate limiting', () => {
  it('stops the dry run at the throttle and returns partial results', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2), orgRow(3)]);
    mocks.lookupInstallationForOrg
      .mockResolvedValueOnce({ status: 'not-installed' })
      .mockRejectedValueOnce(new GitHubRateLimitedError(120));

    const report = await runTask();

    // The third org was never asked about.
    expect(mocks.lookupInstallationForOrg).toHaveBeenCalledTimes(2);
    expect(report.stoppedEarly).toBe(true);
    expect(report.retryAfterSeconds).toBe(120);
    expect(report.scanned).toBe(2);
    expect(report.results.map(r => r.outcome)).toEqual(['not-installed', 'rate-limited']);
    expect(report.results[1].login).toBe('org2');
  });

  it('stops an applying run when repairInstallation reports the throttle', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2), orgRow(3)]);
    mocks.repairInstallation
      .mockResolvedValueOnce({ status: 'connected', org: { github_installation_id: '55501' } })
      .mockResolvedValueOnce({ status: 'rate-limited', retryAfterSeconds: 45 });

    const report = await runTask({ dryRun: false });

    expect(mocks.repairInstallation).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ stoppedEarly: true, retryAfterSeconds: 45, scanned: 2 });
    expect(report.summary.byOutcome).toEqual({ connected: 1, 'rate-limited': 1 });
  });
});

describe('payload validation', () => {
  it('rejects an unknown key rather than running a full applying sweep', async () => {
    // `{ "limt": 5 }` used to mean "no limit, dry run" — the typo silently
    // becoming a different, larger run is exactly the failure this guards.
    await expect(runTask({ limt: 5 })).rejects.toThrow(/unknown payload key/);
    expect(mocks.findManyOrgs).not.toHaveBeenCalled();
  });

  it('rejects a dryRun that is not a boolean', async () => {
    // The JSON string "false" is truthy; letting it through would report a dry
    // run while doing nothing, or worse.
    await expect(runTask({ dryRun: 'false' })).rejects.toThrow(/dryRun must be a boolean/);
    expect(mocks.findManyOrgs).not.toHaveBeenCalled();
  });

  it('rejects a non-positive limit and a non-string orgIds entry', async () => {
    await expect(runTask({ limit: 0 })).rejects.toThrow(/limit must be a positive integer/);
    await expect(runTask({ orgIds: ['ok', 7] })).rejects.toThrow(/orgIds must be an array/);
  });

  it('accepts an empty payload, and no payload at all, as a dry run', async () => {
    await expect(runTask({})).resolves.toMatchObject({ dryRun: true });
    await expect(runTask(undefined)).resolves.toMatchObject({ dryRun: true });
  });
});

describe('GitHub budget', () => {
  it('mints one app client and reads /app/installations once for a dry run', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2), orgRow(3)]);
    mocks.lookupInstallationForOrg.mockResolvedValue({ status: 'not-installed' });

    await runTask();

    expect(mocks.getAppOctokit).toHaveBeenCalledTimes(1);
    expect(mocks.listAppInstallations).toHaveBeenCalledTimes(1);
    expect(mocks.listAppInstallations).toHaveBeenCalledWith(APP_OCTOKIT);
    expect(mocks.lookupInstallationForOrg).toHaveBeenCalledTimes(3);
    // Every org reads the SAME preloaded list — the paginated scan is the
    // expensive half of a lookup, and 45 of them is the whole hourly budget.
    for (const call of mocks.lookupInstallationForOrg.mock.calls) {
      expect(call[0]).toBe(APP_OCTOKIT);
      expect(call[2]).toEqual({ installations: INSTALLATIONS });
    }
  });

  it('mints one app client and reads /app/installations once for an applying run', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2)]);
    mocks.repairInstallation.mockResolvedValue({ status: 'not-installed' });

    await runTask({ dryRun: false });

    expect(mocks.getAppOctokit).toHaveBeenCalledTimes(1);
    expect(mocks.listAppInstallations).toHaveBeenCalledTimes(1);
  });

  it('asks GitHub nothing at all when the scan matched no orgs', async () => {
    await runTask();

    expect(mocks.getAppOctokit).not.toHaveBeenCalled();
    expect(mocks.listAppInstallations).not.toHaveBeenCalled();
  });

  it('stops before touching any org when the preload is throttled', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1), orgRow(2)]);
    mocks.listAppInstallations.mockRejectedValue(new GitHubRateLimitedError(300));

    const report = await runTask();

    expect(report).toMatchObject({
      candidates: 2,
      scanned: 0,
      stoppedEarly: true,
      retryAfterSeconds: 300,
    });
    expect(mocks.lookupInstallationForOrg).not.toHaveBeenCalled();
  });
});

describe('report', () => {
  it('counts candidates and names requested ids that matched nothing', async () => {
    // An org already connected, or example-only, or simply absent, is not in
    // the scan's result at all — the operator who named it needs telling.
    mocks.findManyOrgs.mockResolvedValue([orgRow(2)]);
    mocks.lookupInstallationForOrg.mockResolvedValue({ status: 'not-installed' });

    const report = await runTask({ orgIds: ['org-2', 'org-404'] });

    expect(report.candidates).toBe(1);
    expect(report.unmatchedOrgIds).toEqual(['org-404']);
  });

  it('leaves unmatchedOrgIds empty when no subset was requested', async () => {
    const report = await runTask();

    expect(report.unmatchedOrgIds).toEqual([]);
    expect(report.candidates).toBe(0);
  });

  it("carries repairInstallation's own message onto an error row", async () => {
    // `repairInstallation` swallows unexpected failures into a status, so
    // without its message the report says `error` and nothing else.
    mocks.findManyOrgs.mockResolvedValue([orgRow(1)]);
    mocks.repairInstallation.mockResolvedValue({
      status: 'error',
      message: 'Organization disappeared while connecting',
    });

    const report = await runTask({ dryRun: false });

    expect(report.results[0]).toMatchObject({
      outcome: 'error',
      message: 'Organization disappeared while connecting',
    });
  });

  it('carries a thrown failure message onto an error row', async () => {
    mocks.findManyOrgs.mockResolvedValue([orgRow(1)]);
    mocks.lookupInstallationForOrg.mockRejectedValue(new Error('boom'));

    const report = await runTask();

    expect(report.results[0]).toMatchObject({ outcome: 'error', message: 'boom' });
  });
});
