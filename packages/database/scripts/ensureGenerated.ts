/**
 * `npm run db:ensure`: run `prisma generate` only when the generated clients
 * are out of date, and otherwise touch nothing (a rewrite restarts every
 * `node --watch` service and reloads Vite). turbo runs it before typecheck,
 * tests, builds, dev servers and Trigger deploys; `db:generate` runs it with
 * `--force`, always generating.
 *
 * Out of date: an entry file below is missing, or `generated/.stamp` is not
 * the sha256 of schema.prisma, the installed `prisma` and `@prisma/client`
 * versions and the entry list. The stamp is removed before generating and
 * written only after a generate that succeeded. A lock directory makes a
 * second process wait, then find the stamp current. Plain Node: it runs before
 * anything is generated.
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

export type EnsureOptions = {
  dir?: string;
  force?: boolean;
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
  if (!GENERATED_ENTRIES.every(file => existsSync(join(dir, file)))) return false;
  try {
    return readFileSync(join(dir, STAMP), 'utf8').trim() === wanted;
  } catch {
    return false;
  }
}

function runPrismaGenerate(dir: string): boolean {
  const cli = require.resolve('prisma/build/index.js');
  return (
    spawnSync(process.execPath, [cli, 'generate'], { cwd: dir, stdio: 'inherit' }).status === 0
  );
}

function isStale(lock: string): boolean {
  try {
    const owner = Number(readFileSync(join(lock, 'pid'), 'utf8'));
    process.kill(owner, 0); // throws when no such process
  } catch (error) {
    // EPERM: alive, someone else's. Anything else (no pid file yet, ESRCH): judge by age.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  return Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS;
}

function withLock<T>(lock: string, run: () => T): T {
  for (;;) {
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
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Generates when out of date (or forced); throws when the generate fails. */
export function ensureGenerated(options: EnsureOptions = {}): 'up-to-date' | 'generated' {
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
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
