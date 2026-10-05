# Live editing: local test kit

How to try live collaboration in classroom `musashibot-testing` with several
browsers and agent sessions at once. Everything here is for the devport only
(devport 1, database `classmoji_collab_live_editing`). Run all commands from
the worktree root, `~/Sandbox/classmoji/classmoji-collab-live-editing`.

| Service | URL |
| --- | --- |
| Webapp | http://localhost:3010 |
| Pages | http://localhost:7110 |
| Slides | http://localhost:6510 |
| MCP | http://localhost:8110/mcp |
| Collab | http://localhost:7710 (ws://localhost:7710) |

## 1. Start the stack with the Trigger.dev dev key

The checkpoint worker (`content-checkpoint`) runs in `trigger:dev`, and the
collab server needs `TRIGGER_SECRET_KEY` to queue it. The key lives in
`~/.config/classmoji-collab/trigger-dev.env` (`TRIGGER_SECRET_KEY`,
`TRIGGER_PROJECT_ID`, `TRIGGER_DEV_MACHINE`). Never `cat` it.

```bash
CLASSMOJI_ENV_OVERLAY=~/.config/classmoji-collab/trigger-dev.env ENABLE_TEST_LOGIN=true npm run dev
```

`dev.sh` reads the overlay file right after `.env`, so its values win over the
empty ones in `.env`. `ENABLE_TEST_LOGIN=true` turns on the `?as=` sign-in
links below. To keep the stack running after you close the terminal, prefix
with `nohup` and end with `> /tmp/classmoji-dev-collab-live-editing.log 2>&1 &`.

Right after a fresh start (or after clearing Vite caches), the first page load
in each app triggers Vite's dependency optimisation and a reload; a page opened
during that window can show "Cannot read properties of null (reading
'useContext')". Reload once and it's gone.

Check it started: `tail -f /tmp/classmoji-dev-collab-live-editing.log`.
`.dev-context` should list Collab, and the log should show the `trigger`
worker registering `content-checkpoint` on branch
`<TRIGGER_DEV_MACHINE>-collab-live-editing`.

## 2. Seed (already run once; safe to re-run)

```bash
npx dotenv -e .env -- ./scripts/devport.sh run \
  node --experimental-strip-types scripts/collab-dev/seed.ts
```

`devport.sh run` sets the devport database and URLs but does not read `.env`.
`dotenv` supplies the GitHub App credentials. The stack does not need to be
running for this step. The script:

- turns on `collab_enabled` for `musashibot-testing`
- adds three users with accepted memberships: `collab-teacher-1` and
  `collab-teacher-2` (TEACHER) and `collab-assistant` (ASSISTANT)
- creates the content below through the normal page and slide services
  (commits land in `classmoji-development/content-musashibot-testing`)

It prints the URLs at the end. It only writes a document's content while that
document has no `collab_docs` row, so re-running it never overwrites a live
document. Pass `--db-only` to do just the flag and the users.

| Content | URL |
| --- | --- |
| Kitchen sink page (every block type, cover image) | http://localhost:7110/musashibot-testing/cad43539-06ac-4dfa-895b-24c2c8289a85 |
| Plain collab page | http://localhost:7110/musashibot-testing/8a10dc77-2de6-4591-a691-03f25806b189 |
| Kitchen sink deck (17 slides plus a 3-slide vertical stack) | http://localhost:6510/187aee63-dd06-4a3d-8fb1-f27a0fe7e769?mode=edit |
| Plain collab deck (starter deck) | http://localhost:6510/c972c0c5-104a-4e7d-bc5d-fb7c1535be36?mode=edit |

