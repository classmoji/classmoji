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

describe('GitLabProvider.createRepository', () => {
  it('resolves the group namespace and creates a private project', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: 42 })) // GET /groups/:path
      .mockResolvedValueOnce(
        res(201, { id: 100, path: 'hw1', web_url: 'https://gitlab.com/g/hw1' })
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    const repo = await provider.createRepository('my-group', 'HW1', true);

    expect(repo).toEqual({ id: '100', name: 'hw1', url: 'https://gitlab.com/g/hw1' });

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v4/groups/my-group');
    const [projUrl, projInit] = fetchMock.mock.calls[1];
    expect(projUrl).toContain('/api/v4/projects');
    expect(projInit.method).toBe('POST');
    expect(JSON.parse(projInit.body)).toEqual({
      name: 'HW1',
      path: 'hw1',
      namespace_id: 42,
      visibility: 'private',
    });
  });

  it('creates a public project when isPrivate is false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: 7 }))
      .mockResolvedValueOnce(res(201, { id: 9, path: 'p', web_url: 'u' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    await provider.createRepository('grp', 'P', false);

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).visibility).toBe('public');
  });
});
