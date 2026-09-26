import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabProvider } from '../GitLabProvider.ts';

afterEach(() => vi.unstubAllGlobals());

describe('GitLabProvider base URL', () => {
  it('calls the instance it was given', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 5 }),
      headers: new Headers(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('1', 'g', 'tok', 'https://gitlab.school.edu/');
    await provider.resolveGroupId('cs');

    expect(fetchMock.mock.calls[0][0]).toBe('https://gitlab.school.edu/api/v4/groups/cs');
    expect(provider.getCloneUrl('cs', 'hw1', 't')).toBe(
      'https://oauth2:t@gitlab.school.edu/cs/hw1.git'
    );
  });

  it('defaults to gitlab.com', () => {
    expect(new GitLabProvider('1').baseUrl).toBe('https://gitlab.com');
  });
});
