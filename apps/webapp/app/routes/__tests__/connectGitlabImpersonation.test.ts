/**
 * "Connect Gitlab" (/connect/gitlab and its callback) while viewing as another
 * user. The session then belongs to the viewed user, so a connection made now
 * would be stored on their account: both routes answer 403 before anything
 * else, and the callback stores nothing. A normal session goes through as
 * before.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  oauthClient: vi.fn(),
  exchangeCode: vi.fn(),
  fetchTokenUser: vi.fn(),
  saveConnection: vi.fn(),
  findForUser: vi.fn(),
  cookieParse: vi.fn(),
  cookieSerialize: vi.fn(),
  gitlabInstanceForUser: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  requireAuth: (...a: unknown[]) => mocks.requireAuth(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitlabInstance: { oauthClient: (...a: unknown[]) => mocks.oauthClient(...a) },
    gitlabConnection: {
      CONNECTION_SCOPES: ['api', 'read_user'],
      exchangeCode: (...a: unknown[]) => mocks.exchangeCode(...a),
      fetchTokenUser: (...a: unknown[]) => mocks.fetchTokenUser(...a),
      saveConnection: (...a: unknown[]) => mocks.saveConnection(...a),
      findForUser: (...a: unknown[]) => mocks.findForUser(...a),
    },
  },
}));
vi.mock('~/utils/gitlabConnect.server', () => ({
  gitlabConnectCookie: {
    parse: (...a: unknown[]) => mocks.cookieParse(...a),
    serialize: (...a: unknown[]) => mocks.cookieSerialize(...a),
  },
  gitlabConnectRedirectUri: () => 'http://localhost:3000/connect/gitlab/callback',
  safeReturnTo: (value: string | null) => value ?? '/create-classroom?provider=gitlab',
}));
vi.mock('~/utils/gitlabInstance.server', () => ({
  gitlabInstanceForUser: (...a: unknown[]) => mocks.gitlabInstanceForUser(...a),
}));

const start = await import('../connect.gitlab/route.ts');
const callback = await import('../connect.gitlab_.callback/route.ts');
const { GITLAB_CONNECT_IMPERSONATION_MESSAGE } = await import('../../utils/impersonationSession');

const OWN = { userId: 'student-1', session: { session: { impersonatedBy: null } } };
const VIEWING_AS = { userId: 'student-1', session: { session: { impersonatedBy: 'admin-1' } } };

const startLoader = () =>
  start.loader({
    request: new Request('http://localhost:3000/connect/gitlab?returnTo=/create-classroom'),
  } as unknown as Parameters<typeof start.loader>[0]);

const callbackLoader = () =>
  callback.loader({
    request: new Request('http://localhost:3000/connect/gitlab/callback?state=s1&code=c1'),
  } as unknown as Parameters<typeof callback.loader>[0]);

/** The thrown or returned Response of a loader. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    r => r as Response,
    e => e as Response
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.gitlabInstanceForUser.mockResolvedValue(null);
  mocks.oauthClient.mockResolvedValue({ host: 'https://gitlab.test', clientId: 'client-1' });
  mocks.cookieSerialize.mockResolvedValue('gitlab-connect=signed');
  mocks.cookieParse.mockResolvedValue({
    state: 's1',
    verifier: 'v1',
    userId: 'student-1',
    returnTo: '/create-classroom?provider=gitlab',
    instanceId: null,
  });
  mocks.findForUser.mockResolvedValue(null);
  mocks.exchangeCode.mockResolvedValue({ accessToken: 't', scope: 'api read_user' });
  mocks.fetchTokenUser.mockResolvedValue({ id: 1, username: 'someone' });
});

describe('/connect/gitlab', () => {
  it('answers 403 while viewing as another user, before starting anything', async () => {
    mocks.requireAuth.mockResolvedValue(VIEWING_AS);
    const res = await outcome(startLoader());

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(GITLAB_CONNECT_IMPERSONATION_MESSAGE);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(mocks.oauthClient).not.toHaveBeenCalled();
    expect(mocks.cookieSerialize).not.toHaveBeenCalled();
  });

  it('sends a normal session on to Gitlab as before', async () => {
    mocks.requireAuth.mockResolvedValue(OWN);
    const res = await outcome(startLoader());

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/gitlab\.test\/oauth\/authorize\?/);
    expect(res.headers.get('set-cookie')).toBe('gitlab-connect=signed');
  });
});

describe('/connect/gitlab/callback', () => {
  it('answers 403 while viewing as another user and stores nothing', async () => {
    mocks.requireAuth.mockResolvedValue(VIEWING_AS);
    const res = await outcome(callbackLoader());

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(GITLAB_CONNECT_IMPERSONATION_MESSAGE);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.saveConnection).not.toHaveBeenCalled();
  });

  it('stores the connection for a normal session as before', async () => {
    mocks.requireAuth.mockResolvedValue(OWN);
    const res = await outcome(callbackLoader());

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('gitlab=connected');
    expect(mocks.saveConnection).toHaveBeenCalledWith(
      'student-1',
      expect.objectContaining({ accessToken: 't' }),
      expect.objectContaining({ username: 'someone' }),
      null
    );
  });
});
