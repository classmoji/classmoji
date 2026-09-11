/**
 * mintMcpAccessToken — the per-user MCP bearer token Ask Moji carries
 * (plan §4.4, task P1-2).
 *
 * WHY A ROW IS WRITTEN DIRECTLY INSTEAD OF DRIVING THE OAUTH FLOW
 * ---------------------------------------------------------------
 * better-auth's MCP access tokens are opaque, unsigned, plaintext-stored 32-char
 * strings (better-auth 1.4.18, node_modules/better-auth/dist/plugins/mcp/index.mjs
 * :406-421). There is nothing to sign and nothing to forge, so a row written here
 * validates identically to one minted through the browser — which is exactly what
 * apps/mcp/src/routes/devMint.ts already relies on. The webapp holds the user's
 * session on every Ask Moji turn, so re-minting is free and no browser hop and no
 * refresh grant is ever needed.
 *
 * This couples us to better-auth's plaintext token storage. So does
 * apps/mcp/src/auth/resolveViewer.ts, which reads the row shape directly. A
 * better-auth upgrade must re-verify BOTH files together.
 *
 * WHY THE MINTED TOKEN CAN NEVER BE REFRESHED (three independent layers)
 * ---------------------------------------------------------------------
 * `oauth_access_tokens.refresh_token` is NOT NULL and @unique, so a row cannot be
 * created without one. A live refresh token here would be a real escalation: the
 * refresh grant (index.mjs:262-309) checks the refresh token and the client id and
 * *never* a client secret, so anyone holding a leaked one-hour Ask Moji bearer
 * could read the whole token row back out of `/mcp/get-session` (index.mjs:636-653
 * returns the entire row, expiry unchecked) and trade its refresh token for a
 * fresh seven-day renewable credential, indefinitely. The three layers that stop
 * that, all of which must be removed before the attack works again:
 *
 *   1. HERE — `refreshTokenExpiresAt` is stamped in the PAST, so the refresh grant
 *      refuses the row with `invalid_grant` (index.mjs:283-286). The value itself
 *      is random, so it is not guessable either.
 *   2. packages/auth/src/server.ts — a `hooks.before` middleware rejects every
 *      `/mcp/token` grant that names this client id, refresh or otherwise.
 *   3. packages/auth/src/server.ts — `disabledPaths` 404s the raw
 *      `/mcp/get-session` HTTP endpoint, so the row (and the refresh token in it)
 *      is not readable by an external caller at all. apps/mcp calls
 *      `auth.api.getMcpSession` IN-PROCESS, which does not pass through the HTTP
 *      router, so MCP token validation is untouched.
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
 * The OAuth client every Ask Moji token is issued to. Seeded by
 * packages/database/scripts/seed.js and upserted here so a fresh environment
 * works without a seed run. `OauthAccessToken.clientId` FKs
 * `OauthApplication.clientId`, and `Viewer.clientId`
 * (apps/mcp/src/auth/resolveViewer.ts:69) is how the MCP tells an Ask Moji call
 * from a Claude.ai-connector call.
 */
export const ASK_MOJI_CLIENT_ID = 'classmoji-ask-moji';

/**
 * Space-delimited, matching the column's format. READ ONLY on purpose:
 * apps/mcp/src/mcp/registry.ts:428 filters at REGISTRATION, so a write tool is
 * never registered for this token and never appears in `tools/list`. The model
 * cannot be talked into calling a tool that is absent.
 */
export const ASK_MOJI_SCOPES = 'read';

/** Matches better-auth's own `accessTokenExpiresIn` default (index.mjs:124). */
export const TOKEN_TTL_SECONDS = 3600;

/**
 * A live token with more than this left is handed back instead of minting a new
 * one. This is what keeps `oauth_access_tokens` from growing one row per chat
 * turn — it bounds minting to roughly one row per user per hour. The floor also
 * means a token handed to a turn always has at least five minutes of life, so a
 * long tool call cannot expire mid-flight.
 */
export const REUSE_FLOOR_SECONDS = 300;

export interface MintedMcpToken {
  accessToken: string;
  expiresAt: Date;
}

/** The subset of the Prisma client this module uses — also what tests stand in for. */
type MintClient = Pick<
  PrismaClient,
  'oauthAccessToken' | 'oauthApplication' | '$executeRaw' | '$transaction'
>;
type MintTx = Omit<MintClient, '$transaction'>;

/**
 * A stable 64-bit key for `pg_advisory_xact_lock`, derived from the client id and
 * the user id so two users never contend with each other.
 *
 * An advisory lock rather than the repo's usual `SELECT … FOR UPDATE` idiom
 * (packages/services/src/classmoji/classroomMembership.service.ts:405) because
 * there is no row that represents "this user's Ask Moji token" until we create
 * one — that is the whole race. Locking the `users` row instead would serialize
 * token minting against unrelated profile writes.
 */
