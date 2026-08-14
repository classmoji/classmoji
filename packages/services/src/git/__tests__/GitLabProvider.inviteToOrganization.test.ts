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

describe('GitLabProvider.inviteToOrganization', () => {
  it('invites by email via /invitations (default Reporter level)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: 5 })) // resolve group
      .mockResolvedValueOnce(res(201, {}));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    await provider.inviteToOrganization('org', 'ta@school.edu');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain('/api/v4/groups/5/invitations');
    expect(JSON.parse(init.body)).toEqual({ email: 'ta@school.edu', access_level: 20 });
  });

  it('adds a username as a member (resolves user id) with the given level', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(200, { id: 5 })) // resolve group
      .mockResolvedValueOnce(res(200, [{ id: 77 }])) // resolve user
      .mockResolvedValueOnce(res(201, {}));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('g', 'g', 'tok');
    await provider.inviteToOrganization('org', 'ada', undefined, 40);

    expect(fetchMock.mock.calls[1][0]).toContain('/api/v4/users?username=ada');
    const [memUrl, memInit] = fetchMock.mock.calls[2];
    expect(memUrl).toContain('/api/v4/groups/5/members');
    expect(JSON.parse(memInit.body)).toEqual({ user_id: 77, access_level: 40 });
  });
});
