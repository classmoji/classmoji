/**
 * The MCP bearer tokens Classmoji mints itself (`askmoji_…`, one per Ask Moji
 * or quiz turn, and the development-only dev mint): a row in
 * `mcp_internal_tokens`, looked up by the token's SHA-256
 * (packages/auth/src/mcpToken.ts). A token that is not there is refused.
 *
 * A token is accepted while:
 *   - its row exists, names one of the two internal client ids, and has not
 *     expired;
 *   - its user is not banned (a ban with an end date counts until then);
 *   - when it was minted for a View as session, that session still exists, is
 *     the same user's, names the same admin, and has not expired. The admin
 *     the viewer records is the row's, never a header's.
 */

import getPrisma from '@classmoji/database';
import {
  hashInternalToken,
  INTERNAL_CLIENT_IDS,
  INTERNAL_TOKEN_PREFIX,
} from '@classmoji/auth/mcp-token';
import { TokenStoreUnavailableError, UnauthorizedError } from '../mcp/errors.ts';
import { isTokenStoreUnavailable } from './tokenStoreErrors.ts';
import { isBanned, type Viewer } from './viewer.ts';

/** Whether a bearer has the internal tokens' shape (and is looked up in their table). */
export function isInternalToken(bearer: string): boolean {
  return bearer.startsWith(INTERNAL_TOKEN_PREFIX);
}

/** A read that fails because the store is unavailable → 503; anything else is passed on. */
async function read<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (isTokenStoreUnavailable(error)) throw new TokenStoreUnavailableError({ cause: error });
    throw error;
  }
}

export async function resolveInternalToken(bearer: string, now = Date.now()): Promise<Viewer> {
  const prisma = getPrisma();
  const row = await read(() =>
    prisma.mcpInternalToken.findUnique({
      where: { token_hash: hashInternalToken(bearer) },
      select: {
        client_id: true,
        user_id: true,
        scopes: true,
        expires_at: true,
        impersonation_session_id: true,
        impersonated_by: true,
        user: { select: { banned: true, ban_expires_at: true } },
      },
    })
  );
  if (!row || !INTERNAL_CLIENT_IDS.includes(row.client_id)) {
    throw new UnauthorizedError('Missing or invalid access token');
  }
  if (row.expires_at.getTime() <= now) {
    throw new UnauthorizedError('Access token expired');
  }
  if (isBanned(row.user, now)) {
    throw new UnauthorizedError('Access token user is banned');
  }

  if (row.impersonation_session_id || row.impersonated_by) {
    const sessionId = row.impersonation_session_id;
    const session = sessionId
      ? await read(() =>
          prisma.session.findUnique({
            where: { id: sessionId },
            select: { user_id: true, impersonatedBy: true, expires_at: true },
          })
        )
      : null;
    if (
      !session ||
      !row.impersonated_by ||
      session.user_id !== row.user_id ||
      session.impersonatedBy !== row.impersonated_by ||
      session.expires_at.getTime() <= now
    ) {
      throw new UnauthorizedError('The View as session this token was minted for has ended');
    }
  }

  return {
    tokenKind: 'internal',
    userId: row.user_id,
    clientId: row.client_id,
    scopes: new Set(row.scopes),
    impersonatedBy: row.impersonated_by ?? null,
  };
}
