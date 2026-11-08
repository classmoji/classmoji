// node --test apps/backup-monitor/test/*.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assess, newestBackup, startedAtOf } from '../src/check.js';

const now = new Date('2026-11-10T16:17:00Z');
const MB = 1024 * 1024;

test('picks the newest backup, ignoring anything else in the bucket', () => {
  const objects = [
    { key: '2026-11-09T101703Z.dump', size: 33 * MB },
    { key: '2026-11-10T101702Z.dump', size: 34 * MB },
    { key: 'prod/2026-11-12T101700Z-run_d-a1.dump', size: 34 * MB },
    { key: 'test/2026-11-12T101700Z.dump', size: 34 * MB },
    { key: 'notes.txt', size: 5 },
  ];
  assert.equal(newestBackup(objects).key, '2026-11-10T101702Z.dump');
  assert.equal(newestBackup([]), null);
});

test('reads the start time from the name', () => {
  assert.equal(startedAtOf('2026-11-10T101702Z.dump').toISOString(), '2026-11-10T10:17:02.000Z');
  assert.equal(startedAtOf('notes.txt'), null);
});

test("today's backup is fine", () => {
  const result = assess({ backup: { key: '2026-11-10T101700Z.dump', size: 33 * MB }, now });
  assert.equal(result.ok, true);
  assert.equal(result.ageHours, 6);
});

test("alerts when today's backup failed and yesterday's is the newest", () => {
  const result = assess({ backup: { key: '2026-11-09T101700Z.dump', size: 33 * MB }, now });
  assert.equal(result.ok, false);
  assert.match(result.problem, /30\.0 hours ago/);
});

test('alerts when there is no backup or it is suspiciously small', () => {
  assert.match(assess({ backup: null, now }).problem, /No database backup/);
  assert.match(
    assess({ backup: { key: '2026-11-10T101700Z.dump', size: 1000 }, now }).problem,
    /only 1000 bytes/
  );
});
