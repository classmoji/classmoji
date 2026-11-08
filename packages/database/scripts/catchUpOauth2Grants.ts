/**
 * Copies the better-auth 1.4 OAuth rows written after the
 * 20261107180000_oauth2_provider_tables migration ran into the 1.7 tables,
 * exactly as that migration copied the rows it found (CX-2).
 *
 *   DATABASE_URL='postgresql://…' node packages/database/scripts/catchUpOauth2Grants.ts           # dry run
 *   DATABASE_URL='postgresql://…' node packages/database/scripts/catchUpOauth2Grants.ts --write   # insert
 *   … --since 2026-11-09T14:03:12.345Z [--write]   # rows created since then
 *
 * (Node 24+ runs the file as it is; `npx tsx` works too.)
 *
 * WHY. The migration runs in the webapp's release_command. Until every
 * webapp machine runs better-auth 1.7, machines still on 1.4 keep writing
 * legacy rows: clients registered at the old endpoint, refresh tokens issued
 * or rotated by the old token endpoint (1.4 rotates by creating a new row; it
 * never changes or deletes one), consents given on the old consent page. Run
 * it once the webapp deploy has finished (MCP clients reach the OAuth
 * endpoints on the webapp's origin only). After a rollback to the previous
 * release, the old release writes legacy rows again; once the release is
 * back on 1.7, run it again: by default it starts where the last recorded
 * run started.
 *
 * WHAT IT COPIES. The legacy rows created at or after its watermark, to the
 * millisecond (legacy `created_at` has milliseconds):
 *   - by default, the start of the last run recorded in platform_audit_logs
 *     (see RECORD), or, before any run, the migration's first start: the
 *     earliest `started_at` among its `_prisma_migrations` rows, rolled-back
 *     ones included (`migrate resolve --applied` records a new row whose
 *     `started_at` is the time of the resolve, while the copy ran at the first
 *     attempt);
 *   - with `--since <ISO timestamp>`, that time. It may not be earlier than
 *     the migration's first start nor later than this run's own start, and
 *     not earlier than the last recorded run's start unless
 *     `--allow-earlier-since` is given.
 * Rows older than the watermark are not looked at again, so a row 1.7 has
 * deleted since an earlier run read it (refresh-token reuse or a revocation
 * at /oauth2/revoke ending its family) is not put back. (A password change, a
 * reset and a ban also delete the user's legacy rows:
 * packages/auth/src/server.ts revokeOAuthGrants.) Every run prints the
 * watermark it uses and where it comes from, and its own start (`run started
 * …`, `runStartedAt` in the RESULT line). They go through the migration's own
 * statements 1–3:
 *   - clients: every one but the two Classmoji-owned ids; legacy id kept;
 *     no owner; `public` → `none` with no secret, any other type → client_secret_basic
 *     with the secret as SHA-256 base64url without padding; redirect URIs
 *     split on commas; the server's scope list written out;
 *   - consents: one per (client, user) with a given consent or a live
 *     refresh token, newest consent's id, all their scopes;
 *   - refresh tokens: live, of a user, on a copied client; legacy id and
 *     expiry kept; hashed; `offline_access` added; no resources (the token
 *     endpoint's rule writes the MCP resource on first use).
 * Legacy access tokens are never copied. What those statements produce is
 * then inserted, never updated or deleted:
 *   - a client when no client has its id;
 *   - a refresh token when no refresh token has its id;
 *   - a consent only when its (client, user) has no consent at all. A second
 *     consent, created now, for a pair that already holds a 1.7 JWT would
 *     refuse that JWT (the MCP's `iat >= consent createdAt` check reads the
 *     newest consent).
 *
 * WHY THE SQL CANNOT DRIFT FROM THE MIGRATION. The three statements are read
 * from the migration file and run byte for byte, and the file's SHA-256 must
 * equal the checksum Prisma recorded when it applied the migration to THIS
 * database. They run against temporary tables of the same names, with
 * search_path set to pg_temp alone (each name is checked to resolve there):
 * the three legacy tables hold only the rows created since the watermark
 * (minus clients already copied), oauth2_clients holds every client the
 * database has (so the statements' joins see exactly the copied clients),
 * and oauth2_consents and oauth2_refresh_tokens start empty. The real tables
 * are checked to be untouched by them.
 *
 * DRY RUN (the default): the temporary tables are created, then the
 * transaction is switched to READ ONLY, so Postgres refuses any write outside
 * them. It prints the counts it would insert and rolls back.
 * --write: one transaction, all or nothing. oauth2_consents is locked against
 * other writers first (SHARE ROW EXCLUSIVE, 10 s lock timeout), so each "no
 * consent for this pair" still holds at commit. Running it again inserts
 * nothing.
 *
 * RECORD. Every --write run inserts one platform_audit_logs row in the same
 * transaction: action `oauth.catch_up.run`, no actor, `data` = { tool,
 * migration, runStartedAt, since, sinceFrom, inserted (per table) }. The
 * latest `runStartedAt` among those rows is the next run's default watermark.
 *
 * REFUSES, writing nothing, when: DATABASE_URL is not set (no .env is read);
 * `--since` is not an ISO timestamp with a time zone, or falls before the
 * migration's first start, after this run's start, or (without
 * `--allow-earlier-since`) before the last recorded run's start; the
 * migration has no single applied row; the file differs from what ran; a
 * recorded run has no valid `runStartedAt`;
 * a row to insert collides with a row already there under another id (a
 * client id, a refresh-token hash or a consent id), which the migration could
 * not have produced. Use Neon's direct (not -pooler) URL: temporary tables
 * need one session for the whole transaction. Never prints a token or secret.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Prisma, PrismaClient } from '@prisma/client';

const MIGRATION = '20261107180000_oauth2_provider_tables';
/** The platform_audit_logs action of a --write run (RECORD). */
const RUN_ACTION = 'oauth.catch_up.run';
const MIGRATION_FILE = fileURLToPath(
  new URL(`../migrations/${MIGRATION}/migration.sql`, import.meta.url)
);

