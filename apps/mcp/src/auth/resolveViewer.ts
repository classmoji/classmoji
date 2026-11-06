/**
 * resolveViewer — THE token-validation seam (plan §3.2, locked decision 2).
 *
 * This is the ONLY place in apps/mcp where a bearer token is validated.
 * v1 validates in-process against the shared better-auth instance
 * (DB-backed `auth.api.getMcpSession`), which gives immediate revocation
 * (S2): deleting the oauth_access_tokens row invalidates the token on the
 * next request. Swapping to remote token introspection later is a change to
 * this file only.
 *
 * IMPORTANT (verified against better-auth 1.4.18,
 * node_modules/better-auth/dist/plugins/mcp/index.mjs:636-655):
 * `getMcpSession` returns the raw oauth_access_tokens row whenever the bearer
 * string matches — it does NOT check `accessTokenExpiresAt`. Expiry MUST be
 * enforced here. It also returns `scopes` as a space-delimited string. It also
 * returns ONLY the token row: the owning `oauth_applications` row, and with it
 * the `disabled` kill switch, has to be read separately (see below).
 *
 * When either read fails because the token store itself is unavailable (no
 * database connection, a missing table: see tokenStoreErrors.ts), the result
 * is a `TokenStoreUnavailableError`, which the route answers with a 503 and
 * Retry-After. So is a bearer that is not found but has the shape of a token
 * a newer authorization server issues (`UnsupportedTokenFormatError`, see
 * `isNewerTokenFormat`). Every other failure stays an `UnauthorizedError` (401).
 */

import getPrisma from '@classmoji/database';
import { auth } from '@classmoji/auth/server';
import type { Role } from '@prisma/client';
import {
  TokenStoreUnavailableError,
  UnauthorizedError,
  UnsupportedTokenFormatError,
} from '../mcp/errors.ts';
import { isTokenStoreUnavailable } from './tokenStoreErrors.ts';

/**
 * The bearer string as better-auth's `getMcpSession` reads it
 * (`Authorization` with its first "Bearer " removed).
 */
export function bearerFrom(headers: Headers): string | null {
  return headers.get('authorization')?.replace('Bearer ', '') || null;
}

/** The prefix Ask Moji's internal MCP tokens carry (packages/auth/src/mcpToken.ts). */
export const ASK_MOJI_TOKEN_PREFIX = 'askmoji_';

const JWT_SHAPE = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Whether an unknown bearer looks like a token issued by the authorization
 * server's next version, which this version cannot check:
 *   - a JWT: three base64url segments, the first a JSON header with `alg`
 *     (the planned move to better-auth 1.7 issues JWT access tokens);
 *   - an Ask Moji internal token (`askmoji_…`), which that move stores in a
 *     table of its own.
 * During that deploy, clients holding such a token can reach this version
 * for a few minutes; a 503 asks them to try again shortly instead of a 401
 * that would send them to sign in again.
 *
 * Today nothing issues JWTs, so a JWT-shaped bearer presented now gets a 503
 * instead of a 401 (acceptable: it is no token of ours either way). Ask Moji's
 * tokens already carry `askmoji_`; one this server cannot find (removed after
 * expiry, or revoked) likewise gets a 503 instead of a 401, and Ask Moji's
 * client, which never runs a sign-in flow, simply fails that call either way.
 */
export function isNewerTokenFormat(bearer: string): boolean {
  if (bearer.startsWith(ASK_MOJI_TOKEN_PREFIX)) return true;
  if (!JWT_SHAPE.test(bearer)) return false;
  try {
    const header: unknown = JSON.parse(
      Buffer.from(bearer.slice(0, bearer.indexOf('.')), 'base64url').toString('utf8')
    );
    return (
      typeof header === 'object' &&
      header !== null &&
      typeof (header as { alg?: unknown }).alg === 'string'
    );
  } catch {
    return false;
  }
}

export type Scope = 'read' | 'write';

