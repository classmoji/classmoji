import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabProvider } from '../GitLabProvider.ts';

afterEach(() => vi.unstubAllGlobals());

function stubEvents(events: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(events),
    headers: new Headers(),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GitLabProvider.getPushTime', () => {
  const provider = () => new GitLabProvider('1', 'g', 'tok', 'https://gitlab.school.edu');

  it("returns GitLab's server time for the push that moved the branch to the sha", async () => {
    const fetchMock = stubEvents([
      { created_at: '2026-09-26T18:00:00Z', push_data: { commit_to: 'other' } },
      { created_at: '2026-09-26T17:30:00Z', push_data: { commit_to: 'abc123' } },
    ]);
    const time = await provider().getPushTime('cs/c1', 'hw1-alice', 'abc123');
    expect(time?.toISOString()).toBe('2026-09-26T17:30:00.000Z');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gitlab.school.edu/api/v4/projects/cs%2Fc1%2Fhw1-alice/events?action=pushed&per_page=50'
    );
  });

  it('returns null when no push event matches', async () => {
    stubEvents([{ created_at: '2026-09-26T18:00:00Z', push_data: { commit_to: 'other' } }]);
    await expect(provider().getPushTime('cs/c1', 'hw1-alice', 'abc123')).resolves.toBeNull();
  });
});

describe('GitLabProvider.listDefaultBranchPushes', () => {
  it('returns default-branch pushes after `since`, oldest first, skipping deletions and other branches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ default_branch: 'main' }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              created_at: '2026-09-26T12:00:00Z',
              author_username: 'alice',
              push_data: { ref: 'main', ref_type: 'branch', action: 'pushed', commit_to: 'c3' },
            },
            {
              created_at: '2026-09-26T11:00:00Z',
              author_username: 'alice',
              push_data: { ref: 'feature', ref_type: 'branch', action: 'pushed', commit_to: 'f1' },
            },
            {
              created_at: '2026-09-26T10:00:00Z',
              author_username: 'alice',
              push_data: { ref: 'main', ref_type: 'branch', action: 'removed', commit_to: null },
            },
            {
              created_at: '2026-09-26T09:00:00Z',
              author_username: 'prof',
              push_data: { ref: 'main', ref_type: 'branch', action: 'pushed', commit_to: 'c1' },
            },
            {
              created_at: '2026-09-25T09:00:00Z',
              author_username: 'alice',
              push_data: { ref: 'main', ref_type: 'branch', action: 'pushed', commit_to: 'old' },
            },
          ]),
        headers: new Headers(),
      });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GitLabProvider('1', 'g', 'tok', 'https://gitlab.school.edu');
    const pushes = await provider.listDefaultBranchPushes(
      'cs/c1',
      'hw1-alice',
      new Date('2026-09-26T00:00:00Z')
    );

    expect(pushes.map(p => [p.sha, p.author])).toEqual([
      ['c1', 'prof'],
      ['c3', 'alice'],
    ]);
    expect(String(fetchMock.mock.calls[1][0])).toContain('action=pushed');
    expect(String(fetchMock.mock.calls[1][0])).toContain('after=2026-09-25');
  });
});
