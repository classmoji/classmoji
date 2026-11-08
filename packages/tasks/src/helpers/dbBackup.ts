import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { headBytes, sha256File, uploadFile, type MediaStore } from './r2Objects.ts';

/**
 * Daily off-site backup of the production database: `pg_dump` to a temp file,
 * check it, upload it to its own R2 bucket, then write a manifest beside it.
 *
 * ## Why these choices
 *
 * - **Temp file, not a stream.** A streamed dump can fail after the upload has
 *   already completed, and the bucket lock then keeps that broken object for 7
 *   days. Here nothing is uploaded until `pg_dump` has exited 0 and
 *   `pg_restore --list` has read the archive back.
 * - **A new key per ATTEMPT.** The bucket lock refuses overwrites, so a retry
 *   that reused the key of an object a previous attempt managed to write would
 *   fail forever. `<started>-<runId>-a<attempt>` never repeats.
 * - **The manifest is the success marker.** It is written last, so a dump with
 *   no manifest is an attempt that did not finish; the freshness monitor
 *   (`apps/backup-monitor`) and the restore script only trust dumps that have
 *   one.
 * - **Its own bucket and token** (`DB_BACKUP_R2_*`), never the media ones: a
 *   leaked token for one bucket reaches nothing in the other.
 *
 * Retention is the bucket's job (lifecycle: delete after 90 days, abort
 * unfinished uploads after 1 day; lock: 7 days), not this code's: it never
 * deletes anything.
 */

/**
 * A backup's file names at the bucket root: `<UTC start>-<run id>-a<attempt>`
 * plus `.dump` or `.manifest.json`. The monitor (apps/backup-monitor) and the
 * restore script count only names of this shape, so anything else put in the
 * bucket is never mistaken for a backup.
 */
export const BACKUP_KEY_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{6}Z-[A-Za-z0-9_-]+-a\d+\.(?:dump|manifest\.json)$/;

/**
 * Smaller than this is not a real production dump. An empty schema is
 * ~300 KB; production's first full dump (Nov 2026) was 33 MB.
 */
export const DEFAULT_MIN_BYTES = 10 * 1024 * 1024;

export interface BackupConfig {
  databaseUrl: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  minBytes: number;
  /**
   * `/usr/lib/postgresql` in the deployed image, which carries one client per
   * supported major (`postgresClient()` in trigger.config.js): each run uses
   * `<root>/<server major>/bin`. Null under `trigger dev`, which uses the
   * paths below (PATH by default).
   */
  pgBinRoot: string | null;
  pgDumpPath: string;
  pgRestorePath: string;
  /** Any version works here: it only asks the server for its version. */
  psqlPath: string;
}

export const BACKUP_ENV_VARS = [
  'DB_BACKUP_DATABASE_URL',
  'DB_BACKUP_R2_ACCOUNT_ID',
  'DB_BACKUP_R2_ACCESS_KEY_ID',
  'DB_BACKUP_R2_SECRET_ACCESS_KEY',
  'DB_BACKUP_R2_BUCKET',
] as const;

/**
 * The backup's settings from the environment. Throws, naming every missing
 * variable, rather than skipping: in production a missing secret must fail the
 * run (and alert), never look like a quiet success.
 */
export function readBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const missing = BACKUP_ENV_VARS.filter(name => !env[name]);
  if (missing.length) {
    throw new Error(`[db-backup] missing env: ${missing.join(', ')}`);
  }
  const value = (name: (typeof BACKUP_ENV_VARS)[number]) => env[name] ?? '';
  const minBytes = Number(env.DB_BACKUP_MIN_BYTES ?? DEFAULT_MIN_BYTES);
  return {
    databaseUrl: value('DB_BACKUP_DATABASE_URL'),
    accountId: value('DB_BACKUP_R2_ACCOUNT_ID'),
    accessKeyId: value('DB_BACKUP_R2_ACCESS_KEY_ID'),
    secretAccessKey: value('DB_BACKUP_R2_SECRET_ACCESS_KEY'),
    bucket: value('DB_BACKUP_R2_BUCKET'),
    minBytes: Number.isFinite(minBytes) && minBytes >= 0 ? minBytes : DEFAULT_MIN_BYTES,
    // Set in the deployed image by `postgresClient()` in trigger.config.js;
    // `trigger dev` uses whatever is on PATH.
    pgBinRoot: env.PG_BIN_ROOT || null,
    pgDumpPath: env.PG_DUMP_PATH || 'pg_dump',
    pgRestorePath: env.PG_RESTORE_PATH || 'pg_restore',
    psqlPath: env.PSQL_PATH || 'psql',
  };
}

