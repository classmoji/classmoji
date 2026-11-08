/**
 * The admin app's better-auth handler (api.auth.$):
 *   - it hands better-auth exactly the two calls this app makes, View as start
 *     (POST /admin/impersonate-user) and sign-out (POST /sign-out), and answers
 *     404 to everything else before better-auth runs: the authorization
 *     server's endpoints and discovery documents, registration, the rest of
 *     the admin plugin, those two paths by another method, and other
 *     spellings of any path;
 *   - session responses leave without their rows' `token` field, with
 *     better-auth's status and headers (Set-Cookie included); other responses
 *     pass through as sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handler = vi.fn();

vi.mock('@classmoji/auth/server', () => ({ auth: { handler: (r: Request) => handler(r) } }));

const route = await import('../api.auth.$.ts');

const ORIGIN = 'http://localhost:7500';
const BASE = `${ORIGIN}/api/auth`;

const betterAuthResponse = (body: unknown) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', 'classmoji.session_token=abc; Path=/; HttpOnly');
  return new Response(JSON.stringify(body), { status: 200, headers });
};

/** A request as the route gets it: GET, HEAD and OPTIONS to the loader, the rest to the action. */
function send(url: string, method = 'GET', body?: unknown): Promise<Response> {
  const request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const run = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? route.loader : route.action;
  return run({ request } as never) as Promise<Response>;
}

beforeEach(() => {
  handler.mockReset();
  handler.mockResolvedValue(betterAuthResponse({ success: true }));
});

describe('admin api.auth.$: the calls this app makes', () => {
  it('serves a View as start without the token field, keeping the cookie', async () => {
    handler.mockResolvedValue(
      betterAuthResponse({ session: { id: 'sess-2', token: 'value-2' }, user: { id: 'user-1' } })
    );

    const res = await send(`${BASE}/admin/impersonate-user`, 'POST', { userId: 'user-1' });

    expect(handler).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ session: { id: 'sess-2' }, user: { id: 'user-1' } });
    expect(res.headers.getSetCookie()).toEqual(['classmoji.session_token=abc; Path=/; HttpOnly']);
  });

  it('passes sign-out through as sent', async () => {
    const sent = betterAuthResponse({ success: true });
    handler.mockResolvedValue(sent);

    const res = await send(`${BASE}/sign-out`, 'POST');

    expect(res).toBe(sent);
    expect(handler.mock.calls[0]![0].url).toBe(`${BASE}/sign-out`);
  });

  it('hands them on with a query string too', async () => {
    await send(`${BASE}/sign-out?from=shell`, 'POST');
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('admin api.auth.$: everything else is 404, before better-auth', () => {
  const expectNotFound = async (res: Response) => {
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  };

  it.each([
    // The authorization server.
    ['GET', '/oauth2/authorize?client_id=c1&response_type=code'],
    ['POST', '/oauth2/token'],
    ['POST', '/oauth2/consent'],
    ['POST', '/oauth2/revoke'],
    ['POST', '/oauth2/continue'],
    ['POST', '/oauth2/introspect'],
    ['GET', '/oauth2/userinfo'],
    ['GET', '/jwks'],
    ['GET', '/token'],
    // Registration, at the current and the 1.4 path.
    ['POST', '/oauth2/register'],
    ['POST', '/mcp/register'],
    ['POST', '/mcp/token'],
    ['GET', '/mcp/authorize'],
    // Discovery under the auth path.
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/.well-known/openid-configuration'],
    // The rest of the admin plugin, and of better-auth.
    ['POST', '/admin/stop-impersonating'],
    ['POST', '/admin/set-role'],
    ['GET', '/admin/list-users'],
    ['POST', '/admin/set-user-password'],
    ['GET', '/get-session'],
    ['POST', '/sign-in/email'],
    ['POST', '/sign-up/email'],
    ['POST', '/sign-in/social'],
    ['POST', '/gitlab-instance/sign-in'],
  ])('%s %s', async (method, path) => {
    await expectNotFound(await send(`${BASE}${path}`, method, method === 'POST' ? {} : undefined));
  });

  it.each([
    ['GET', '/sign-out'],
    ['GET', '/admin/impersonate-user'],
    ['PUT', '/sign-out'],
    ['DELETE', '/admin/impersonate-user'],
    ['OPTIONS', '/admin/impersonate-user'],
  ])('the calls by another method: %s %s', async (method, path) => {
    await expectNotFound(await send(`${BASE}${path}`, method));
  });

  it.each([
    ['an encoded slash', '/api/auth/admin%2Fimpersonate-user'],
    ['an encoded slash in the auth path', '/api%2Fauth/sign-out'],
    ['a trailing slash', '/api/auth/sign-out/'],
    ['another case', '/api/auth/SIGN-OUT'],
    ['another case in the auth path', '/API/auth/sign-out'],
    ['a doubled slash', '/api/auth//sign-out'],
    ['a dot segment to the token endpoint', '/api/auth/sign-out/../oauth2/token'],
    ['an encoded dot segment to registration', '/api/auth/sign-out/%2e%2e/oauth2/register'],
    [
      'dot segments out of the View as path',
      '/api/auth/admin/impersonate-user/../../oauth2/register',
    ],
    ['a path parameter', '/api/auth/sign-out;x=1'],
    ['an encoded NUL', '/api/auth/sign-out%00'],
    ['an encoded letter', '/api/auth/sign-ou%74'],
    ['no auth path', '/sign-out'],
  ])('%s (%s)', async (_label, path) => {
    await expectNotFound(await send(`${ORIGIN}${path}`, 'POST', {}));
  });
});
