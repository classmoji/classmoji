/**
 * A database session that refuses writes, for scripts run against production.
 *
 * What it guarantees: an ordinary write sent through this client (an INSERT,
 * an UPDATE, a model `create`) fails with "cannot execute ... in a read-only
 * transaction", on every session the client opens. What it does not: code
 * that itself switches the access mode (`SET transaction_read_only = off`,
 * `BEGIN READ WRITE`) is not stopped. It guards against a script's mistakes,
 * not against a script written to write.
 *
 *   1. The URL is the DIRECT endpoint (`DATABASE_URL_UNPOOLED`, not the
 *      pooler: a pooled connection is shared between clients, so a session
 *      setting is neither reliable nor ours to set), on a client of exactly
 *      one connection (`openReadOnlySession`).
 *   2. Every session that client opens STARTS read-only: the startup
 *      parameter `-c default_transaction_read_only=on` is sent at connect, so
 *      it holds for a session node-postgres opens to replace one the server
 *      ended mid-run (a `SET SESSION` would be lost with the old session, and
 *      the replacement would be writable). It also beats a role-level
 *      `ALTER ROLE ... SET default_transaction_read_only = off`. A URL
 *      `options=` parameter would override it, so such a URL is refused.
 *   3. Fail closed at connect: before anything else, the session must report
 *      `default_transaction_read_only = on`, i.e. the startup parameter
 *      arrived. An endpoint that drops startup options (some proxies do) is
 *      an error here, not a writable fallback a later `SET` would paper over.
 *   4. `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` too, then
 *      `SHOW transaction_read_only` must answer `on` — or nothing else runs.
 *   5. The caller re-asserts before trusting its output (`assertReadOnly`).
 *
 * Takes the client as a parameter so the guard is testable with a fake.
 */

import type { PrismaClient } from '@prisma/client';
import { createPgPrismaClient } from '@classmoji/database/pg-client';

export const DRY_RUN_ACK = 'read-only';

/** Refuse to start unless the operator acknowledged a read-only run. */
export function requireReadOnlyAck(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CLASSMOJI_DRY_RUN_ACK !== DRY_RUN_ACK) {
    throw new Error(`Refusing to start: set CLASSMOJI_DRY_RUN_ACK=${DRY_RUN_ACK}`);
  }
}

/**
 * The direct-endpoint URL, checked, and the host to print. The URL itself (it
 * carries the password) must never be printed.
 */
export function directEndpointUrl(raw: string | undefined): { url: string; host: string } {
  if (!raw)
    throw new Error('DATABASE_URL_UNPOOLED is required (the direct endpoint, not the pooler)');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL_UNPOOLED is not a valid URL');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error('DATABASE_URL_UNPOOLED is not a postgres URL');
  }
  if (
    /-pooler\./i.test(parsed.hostname) ||
    parsed.searchParams.getAll('pgbouncer').at(-1)?.toLowerCase() === 'true'
  ) {
    throw new Error('DATABASE_URL_UNPOOLED points at a pooler; use the direct endpoint');
  }
  if (parsed.searchParams.has('options')) {
    // node-postgres lets a URL `options=` override the startup parameters
    // that make every session read-only (see the top of this file).
    throw new Error(
      'DATABASE_URL_UNPOOLED carries `options=`; remove it (it could undo read-only)'
    );
  }
  return { url: parsed.toString(), host: parsed.hostname };
}

/** Sent at connect: every session the client opens, replacements included, starts read-only. */
export const READ_ONLY_STARTUP_OPTIONS = '-c default_transaction_read_only=on';

/**
 * A client of ONE session, made read-only and proven so (see the top of this
 * file). The caller `$disconnect()`s it.
 */
export async function openReadOnlySession(url: string): Promise<PrismaClient> {
  const client = createPgPrismaClient(url, {
    max: 1,
    keepIdle: true,
    options: READ_ONLY_STARTUP_OPTIONS,
  });
  try {
    await enforceReadOnlySession(client);
  } catch (error) {
    await client.$disconnect().catch(() => {});
    throw error;
  }
  return client;
}

export interface RawClient {
  $executeRawUnsafe(query: string): Promise<unknown>;
  $queryRawUnsafe(query: string): Promise<unknown>;
}

/** Throws unless the session reports `transaction_read_only = on`. */
export async function assertReadOnly(client: RawClient): Promise<void> {
  const rows = (await client.$queryRawUnsafe('SHOW transaction_read_only')) as
    | { transaction_read_only?: unknown }[]
    | null;
  const value = Array.isArray(rows) ? rows[0]?.transaction_read_only : undefined;
  if (value !== 'on') {
    throw new Error(
      `Aborting: the database session is not read-only (transaction_read_only=${String(value)})`
    );
  }
}

/**
 * Throws unless the session STARTED read-only: the startup parameter reached
 * the server (a proxy that drops startup options leaves it `off`).
 */
export async function assertStartedReadOnly(client: RawClient): Promise<void> {
  const rows = (await client.$queryRawUnsafe(
    "SELECT current_setting('default_transaction_read_only') AS default_transaction_read_only"
  )) as { default_transaction_read_only?: unknown }[] | null;
  const value = Array.isArray(rows) ? rows[0]?.default_transaction_read_only : undefined;
  if (value !== 'on') {
    throw new Error(
      `Aborting: the database session did not start read-only (default_transaction_read_only=${String(value)}); the endpoint may drop startup options`
    );
  }
}

/**
 * Prove the session started read-only, then make it read-only for the
 * session too and prove that. Run before any other query.
 */
export async function enforceReadOnlySession(client: RawClient): Promise<void> {
  await assertStartedReadOnly(client);
  await client.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await assertReadOnly(client);
}
