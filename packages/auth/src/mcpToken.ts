/**
 * mintMcpAccessToken — the per-turn MCP bearer token Ask Moji and the quiz
 * agent carry (plan §4.4, task P1-2; Batch 2 task B).
 *
 * WHY CLASSMOJI MINTS THESE ITSELF INSTEAD OF DRIVING THE OAUTH FLOW
 * ------------------------------------------------------------------
 * The Trigger task holds the user's identity on every turn (the conversation's
 * row), so it can mint a fresh token per turn with no browser hop and no
 * refresh grant. The token is an opaque random string (`askmoji_…`) with a row
 * in `mcp_internal_tokens` (Prisma `McpInternalToken`), which
 * apps/mcp/src/auth/resolveViewer.ts reads to resolve it. Only the SHA-256 of
 * the token is stored (`hashInternalToken`); the raw value is returned once,
 * to the caller that minted it, and never written anywhere.
 *
 * These tokens never meet the OAuth server (better-auth's oauth-provider,
 * ./server.ts): it does not read this table, issues no refresh token for it,
 * and reserves `classmoji-ask-moji` and `classmoji-dev-mint` as DISABLED
 * clients, so no OAuth client can carry either id
 * (__tests__/askMojiTokenGrant.test.ts). apps/mcp honours Ask Moji's role
 * ceiling and impersonation headers only for an internal token of this client.
 *
 * VIEW AS
 * -------
 * A turn that runs while a platform admin views as the user passes that View
 * as session's id. The mint reads the session row and refuses unless it is a
 * live View as session of this user; the token then names the session and its
 * admin (`impersonated_by`, from the session row, never from the caller).
 * apps/mcp refuses the token once that session is gone or expired, so a turn's
 * lookups stop when View as ends, and the admin it records is the one the
 * session names.
 *
 * WHAT THIS TOKEN DOES *NOT* CONFINE (intended v1 behaviour — finding 15)
 * ----------------------------------------------------------------------
 * The token carries a user and a scope set. It carries NO classroom confinement
 * and NO role ceiling. A user who is a STUDENT in classroom A and an ASSISTANT in
 * classroom B can open Ask Moji inside A and, by naming B, read B's drafts through
 * the MCP. That is authorized by their real membership in B — every tool call
 * re-resolves the caller's membership and role for the classroom it names
 * (apps/mcp/src/authz/classroomContext.ts:60), so this is reach, not a bypass, and
 * revoking the membership stops it on the very next call. Confining a token to the
 * classroom the chat was opened in is a v2 decision, deliberately not taken here.
 *
 * Relatedly: Ask Moji's client-supplied `userRole` (the "view as student" toggle)
 * is PRESENTATION ONLY. It must never reach a permission decision — the MCP
 * derives role from the membership rows, never from anything the client says.
 *
 * @see packages/auth/src/__tests__/mcpToken.test.ts
 */

import { createHash, randomBytes } from 'node:crypto';
import getPrisma from '@classmoji/database';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The client every Ask Moji and quiz-agent token names. apps/mcp tells an
 * Ask Moji call from an OAuth client's by it (`Viewer.clientId`), together
 * with the token being an internal one.
 */
export const ASK_MOJI_CLIENT_ID = 'classmoji-ask-moji';

/** The client apps/mcp's development-only token mint (routes/devMint.ts) names. */
export const DEV_MINT_CLIENT_ID = 'classmoji-dev-mint';

/** The two client ids only Classmoji mints for; reserved, disabled, on the OAuth server. */
export const INTERNAL_CLIENT_IDS: readonly string[] = [ASK_MOJI_CLIENT_ID, DEV_MINT_CLIENT_ID];

/**
 * The prefix every internal token carries, whichever client it names (the
 * row's `client_id` says which). apps/mcp looks a bearer up in
 * `mcp_internal_tokens` only when it has this prefix.
 */
export const INTERNAL_TOKEN_PREFIX = 'askmoji_';

/**
 * READ ONLY on purpose: apps/mcp/src/mcp/registry.ts filters at REGISTRATION,
 * so a write tool is never registered for this token and never appears in
 * `tools/list`. The model cannot be talked into calling a tool that is absent.
 */
export const ASK_MOJI_SCOPES: readonly string[] = ['read'];

/** An hour, as the OAuth server's access tokens. A turn uses its token for minutes. */
export const TOKEN_TTL_SECONDS = 3600;

export interface MintedMcpToken {
  accessToken: string;
  expiresAt: Date;
}

export interface MintMcpTokenOptions {
  /**
   * The View as session the turn runs under (the conversation grant's
   * `impersonation.session_id`), when it runs under one. Null or absent: the
   * user's own turn.
   */
  impersonationSessionId?: string | null;
}

/**
 * How an internal token is stored and looked up: SHA-256 over its UTF-8
 * bytes, base64url without padding.
 */
