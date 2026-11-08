/**
 * The daily database backup. What matters:
 *
 *  - nothing is uploaded unless pg_dump exited 0, the file is big enough and
 *    `pg_restore --list` reads it back (a locked bucket keeps a bad upload for
 *    7 days);
 *  - the dump is uploaded as one file carrying its checksum and versions as
 *    metadata, and the run fails unless R2 then holds it at the right size;
 *  - every attempt gets its own name, so a retry never hits a locked object;
 *  - the database URL (with its password) never reaches an error message;
 *  - the temp dump is always removed.
 *
 * pg_dump, pg_restore, psql and R2 are all faked; nothing leaves the process.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  BACKUP_KEY_PATTERN,
  backupKey,
  backupMetadata,
  clientFor,
  parseServerVersion,
  readBackupConfig,
  redact,
  runDbBackup,
  stampOf,
  startedAtOf,
  type BackupConfig,
  type BackupDeps,
  type CommandResult,
} from '../dbBackup.ts';
import type { MediaStore } from '../r2Objects.ts';

const URL = 'postgresql://db_backup:s3cret-pass@ep-prod.neon.tech/classmoji?sslmode=require';

const config: BackupConfig = {
  databaseUrl: URL,
  accountId: 'acct',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'classmoji-db-backups-prod',
  minBytes: 10,
  pgBinRoot: null,
  pgDumpPath: 'pg_dump',
  pgRestorePath: 'pg_restore',
  psqlPath: 'psql',
};

const ok = (stdout = ''): CommandResult => ({ code: 0, signal: null, stdout, stderr: '' });
const fail = (stderr: string, code = 1): CommandResult => ({
  code,
  signal: null,
  stdout: '',
  stderr,
});

interface FakeOptions {
  dumpBytes?: number;
  dumpResult?: CommandResult;
  listResult?: CommandResult;
  upload?: BackupDeps['upload'];
  storedBytes?: number | null;
  /** When the fake clock starts: a retry starts at least a minute after the attempt before it. */
  startAt?: string;
  serverVersionOut?: string;
  installed?: string[];
}

function fakeDeps(options: FakeOptions = {}) {
  const {
    dumpBytes = 64,
    dumpResult = ok(),
    listResult = ok('toc'),
    serverVersionOut = '160009 16.9\n',
  } = options;
  const calls: string[] = [];
  let dir = '';
  const run = vi.fn(async (command: string, args: string[]) => {
    calls.push(`exec ${command}${args[0] === '--version' ? ' --version' : ''}`);
    if (args[0] === '--version') return ok('pg_dump (PostgreSQL) 16.15');
    if (command.endsWith('psql')) return ok(serverVersionOut);
    if (command.endsWith('pg_dump')) {
      const file = args.find(a => a.startsWith('--file='))!.slice('--file='.length);
      await writeFile(file, Buffer.alloc(dumpBytes, 1));
      calls.push('dump');
      return dumpResult;
    }
    if (command.endsWith('pg_restore')) {
      calls.push('list');
      return listResult;
    }
    throw new Error(`unexpected command ${command}`);
  });
  const upload = vi.fn(
    options.upload ??
      (async (_s: MediaStore, key: string) => {
        calls.push(`upload ${key}`);
      })
  );
  let tick = Date.parse(options.startAt ?? '2026-11-09T10:17:03.456Z');
  const deps: BackupDeps = {
    run: run as unknown as BackupDeps['run'],
    store: { client: {} as MediaStore['client'], bucket: config.bucket },
    upload: upload as unknown as BackupDeps['upload'],
    head: vi.fn(async () => ('storedBytes' in options ? options.storedBytes! : dumpBytes)),
    hash: vi.fn(async () => 'abc123'),
    now: () => new Date((tick += 1000)),
    tempDir: async () => (dir = await mkdtemp(join(tmpdir(), 'db-backup-test-'))),
    exists: async path => (options.installed ?? []).includes(path),
  };
  return { deps, calls, run, upload, dir: () => dir };
}