On the kitchen sink page, the paragraph right under the title ("Shared
paragraph: two people type here.") is the shared typing target. On the kitchen
sink deck, slides 2 and 3 (`#/1`, `#/2`) are plain text slides, which makes
them easy to use for lock tests. The deck has `allow_team_edit` on so the
assistant can join it. The plain deck does not, so the assistant can only
watch the refusal there.

## 3. Sign in as several people

Each user needs their own browser profile, another browser, or a private
window. The session cookie is per profile, and one cookie works on every
localhost port.

| User | Role | Sign-in link |
| --- | --- | --- |
| timofei7 | OWNER | your normal GitHub login, or http://localhost:3010/test-login?as=timofei7 |
| collab-teacher-1 | TEACHER | http://localhost:3010/test-login?as=collab-teacher-1 |
| collab-teacher-2 | TEACHER | http://localhost:3010/test-login?as=collab-teacher-2 |
| collab-assistant | ASSISTANT | http://localhost:3010/test-login?as=collab-assistant |

The link signs you in and opens your classroom dashboard. After that, open the
page or deck URLs above. How `?as=` works:

- It is dev only: it returns 404 unless `NODE_ENV=development` and
  `ENABLE_TEST_LOGIN=true`.
- It signs in an existing user, found by GitHub username. It never creates
  one: an unknown name gets a 404.
- No GitHub token is needed, because content writes use the GitHub App
  installation token.
- `&redirect=/some/path` is followed only for same-origin paths (the webapp's
  own paths).

## 4. Agent sessions over MCP

Mint a token for each user an agent should act as. The stack must be running.

```bash
./scripts/devport.sh run node --experimental-strip-types \
  scripts/collab-dev/mint-mcp-token.ts collab-teacher-2 12
```

It prints a token that lasts 12 hours and a ready command:

```bash
claude mcp add --transport http classmoji-collab-teacher-2 http://localhost:8110/mcp \
  --header "Authorization: Bearer dev-…"
```

Run that command in the directory you will start that agent's `claude`
session from. The default scope is local, so it only applies there; use a
separate scratch directory per agent so two agents don't share one user. When
a tool asks for a classroom, pass `classmoji-development/musashibot-testing`.
Pages are drafts, so agent page edits default to live mode: the agent shows up
as `<name> (agent)` in the editors. To clean up afterwards, run
`claude mcp remove classmoji-collab-teacher-2`.

## 5. Watching checkpoints

- **Database**: when `version` and `pushed_version` are equal, the document
  has been pushed.
  ```bash
  psql postgresql://classmoji:classmoji@localhost:5433/classmoji_collab_live_editing \
    -c "select kind, doc_id, epoch, version, pushed_version, left(pushed_commit, 8) as commit, dirty_since from collab_docs order by updated_at desc"
  ```
- **Trigger.dev runs**: in the dashboard, open the project, then the
  Development environment, and pick the branch
  `<TRIGGER_DEV_MACHINE>-collab-live-editing`. Look for the task
  `content-checkpoint`. In dev it waits 10 s after the last edit, and at most
  30 s while edits keep coming. The `trigger:<devport>` lines in the dev log
  show the same runs.
- **Content repo commits**: each checkpoint is one commit named
  `Update <titles> (live editing)`, with a `Co-authored-by` line per editor.
  ```bash
  gh api "repos/classmoji-development/content-musashibot-testing/commits?per_page=10" \
    --jq '.[] | .sha[0:8] + "  " + (.commit.message | split("\n")[0])'
  ```
  On the web: https://github.com/classmoji-development/content-musashibot-testing/commits/main

## 6. Automated acceptance run

Run this with the stack up and the seed done:

```bash
COLLAB_E2E=1 COLLAB_E2E_CHANNEL=chrome npx dotenv -e .env -- ./scripts/devport.sh run \
  npx playwright test -c tests/collab
```

`COLLAB_E2E_CHANNEL=chrome` uses the installed Google Chrome instead of
Playwright's own Chromium download.

It covers four things:

1. The `?as=` refusals.
2. Two teachers type into the shared page paragraph and end up with the same
   text, and each sees the other's avatar.
3. On the deck, teacher 1 edits slide 2, so teacher 2 sees the lock badge and
   cannot type there. Teacher 2 then edits slide 3, and teacher 1 sees the
   change.
4. The `collab_docs` rows settle, the repo HEAD moves, and GitHub's
   `content.json` and `deck.json` contain both teachers' edits.

Without `COLLAB_E2E` every test skips. Each run adds unique markers such as
`[p1-…]` to the kitchen sink documents. That is expected, and it is why the
seed never rewrites a document that has a live row.
