/**
 * Where the Connect GitLab callback sends the browser back to. The round-trip
 * cookie is a real signed one (from `gitlabConnectCookie`), so a value it
 * carries from before the current rule is handled as it would be in a browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthMock = vi.fn();

vi.mock('@classmoji/auth/server', () => ({
  AUTH_SECRET: 'test-secret',
  requireAuth: (...a: unknown[]) => requireAuthMock(...a),
}));

vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

const { gitlabConnectCookie } = await import('~/utils/gitlabConnect.server');
const { loader } = await import('../connect.gitlab_.callback/route');

const USER = 'user-1';

/** The callback request GitLab makes after a declined grant, with our cookie. */
const declinedCallback = async (returnTo: string) => {
  const cookie = (
    await gitlabConnectCookie.serialize({
      state: 'st',
      verifier: 'v',
      userId: USER,
      returnTo,
      instanceId: null,
    })
  ).split(';')[0];
  const request = new Request(
    'http://app.test/connect/gitlab/callback?state=st&error=access_denied',
    { headers: { Cookie: cookie } }
  );
  return (await loader({ request, params: {}, context: {} } as never)) as Response;
};

beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: USER });
});

describe('connect.gitlab callback return path', () => {
  it('returns to the saved path with the outcome added', async () => {
    const response = await declinedCallback('/settings?tab=git');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/settings?tab=git&gitlab=denied');
  });

  it.each(['/..//host.example', '/.//host.example', '/%2e%2e//host.example', '//host.example'])(
    'replaces the saved value %j with the default, keeping the outcome',
    async returnTo => {
      const response = await declinedCallback(returnTo);
      const location = response.headers.get('Location');
      expect(location).toBe('/create-classroom?provider=gitlab&gitlab=denied');
      expect(new URL(location as string, 'http://app.test').origin).toBe('http://app.test');
    }
  );
});
