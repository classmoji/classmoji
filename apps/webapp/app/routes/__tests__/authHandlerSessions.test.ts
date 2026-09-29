/**
 * The webapp's better-auth handler (api.auth.$): session responses leave
 * without their rows' `token` field, with better-auth's status and headers
 * (Set-Cookie included); every other response passes through as sent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handler = vi.fn();

vi.mock('@classmoji/auth/server', () => ({ auth: { handler: (r: Request) => handler(r) } }));

const route = await import('../api.auth.$.ts');

const BASE = 'http://localhost:3000/api/auth';

const betterAuthResponse = (body: unknown) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', 'classmoji.session_token=abc; Path=/; HttpOnly');
  headers.append('set-cookie', 'classmoji.session_data=def; Path=/; HttpOnly');
  return new Response(JSON.stringify(body), { status: 200, headers });
};

beforeEach(() => {
  handler.mockReset();
});

describe('api.auth.$ — session responses', () => {
  it('serves /get-session without the token field, keeping the cookies', async () => {
    handler.mockResolvedValue(
      betterAuthResponse({
        session: { id: 'sess-1', token: 'value-1', impersonatedBy: 'admin-1' },
        user: { id: 'user-1', name: 'Ada' },
      })
    );

    const res = (await route.loader({
      request: new Request(`${BASE}/get-session`),
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session: { id: 'sess-1', impersonatedBy: 'admin-1' },
      user: { id: 'user-1', name: 'Ada' },
    });
    expect(res.headers.getSetCookie()).toHaveLength(2);
  });

  it('serves /admin/list-user-sessions rows without the token field', async () => {
    handler.mockResolvedValue(
      betterAuthResponse({ sessions: [{ id: 'sess-1', token: 'value-1', userId: 'user-1' }] })
    );

    const res = (await route.action({
      request: new Request(`${BASE}/admin/list-user-sessions`, {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-1' }),
        headers: { 'content-type': 'application/json' },
      }),
    } as never)) as Response;

    expect(await res.json()).toEqual({ sessions: [{ id: 'sess-1', userId: 'user-1' }] });
  });

  it('passes sign-out and impersonation responses through as sent', async () => {
    for (const path of ['/sign-out', '/admin/impersonate-user', '/admin/stop-impersonating']) {
      const sent = betterAuthResponse({ success: true });
      handler.mockResolvedValue(sent);

      const res = (await route.action({
        request: new Request(`${BASE}${path}`, { method: 'POST' }),
      } as never)) as Response;

      expect(res).toBe(sent);
    }
  });
});
