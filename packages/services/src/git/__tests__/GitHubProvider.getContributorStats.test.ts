import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';
import type { ContributorRecord } from '../../classmoji/repoAnalytics.types.ts';

function makeFakeOctokit(response: { status: number; data: unknown }) {
  const fakeOctokit = {
    request: vi.fn(async (_route: string, _params: unknown) => response),
    paginate: {
      iterator() {
        return {
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            return;
          },
        };
      },
    },
  };
  return fakeOctokit;
}

describe('GitHubProvider.getContributorStats', () => {
  it('returns { pending: true } when GitHub responds 202 (cache warming)', async () => {
    const fakeOctokit = makeFakeOctokit({ status: 202, data: null });

    const provider = new GitHubProvider('1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as unknown as { _octokit: unknown })._octokit = fakeOctokit as any;

    const result = await provider.getContributorStats('org', 'repo');
    expect(result).toEqual({ pending: true });
  });

  it('maps contributor rows into ContributorRecord[] when GitHub responds 200', async () => {
    const fakeOctokit = makeFakeOctokit({
      status: 200,
      data: [
        {
          author: { login: 'ada' },
          total: 3,
          weeks: [
            { a: 10, d: 2 },
            { a: 5, d: 0 },
          ],
        },
      ],
    });

    const provider = new GitHubProvider('1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as unknown as { _octokit: unknown })._octokit = fakeOctokit as any;

    const result = (await provider.getContributorStats('org', 'repo')) as ContributorRecord[];
    expect(result).toEqual([
      {
        login: 'ada',
        user_id: null,
        commits: 3,
        additions: 15,
        deletions: 2,
      },
    ]);
  });
});
