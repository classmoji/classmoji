import { logger, schedules } from '@trigger.dev/sdk';

import { defaultDeps, readBackupConfig, runDbBackup } from '../helpers/dbBackup.ts';

/**
 * Daily off-site backup of the production database to R2
 * (`classmoji-db-backups-prod`, kept 90 days). How it works and why:
 * `helpers/dbBackup.ts`. Restoring: `packages/database/scripts/restoreBackup.ts`.
 *
 * 10:17 UTC is 5–6am Eastern and 2–3am Pacific: after every US midnight
 * deadline (and the webhooks that record late pushes), before the morning, and
 * clear of the 03:15–06:15 UTC daily jobs and the :00/:30/:35 recurring ones.
 *
 * Production only, twice over: the schedule exists only in PRODUCTION, and a
 * run started any other way (the dashboard's Test button, a dev worker) does
 * nothing, so no other environment's database is ever dumped into the
 * production bucket.
 */
export const dbBackupTask = schedules.task({
  id: 'db-backup',
  cron: { pattern: '17 10 * * *', environments: ['PRODUCTION'] },
  // Unlike the other daily jobs, waiting for tomorrow is not an acceptable
  // retry. Each attempt writes under its own key (see backupKey).
  retry: { maxAttempts: 3, minTimeoutInMs: 60_000, maxTimeoutInMs: 300_000, factor: 2 },
  queue: { concurrencyLimit: 1 },
  // A full production dump took 34 s (34 MB) in Nov 2026; this leaves room
  // for a much bigger database and a slow upload.
  maxDuration: 900,
  run: async (_payload, { ctx, signal }) => {
    if (ctx.environment.type !== 'PRODUCTION') {
      logger.warn('db-backup runs only in production; skipping', {
        environment: ctx.environment.type,
      });
      return { skipped: true as const };
    }

    const config = readBackupConfig();
    const backup = await runDbBackup({
      config,
      runId: ctx.run.id,
      attempt: ctx.attempt.number,
      signal,
      deps: defaultDeps(config),
    });
    logger.info('db-backup uploaded', {
      key: backup.key,
      bytes: backup.bytes,
      sha256: backup.sha256,
      serverVersion: backup.serverVersion,
      pgDumpVersion: backup.pgDumpVersion,
      seconds: (Date.parse(backup.finishedAt) - Date.parse(backup.startedAt)) / 1000,
    });
    return { skipped: false as const, key: backup.key, bytes: backup.bytes };
  },
});