export function backupStore(config: BackupConfig): MediaStore {
  return {
    bucket: config.bucket,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Same settings as `mediaStore()`; see r2Objects.ts for why.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 10_000, socketTimeout: 60_000 },
    }),
  };
}

/** `2026-11-09T10:17:03.123Z` → `2026-11-09T101703Z`: sortable, no colons. */
export function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '');
}

/** Unique per attempt, so a retry never collides with a locked object. */
export function backupKey(startedAt: Date, runId: string, attempt: number): string {
  const safeRun = runId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeRun) throw new Error('[db-backup] empty run id');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('[db-backup] bad attempt');
  return `${stampOf(startedAt)}-${safeRun}-a${attempt}.dump`;
}

export function manifestKeyFor(dumpKey: string): string {
  if (!dumpKey.endsWith('.dump')) throw new Error(`[db-backup] not a dump key: ${dumpKey}`);
  return dumpKey.slice(0, -'.dump'.length) + '.manifest.json';
}

export interface BackupManifest {
  version: 1;
  key: string;
  bytes: number;
  sha256: string;
  /** When pg_dump started: the dump's snapshot is taken at about this moment. */
  startedAt: string;
  finishedAt: string;
  pgDumpVersion: string;
  serverVersion: string;
  runId: string;
  attempt: number;
}

/** Replaces the connection string (password and all) wherever it appears. */
export function redact(text: string, secret: string): string {
  let out = secret ? text.split(secret).join('<database-url>') : text;
  // libpq can also echo `postgresql://user:pass@host` forms it rebuilt itself.
  out = out.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, '$1***@');
  return out;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** The last 4 KB of output is plenty for an error message. */
const OUTPUT_CAP = 4096;

/**
 * Run a command to completion, keeping only the tail of its output (pg_dump's
 * stderr is drained, never left to fill a pipe and stall it). Aborting the
 * signal kills the process.
 */
export function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    const keep = (prev: string, chunk: Buffer) =>
      (prev + chunk.toString('utf8')).slice(-OUTPUT_CAP);
    child.stdout.on('data', (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = keep(stderr, c)));
    child.on('error', reject);
    child.on('close', (code, sig) => resolve({ code, signal: sig, stdout, stderr }));
  });
}

export interface BackupDeps {
  run: typeof runCommand;
  store: MediaStore;
  upload: typeof uploadFile;
  head: typeof headBytes;
  hash: typeof sha256File;
  putManifest: (store: MediaStore, key: string, manifest: BackupManifest) => Promise<void>;
  now: () => Date;
  tempDir: () => Promise<string>;
  exists: (path: string) => Promise<boolean>;
}

async function putManifestObject(store: MediaStore, key: string, manifest: BackupManifest) {
  await store.client.send(
    new PutObjectCommand({
      Bucket: store.bucket,
      Key: key,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    })
  );
}

export function defaultDeps(config: BackupConfig): BackupDeps {
  return {
    run: runCommand,
    store: backupStore(config),
    upload: uploadFile,
    head: headBytes,
    hash: sha256File,
    putManifest: putManifestObject,
    now: () => new Date(),
    tempDir: () => mkdtemp(join(tmpdir(), 'db-backup-')),
    exists: path =>
      access(path, constants.X_OK).then(
        () => true,
        () => false
      ),
  };
}

function failure(step: string, result: CommandResult, config: BackupConfig): Error {
  const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
  const tail = redact(result.stderr.trim(), config.databaseUrl);
  return new Error(`[db-backup] ${step} failed (${how})${tail ? `: ${tail}` : ''}`);
}

export const SERVER_VERSION_SQL =
  "SELECT current_setting('server_version_num') || ' ' || current_setting('server_version')";

