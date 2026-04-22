import { describe, it, expect } from 'vitest';
import {
  lateCommitRatio,
  isMegaCommit,
  commitMessageQuality,
  averageCommitQuality,
  busFactor,
  dumpAndRun,
  aggregateByContributor,
  commitsPerDayByContributor,
} from '../repoAnalytics.flags.ts';
import type {
  CommitRecord,
  ContributorRecord,
} from '../repoAnalytics.types.ts';

function commit(partial: Partial<CommitRecord>): CommitRecord {
  return {
    sha: 'sha',
    author_login: 'alice',
    author_email: null,
    author_user_id: null,
    ts: '2026-01-01T00:00:00Z',
    message: 'msg',
    additions: 0,
    deletions: 0,
    parents: [],
    ...partial,
  };
}

describe('lateCommitRatio', () => {
  it('returns 0 when no commits', () => {
    expect(lateCommitRatio([], new Date('2026-01-01T00:00:00Z'))).toBe(0);
  });
  it('returns 0 when deadline is null', () => {
    expect(lateCommitRatio([commit({ ts: '2026-01-01T00:00:00Z' })], null)).toBe(0);
  });
  it('returns 0 when no commits are after deadline', () => {
    const c = [
      commit({ sha: '1', ts: '2026-01-01T00:00:00Z' }),
      commit({ sha: '2', ts: '2026-01-02T00:00:00Z' }),
    ];
    expect(lateCommitRatio(c, new Date('2026-01-10T00:00:00Z'))).toBe(0);
  });
  it('returns 0.5 when half of commits are after deadline', () => {
    const c = [
      commit({ sha: '1', ts: '2026-01-01T00:00:00Z' }),
      commit({ sha: '2', ts: '2026-01-11T00:00:00Z' }),
    ];
    expect(lateCommitRatio(c, new Date('2026-01-10T00:00:00Z'))).toBe(0.5);
  });
  it('returns 1 when all commits are after the deadline', () => {
    const c = [
      commit({ sha: '1', ts: '2026-01-11T00:00:00Z' }),
      commit({ sha: '2', ts: '2026-01-12T00:00:00Z' }),
    ];
    expect(lateCommitRatio(c, new Date('2026-01-10T00:00:00Z'))).toBe(1);
  });
});

describe('isMegaCommit', () => {
  it('is true when commit size is more than 40% of the total', () => {
    const c = commit({ additions: 500, deletions: 0 });
    expect(isMegaCommit(c, 1000, 0)).toBe(true);
  });
  it('is false when commit size is at or below 40%', () => {
    const c = commit({ additions: 400, deletions: 0 });
    expect(isMegaCommit(c, 1000, 0)).toBe(false);
  });
  it('returns false when total is 0', () => {
    const c = commit({ additions: 0, deletions: 0 });
    expect(isMegaCommit(c, 0, 0)).toBe(false);
  });
  it('counts additions and deletions for both sides', () => {
    const c = commit({ additions: 100, deletions: 100 });
    expect(isMegaCommit(c, 200, 200)).toBe(true); // 200/400 = 50%
  });
  it('is false when commit size equals exactly 40%', () => {
    const c = commit({ additions: 40, deletions: 0 });
    expect(isMegaCommit(c, 100, 0)).toBe(false);
  });
});

describe('commitMessageQuality', () => {
  it('returns 0 for empty string', () => {
    expect(commitMessageQuality('')).toBe(0);
    expect(commitMessageQuality('   ')).toBe(0);
  });
  it('penalizes filler verbs alone', () => {
    expect(commitMessageQuality('update')).toBeLessThan(0.3);
    expect(commitMessageQuality('wip')).toBeLessThan(0.3);
    expect(commitMessageQuality('fix')).toBeLessThan(0.3);
  });
  it('rewards longer descriptive messages', () => {
    expect(
      commitMessageQuality('Refactor auth guard to handle expired tokens'),
    ).toBeGreaterThanOrEqual(0.7);
  });
  it('penalizes very short messages', () => {
    expect(commitMessageQuality('hi')).toBeLessThan(0.5);
  });
  it('clamps to [0, 1]', () => {
    const q = commitMessageQuality('a'.repeat(100));
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(1);
  });
});

describe('averageCommitQuality', () => {
  it('returns 0 when no commits', () => {
    expect(averageCommitQuality([])).toBe(0);
  });
  it('averages quality across commits', () => {
    const c = [
      commit({ message: 'update' }),
      commit({ message: 'Refactor auth guard to handle expired tokens' }),
    ];
    const avg = averageCommitQuality(c);
    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(1);
  });
});

describe('busFactor', () => {
  it('returns null when 0 contributors', () => {
    expect(busFactor([])).toBeNull();
  });
  it('returns null when only 1 contributor', () => {
    const cs: ContributorRecord[] = [
      { login: 'alice', user_id: null, commits: 10, additions: 0, deletions: 0 },
    ];
    expect(busFactor(cs)).toBeNull();
  });
  it('returns max share across many contributors', () => {
    const cs: ContributorRecord[] = [
      { login: 'alice', user_id: null, commits: 8, additions: 0, deletions: 0 },
      { login: 'bob', user_id: null, commits: 1, additions: 0, deletions: 0 },
      { login: 'carol', user_id: null, commits: 1, additions: 0, deletions: 0 },
    ];
    expect(busFactor(cs)).toEqual({ login: 'alice', share: 0.8 });
  });
});

