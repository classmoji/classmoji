import { describe, it, expect } from 'vitest';
import {
  identityKeys,
  buildSnapshot,
  linkAuthorsToUsers,
  linkContributorsToUsers,
} from '../repoAnalytics.service.ts';
import type { CommitRecord, ContributorRecord } from '../repoAnalytics.types.ts';
import type { GitProvider } from '../../git/GitProvider.ts';

function commit(partial: Partial<CommitRecord>): CommitRecord {
  return {
    sha: 'a',
    author_login: 'alice',
    author_email: null,
    author_user_id: null,
    ts: '2026-01-01T00:00:00Z',
    message: 'm',
    additions: 0,
    deletions: 0,
    parents: [],
    ...partial,
  };
}

describe('linkAuthorsToUsers', () => {
  it('maps by login, leaves null for misses or null login', () => {
    const commits = [
      commit({ sha: '1', author_login: 'alice' }),
      commit({ sha: '2', author_login: 'stranger' }),
      commit({ sha: '3', author_login: null }),
    ];
    const out = linkAuthorsToUsers(commits, new Map([['alice', 'user-1']]));
    expect(out[0].author_user_id).toBe('user-1');
    expect(out[1].author_user_id).toBeNull();
    expect(out[2].author_user_id).toBeNull();
  });
});

describe('linkContributorsToUsers', () => {
  it('sets user_id on login match, null otherwise', () => {
    const contributors: ContributorRecord[] = [
      { login: 'alice', user_id: null, commits: 5, additions: 100, deletions: 10 },
      { login: 'stranger', user_id: null, commits: 2, additions: 20, deletions: 3 },
    ];
    const out = linkContributorsToUsers(contributors, new Map([['alice', 'user-1']]));
    expect(out[0].user_id).toBe('user-1');
    expect(out[1].user_id).toBeNull();
  });
});

describe('buildSnapshot', () => {
  it('bounds commit collection for analytics refreshes', async () => {
    let listCommitsOpts: { maxCommits?: number } | undefined;
    const provider = {
      async listCommits(_org: string, _repo: string, opts?: { maxCommits?: number }) {
        listCommitsOpts = opts;
        return [];
      },
      async getContributorStats() {
        return [];
      },
      async getLanguages() {
        return {};
      },
      async listPulls() {
        return { open: 0, merged: 0, closed: 0 };
      },
    } as unknown as GitProvider;

    await buildSnapshot(provider, 'org', 'repo');

    expect(listCommitsOpts).toEqual({ maxCommits: 250 });
  });
});

describe('Gitlab author matching', () => {
  it('reads the username out of a Gitlab no-reply commit email', () => {
    expect(identityKeys('42-MChen@users.noreply.gitlab.school.edu')).toEqual([
      '42-mchen@users.noreply.gitlab.school.edu',
      'mchen',
    ]);
    expect(identityKeys('  Maya Chen ')).toEqual(['maya chen']);
    expect(identityKeys(null)).toEqual([]);
  });

  it('links commits by email and contributors by name or email, case-insensitively', () => {
    const map = new Map([
      ['mchen', 'u1'],
      ['maya chen', 'u1'],
      ['jrivera@school.edu', 'u2'],
    ]);
    const commits = linkAuthorsToUsers(
      [
        { sha: 'a', author_login: null, author_email: 'JRivera@school.edu' } as CommitRecord,
        { sha: 'b', author_login: null, author_email: '7-mchen@users.noreply.x' } as CommitRecord,
        { sha: 'c', author_login: null, author_email: 'stranger@x.io' } as CommitRecord,
      ],
      map
    );
    expect(commits.map(c => c.author_user_id)).toEqual(['u2', 'u1', null]);
    const contributors = linkContributorsToUsers(
      [
        { login: 'Maya Chen', email: 'maya@home.test' } as ContributorRecord,
        { login: 'J R', email: 'jrivera@school.edu' } as ContributorRecord,
      ],
      map
    );
    expect(contributors.map(c => c.user_id)).toEqual(['u1', 'u2']);
  });
});
