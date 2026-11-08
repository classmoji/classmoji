/**
 * The daily database backup. What matters:
 *
 *  - nothing is uploaded unless pg_dump exited 0, the file is big enough and
 *    `pg_restore --list` reads it back (a locked bucket keeps a bad upload for
 *    7 days);
 *  - the manifest, the success marker, is written only after the dump is in
 *    the bucket at the right size;
 *  - every attempt gets its own key, so a retry never hits a locked object;
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
  backupKey,
  manifestKeyFor,
  readBackupConfig,
  redact,
  runDbBackup,
  stampOf,
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
}

function fakeDeps(options: FakeOptions = {}) {
  const { dumpBytes = 64, dumpResult = ok(), listResult = ok('toc') } = options;
  const calls: string[] = [];
  let dir = '';
  const run = vi.fn(async (command: string, args: string[]) => {
    if (args[0] === '--version') return ok('pg_dump (PostgreSQL) 16.15');
    if (command === 'psql') return ok('16.9\n');
    if (command === 'pg_dump') {
      const file = args.find(a => a.startsWith('--file='))!.slice('--file='.length);
      await writeFile(file, Buffer.alloc(dumpBytes, 1));
      calls.push('dump');
      return dumpResult;
    }
    if (command === 'pg_restore') {
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
  const putManifest = vi.fn(async (_s: MediaStore, key: string, _m: unknown) => {
    calls.push(`manifest ${key}`);
  });
  let tick = Date.parse('2026-11-09T10:17:03.456Z');
  const deps: BackupDeps = {
    run: run as unknown as BackupDeps['run'],
    store: { client: {} as MediaStore['client'], bucket: config.bucket },
    upload: upload as unknown as BackupDeps['upload'],
    head: vi.fn(async () => ('storedBytes' in options ? options.storedBytes! : dumpBytes)),
    hash: vi.fn(async () => 'abc123'),
    putManifest,
    now: () => new Date((tick += 1000)),
    tempDir: async () => (dir = await mkdtemp(join(tmpdir(), 'db-backup-test-'))),
  };
  return { deps, calls, run, upload, putManifest, dir: () => dir };
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
    });
    expect(c.minBytes).toBe(5);
    expect(c.pgDumpPath).toBe('/usr/lib/postgresql/16/bin/pg_dump');
    expect(c.pgRestorePath).toBe('pg_restore');
  });
});

describe('keys', () => {
  const at = new Date('2026-11-09T10:17:03.456Z');

  it('is sortable and colon-free', () => {
    expect(stampOf(at)).toBe('2026-11-09T101703Z');
    expect(backupKey(at, 'run_abc', 1)).toBe('prod/2026-11-09T101703Z-run_abc-a1.dump');
  });

  it('differs for every attempt of the same run', () => {
    expect(backupKey(at, 'run_abc', 1)).not.toBe(backupKey(at, 'run_abc', 2));
  });

  it('cannot be steered out of the prefix', () => {
    expect(backupKey(at, '../../etc/x', 1)).toBe('prod/2026-11-09T101703Z-etcx-a1.dump');
    expect(() => backupKey(at, '///', 1)).toThrow('empty run id');
    expect(() => backupKey(at, 'run', 0)).toThrow('bad attempt');
  });

  it('puts the manifest beside its dump', () => {
    expect(manifestKeyFor('prod/x-a1.dump')).toBe('prod/x-a1.manifest.json');
    expect(() => manifestKeyFor('prod/x')).toThrow('not a dump key');
  });
});

describe('redact', () => {
  it('removes the connection string and any password-bearing URL', () => {
    expect(redact(`connection to ${URL} failed`, URL)).toBe('connection to <database-url> failed');
    expect(redact('postgres://u:p4ss@h/db', URL)).toBe('postgres://u:***@h/db');
  });
});

describe('runDbBackup', () => {
  it('dumps, checks, uploads, then writes the manifest last', async () => {
    const f = fakeDeps();
    const manifest = await runDbBackup({ config, runId: 'run_1', attempt: 2, deps: f.deps });

    expect(f.calls).toEqual([
      'dump',
      'list',
      'upload prod/2026-11-09T101704Z-run_1-a2.dump',
      'manifest prod/2026-11-09T101704Z-run_1-a2.manifest.json',
    ]);
    expect(manifest).toMatchObject({
      version: 1,
      key: 'prod/2026-11-09T101704Z-run_1-a2.dump',
      bytes: 64,
      sha256: 'abc123',
      startedAt: '2026-11-09T10:17:04.456Z',
      pgDumpVersion: 'pg_dump (PostgreSQL) 16.15',
      serverVersion: '16.9',
      runId: 'run_1',
      attempt: 2,
    });
    expect(f.putManifest.mock.calls[0][2]).toEqual(manifest);
    expect(existsSync(f.dir())).toBe(false);
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
    expect(f.putManifest).not.toHaveBeenCalled();
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

  it('writes no manifest when the upload fails', async () => {
    const f = fakeDeps({
      upload: async () => {
        throw new Error('network down');
      },
    });
    await expect(runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps })).rejects.toThrow(
      'network down'
    );
    expect(f.putManifest).not.toHaveBeenCalled();
    expect(existsSync(f.dir())).toBe(false);
  });

  it('writes no manifest when R2 holds a different size', async () => {
    const f = fakeDeps({ storedBytes: 12 });
    await expect(runDbBackup({ config, runId: 'r', attempt: 1, deps: f.deps })).rejects.toThrow(
      'R2 reports 12'
    );
    expect(f.putManifest).not.toHaveBeenCalled();
  });

  it('retries under a new key after an upload that committed but reported failure', async () => {
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

    const second = fakeDeps({ upload: lockedUpload });
    const manifest = await runDbBackup({ config, runId: 'r', attempt: 2, deps: second.deps });
    expect(manifest.key).toMatch(/-a2\.dump$/);
    expect(written.size).toBe(2);
  });
});
