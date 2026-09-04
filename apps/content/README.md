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
| `CONTENT_WORKER_SHARED_SECRET` | secret | bearer token presented to the token endpoint |

Secrets come from Infisical (`/content-worker`, env `sta`) and are pushed by CI
with `wrangler secret bulk` after the deploy. A Worker without them serves 503
for everything, so the deploy workflow fails loudly if either is missing.

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
# 3. Run it (local R2 + local Images emulation):
npm run cf:dev -w apps/content

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

## Deployment

Staging deploys from `.github/workflows/deploy-cloudflare-staging.yml` on pushes
to `staging`, as `classmoji-content-staging`.

Production will deploy from a workflow on pushes to `main`, as
`classmoji-content`. **That workflow is not in the tree yet** — it lands in a
separate PR; until it does, production is deployed by hand with
`npx wrangler deploy --env production`.

The top-level config is named `classmoji-content-unconfigured` on purpose. It
carries no R2 bucket, no Images binding and no vars, and wrangler falls back to
it whenever no `--env` is given — so a bare `npx wrangler deploy` creates a
throwaway Worker nothing routes to, instead of replacing production with a
bindingless build that 503s everything. Every real deploy names its
environment; `cf:dev` and `cf:types` pass `--env staging` for the same reason.
