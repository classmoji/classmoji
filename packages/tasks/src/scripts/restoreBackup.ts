/**
 * List or restore the production database backups in R2 (written daily by
 * the `db-backup` task; runbook: `docs/db-backups.md`).
 *
 * Usage:
 *   npx tsx packages/tasks/src/scripts/restoreBackup.ts --list
 *   npx tsx packages/tasks/src/scripts/restoreBackup.ts --target <postgres-url> [--key <dump key>]
 *   npx tsx packages/tasks/src/scripts/restoreBackup.ts --download <dir> [--key <dump key>]
 *
 * Without `--key` it takes the newest backup that finished (has a manifest).
 * Every download is checked against its manifest's size and SHA-256 before it
 * is used.
 *
 * The target must be EMPTY (no tables) and local, unless `--allow-remote`
 * (a disaster restore into a brand-new database). Never restore over
 * production: restore into a scratch database and copy back what you need.
 * The target needs the `vector` extension available (the local docker image,
 * pgvector/pgvector:pg16, has it; Neon has it).
 *
 * Needs `DB_BACKUP_R2_ACCOUNT_ID`, `DB_BACKUP_R2_ACCESS_KEY_ID`,
 * `DB_BACKUP_R2_SECRET_ACCESS_KEY`, `DB_BACKUP_R2_BUCKET` in the environment,
 * and `pg_restore`/`psql` 16 or newer on PATH (`brew install libpq`, or set
 * `PG_RESTORE_PATH`/`PSQL_PATH`).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backupStore, redact, runCommand, type BackupConfig } from '../helpers/dbBackup.ts';
import {
  USER_TABLES_SQL,
  checkRestoreTarget,
  finishedBackups,
  listKeys,
  readManifest,
} from '../helpers/dbBackupRestore.ts';
import { downloadToFile, sha256File } from '../helpers/r2Objects.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string): never {
  console.error(`[restore] ${message}`);
  process.exit(1);
}

const missing = [
  'DB_BACKUP_R2_ACCOUNT_ID',
  'DB_BACKUP_R2_ACCESS_KEY_ID',
  'DB_BACKUP_R2_SECRET_ACCESS_KEY',
  'DB_BACKUP_R2_BUCKET',
].filter(name => !process.env[name]);
if (missing.length) fail(`missing env: ${missing.join(', ')}`);

const store = backupStore({
  accountId: process.env.DB_BACKUP_R2_ACCOUNT_ID,
  accessKeyId: process.env.DB_BACKUP_R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.DB_BACKUP_R2_SECRET_ACCESS_KEY,
  bucket: process.env.DB_BACKUP_R2_BUCKET,
} as BackupConfig);
const pgRestore = process.env.PG_RESTORE_PATH || 'pg_restore';
const psql = process.env.PSQL_PATH || 'psql';

const backups = finishedBackups(await listKeys(store));

if (process.argv.includes('--list')) {
  if (!backups.length) console.log('No finished backups.');
  for (const b of backups) console.log(b.dumpKey);
  process.exit(0);
}

const target = arg('--target');
const downloadDir = arg('--download');
if (!target && !downloadDir) fail('pass --list, --target <postgres-url> or --download <dir>');

const chosen = arg('--key')
  ? backups.find(b => b.dumpKey === arg('--key'))
  : backups[backups.length - 1];
if (!chosen) fail(arg('--key') ? `no finished backup ${arg('--key')}` : 'no finished backups');

if (target) {
  const check = checkRestoreTarget(target, process.argv.includes('--allow-remote'));
  if (!check.ok) fail(check.reason);
  const tables = await runCommand(psql, ['--no-psqlrc', '-tA', '-c', USER_TABLES_SQL, target]);
  if (tables.code !== 0) fail(`cannot read the target: ${redact(tables.stderr.trim(), target)}`);
  if (tables.stdout.trim() !== '0') {
    fail(`the target database ${check.database} is not empty; restore only into a new database`);
  }
}

const manifest = await readManifest(store, chosen.manifestKey);
const workDir = downloadDir
  ? (await mkdir(downloadDir, { recursive: true }), downloadDir)
  : await mkdtemp(join(tmpdir(), 'db-restore-'));
const file = join(workDir, chosen.dumpKey.split('/').pop() ?? 'backup.dump');

// Errors in here are thrown, not `fail()`ed: process.exit would skip the
// `finally` and leave a copy of the database in the temp directory.
try {
  console.log(`[restore] downloading ${chosen.dumpKey} (${manifest.bytes} bytes)`);
  await downloadToFile(store, chosen.dumpKey, file, manifest.bytes);
  const sha256 = await sha256File(file);
  if (sha256 !== manifest.sha256) throw new Error(`checksum mismatch for ${chosen.dumpKey}`);
  console.log(`[restore] verified sha256 ${sha256}`);

  if (target) {
    // One transaction, stop at the first error: a restore either completes or
    // leaves the target as empty as it was.
    const restore = await runCommand(pgRestore, [
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--single-transaction',
      `--dbname=${target}`,
      file,
    ]);
    if (restore.code !== 0) {
      throw new Error(`pg_restore failed: ${redact(restore.stderr.trim(), target)}`);
    }
    console.log(`[restore] restored ${chosen.dumpKey} (dumped ${manifest.startedAt})`);
  } else {
    console.log(`[restore] saved ${file}`);
  }
} catch (error) {
  console.error(`[restore] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (!downloadDir) await rm(workDir, { recursive: true, force: true });
}
