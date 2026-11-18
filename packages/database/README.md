# @classmoji/database

The Prisma schema (`schema.prisma`), its migrations (`migrations/`), the
shared client (`index.ts`) and the factory every other Node client is built
with (`pgClient.ts`, exported as `@classmoji/database/pg-client`).

## Prisma 7

- **Generated clients.** `schema.prisma` has two `prisma-client` generators,
  both writing TypeScript into `generated/` (gitignored). `npm run db:generate`
  always writes both. `db:ensure` (`scripts/ensureGenerated.ts`) writes them
  only when they are missing or `generated/.stamp` no longer matches
  `schema.prisma` and the installed Prisma, and otherwise touches nothing, so
  watching dev servers do not restart; turbo runs it before typecheck, tests,
  builds, dev servers and `trigger:deploy`, and `npm run dev` before it starts
  anything.
  - `client` → `generated/node`, the Node client. Everything imports it as
    `@classmoji/database/client` (the client, `Prisma`, model types, enums),
    never `@prisma/client`, which a lint rule refuses (`@prisma/client` is
    now only the client's runtime, a dependency of this package). In browser
    bundles the same specifier resolves to `generated/node/browser.ts` (the
    `browser` export condition): enums and types, no server code. Its imports
    end in `.ts` (`importFileExtension`) so `node --experimental-strip-types`
    loads it as it is. Like any ESM build of Prisma's Node client, it sets
    `globalThis.__dirname` when it loads.
  - `workerClient` → `generated/worker`, for Cloudflare Workers:
    `classmojiWorkerSwaps` (@classmoji/workers/vite) puts it in place of
    `@classmoji/database/client`. That is why `index.ts` and `pgClient.ts`
    import the client by that specifier, never by a relative path.

  Docker images and the deploy workflows (before `trigger deploy`) generate
  only `client` (`--generator client`).
- **CLI.** `prisma.config.ts` names the schema, the migrations, the seed and the
  URL (`DATABASE_URL`). Prisma finds it in the current directory only, so run
  `npx prisma …` here, or pass `--config packages/database/prisma.config.ts`
  from elsewhere. The CLI no longer reads `.env`; the root `npm run db:*`
  scripts load it.
- **Clients.** The client talks to Postgres through `@prisma/adapter-pg`
  (node-postgres). `pgClient.ts` turns the URL's Prisma parameters into pool
  options (see the table at its top):
  - `connection_limit`: the pool size (default 10).
  - `connect_timeout`: how long opening a connection may take (default 5 s).
  - `pool_timeout`: how long a query waits for a free pooled connection
    (default 10 s). The two are separate waits; `0` turns off only its own.
    pg-pool also bounds a NEW connection by the pool wait, so a connect gives
    up after the shorter of the two (with `connect_timeout=0`, after
    `pool_timeout`, unless that is 0 too).
  - `schema`: model queries use it (`public` is the default and changes
    nothing); raw SQL keeps the session's search path.
  - `sslmode`, `channel_binding`: see TLS below.

  A repeated parameter takes its last value. Build a client with
  `getPrisma()` or `createPgPrismaClient(url, options)`, never
  `new PrismaClient()`.
- **TLS (self-hosters, read this).** `sslmode=require` (and `prefer`, `allow`,
  `verify-ca`) VERIFIES the server's certificate chain and host name, as
  `verify-full` does. A provider whose certificate is signed by a private CA
  needs `sslrootcert=<file>` in the URL, or `sslmode=no-verify` to skip
  verification. With no `sslmode`, `ssl=` decides: `0`, `false` or empty is
  off, `1` or `true` verified TLS, `no-verify` TLS without verification, and
  any other value is refused at boot. A URL with no `sslmode`, no `ssl=` and
  no certificate files (`sslrootcert` and the like) connects WITHOUT TLS.
  `channel_binding=require` needs TLS and is refused without it.
- **The direct endpoint.** Behind a connection pooler (Neon's `-pooler` host,
  PgBouncer), set `DATABASE_URL_UNPOOLED` to the direct endpoint too. The
  clients that hold a session use it: collab's instance lock, the docs-index
  run lock, and the read-only session of the operator scripts (the Cloudinary
  dry run, `packages/tasks/src/scripts/`; not a Trigger task). The read-only
  session REQUIRES it and never falls back to `DATABASE_URL`, locally too; the
  docs-index lock falls back only to a direct `DATABASE_URL` and refuses a
  pooled one; collab rewrites a Neon `-pooler` host to the direct one and
  refuses only `pgbouncer=true`.
- **Time zone.** Raw `timestamptz` values are read correctly only in a UTC
  session (Neon's default; `__tests__/clientApi.integration.test.ts` shows
  the shift in a New York session). Model `DateTime` values Prisma reads and
  writes are not affected (Prisma fills `@default(now())` itself on a model
  create), but the database's own default (`DEFAULT CURRENT_TIMESTAMP` on
  these `timestamp(3)` columns), which applies to a raw INSERT that leaves the
  column out, is stored in the session's local time, so in a non-UTC session
  it is shifted too.
- **Schema description in tests.** The generated client has no `Prisma.dmmf`
  (`prisma-client-js`'s kept only field names and types).
  `testing/schemaDmmf.ts` reads the full description from
  `schema.prisma` with `@prisma/prisma-schema-wasm`, whose version ends in the
  engines hash of the installed Prisma: bump it with Prisma
  (`__tests__/schemaDmmf.test.ts` fails until you do). It is a dev dependency
  that no runtime code imports, but the Docker images install every
  dependency and the webapp's final image copies `node_modules`, so its 3.2 MB
  ships in that image (not in any bundle, the Trigger worker or the Workers
  build).

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

Prisma 6 sent a migration file to Postgres in one go, which ran it as one
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
