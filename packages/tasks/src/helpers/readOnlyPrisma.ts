/**
 * A database session that cannot write, for scripts run against production.
 *
 * Not a promise that the code only reads — the SESSION refuses writes:
 *
 *   1. The URL is the DIRECT endpoint (`DATABASE_URL_UNPOOLED`, not the
 *      pooler: a pooled connection is shared between clients, so a session
 *      setting is neither reliable nor ours to set) with `connection_limit=1`,
 *      so every query this client makes goes through one connection.
 *   2. `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` on that
 *      connection, then `SHOW transaction_read_only` must answer `on` — or
 *      nothing else runs.
 *   3. The caller re-asserts before trusting its output (`assertReadOnly`), so a
 *      reconnect mid-run that silently lost the setting is caught.
 *
 * Takes the client as a parameter so the guard is testable with a fake.
 */

export const DRY_RUN_ACK = 'read-only';

/** Refuse to start unless the operator acknowledged a read-only run. */
export function requireReadOnlyAck(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CLASSMOJI_DRY_RUN_ACK !== DRY_RUN_ACK) {
    throw new Error(`Refusing to start: set CLASSMOJI_DRY_RUN_ACK=${DRY_RUN_ACK}`);
  }
}

/**
 * The single-connection URL, and the host to print. The URL itself (it carries
 * the password) must never be printed.
 */
export function singleConnectionUrl(raw: string | undefined): { url: string; host: string } {
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
  if (/-pooler\./.test(parsed.hostname) || parsed.searchParams.get('pgbouncer') === 'true') {
    throw new Error('DATABASE_URL_UNPOOLED points at a pooler; use the direct endpoint');
  }
  parsed.searchParams.set('connection_limit', '1');
  return { url: parsed.toString(), host: parsed.hostname };
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

/** Make the session read-only and prove it. Run before any other query. */
export async function enforceReadOnlySession(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await assertReadOnly(client);
}
