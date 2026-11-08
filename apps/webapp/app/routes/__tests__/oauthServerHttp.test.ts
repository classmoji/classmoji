/**
 * The authorization server as the webapp serves it over HTTP:
 *   - api.auth.$ maps a 1.4 MCP path to its oauth-provider path BEFORE the
 *     registration guard looks at the path, so a registration at the old
 *     path gets the same check;
 *   - the guard refuses a redirect URI the consent page would not follow,
 *     and lets native app schemes through;
 *   - token, registration, revocation and the signing keys answer any origin
 *     (CORS, no credentials), errors included, and a preflight is answered
 *     without reaching better-auth; nothing else gets the headers;
 *   - the four discovery routes answer any origin too, preflight included,
 *     and leave out every DPoP key oauth-provider writes;
 *   - a registration over the size limits is refused before better-auth.
 * better-auth itself is stood in (auth.handler, and the two endpoints the
 * discovery helpers read); the helpers are oauth-provider's own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handler: vi.fn<(request: Request) => Promise<Response>>(),
  // What oauth-provider writes, DPoP keys included.
  serverConfig: vi.fn(async () => ({
    issuer: 'http://localhost:3000',
    token_endpoint: 'x',
    dpop_signing_alg_values_supported: ['EdDSA', 'ES256'],
    dpop_bound_access_tokens_required: false,
  })),
}));

vi.mock('@classmoji/auth/server', async () => {
  const provider = await import('@better-auth/oauth-provider');
  return {
    auth: {
      handler: (request: Request) => mocks.handler(request),
      api: { getOAuthServerConfig: mocks.serverConfig, getOpenIdConfig: mocks.serverConfig },
    },
    oauthProviderAuthServerMetadata: provider.oauthProviderAuthServerMetadata,
    oauthProviderOpenIdConfigMetadata: provider.oauthProviderOpenIdConfigMetadata,
  };
});

const authRoute = await import('../api.auth.$.ts');
const discoveryRoutes = [
  [
    '/.well-known/oauth-authorization-server',
    await import('../[.]well-known.oauth-authorization-server/route.ts'),
  ],
  [
    '/.well-known/oauth-authorization-server/api/auth',
    await import('../[.]well-known.oauth-authorization-server.api.auth/route.ts'),
  ],
  [
    '/.well-known/openid-configuration',
    await import('../[.]well-known.openid-configuration/route.ts'),
  ],
  [
    '/.well-known/openid-configuration/api/auth',
    await import('../[.]well-known.openid-configuration.api.auth/route.ts'),
  ],
] as const;

const ORIGIN = 'http://localhost:3000';

/** A request as the route gets it: GET, HEAD and OPTIONS to the loader, the rest to the action. */
function send(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, init);
  const method = request.method;
  const run =
    method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
      ? authRoute.loader
      : authRoute.action;
  return run({ request } as never) as Promise<Response>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const registration = (redirectUris: unknown[]) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'Some client', redirect_uris: redirectUris }),
});

beforeEach(() => {
  mocks.handler.mockReset();
  mocks.handler.mockResolvedValue(json({ ok: true }));
});

describe('the 1.4 MCP paths', () => {
  it.each([
    ['/api/auth/mcp/token', '/api/auth/oauth2/token', 'POST'],
    ['/api/auth/mcp/register', '/api/auth/oauth2/register', 'POST'],
    ['/api/auth/mcp/authorize?client_id=c1', '/api/auth/oauth2/authorize?client_id=c1', 'GET'],
  ])('send %s on to %s', async (from, to, method) => {
    await send(from, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:1/cb'] }),
          }
        : {}),
    });

    expect(mocks.handler).toHaveBeenCalledOnce();
    const handed = mocks.handler.mock.calls[0]![0];
    expect(handed.url).toBe(`${ORIGIN}${to}`);
    expect(handed.method).toBe(method);
  });

  it('are mapped before the registration guard: a refused redirect URI at the old path never reaches better-auth', async () => {
    const res = await send('/api/auth/mcp/register', registration(['javascript:alert(1)']));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(mocks.handler).not.toHaveBeenCalled();
    // Readable by a browser-based client, like any registration answer.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('client registration', () => {
  it.each([['blob:https://x.example/1'], ['data:text/html,x'], ['file:///x']])(
    'refuses %s before better-auth',
    async uri => {
      const res = await send(
        '/api/auth/oauth2/register',
        registration(['https://ok.example/cb', uri])
      );
      expect(res.status).toBe(400);
      expect(mocks.handler).not.toHaveBeenCalled();
    }
  );

  it('refuses one whose client_name is over the size limit before better-auth', async () => {
    const res = await send('/api/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'N'.repeat(201),
        redirect_uris: ['https://ok.example/cb'],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_client_metadata' });
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('hands a native app scheme on to better-auth', async () => {
    mocks.handler.mockResolvedValue(json({ client_id: 'new' }, 201));
    const res = await send(
      '/api/auth/oauth2/register',
      registration(['cursor://anysphere.cursor-retrieval/oauth/callback'])
    );
    expect(res.status).toBe(201);
    expect(mocks.handler).toHaveBeenCalledOnce();
  });
});

describe('CORS', () => {
  const CORS_PATHS = [
    ['/api/auth/oauth2/token', 'POST'],
    ['/api/auth/oauth2/register', 'POST'],
    ['/api/auth/oauth2/revoke', 'POST'],
    ['/api/auth/jwks', 'GET'],
  ] as const;

  it.each(CORS_PATHS)('%s answers any origin, without credentials', async (path, method) => {
    const res = await send(path, {
      method,
      headers: { origin: 'https://inspector.example' },
      ...(method === 'POST' ? { body: 'grant_type=x' } : {}),
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it.each([
    [400, { error: 'invalid_grant' }],
    [429, { message: 'Too many requests' }],
  ])('carries the headers on a %s from better-auth, unchanged otherwise', async (status, body) => {
    mocks.handler.mockResolvedValue(json(body, status));
    const res = await send('/api/auth/oauth2/token', { method: 'POST', body: 'grant_type=x' });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it.each(CORS_PATHS)('answers a preflight for %s itself', async path => {
    const res = await send(path, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://inspector.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/auth/oauth2/authorize?client_id=c1', 'GET'],
    ['/api/auth/oauth2/consent', 'POST'],
    ['/api/auth/get-session', 'GET'],
    ['/api/auth/sign-in/email', 'POST'],
  ])('is not on %s', async (path, method) => {
    const res = await send(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('leaves a preflight elsewhere to better-auth', async () => {
    mocks.handler.mockResolvedValue(new Response(null, { status: 404 }));
    const res = await send('/api/auth/oauth2/consent', { method: 'OPTIONS' });
    expect(mocks.handler).toHaveBeenCalledOnce();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the discovery documents', () => {
  it.each(discoveryRoutes)('%s answers any origin', async (path, route) => {
    const res = (await route.loader({
      request: new Request(`${ORIGIN}${path}`, {
        headers: { origin: 'https://inspector.example' },
      }),
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: 'http://localhost:3000', token_endpoint: 'x' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    // oauth-provider's own caching header stays.
    expect(res.headers.get('cache-control')).toBeTruthy();
  });

  it.each(discoveryRoutes)('%s answers a preflight', async (path, route) => {
    mocks.serverConfig.mockClear();
    const res = (await route.loader({
      request: new Request(`${ORIGIN}${path}`, { method: 'OPTIONS' }),
    } as never)) as Response;

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/MCP-Protocol-Version/);
    expect(mocks.serverConfig).not.toHaveBeenCalled();
  });
});