describe('readBackupConfig', () => {
  it('names every missing variable instead of quietly skipping', () => {
    expect(() => readBackupConfig({ DB_BACKUP_R2_BUCKET: 'b' })).toThrow(
      'missing env: DB_BACKUP_DATABASE_URL, DB_BACKUP_R2_ACCOUNT_ID, DB_BACKUP_R2_ACCESS_KEY_ID, DB_BACKUP_R2_SECRET_ACCESS_KEY'
    );
  });

  it('reads the image binaries and the minimum size', () => {
    const c = readBackupConfig({
      DB_BACKUP_DATABASE_URL: URL,
      DB_BACKUP_R2_ACCOUNT_ID: 'a',
      DB_BACKUP_R2_ACCESS_KEY_ID: 'k',
      DB_BACKUP_R2_SECRET_ACCESS_KEY: 's',
      DB_BACKUP_R2_BUCKET: 'b',
      DB_BACKUP_MIN_BYTES: '5',
      PG_DUMP_PATH: '/usr/lib/postgresql/16/bin/pg_dump',
      PG_BIN_ROOT: '/usr/lib/postgresql',
    });
    expect(c.minBytes).toBe(5);
    expect(c.pgBinRoot).toBe('/usr/lib/postgresql');
    expect(c.pgDumpPath).toBe('/usr/lib/postgresql/16/bin/pg_dump');
    expect(c.pgRestorePath).toBe('pg_restore');
  });
});

describe('keys', () => {
  const at = new Date('2026-11-09T10:17:03.456Z');

  it('is the UTC second the dump started: sortable, colon-free, one file at the root', () => {
    expect(stampOf(at)).toBe('2026-11-09T101703Z');
    expect(backupKey(at)).toBe('2026-11-09T101703Z.dump');
    expect(startedAtOf('2026-11-09T101703Z.dump')?.toISOString()).toBe('2026-11-09T10:17:03.000Z');
    expect(startedAtOf('notes.txt')).toBeNull();
  });

  it('matches the name pattern the monitor and restore script look for', () => {
    expect(BACKUP_KEY_PATTERN.test(backupKey(at))).toBe(true);
    expect(BACKUP_KEY_PATTERN.test(`prod/${backupKey(at)}`)).toBe(false);
    expect(BACKUP_KEY_PATTERN.test('2026-11-09T101703Z.manifest.json')).toBe(false);
    expect(BACKUP_KEY_PATTERN.test('notes.txt')).toBe(false);
  });
});

describe('backupMetadata', () => {
  it('stores the checksum, times and versions as plain ASCII', () => {
    expect(
      backupMetadata({
        key: 'k.dump',
        bytes: 1,
        sha256: 'abc',
        startedAt: '2026-11-09T10:17:03.000Z',
        finishedAt: '2026-11-09T10:17:37.000Z',
        pgDumpVersion: 'pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg12+2)',
        serverVersion: '16.15 (f37ae9a) – neon',
        runId: 'run_1',
        attempt: 2,
      })
    ).toEqual({
      sha256: 'abc',
      'started-at': '2026-11-09T10:17:03.000Z',
      'dump-finished-at': '2026-11-09T10:17:37.000Z',
      'pg-dump-version': 'pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg12+2)',
      'server-version': '16.15 (f37ae9a) ? neon',
      'run-id': 'run_1',
      attempt: '2',
    });
  });
});

describe('server version and client', () => {
  it('reads the major from server_version_num', () => {
    expect(parseServerVersion('160015 16.15 (f37ae9a)\n')).toEqual({
      major: 16,
      serverVersion: '16.15 (f37ae9a)',
    });
    expect(parseServerVersion('170002 17.2')).toEqual({ major: 17, serverVersion: '17.2' });
    expect(() => parseServerVersion('')).toThrow('unreadable server version');
  });

  const inImage = { ...config, pgBinRoot: '/usr/lib/postgresql' };
  const has =
    (...paths: string[]) =>
    async (p: string) =>
      paths.includes(p);

  it("uses the image's client for the server's major", async () => {
    await expect(
      clientFor(
        inImage,
        17,
        has('/usr/lib/postgresql/17/bin/pg_dump', '/usr/lib/postgresql/17/bin/pg_restore')
      )
    ).resolves.toEqual({
      pgDump: '/usr/lib/postgresql/17/bin/pg_dump',
      pgRestore: '/usr/lib/postgresql/17/bin/pg_restore',
    });
  });

  it('says what to change when the image has no client for that major', async () => {
    await expect(clientFor(inImage, 19, has())).rejects.toThrow(
      'runs Postgres 19, but the image has no client for it; add it to POSTGRES_CLIENT_MAJORS'
    );
  });

  it('uses the configured paths outside the image', async () => {
    await expect(clientFor(config, 16, has())).resolves.toEqual({
      pgDump: 'pg_dump',
      pgRestore: 'pg_restore',
    });
  });
});

describe('redact', () => {
  it('removes the connection string and any password-bearing URL', () => {
    expect(redact(`connection to ${URL} failed`, URL)).toBe('connection to <database-url> failed');
    expect(redact('postgres://u:p4ss@h/db', URL)).toBe('postgres://u:***@h/db');
  });
});

