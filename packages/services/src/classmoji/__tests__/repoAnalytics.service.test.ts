import { describe, it, expect } from 'vitest';
import {
  linkAuthorsToUsers,
  linkContributorsToUsers,
} from '../repoAnalytics.service.ts';
import type {
  CommitRecord,
  ContributorRecord,
} from '../repoAnalytics.types.ts';

describe('linkAuthorsToUsers', () => {
  it('maps author_login to author_user_id using the lookup map', () => {
    const commits: CommitRecord[] = [
      {
        sha: 'a',
        author_login: 'alice',
        author_email: null,
        author_user_id: null,
        ts: '2026-01-01T00:00:00Z',
        message: 'first',
        additions: 1,
        deletions: 0,
        parents: [],
      },
    ];
    const map = new Map([['alice', 'user-1']]);

    const out = linkAuthorsToUsers(commits, map);

    expect(out[0].author_user_id).toBe('user-1');
    expect(out[0].author_login).toBe('alice');
  });

  it('leaves author_user_id null when login not in map', () => {
    const commits: CommitRecord[] = [
      {
        sha: 'b',
        author_login: 'stranger',
        author_email: null,
        author_user_id: null,
        ts: '2026-01-02T00:00:00Z',
        message: 'x',
        additions: 0,
        deletions: 0,
        parents: [],
      },
    ];
    const out = linkAuthorsToUsers(commits, new Map([['alice', 'user-1']]));
    expect(out[0].author_user_id).toBeNull();
  });

  it('leaves author_user_id null when author_login itself is null', () => {
    const commits: CommitRecord[] = [
      {
        sha: 'c',
        author_login: null,
        author_email: 'x@y.com',
        author_user_id: null,
        ts: '2026-01-03T00:00:00Z',
        message: 'orphan',
        additions: 0,
        deletions: 0,
        parents: [],
      },
    ];
    const out = linkAuthorsToUsers(commits, new Map([['alice', 'user-1']]));
    expect(out[0].author_user_id).toBeNull();
  });

  it('does not mutate the input array', () => {
    const commits: CommitRecord[] = [
      {
        sha: 'a',
        author_login: 'alice',
        author_email: null,
        author_user_id: null,
        ts: '2026-01-01T00:00:00Z',
        message: 'first',
        additions: 1,
        deletions: 0,
        parents: [],
      },
    ];
    const map = new Map([['alice', 'user-1']]);
    linkAuthorsToUsers(commits, map);
    expect(commits[0].author_user_id).toBeNull();
  });
});

describe('linkContributorsToUsers', () => {
  it('sets user_id when login matches the map', () => {
    const contributors: ContributorRecord[] = [
      { login: 'alice', user_id: null, commits: 5, additions: 100, deletions: 10 },
      { login: 'stranger', user_id: null, commits: 2, additions: 20, deletions: 3 },
    ];
    const map = new Map([['alice', 'user-1']]);

    const out = linkContributorsToUsers(contributors, map);

    expect(out[0].user_id).toBe('user-1');
    expect(out[1].user_id).toBeNull();
  });
});
