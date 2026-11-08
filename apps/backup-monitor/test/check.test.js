// node --test apps/backup-monitor/test/*.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assess, dumpKeyFor, newestManifestKey } from '../src/check.js';

const now = new Date('2026-11-10T16:17:00Z');

test('picks the newest manifest, ignoring unfinished dumps and other prefixes', () => {
  const keys = [
    'prod/2026-11-09T101700Z-run_a-a1.manifest.json',
    'prod/2026-11-09T101700Z-run_a-a1.dump',
    'prod/2026-11-10T101700Z-run_b-a1.dump',
    'other/2026-11-11T101700Z-run_c-a1.manifest.json',
  ];
  assert.equal(newestManifestKey(keys), 'prod/2026-11-09T101700Z-run_a-a1.manifest.json');
  assert.equal(newestManifestKey([]), null);
  assert.equal(
    dumpKeyFor('prod/2026-11-09T101700Z-run_a-a1.manifest.json'),
    'prod/2026-11-09T101700Z-run_a-a1.dump'
  );
});

test("today's backup is fine", () => {
  const result = assess({
    manifest: { startedAt: '2026-11-10T10:17:00Z', bytes: 100 },
    dumpBytes: 100,
    now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ageHours, 6);
});

test("alerts when today's backup failed and yesterday's is the newest", () => {
  const result = assess({
    manifest: { startedAt: '2026-11-09T10:17:00Z', bytes: 100 },
    dumpBytes: 100,
    now,
  });
  assert.equal(result.ok, false);
  assert.match(result.problem, /30\.0 hours ago/);
});

test('alerts when there is no backup, no dump, or a size mismatch', () => {
  assert.equal(assess({ manifest: null, dumpBytes: null, now }).ok, false);
  const manifest = { startedAt: '2026-11-10T10:17:00Z', bytes: 100 };
  assert.match(assess({ manifest, dumpBytes: null, now }).problem, /no dump/);
  assert.match(assess({ manifest, dumpBytes: 7, now }).problem, /7 bytes/);
  assert.match(assess({ manifest: { bytes: 1 }, dumpBytes: 1, now }).problem, /startedAt/);
});
