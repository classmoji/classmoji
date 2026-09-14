/**
 * A DISPOSABLE Postgres database, built from the migrations, for the docs suites.
 *
 * ── Why `docs_index` cannot use the house pattern ──────────────────────────
 * Every other DB-backed suite in this package namespaces its fixtures under a
 * fresh uuid and tears them down by deleting one git organization, which
 * cascades. That works because `content_index` is PER CLASSROOM: a namespaced
 * fixture is invisible to every statement that filters `classroom_id`, and the
 * cascade reaches every row it created.
 *
 * `docs_index` is GLOBAL. There is no classroom column to namespace on, so:
 *
 *   - ranking is not isolated. `searchDocs` orders the whole table, so a
 *     developer's real docs rows sit between the fixtures and change what
 *     "the top hit" means;
 *   - pagination is not isolated. `listDocs` counts every row in the table;
 *   - `docsIndexIsEmpty()` cannot be tested at all against a table that has
 *     anything else in it;
 *   - and worst, a real `reconcileDocsIndex` test ends with a SWEEP —
 *     `DELETE … WHERE slug <> ALL($1)` — which on a shared database deletes
 *     every ordinary docs row the developer had indexed.
 *
 * Namespacing protects teardown. It does not protect any of those. So the docs
 * suites get a database of their own, created from
 * `packages/database/migrations` and dropped afterwards — which has the second
 * benefit of proving the migration chain replays from empty on every run.
 *
 * ── FAIL, DO NOT SKIP ──────────────────────────────────────────────────────
 * When the opt-in is set and the database is unreachable, this THROWS. The
 * localhost gates on the existing suites otherwise permit a completely green
 * run with no SQL exercised at all — which is how a broken statement ships
 * while the suite that would have caught it silently skipped.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

/** The deliberate opt-in. Without it, the docs DB suites do not run at all. */
export const DOCS_DB_OPT_IN = 'DOCS_INDEX_INTEGRATION';

export const docsDbOptedIn = (): boolean => process.env[DOCS_DB_OPT_IN] === '1';

export interface DisposableDatabase {
  /** Connection string for the freshly migrated database. */
  url: string;
  name: string;
  /** Drops it. Safe to call twice. */
  drop(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(here, '..', '..', '..', '..', '..', 'database', 'schema.prisma');

/** Identifiers are built here, never supplied — assert it anyway. */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Create a database named after this run, migrate it, and hand back its URL.
 *
 * The admin connection is the ordinary `DATABASE_URL`: `CREATE DATABASE` may be
 * issued from any other database on the same server, so no separate maintenance
 * credential is needed, and the one thing that cannot happen — dropping the
 * database you are connected to — is exactly what we never do.
 *
 * LOCAL ONLY. Creating and dropping databases is not something to do against a
 * host somebody could have pointed at staging.
 */
export async function createDocsTestDatabase(): Promise<DisposableDatabase> {
  const adminUrl = process.env.DATABASE_URL ?? '';
  if (!adminUrl) {
    throw new Error(
      `[docsTestDatabase] ${DOCS_DB_OPT_IN}=1 but DATABASE_URL is unset. These suites FAIL rather than skip: load .env first.`
    );
  }
  if (!/@(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)[:/]/.test(adminUrl)) {
    throw new Error(
      '[docsTestDatabase] refusing to create a database on a non-local host. DATABASE_URL must point at localhost.'
    );
  }

  const name = `classmoji_docstest_${process.pid}_${Date.now().toString(36)}`;
  if (!SAFE_NAME.test(name)) throw new Error(`[docsTestDatabase] unsafe database name: ${name}`);

  const parsed = new URL(adminUrl);
  const sourceName = parsed.pathname.replace(/^\//, '');
  // Belt and braces: this must never be the database the developer is working
  // in, because the suites that use it run a sweep that deletes unmatched rows.
  if (sourceName === name)
    throw new Error('[docsTestDatabase] refusing to reuse the source database');

  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    // `CREATE DATABASE` cannot run inside a transaction; `$executeRawUnsafe`
    // issues it directly. The name is built above and shape-checked, never
    // interpolated from input.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  try {
    // The migrations ARE the schema under test. `db push` would build the table
    // from `schema.prisma` and skip the migration this lane added, so a broken
    // migration would pass a suite that never ran it.
    execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', SCHEMA], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
  } catch (error) {
    await dropDatabase(adminUrl, name);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[docsTestDatabase] migrate deploy failed for ${name}: ${detail}`);
  }

  let dropped = false;
  return {
    url: databaseUrl,
    name,
    drop: async () => {
      if (dropped) return;
      dropped = true;
      await dropDatabase(adminUrl, name);
    },
  };
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    // WITH (FORCE) terminates any connection the suite left open, so a leaked
    // client cannot leave a database behind on every run.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}