export function hashInternalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** A new random internal token (256 bits). */
export function newInternalToken(): string {
  return `${INTERNAL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** The subset of the Prisma client this module uses — also what tests stand in for. */
type MintClient = Pick<
  PrismaClient,
  'mcpInternalToken' | 'session' | '$executeRaw' | '$transaction'
>;
type MintTx = Omit<MintClient, '$transaction'>;

/**
 * Prisma interactive-transaction limits, set explicitly instead of inheriting
 * the defaults (maxWait 2s, timeout 5s).
 *
 * `maxWait` is how long this call waits for a connection from the pool before
 * giving up; `timeout` is how long the transaction may run once it has one —
 * which here means how long it may sit in `pg_advisory_xact_lock`. The lock is
 * keyed per USER, so the only contention that can ever queue on it is one
 * person's own concurrent turns: several tabs open on the same chat, or a
 * conversation resumed in parallel. Each holder runs a few short statements,
 * so the realistic wait is milliseconds and these ceilings exist for the
 * pathological case (a saturated pool, a stalled connection) rather than the
 * normal one.
 *
 * Both FAIL CLOSED. A timeout throws out of `mintMcpAccessToken`, which fails
 * that turn. The turn is lost; the next one re-mints.
 */
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 10000 } as const;

/**
 * A stable 64-bit key for `pg_advisory_xact_lock`, derived from the client id and
 * the user id so two users never contend with each other.
 *
 * It serializes one user's mints, so the hygiene delete and the insert of two
 * racing turns never interleave. An advisory lock rather than the repo's usual
 * `SELECT … FOR UPDATE` idiom (packages/services/src/classmoji/classroomMembership.service.ts:405)
 * because no row represents "this user's Ask Moji tokens"; locking the `users`
 * row instead would serialize token minting against unrelated profile writes.
 */
function advisoryLockKey(userId: string): bigint {
  return createHash('sha256').update(`${ASK_MOJI_CLIENT_ID}:${userId}`).digest().readBigInt64BE(0);
}

/**
 * The View as binding for a turn: the session's admin, after checking the
 * session row is a live View as session of this user. Throws otherwise, so a
 * turn whose View as has ended gets no token rather than an unbound one.
 */
async function viewAsBinding(
  client: MintTx,
  userId: string,
  sessionId: string,
  now: number
): Promise<string> {
  const session = await client.session.findUnique({
    where: { id: sessionId },
    select: { user_id: true, impersonatedBy: true, expires_at: true },
  });
  if (
    !session ||
    session.user_id !== userId ||
    !session.impersonatedBy ||
    session.expires_at.getTime() <= now
  ) {
    throw new Error('mintMcpAccessToken: the View as session is not a live session of this user');
  }
  return session.impersonatedBy;
}

/**
 * Mint a read-only MCP access token for `userId`, one per turn.
 *
 * The caller must already have proven the user's identity — this function does no
 * authentication of its own. It is called by the Ask Moji and quiz Trigger
 * tasks, for the user id on the conversation's row.
 *
 * @throws if `userId` is empty (a token bound to nobody would only be refused),
 *   or if `impersonationSessionId` names no live View as session of this user.
 */
export async function mintMcpAccessToken(
  userId: string,
  options: MintMcpTokenOptions = {}
): Promise<MintedMcpToken> {
  if (!userId) {
    throw new Error('mintMcpAccessToken: userId is required');
  }
  const impersonationSessionId = options.impersonationSessionId || null;

  const prisma = getPrisma() as MintClient;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const client = tx as unknown as MintTx;

    // Serialize this user's mints (see advisoryLockKey).
    //
    // `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns `void`,
    // and Prisma's `$queryRaw` fails deserializing a void column ("Failed to
    // deserialize column of type 'void'"). Verified against the dev database.
    await (tx as unknown as MintClient)
      .$executeRaw`SELECT pg_advisory_xact_lock(${advisoryLockKey(userId)})`;

    const now = Date.now();
    const impersonatedBy = impersonationSessionId
      ? await viewAsBinding(client, userId, impersonationSessionId, now)
      : null;

    // Hygiene: this user's dead Ask Moji rows go now. Scoped to the user rather
    // than the whole client so concurrent mints never contend on the same rows;
    // a user keeps at most the tokens of the last hour's turns, and one who
    // stops using Ask Moji leaves those until they come back.
    await client.mcpInternalToken.deleteMany({
      where: {
        client_id: ASK_MOJI_CLIENT_ID,
        user_id: userId,
        expires_at: { lte: new Date(now) },
      },
    });

    const accessToken = newInternalToken();
    const expiresAt = new Date(now + TOKEN_TTL_SECONDS * 1000);
    await client.mcpInternalToken.create({
      data: {
        token_hash: hashInternalToken(accessToken),
        client_id: ASK_MOJI_CLIENT_ID,
        user_id: userId,
        scopes: [...ASK_MOJI_SCOPES],
        expires_at: expiresAt,
        impersonation_session_id: impersonationSessionId,
        impersonated_by: impersonatedBy,
      },
    });

    return { accessToken, expiresAt };
  }, TRANSACTION_OPTIONS);
}
