/**
 * `refreshRepo` is what a push triggers. The invariant it exists to hold: one
 * git repo costs ONE set of provider calls per refresh, however many submission
 * rows hang off it — the commits, contributors, languages and PRs a snapshot
 * holds are facts about the repo and identical across its rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const gitRepoFindUnique = vi.fn();
const snapshotUpsert = vi.fn();
const snapshotCount = vi.fn();
const membershipFindMany = vi.fn().mockResolvedValue([]);
const contributorLinkFindMany = vi.fn().mockResolvedValue([]);

const snapshotFindFirst = vi.fn();
const listCommits = vi.fn();
const getContributorStats = vi.fn();
const getLanguages = vi.fn();
const listPulls = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    gitRepo: { findUnique: (...a: unknown[]) => gitRepoFindUnique(...a) },
    gitRepoAnalyticsSnapshot: {
      upsert: (...a: unknown[]) => snapshotUpsert(...a),
      count: (...a: unknown[]) => snapshotCount(...a),
      findFirst: (...a: unknown[]) => snapshotFindFirst(...a),
    },
    classroomMembership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    gitRepoContributorLink: { findMany: (...a: unknown[]) => contributorLinkFindMany(...a) },
  }),
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    listCommits: (...a: unknown[]) => listCommits(...a),
    getContributorStats: (...a: unknown[]) => getContributorStats(...a),
    getLanguages: (...a: unknown[]) => getLanguages(...a),
    listPulls: (...a: unknown[]) => listPulls(...a),
  }),
}));

const { refreshRepo } = await import('../repoAnalytics.service.ts');

function repoWith(rowIds: string[]) {
  return {
    id: 'gitrepo-1',
    name: 'lab-3-alice',
    assignments: rowIds.map(id => ({ id })),
    classroom: {
      id: 'classroom-1',
      git_organization: { id: 'org-1', login: 'acme-u', provider: 'GITHUB' },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipFindMany.mockResolvedValue([]);
  contributorLinkFindMany.mockResolvedValue([]);
  listCommits.mockResolvedValue([]);
  getContributorStats.mockResolvedValue([]);
  getLanguages.mockResolvedValue({});
  listPulls.mockResolvedValue([]);
  snapshotUpsert.mockResolvedValue({});
  snapshotFindFirst.mockResolvedValue(null);
  // Default: nothing fresh on record, so the TTL never short-circuits.
  snapshotCount.mockResolvedValue(0);
});

describe('refreshRepo', () => {
  it('reads the provider once and writes a snapshot for every row', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith(['ra-1', 'ra-2', 'ra-3']));

    const result = await refreshRepo('gitrepo-1');

    expect(listCommits).toHaveBeenCalledTimes(1);
    expect(getContributorStats).toHaveBeenCalledTimes(1);
    expect(getLanguages).toHaveBeenCalledTimes(1);
    expect(listPulls).toHaveBeenCalledTimes(1);
    expect(snapshotUpsert).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ stale: false, rows: 3 });
  });

  it('hands the provider the line counts it already read, by sha', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith(['ra-1']));
    snapshotFindFirst.mockResolvedValue({
      commits: [{ sha: 'old', additions: 4, deletions: 2 }],
    });

    await refreshRepo('gitrepo-1');

    const opts = listCommits.mock.calls[0][2] as { knownStats: Map<string, unknown> };
    expect(opts.knownStats.get('old')).toEqual({ additions: 4, deletions: 2 });
  });

  it('spends no provider calls on a repo with no submission rows', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith([]));

    const result = await refreshRepo('gitrepo-1');

    expect(listCommits).not.toHaveBeenCalled();
    expect(snapshotUpsert).not.toHaveBeenCalled();
    expect(result).toEqual({ stale: false, rows: 0 });
  });

  it('builds contributors from the commits when the provider has no endpoint for them', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith(['ra-1']));
    getContributorStats.mockResolvedValue(null);
    listCommits.mockResolvedValue([
      {
        sha: 'a',
        author_login: 'alice',
        author_email: null,
        ts: '2026-10-01T00:00:00Z',
        message: '',
        additions: 5,
        deletions: 1,
        parents: [],
      },
      {
        sha: 'b',
        author_login: 'alice',
        author_email: null,
        ts: '2026-10-02T00:00:00Z',
        message: '',
        additions: 2,
        deletions: 0,
        parents: [],
      },
    ]);

    const result = await refreshRepo('gitrepo-1');

    expect(result).toEqual({ stale: false, rows: 1 });
    const written = (snapshotUpsert.mock.calls[0][0] as { create: { contributors: unknown } })
      .create.contributors;
    expect(written).toEqual([
      { login: 'alice', email: null, user_id: null, commits: 2, additions: 7, deletions: 1 },
    ]);
  });

  it('persists the failure on every row so a dead repo surfaces on each submission', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith(['ra-1', 'ra-2']));
    listCommits.mockRejectedValue(new Error('Not Found'));

    const result = await refreshRepo('gitrepo-1');

    expect(result.stale).toBe(true);
    expect(result.error).toContain('Not Found');
    expect(result.rows).toBe(2);
    expect(snapshotUpsert).toHaveBeenCalledTimes(2);
    for (const call of snapshotUpsert.mock.calls) {
      expect((call[0] as { create: { error: string | null } }).create.error).toContain('Not Found');
    }
  });

  it('skips the provider entirely while every row holds a fresh snapshot', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith(['ra-1', 'ra-2']));
    snapshotCount.mockResolvedValue(2);

    const result = await refreshRepo('gitrepo-1');

    expect(listCommits).not.toHaveBeenCalled();
    expect(snapshotUpsert).not.toHaveBeenCalled();
    expect(result).toEqual({ stale: false, rows: 2, skipped: true });
  });

  it('refreshes when only some rows are fresh', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith(['ra-1', 'ra-2']));
    snapshotCount.mockResolvedValue(1);

    const result = await refreshRepo('gitrepo-1');

    expect(listCommits).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ stale: false, rows: 2 });
  });

  it('never counts a stale or errored row as fresh', async () => {
    gitRepoFindUnique.mockResolvedValue(repoWith(['ra-1']));
    snapshotCount.mockResolvedValue(1);

    await refreshRepo('gitrepo-1');

    // A warming (202) or dead row must keep retrying, so the freshness query
    // excludes them rather than letting the window freeze them out.
    const where = (snapshotCount.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.stale).toBe(false);
    expect(where.error).toBeNull();
  });
});
