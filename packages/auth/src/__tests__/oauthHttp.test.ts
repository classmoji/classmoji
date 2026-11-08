/**
 * The authorization server's HTTP helpers (../oauthHttp.ts): the 1.4 MCP paths
 * mapped to their oauth-provider paths, and CORS for the endpoints
 * browser-based clients call. Through the real auth server, the mapped token
 * and registration requests are in ./askMojiTokenGrant.test.ts and
 * ./appConnection.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
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
