/**
 * Access tokens the OAuth server signs for MCP clients (better-auth 1.7's
 * oauth-provider on the webapp, packages/auth/src/server.ts): JWTs, checked
 * here on every request, before the body is read (routes/mcp.ts).
 *
 * THE TOKEN
 *   - signed by one of the server's keys, read in process with
 *     `auth.api.getJwks()` (the `jwks` table) and cached by core's verifier
 *     under JWKS_CACHE_KEY: five minutes, and refetched (at most every 30 s)
 *     when a token names a key the cached set lacks, as after a rotation;
 *   - header `typ: at+jwt` (an ID token is not an access token);
 *   - `iss` = AUTH_ISSUER, the webapp's origin; `aud` names MCP_RESOURCE (a
 *     string, or a list when the client also asked for `openid`);
 *   - `sub`, `azp`, `iat` and `exp` present, and not expired;
 *   - no `cnf`: a sender-constrained (DPoP) token is refused, since this
 *     server takes bearer tokens only (`bearer_methods_supported: header`).
 *
 * LIVENESS: a signed token stays valid until it expires, so these are read
 * on every request; each makes revoking at the server take effect at once:
 *   - `azp` is not one of the two client ids only Classmoji mints for;
 *   - the client exists and is not disabled;
 *   - the user exists and is not banned (a ban with an end date counts until
 *     then);
 *   - a consent for (client, user) exists, and the token was issued no
 *     earlier than the second it was given (`iat >= floor(createdAt / 1 s)`):
 *     disconnecting an app deletes its consent, and a token from before a
 *     reconnect stays refused. The OAuth server writes a consent's createdAt
 *     on whole seconds, and `iat` is whole seconds, so a token issued in the
 *     same second as its consent passes.
 *
 * The consent's own `scopes` and `resources` lists are not read: the token's
 * `scope` claim is what the OAuth server granted, and `aud` is the resource
 * check. (Prisma reads a NULL list as `[]`, and a consent copied from the 1.4
 * tables has no resources.)
 *
 * ERRORS: a key or liveness read that fails because the store is unavailable,
 * or a key read that times out, is a TokenStoreUnavailableError (503, try
 * again); a token that fails a check is an UnauthorizedError (401); anything
 * else is passed on, and the route logs it and answers 401.
 */

import getPrisma from '@classmoji/database';
import { auth, verifyJwsAccessToken } from '@classmoji/auth/server';
import { AUTH_ISSUER, MCP_RESOURCE } from '@classmoji/auth/mcp-resource';
import { INTERNAL_CLIENT_IDS } from '@classmoji/auth/mcp-token';
import { TokenStoreUnavailableError, UnauthorizedError } from '../mcp/errors.ts';
import { isTokenStoreUnavailable } from './tokenStoreErrors.ts';
import { isBanned, type Viewer } from './viewer.ts';

/** The JWT media type the OAuth server puts in an access token's header (RFC 9068). */
export const ACCESS_TOKEN_TYP = 'at+jwt';

/** Three base64url segments: the only bearer shape checked as a JWT. */
const JWT_SHAPE = /^[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,65536}\.[A-Za-z0-9_-]{0,8192}$/;

export function isJwtShaped(bearer: string): boolean {
  return JWT_SHAPE.test(bearer);
}

/** Core's verifier caches the key set under this object (one per process). */
const JWKS_CACHE_KEY = {};

/**
 * The server's public keys, read in process. The cast only bridges two
 * copies of jose's types: better-auth's own (6.x, nested under it) describes
 * what `getJwks` returns, and the root copy (5.x, the one
 * `@better-auth/core` resolves and verifies with) describes what the
 * verifier takes. The value is the same plain JSON key set.
 */
type JwksFetch = Extract<Parameters<typeof verifyJwsAccessToken>[1]['jwksFetch'], () => unknown>;
const fetchJwks = (() => auth.api.getJwks()) as unknown as JwksFetch;

/** jose's error codes for a key read that took too long: nothing was learned about the token. */
const KEY_READ_TIMEOUT_CODES = new Set(['ERR_JWKS_TIMEOUT']);

/** jose's error codes for a token that fails a check. */
const TOKEN_REFUSED_CODES = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
]);

const codeOf = (error: unknown): unknown =>
  error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;

/** A read that fails because the store is unavailable → 503; anything else is passed on. */
async function read<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (isTokenStoreUnavailable(error)) throw new TokenStoreUnavailableError({ cause: error });
    throw error;
  }
}

/** The token's verified claims, or the error that says why not. */
async function verifiedClaims(bearer: string): Promise<Record<string, unknown>> {
  try {
    return await verifyJwsAccessToken(bearer, {
      jwksFetch: fetchJwks,
      jwksCacheKey: JWKS_CACHE_KEY,
      verifyOptions: {
        issuer: AUTH_ISSUER,
        audience: MCP_RESOURCE,
        typ: ACCESS_TOKEN_TYP,
        requiredClaims: ['sub', 'azp', 'iat', 'exp'],
      },
    });
  } catch (error) {
    if (isTokenStoreUnavailable(error) || KEY_READ_TIMEOUT_CODES.has(codeOf(error) as string)) {
      throw new TokenStoreUnavailableError({ cause: error });
    }
    if (TOKEN_REFUSED_CODES.has(codeOf(error) as string)) {
      throw new UnauthorizedError('Invalid access token');
    }
    throw error;
  }
}

export async function resolveJwtAccessToken(bearer: string, now = Date.now()): Promise<Viewer> {
  const claims = await verifiedClaims(bearer);
  const { sub, azp, iat, scope, cnf } = claims;
  if (typeof sub !== 'string' || !sub || typeof azp !== 'string' || !azp) {
    throw new UnauthorizedError('Invalid access token');
  }
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    throw new UnauthorizedError('Invalid access token');
  }
  if (scope !== undefined && typeof scope !== 'string') {
    throw new UnauthorizedError('Invalid access token');
  }
  if (cnf !== undefined) {
    throw new UnauthorizedError('Sender-constrained access tokens are not accepted');
  }
  if (INTERNAL_CLIENT_IDS.includes(azp)) {
    throw new UnauthorizedError('Access token client is reserved');
  }

  const prisma = getPrisma();
  const [client, user, consent] = await read(() =>
    Promise.all([
      prisma.oauthClient.findUnique({ where: { clientId: azp }, select: { disabled: true } }),
      prisma.user.findUnique({
        where: { id: sub },
        select: { banned: true, ban_expires_at: true },
      }),
      prisma.oauthConsent.findFirst({
        where: { clientId: azp, userId: sub },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ])
  );
  if (!client || client.disabled === true) {
    throw new UnauthorizedError('Access token client is disabled or unknown');
  }
  if (!user || isBanned(user, now)) {
    throw new UnauthorizedError('Access token user is banned or unknown');
  }
  if (!consent) {
    throw new UnauthorizedError('The app is no longer connected');
  }
  if (iat < Math.floor(consent.createdAt.getTime() / 1000)) {
    throw new UnauthorizedError('The app was connected again after this token was issued');
  }

  return {
    tokenKind: 'jwt',
    userId: sub,
    clientId: azp,
    scopes: new Set((scope ?? '').split(' ').filter(Boolean)),
    impersonatedBy: null,
  };
}