/** The migration's statements this script runs, by the table each one fills. */
const STATEMENTS = [
  { target: 'oauth2_clients', from: '-- 1. Clients.\n', to: '\n-- 2. Consents.' },
  { target: 'oauth2_consents', from: '-- 2. Consents.\n', to: '\n-- 3. Refresh tokens.' },
  { target: 'oauth2_refresh_tokens', from: '-- 3. Refresh tokens.\n', to: '\n-- 4. ' },
] as const;

/** Every table those statements name; each gets a temporary stand-in. */
const SHADOWED = [
  'oauth_applications',
  'oauth_consents',
  'oauth_access_tokens',
  'oauth2_clients',
  'oauth2_consents',
  'oauth2_refresh_tokens',
] as const;

const LEGACY = ['oauth_applications', 'oauth_consents', 'oauth_access_tokens'] as const;
const TARGETS = ['oauth2_clients', 'oauth2_consents', 'oauth2_refresh_tokens'] as const;
type Target = (typeof TARGETS)[number];

const SINCE = '(SELECT w."since" FROM pg_temp."catch_up_window" w)';

/** `--since`'s form: an ISO 8601 timestamp with a time zone, to the millisecond at most. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The rows to insert into each real table, from what the statements put in
 * the temporary one. The dry run counts these; --write inserts these.
 */
const TO_INSERT: Record<Target, string> = {
  // Only the clients statement 1 copied (the table also holds every client
  // the database has, for the joins).
  oauth2_clients: `SELECT t.* FROM pg_temp."oauth2_clients" t
    WHERE t."id" IN (SELECT a."id" FROM pg_temp."oauth_applications" a)
      AND NOT EXISTS (SELECT 1 FROM public."oauth2_clients" p WHERE p."id" = t."id")`,
  oauth2_consents: `SELECT t.* FROM pg_temp."oauth2_consents" t
    WHERE NOT EXISTS (
      SELECT 1 FROM public."oauth2_consents" p
      WHERE p."client_id" = t."client_id" AND p."user_id" = t."user_id")`,
  oauth2_refresh_tokens: `SELECT t.* FROM pg_temp."oauth2_refresh_tokens" t
    WHERE NOT EXISTS (SELECT 1 FROM public."oauth2_refresh_tokens" p WHERE p."id" = t."id")`,
};

