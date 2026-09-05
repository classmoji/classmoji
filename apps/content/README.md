# @classmoji/content-worker

The content delivery layer: a Cloudflare Worker that serves signed classroom
content from R2, backfilling from GitHub on a miss.

It is deliberately dumb. It has no business rules, no sessions, and no knowledge
of a classroom beyond the id in the URL. Everything it is willing to serve is
decided by a signature the webapp minted.

```
browser ──signed URL──▶ Worker ──hit──▶ R2
                          │
                          └──miss──▶ token endpoint (webapp) ──▶ GitHub ──▶ R2 + browser
```

## Routes

```
GET /c/{classroomId}/blob/{sha}.{ext}?p=&v=&exp=&sig=[&w=&fmt=]
GET /c/{classroomId}/theme/{theme}/{treeSha}/{p}.{v}.{exp}.{sig}/{relPath}
GET /healthz
OPTIONS *
```

`p` is the tier (`public` | `enrolled` | `draft`), `v` the key version, `exp` a
unix-seconds expiry, `sig` the base64url HMAC. `w` (800 | 1600 | 2560) and `fmt`
(webp | avif | auto) request an image variant and are part of the signed string,
so they cannot be swapped.

**The request host is signed too** — lowercased, port included, immediately
after the scheme in the canonical string:

```
cm1|blob|{host}|{classroomId}|{sha}|{ext}|{p}|{v}|{exp}|{w or ''}|{fmt or ''}
cm1|theme|{host}|{classroomId}|{theme}|{treeSha}|{p}|{v}|{exp}
```

so a URL minted for one delivery origin cannot be replayed against another.
Blob query params are allowlisted to exactly `p, v, exp, sig, w, fmt` — any
other key, or any repeated key, is malformed. Theme URLs must carry no query
string at all, and a theme path segment that is empty, `.`, `..`, or still
percent-encoded after one decode is refused.

`/c/` is the canonical-scheme marker (`cm1`) and the only content prefix — there
is no separate version field. Anything else is a 404. An unsigned, tampered, or
long-expired URL is a 403 with `Cache-Control: no-store` — a refusal is never
cached.

## Behaviour worth knowing

- **Bytes stream.** A miss is piped to the browser while a tee'd copy goes to R2
  under `ctx.waitUntil`. Only image transforms and tree listings materialize.
- **R2 keys are content-addressed.** `blobs/{sha}`, variants at
  `blobs/{sha}/w{width}.{format}`, tree listings at `trees/{treeSha}.json`. No
  classroom appears in a key: two classrooms referencing the same blob share one
  object, and access is decided by the signature rather than the key.
- **`fmt=auto` negotiates on `Accept`** — avif when the browser offers it, else
  webp — and the *stored* variant is keyed by the concrete format, so no viewer
  is ever handed a format it cannot decode.
- **A failed transform is not a failure.** If the Images binding throws
  (unsupported source, quota), the original bytes are served with the original
  content type — on a short `public, max-age=60`, so a passing quota blip does
  not pin a full-size original at the edge for a month under a URL that asked
  for a thumbnail. Only raster sources (png, jpg, jpeg, webp, avif, gif) are
  ever sent to a transform.
- **EXIF:** transformed variants are webp or avif, and both discard all
  metadata unconditionally, so GPS never survives a transform. Untransformed
  originals stream through verbatim, EXIF included — this is a pass-through
  cache, and the place to strip metadata is upload. The Images *binding*
  exposes no `metadata` option to change that; it exists only on the `cf.image`
  fetch API.
- **Draft content is `no-store`,** everything else `public, max-age=…, immutable`
  for as long as its signature lives. A just-expired signature is still honoured
  inside its tier's grace window (6h for public/enrolled, 5m for draft).
- **Every response** carries CORS (`*`, `GET, HEAD, OPTIONS`, exposing
  `Content-Type, Content-Length, ETag`), `X-Content-Type-Options: nosniff`, and
  `Content-Security-Policy: default-src 'none'; sandbox`. A `Set-Cookie` can
  never leave this Worker. The CSP matters because production serves from
  `content.classmoji.io`, inside the app's `.classmoji.io` session-cookie
  domain: without `sandbox`, an SVG carrying inline script and opened as a
  top-level navigation would execute there. Subresource use (`<img>`, `<link>`,
  fonts) is unaffected.
