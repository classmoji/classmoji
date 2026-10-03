import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabProvider } from '../GitLabProvider.ts';

afterEach(() => vi.unstubAllGlobals());

const res = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  headers: new Headers(),
});

/** Route fetch by `METHOD path-substring`, in order of registration. */
function route(routes: Array<[string, ReturnType<typeof res>]>) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const hit = routes.find(([key]) => {
      const [m, frag] = key.split(' ');
      return m === method && url.includes(frag);
    });
    return hit ? hit[1] : res(404, { message: '404 Not Found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const provider = () => new GitLabProvider('1', 'cs', 'tok', 'https://gitlab.school.edu');

describe('GitLabProvider teams', () => {
  it("creates the class's teams subgroup on first use, then the team inside it", async () => {
    const fetchMock = route([
      ['GET groups/cs%2Fc1%2Fteams', res(404, { message: '404 Group Not Found' })],
      ['GET groups/cs%2Fc1', res(200, { id: 10 })],
      [
        'POST /api/v4/groups',
        res(201, { id: 11, full_path: 'cs/c1/teams', path: 'teams', name: 'Teams' }),
      ],
    ]);
    // Second POST (the team) answers with the team.
    let posts = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('groups/cs%2Fc1%2Fteams')) return res(404, {});
      if (method === 'GET' && url.includes('groups/cs%2Fc1')) return res(200, { id: 10 });
      if (method === 'POST' && url.endsWith('/api/v4/groups')) {
        posts += 1;
        const body = JSON.parse(init?.body ?? '{}');
        return posts === 1
          ? res(201, { id: 11, full_path: 'cs/c1/teams' })
          : res(201, { id: 12, path: body.path, name: body.name, parent: body.parent_id });
      }
      return res(404, {});
    });

    const team = await provider().createTeam('cs/c1/teams', 'Team Rocket');

    expect(team).toEqual({ id: 12, slug: 'team-rocket', name: 'Team Rocket' });
    const bodies = fetchMock.mock.calls
      .filter(([, init]) => (init as { method?: string })?.method === 'POST')
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(bodies[0]).toMatchObject({ path: 'teams', parent_id: 10 });
    expect(bodies[1]).toMatchObject({ path: 'team-rocket', parent_id: 11, visibility: 'private' });
  });

  it('shares a team project with the team subgroup as Developer', async () => {
    const fetchMock = route([
      ['GET groups/cs%2Fc1%2Fteams%2Fteam-rocket', res(200, { id: 12 })],
      ['POST /share', res(201, {})],
    ]);
    await provider().addTeamToRepo('cs/c1', 'proj-team-rocket', 'cs/c1/teams/team-rocket', 'push');
    const share = fetchMock.mock.calls.find(([url]) => String(url).includes('/share'));
    expect(String(share?.[0])).toContain('projects/cs%2Fc1%2Fproj-team-rocket/share');
    expect(JSON.parse((share?.[1] as { body: string }).body)).toEqual({
      group_id: 12,
      group_access: 30,
    });
  });

  it('treats an existing share as done', async () => {
    route([
      ['GET groups/cs%2Fc1%2Fteams%2Fteam-rocket', res(200, { id: 12 })],
      ['POST /share', res(409, { message: 'Group already shared with this group' })],
    ]);
    await expect(
      provider().addTeamToRepo('cs/c1', 'proj-team-rocket', 'cs/c1/teams/team-rocket', 'push')
    ).resolves.toBeUndefined();
  });

  it('lists no teams before the teams subgroup exists, and deleting a missing team is fine', async () => {
    route([]);
    await expect(provider().getTeams('cs/c1/teams')).resolves.toEqual([]);
    await expect(provider().deleteTeam('cs/c1/teams', 'gone')).resolves.toBeUndefined();
  });
});
