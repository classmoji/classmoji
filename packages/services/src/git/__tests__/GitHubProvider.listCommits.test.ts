import { describe, it, expect } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';
import type { CommitRecord } from '../../classmoji/repoAnalytics.types.ts';

type FakeCommitSummary = {
  sha: string;
  author: { login: string } | null;
  commit: {
    author: { email: string; date: string } | null;
    message: string;
  };
  parents: { sha: string }[];
};

function makeFakeOctokit(pages: FakeCommitSummary[][], fullMap: Record<string, { stats: { additions: number; deletions: number } }>) {
  const calls: { listArgs: unknown; getCommitRefs: string[] } = {
    listArgs: null,
    getCommitRefs: [],
  };

  const listCommitsMethod = Object.assign(
    (() => {
      throw new Error('listCommits should be called via paginate.iterator in listCommits()');
    }) as unknown as (...args: unknown[]) => unknown,
    {},
  );

  const fakeOctokit = {
    paginate: {
      iterator(method: unknown, args: unknown) {
        calls.listArgs = args;
        // Ensure we received the expected endpoint reference
        if (method !== listCommitsMethod) {
          throw new Error('unexpected list method passed to paginate.iterator');
        }
        let i = 0;
        return {
          async *[Symbol.asyncIterator]() {
            for (; i < pages.length; i++) {
              yield { data: pages[i] };
            }
          },
        };
      },
    },
    rest: {
      repos: {
        listCommits: listCommitsMethod,
        async getCommit({ ref }: { owner: string; repo: string; ref: string }) {
          calls.getCommitRefs.push(ref);
          const full = fullMap[ref];
          if (!full) throw new Error(`no fake full commit for ${ref}`);
          return { data: full };
        },
      },
    },
    _calls: calls,
  };

  return fakeOctokit;
}

describe('GitHubProvider.listCommits', () => {
  it('maps commit summaries + per-commit stats into CommitRecord[]', async () => {
    const fakeOctokit = makeFakeOctokit(
      [
        [
          {
            sha: 'aaa111',
            author: { login: 'alice' },
            commit: {
              author: { email: 'alice@example.com', date: '2026-01-01T12:00:00Z' },
              message: 'first commit',
            },
            parents: [],
          },
          {
            sha: 'bbb222',
            author: { login: 'bob' },
            commit: {
              author: { email: 'bob@example.com', date: '2026-01-02T12:00:00Z' },
              message: 'second commit',
            },
            parents: [{ sha: 'aaa111' }],
          },
        ],
      ],
      {
        aaa111: { stats: { additions: 10, deletions: 2 } },
        bbb222: { stats: { additions: 5, deletions: 1 } },
      },
    );

    const provider = new GitHubProvider('1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as unknown as { _octokit: unknown })._octokit = fakeOctokit as any;

    const commits: CommitRecord[] = await provider.listCommits('org', 'repo');

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'aaa111',
      author_login: 'alice',
      author_email: 'alice@example.com',
      author_user_id: null,
      ts: '2026-01-01T12:00:00Z',
      message: 'first commit',
      additions: 10,
      deletions: 2,
      parents: [],
    });
    expect(commits[1]).toEqual({
      sha: 'bbb222',
      author_login: 'bob',
      author_email: 'bob@example.com',
      author_user_id: null,
      ts: '2026-01-02T12:00:00Z',
      message: 'second commit',
      additions: 5,
      deletions: 1,
      parents: ['aaa111'],
    });
  });

  it('returns author_login: null when GitHub author is null (non-linked email)', async () => {
    const fakeOctokit = makeFakeOctokit(
      [
        [
          {
            sha: 'ccc333',
            author: null,
            commit: {
              author: { email: 'stranger@example.com', date: '2026-01-03T12:00:00Z' },
              message: 'orphan commit',
            },
            parents: [{ sha: 'bbb222' }],
          },
        ],
      ],
      {
        ccc333: { stats: { additions: 1, deletions: 1 } },
      },
    );

    const provider = new GitHubProvider('1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as unknown as { _octokit: unknown })._octokit = fakeOctokit as any;

    const commits = await provider.listCommits('org', 'repo');
    expect(commits).toHaveLength(1);
    expect(commits[0].author_login).toBeNull();
    expect(commits[0].author_email).toBe('stranger@example.com');
    expect(commits[0].parents).toEqual(['bbb222']);
  });
});
