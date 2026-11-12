/**
 * The authorization server's HTTP helpers (../oauthHttp.ts): the 1.4 MCP paths
 * mapped to their oauth-provider paths, and CORS for the endpoints
 * browser-based clients call. Through the real auth server, the mapped token
 * and registration requests are in ./askMojiTokenGrant.test.ts and
 * ./appConnection.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
// A namespace import, so the form body cases fail on their own assertions on a
// tree without the helper rather than taking the whole file down.
import * as oauthHttp from '../oauthHttp.ts';
import {
  corsPreflightResponse,
  isOAuthCorsPreflight,
  LEGACY_MCP_PATHS,
  OAUTH_CORS_HEADERS,
  OAUTH_CORS_PATHS,
  withLegacyMcpPathMapped,
  withOAuthCors,
} from '../oauthHttp.ts';

const ORIGIN = 'http://localhost:3000';

describe('withLegacyMcpPathMapped', () => {
  it('maps exactly the 1.4 authorize, token and registration paths', () => {
    expect(LEGACY_MCP_PATHS).toEqual({
      '/api/auth/mcp/authorize': '/api/auth/oauth2/authorize',
      '/api/auth/mcp/token': '/api/auth/oauth2/token',
      '/api/auth/mcp/register': '/api/auth/oauth2/register',
    });
  });

  it('keeps the method, headers and body of a token request', async () => {
    const body = 'grant_type=refresh_token&refresh_token=abc&client_id=c1';
    const mapped = await withLegacyMcpPathMapped(
      new Request(`${ORIGIN}/api/auth/mcp/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: 'Basic eDp5',
        },
        body,
      })
    );

    expect(mapped.url).toBe(`${ORIGIN}/api/auth/oauth2/token`);
    expect(mapped.method).toBe('POST');
    expect(mapped.headers.get('authorization')).toBe('Basic eDp5');
    expect(mapped.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(await mapped.text()).toBe(body);
  });

  it('keeps the query of an authorize request', async () => {
    const mapped = await withLegacyMcpPathMapped(
      new Request(`${ORIGIN}/api/auth/mcp/authorize?client_id=c1&state=s%20t`)
    );
    expect(mapped.url).toBe(`${ORIGIN}/api/auth/oauth2/authorize?client_id=c1&state=s%20t`);
    expect(mapped.method).toBe('GET');
  });

  it.each([
    ['/api/auth/oauth2/token'],
    ['/api/auth/mcp/userinfo'],
    ['/api/auth/mcp/jwks'],
    ['/api/auth/mcp/token/'],
    ['/api/auth/MCP/token'],
    ['/api/auth/get-session'],
  ])('leaves %s as it is', async path => {
    const request = new Request(`${ORIGIN}${path}`);
    expect(await withLegacyMcpPathMapped(request)).toBe(request);
  });
});

describe('CORS for the endpoints browser-based clients call', () => {
  it('covers token, registration, revocation and the signing keys only', () => {
    expect([...OAUTH_CORS_PATHS].sort()).toEqual([
      '/api/auth/jwks',
      '/api/auth/oauth2/register',
      '/api/auth/oauth2/revoke',
      '/api/auth/oauth2/token',
    ]);
  });

  it('allows any origin, never credentials, and names Authorization', () => {
    expect(OAUTH_CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
    expect(Object.keys(OAUTH_CORS_HEADERS).map(h => h.toLowerCase())).not.toContain(
      'access-control-allow-credentials'
    );
    expect(OAUTH_CORS_HEADERS['Access-Control-Allow-Headers']).toMatch(/\bAuthorization\b/);
  });

  it('answers a preflight with 204 and the headers', () => {
    const res = corsPreflightResponse();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  });

  it.each([...OAUTH_CORS_PATHS])('treats OPTIONS %s as a preflight', path => {
    expect(isOAuthCorsPreflight(new Request(`${ORIGIN}${path}`, { method: 'OPTIONS' }))).toBe(true);
  });

  it.each([
    ['OPTIONS', '/api/auth/oauth2/authorize'],
    ['OPTIONS', '/api/auth/oauth2/consent'],
    ['OPTIONS', '/api/auth/get-session'],
    ['POST', '/api/auth/oauth2/token'],
  ])('does not treat %s %s as one', (method, path) => {
    expect(isOAuthCorsPreflight(new Request(`${ORIGIN}${path}`, { method }))).toBe(false);
  });

  it('adds the headers to any answer on those paths, keeping status, body and headers', async () => {
    const sent = new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    const res = withOAuthCors(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, { method: 'POST' }),
      sent
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });

  it.each([
    ['/api/auth/oauth2/authorize'],
    ['/api/auth/oauth2/consent'],
    ['/api/auth/get-session'],
  ])('leaves an answer on %s as it is', path => {
    const sent = new Response('{}');
    expect(withOAuthCors(new Request(`${ORIGIN}${path}`), sent)).toBe(sent);
  });
});

describe('withFormBodyLimited', () => {
  const URLENCODED = 'application/x-www-form-urlencoded';
  const limited = (request: Request) => oauthHttp.withFormBodyLimited(request);
  const tokenPost = (body: BodyInit, contentType = URLENCODED, init: RequestInit = {}) =>
    new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': contentType, authorization: 'Basic eDp5', origin: ORIGIN },
      body,
      ...init,
    });
  const fieldsOf = (count: number) => Array.from({ length: count }, () => 'a=1').join('&');

  // The real shapes: an authorization code exchange with PKCE from a client
  // named by its metadata document, a refresh and a revocation.
  const REAL_FORMS = {
    'an authorization code exchange': new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'c'.repeat(64),
      redirect_uri: 'http://localhost:54321/callback',
      client_id: 'https://client.example/oauth/client-metadata.json',
      code_verifier: 'v'.repeat(128),
      resource: 'https://mcp.example/mcp',
    }).toString(),
    'a refresh': new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'r'.repeat(64),
      client_id: 'https://client.example/oauth/client-metadata.json',
      resource: 'https://mcp.example/mcp',
    }).toString(),
    'a revocation': new URLSearchParams({
      token: 't'.repeat(64),
      token_type_hint: 'refresh_token',
    }).toString(),
  };

  it.each(Object.entries(REAL_FORMS))(
    'hands %s on with its method, headers and body',
    async (_, body) => {
      const handed = await limited(tokenPost(body));
      expect(handed).toBeInstanceOf(Request);
      const request = handed as Request;
      expect(request.url).toBe(`${ORIGIN}/api/auth/oauth2/token`);
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe('Basic eDp5');
      expect(request.headers.get('origin')).toBe(ORIGIN);
      expect(request.headers.get('content-type')).toBe(URLENCODED);
      expect(await request.text()).toBe(body);
    }
  );

  it('labels a url-encoded form exactly that, whatever parameters it was sent with', async () => {
    const handed = (await limited(
      tokenPost('grant_type=x', 'application/x-www-form-urlencoded; charset=UTF-8')
    )) as Request;
    expect(handed.headers.get('content-type')).toBe(URLENCODED);
  });

  it('refuses a form of more than 10,000 fields with a 413', async () => {
    const answer = await limited(tokenPost(fieldsOf(10_001)));
    expect(answer).toBeInstanceOf(Response);
    expect((answer as Response).status).toBe(413);
    expect(await (answer as Response).json()).toMatchObject({ error: 'invalid_request' });
  });

  it('hands on a form of 10,000 fields', async () => {
    expect(await limited(tokenPost(fieldsOf(10_000)))).toBeInstanceOf(Request);
  });

  it('counts the fields of any body better-auth would parse as a form', async () => {
    for (const contentType of [
      'multipart/form-data; boundary=b, application/x-www-form-urlencoded',
      'multipart/form-data, application/x-www-form-urlencoded',
      'text/plain; x=application/x-www-form-urlencoded',
    ]) {
      const answer = await limited(tokenPost(fieldsOf(10_001), contentType));
      expect((answer as Response).status).toBe(413);
    }
  });

  it('refuses a form body over the size limit, declared or not', async () => {
    const over = 'a='.padEnd(64 * 1024 + 1, 'x');
    expect(((await limited(tokenPost(over))) as Response).status).toBe(413);

    const bytes = new TextEncoder().encode(over);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const chunked = tokenPost(stream, URLENCODED, { duplex: 'half' } as RequestInit);
    expect(((await limited(chunked)) as Response).status).toBe(413);
  });

  it('returns any other request as it is, its body unread', async () => {
    const json = tokenPost(JSON.stringify({ redirect_uris: [] }), 'application/json');
    expect(await limited(json)).toBe(json);
    expect(json.bodyUsed).toBe(false);

    const get = new Request(`${ORIGIN}/api/auth/jwks`);
    expect(await limited(get)).toBe(get);
  });
});