describe('dumpAndRun', () => {
  it('is false when commits empty', () => {
    expect(dumpAndRun([], new Date('2026-01-10T00:00:00Z'))).toBe(false);
  });
  it('is false when deadline null', () => {
    expect(
      dumpAndRun([commit({ ts: '2026-01-09T20:00:00Z' })], null),
    ).toBe(false);
  });
  it('is true when first commit is 20h before deadline', () => {
    const deadline = new Date('2026-01-10T00:00:00Z');
    const cs = [commit({ ts: '2026-01-09T04:00:00Z' })]; // 20h before
    expect(dumpAndRun(cs, deadline)).toBe(true);
  });
  it('is false when first commit is 2 weeks before deadline', () => {
    const deadline = new Date('2026-01-10T00:00:00Z');
    const cs = [
      commit({ sha: '1', ts: '2025-12-27T00:00:00Z' }),
      commit({ sha: '2', ts: '2026-01-09T00:00:00Z' }),
    ];
    expect(dumpAndRun(cs, deadline)).toBe(false);
  });
  it('uses the earliest commit when commits are unordered', () => {
    const deadline = new Date('2026-01-10T00:00:00Z');
    const cs = [
      commit({ sha: 'late', ts: '2026-01-09T23:00:00Z' }),
      commit({ sha: 'early', ts: '2025-12-01T00:00:00Z' }),
    ];
    expect(dumpAndRun(cs, deadline)).toBe(false);
  });
});

describe('aggregateByContributor', () => {
  it('returns empty array when no commits', () => {
    expect(aggregateByContributor([])).toEqual([]);
  });
  it('aggregates commits from 2 authors and sorts descending by commits', () => {
    const cs = [
      commit({ sha: '1', author_login: 'alice' }),
      commit({ sha: '2', author_login: 'bob' }),
      commit({ sha: '3', author_login: 'alice' }),
    ];
    const rows = aggregateByContributor(cs);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.login).toBe('alice');
    expect(rows[0]!.commits).toBe(2);
    expect(rows[1]!.login).toBe('bob');
    expect(rows[1]!.commits).toBe(1);
  });
  it('buckets commits with null author_login under "unknown"', () => {
    const cs = [
      commit({ sha: '1', author_login: null }),
      commit({ sha: '2', author_login: 'alice' }),
      commit({ sha: '3', author_login: null }),
    ];
    const rows = aggregateByContributor(cs);
    const unknown = rows.find((r) => r.login === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.commits).toBe(2);
  });
  it('sums additions and deletions per contributor', () => {
    const cs = [
      commit({ sha: '1', author_login: 'alice', additions: 10, deletions: 1 }),
      commit({ sha: '2', author_login: 'alice', additions: 5, deletions: 2 }),
      commit({ sha: '3', author_login: 'bob', additions: 3, deletions: 4 }),
    ];
    const rows = aggregateByContributor(cs);
    const alice = rows.find((r) => r.login === 'alice')!;
    const bob = rows.find((r) => r.login === 'bob')!;
    expect(alice.additions).toBe(15);
    expect(alice.deletions).toBe(3);
    expect(bob.additions).toBe(3);
    expect(bob.deletions).toBe(4);
  });
});

describe('commitsPerDayByContributor', () => {
  it('returns empty when no commits', () => {
    expect(commitsPerDayByContributor([])).toEqual([]);
  });
  it('buckets by UTC day and stacks by contributor', () => {
    const cs = [
      commit({ sha: '1', author_login: 'alice', ts: '2026-04-15T10:00:00Z' }),
      commit({ sha: '2', author_login: 'bob', ts: '2026-04-15T23:00:00Z' }),
      commit({ sha: '3', author_login: 'alice', ts: '2026-04-16T01:00:00Z' }),
    ];
    const rows = commitsPerDayByContributor(cs);
    expect(rows).toEqual([
      { day: '2026-04-15', alice: 1, bob: 1 },
      { day: '2026-04-16', alice: 1, bob: 0 },
    ]);
  });
  it('fills intermediate days with zeros', () => {
    const cs = [
      commit({ sha: '1', author_login: 'alice', ts: '2026-04-15T00:00:00Z' }),
      commit({ sha: '2', author_login: 'bob', ts: '2026-04-18T00:00:00Z' }),
    ];
    const rows = commitsPerDayByContributor(cs);
    expect(rows.map((r) => r.day)).toEqual([
      '2026-04-15',
      '2026-04-16',
      '2026-04-17',
      '2026-04-18',
    ]);
    expect(rows[0]).toEqual({ day: '2026-04-15', alice: 1, bob: 0 });
    expect(rows[1]).toEqual({ day: '2026-04-16', alice: 0, bob: 0 });
    expect(rows[2]).toEqual({ day: '2026-04-17', alice: 0, bob: 0 });
    expect(rows[3]).toEqual({ day: '2026-04-18', alice: 0, bob: 1 });
  });
  it('uses UTC date portion (slice 0,10) of ts', () => {
    // 23:59Z on the 15th stays on the 15th even though many local tz would roll.
    const cs = [
      commit({ sha: '1', author_login: 'alice', ts: '2026-04-15T23:59:00Z' }),
    ];
    const rows = commitsPerDayByContributor(cs);
    expect(rows).toEqual([{ day: '2026-04-15', alice: 1 }]);
  });
  it('buckets null author_login under "unknown"', () => {
    const cs = [
      commit({ sha: '1', author_login: null, ts: '2026-04-15T10:00:00Z' }),
    ];
    const rows = commitsPerDayByContributor(cs);
    expect(rows).toEqual([{ day: '2026-04-15', unknown: 1 }]);
  });
});
