import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabProvider } from '../GitLabProvider.ts';

function res(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    headers: new Headers(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('GitLabProvider.getUserByLogin', () => {
  it('returns the first matching user', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, [{ id: 1, username: 'ada' }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    const user = await provider.getUserByLogin('ada');

    expect(user).toEqual({ id: 1, username: 'ada' });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v4/users?username=ada');
  });

  it('returns null when no user matches', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(200, []));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    expect(await provider.getUserByLogin('nobody')).toBeNull();
  });
});
