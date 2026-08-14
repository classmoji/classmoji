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

describe('GitLabProvider.addCollaborator', () => {
  it('adds a user to a project with the mapped access level (developer → 30)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ id: 77 }])) // resolve user
      .mockResolvedValueOnce(res(201, {}));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    await provider.addCollaborator('grp', 'proj', 'ada', 'developer');

    const [memUrl, memInit] = fetchMock.mock.calls[1];
    expect(memUrl).toContain('/api/v4/projects/grp%2Fproj/members');
    expect(JSON.parse(memInit.body)).toEqual({ user_id: 77, access_level: 30 });
  });

  it('maps GitHub-style permission names (push → 30, maintain → 40)', async () => {
    const provider = new GitLabProvider('g', 'g', 'tok');
    for (const [perm, level] of [
      ['push', 30],
      ['maintain', 40],
      ['pull', 20],
    ] as const) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(res(200, [{ id: 1 }]))
        .mockResolvedValueOnce(res(201, {}));
      vi.stubGlobal('fetch', fetchMock);
      await provider.addCollaborator('grp', 'proj', 'ada', perm);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).access_level).toBe(level);
      vi.unstubAllGlobals();
    }
  });
});
