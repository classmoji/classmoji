# @classmoji/content-signing

Cryptographic core of the content delivery layer. Mints and verifies signed asset
URLs.

Runs on **both** sides: the Node apps (webapp, pages, slides) mint, a Cloudflare
Worker verifies. Web Crypto only (`globalThis.crypto.subtle`), zero runtime
dependencies, no `node:crypto`. Typechecked under both the DOM lib and
`@cloudflare/workers-types` (`npm run typecheck` runs both).

## Keys

```
key = HMAC-SHA256(MASTER_SECRET, classroomId + '|' + keyVersion)
```

The Worker holds only the master; per-classroom keys are derived on demand and
memoized (bounded LRU, 256 entries). `keyVersion` is `Classroom.content_key_version`
(default `0`). Bumping it changes every URL for that classroom — a cache bust, not
a revocation: URLs signed under the old version keep verifying until they expire.

## Tiers

A tier is named for its window because that is all it decides. It is **not**
access control — the signature is; a tier only sets how long an already-minted
URL lives and whether a cache may keep it.

| Tier    | Expiry                        | Grace on verify | Cache-Control                          |
| ------- | ----------------------------- | --------------- | -------------------------------------- |
| `month` | end of the current 30d bucket | 6h              | `public, max-age={exp-now}, immutable` |
| `week`  | end of the current 7d bucket  | 6h              | `public, max-age={exp-now}, immutable` |
| `edit`  | exact `now + 4h`              | 5m              | `no-store`                             |

The caller picks the tier; this package only validates that `p` is one of the
three. In the apps that choice follows the content's visibility — `edit` for a
viewer who can edit, `month` for content that is public, `week` otherwise — so
the same file rendered on two different surfaces mints the same URL.

**Renamed 2026-09-05.** These were `public`, `enrolled` and `draft`, names that
read like permissions they never were. `p` is a field of the canonical string,
so every URL minted before that date now fails `bad-signature`. Nothing is in
production; only staging ever held one.

Bucket boundaries are staggered per classroom so the fleet does not cold-fill in
unison:

```
offset = fnv1a32(classroomId) mod bucketSeconds
end    = offset + (floor((now - offset) / bucketSeconds) + 1) * bucketSeconds
exp    = end - now < 3600 ? end + bucketSeconds : end
```

Every mint inside one bucket produces a byte-identical URL. The one-hour floor
keeps a URL minted just before rollover from expiring immediately and sending
every viewer back at once; grace keeps the outgoing bucket's URLs serving
meanwhile.

Grace covers a page rendered just before rollover and still sitting in a cache;
for `edit` it covers clock skew only. An expired-beyond-grace signature fails
with `expired`. Nothing validates that `exp` is not further in the future than the
tier could have produced. Past `exp` but inside grace, `cacheControlFor` returns
`public, max-age=60` rather than an immutable zero TTL.

## URL shapes

Blob — images and any single file:

```
{origin}/c/{classroomId}/blob/{sha}.{ext}?p={tier}&v={keyVersion}&exp={unix}&sig={b64url}
                                          [&w={800|1600|2560}][&fmt={webp|avif|auto}]
```

The query is an exact allowlist: `p, v, exp, sig, w, fmt`, each at most once.
Any other key, or any repeat, is `malformed` — everything in the query is signed,
so anything else is by definition unsigned.

Theme folder — a directory served path-addressed so relative CSS `url()` keeps
working. The signature lives in the path, so relative resolution inherits it:

```
{origin}/c/{classroomId}/theme/{theme}/{treeSha}/{p}.{v}.{exp}.{sig}/{relPath}
```

A theme URL carries **no** query string at all; any query is `malformed`.

The theme signature covers everything up to and including the policy segment, not
`relPath`: authorizing the folder authorizes every file under it. `relPath` is
decoded exactly once and must have no empty, `.`, or `..` segment, no separator
(`/`, `\`) or control character, and nothing still percent-encoded after that one
decode — so a second decode downstream cannot resurrect `../` out of
`%252e%252e%252f`. The cost is that a file whose real name contains a percent
escape (`report%2Bdraft.png`) is refused rather than served.

The leading `/c/` segment is the URL-scheme marker for canonical version `cm1`.
A future canonical version gets a new segment (`/c2/`, …); an unrecognized one
fails with `unsupported-version` rather than `malformed`.

## Canonical signing strings

`sig` is HMAC-SHA256 over the string, with the derived key, base64url, unpadded.

```
cm1|blob|{host}|{classroomId}|{sha}|{ext}|{p}|{v}|{exp}|{w or ''}|{fmt or ''}
cm1|theme|{host}|{classroomId}|{theme}|{treeSha}|{p}|{v}|{exp}
```

`host` is the lowercased `URL.host`, **port included**, so a URL minted for one
host cannot be replayed against another. The **scheme is deliberately not
covered**: `http://cdn.example` and `https://cdn.example` share a signature.
`cdn.example` and `cdn.example:8443` do not.

Rejected at parse time: anything where `classroomId` is not a lowercase UUID,
`sha`/`treeSha` not 40-hex, `ext` not <= 8 lowercase alphanumerics, `theme` not
`[a-z0-9][a-z0-9._-]*` (no leading dot, so never a dotfile directory), `p` not a
known tier, `v`/`exp` not non-negative safe integers, `w` not one of the three
widths, or `fmt` not one of the three formats.

Signature comparison runs inside `crypto.subtle.verify` — never string equality.

## Usage

Minting (Node app):

```ts
import { signBlobUrl, signSrcSet, signThemeBase } from '@classmoji/content-signing';

const ctx = { master: env.CONTENT_MASTER_SECRET, classroomId, keyVersion, tier: 'week' };

const url = await signBlobUrl(origin, ctx, { sha, ext: 'png' });
const { src, srcset } = await signSrcSet(origin, ctx, { sha, ext: 'png', sourceWidth: 1600 });
const base = await signThemeBase(origin, ctx, { theme: 'cosmo-dark', treeSha });
const css = `${base}theme.css`;
```

Verifying (Worker):

```ts
import { cacheControlFor, verifyContentUrl } from '@classmoji/content-signing';

const result = await verifyContentUrl(env.CONTENT_MASTER_SECRET, request.url);
if (!result.ok)
  return new Response(result.reason, { status: result.reason === 'expired' ? 410 : 403 });

const now = Math.floor(Date.now() / 1000);
const headers = { 'cache-control': cacheControlFor(result.tier, result.exp, now) };
// result.inGrace === true means the URL is past exp but still inside its grace window.
```

`signSrcSet` emits only rungs `<= sourceWidth` (never upscales); with no
`sourceWidth` it emits all three. When the source sits between rungs (a 1599px
image) the untransformed original is added as the top candidate so it is not
capped at 800; above the top rung the 2560 cap is deliberate and no original is
added. When the source is narrower than 800 it returns the untransformed original
alone. `src` is the largest bounded rendition.

## Tests

```
npm run test -w packages/content-signing
npm run typecheck -w packages/content-signing   # DOM lib and workers-types
```
