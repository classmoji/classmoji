import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findFirstMock = vi.fn();
const updateMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    account: {
      findFirst: (...a: unknown[]) => findFirstMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
    },
  }),
}));

const { getGitLabTokenForUser } = await import('../gitlabUserToken.service.ts');

beforeEach(() => {
  findFirstMock.mockReset();
  updateMock.mockReset();
  process.env.GITLAB_CLIENT_ID = 'cid';
  process.env.GITLAB_CLIENT_SECRET = 'csecret';
});
afterEach(() => vi.unstubAllGlobals());

describe('getGitLabTokenForUser', () => {
  it('returns the stored token when it is still valid (no refresh)', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    findFirstMock.mockResolvedValueOnce({
      id: 'a1',
      access_token: 'valid',
      refresh_token: 'r',
      access_token_expires_at: future,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getGitLabTokenForUser('u1');

    expect(result).toEqual({ token: 'valid', expiresAt: future });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the rotated tokens', async () => {
    const past = new Date(Date.now() - 1000);
    findFirstMock.mockResolvedValueOnce({
      id: 'a1',
      access_token: 'old',
      refresh_token: 'oldR',
      access_token_expires_at: past,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ access_token: 'new', refresh_token: 'newR', expires_in: 7200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getGitLabTokenForUser('u1');

    expect(result?.token).toBe('new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gitlab.com/oauth/token');
    expect(String(init.body)).toContain('grant_type=refresh_token');

    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateArg = updateMock.mock.calls[0][0];
    expect(updateArg.data.access_token).toBe('new');
    expect(updateArg.data.refresh_token).toBe('newR');
  });

  it('returns null when the user has no GitLab account', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    expect(await getGitLabTokenForUser('u1')).toBeNull();
  });
});