/** `160015 16.15 (f37ae9a)` → major 16, version `16.15 (f37ae9a)`. */
export function parseServerVersion(output: string): { major: number; serverVersion: string } {
  const match = /^\s*(\d{5,6})\s+(.+?)\s*$/.exec(output);
  if (!match) throw new Error(`[db-backup] unreadable server version: ${output.slice(0, 80)}`);
  return { major: Math.floor(Number(match[1]) / 10000), serverVersion: match[2] };
}

/**
 * The pg_dump/pg_restore matching the server's major. pg_dump refuses a
 * newer server, and a dump from a newer pg_dump may not restore into the
 * server's own version, so the image carries one client per major and each
 * run takes the server's. A major the image lacks fails with what to change,
 * instead of an opaque spawn error.
 */
export async function clientFor(
  config: BackupConfig,
  major: number,
  exists: (path: string) => Promise<boolean>
): Promise<{ pgDump: string; pgRestore: string }> {
  if (!config.pgBinRoot) return { pgDump: config.pgDumpPath, pgRestore: config.pgRestorePath };
  const bin = `${config.pgBinRoot}/${major}/bin`;
  const client = { pgDump: `${bin}/pg_dump`, pgRestore: `${bin}/pg_restore` };
  if (!(await exists(client.pgDump)) || !(await exists(client.pgRestore))) {
    throw new Error(
      `[db-backup] the server runs Postgres ${major}, but the image has no client for it; ` +
        'add it to POSTGRES_CLIENT_MAJORS in packages/tasks/trigger.config.js and redeploy'
    );
  }
  return client;
}

/**
 * One backup attempt. Resolves with the manifest once the dump AND its
 * manifest are in the bucket; throws on anything else, leaving at most an
 * orphan dump without a manifest (ignored by everything that reads backups,
 * removed by the 90-day rule).
 */
export async function runDbBackup({
  config,
  runId,
  attempt,
  signal,
  deps,
}: {
  config: BackupConfig;
  runId: string;
  attempt: number;
  signal?: AbortSignal;
  deps: BackupDeps;
}): Promise<BackupManifest> {
  const dir = await deps.tempDir();
  try {
    const serverOut = await deps.run(
      config.psqlPath,
      ['--no-psqlrc', '-tA', '-c', SERVER_VERSION_SQL, config.databaseUrl],
      signal
    );
    if (serverOut.code !== 0) throw failure('reading the server version', serverOut, config);
    const { major, serverVersion } = parseServerVersion(serverOut.stdout);

    const client = await clientFor(config, major, deps.exists);
    const versionOut = await deps.run(client.pgDump, ['--version'], signal);
    if (versionOut.code !== 0) throw failure('pg_dump --version', versionOut, config);
    const pgDumpVersion = versionOut.stdout.trim();

    const file = join(dir, 'backup.dump');
    const startedAt = deps.now();
    const dump = await deps.run(
      client.pgDump,
      ['--format=custom', '--no-password', `--file=${file}`, `--dbname=${config.databaseUrl}`],
      signal
    );
    if (dump.code !== 0) throw failure('pg_dump', dump, config);

    const { size } = await stat(file);
    if (size < config.minBytes) {
      throw new Error(
        `[db-backup] dump is ${size} bytes, below the ${config.minBytes}-byte minimum; refusing to upload it`
      );
    }

    // Reads the archive's table of contents end to end: a truncated or
    // corrupt file fails here, before anything is uploaded.
    const list = await deps.run(client.pgRestore, ['--list', file], signal);
    if (list.code !== 0) throw failure('pg_restore --list', list, config);

    const sha256 = await deps.hash(file);
    const key = backupKey(startedAt, runId, attempt);
    await deps.upload(deps.store, key, file, size, 'application/octet-stream');

    const stored = await deps.head(deps.store, key);
    if (stored !== size) {
      throw new Error(`[db-backup] uploaded ${size} bytes but R2 reports ${stored} for ${key}`);
    }

    const manifest: BackupManifest = {
      version: 1,
      key,
      bytes: size,
      sha256,
      startedAt: startedAt.toISOString(),
      finishedAt: deps.now().toISOString(),
      pgDumpVersion,
      serverVersion,
      runId,
      attempt,
    };
    await deps.putManifest(deps.store, manifestKeyFor(key), manifest);
    return manifest;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
