/**
 * `npm run db:ensure`: run `prisma generate` only when the generated clients
 * are out of date, and otherwise touch nothing (a rewrite restarts every
 * `node --watch` service and reloads Vite). turbo runs it before typecheck,
 * tests, builds, dev servers and Trigger deploys; `db:generate` runs it with
 * `--force`, always generating.
 *
 * Out of date: an entry file below is missing or newer than `generated/.stamp`
 * (the Prisma CLI was run directly), or the stamp is not the sha256 of
 * schema.prisma, the installed `prisma` and `@prisma/client` versions and the
 * entry list. The stamp is removed before generating and
 * written only after a generate that succeeded. A lock directory makes a
 * second process wait, then find the stamp current. Plain Node: it runs before
 * anything is generated.
 *
 * `DB_ENSURE=off` skips it (no lock, no stamp, no generate): the app images
 * generate only the Node client themselves, then build through turbo.
 * `--force` ignores it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** One file per schema.prisma generator (`client`, `workerClient`): change them together. */
export const GENERATED_ENTRIES = ['generated/node/client.ts', 'generated/worker/client.ts'];
const STAMP = 'generated/.stamp';
const LOCK = 'generated/.lock';
/** A lock older than this, or whose owner is gone, was left by a killed run. */
const STALE_LOCK_MS = 10 * 60_000;
/** Longer than the gap between taking the lock and writing its pid file. */
const PID_WRITE_MS = 5_000;
const LOCK_POLL_MS = 200;
/** A waiting run says so once it has waited this long. */
const LOCK_NOTICE_MS = 1_000;

export type EnsureOptions = {
  dir?: string;
  force?: boolean;
  /** The environment `DB_ENSURE` is read from (default `process.env`). */
  env?: Record<string, string | undefined>;
  versions?: string;
  generate?: () => boolean;
};

function installedVersions(): string {
  return ['prisma', '@prisma/client']
    .map(name => {
      const pkg = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'));
      return `${name}@${(pkg as { version: string }).version}`;
    })
    .join(' ');
}

export function fingerprint(dir: string, versions: string): string {
  return createHash('sha256')
    .update(readFileSync(join(dir, 'schema.prisma')))
    .update(`\0${versions}\0${GENERATED_ENTRIES.join('\n')}`)
    .digest('hex');
}

export function isUpToDate(dir: string, wanted: string): boolean {
  try {
    if (readFileSync(join(dir, STAMP), 'utf8').trim() !== wanted) return false;
    // An entry newer than the stamp was written by a generate this script did
    // not run (the Prisma CLI called directly, maybe on another schema).
    const stamped = statSync(join(dir, STAMP)).mtimeMs;
    return GENERATED_ENTRIES.every(file => statSync(join(dir, file)).mtimeMs <= stamped);
  } catch {
    return false; // no stamp, or an entry file is missing
  }
}

function runPrismaGenerate(dir: string): boolean {
  const cli = require.resolve('prisma/build/index.js');
  return (
    spawnSync(process.execPath, [cli, 'generate'], { cwd: dir, stdio: 'inherit' }).status === 0
  );
}

/** The pid in the lock, or 0 while its owner has not written one. */
function lockOwner(lock: string): number {
  try {
    const owner = Number(readFileSync(join(lock, 'pid'), 'utf8'));
    return Number.isInteger(owner) && owner > 0 ? owner : 0;
  } catch {
    return 0;
  }
}

function isStale(lock: string): boolean {
  const age = Date.now() - statSync(lock).mtimeMs;
  const owner = lockOwner(lock);
  // No pid: the owner writes it right after taking the lock, so a lock still
  // without one after a few seconds was left by a run killed in between.
  if (!owner) return age > PID_WRITE_MS;
  try {
    process.kill(owner, 0); // throws when no such process
  } catch (error) {
    // EPERM: alive, someone else's process; judge that one by age.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  return age > STALE_LOCK_MS;
}

function withLock<T>(lock: string, run: () => T): T {
  for (let waited = 0; ; waited += LOCK_POLL_MS) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (isStale(lock)) rmSync(lock, { recursive: true, force: true });
    } catch {
      // Released between the two calls: try again.
    }
    if (waited === LOCK_NOTICE_MS) {
      console.error(
        `[db:ensure] waiting for another prisma generate (pid ${lockOwner(lock) || 'unknown'}, lock ${lock})`
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Generates when out of date (or forced); throws when the generate fails. */
export function ensureGenerated(
  options: EnsureOptions = {}
): 'skipped' | 'up-to-date' | 'generated' {
  if (!options.force && (options.env ?? process.env).DB_ENSURE === 'off') return 'skipped';
  const dir = options.dir ?? PACKAGE_DIR;
  const generate = options.generate ?? (() => runPrismaGenerate(dir));
  const wanted = fingerprint(dir, options.versions ?? installedVersions());
  if (!options.force && isUpToDate(dir, wanted)) return 'up-to-date';
  mkdirSync(join(dir, 'generated'), { recursive: true });
  return withLock(join(dir, LOCK), () => {
    // Another process may have generated while this one waited.
    if (!options.force && isUpToDate(dir, wanted)) return 'up-to-date';
    rmSync(join(dir, STAMP), { force: true });
    if (!generate() || !GENERATED_ENTRIES.every(file => existsSync(join(dir, file)))) {
      throw new Error('[db:ensure] prisma generate failed; the clients are not marked current');
    }
    writeFileSync(join(dir, STAMP), `${wanted}\n`);
    return 'generated';
  });
}

// Run as a script (real paths: the loader resolves symlinks, argv[1] does not).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = ensureGenerated({ force: process.argv.includes('--force') });
    if (result === 'up-to-date') console.log('[db:ensure] Prisma clients are up to date');
    if (result === 'skipped') console.log('[db:ensure] skipped (DB_ENSURE=off)');
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
