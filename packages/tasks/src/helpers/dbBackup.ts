import { S3Client } from '@aws-sdk/client-s3';
import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { headBytes, sha256File, uploadFile, type MediaStore } from './r2Objects.ts';

/**
 * Daily off-site backup of the production database: `pg_dump` to a temp file,
 * check it, upload it to its own R2 bucket as ONE file,
 * `2026-11-09T101703Z.dump`, with its details as object metadata.
 *
 * ## Why these choices
 *
 * - **Temp file, not a stream.** A streamed dump can fail after the upload has
 *   already completed, and the bucket lock then keeps that broken object for 7
 *   days. Here nothing is uploaded until `pg_dump` has exited 0 and
 *   `pg_restore --list` has read the archive back.
 * - **Named by the dump's start time.** The bucket lock refuses overwrites, so
 *   every attempt needs its own name; each attempt starts pg_dump at its own
 *   moment (retries are at least a minute apart), so the UTC second is enough.
 * - **No separate success marker.** An R2 upload is atomic: the object appears
 *   only once the upload completes, and a failed one never does (unfinished
 *   multipart uploads are aborted after a day). So every `.dump` in the bucket
 *   is whole. Its SHA-256, size and versions travel with it as metadata
 *   (`BACKUP_METADATA`), read by the restore script; the monitor
 *   (`apps/backup-monitor`) needs only the name's timestamp.
 * - **Its own bucket and token** (`DB_BACKUP_R2_*`), never the media ones: a
 *   leaked token for one bucket reaches nothing in the other.
 *
 * Retention is the bucket's job (lifecycle: delete after 90 days, abort
 * unfinished uploads after 1 day; lock: 7 days), not this code's: it never
 * deletes anything.
 */

/**
 * A backup's name at the bucket root: the UTC second pg_dump started, then
 * `.dump`. The monitor (apps/backup-monitor) and the restore script count only
 * names of this shape, so anything else put in the bucket is never mistaken
 * for a backup.
 */
export const BACKUP_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z\.dump$/;

/**
 * The object metadata each backup carries (`x-amz-meta-<name>`, lower case,
 * ASCII). Set at upload: the bucket lock forbids rewriting it later.
 */
export const BACKUP_METADATA = {
  sha256: 'sha256',
  startedAt: 'started-at',
  finishedAt: 'dump-finished-at',
  pgDumpVersion: 'pg-dump-version',
  serverVersion: 'server-version',
  runId: 'run-id',
  attempt: 'attempt',
} as const;

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

/** `2026-11-09T101703Z.dump`: when pg_dump started, to the second. */
export function backupKey(startedAt: Date): string {
  return `${stampOf(startedAt)}.dump`;
}

/** `2026-11-09T101703Z.dump` → that instant, or null for any other name. */
export function startedAtOf(key: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/.exec(key);
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** What a backup is, as returned by a run (and stored as its metadata). */
export interface BackupInfo {
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

/** The object metadata for a backup: printable ASCII only, as S3 requires. */
export function backupMetadata(info: BackupInfo): Record<string, string> {
  const ascii = (value: string) => value.replace(/[^\x20-\x7e]/g, '?');
  return {
    [BACKUP_METADATA.sha256]: info.sha256,
    [BACKUP_METADATA.startedAt]: info.startedAt,
    [BACKUP_METADATA.finishedAt]: info.finishedAt,
    [BACKUP_METADATA.pgDumpVersion]: ascii(info.pgDumpVersion),
    [BACKUP_METADATA.serverVersion]: ascii(info.serverVersion),
    [BACKUP_METADATA.runId]: ascii(info.runId),
    [BACKUP_METADATA.attempt]: String(info.attempt),
  };
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
  now: () => Date;
  tempDir: () => Promise<string>;
  exists: (path: string) => Promise<boolean>;
}

export function defaultDeps(config: BackupConfig): BackupDeps {
  return {
    run: runCommand,
    store: backupStore(config),
    upload: uploadFile,
    head: headBytes,
    hash: sha256File,
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
 * One backup attempt. Resolves once the dump is in the bucket at its full size
 * with its metadata; throws on anything else, having uploaded nothing (or,
 * if only the final size check fails, a dump the 90-day rule removes).
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
}): Promise<BackupInfo> {
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
    const info: BackupInfo = {
      key: backupKey(startedAt),
      bytes: size,
      sha256,
      startedAt: startedAt.toISOString(),
      finishedAt: deps.now().toISOString(),
      pgDumpVersion,
      serverVersion,
      runId,
      attempt,
    };
    await deps.upload(deps.store, info.key, file, size, 'application/octet-stream', {
      metadata: backupMetadata(info),
    });

    const stored = await deps.head(deps.store, info.key);
    if (stored !== size) {
      throw new Error(
        `[db-backup] uploaded ${size} bytes but R2 reports ${stored} for ${info.key}`
      );
    }
    return info;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
