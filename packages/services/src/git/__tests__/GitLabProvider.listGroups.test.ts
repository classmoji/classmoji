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

describe('GitLabProvider.listGroups', () => {
  it('lists Maintainer+ groups and maps to the option shape', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      res(200, [
        { id: 1, full_path: 'uni', name: 'Uni', avatar_url: 'a' },
        { id: 2, full_path: 'uni/cs', name: 'CS', avatar_url: null },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('', '', 'tok');
    const groups = await provider.listGroups();

    expect(groups).toEqual([
      { id: 1, full_path: 'uni', name: 'Uni', avatar_url: 'a' },
      { id: 2, full_path: 'uni/cs', name: 'CS', avatar_url: null },
    ]);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('/api/v4/groups');
    expect(url).toContain('min_access_level=40');
  });

  it('returns [] on empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(res(200, [])));
    const provider = new GitLabProvider('', '', 'tok');
    expect(await provider.listGroups()).toEqual([]);
  });
});
