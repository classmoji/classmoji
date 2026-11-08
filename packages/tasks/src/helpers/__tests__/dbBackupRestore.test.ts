/**
 * The restore side of the database backups: only backup names are offered, oldest first, each verified
 * against the checksum stored with it, and a restore target must be a local
 * database unless the operator explicitly says otherwise.
 */

import { describe, expect, it, vi } from 'vitest';

import { checkRestoreTarget, listBackups, readBackupInfo } from '../dbBackupRestore.ts';
import type { MediaStore } from '../r2Objects.ts';

describe('listBackups', () => {
  it('keeps only backup names at the bucket root, oldest first', () => {
    const keys = [
      '2026-11-10T101700Z.dump',
      '2026-11-09T101700Z.dump',
      '2026-11-11T101903Z.dump',
      // other files in the bucket are never backups
      'prod/2026-11-12T101700Z-run_x-a1.dump',
      'test/2026-11-12T101700Z.dump',
      'notes.txt',
    ];
    expect(listBackups(keys)).toEqual([
      '2026-11-09T101700Z.dump',
      '2026-11-10T101700Z.dump',
      '2026-11-11T101903Z.dump',
    ]);
  });
});

describe('readBackupInfo', () => {
  const sha = 'a'.repeat(64);
  const storeAnswering = (head: unknown) =>
    ({ bucket: 'b', client: { send: vi.fn(async () => head) } }) as unknown as MediaStore;

  it('reads the size and checksum stored with the backup', async () => {
    const store = storeAnswering({
      ContentLength: 33_926_481,
      Metadata: { sha256: sha, 'started-at': '2026-11-09T10:17:03.000Z' },
    });
    await expect(readBackupInfo(store, '2026-11-09T101703Z.dump')).resolves.toEqual({
      key: '2026-11-09T101703Z.dump',
      bytes: 33_926_481,
      sha256: sha,
      startedAt: '2026-11-09T10:17:03.000Z',
    });
  });

  it('refuses a dump it cannot verify', async () => {
    await expect(
      readBackupInfo(storeAnswering({ ContentLength: 10, Metadata: {} }), 'x.dump')
    ).rejects.toThrow('no size or SHA-256');
    await expect(
      readBackupInfo(storeAnswering({ ContentLength: 10, Metadata: { sha256: 'nope' } }), 'x.dump')
    ).rejects.toThrow('no size or SHA-256');
  });
});

describe('checkRestoreTarget', () => {
  it('accepts a local database', () => {
    expect(checkRestoreTarget('postgresql://u:p@localhost:5432/restore_test', false)).toEqual({
      ok: true,
      host: 'localhost',
      database: 'restore_test',
    });
  });

  it('refuses a remote database unless told it is a new one', () => {
    const neon = 'postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb';
    const refused = checkRestoreTarget(neon, false);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain('--allow-remote');
    expect(checkRestoreTarget(neon, true).ok).toBe(true);
  });

  it('refuses anything that is not a postgres URL naming a database', () => {
    expect(checkRestoreTarget('not a url', false).ok).toBe(false);
    expect(checkRestoreTarget('mysql://localhost/db', false).ok).toBe(false);
    expect(checkRestoreTarget('postgresql://localhost:5432/', false).ok).toBe(false);
  });
});
