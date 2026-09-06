/**
 * One question, asked before anything writes: is this database local?
 *
 * The guard this replaces keyed on `E2E_TARGET`, which describes INTENT and
 * not connectivity. A developer whose `.env` DATABASE_URL points at Neon —
 * ordinary when debugging production data — running the documented command
 * `E2E_CD_CONTENT_REPO=1 npm run e2e:content` would have had `E2E_TARGET`
 * unset, therefore "local", therefore permission to upload fixtures to a live
 * content repo, delete a file out of it, flip a real classroom's
 * `content_delivery_enabled`, and bump its `content_key_version` — which
 * rewrites every signed URL every real viewer is holding.
 *
 * So the gate is the resolved DATABASE_URL's HOST, checked at the moment of the
 * write. It lives in its own module because the pack is not the only caller:
 * `getTestPrisma` in both apps' `tests/helpers/` opens the same client for
 * other suites, and a guard the shared client does not enforce is a guard with
 * a way around it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

/** The escape hatch. Long and unpleasant to type, deliberately. */
const OVERRIDE = 'E2E_ALLOW_REMOTE_DB_I_KNOW_WHAT_I_AM_DOING';

/** Loopback in the three spellings a connection string actually uses. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Hosts the override may NOT unlock.
 *
 * The point of an escape hatch is a docker host or a colleague's box on the
 * LAN, never production. Neon is matched by provider domain rather than by
 * project name because the project name is the part that changes; the
 * `prod`/`production` words catch a self-hosted equivalent.
 */
const NEVER_WRITABLE = [
  // Not end-anchored: these are matched against `host/database`, so a `$` here
  // would stop matching the moment the database name was appended — which is
  // how the Neon rule silently stopped firing when the name was added.
  /\.neon\.tech\//i,
  /\.supabase\.co\//i,
  /\.rds\.amazonaws\.com\//i,
  /\bprod(uction)?\b/i,
];

/** DATABASE_URL as the pack will actually use it: env first, then `.dev-context`. */
export function resolvedDatabaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const content = fs.readFileSync(path.join(REPO_ROOT, '.dev-context'), 'utf-8');
    const match = content.match(/URL:\s+(postgresql:\/\/\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Host of a postgres connection string, lowercased, or null if unparseable. */
export function databaseHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLocalDatabaseHost(host: string | null): boolean {
  return host !== null && LOCAL_HOSTS.has(host);
}

/**
 * The identity the never-writable patterns are matched against.
 *
 * Host AND database name, because production hides in either one. A managed
 * provider announces itself in the host (`…aws.neon.tech`), but a self-hosted
 * production database is usually `db.internal.example.com/prod` — an ordinary
 * host holding the database everyone cares about. Matching the host alone let
 * the override through on exactly that shape.
 */
function databaseIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}/${parsed.pathname.replace(/^\//, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Refuse the write unless the database is one it is safe to damage.
 *
 * Throws rather than skipping. A skip is the right answer to "this environment
 * cannot show me the thing"; this is "this environment must not be touched",
 * and a run that quietly skipped would leave the operator believing the guard
 * had approved something. `action` names the specific write so the message
 * says what was stopped.
 */
export function assertWritableDatabase(action: string): void {
  const url = resolvedDatabaseUrl();
  const host = databaseHost(url);

  if (isLocalDatabaseHost(host)) return;

  if (host === null) {
    throw new Error(
      `refusing to ${action}: no DATABASE_URL could be resolved, so there is no way to tell ` +
        'which database this would write to. Set DATABASE_URL, or run from a checkout with a .dev-context.'
    );
  }

  const identity = databaseIdentity(url as string);
  if (NEVER_WRITABLE.some(pattern => pattern.test(identity))) {
    throw new Error(
      `refusing to ${action}: DATABASE_URL points at '${identity}', which looks like a managed or ` +
        `production database. ${OVERRIDE} does not unlock this one.`
    );
  }

  if (process.env[OVERRIDE] === '1') {
    console.warn(
      `[e2e] ${OVERRIDE}=1 — allowing "${action}" against the non-local database at '${host}'.`
    );
    return;
  }

  throw new Error(
    `refusing to ${action}: DATABASE_URL points at '${host}', not a local database. ` +
      'This pack creates and deletes files in a real GitHub content repo and changes classroom ' +
      `rows, so it only runs against localhost. Set ${OVERRIDE}=1 if you are certain.`
  );
}