- **Content responses carry `Vary: Accept`,** because `fmt=auto` negotiates
  avif vs webp from that header and the answer is cached immutable for up to 30
  days — otherwise the first Chrome visitor pins AVIF bytes for every Safari
  visitor after them.
- **A truncated tree listing is used but never stored.** `trees/{treeSha}.json`
  is content-addressed and treated as immutable, so caching a partial listing
  would 404 the omitted files forever, for every classroom sharing that sha.
- **It fails closed.** Missing secrets produce a 503 at request time rather than
  a crash at load, and `/healthz` keeps answering so a bad deploy is visible.
- **GitHub 401 →** the cached installation token is dropped and the fetch is
  retried exactly once with a fresh one.

## Bindings, vars, secrets

| Name | Kind | Notes |
| --- | --- | --- |
| `CACHE` | R2 bucket | `classmoji-content-cache-stg` / `-prod` |
| `IMAGES` | Images binding | width/format variants |
| `CONTENT_TOKEN_ENDPOINT` | var | webapp endpoint that mints installation tokens |
| `ENVIRONMENT` | var | `staging` / `production` |
| `CONTENT_SIGNING_SECRET` | secret | HMAC master key for signed URLs |
| `CONTENT_SIGNING_SECRET_PREVIOUS` | secret, optional | the key the current one replaced; accepted for verification during a rotation, never signed with |
| `CONTENT_WORKER_SHARED_SECRET` | secret | bearer token presented to the token endpoint |

Secrets come from Infisical (`/content-worker`, env `sta` for staging and `prod`
for production) and are pushed by CI with `wrangler secret bulk` after the
deploy. A Worker without the two required ones serves 503 for everything, so the
deploy workflow fails loudly if either is missing; the previous-key slot is
allowed but never required, and `/healthz` deliberately says nothing about
whether it is set.

## Signing

Signatures are verified by `@classmoji/content-signing` — the same package the
apps mint with, so a URL is checked by exactly the code that produced it.
`src/verify.ts` is the one importer, a single `export * from` line; every other
module goes through that seam rather than reaching for the package directly.
wrangler bundles the workspace package's TypeScript source (its `exports` points
at `src/index.ts`), so there is no build step to keep in sync.

