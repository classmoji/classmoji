import { describe, it, expect } from 'vitest';
import {
  linkAuthorsToUsers,
  linkContributorsToUsers,
} from '../repoAnalytics.service.ts';
import type {
  CommitRecord,
  ContributorRecord,
} from '../repoAnalytics.types.ts';

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
