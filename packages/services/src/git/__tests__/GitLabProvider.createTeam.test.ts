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

describe('GitLabProvider.createTeam (subgroup)', () => {
  it('creates a subgroup under the parent group', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: 5 })) // resolve parent group
      .mockResolvedValueOnce(res(201, { id: 88, path: 'cs101-fall', name: 'CS101 Fall' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    const team = await provider.createTeam('org', 'CS101 Fall');

    expect(team).toEqual({ id: 88, slug: 'cs101-fall', name: 'CS101 Fall' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain('/api/v4/groups');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'CS101 Fall',
      path: 'cs101-fall',
      parent_id: 5,
      visibility: 'private',
    });
  });

  it('is idempotent: fetches the existing subgroup when the path is taken', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: 5 })) // resolve parent group
      .mockResolvedValueOnce(res(400, { message: 'has already been taken' })) // POST fails
      .mockResolvedValueOnce(res(200, { id: 88, path: 'cs101-fall', name: 'CS101 Fall' })); // getTeam
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    const team = await provider.createTeam('org', 'CS101 Fall');

    expect(team).toEqual({ id: 88, slug: 'cs101-fall', name: 'CS101 Fall' });
    expect(fetchMock.mock.calls[2][0]).toContain('/api/v4/groups/org%2Fcs101-fall');
  });
});