All times crossing this boundary are **unix seconds**, and `cacheControlFor`
takes `now` explicitly — call sites pass `nowSeconds()`. Past `exp` (inside the
tier's grace window) it returns a short `public, max-age=60` rather than pinning
a stale response immutable or sending every cache back at once with `max-age=0`.

Test fixtures mint through the package's own `signBlobUrl` / `signThemeBase`.
The two cases those cannot express — a pinned expiry (grace and expiry tests)
and a forged host (replay tests) — build the canonical string with the package's
`blobCanonicalString` / `themeCanonicalString` and sign it with a key from its
`deriveKey`, so even those fixtures cannot drift from the contract.

## Working on it

```sh
npm run typecheck -w apps/content
npm run lint -w apps/content
npm run test -w apps/content          # vitest, node env, fake bindings — no miniflare
```

### Manual smoke with `wrangler dev`

```sh
# 1. Validate the config and bundle without touching Cloudflare:
npx wrangler deploy --env staging --dry-run --outdir /tmp/content-dryrun

# 2. Put local secrets in apps/content/.dev.vars (git-ignored):
#      CONTENT_SIGNING_SECRET="..."
#      CONTENT_WORKER_SHARED_SECRET="..."
#      CONTENT_SIGNING_SECRET_PREVIOUS="..."   # optional, only to rehearse a rotation
# 3. Run it (local R2 + local Images emulation), on the local `dev` env:
npm run cf:dev:local -w apps/content
#    `cf:dev` runs `--env staging`, whose CONTENT_TOKEN_ENDPOINT is
#    staging.classmoji.io — fine for a bindings-only smoke, wrong the moment
#    you want the Worker to fetch a blob. Use `cf:dev:local` for that.

# 4. Health:
curl -s localhost:8787/healthz
# 5. Refusals (no signature, unknown path):
curl -si "localhost:8787/c/$CLASSROOM/blob/$SHA.png" | head -3   # 403
curl -si localhost:8787/robots.txt | head -3                     # 404
# 6. A real fetch needs a signed URL and a CONTENT_TOKEN_ENDPOINT that can mint
#    a token for that classroom. See tests/helpers.ts for the exact recipe.
```

**The host is part of the signature, so a `wrangler dev` on `localhost:8787`
only verifies URLs minted for `http://localhost:8787`.** A URL copied from
staging will always 403 here, and that is correct, not a bug. The apps point
their minting at the local Worker with `CONTENT_DELIVERY_ORIGIN`; set it to
`http://localhost:8787` for a local smoke, and remember the port is signed too
— `:8788` will not verify against a `:8787` signature.

### Local end-to-end

Running the whole pipeline — editor upload, signed render, Worker fetch — on
one machine. This is what `npm run e2e:content` drives; the Playwright pack is
in `apps/pages/tests/content-pipeline.spec.ts` and
`apps/slides/tests/content-pipeline.spec.ts`.

Three things have to agree, and all three are easy to get subtly wrong:

1. **The same signing secret in both places.** The apps sign; the Worker
   verifies. A mismatch is indistinguishable from tampering — every image 403s
   with `bad-signature` and nothing says why.
2. **The origin the apps sign for is the origin the Worker answers on**, host
   *and* port, because the host is inside the canonical string.
3. **The Worker's token endpoint points at the LOCAL webapp**, not staging.

#### 1. Generate a throwaway pair

Never reuse the staging or production secret locally; a local signature must
not verify anywhere real.

```sh
openssl rand -base64 32   # -> CONTENT_SIGNING_SECRET
openssl rand -base64 32   # -> CONTENT_WORKER_SHARED_SECRET
```

#### 2. Repo root `.env` (git-ignored) — what the apps sign with

```sh
CONTENT_SIGNING_SECRET="<the first value>"
CONTENT_WORKER_SHARED_SECRET="<the second value>"
CONTENT_DELIVERY_ORIGIN="http://localhost:8787"
```

`CONTENT_DELIVERY_ORIGIN` has no trailing slash and names the port. Both of
the first two must be set or `isContentDeliveryConfigured()` is false and every
app renders legacy refs — the same outcome as the feature being off, which is
why a "nothing is signed" local run is nearly always a missing env var rather
than a bug.

#### 3. `apps/content/.dev.vars` (git-ignored) — what the Worker verifies with

```sh
CONTENT_SIGNING_SECRET="<the SAME first value>"
CONTENT_WORKER_SHARED_SECRET="<the SAME second value>"
# Only if the webapp is on a devport rather than 3000:
# CONTENT_TOKEN_ENDPOINT="http://localhost:3050/api/content/token"
```

Leave `CONTENT_SIGNING_SECRET_PREVIOUS` out unless you are rehearsing a
rotation. Then:

```sh
npm run cf:dev:local -w apps/content
curl -s localhost:8787/healthz    # {"ok":true,"environment":"development","configured":true}
```

`configured: false` there means the Worker never read `.dev.vars` — check you
put it in `apps/content/`, not the repo root.

#### 4. Turn the flag on for one classroom

`content_delivery_enabled` defaults to false, per classroom, and the env check
above is separate from it. Both have to be true. Locally, flip it directly:

The pack's default local classroom is `classmoji-dev-winter-2025` — the one
`npm run db:seed` creates — so that is the slug to flip unless you set
`E2E_CLASSROOM_SLUG` to something else:

```sh
# .dev-context has the database this checkout is actually using.
psql "$DATABASE_URL" -c \
  "update classrooms set content_delivery_enabled = true where slug = 'classmoji-dev-winter-2025';"
```

(`cs98-test` is the STAGING classroom; flipping that name locally updates zero
rows and looks exactly like the feature not working.)

Every write in the pack — the flag, the cache bump, the uploads and the repo
deletes — is refused unless `DATABASE_URL` resolves to a host on localhost.
`E2E_ALLOW_REMOTE_DB_I_KNOW_WHAT_I_AM_DOING=1` lifts that for a non-local host,
and does not lift it for anything that looks managed or production.

In the UI it lives at **Settings → Content** for the classroom
(`/admin/:class/settings/content`), alongside **Reset content cache** — the
button that increments `content_key_version` and so changes every signed URL
the classroom hands out.

To watch the gate work, set it back to `false` and reload: every `<img>` goes
back to a legacy `raw.githubusercontent.com` / `/content/{org}/{repo}/…` ref
and nothing is requested from `localhost:8787` at all.

#### 5. What the classroom actually has to be

Three things beyond the flag, each of which fails in its own confusing way:

- **A content repo that exists on GitHub, in an org with the App installed.**
  `npm run db:seed` gives the dev classroom the synthetic org `dev-org` and the
  repo `content-classmoji-dev-winter-2025`, and neither exists. An upload then
  fails at the GitHub API and tells you nothing about delivery. Point the
  classroom at a real one (`git_org_id` + `content_repo`, with the org's
  `github_installation_id` set) before expecting an upload to work.
- **Pages or decks with real `content_path`s.** The delivery layer resolves
  references; a classroom with no content has nothing to resolve, and every
  assertion about it is vacuously true.
- **`SITE_BASE_DOMAIN`, if you want the `public` tier.** The class-site host
  rewriter is a no-op without it, and `public` is only ever minted for the
  class-site surface — so with it unset there is no way to see that tier at all.
  Start the pages app with e.g. `SITE_BASE_DOMAIN=classmoji.io` and address the
  site with a `Host:` header; there is no local DNS for it. The site also has to
  be *enabled* and have a home page — a claimed-but-disabled site 404s.

Then:

```sh
E2E_CD_CONTENT_REPO=1 npm run e2e:content
```

`E2E_CD_CONTENT_REPO=1` is your assertion that the classroom's repo is real and
writable; without it the upload scenarios skip rather than fail. Two caches sit
between a write and what you see, and the pack waits both out rather than
sleeping: GitHub's contents API is eventually consistent after a write, and the
page loader passes `skipCache: canEdit`, so staff read fresh while a student or
an anonymous site visitor gets a 60-second cache.

## Operating

### R2 layout, and purging one blob

Keys are content-addressed, so a blob and its variants live together:

```
blobs/{sha}                 # the original bytes, exactly as GitHub stores them
blobs/{sha}/w{width}.{fmt}  # a transformed variant: w800.webp, w1600.avif, ...
trees/{treeSha}.json        # a theme's flattened tree listing
```

Purging one blob means purging its variants too — they are separate objects and
nothing cascades:

```sh
BUCKET=classmoji-content-cache-stg   # -prod in production
SHA=0123456789abcdef0123456789abcdef01234567

npx wrangler r2 object delete "$BUCKET/blobs/$SHA" --remote
for W in 800 1600 2560; do
  for FMT in webp avif; do
    npx wrangler r2 object delete "$BUCKET/blobs/$SHA/w$W.$FMT" --remote || true
  done
done
```

The delete is safe in the sense that matters: the next request for that sha
refetches it from GitHub and writes it back. It is *not* scoped to a classroom —
one object serves every classroom referencing that sha, which is the point of a
content-addressed key.

### "Reset content cache" busts the edge, not R2

The per-classroom button in the app bumps the classroom's key version, so every
URL it mints from then on carries a new `v` and a new signature. That retires
the old URLs at the edge (and in browsers) — it does **not** touch R2. The bytes
under `blobs/{sha}` stay exactly where they were, which is correct: they are
addressed by content, so a stale one is a contradiction. Reach for
`wrangler r2 object delete` only when an object in R2 is genuinely wrong.

### Logs

Workers Logs, in the Cloudflare dashboard: **Workers & Pages → the Worker →
Logs** (`classmoji-content-staging` or `classmoji-content`), with
`observability.enabled` set in `wrangler.jsonc` for both. `npx wrangler tail
--env staging` gives the same stream in a terminal. The lines worth searching:

| Shape | Means |
| --- | --- |
| `[content] 403 {reason} classroom=… path=… p=… v=…` | refused: `bad-signature`, `expired`, `malformed`, `unsupported-version`. Never carries `sig` or a query string |
| `[content] key=previous classroom=… path=… p=… v=…` | served, but the signature only verified against `CONTENT_SIGNING_SECRET_PREVIOUS`. Expected during a rotation. Logged once per classroom and key version per isolate, so it counts classrooms, not requests |
| `[content] 404 missing classroom=… path=…` | the app minted a `/missing/` URL: a reference that resolves to no blob (deleted, renamed, or a directory). Not an attack — a content bug |
| `[content] origin blob {sha}: {status}` | GitHub refused the blob; the client got a 502 |
| `[content] origin error: …` / `[content] unhandled error: …` | 502 / 500 |
| `[content] image transform failed (w=…, fmt=…)` | Images could not do it; the original was served on `max-age=60` |
| `[content] skipping transform for {sha}: …ceiling` | source past `MAX_TRANSFORM_SOURCE_BYTES`; the original was streamed instead |
| `[content] refusing to cache truncated tree {sha}` | the listing was used but not stored |
| `[content] failed to cache {key}` | the R2 write-back failed; the client was still served |

A burst of `403 bad-signature` on one classroom usually means a stale page in
someone's browser, not an attacker: signatures expire, and the grace window is
6h (5m for draft). A burst of `404 missing` means content references drifted
from the repo — look at the resolver, not the Worker.

A `\uFFFD` in a logged path is this Worker defusing the path, not a corrupt
file: the repo path in a `/missing/` URL arrives from the network, so every
control character in it is replaced and the whole path is capped at 512
characters. Otherwise a `%0A` would let an unauthenticated request write its
own `[content] 403 …` line into the stream you are searching.

### Rotating the signing secret

The apps sign with one key; the Worker verifies against two. That gap is the
whole trick: it lets a key change without invalidating every URL already sitting
in a browser, a `<link>` tag, or an edge cache.

1. **Set both keys in Infisical**, project `e9a6487c-350e-41e7-8bba-2d95ca5934a6`,
   environment `prod`. The `/content-worker` folder holds *references* to the
   root-level secrets the Fly apps read, so there is one value per key and not
   two copies to keep in step — but a brand-new key needs the reference created
   the first time round:

   - root `CONTENT_SIGNING_SECRET_PREVIOUS` ← the current value of `CONTENT_SIGNING_SECRET`
   - root `CONTENT_SIGNING_SECRET` ← a fresh `openssl rand -hex 32`
   - `/content-worker` ← a reference for `CONTENT_SIGNING_SECRET_PREVIOUS` alongside
     the two that are already there

   Do these as one edit. Between writing the new current key and writing the
   previous one there is no fallback, and anything the apps mint in that gap
   verifies against nothing.

2. **The Fly apps pick it up on their own.** Infisical's native sync pushes the
   new value to them; from that moment they sign with the new key. They never
   read `CONTENT_SIGNING_SECRET_PREVIOUS` — signing has exactly one key, always
   the current one.

3. **The Worker gets both on its next deploy.** The secret sync is a step of
   `deploy-cloudflare-prod.yml`, so it runs when something under `apps/content/**`
   or `packages/content-signing/**` lands on `main` — or immediately, on a
   `workflow_dispatch` run of that workflow, which is how you push a secret
   change with no code change behind it.

   That workflow deploys first and pushes secrets second (`wrangler secret bulk`
   needs a script to attach to), so for a few seconds a freshly deployed version
   is still reading the old values. During a rotation that window is harmless
   precisely because of the previous-key slot: the Worker is verifying with a
   key it already accepts either way.

4. **Wait out the longest signature still in the wild** — 30 days, the public
   tier's bucket, plus its 6h grace. `enrolled` is 7 days and `draft` is 4
   hours, so the public tier is the one that sets the clock. Watch for the line
   that says the old key is still carrying traffic:

   ```
   [content] key=previous classroom=… path=… p=… v=…
   ```

   That line is logged once per classroom and key version per isolate, not once
   per request — a warn on every request for a month would bury the 403 and 404
   lines. Which means its disappearance is a *weaker* signal than it looks:
   isolates recycle, so a fresh one logs the same classroom again, and a quiet
   hour may just be a quiet hour.

   Read it as a count instead. Query Workers Logs for `key=previous` over a
   fixed window (a day, say) and watch the number of distinct classrooms fall.
   Zero across a busy window, held for a few days, is what "drained" looks
   like; a single silent hour is not.

   Cut it short only if you are rotating **because the old key leaked**, and go
   in knowing what it costs: every URL minted under it — the ones already in
   pages people have open, in browser caches, and linked from anywhere the
   class site has been shared — starts answering 403 the moment the slot
   clears. Assets come back as soon as a page re-renders and re-signs, so the
   damage is broken images and stylesheets until then, not lost content.

5. **Clear the previous key — in two places.** Removing it from Infisical is
   not enough: `wrangler secret bulk` only writes the keys it is handed and
   never deletes, so a secret dropped from the export simply stops being
   updated and keeps its last value on the Worker forever.

   ```sh
   # Infisical: delete root CONTENT_SIGNING_SECRET_PREVIOUS and its
   # /content-worker reference, then:
   npx wrangler secret delete CONTENT_SIGNING_SECRET_PREVIOUS --env production
   ```

   `/healthz` will not confirm this for you — it says nothing about the
   previous-key slot on purpose, because it is unauthenticated. Check with
   `npx wrangler secret list --env production`.

## Deployment

Staging deploys from `.github/workflows/deploy-cloudflare-staging.yml` on pushes
to `staging`, as `classmoji-content-staging`.

Production deploys from `.github/workflows/deploy-cloudflare-prod.yml` on
pushes to `main`, as `classmoji-content`. It is the same job as staging's with
two things that are not a rename: the branch is `main`, and the Infisical
environment slug is `prod` where staging's is `sta`. `workflow_dispatch` runs it
by hand — which is also how you push a secret change without a code change,
since the secret sync only runs as part of a deploy. Dispatch it **against
`main`**: the job is guarded on that ref, so a dispatch from any other branch
does nothing rather than shipping that branch to `content.classmoji.io`.

A push to `main` that touches `packages/content-signing/**` starts the Fly
workflows too, and nothing orders them against this one. So for one deploy the
apps and the Worker may be running different versions of the signing package: a
change to a canonical string has to verify what the previous version minted.

The top-level config is named `classmoji-content-unconfigured` on purpose. It
carries no R2 bucket, no Images binding and no vars, and wrangler falls back to
it whenever no `--env` is given — so a bare `npx wrangler deploy` creates a
throwaway Worker nothing routes to, instead of replacing production with a
bindingless build that 503s everything. Every real deploy names its
environment; `cf:dev` and `cf:types` pass `--env staging` for the same reason.

### First production deploy

Once, in this order:

1. **R2 read on the Cloudflare API token** — already done. The token in
   `CLOUDFLARE_API_TOKEN` needs Workers Scripts edit *and* R2 read, or the
   deploy fails validating the `CACHE` binding rather than at request time.

   The bucket itself already exists too: `classmoji-content-cache-prod` and
   `classmoji-content-cache-stg` were both created on 2026-09-03. Nothing to do
   here — but a fresh account would need it before the first deploy, because
   wrangler binds an existing bucket and never creates one:

   ```sh
   npx wrangler r2 bucket create classmoji-content-cache-prod
   ```
2. **Push to `main`.** The workflow deploys `classmoji-content` and then pushes
   `CONTENT_SIGNING_SECRET` and `CONTENT_WORKER_SHARED_SECRET` from Infisical
   `prod`. Both must already exist under `/content-worker` there — the job
   fails loudly rather than shipping a Worker that 503s everything.
3. **Check it is configured.**

   ```sh
   curl -s https://content.classmoji.io/healthz
   # {"ok":true,"environment":"production","configured":true}
   ```

   `configured:false` means the secret step did not land; re-run the workflow
   with `workflow_dispatch` rather than redeploying by hand.
4. **The custom domain and its certificate are wrangler's job.** The
   `production` env declares `content.classmoji.io` as a `custom_domain`, so
   wrangler creates the hostname and orders an Advanced Certificate for it on
   the first deploy. Nothing to click, and nothing to add in the dashboard.

   **Universal SSL stays OFF on the `classmoji.io` zone.** It is disabled on
   purpose — it fights Fly's renewal of the `*.classmoji.io` wildcard — and the
   Advanced Certificate above is what covers this hostname. Turning Universal
   SSL back on to "fix" a certificate here breaks the apps instead.
5. **Then the per-classroom gate.** A deployed Worker serves nobody by itself.
   The apps mint signed URLs only where `isContentDeliveryConfigured`
   (`contentDelivery.service.ts`) is satisfied *and* the classroom is switched
   on: `Classroom.content_delivery_enabled`, which staff toggle in the admin app
   under `/content-delivery`.

   That toggle is the rollout. Turn on one classroom, watch its logs, and widen
   from there — it is the last step, never the first.
