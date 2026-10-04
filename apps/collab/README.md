# classmoji-collab

Hocuspocus 4.7 server for live collaborative editing of pages and decks
(`@classmoji/collab-server`). Browsers connect over WebSocket; the apps, MCP
and hook-station call its internal HTTP API (`src/internal.ts`); a debounced
Trigger.dev task (`content-checkpoint`) pushes the buffered documents to git.

## Run it

- Dev: `npm run dev` starts it (`collab:dev`, `NODE_ENV=development`) on
  `COLLAB_PORT` (7700 + devport id × 10). Alone: `npm run collab:dev`.
- Prod: `npm run collab:start` (`NODE_ENV=production`). Requires
  `COLLAB_INTERNAL_SECRET` (never the development value), `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `WEBAPP_URL` / `PAGES_URL` / `SLIDES_URL` (the
  origin allowlist, plus `COLLAB_ALLOWED_ORIGINS`) and `TRIGGER_SECRET_KEY`.
- `GET /health` is public. Settings and defaults: `src/config.ts`.

## ONE INSTANCE ONLY

Run exactly one collab process per environment (Fly: one machine, no
autoscaling, no rolling deploy that overlaps two machines). Everything that
makes a room consistent lives in this process's memory:

- the live Y.Doc of every open room (there is no Redis extension, so two
  instances would each hold their own copy of a room and overwrite each
  other's stores in `collab_docs`);
- the editors since the last push (co-author trailers), agent presence and
  the merged "Save version" payloads.

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
