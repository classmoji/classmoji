import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';

describe('GitHubProvider.getLanguages', () => {
  it('returns the languages map from GitHub unchanged', async () => {
    const fakeOctokit = {
      rest: {
        repos: {
          listLanguages: vi.fn(async (_params: unknown) => ({
            data: { TypeScript: 1234, CSS: 56 },
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

    const result = await provider.getLanguages('org', 'repo');
    expect(result).toEqual({ TypeScript: 1234, CSS: 56 });
    expect(fakeOctokit.rest.repos.listLanguages).toHaveBeenCalledWith({
      owner: 'org',
      repo: 'repo',
    });
  });
});