/** Rows to insert that would land on a row already there under another id. */
const CONFLICTS: { what: string; sql: string }[] = [
  {
    what: 'refresh tokens whose hash is already stored under another id',
    sql: `SELECT r."id" FROM (${TO_INSERT.oauth2_refresh_tokens}) r
      WHERE EXISTS (SELECT 1 FROM public."oauth2_refresh_tokens" p WHERE p."token" = r."token")`,
  },
  {
    what: 'consents whose id another consent already has',
    sql: `SELECT r."id" FROM (${TO_INSERT.oauth2_consents}) r
      WHERE EXISTS (SELECT 1 FROM public."oauth2_consents" p WHERE p."id" = r."id")`,
  },
];

class Refusal extends Error {}

/** Thrown to roll the dry run back; carries its result out of the transaction. */
class DryRunDone extends Error {
  readonly result: Result;
  constructor(result: Result) {
    super('dry run');
    this.result = result;
  }
}

interface Result {
  mode: 'dry-run' | 'write';
  database: string;
  /** The earliest `started_at` among the migration's `_prisma_migrations` rows. */
  migrationStartedAt: string;
  /** `started_at` of its applied row. */
  migrationAppliedAt: string;
  /** This run's start: a later run's default watermark once recorded. */
  runStartedAt: string;
  /** The latest recorded run's start, if any run is recorded. */
  lastRunStartedAt: string | null;
  since: string;
  sinceFrom: 'migration' | 'last-run' | 'option';
  /** The platform_audit_logs row this run wrote (--write only). */
  recordId: string | null;
  window: Record<(typeof LEGACY)[number], number>;
  clientsAlreadyCopied: number;
  produced: Record<Target, number>;
  insert: Record<Target, number>;
}

/** Statements 1–3 of the migration, each exactly as the file has it. */
function migrationStatements(sql: string): { target: Target; sql: string }[] {
  return STATEMENTS.map(({ target, from, to }) => {
    const at = sql.indexOf(from);
    if (at < 0 || sql.indexOf(from, at + 1) >= 0) {
      throw new Refusal(`${MIGRATION}: expected the marker ${JSON.stringify(from)} exactly once`);
    }
    const start = at + from.length;
    const end = sql.indexOf(to, start);
    if (end < 0) throw new Refusal(`${MIGRATION}: no ${JSON.stringify(to)} after ${from.trim()}`);
    const text = sql.slice(start, end).trim();
    if (!text.endsWith(';') || text.indexOf(';') !== text.length - 1) {
      throw new Refusal(`${MIGRATION}: ${from.trim()} is not one statement`);
    }
    if (text.split(`INSERT INTO "${target}"`).length !== 2) {
      throw new Refusal(`${MIGRATION}: ${from.trim()} does not insert into ${target} once`);
    }
    return { target, sql: text.slice(0, -1) };
  });
}

function describeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refusal('DATABASE_URL is not a URL');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || '(none)';
  const user = decodeURIComponent(parsed.username) || '(none)';
  return `${parsed.hostname}:${parsed.port || '5432'}/${database} as ${user}`;
}

