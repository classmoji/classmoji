# Database backups

An independent copy of the production database in Cloudflare R2, for the day
Neon is not there to restore from (a deleted project or account, an outage),
and for mistakes found after Neon's own restore window. For everyday mistakes
(a bad migration, a deleted row this week) use Neon's point-in-time restore
first: it is faster and loses nothing.

| What            | Where                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backup task     | `db-backup`, Trigger.dev **production** only, daily at **10:17 UTC** (`packages/tasks/src/workflows/dbBackup.ts`, logic in `src/helpers/dbBackup.ts`)  |
| Bucket          | `classmoji-db-backups-prod` (Cloudflare account "Classmoji", ENAM)                                                                                     |
| Retention       | each dump deleted after **90 days**; nothing can delete one younger than **7 days** (bucket lock); unfinished uploads aborted after 1 day              |
| Freshness check | Worker `classmoji-backup-monitor` (`apps/backup-monitor`), daily at **16:17 UTC**, emails if the newest finished backup started more than 26 hours ago |
| Restore         | `packages/tasks/src/scripts/restoreBackup.ts`                                                                                                          |

Each run writes `prod/<UTC start>-<run id>-a<attempt>.dump` (`pg_dump
--format=custom`, read back with `pg_restore --list` before upload), then
`….manifest.json` beside it (size, SHA-256, pg_dump and server versions, start
time). **A dump without a manifest did not finish**; the monitor and the
restore script ignore it. Dumps are not encrypted (decided): the bucket token
is the protection, so keep it scoped to this bucket.

What a dump does NOT contain: git repositories (Github/Gitlab), media in R2,
Trigger.dev state, Postgres roles. Restoring it brings back the database only.

## One-time setup

1. **Read-only role.** In the Neon SQL editor on the production branch, as the
   database owner (create it by SQL, not in the console: console roles get
   `neon_superuser`):

   ```sql
   CREATE ROLE db_backup WITH LOGIN PASSWORD '<long random password>';
   GRANT CONNECT ON DATABASE neondb TO db_backup;  -- the production database's name
   GRANT pg_read_all_data TO db_backup;
   ```

   Its connection string must be the **direct** endpoint (host without
   `-pooler`), with `?sslmode=require`.

2. **R2 token.** Cloudflare dashboard → R2 → Manage API tokens → Create
   Account API token: permission **Object Read & Write**, applied to
   **`classmoji-db-backups-prod` only**. Keep the Access Key ID and Secret
   Access Key.

3. **Infisical, `prod` environment:**

   | Name                             | Value                                  |
   | -------------------------------- | -------------------------------------- |
   | `DB_BACKUP_DATABASE_URL`         | the `db_backup` direct URL from step 1 |
   | `DB_BACKUP_R2_ACCOUNT_ID`        | `a653a8f645101f2c08cceb8f644be6d9`     |
   | `DB_BACKUP_R2_ACCESS_KEY_ID`     | from step 2                            |
   | `DB_BACKUP_R2_SECRET_ACCESS_KEY` | from step 2                            |
   | `DB_BACKUP_R2_BUCKET`            | `classmoji-db-backups-prod`            |

   They reach the worker on the next Trigger.dev production deploy.

4. **Monitor secrets** (the Worker is deployed; it cannot email without them):

   ```bash
   npx wrangler login
   npx wrangler secret put RESEND_API_KEY --config apps/backup-monitor/wrangler.jsonc
   npx wrangler secret put ALERT_EMAIL --config apps/backup-monitor/wrangler.jsonc   # comma-separated
   ```

5. **Trigger.dev alert** (optional, faster than the monitor): dashboard →
   project → Alerts → New alert → email on **task run failure** in Production.
   A failed attempt that is then retried successfully also emails; the
   monitor emails only when no backup finished.

6. **First run.** After the deploy, Trigger.dev dashboard → Production →
   `db-backup` → Test (any payload). Check the run log (bytes, seconds), that
   the dump and manifest are in the bucket, and that it fits: **every
   Trigger.dev machine has 10 GB of disk**, so a dump nearing ~5 GB needs a
   streamed upload instead. Then set `maxDuration` (now 3600 s) to a few
   times the measured time. Then do a test restore (below).

## Restoring

Needs the four `DB_BACKUP_R2_*` variables in the environment and `pg_restore`
/ `psql` **16 or newer** (`brew install libpq` and add its `bin` to PATH, or
set `PG_RESTORE_PATH` / `PSQL_PATH`).

```bash
# what is there (finished backups only, oldest first)
npx tsx packages/tasks/src/scripts/restoreBackup.ts --list

# restore the newest (or --key prod/…dump) into a NEW, EMPTY local database
createdb -h localhost -p <port> restore_test     # port: see .dev-context
npx tsx packages/tasks/src/scripts/restoreBackup.ts --target postgresql://<user>:<pass>@localhost:<port>/restore_test

# or only download and verify it
npx tsx packages/tasks/src/scripts/restoreBackup.ts --download ./backup
```

Every download is checked against its manifest's size and SHA-256. The
restore runs `pg_restore --no-owner --no-privileges --exit-on-error
--single-transaction`: it completes or leaves the target empty. The script
refuses a target that has tables, and any non-local host unless
`--allow-remote`.

- **Never restore over production.** Restore into a scratch database and copy
  back the affected rows. Rolling production back throws away every valid
  change made since the dump.
- **Disaster (Neon is gone):** create a new Neon project (Postgres 16, with
  the `vector` extension available), restore into its empty database with
  `--allow-remote`, run `npm run db:deploy` against it to apply any migration
  newer than the dump, then point `DATABASE_URL` / `DATABASE_URL_UNPOOLED` at
  it in Infisical and redeploy.
- **Deleted data:** a restored copy can hold students who have since asked to
  be deleted. Re-apply those deletions before anyone uses the copy, and delete
  scratch databases and downloaded dumps when done.

**Test restore:** do one after setup, and again after major schema changes:
restore into an empty local database and compare a few counts (`users`,
`_prisma_migrations`, the newest `created_at` in a busy table) with
production.

## Changing things

- **Postgres upgrade on Neon:** bump `POSTGRES_CLIENT_MAJOR` in
  `packages/tasks/trigger.config.js` in the same change. pg_dump refuses a
  server newer than itself, so a Neon upgrade without it fails every backup
  (the monitor will email).
- **Retention:** the bucket's lifecycle rule, not code. The lock (7 days) must
  stay shorter than the lifecycle rule.
- **Schedule:** `cron` in `dbBackup.ts`; move the monitor's cron in
  `apps/backup-monitor/wrangler.jsonc` with it (it checks 6 hours later,
  against a 26-hour limit in `src/check.js`).
- **Monitor code:** test with `node --test apps/backup-monitor/test/*.test.js`,
  deploy with `npx wrangler deploy --config apps/backup-monitor/wrangler.jsonc`.
