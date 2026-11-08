/**
 * REAL access tokens for the integration suites: the OAuth server
 * (packages/auth's better-auth instance, the one the webapp serves at
 * /api/auth) run in the test process, on the same database as the spawned MCP
 * server, through its own handler:
 *
 *   register a client (open DCR) → a session for a seeded user →
 *   /oauth2/authorize → the consent page's signed query → approve at
 *   /oauth2/consent → the code → /oauth2/token → a JWT for MCP_RESOURCE.
 *
 * The MCP server checks those tokens exactly as it checks a connector's: the
 * signature against the `jwks` table, then the client, user and consent rows.
 *
 * The auth instance reads its environment when it is imported, so this module
 * sets the issuer and the resource (the spawned server's BASE) first, and is
 * imported lazily by its callers. The secret is the runner's
 * BETTER_AUTH_SECRET, or both processes' development fallback.
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { serializeSignedCookie } from 'better-call';
import { expect } from 'vitest';
import { BASE, getPrisma } from './helpers.ts';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.MCP_PUBLIC_URL = BASE;

const server = await import('@classmoji/auth/server');
export const { auth, MCP_RESOURCE, AUTH_ISSUER } = server;

const AS = 'http://localhost:3000/api/auth';
export const REDIRECT_URI = 'http://127.0.0.1:47811/callback';

/** Rows this module created, for cleanup. */
const created = { clients: [] as string[], sessions: [] as string[] };

/** Register a public client with open DCR; its client id. */
export async function registerClient(name = 'MCP integration client'): Promise<string> {
  const res = await auth.handler(
    new Request(`${AS}/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    })
  );
  expect(res.status, 'client registration').toBe(201);
  const { client_id } = (await res.json()) as { client_id: string };
  created.clients.push(client_id);
  return client_id;
}

/** A signed session cookie for a new session of `userId`. */
export async function sessionCookie(userId: string): Promise<string> {
  const token = `mcp-it-${randomBytes(16).toString('hex')}`;
  const session = await getPrisma().session.create({
    data: { token, user_id: userId, expires_at: new Date(Date.now() + 86_400_000) },
  });
  created.sessions.push(session.id);
  const secret = (await auth.$context).secret;
  return (
    await serializeSignedCookie(`${server.COOKIE_PREFIX}.session_token`, token, secret)
  ).split(';')[0]!;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token?: string;
  scope: string;
}

/** POST /oauth2/token with a form body (and any other headers, a DPoP proof say). */
export async function tokenRequest(
  body: Record<string, string>,
  headers: Record<string, string> = {}
) {
  const res = await auth.handler(
    new Request(`${AS}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body).toString(),
    })
  );
  return {
    status: res.status,
    body: (await res.json()) as IssuedTokens & { error?: string; token_type?: string },
  };
}

/** The token endpoint's URL, a DPoP proof's `htu`. */
export const TOKEN_ENDPOINT = `${AS}/oauth2/token`;

/**
 * A DPoP key (RFC 9449, ES256): a function that signs a proof for POST to
 * `htu`, as a client that uses DPoP sends with each token request.
 */
export function dpopProofs(): (htu: string) => string {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return htu => {
    const input = `${b64({ typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } })}.${b64({
      jti: randomBytes(16).toString('hex'),
      htm: 'POST',
      htu,
      iat: Math.floor(Date.now() / 1000),
    })}`;
    const signature = sign('sha256', Buffer.from(input), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${input}.${signature.toString('base64url')}`;
  };
}

/**
 * Connect `clientId` for the user behind `cookie` (always through the
 * consent page, as the server forces), approve, and exchange the code.
 */
export async function connectApp(
  clientId: string,
  cookie: string,
  scope = 'read write',
  exchangeHeaders: Record<string, string> = {}
): Promise<IssuedTokens & { token_type?: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope,
    state: 'it',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const authorize = await auth.handler(
    new Request(`${AS}/oauth2/authorize?${query}`, { headers: { cookie } })
  );
  const location = new URL(authorize.headers.get('location') ?? '', 'http://localhost:3000');
  expect(location.pathname, 'authorize goes to the consent page').toBe('/oauth/consent');

  const consent = await auth.handler(
    new Request(`${AS}/oauth2/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie },
      body: JSON.stringify({ accept: true, oauth_query: location.searchParams.toString() }),
    })
  );
  const { url } = (await consent.json()) as { url: string };
  const code = new URL(url).searchParams.get('code');
  expect(code, 'consent gives a code').toBeTruthy();

  const { status, body } = await tokenRequest(
    {
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    },
    exchangeHeaders
  );
  expect(status, `token exchange: ${JSON.stringify(body)}`).toBe(200);
  return body;
}

/** The claims of a JWT, unverified (the MCP server verifies them). */
export function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

/**
 * A real access token for `userId` with `scopes`: what `mintToken` hands out
 * when the suites run with MCP_IT_TOKEN_KIND=jwt. Each token is its own app
 * connection (its own registered client), so revoking one never cuts another.
 */
export async function issueAccessToken(userId: string, scopes: string[]): Promise<string> {
  const scope = scopes.join(' ');
  const clientId = await registerClient(`MCP integration client (${scope})`);
  const issued = await connectApp(clientId, await sessionCookie(userId), scope);
  expect(claimsOf(issued.access_token)).toMatchObject({ sub: userId, azp: clientId });
  return issued.access_token;
}

/**
 * Disconnect the app a JWT was issued to, as Classmoji's disconnect does:
 * delete the (client, user) consent and refresh tokens. How many consents
 * went.
 */
export async function disconnectApp(jwt: string): Promise<number> {
  const { azp, sub } = claimsOf(jwt) as { azp: string; sub: string };
  const prisma = getPrisma();
  await prisma.oauthRefreshToken.deleteMany({ where: { clientId: azp, userId: sub } });
  const { count } = await prisma.oauthConsent.deleteMany({ where: { clientId: azp, userId: sub } });
  return count;
}

/** Delete every client and session this module created (their grants cascade). */
export async function deleteIssuedGrants(): Promise<void> {
  const prisma = getPrisma();
  if (created.clients.length > 0) {
    await prisma.oauthClient.deleteMany({ where: { clientId: { in: created.clients.splice(0) } } });
  }
  if (created.sessions.length > 0) {
    await prisma.session.deleteMany({ where: { id: { in: created.sessions.splice(0) } } });
  }
}
