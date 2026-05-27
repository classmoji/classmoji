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
import type { CommitRecord, ContributorRecord } from '../repoAnalytics.types.ts';

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
  it('returns 0 when empty or no deadline', () => {
    expect(lateCommitRatio([], new Date('2026-01-01T00:00:00Z'))).toBe(0);
    expect(lateCommitRatio([commit({})], null)).toBe(0);
  });
  it('computes fraction of commits strictly after deadline', () => {
    const c = [
      commit({ sha: '1', ts: '2026-01-01T00:00:00Z' }),
      commit({ sha: '2', ts: '2026-01-11T00:00:00Z' }),
    ];
    expect(lateCommitRatio(c, new Date('2026-01-10T00:00:00Z'))).toBe(0.5);
  });
});

describe('isMegaCommit', () => {
  it('is true only when commit exceeds 40% of total additions+deletions', () => {
    expect(isMegaCommit(commit({ additions: 500 }), 1000, 0)).toBe(true);
    expect(isMegaCommit(commit({ additions: 400 }), 1000, 0)).toBe(false);
    expect(isMegaCommit(commit({}), 0, 0)).toBe(false);
  });
});

describe('commitMessageQuality', () => {
  it('scores empty/filler low and descriptive messages high, clamped to [0,1]', () => {
    expect(commitMessageQuality('')).toBe(0);
    expect(commitMessageQuality('update')).toBeLessThan(0.3);
    expect(
      commitMessageQuality('Refactor auth guard to handle expired tokens')
    ).toBeGreaterThanOrEqual(0.7);
    const q = commitMessageQuality('a'.repeat(100));
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(1);
  });
});

describe('averageCommitQuality', () => {
  it('returns 0 for empty and averages across commits', () => {
    expect(averageCommitQuality([])).toBe(0);
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
  it('is null with <=1 contributors, otherwise the max share', () => {
    expect(busFactor([])).toBeNull();
    const one: ContributorRecord[] = [
      { login: 'alice', user_id: null, commits: 10, additions: 0, deletions: 0 },
    ];
    expect(busFactor(one)).toBeNull();
    const many: ContributorRecord[] = [
      { login: 'alice', user_id: null, commits: 8, additions: 0, deletions: 0 },
      { login: 'bob', user_id: null, commits: 1, additions: 0, deletions: 0 },
      { login: 'carol', user_id: null, commits: 1, additions: 0, deletions: 0 },
    ];
    expect(busFactor(many)).toEqual({ login: 'alice', share: 0.8 });
  });
});

describe('dumpAndRun', () => {
  it('true only when the earliest commit is <24h before deadline', () => {
    const deadline = new Date('2026-01-10T00:00:00Z');
    expect(dumpAndRun([], deadline)).toBe(false);
    expect(dumpAndRun([commit({ ts: '2026-01-09T20:00:00Z' })], null)).toBe(false);
    expect(dumpAndRun([commit({ ts: '2026-01-09T04:00:00Z' })], deadline)).toBe(true);
    expect(
      dumpAndRun(
        [
          commit({ sha: 'early', ts: '2025-12-01T00:00:00Z' }),
          commit({ sha: 'late', ts: '2026-01-09T23:00:00Z' }),
        ],
        deadline
      )
    ).toBe(false);
  });
});

describe('aggregateByContributor', () => {
  it('aggregates by login (null → "unknown") with sums and desc order', () => {
    expect(aggregateByContributor([])).toEqual([]);
    const cs = [
      commit({ sha: '1', author_login: 'alice', additions: 10, deletions: 1 }),
      commit({ sha: '2', author_login: 'alice', additions: 5, deletions: 2 }),
      commit({ sha: '3', author_login: 'bob', additions: 3, deletions: 4 }),
      commit({ sha: '4', author_login: null }),
    ];
    const rows = aggregateByContributor(cs);
    expect(rows[0]!.login).toBe('alice');
    expect(rows[0]!.commits).toBe(2);
    expect(rows[0]!.additions).toBe(15);
    expect(rows[0]!.deletions).toBe(3);
    expect(rows.find(r => r.login === 'unknown')!.commits).toBe(1);
  });
});

describe('commitsPerDayByContributor', () => {
  it('buckets by UTC day, stacks by login, fills intermediate days', () => {
    expect(commitsPerDayByContributor([])).toEqual([]);
    const cs = [
      commit({ sha: '1', author_login: 'alice', ts: '2026-04-15T23:59:00Z' }),
      commit({ sha: '2', author_login: 'bob', ts: '2026-04-18T00:00:00Z' }),
      commit({ sha: '3', author_login: null, ts: '2026-04-15T10:00:00Z' }),
    ];
    const rows = commitsPerDayByContributor(cs);
    expect(rows.map(r => r.day)).toEqual(['2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18']);
    expect(rows[0]).toEqual({ day: '2026-04-15', alice: 1, bob: 0, unknown: 1 });
    expect(rows[3]).toEqual({ day: '2026-04-18', alice: 0, bob: 1, unknown: 0 });
  });
});
