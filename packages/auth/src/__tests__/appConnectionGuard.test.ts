/**
 * Unit tests for the app-connection rules in the shared better-auth
 * `hooks.before` (../appConnectionGuard.ts). The end-to-end behaviour through
 * the real `auth.handler` is in ./appConnection.integration.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyAppConnectionRules,
  CONNECT_APP_VIEWING_AS_MESSAGE,
  withoutCookie,
} from '../appConnectionGuard.ts';

const VIEWING_AS = { session: { impersonatedBy: 'platform-admin-1' } };
const OWN = { session: { impersonatedBy: null } };
const LOGIN_PROMPT = 'oidc_login_prompt=%7B%22client_id%22%7D.sig%3D';

const ctx = (
  path: string,
  { cookie, query, body }: { cookie?: string; query?: Record<string, unknown>; body?: unknown } = {}
) => ({
  path,
  headers: new Headers(cookie ? { cookie } : {}),
  query,
  body,
});

const lookup = (session: unknown) => vi.fn(async () => session as never);

describe('non-matching requests', () => {
  it('are untouched and never look up the session', async () => {
    for (const path of [
      '/get-session',
      '/sign-out',
      '/update-user',
      '/mcp/token',
      '/mcp/register',
    ]) {
      const session = lookup(VIEWING_AS);
      await expect(
        applyAppConnectionRules(ctx(path, { cookie: 'classmoji.session_token=abc' }), session)
      ).resolves.toBeUndefined();
      expect(session).not.toHaveBeenCalled();
    }
  });

  it('are untouched for in-process calls without headers', async () => {
    const session = lookup(VIEWING_AS);
    await expect(
      applyAppConnectionRules({ path: '/get-session' }, session)
    ).resolves.toBeUndefined();
    expect(session).not.toHaveBeenCalled();
  });
});

describe('/mcp/authorize', () => {
  it('always asks for the consent page, keeping the rest of the query', async () => {
    const result = await applyAppConnectionRules(
      ctx('/mcp/authorize', { query: { client_id: 'c1', state: 's', prompt: 'none' } }),
      lookup(OWN)
    );
    expect(result).toEqual({
      context: { query: { client_id: 'c1', state: 's', prompt: 'consent' } },
    });
  });

  it('asks for the consent page when signed out too (the saved request keeps it)', async () => {
    const result = await applyAppConnectionRules(
      ctx('/mcp/authorize', { query: { client_id: 'c1' } }),
      lookup(null)
    );
    expect(result).toEqual({ context: { query: { client_id: 'c1', prompt: 'consent' } } });
  });

  it('is refused while viewing as another user', async () => {
    await expect(
      applyAppConnectionRules(
        ctx('/mcp/authorize', { query: { client_id: 'c1' } }),
        lookup(VIEWING_AS)
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { error: 'access_denied', error_description: CONNECT_APP_VIEWING_AS_MESSAGE },
    });
  });

  it('answers 503 when the session cannot be checked', async () => {
    const failing = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    await expect(
      applyAppConnectionRules(ctx('/mcp/authorize', { query: {} }), failing)
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('/oauth2/consent', () => {
  it('refuses an approval while viewing as another user', async () => {
    await expect(
      applyAppConnectionRules(
        ctx('/oauth2/consent', { body: { accept: true, consent_code: 'x' } }),
        lookup(VIEWING_AS)
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { error: 'access_denied', error_description: CONNECT_APP_VIEWING_AS_MESSAGE },
    });
  });

  it('lets a denial through without looking up the session', async () => {
    const session = lookup(VIEWING_AS);
    await expect(
      applyAppConnectionRules(
        ctx('/oauth2/consent', { body: { accept: false, consent_code: 'x' } }),
        session
      )
    ).resolves.toBeUndefined();
    expect(session).not.toHaveBeenCalled();
  });

  it('lets an approval through for an ordinary session, unchanged', async () => {
    await expect(
      applyAppConnectionRules(ctx('/oauth2/consent', { body: { accept: true } }), lookup(OWN))
    ).resolves.toBeUndefined();
  });

  it('answers 503 when the session cannot be checked', async () => {
    const failing = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    await expect(
      applyAppConnectionRules(ctx('/oauth2/consent', { body: { accept: true } }), failing)
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('a saved authorization cookie (oidc_login_prompt)', () => {
  const cookie = `classmoji.session_token=abc.sig; ${LOGIN_PROMPT}; theme=dark`;

  it('is removed when starting to view as someone, without a session lookup', async () => {
    const session = lookup(OWN);
    const result = await applyAppConnectionRules(
      ctx('/admin/impersonate-user', { cookie }),
      session
    );
    expect(result?.context.headers?.get('cookie')).toBe(
      'classmoji.session_token=abc.sig; theme=dark'
    );
    expect(session).not.toHaveBeenCalled();
  });

  it('is removed from any request made while viewing as another user', async () => {
    const result = await applyAppConnectionRules(
      ctx('/update-user', { cookie }),
      lookup(VIEWING_AS)
    );
    expect(result?.context.headers?.get('cookie')).toBe(
      'classmoji.session_token=abc.sig; theme=dark'
    );
  });

  it('is kept for an ordinary session, so sign-in resumes the authorization', async () => {
    await expect(
      applyAppConnectionRules(ctx('/callback/github', { cookie }), lookup(OWN))
    ).resolves.toBeUndefined();
  });

  it('is kept when signed out', async () => {
    await expect(
      applyAppConnectionRules(ctx('/callback/github', { cookie }), lookup(null))
    ).resolves.toBeUndefined();
  });

  it('is removed, not refused, when the session cannot be checked', async () => {
    const failing = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const result = await applyAppConnectionRules(ctx('/update-user', { cookie }), failing);
    expect(result?.context.headers?.get('cookie')).toBe(
      'classmoji.session_token=abc.sig; theme=dark'
    );
  });

  it('does not match a cookie whose name only contains the name', async () => {
    const result = await applyAppConnectionRules(
      ctx('/admin/impersonate-user', { cookie: 'x_oidc_login_prompt=1; a=b' }),
      lookup(OWN)
    );
    expect(result).toBeUndefined();
  });
});

describe('withoutCookie', () => {
  it('removes only the named cookie', () => {
    expect(withoutCookie('a=1; oidc_login_prompt=2; b=3', 'oidc_login_prompt')).toBe('a=1; b=3');
    expect(withoutCookie('oidc_login_prompt=2', 'oidc_login_prompt')).toBe('');
    expect(withoutCookie('a=1;b=2', 'oidc_login_prompt')).toBe('a=1; b=2');
  });
});