/** The latest recorded run (RECORD), or null when none is. */
async function lastRecordedRun(
  rows: <T>(sql: string, ...values: unknown[]) => Promise<T[]>
): Promise<{ id: string; startedAt: Date } | null> {
  const recorded = await rows<{ id: string; runStartedAt: string | null }>(
    `SELECT "id", "data"->>'runStartedAt' AS "runStartedAt"
     FROM public."platform_audit_logs" WHERE "action" = $1`,
    RUN_ACTION
  );
  let last: { id: string; startedAt: Date } | null = null;
  for (const { id, runStartedAt } of recorded) {
    const at = runStartedAt && ISO_TIMESTAMP.test(runStartedAt) ? Date.parse(runStartedAt) : NaN;
    if (Number.isNaN(at)) {
      throw new Refusal(`the recorded run platform_audit_logs ${id} has no valid runStartedAt`);
    }
    if (!last || at > last.startedAt.getTime()) last = { id, startedAt: new Date(at) };
  }
  return last;
}

async function run(
  tx: Prisma.TransactionClient,
  write: boolean,
  since: Date | null,
  allowEarlierSince: boolean,
  statements: { target: Target; sql: string }[],
  fileChecksum: string
): Promise<Result> {
  const rows = <T>(sql: string, ...values: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...values);
  const exec = (sql: string) => tx.$executeRawUnsafe(sql);
  const count = async (sql: string) =>
    (await rows<{ n: number }>(`SELECT count(*)::int AS "n" FROM (${sql}) s`))[0]!.n;

  const [server] = await rows<Record<string, string>>(
    `SELECT current_database() AS "database", current_user AS "user",
            coalesce(host(inet_server_addr()), 'local socket') AS "address",
            coalesce(inet_server_port()::text, '') AS "port",
            current_setting('TimeZone') AS "timezone",
            current_setting('server_version') AS "version"`
  );
  console.log(
    `connected: database ${server!.database} as ${server!.user} on ${server!.address}:${server!.port}` +
      ` (Postgres ${server!.version}, TimeZone ${server!.timezone}; this run uses UTC)`
  );
  await exec(`SET LOCAL TimeZone = 'UTC'`);
  const [started] = await rows<{ runStartedAt: Date }>(
    `SELECT date_trunc('milliseconds', transaction_timestamp()) AS "runStartedAt"`
  );
  const runStartedAt = started!.runStartedAt;
  console.log(`run started ${runStartedAt.toISOString()} (a later run's default watermark)`);

  // Every row Prisma keeps for the migration: a failed attempt (later marked
  // rolled back), the attempt that applied it, or the row
  // `migrate resolve --applied` adds (started_at = finished_at, no steps).
  const attempts = await rows<{
    checksum: string;
    started_at: Date;
    finished_at: Date | null;
    rolled_back_at: Date | null;
    applied_steps_count: number;
    since: Date;
  }>(
    `SELECT "checksum", "started_at", "finished_at", "rolled_back_at", "applied_steps_count",
            date_trunc('milliseconds', "started_at" AT TIME ZONE 'UTC') AS "since"
     FROM public."_prisma_migrations"
     WHERE "migration_name" = $1
     ORDER BY "started_at", "id"`,
    MIGRATION
  );
  const applied = attempts.filter(a => a.finished_at !== null && a.rolled_back_at === null);
  if (applied.length !== 1) {
    throw new Refusal(
      `${MIGRATION}: expected one applied row in _prisma_migrations, found ${applied.length}`
    );
  }
  const migration = applied[0]!;
  if (migration.checksum !== fileChecksum) {
    throw new Refusal(
      `${MIGRATION}/migration.sql is not the file that ran on this database ` +
        `(file ${fileChecksum}, recorded ${migration.checksum})`
    );
  }
  // The copy ran at the first attempt that committed, which is never earlier
  // than the first row; a later row may be the resolve's.
  const migrationStart = attempts[0]!.since;
  const resolvedApplied =
    migration.applied_steps_count === 0 &&
    migration.finished_at!.getTime() === migration.started_at.getTime();
  console.log(
    `migration ${MIGRATION}: ${attempts.length} row(s) in _prisma_migrations, the first started ` +
      `${attempts[0]!.started_at.toISOString()}; the applied one started ` +
      `${migration.started_at.toISOString()}` +
      (resolvedApplied ? ' (recorded by migrate resolve --applied)' : '') +
      '; the file matches its recorded checksum'
  );

  const lastRun = await lastRecordedRun(rows);
  console.log(
    lastRun
      ? `last recorded run: started ${lastRun.startedAt.toISOString()} (platform_audit_logs ${lastRun.id})`
      : 'last recorded run: none'
  );
  if (since && since.getTime() < migrationStart.getTime()) {
    throw new Refusal(
      `--since ${since.toISOString()} is before the migration's start ` +
        `(${migrationStart.toISOString()}): the migration copied those rows itself`
    );
  }
  if (since && since.getTime() > runStartedAt.getTime()) {
    throw new Refusal(`--since ${since.toISOString()} is after this run's start`);
  }
  if (since && lastRun && since.getTime() < lastRun.startedAt.getTime() && !allowEarlierSince) {
    throw new Refusal(
      `--since ${since.toISOString()} is before the last recorded run's start ` +
        `(${lastRun.startedAt.toISOString()}, platform_audit_logs ${lastRun.id}): a run from an ` +
        'earlier time reads again what that run read, and copies back any of it that 1.7 has ' +
        'ended since. Leave --since out to start at that run, or add --allow-earlier-since'
    );
  }
  let watermark: Date;
  let sinceFrom: Result['sinceFrom'];
  let source: string;
  if (since) {
    [watermark, sinceFrom, source] = [since, 'option', '--since'];
  } else if (lastRun && lastRun.startedAt.getTime() > migrationStart.getTime()) {
    [watermark, sinceFrom] = [lastRun.startedAt, 'last-run'];
    source = `the last recorded run, platform_audit_logs ${lastRun.id}`;
  } else {
    [watermark, sinceFrom, source] = [migrationStart, 'migration', "the migration's first start"];
  }
  console.log(`window: legacy rows created at or after ${watermark.toISOString()} (${source})`);

  if (write) {
    await exec(`SET LOCAL lock_timeout = '10s'`);
    await exec(`LOCK TABLE public."oauth2_consents" IN SHARE ROW EXCLUSIVE MODE`);
  }

  // Every DDL first: a dry run turns READ ONLY right after.
  await exec(`CREATE TEMP TABLE "catch_up_window" ("since" timestamp(3) NOT NULL) ON COMMIT DROP`);
  await tx.$executeRawUnsafe(
    `INSERT INTO pg_temp."catch_up_window" ("since")
     VALUES (date_trunc('milliseconds', $1::timestamptz AT TIME ZONE 'UTC'))`,
    watermark.toISOString()
  );
  for (const name of SHADOWED) {
    await exec(`CREATE TEMP TABLE "${name}" (LIKE public."${name}" INCLUDING ALL) ON COMMIT DROP`);
  }
  await exec(`SET LOCAL search_path = pg_temp`);
  if (!write) {
    await exec(`SET TRANSACTION READ ONLY`);
    const [{ readOnly }] = await rows<{ readOnly: string }>(
      `SELECT current_setting('transaction_read_only') AS "readOnly"`
    );
    console.log(
      `dry run: transaction_read_only = ${readOnly}; only the temporary tables can be written`
    );
  }

  // Every name the statements use must now mean the temporary table.
  const resolved = await rows<{ name: string; temporary: boolean | null }>(
    `SELECT n."name", (SELECT c."relnamespace" = pg_my_temp_schema() FROM pg_class c
                       WHERE c."oid" = to_regclass(quote_ident(n."name"))) AS "temporary"
     FROM unnest(ARRAY[${SHADOWED.map(name => `'${name}'`).join(', ')}]) AS n("name")`
  );
  const notShadowed = resolved.filter(r => r.temporary !== true).map(r => r.name);
  if (notShadowed.length) {
    throw new Refusal(`not resolving to temporary tables: ${notShadowed.join(', ')}`);
  }

  const inWindow = {} as Result['window'];
  for (const name of LEGACY) {
    inWindow[name] = await count(`SELECT 1 FROM public."${name}" WHERE "created_at" >= ${SINCE}`);
  }
  await exec(
    `INSERT INTO pg_temp."oauth_applications"
     SELECT a.* FROM public."oauth_applications" a
     WHERE a."created_at" >= ${SINCE}
       AND NOT EXISTS (SELECT 1 FROM public."oauth2_clients" n WHERE n."id" = a."id")`
  );
  for (const name of ['oauth_consents', 'oauth_access_tokens'] as const) {
    await exec(
      `INSERT INTO pg_temp."${name}" SELECT l.* FROM public."${name}" l WHERE l."created_at" >= ${SINCE}`
    );
  }
  await exec(`INSERT INTO pg_temp."oauth2_clients" SELECT c.* FROM public."oauth2_clients" c`);
  const clientsAlreadyCopied =
    inWindow.oauth_applications - (await count(`SELECT 1 FROM pg_temp."oauth_applications"`));

  const realCounts = async () => {
    const out: Record<string, number> = {};
    for (const name of TARGETS) out[name] = await count(`SELECT 1 FROM public."${name}"`);
    return JSON.stringify(out);
  };
  const before = await realCounts();
  const produced = {} as Result['produced'];
  for (const statement of statements) {
    try {
      produced[statement.target] = await tx.$executeRawUnsafe(statement.sql);
    } catch (error) {
      throw new Refusal(
        `the migration's statement for ${statement.target} failed on the window's rows ` +
          `(a client id already held by another client is one cause): ${(error as Error).message}`
      );
    }
  }
  if ((await realCounts()) !== before) {
    throw new Refusal('the migration statements changed a real table; nothing is written');
  }

  for (const { what, sql } of CONFLICTS) {
    const ids = (await rows<{ id: string }>(sql)).map(r => r.id);
    if (ids.length) throw new Refusal(`${ids.length} ${what}: ${ids.join(', ')}`);
  }

  const insert = {} as Result['insert'];
  for (const name of TARGETS) {
    insert[name] = await count(TO_INSERT[name]);
    if (!write) continue;
    const inserted = await tx.$executeRawUnsafe(`INSERT INTO public."${name}" ${TO_INSERT[name]}`);
    if (inserted !== insert[name] || (await count(TO_INSERT[name])) !== 0) {
      throw new Refusal(`${name}: expected to insert ${insert[name]}, inserted ${inserted}`);
    }
  }

  // RECORD: this run, for the next one's default watermark (and the audit log).
  let recordId: string | null = null;
  if (write) {
    recordId = randomUUID();
    const recorded = await tx.$executeRawUnsafe(
      `INSERT INTO public."platform_audit_logs" ("id", "actor_id", "action", "target_type", "target_id", "data")
       VALUES ($1, NULL, $2, 'oauth_grants', NULL, $3::jsonb)`,
      recordId,
      RUN_ACTION,
      JSON.stringify({
        tool: 'script:oauth.catch_up',
        migration: MIGRATION,
        runStartedAt: runStartedAt.toISOString(),
        since: watermark.toISOString(),
        sinceFrom,
        inserted: insert,
      })
    );
    if (recorded !== 1)
      throw new Refusal(`platform_audit_logs: expected one row, wrote ${recorded}`);
    console.log(`recorded this run: platform_audit_logs ${recordId} (${RUN_ACTION})`);
  }

  return {
    mode: write ? 'write' : 'dry-run',
    database: server!.database!,
    migrationStartedAt: migrationStart.toISOString(),
    migrationAppliedAt: migration.started_at.toISOString(),
    runStartedAt: runStartedAt.toISOString(),
    lastRunStartedAt: lastRun ? lastRun.startedAt.toISOString() : null,
    since: watermark.toISOString(),
    sinceFrom,
    recordId,
    window: inWindow,
    clientsAlreadyCopied,
    produced,
    insert,
  };
}

