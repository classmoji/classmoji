/**
 * mintMcpAccessToken — the per-user MCP bearer token Ask Moji carries
 * (plan §4.4, task P1-2).
 *
 * WHY A ROW IS WRITTEN DIRECTLY INSTEAD OF DRIVING THE OAUTH FLOW
 * ---------------------------------------------------------------
 * The token is an opaque random string with a row in the 1.4-era token table
 * (`oauth_access_tokens`, Prisma `LegacyOauthAccessToken`), which
 * apps/mcp/src/auth/resolveViewer.ts reads to resolve it, as it does for
 * apps/mcp/src/routes/devMint.ts. The webapp or Trigger task holds the user's
 * identity on every Ask Moji turn, so re-minting is free and no browser hop
 * and no refresh grant is ever needed. Both files read and write that row
 * shape; they move to `mcp_internal_tokens` together.
 *
 * WHY THE MINTED TOKEN CAN NEVER BE REFRESHED
 * -------------------------------------------
 * `oauth_access_tokens.refresh_token` is NOT NULL and @unique, so a row cannot be
 * created without one. It is never a working refresh token:
 *
 *   1. HERE — `refreshTokenExpiresAt` is stamped in the PAST, and the value is
 *      random (`askmoji-norefresh_…`).
 *   2. The authorization server (better-auth 1.7's oauth-provider, ./server.ts)
 *      never reads this table: its token endpoint looks refresh tokens up in
 *      `oauth2_refresh_tokens`, and the migration that created that table copied
 *      none of this client's rows.
 *   3. `classmoji-ask-moji` is reserved there as a DISABLED client, so the token
 *      endpoint refuses any grant that names it
 *      (__tests__/askMojiTokenGrant.test.ts).
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
 * works without a seed run. `LegacyOauthAccessToken.clientId` FKs
 * `LegacyOauthApplication.clientId`, and `Viewer.clientId`
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
  'legacyOauthAccessToken' | 'legacyOauthApplication' | '$executeRaw' | '$transaction'
>;
type MintTx = Omit<MintClient, '$transaction'>;

/**
 * Prisma's unique-constraint violation. Duck-typed on `code` rather than
 * `instanceof Prisma.PrismaClientKnownRequestError` so this holds for whatever
 * the generated client actually throws (the class identity differs between the
 * library and binary query engines, and across a re-generate), and so the tests
 * can drive it without constructing a real Prisma error.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Prisma interactive-transaction limits, set explicitly instead of inheriting
 * the defaults (maxWait 2s, timeout 5s).
 *
 * `maxWait` is how long this call waits for a connection from the pool before
 * giving up; `timeout` is how long the transaction may run once it has one —
 * which here means how long it may sit in `pg_advisory_xact_lock`. The lock is
 * keyed per USER, so the only contention that can ever queue on it is one
 * person's own concurrent turns: several tabs open on the same chat, or a
 * conversation resumed in parallel. Each holder runs four short statements, so
 * the realistic wait is milliseconds and these ceilings exist for the pathological
 * case (a saturated pool, a stalled connection) rather than the normal one.
 *
 * Both FAIL CLOSED. A timeout throws out of `mintMcpAccessToken`, which fails
 * that turn. That is the intended outcome: the alternative — proceeding without a
 * token, or reusing a previous turn's — is precisely what the per-turn mint
 * exists to prevent. The turn is lost; the next one re-mints.
 */
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 10000 } as const;

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
  const existing = await client.legacyOauthAccessToken.findFirst({
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
    //
    // WHY THIS UPSERT CAN STILL RACE (and why the catch below is not paranoia).
    // The advisory lock above is keyed per USER, which is what keeps one
    // person's tabs from minting two tokens — but it deliberately does NOT
    // serialize different users. This row is shared by all of them. In a fresh
    // environment that has never seeded, TWO users' first-ever turns can reach
    // this line at the same moment: Prisma's upsert is a read-then-write, both
    // read "no row", both insert, and the loser takes a P2002 on the unique
    // `clientId`. That would fail a legitimate turn with a 500 on nothing worse
    // than bad luck at first boot.
    //
    // The row the loser failed to create is exactly the row it wanted, so
    // re-read to confirm it is there and carry on. The re-read is not a
    // formality: a P2002 from some OTHER unique constraint would leave no row,
    // and that error must still surface.
    try {
      await client.legacyOauthApplication.upsert({
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
    } catch (error: unknown) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const existing = await client.legacyOauthApplication.findUnique({
        where: { clientId: ASK_MOJI_CLIENT_ID },
      });
      if (!existing) throw error;
      // Someone else created it a moment ago. Note that we do NOT inspect
      // `disabled` here, for the same reason `update: {}` above does not write
      // it: whether the application is enabled is resolveViewer's call at use
      // time, not this function's at mint time.
    }

    const now = Date.now();

    // Hygiene: this user's dead Ask Moji rows go now. Scoped to the user rather
    // than the whole client so concurrent mints never contend on the same rows;
    // growth stays bounded at one stale row per user who stops using Ask Moji,
    // cleared the moment they come back.
    await client.legacyOauthAccessToken.deleteMany({
      where: {
        clientId: ASK_MOJI_CLIENT_ID,
        userId,
        accessTokenExpiresAt: { lte: new Date(now) },
      },
    });

    const expiresAt = new Date(now + TOKEN_TTL_SECONDS * 1000);
    const created = await client.legacyOauthAccessToken.create({
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
  }, TRANSACTION_OPTIONS);
}
