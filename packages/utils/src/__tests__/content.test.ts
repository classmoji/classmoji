import { describe, it, expect } from 'vitest';
import { getContentRepoName } from '../content.ts';

describe('getContentRepoName', () => {
  it('uses settings.content_repo_name when set', () => {
    expect(
      getContentRepoName({
        login: 'cs101',
        settings: { content_repo_name: 'custom-repo' },
      })
    ).toBe('custom-repo');
  });

  it('falls back to content-<login> pattern', () => {
    expect(getContentRepoName({ login: 'cs101' })).toBe('content-cs101');
  });
});
