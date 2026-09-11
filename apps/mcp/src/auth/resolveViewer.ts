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
 */

import getPrisma from '@classmoji/database';
import { auth } from '@classmoji/auth/server';
import { UnauthorizedError } from '../mcp/errors.ts';

export type Scope = 'read' | 'write';

export interface Viewer {
  userId: string;
  /** OAuth client the token was issued to. */
  clientId: string | null;
  /** Granted scopes, parsed from the token row's space-delimited string. */
  scopes: ReadonlySet<string>;
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
  } catch {
    // better-auth throws APIError for malformed requests — treat as unauthenticated.
    throw new UnauthorizedError('Invalid access token');
  }

  if (!session) {
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
  const application = await getPrisma().oauthApplication.findUnique({
    where: { clientId: session.clientId },
    select: { disabled: true },
  });
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