function advisoryLockKey(userId: string): bigint {
  return createHash('sha256').update(`${ASK_MOJI_CLIENT_ID}:${userId}`).digest().readBigInt64BE(0);
}

/** A live, reusable token for this user, or null. */
async function findReusableToken(client: MintTx, userId: string): Promise<MintedMcpToken | null> {
  const floor = new Date(Date.now() + REUSE_FLOOR_SECONDS * 1000);
  const existing = await client.oauthAccessToken.findFirst({
    where: {
      userId,
      clientId: ASK_MOJI_CLIENT_ID,
      scopes: ASK_MOJI_SCOPES,
      accessTokenExpiresAt: { gt: floor },
    },
    orderBy: { accessTokenExpiresAt: 'desc' },
  });
  if (!existing) return null;
  return { accessToken: existing.accessToken, expiresAt: existing.accessTokenExpiresAt };
}

/**
 * Mint (or reuse) a read-only MCP access token for `userId`.
 *
 * The caller must already have proven the user's identity — this function does no
 * authentication of its own. It is called from an already-authenticated webapp
 * request, once per Ask Moji turn.
 *
 * @throws if `userId` is empty — minting an unbound token would produce a bearer
 *   that `resolveViewer` rejects anyway, and a silent no-op here would be worse.
 */
export async function mintMcpAccessToken(userId: string): Promise<MintedMcpToken> {
  if (!userId) {
    throw new Error('mintMcpAccessToken: userId is required');
  }

  const prisma = getPrisma() as MintClient;

  // Fast path, outside any transaction: the overwhelmingly common case is a
  // second turn of a conversation whose token is still comfortably alive.
  const reusable = await findReusableToken(prisma, userId);
  if (reusable) return reusable;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const client = tx as unknown as MintTx;

    // Serialize this user's mints. Two turns racing here (two tabs, or a
    // conversation resumed in parallel) would otherwise BOTH miss the read above
    // and BOTH create a row — the access tokens are random, so no unique
    // constraint would catch it.
    //
    // `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns `void`,
    // and Prisma's `$queryRaw` fails deserializing a void column ("Failed to
    // deserialize column of type 'void'"). Verified against the dev database.
    await (tx as unknown as MintClient)
      .$executeRaw`SELECT pg_advisory_xact_lock(${advisoryLockKey(userId)})`;

    // Double-checked: whoever held the lock first may have just minted the token
    // this call was about to create. Reuse theirs.
    const raced = await findReusableToken(client, userId);
    if (raced) return raced;

    // Idempotent. `update: {}` on purpose: if an operator has flipped
    // `disabled: true` as a kill switch (resolveViewer refuses a disabled
    // application), minting must not quietly turn Ask Moji back on.
    await client.oauthApplication.upsert({
      where: { clientId: ASK_MOJI_CLIENT_ID },
      update: {},
      create: {
        name: 'Ask Moji',
        clientId: ASK_MOJI_CLIENT_ID,
        clientSecret: '', // never used — no authorization-code flow runs for this client
        redirectUrls: '', // never used — no browser redirect
        // NOT 'public'. Nothing reads this on the direct-mint path, but 'public'
        // means "no client secret required" if the real flow is ever wired up.
        type: 'confidential',
        disabled: false,
      },
    });

    const now = Date.now();

    // Hygiene: this user's dead Ask Moji rows go now. Scoped to the user rather
    // than the whole client so concurrent mints never contend on the same rows;
    // growth stays bounded at one stale row per user who stops using Ask Moji,
    // cleared the moment they come back.
    await client.oauthAccessToken.deleteMany({
      where: {
        clientId: ASK_MOJI_CLIENT_ID,
        userId,
        accessTokenExpiresAt: { lte: new Date(now) },
      },
    });

    const expiresAt = new Date(now + TOKEN_TTL_SECONDS * 1000);
    const created = await client.oauthAccessToken.create({
      data: {
        accessToken: `askmoji_${randomBytes(32).toString('base64url')}`,
        // The column is NOT NULL and @unique, so a value must be written. It is
        // random (unguessable) AND already expired (unusable) — see the module
        // docblock: a live refresh token here is a privilege escalation.
        refreshToken: `askmoji-norefresh_${randomBytes(32).toString('base64url')}`,
        accessTokenExpiresAt: expiresAt,
        refreshTokenExpiresAt: new Date(now - 1000),
        clientId: ASK_MOJI_CLIENT_ID,
        userId,
        scopes: ASK_MOJI_SCOPES,
      },
    });

    return { accessToken: created.accessToken, expiresAt: created.accessTokenExpiresAt };
  });
}