export interface Viewer {
  userId: string;
  /** OAuth client the token was issued to. */
  clientId: string | null;
  /** Granted scopes, parsed from the token row's space-delimited string. */
  scopes: ReadonlySet<string>;
  /**
   * A caller-supplied IANA zone (the `X-Classmoji-Timezone` header), already
   * validated against Intl; null/absent when none was sent or it was invalid.
   * A RENDERING hint only — it never reaches an authorization decision. Used
   * for `_local` fields when the classroom has no zone of its own (Ask Moji
   * passes the student's browser zone; the Claude.ai connector sends none).
   */
  timezoneHint?: string | null;
  /**
   * The MCP session this request belongs to (`Mcp-Session-Id`, issued on
   * initialize; see routes/mcp.ts), when the client sent a well-formed one.
   * Only tells a person's agent sessions apart in live editing — never part
   * of an authorization decision.
   */
  agentSession?: string | null;
  /**
   * The highest role this request may resolve as in any classroom (the
   * `X-Classmoji-Role-Ceiling` header, see routes/mcp.ts). Set only for the
   * Ask Moji client, which sends the view the chat was opened in; null for
   * every other client, whatever it sends. Narrows tool and resource role
   * resolution (authz/classroomContext.ts) and nothing else.
   */
  roleCeiling?: Role | null;
  /**
   * The user id of the person viewing as this user, when an Ask Moji
   * conversation runs under impersonation (the `X-Classmoji-Impersonated-By`
   * header, see routes/mcp.ts). Set only for the Ask Moji client; null for
   * every other client, whatever it sends. Recorded as `impersonated_by` on
   * every audit row the request writes (mcp/audit.ts) and nothing else.
   */
  impersonatedBy?: string | null;
}

/** Shape of the oauth_access_tokens row `getMcpSession` returns (better-auth 1.4.18). */
interface McpSessionRow {
  userId?: string | null;
  clientId?: string | null;
  scopes?: string | null;
  accessTokenExpiresAt?: Date | string | null;
}

export async function resolveViewer(headers: Headers): Promise<Viewer> {
  let session: McpSessionRow | null = null;
  try {
    session = (await auth.api.getMcpSession({ headers })) as McpSessionRow | null;
  } catch (error) {
    if (isTokenStoreUnavailable(error)) throw new TokenStoreUnavailableError({ cause: error });
    // better-auth throws APIError for malformed requests — treat as unauthenticated.
    throw new UnauthorizedError('Invalid access token');
  }

  if (!session) {
    const bearer = bearerFrom(headers);
    if (bearer && isNewerTokenFormat(bearer)) throw new UnsupportedTokenFormatError();
    throw new UnauthorizedError('Missing or invalid access token');
  }

  // Enforce expiry ourselves — getMcpSession does not (see module docblock).
  const rawExpiry = session.accessTokenExpiresAt;
  const expiresAt = rawExpiry ? new Date(rawExpiry) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new UnauthorizedError('Access token expired');
  }

  if (!session.userId) {
    throw new UnauthorizedError('Access token is not bound to a user');
  }

  // The OAuth application's `disabled` flag is an operator kill switch: flipping
  // it revokes every token issued to that client at once, without hunting rows.
  // better-auth never consults it on this path — `getMcpSession` returns the
  // token row alone — so it is enforced here, next to expiry, for the same
  // reason. One extra read per request, on a unique index.
  //
  // Fail closed on a token with no client id: `oauth_access_tokens.client_id` is
  // NOT NULL with an FK to `oauth_applications.client_id`, so a row without one
  // cannot exist — and a token we cannot trace to an application is a token the
  // kill switch cannot reach.
  if (!session.clientId) {
    throw new UnauthorizedError('Access token is not bound to an OAuth client');
  }
  let application: { disabled: boolean | null } | null;
  try {
    application = await getPrisma().oauthApplication.findUnique({
      where: { clientId: session.clientId },
      select: { disabled: true },
    });
  } catch (error) {
    if (isTokenStoreUnavailable(error)) throw new TokenStoreUnavailableError({ cause: error });
    throw error;
  }
  if (!application) {
    throw new UnauthorizedError('Access token is not bound to an OAuth client');
  }
  if (application.disabled === true) {
    throw new UnauthorizedError('Access token client is disabled');
  }

  const scopes = new Set(
    String(session.scopes ?? '')
      .split(' ')
      .filter(Boolean)
  );

  return { userId: session.userId, clientId: session.clientId, scopes };
}