describe('runDbBackup', () => {
  it('dumps, checks, then uploads one file with its details as metadata', async () => {
    const f = fakeDeps();
    const info = await runDbBackup({ config, runId: 'run_1', attempt: 2, deps: f.deps });

    expect(f.calls.filter(c => !c.startsWith('exec'))).toEqual([
      'dump',
      'list',
      'upload 2026-11-09T101704Z.dump',
    ]);
    expect(info).toMatchObject({
      key: '2026-11-09T101704Z.dump',
      bytes: 64,
      sha256: 'abc123',
      startedAt: '2026-11-09T10:17:04.456Z',
      pgDumpVersion: 'pg_dump (PostgreSQL) 16.15',
      serverVersion: '16.9',
      runId: 'run_1',
      attempt: 2,
    });
    const options = f.upload.mock.calls[0][5] as { metadata: Record<string, string> };
    expect(options.metadata).toEqual(backupMetadata(info));
    expect(existsSync(f.dir())).toBe(false);
  });

  it("dumps with the client matching the server's major", async () => {
    const f = fakeDeps({
      serverVersionOut: '170004 17.4\n',
      installed: ['/pg/17/bin/pg_dump', '/pg/17/bin/pg_restore'],
    });
    await runDbBackup({
      config: { ...config, pgBinRoot: '/pg', psqlPath: '/pg/18/bin/psql' },
      runId: 'r',
      attempt: 1,
      deps: f.deps,
    });
    expect(f.calls.filter(c => c.startsWith('exec'))).toEqual([
      'exec /pg/18/bin/psql',
      'exec /pg/17/bin/pg_dump --version',
      'exec /pg/17/bin/pg_dump',
      'exec /pg/17/bin/pg_restore',
    ]);
  });

  it('dumps in custom format without ever prompting for a password', async () => {
    const f = fakeDeps();
    await runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps });
    const dumpArgs = f.run.mock.calls.find(c => c[0] === 'pg_dump' && c[1][0] !== '--version')![1];
    expect(dumpArgs).toEqual(
      expect.arrayContaining(['--format=custom', '--no-password', `--dbname=${URL}`])
    );
  });

  it('uploads nothing when pg_dump fails, and keeps the password out of the error', async () => {
    const f = fakeDeps({ dumpResult: fail(`pg_dump: error: connection to ${URL} refused`) });
    const error = await runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps }).catch(e => e);

    expect(error.message).toContain('pg_dump failed (exit 1)');
    expect(error.message).toContain('<database-url>');
    expect(error.message).not.toContain('s3cret-pass');
    expect(f.upload).not.toHaveBeenCalled();
    expect(existsSync(f.dir())).toBe(false);
  });

  it('refuses a dump below the minimum size', async () => {
    const f = fakeDeps({ dumpBytes: 3 });
    await expect(runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps })).rejects.toThrow(
      'below the 10-byte minimum'
    );
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('refuses an archive pg_restore cannot read', async () => {
    const f = fakeDeps({ listResult: fail('pg_restore: error: could not read input file') });
    await expect(runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps })).rejects.toThrow(
      'pg_restore --list failed'
    );
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('fails, and still cleans up, when the upload fails', async () => {
    const f = fakeDeps({
      upload: async () => {
        throw new Error('network down');
      },
    });
    await expect(runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps })).rejects.toThrow(
      'network down'
    );
    expect(existsSync(f.dir())).toBe(false);
  });

  it('fails when R2 holds a different size', async () => {
    const f = fakeDeps({ storedBytes: 12 });
    await expect(runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps })).rejects.toThrow(
      'R2 reports 12'
    );
  });

  it('retries under a new name after an upload that committed but reported failure', async () => {
    // Attempt 1: the object lands in R2, but the response is lost.
    const written = new Set<string>();
    const lockedUpload: BackupDeps['upload'] = async (_s, key) => {
      if (written.has(key)) throw new Error('object is locked');
      written.add(key);
      if (written.size === 1) throw new Error('socket hang up');
    };
    const first = fakeDeps({ upload: lockedUpload });
    await expect(runDbBackup({ config, runId: 'r', attempt: 1, deps: first.deps })).rejects.toThrow(
      'socket hang up'
    );

    // Trigger retries a minute or more later, so the dump starts at a new second.
    const second = fakeDeps({ upload: lockedUpload, startAt: '2026-11-09T10:18:33.456Z' });
    const info = await runDbBackup({ config, runId: 'r', attempt: 2, deps: second.deps });
    expect(info.key).toBe('2026-11-09T101834Z.dump');
    expect(written.size).toBe(2);
  });
});
