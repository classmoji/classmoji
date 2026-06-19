import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';

describe('GitHubProvider.listPulls', () => {
  it('counts open, merged, and closed-unmerged PRs into PRSummary', async () => {
    const fakeOctokit = {
      rest: {
        pulls: {
          list: vi.fn(async (_params: unknown) => ({
            data: [
              { state: 'open', merged_at: null },
              { state: 'closed', merged_at: '2026-01-02T00:00:00Z' },
              { state: 'closed', merged_at: null },
            ],
          })),
        },
      },
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

    const provider = new GitHubProvider('1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as unknown as { _octokit: unknown })._octokit = fakeOctokit as any;

    const result = await provider.listPulls('org', 'repo');
    expect(result).toEqual({ open: 1, merged: 1, closed: 1 });
    expect(fakeOctokit.rest.pulls.list).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
      state: 'all',
      per_page: 100,
    });
  });
});
