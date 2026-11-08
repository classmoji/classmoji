/**
 * Unit tests for the app-connection rules (../appConnectionGuard.ts) and the
 * authorization server's request rules (../oauthRequestRules.ts) in the
 * shared better-auth `hooks.before`. The end-to-end behaviour through the
 * real `auth.handler` is in ./appConnection.integration.test.ts and, on a
 * real database, ./oauth2.integration.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyAppConnectionRules,
  authorizeParameterSource,
  CONNECT_APP_VIEWING_AS_MESSAGE,
  isClientAuthorizeRequest,
  promptWithConsent,
} from '../appConnectionGuard.ts';
import {
  BACKCHANNEL_LOGOUT_REFUSED_MESSAGE,
  dpopProofIgnored,
  DPOP_REFUSED_MESSAGE,
  offlineAccessChange,
  openRegistrationChange,
  refuseBackchannelLogout,
  refuseDpopBoundAuthorization,
  refuseDpopBoundRegistration,
  RESOURCE_REFUSED_MESSAGE,
  resourceParamChange,
  storedRefreshToken,
} from '../oauthRequestRules.ts';
import { MCP_RESOURCE } from '../mcpResource.ts';

const VIEWING_AS = { session: { impersonatedBy: 'platform-admin-1' } };
const OWN = { session: { impersonatedBy: null } };

const reads = (...sessions: unknown[]) => vi.fn(async () => sessions as never);

const authorize = (over: Record<string, unknown> = {}) => ({
  path: '/oauth2/authorize',
  method: 'GET',
  query: { client_id: 'c1', response_type: 'code', scope: 'read write' },
  ...over,
});

describe('which request the rules treat as the client’s', () => {
  it('is /oauth2/authorize with no authorizeSettings', () => {
    expect(isClientAuthorizeRequest(authorize())).toBe(true);
    // The provider's own dispatches (sign-in resume, consent, continue).
    expect(isClientAuthorizeRequest(authorize({ authorizeSettings: {} }))).toBe(false);
    expect(isClientAuthorizeRequest(authorize({ authorizeSettings: { postLogin: true } }))).toBe(
      false
    );
    expect(isClientAuthorizeRequest({ path: '/oauth2/consent' })).toBe(false);
  });

  it('reads the body for a POST a client sent, the query otherwise', () => {
    expect(authorizeParameterSource(authorize({ method: 'POST' }))).toBe('body');
    expect(authorizeParameterSource(authorize({ method: 'GET' }))).toBe('query');
    // A re-dispatch from POST /oauth2/consent reads the query.
    expect(authorizeParameterSource(authorize({ method: 'POST', authorizeSettings: {} }))).toBe(
      'query'
    );
    expect(
      authorizeParameterSource(
        authorize({ method: 'POST', authorizeSettings: { isAuthorize: true } })
      )
    ).toBe('body');
  });
});

describe('promptWithConsent', () => {
  it('adds consent and drops none, keeping the rest', () => {
    expect(promptWithConsent(undefined)).toBe('consent');
    expect(promptWithConsent('none')).toBe('consent');
    expect(promptWithConsent('consent')).toBe('consent');
    expect(promptWithConsent('login')).toBe('login consent');
    expect(promptWithConsent('login none consent')).toBe('login consent');
    expect(promptWithConsent(['login'])).toBe('consent');
  });
});

describe('the app-connection rule', () => {
  it('asks for the consent page on the client’s authorize request (query)', async () => {
    await expect(
      applyAppConnectionRules(authorize({ query: { client_id: 'c1', prompt: 'none' } }), reads(OWN))
    ).resolves.toEqual({ context: { query: { prompt: 'consent' } } });
  });

  it('asks for it in the body of a POST authorize request', async () => {
    await expect(
      applyAppConnectionRules(
        authorize({ method: 'POST', query: {}, body: { client_id: 'c1' } }),
        reads(OWN)
      )
    ).resolves.toEqual({ context: { body: { prompt: 'consent' } } });
  });

  it('leaves the provider’s own dispatches as they are (no consent loop)', async () => {
    const session = reads(OWN);
    await expect(
      applyAppConnectionRules(authorize({ authorizeSettings: {} }), session)
    ).resolves.toBeUndefined();
    // Still judged for "view as".
    expect(session).toHaveBeenCalled();
  });

  it.each([
    ['the client’s authorize request', authorize()],
    ['a re-dispatched authorize', authorize({ authorizeSettings: {} })],
    ['approving consent', { path: '/oauth2/consent', body: { accept: true } }],
    ['continue', { path: '/oauth2/continue', body: {} }],
  ])('refuses %s when any session read is viewing as someone', async (_label, ctx) => {
    for (const sessions of [
      [VIEWING_AS, OWN, OWN],
      [OWN, VIEWING_AS, OWN],
      [null, null, VIEWING_AS],
    ]) {
      await expect(applyAppConnectionRules(ctx, reads(...sessions))).rejects.toMatchObject({
        statusCode: 403,
        body: { error: 'access_denied', error_description: CONNECT_APP_VIEWING_AS_MESSAGE },
      });
    }
  });

  it('lets a consent denial through without looking up the session', async () => {
    const session = reads(VIEWING_AS);
    await expect(
      applyAppConnectionRules({ path: '/oauth2/consent', body: { accept: false } }, session)
    ).resolves.toBeUndefined();
    expect(session).not.toHaveBeenCalled();
  });

  it('answers 503 when the session cannot be checked', async () => {
    const failing = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    await expect(applyAppConnectionRules(authorize(), failing)).rejects.toMatchObject({
      statusCode: 503,
      body: { error: 'temporarily_unavailable' },
    });
  });

  it('does nothing on other paths', async () => {
    const session = reads(VIEWING_AS);
    for (const path of ['/get-session', '/oauth2/token', '/oauth2/register', '/sign-in/email']) {
      await expect(applyAppConnectionRules({ path }, session)).resolves.toBeUndefined();
    }
    expect(session).not.toHaveBeenCalled();
  });
});

describe('registration rules', () => {
  it.each([
    [{ backchannel_logout_uri: 'https://client.example/logout' }],
    [{ backchannel_logout_session_required: true }],
    [{ backchannel_logout_session_required: false }],
  ])('refuse back-channel logout fields (%o)', fields => {
    expect(() =>
      refuseBackchannelLogout({
        path: '/oauth2/register',
        body: { redirect_uris: ['https://client.example/cb'], ...fields },
        context: {},
      })
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        body: expect.objectContaining({
          error: 'invalid_client_metadata',
          error_description: BACKCHANNEL_LOGOUT_REFUSED_MESSAGE,
        }),
      })
    );
  });

  it('leave a registration without them alone', () => {
    expect(() =>
      refuseBackchannelLogout({
        path: '/oauth2/register',
        body: { redirect_uris: ['https://client.example/cb'], backchannel_logout_uri: null },
        context: {},
      })
    ).not.toThrow();
  });

  it('drop the cookie header so registration is always open registration', () => {
    expect(
      openRegistrationChange({
        path: '/oauth2/register',
        headers: new Headers({ cookie: 'classmoji.session_token=abc' }),
        context: {},
      })?.context.headers?.get('cookie')
    ).toBe('');
    expect(
      openRegistrationChange({ path: '/oauth2/register', headers: new Headers(), context: {} })
    ).toBeUndefined();
  });
});

describe('DPoP rules', () => {
  const refused = (error: string) =>
    expect.objectContaining({
      statusCode: 400,
      body: expect.objectContaining({ error, error_description: DPOP_REFUSED_MESSAGE }),
    });

  it('refuse a registration asking for DPoP-bound tokens, and let one without through', () => {
    const register = (fields: Record<string, unknown>) => ({
      path: '/oauth2/register',
      body: { redirect_uris: ['https://client.example/cb'], ...fields },
      context: {},
    });
    expect(() => refuseDpopBoundRegistration(register({ dpop_bound_access_tokens: true }))).toThrow(
      refused('invalid_client_metadata')
    );
    for (const fields of [{}, { dpop_bound_access_tokens: false }]) {
      expect(() => refuseDpopBoundRegistration(register(fields))).not.toThrow();
    }
  });

  it('refuse an authorization naming a DPoP key (query or body), and let one without through', () => {
    const jkt = 'x'.repeat(43);
    for (const request of [
      authorize({ query: { client_id: 'c1', dpop_jkt: jkt } }),
      authorize({ method: 'POST', query: {}, body: { client_id: 'c1', dpop_jkt: jkt } }),
    ]) {
      expect(() => refuseDpopBoundAuthorization({ ...request, context: {} })).toThrow(
        refused('invalid_request')
      );
    }
    expect(() => refuseDpopBoundAuthorization({ ...authorize(), context: {} })).not.toThrow();
  });

  it('blank a DPoP proof on the token request, and leave a request without one alone', () => {
    expect(
      dpopProofIgnored({
        path: '/oauth2/token',
        headers: new Headers({ dpop: 'eyJ.eyJ.sig' }),
        context: {},
      })?.context.headers?.get('dpop')
    ).toBe('');
    expect(
      dpopProofIgnored({ path: '/oauth2/token', headers: new Headers(), context: {} })
    ).toBeUndefined();
  });
});

describe('the resource rule', () => {
  it('fills in the resource on authorize (query or body) when none is sent', async () => {
    await expect(resourceParamChange({ ...authorize(), context: {} })).resolves.toEqual({
      context: { query: { resource: MCP_RESOURCE } },
    });
    await expect(
      resourceParamChange({
        ...authorize({ method: 'POST', query: {}, body: { client_id: 'c1' } }),
        context: {},
      })
    ).resolves.toEqual({ context: { body: { resource: MCP_RESOURCE } } });
  });

  it('canonicalises the bare origin, with or without a slash', async () => {
    const origin = new URL(MCP_RESOURCE).origin;
    for (const sent of [origin, `${origin}/`, `${MCP_RESOURCE}/`]) {
      await expect(
        resourceParamChange({
          ...authorize({ query: { client_id: 'c1', resource: sent } }),
          context: {},
        })
      ).resolves.toEqual({ context: { query: { resource: MCP_RESOURCE } } });
    }
  });

  it('leaves the resource itself as sent, and one named twice as one', async () => {
    await expect(
      resourceParamChange({
        ...authorize({ query: { client_id: 'c1', resource: MCP_RESOURCE } }),
        context: {},
      })
    ).resolves.toBeUndefined();
    await expect(
      resourceParamChange({
        ...authorize({ query: { client_id: 'c1', resource: [MCP_RESOURCE, MCP_RESOURCE] } }),
        context: {},
      })
    ).resolves.toEqual({ context: { query: { resource: MCP_RESOURCE } } });
  });

  it.each([
    ['another server', 'https://elsewhere.example/mcp'],
    ['the userinfo URL', 'http://localhost:3000/api/auth/oauth2/userinfo'],
    [
      'the userinfo URL with the MCP resource',
      ['http://localhost:3000/api/auth/oauth2/userinfo', MCP_RESOURCE],
    ],
    ['the MCP resource with another server', [MCP_RESOURCE, 'https://elsewhere.example/mcp']],
  ])('refuses an authorization naming %s', async (_label, resource) => {
    for (const request of [
      authorize({ query: { client_id: 'c1', resource } }),
      authorize({ method: 'POST', query: {}, body: { client_id: 'c1', resource } }),
    ]) {
      await expect(resourceParamChange({ ...request, context: {} })).rejects.toMatchObject({
        statusCode: 400,
        body: expect.objectContaining({
          error: 'invalid_target',
          error_description: RESOURCE_REFUSED_MESSAGE,
        }),
      });
    }
  });

  it('leaves another resource on a token request for the provider to check', async () => {
    await expect(
      resourceParamChange({
        path: '/oauth2/token',
        body: {
          grant_type: 'authorization_code',
          code: 'x',
          resource: 'https://elsewhere.example/mcp',
        },
        context: {},
      })
    ).resolves.toBeUndefined();
  });

  it('fills it in on the token request', async () => {
    await expect(
      resourceParamChange({
        path: '/oauth2/token',
        body: { grant_type: 'authorization_code', code: 'x' },
        context: {},
      })
    ).resolves.toEqual({ context: { body: { resource: MCP_RESOURCE } } });
  });

  it('gives a refresh token with no resources the MCP resource, and leaves others alone', async () => {
    const rows: Record<string, Record<string, unknown>> = {
      [storedRefreshToken('copied')]: { id: 'r1', resources: [] },
      [storedRefreshToken('fresh')]: { id: 'r2', resources: [MCP_RESOURCE] },
    };
    const adapter = {
      findOne: vi.fn(
        async ({ where }: { where: { value: string }[] }) => rows[where[0]!.value] ?? null
      ),
      update: vi.fn(async () => ({})),
    };
    for (const token of ['copied', 'fresh', 'unknown']) {
      await resourceParamChange({
        path: '/oauth2/token',
        body: { grant_type: 'refresh_token', refresh_token: token, resource: MCP_RESOURCE },
        context: { adapter },
      });
    }
    expect(adapter.update).toHaveBeenCalledTimes(1);
    expect(adapter.update).toHaveBeenCalledWith({
      model: 'oauthRefreshToken',
      where: [{ field: 'id', value: 'r1' }],
      update: { resources: [MCP_RESOURCE] },
    });
  });

  it('hashes refresh tokens the way the provider stores them (SHA-256, base64url)', () => {
    expect(storedRefreshToken('ref-pub-live')).toBe('Rxy9oE2JA_s1uwEpVj6Bk7cWUjRtYuSshLllnvwEy14');
  });
});

describe('the offline_access rule', () => {
  const adapterWith = (client: Record<string, unknown> | null) => ({
    findOne: vi.fn(async () => client),
    update: vi.fn(),
  });

  it('adds offline_access when the client may refresh', async () => {
    for (const client of [
      { clientId: 'c1', grantTypes: ['authorization_code'], scopes: [] },
      { clientId: 'c1', grantTypes: [], scopes: ['read', 'write', 'offline_access'] },
      { clientId: 'c1', grantTypes: ['authorization_code', 'refresh_token'] },
      // Not registered yet (a Client ID Metadata Document): the endpoint checks it.
      null,
    ]) {
      await expect(
        offlineAccessChange({ ...authorize(), context: { adapter: adapterWith(client) } })
      ).resolves.toEqual({ context: { query: { scope: 'read write offline_access' } } });
    }
  });

  it('leaves a client that may not refresh, or a request that already asks', async () => {
    for (const client of [
      { clientId: 'c1', grantTypes: ['client_credentials'] },
      { clientId: 'c1', grantTypes: ['authorization_code'], scopes: ['read', 'write'] },
    ]) {
      await expect(
        offlineAccessChange({ ...authorize(), context: { adapter: adapterWith(client) } })
      ).resolves.toBeUndefined();
    }
    await expect(
      offlineAccessChange({
        ...authorize({ query: { client_id: 'c1', scope: 'read offline_access' } }),
        context: { adapter: adapterWith({}) },
      })
    ).resolves.toBeUndefined();
    // No scope: the endpoint gives the client its scopes, offline_access among them.
    await expect(
      offlineAccessChange({
        ...authorize({ query: { client_id: 'c1' } }),
        context: { adapter: adapterWith({}) },
      })
    ).resolves.toBeUndefined();
  });

  it('changes the body of a POST authorize request', async () => {
    await expect(
      offlineAccessChange({
        ...authorize({ method: 'POST', query: {}, body: { client_id: 'c1', scope: 'read' } }),
        context: { adapter: adapterWith(null) },
      })
    ).resolves.toEqual({ context: { body: { scope: 'read offline_access' } } });
  });
});
