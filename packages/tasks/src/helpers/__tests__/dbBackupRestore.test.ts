/**
 * The restore side of the database backups: only finished dumps (with a
 * manifest) are offered, newest last, and a restore target must be a local
 * database unless the operator explicitly says otherwise.
 */

import { describe, expect, it } from 'vitest';

import { checkRestoreTarget, finishedBackups } from '../dbBackupRestore.ts';

describe('finishedBackups', () => {
  it('keeps only dumps with a manifest, oldest first', () => {
    const keys = [
      'prod/2026-11-10T101700Z-run_b-a1.manifest.json',
      'prod/2026-11-10T101700Z-run_b-a1.dump',
      // attempt 1 of run_c never finished: no manifest
      'prod/2026-11-11T101700Z-run_c-a1.dump',
      'prod/2026-11-11T101900Z-run_c-a2.dump',
      'prod/2026-11-11T101900Z-run_c-a2.manifest.json',
      'prod/2026-11-09T101700Z-run_a-a1.dump',
      'prod/2026-11-09T101700Z-run_a-a1.manifest.json',
      // a manifest whose dump is gone is not a backup either
      'prod/2026-11-08T101700Z-run_z-a1.manifest.json',
      'elsewhere/2026-11-12T101700Z-run_x-a1.manifest.json',
      'elsewhere/2026-11-12T101700Z-run_x-a1.dump',
    ];
    expect(finishedBackups(keys).map(b => b.dumpKey)).toEqual([
      'prod/2026-11-09T101700Z-run_a-a1.dump',
      'prod/2026-11-10T101700Z-run_b-a1.dump',
      'prod/2026-11-11T101900Z-run_c-a2.dump',
    ]);
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
