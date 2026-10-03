import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitLabProvider } from '../GitLabProvider.ts';

const URL_NOW = 'https://hooks.classmoji.io/webhooks/callback/gitlab';

function res(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    headers: new Headers(),
  };
}

/** fetch mock: GET returns `hooks`, everything else succeeds. */
function mockHooks(hooks: Array<{ id: number; url: string; name?: string }>) {
  const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) =>
    (init?.method ?? 'GET') === 'GET' ? res(200, hooks) : res(200, {})
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof mockHooks>) =>
  fetchMock.mock.calls.map(([url, init]) => ({
    method: (init as { method?: string } | undefined)?.method ?? 'GET',
    url: String(url),
    body: (init as { body?: string } | undefined)?.body
      ? JSON.parse((init as { body: string }).body)
      : undefined,
  }));

afterEach(() => vi.unstubAllGlobals());

describe('GitLabProvider.ensureProjectPushHook', () => {
  const provider = () => new GitLabProvider('1', 'g', 'tok', 'https://gitlab.school.edu');

  it('creates a named hook when the project has none', async () => {
    const fetchMock = mockHooks([]);
    await expect(
      provider().ensureProjectPushHook('cs/c1', 'hw1-alice', URL_NOW, 's3')
    ).resolves.toBe('created');
    const post = calls(fetchMock).find(c => c.method === 'POST');
    expect(post?.body).toMatchObject({
      url: URL_NOW,
      token: 's3',
      name: 'Classmoji',
      push_events: true,
      issues_events: true,
    });
  });

  it('always re-sets the token on an existing hook (GitLab never returns it)', async () => {
    const fetchMock = mockHooks([{ id: 7, url: URL_NOW }]);
    await expect(
      provider().ensureProjectPushHook('cs/c1', 'hw1-alice', URL_NOW, 's3')
    ).resolves.toBe('updated');
    const put = calls(fetchMock).find(c => c.method === 'PUT');
    expect(put?.url).toContain('/hooks/7');
    expect(put?.body).toMatchObject({ url: URL_NOW, token: 's3' });
  });

  it('repoints a hook left on an old Classmoji URL instead of adding another', async () => {
    const fetchMock = mockHooks([
      { id: 3, url: 'https://smee.io/oldchannel' },
      { id: 4, url: 'https://ci.example.com/build' },
    ]);
    await provider().ensureProjectPushHook('cs/c1', 'hw1-alice', URL_NOW, 's3');
    const c = calls(fetchMock);
    expect(c.find(x => x.method === 'POST')).toBeUndefined();
    expect(c.find(x => x.method === 'PUT')?.url).toContain('/hooks/3');
    // Someone else's hook is left alone.
    expect(c.some(x => x.url.includes('/hooks/4'))).toBe(false);
  });

  it('keeps the hook on the current URL and deletes duplicates', async () => {
    const fetchMock = mockHooks([
      {
        id: 1,
        url: 'https://old.classmoji.io/webhooks/callback/gitlab/3f1c2b9e-8a7d-4c1e-9b2a-5d6e7f8a9b0c',
      },
      { id: 2, url: URL_NOW },
      { id: 5, url: 'https://elsewhere.example.com/x', name: 'Classmoji' },
    ]);
    await provider().ensureProjectPushHook('cs/c1', 'hw1-alice', URL_NOW, 's3');
    const c = calls(fetchMock);
    expect(c.find(x => x.method === 'PUT')?.url).toContain('/hooks/2');
    const deleted = c.filter(x => x.method === 'DELETE').map(x => x.url.split('/hooks/')[1]);
    expect(deleted.sort()).toEqual(['1', '5']);
  });
});
