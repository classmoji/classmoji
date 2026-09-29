/**
 * The admin app's better-auth handler (api.auth.$): session responses leave
 * without their rows' `token` field, with better-auth's status and headers
 * (Set-Cookie included); impersonation responses pass through as sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handler = vi.fn();

vi.mock('@classmoji/auth/server', () => ({ auth: { handler: (r: Request) => handler(r) } }));

const route = await import('../api.auth.$.ts');

const BASE = 'http://localhost:7500/api/auth';

const betterAuthResponse = (body: unknown) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', 'classmoji.session_token=abc; Path=/; HttpOnly');
  return new Response(JSON.stringify(body), { status: 200, headers });
};

beforeEach(() => {
  handler.mockReset();
});

describe('admin api.auth.$ — session responses', () => {
  it('serves /get-session without the token field, keeping the cookie', async () => {
    handler.mockResolvedValue(
      betterAuthResponse({ session: { id: 'sess-1', token: 'value-1' }, user: { id: 'admin-1' } })
    );

    const res = (await route.loader({
      request: new Request(`${BASE}/get-session`),
    } as never)) as Response;

    expect(await res.json()).toEqual({ session: { id: 'sess-1' }, user: { id: 'admin-1' } });
    expect(res.headers.getSetCookie()).toEqual(['classmoji.session_token=abc; Path=/; HttpOnly']);
  });

  it('passes an impersonation start through as sent', async () => {
    const sent = betterAuthResponse({ user: { id: 'user-1' } });
    handler.mockResolvedValue(sent);

    const res = (await route.action({
      request: new Request(`${BASE}/admin/impersonate-user`, {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-1' }),
        headers: { 'content-type': 'application/json' },
      }),
    } as never)) as Response;

    expect(res).toBe(sent);
  });
});
