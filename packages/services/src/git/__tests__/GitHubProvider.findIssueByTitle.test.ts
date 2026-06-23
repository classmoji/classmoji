import { describe, it, expect } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';

function makeFakeOctokit(pages: unknown[][]) {
  const calls: { listArgs: unknown; pagesYielded: number } = {
    listArgs: null,
    pagesYielded: 0,
  };

  const listForRepoMethod = Object.assign(
    (() => {
      throw new Error('listForRepo should be called via paginate.iterator');
    }) as unknown as (...args: unknown[]) => unknown,
    {}
  );

  const fakeOctokit = {
    paginate: {
      iterator(method: unknown, args: unknown) {
        calls.listArgs = args;
        if (method !== listForRepoMethod) {
          throw new Error('unexpected list method passed to paginate.iterator');
        }
        let i = 0;
        return {
          async *[Symbol.asyncIterator]() {
            for (; i < pages.length; i++) {
              calls.pagesYielded += 1;
              yield { data: pages[i] };
            }
          },
        };
      },
    },
    rest: {
      issues: {
        listForRepo: listForRepoMethod,
      },
    },
    _calls: calls,
  };

  return fakeOctokit;
}

describe('GitHubProvider.findIssueByTitle', () => {
  it('returns the first exact issue title match and ignores pull requests', async () => {
    const fakeOctokit = makeFakeOctokit([
      [
        {
          id: 1,
          number: 10,
          title: 'Assignment 1',
          html_url: 'https://github.com/org/repo/pull/10',
          pull_request: {},
        },
        {
          id: 2,
          number: 11,
          title: 'Assignment 1',
          html_url: 'https://github.com/org/repo/issues/11',
        },
      ],
    ]);

    const provider = new GitHubProvider('1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as unknown as { _octokit: unknown })._octokit = fakeOctokit as any;

    const issue = await provider.findIssueByTitle('org', 'repo', 'Assignment 1');

    expect(issue).toEqual({
      id: '2',
      number: 11,
      url: 'https://github.com/org/repo/issues/11',
    });
    expect(fakeOctokit._calls.listArgs).toEqual({
      owner: 'org',
      repo: 'repo',
      state: 'all',
      per_page: 100,
    });
    expect(fakeOctokit._calls.pagesYielded).toBe(1);
  });

  it('returns null when no issue has the exact title', async () => {
    const fakeOctokit = makeFakeOctokit([
      [
        {
          id: 1,
          number: 10,
          title: 'Assignment 10',
          html_url: 'https://github.com/org/repo/issues/10',
        },
      ],
    ]);

    const provider = new GitHubProvider('1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as unknown as { _octokit: unknown })._octokit = fakeOctokit as any;

    await expect(provider.findIssueByTitle('org', 'repo', 'Assignment 1')).resolves.toBeNull();
  });
});
