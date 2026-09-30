/**
 * Session responses over HTTP carry each session row without its `token`
 * field (the browser authenticates with the cookie). Status, every header
 * (Set-Cookie included) and everything else in the body stay as sent.
 */

import { describe, expect, it } from 'vitest';
import { withoutSessionTokens } from '../sessionResponse.ts';

const BASE = 'http://localhost:3000/api/auth';

const jsonResponse = (body: unknown, init: ResponseInit = {}) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', 'classmoji.session_token=abc; Path=/; HttpOnly');
  headers.append('set-cookie', 'classmoji.session_data=def; Path=/; HttpOnly');
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
};

const SESSION = {
  id: 'sess-1',
  userId: 'user-1',
  token: 'value-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  impersonatedBy: null,
};
const USER = { id: 'user-1', name: 'Ada', email: 'ada@example.edu' };

describe('withoutSessionTokens', () => {
  it('returns /get-session with the session row minus its token field, headers kept', async () => {
    const out = await withoutSessionTokens(
      new Request(`${BASE}/get-session`),
      jsonResponse({ session: SESSION, user: USER })
    );

    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({
      session: {
        id: 'sess-1',
        userId: 'user-1',
        expiresAt: '2030-01-01T00:00:00.000Z',
        impersonatedBy: null,
      },
      user: USER,
    });
    expect(out.headers.getSetCookie()).toEqual([
      'classmoji.session_token=abc; Path=/; HttpOnly',
      'classmoji.session_data=def; Path=/; HttpOnly',
    ]);
    expect(out.headers.get('content-type')).toContain('application/json');
  });

  it('returns /admin/list-user-sessions with each row minus its token field', async () => {
    const out = await withoutSessionTokens(
      new Request(`${BASE}/admin/list-user-sessions`, { method: 'POST' }),
      jsonResponse({ sessions: [SESSION, { ...SESSION, id: 'sess-2', token: 'value-2' }] })
    );

    const body = (await out.json()) as { sessions: Record<string, unknown>[] };
    expect(body.sessions.map(s => Object.keys(s).sort())).toEqual([
      ['expiresAt', 'id', 'impersonatedBy', 'userId'],
      ['expiresAt', 'id', 'impersonatedBy', 'userId'],
    ]);
  });

  it('passes a signed-out /get-session (null) through', async () => {
    const out = await withoutSessionTokens(new Request(`${BASE}/get-session`), jsonResponse(null));
    expect(await out.json()).toBeNull();
  });

  it('leaves every other path, an error and a non-JSON response as they are', async () => {
    const other = jsonResponse({ session: SESSION });
    expect(await withoutSessionTokens(new Request(`${BASE}/sign-in/social`), other)).toBe(other);

    const error = jsonResponse({ message: 'nope' }, { status: 401 });
    expect(await withoutSessionTokens(new Request(`${BASE}/get-session`), error)).toBe(error);

    const text = new Response('ok', { headers: { 'content-type': 'text/plain' } });
    expect(await withoutSessionTokens(new Request(`${BASE}/get-session`), text)).toBe(text);
  });
});