function report(result: Result): void {
  const wrote = result.mode === 'write';
  console.log('');
  console.log(
    `legacy rows in the window: ${LEGACY.map(name => `${name} ${result.window[name]}`).join(', ')}`
  );
  console.log('(legacy access tokens are never copied)');
  const header = [
    'table',
    'migration statement produced',
    'already there',
    wrote ? 'inserted' : 'would insert',
  ];
  const lines = [
    header,
    [
      'oauth2_clients',
      String(result.produced.oauth2_clients),
      `${result.clientsAlreadyCopied} (by id)`,
      String(result.insert.oauth2_clients),
    ],
    [
      'oauth2_consents',
      String(result.produced.oauth2_consents),
      `${result.produced.oauth2_consents - result.insert.oauth2_consents} (pair has a consent)`,
      String(result.insert.oauth2_consents),
    ],
    [
      'oauth2_refresh_tokens',
      String(result.produced.oauth2_refresh_tokens),
      `${result.produced.oauth2_refresh_tokens - result.insert.oauth2_refresh_tokens} (by id)`,
      String(result.insert.oauth2_refresh_tokens),
    ],
  ];
  const widths = header.map((_, i) => Math.max(...lines.map(line => line[i]!.length)));
  for (const line of lines) console.log(line.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  console.log('');
  console.log(
    wrote
      ? 'committed.'
      : 'dry run: nothing was written (read-only transaction, rolled back). Run again with --write to insert.'
  );
  console.log(`RESULT ${JSON.stringify(result)}`);
}

const USAGE =
  "usage: DATABASE_URL='postgresql://…' node packages/database/scripts/catchUpOauth2Grants.ts " +
  '[--since <ISO timestamp> [--allow-earlier-since]] [--write]';

interface Args {
  write: boolean;
  since: Date | null;
  allowEarlierSince: boolean;
}

/** `--write`, `--since <ISO timestamp>` and `--allow-earlier-since`, or the usage error to print. */
function parseArgs(args: string[]): Args | { error: string } {
  let write = false;
  let since: Date | null = null;
  let allowEarlierSince = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--write' && !write) {
      write = true;
    } else if (arg === '--allow-earlier-since' && !allowEarlierSince) {
      allowEarlierSince = true;
    } else if (arg === '--since' && !since) {
      const value = args[++i];
      if (!value || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
        return {
          error: `--since needs an ISO timestamp with a time zone (got ${value ?? 'nothing'})`,
        };
      }
      since = new Date(value);
    } else {
      return { error: `unknown argument(s): ${args.slice(i).join(' ')}` };
    }
  }
  if (allowEarlierSince && !since) return { error: '--allow-earlier-since needs --since' };
  return { write, since, allowEarlierSince };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  const { write, since, allowEarlierSince } = parsed;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set for this command; no .env file is read.');
    return 2;
  }
  console.log(`OAuth 1.4 → 1.7 catch-up (CX-2) on ${describeUrl(url)}`);
  console.log(
    write ? 'mode: WRITE (one transaction)' : 'mode: dry run (read-only; pass --write to insert)'
  );
  if (since) {
    console.log(
      `--since ${since.toISOString()}${allowEarlierSince ? ' --allow-earlier-since' : ''}`
    );
  }

  const file = readFileSync(MIGRATION_FILE);
  const fileChecksum = createHash('sha256').update(file).digest('hex');
  const statements = migrationStatements(file.toString('utf8'));

  const { PrismaClient: Client } = await import('@prisma/client');
  const prisma: PrismaClient = new Client({ datasourceUrl: url });
  try {
    const result = await prisma.$transaction(
      async tx => {
        const outcome = await run(tx, write, since, allowEarlierSince, statements, fileChecksum);
        if (!write) throw new DryRunDone(outcome);
        return outcome;
      },
      { maxWait: 10_000, timeout: 600_000 }
    );
    report(result);
  } catch (error) {
    if (!(error instanceof DryRunDone)) throw error;
    report(error.result);
  } finally {
    await prisma.$disconnect();
  }
  return 0;
}

main().then(
  code => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Refusal ? `REFUSED, nothing written: ${error.message}` : error);
    process.exitCode = 1;
  }
);
