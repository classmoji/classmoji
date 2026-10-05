# classmoji-collab

Hocuspocus 4.7 server for live collaborative editing of pages and decks
(`@classmoji/collab-server`). Browsers connect over WebSocket; the apps, MCP
and hook-station call its internal HTTP API (`src/internal.ts`); a debounced
Trigger.dev task (`content-checkpoint`) pushes the buffered documents to git.

## Run it

- Dev: `npm run dev` starts it (`collab:dev`, `NODE_ENV=development`) on
  `COLLAB_PORT` (7700 + devport id × 10). Alone: `npm run collab:dev`.
- Prod: `npm run collab:start` (`NODE_ENV=production`); the image runs the
  same command with node as PID 1. Required settings: see "Deploy" below.
- `GET /health` is public (always 200 while serving, with `db: ok|down`);
  `GET /health/db` answers 503 when the database does not. Settings and
  defaults: `src/config.ts`.
- Manual epoch reset (drop a doc's live room, reseed from git):
  `POST /internal/:kind/:id/reset { actor, discard? }` with the internal
  secret; unpushed edits refuse it (409) unless `discard: true`.

## ONE INSTANCE ONLY

Run exactly one collab process per environment (Fly: one machine, no
autoscaling, no rolling deploy that overlaps two machines). Everything that
makes a room consistent lives in this process's memory:

- the live Y.Doc of every open room (there is no Redis extension, so two
  instances would each hold their own copy of a room and overwrite each
  other's stores in `collab_docs`);
- the editors since the last push (co-author trailers), agent presence and
  the merged "Save version" payloads.

Enforced at runtime: before `listen()` the process takes a Postgres session
advisory lock on a dedicated connection to the DIRECT host (Neon's
`-pooler` host stripped, as the webapp's migrations do). A second process
retries for 20 s, then exits 1 with `FATAL: another collab server holds the
instance lock` — a second machine crash-loops visibly. The holder re-checks
every 30 s and exits if another process took the lock.

A restart is safe — `stopOnSignals` flushes pending stores on SIGTERM
(raise the platform's kill timeout to cover it) and clients reconnect — but
editors recorded before the restart get no co-author trailer.

## Broadcasts are unbatched (`flushDelay: false`)

Hocuspocus 4.7 batches broadcasts per event-loop turn by default. Collab
turns that off so a server-side correction (the deck lock arbiter reverting
a losing lock claim) goes out in the same tick as the change it answers.
The cost: one WebSocket message per connection per change instead of one
per turn — `changes × connections` messages. Fine for classroom-sized rooms
(a handful of editors); if a room ever has hundreds of active writers,
revisit (e.g. batch only non-deck rooms).

## Close codes and refusal reasons

Constants in `@classmoji/collab`: 4403 (`COLLAB_CLOSE_FORBIDDEN`) when the
60-s re-check finds access gone; 4409 (`COLLAB_CLOSE_RELOAD`, reason `reload`
or `stale-epoch`) when the room closed or moved. Refusals at connect:
`stale-epoch`, `schema-mismatch`, `forbidden`, `legacy-html`, `unavailable`.

## Deploy (Fly.io)

`apps/collab/Dockerfile` + `apps/collab/fly.toml`, deployed by
`.github/workflows/deploy-fly-{prod,staging,dev}.yml` (apps
`classmoji-collab`, `classmoji-collab-staging`, `classmoji-collab-dev`; each
job skips with a notice until its Fly app exists. An app that exists with no
machines yet counts as existing: CI's first deploy creates its one machine,
with the secrets already staged on it). Staging and dev deploy the
production config as-is, with no scale-to-zero wrapper, and
`scripts/fly-staging-autostop.sh` deliberately leaves collab out.

- One machine. A new Fly app's first deploy creates two by default; every
  CI collab deploy passes `--ha=false` so it creates one. Deploying by hand,
  pass `--ha=false` too, or `fly scale count 1 --app <app>` right after.
  Keep the `rolling` strategy (on one machine it stops the old process
  before starting the new); never bluegreen or canary.
- `kill_timeout = 30s` so the SIGTERM flush of pending stores completes.
- `auto_stop_machines = 'off'`, `min_machines_running = 1`, connection
  limits raised to 1000/2000 (Fly's default hard limit is 25 connections).
- Fly's proxy drops a socket after 60 s without traffic; every client's
  awareness heartbeat (about every 15 s) keeps editors' sockets busy, and
  providers reconnect on their own.
- `GET /health` is the Fly check.
- Hostnames: browsers authenticate with the better-auth session cookie, so
  the WebSocket host must be under that environment's cookie domain.
  Production is `collab.classmoji.io` (cookie domain `.classmoji.io`);
  staging is `collab.staging.classmoji.io`, under staging's cookie domain
  `.staging.classmoji.io` (a `collab-staging.classmoji.io` host would never
  receive the staging cookie). Each has a Fly certificate and a DNS record
  (grey-cloud, like the other apps). `collab` is in `RESERVED_SUBDOMAINS`
  (`packages/utils/src/subdomains.ts`), so no class site can claim it.

### Fly secrets (per app)

The collab apps' secrets come from Infisical: `classmoji-collab-staging`
from the `sta` environment, `classmoji-collab` from `prod`. Staging's
`COOKIE_PREFIX` is `classmoji-staging` (the webapp's staging prefix), which
is what lets collab read the staging session cookie.

| Secret | Why |
|---|---|
| `DATABASE_URL` | `collab_docs`, memberships, sessions |
| `BETTER_AUTH_SECRET`, `COOKIE_PREFIX` (staging: `classmoji-staging`), `COOKIE_DOMAIN` (only if set elsewhere) | read the browser's session cookie exactly as the webapp does |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_BASE64` | installation token to read content at a sha (outside-push merges, reseeds) |
| `WEBAPP_URL`, `PAGES_URL`, `SLIDES_URL` | origin allowlist (plus `COLLAB_ALLOWED_ORIGINS`) |
| `TRIGGER_SECRET_KEY` | triggers `content-checkpoint`; startup refuses without it |
| `COLLAB_INTERNAL_SECRET` | the `x-collab-secret` it accepts; startup refuses without it (or with the dev value) |
| `COLLAB_CHECKPOINT_DELAY`, `COLLAB_CHECKPOINT_MAX_DELAY` | optional, default `1m` / `4m` |

`COLLAB_PORT` and `NODE_ENV` are set in `fly.toml`. Collab also imports
`@classmoji/services`; give it the same service secrets the pages app has
(GitHub/R2/content signing) so any path it shares with pages behaves the
same.

### Before the first deploy: Infisical and Trigger.dev

Add to Infisical **prod**, **sta** (and **dev** if the dev apps are used):

- `COLLAB_INTERNAL_SECRET` — one value per environment
  (`openssl rand -base64 32`), shared by collab, the webapp, pages, slides,
  MCP and the Trigger.dev worker.
- `COLLAB_URL` — collab's PUBLIC `https://` base (e.g.
  `https://collab.classmoji.io`). Not a `.internal`/`.flycast` address:
  the Trigger.dev worker runs outside Fly and calls it too.
- `COLLAB_WS_URL` — `wss://` on the same host (pages and slides hand it to
  browsers; defaults to `COLLAB_URL` with the ws scheme).
- Optional: `COLLAB_ALLOWED_ORIGINS`, `COLLAB_CHECKPOINT_DELAY`,
  `COLLAB_CHECKPOINT_MAX_DELAY` (keep collab's and the worker's equal: the
  sweeper counts a trigger lost after 2 × the max delay).

Then make sure each consumer actually receives them: the Fly apps
(collab, webapp, pages, slides, MCP; the Infisical free plan caps native
syncs at 10, so check headroom or `fly secrets set`), and Trigger.dev —
the worker pulls every Infisical secret at deploy (`syncEnvVars` in
`packages/tasks/trigger.config.js`), so it needs `COLLAB_URL` and
`COLLAB_INTERNAL_SECRET` in Infisical and a redeploy of the tasks.
Without them `content-checkpoint` cannot report results, `collab-external`
cannot reach collab, and the sweeper cannot check whether a doc is live.

**Trigger.dev plan:** `collab-sweeper` runs every 30 minutes, so a
checkpoint whose trigger was lost is re-run up to about 40 minutes after the
doc went dirty, and a doc stuck unsaved is alerted after 1 to 1.5 hours
(an outside edit collab has not merged: after 15 minutes). The alert is the
sweeper RUN FAILING with the stuck docs in its error, so point a Trigger.dev
run-failure alert at `collab-sweeper`. Collab itself also re-sends a
checkpoint trigger that went missing (a debounced run Trigger.dev left in
DELAYED) within about 40 s for Save version / last leave and about 6 minutes
for routine edits. On a free
Trigger.dev plan a cron more frequent than hourly is rejected when the
schedule is deployed (all environments, including Development); it needs a
paid plan.

Monitoring: add an uptime monitor on `https://<collab host>/health/db` (Better
Stack, alongside the other five services).
