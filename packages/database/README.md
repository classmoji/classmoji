# @classmoji/database

The Prisma schema (`schema.prisma`), its migrations (`migrations/`) and the
shared client (`index.ts`).

## Migrations

Create one by hand or with `npx prisma migrate dev --create-only` (or
`prisma migrate diff ... --script`), then apply it with `npm run db:deploy`.
None of these add the wrapper below, so add it yourself.

**Every new migration runs in one transaction it opens itself:**

```sql
-- What this migration does and why.
BEGIN;

ALTER TABLE ...;
UPDATE ...;

COMMIT;
```

Prisma 6 sends a migration file to Postgres in one go, which runs it as one
implicit transaction. Prisma 7's Migrate splits a file into statements and runs
them one at a time (7.10.1 still sends a file containing a `$$`-quoted body as
one query, but that is not documented and nothing here relies on it). Without
`BEGIN;`/`COMMIT;` a migration that fails halfway then stays half applied (and
every later deploy stops on it), a `CREATE TEMP TABLE ... ON COMMIT DROP` is
gone before the next statement, and `SET LOCAL` does nothing. A `BEGIN;` with
no `COMMIT;` is worse: `migrate deploy` reports success and applies nothing.

An enum value added with `ALTER TYPE ... ADD VALUE` cannot be used in the same
transaction: add it in its own migration and use it in the next one, or
rebuild the enum with its final values, as
`20261026140000_feedback_types_statuses_decisions` does.

A statement Postgres refuses inside a transaction (`CREATE INDEX
CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX ... CONCURRENTLY`,
`VACUUM`) goes alone in its own migration, whose first line says why:

```sql
-- classmoji:no-transaction: the index build must not block writes
CREATE INDEX CONCURRENTLY "things_owner_idx" ON "things" ("owner_id");
```

Do not add `IF NOT EXISTS` there: a concurrent build that fails leaves an
INVALID index behind, and a retry with `IF NOT EXISTS` skips it while Prisma
records the migration as applied.

`npm run db:check-migrations` checks every migration not in
`scripts/exemptMigrations.ts` (the frozen list of the ones that predate the
rule; never add to it), and the three that cannot run statement by statement
(`ALWAYS_WRAPPED` in `scripts/migrationRules.ts`). It needs no install, and
runs on every pull request that touches a migration and before each deploy's
release command migrates. `__tests__/migrationTransactions.test.ts` runs the
same rules.

### When a migration fails on deploy

Prisma marks it failed, and every later `migrate deploy` stops on it until it
is resolved. Run the `prisma` commands from `packages/database`, with
`DATABASE_URL` set to the database the deploy migrated (they act on that
database).

- **A wrapped migration** rolled back as a whole, so nothing of it is left. Its
  error may read only `current transaction is aborted, commands ignored until
  end of transaction block`, with no log in `_prisma_migrations`: Prisma's own
  bookkeeping ran inside the aborted transaction. That includes the
  `RAISE EXCEPTION` guards in the three wrapped migrations. To see the real
  error, run the file against a COPY of the database, never the one the deploy
  migrated: `psql "$COPY_URL" -v ON_ERROR_STOP=1 -f
  migrations/<name>/migration.sql`. If it fails there, the wrapper rolls it
  back; if it succeeds, it commits (which is why it must be a copy: on the real
  database Prisma would still record the migration as failed and run it again).
  Fix the file, then `npx prisma migrate resolve --rolled-back <name>`, then
  deploy again.
- **An opted-out concurrent index** may have left an INVALID index. Drop it
  first, `DROP INDEX CONCURRENTLY IF EXISTS "things_owner_idx";`, then `npx
  prisma migrate resolve --rolled-back <name>`, then deploy again.

### `migrate dev` on an existing local database

Three migrations already applied everywhere (`20260920000000`,
`20260920000003`, `20261002120000`) were later wrapped in `BEGIN;`/`COMMIT;`.
`migrate deploy` (staging, production, `npm run db:deploy`) does not compare
applied files and is unaffected. `migrate dev`, `--create-only` included,
does: on a local or devport database migrated before that change it refuses
("was modified after it was applied", "We need to reset"). Either

- reset it (deletes its data): `npm run db:reset`, or
- record the new checksums (Prisma's checksum is the file's sha256). **Local
  databases only**: never run this on staging or production, which need
  nothing.

  ```sql
  UPDATE _prisma_migrations SET checksum = 'aef9ab84e66add31966abf45c5e1778b2904fd1fe8f87fdc4ce07c3aab42af0b' WHERE migration_name = '20260920000000_coursework_phase1_additive';
  UPDATE _prisma_migrations SET checksum = '0b137eea722c27a89a8a19bcb59b6f038cf823c47b38b74d430b73c534183e5b' WHERE migration_name = '20260920000003_one_score_per_grader';
  UPDATE _prisma_migrations SET checksum = 'c9d2399a76ef6d3fbe8379760dd66dd57701c50aca3183cede6777db747ed5b2' WHERE migration_name = '20261002120000_quiz_assignments';
  ```
