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
  content type. Only raster sources (png, jpg, jpeg, webp, avif, gif) are ever
  sent to a transform.
- **Draft content is `no-store`,** everything else `public, max-age=…, immutable`
  for as long as its signature lives. A just-expired signature is still honoured
  inside its tier's grace window (6h for public/enrolled, 5m for draft).
- **Every response** carries CORS (`*`, `GET, HEAD, OPTIONS`, exposing
  `Content-Type, Content-Length, ETag`) and `X-Content-Type-Options: nosniff`.
  A `Set-Cookie` can never leave this Worker.
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

## Deployment

Staging deploys from `.github/workflows/deploy-cloudflare-staging.yml` on pushes
to `staging`. **Production is defined in `wrangler.jsonc` but has no workflow**:
deploying `classmoji-content` is a deliberate, manual act.
