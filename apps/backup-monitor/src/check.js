/**
 * Is the newest database backup recent enough? Pure, so it is tested without
 * R2 (`node --test apps/backup-monitor/test/*.test.js`).
 *
 * A backup is one object at the bucket root named for the UTC second its dump
 * started, e.g. `2026-11-09T101703Z.dump` (packages/tasks/src/helpers/dbBackup.ts).
 * R2 uploads are atomic, so every such object is a whole backup.
 */

/** Same as BACKUP_KEY_PATTERN in packages/tasks/src/helpers/dbBackup.ts. */
export const BACKUP_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z\.dump$/;

/**
 * Hours since the newest backup's dump STARTED before it counts as stale.
 * The backup runs at 10:17 UTC and this check at 16:17 UTC: on a good day the
 * newest is ~6h old, and when today's run failed, yesterday's is ~30h old.
 */
export const MAX_AGE_HOURS = 26;

/** Below this a dump is not a real production backup (the first was 33 MB). */
export const MIN_BYTES = 10 * 1024 * 1024;

/** The newest backup among listed objects ({ key, size }), or null. Names sort by time. */
export function newestBackup(objects) {
  const backups = objects.filter(o => BACKUP_KEY_PATTERN.test(o.key));
  backups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return backups.length ? backups[backups.length - 1] : null;
}

/** `2026-11-09T101703Z.dump` → that instant. */
export function startedAtOf(key) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/.exec(key);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null;
}

/**
 * @param {{ backup: { key: string, size: number } | null, now: Date }} input
 * @returns {{ ok: true, ageHours: number, key: string } | { ok: false, problem: string }}
 */
export function assess({ backup, now }) {
  if (!backup) return { ok: false, problem: 'No database backup exists in the bucket.' };
  const started = startedAtOf(backup.key);
  if (!started || Number.isNaN(started.getTime())) {
    return { ok: false, problem: `The newest backup has an unreadable name: ${backup.key}.` };
  }
  if (backup.size < MIN_BYTES) {
    return {
      ok: false,
      problem: `The newest backup (${backup.key}) is only ${backup.size} bytes.`,
    };
  }
  const ageHours = (now.getTime() - started.getTime()) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS) {
    return {
      ok: false,
      problem: `The newest database backup started ${ageHours.toFixed(1)} hours ago (limit ${MAX_AGE_HOURS}).`,
    };
  }
  return { ok: true, ageHours, key: backup.key };
}
