/**
 * Is the newest finished database backup recent enough? Pure, so it is tested
 * without R2 (`node --test apps/backup-monitor/test/*.test.js`).
 *
 * A backup counts only when its manifest exists AND its dump is in the bucket
 * at the manifest's size: a dump without a manifest is an attempt that did not
 * finish (see packages/tasks/src/helpers/dbBackup.ts).
 */

/** Same as BACKUP_KEY_PATTERN in packages/tasks/src/helpers/dbBackup.ts: backups live at the bucket root. */
export const BACKUP_KEY_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{6}Z-[A-Za-z0-9_-]+-a\d+\.(?:dump|manifest\.json)$/;

/**
 * Hours since the newest backup's dump STARTED before it counts as stale.
 * The backup runs at 10:17 UTC and this check at 16:17 UTC: on a good day the
 * newest is ~6h old, and when today's run failed, yesterday's is ~30h old.
 */
export const MAX_AGE_HOURS = 26;

/** The newest manifest key under the prefix, or null. Keys sort by UTC stamp. */
export function newestManifestKey(keys) {
  const manifests = keys
    .filter(k => BACKUP_KEY_PATTERN.test(k) && k.endsWith('.manifest.json'))
    .sort();
  return manifests.length ? manifests[manifests.length - 1] : null;
}

export function dumpKeyFor(manifestKey) {
  return manifestKey.slice(0, -'.manifest.json'.length) + '.dump';
}

/**
 * @param {{ manifest: { startedAt?: string, bytes?: number } | null, dumpBytes: number | null, now: Date }} input
 * @returns {{ ok: true, ageHours: number } | { ok: false, problem: string }}
 */
export function assess({ manifest, dumpBytes, now }) {
  if (!manifest) return { ok: false, problem: 'No finished database backup exists in the bucket.' };
  const started = Date.parse(manifest.startedAt ?? '');
  if (!Number.isFinite(started)) {
    return { ok: false, problem: 'The newest backup manifest has no readable startedAt.' };
  }
  if (dumpBytes === null) {
    return { ok: false, problem: 'The newest backup manifest has no dump beside it.' };
  }
  if (dumpBytes !== manifest.bytes) {
    return {
      ok: false,
      problem: `The newest dump is ${dumpBytes} bytes but its manifest says ${manifest.bytes}.`,
    };
  }
  const ageHours = (now.getTime() - started) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS) {
    return {
      ok: false,
      problem: `The newest database backup started ${ageHours.toFixed(1)} hours ago (limit ${MAX_AGE_HOURS}).`,
    };
  }
  return { ok: true, ageHours };
}
