/**
 * resolveViewer — THE token-validation seam (plan §3.2, locked decision 2).
 *
 * This is the ONLY place in apps/mcp where a bearer token is validated. It is
 * called from POST /mcp's `onRequest` hook, so a request is answered from its
 * headers alone until its token has passed (routes/mcp.ts).
 *
 * Two kinds of bearer are accepted, and nothing else:
 *   - `askmoji_…`: a token Classmoji minted itself (Ask Moji's and the quiz
 *     agent's turns, the dev mint), found by its hash in
 *     `mcp_internal_tokens` (./internalToken.ts);
 *   - a JWT access token the OAuth server signed for an MCP client the user
 *     connected (./jwtAccessToken.ts).
 * Every other bearer, an internal token that is not in the table, and a JWT
 * that fails a check are refused: `UnauthorizedError`, a 401 with the
 * sign-in challenge.
 *
 * When a read the check depends on fails because the store is unavailable
 * (no database connection, a missing table: see tokenStoreErrors.ts; or the
 * signing keys could not be read in time), the result is a
 * `TokenStoreUnavailableError`, which the route answers with a 503 and
 * Retry-After and no challenge: nothing was learned about the token.
 */

import { UnauthorizedError } from '../mcp/errors.ts';
import { isInternalToken, resolveInternalToken } from './internalToken.ts';
import { isJwtShaped, resolveJwtAccessToken } from './jwtAccessToken.ts';
import type { Viewer } from './viewer.ts';

export type { Scope, TokenKind, Viewer } from './viewer.ts';

/**
 * The bearer token of an `Authorization: Bearer <token>` header (the scheme
 * in any case, RFC 7235), or null. Any other scheme, DPoP included, carries
 * no bearer.
 */
export function bearerFrom(headers: Headers): string | null {
  const match = /^Bearer +(\S+) *$/i.exec(headers.get('authorization') ?? '');
  return match ? match[1] : null;
}

export async function resolveViewer(headers: Headers): Promise<Viewer> {
  const bearer = bearerFrom(headers);
  if (!bearer) throw new UnauthorizedError('Missing or invalid access token');
  if (isInternalToken(bearer)) return resolveInternalToken(bearer);
  if (isJwtShaped(bearer)) return resolveJwtAccessToken(bearer);
  throw new UnauthorizedError('Missing or invalid access token');
}
