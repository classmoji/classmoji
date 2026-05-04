import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Request as ExpressRequest, Response, NextFunction } from 'express';

const WEBAPP_URL = process.env.WEBAPP_URL ?? 'http://localhost:3000';
const MCP_AUDIENCE = process.env.MCP_AUDIENCE ?? 'http://localhost:8100/mcp';
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? 'http://localhost:8100';

/**
 * BetterAuth's `jwt()` plugin publishes JWKS at `/api/auth/jwks` (verified
 * via spike). Cache for 6h, refresh on signature failure with 5s cooldown
 * to allow fast recovery during key rotation without hammering the AS.
 */
const JWKS = createRemoteJWKSet(new URL(`${WEBAPP_URL}/api/auth/jwks`), {
  cooldownDuration: 5_000,
  cacheMaxAge: 6 * 60 * 60 * 1000,
});

/**
 * BetterAuth's `iss` claim is `${WEBAPP_URL}/api/auth`, NOT `${WEBAPP_URL}`
 * (spike-confirmed). The audience is an array containing both `MCP_AUDIENCE`
 * and an auto-injected `${WEBAPP_URL}/api/auth/oauth2/userinfo` — `jose`
 * correctly treats `audience: string` as "must be in array".
 */
const EXPECTED_ISSUER = `${WEBAPP_URL}/api/auth`;

/**
 * Augment Express Request with MCP-shaped AuthInfo (token, clientId, scopes,
 * resource, extra). The SDK's transport reads from `req.auth` so we conform
 * to its shape rather than inventing our own. Classmoji-specific fields
 * (userId, tokenId) live under `extra`.
 */
declare module 'express-serve-static-core' {
  interface Request {
    auth?: {
      token: string;
      clientId: string;
      scopes: string[];
      expiresAt?: number;
      resource?: URL;
      extra?: {
        userId: string;
        tokenId: string;
        /**
         * Custom claim from /api/dev/mint-jwt (and future BetterAuth
         * customAccessTokenClaims). When present, restrict the user's
         * effective roles for this session to the listed subset.
         */
        cmRoles?: string[];
      };
    };
  }
}

const wwwAuthenticate = (error?: string, description?: string): string => {
  const params = [
    'realm="OAuth"',
    `resource_metadata="${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource"`,
  ];
  if (error) params.push(`error="${error}"`);
  if (description) params.push(`error_description="${description.replace(/"/g, '')}"`);
  return `Bearer ${params.join(', ')}`;
};

/**
 * Express middleware: verify the incoming Bearer JWT against webapp's JWKS.
 *
 * BetterAuth does not issue a `jti` claim and reserved claims cannot be
 * injected via `customAccessTokenClaims`. For audit traceability we use a
 * SHA-256 truncation of the raw token as the token ID.
 */
export async function requireValidJwt(
  req: ExpressRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.set('WWW-Authenticate', wwwAuthenticate());
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const token = auth.slice('Bearer '.length).trim();
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: EXPECTED_ISSUER,
      audience: MCP_AUDIENCE,
    });

    if (!payload.sub) {
      throw new Error('Token missing required claim: sub');
    }

    const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const clientId = typeof payload.azp === 'string' ? payload.azp : 'unknown';
    const scopeStr = typeof payload.scope === 'string' ? payload.scope : '';

    // Custom Classmoji claim: dev "view-as" role filter. Optional.
    const cmRolesClaim = (payload as Record<string, unknown>).cm_roles;
    const cmRoles = Array.isArray(cmRolesClaim)
      ? cmRolesClaim.filter((r): r is string => typeof r === 'string')
      : undefined;

    req.auth = {
      token,
      clientId,
      scopes: scopeStr.split(/\s+/).filter(Boolean),
      expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      resource: new URL(MCP_AUDIENCE),
      extra: {
        userId: String(payload.sub),
        tokenId: tokenHash,
        ...(cmRoles && cmRoles.length > 0 ? { cmRoles } : {}),
      },
    };
    next();
  } catch (err) {
    const description = err instanceof Error ? err.message : 'JWT verification failed';
    res.set('WWW-Authenticate', wwwAuthenticate('invalid_token', description));
    res.status(401).json({ error: 'invalid_token', error_description: description });
  }
}
