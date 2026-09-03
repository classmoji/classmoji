# @classmoji/content-signing

Cryptographic core of the content delivery layer. Mints and verifies signed asset
URLs.

Runs on **both** sides: the Node apps (webapp, pages, slides) mint, a Cloudflare
Worker verifies. Web Crypto only (`globalThis.crypto.subtle`), zero runtime
dependencies, no `node:crypto`.

## Keys

```
key = HMAC-SHA256(MASTER_SECRET, classroomId + '|' + keyVersion)
```

The Worker holds only the master; per-classroom keys are derived on demand and
memoized (bounded LRU, 256 entries). `keyVersion` is `Classroom.content_key_version`
(default `0`). Bumping it changes every URL for that classroom — a cache bust, not
a revocation: URLs signed under the old version keep verifying until they expire.

## Tiers

| Tier       | Expiry                        | Grace on verify | Cache-Control                          |
| ---------- | ----------------------------- | --------------- | -------------------------------------- |
| `public`   | end of the current 30d bucket | 6h              | `public, max-age={exp-now}, immutable` |
| `enrolled` | end of the current 7d bucket  | 6h              | `public, max-age={exp-now}, immutable` |
| `draft`    | exact `now + 4h`              | 5m              | `no-store`                             |

Bucket boundaries are staggered per classroom so the fleet does not cold-fill in
unison:

```
offset = fnv1a32(classroomId) mod bucketSeconds
exp    = offset + (floor((now - offset) / bucketSeconds) + 1) * bucketSeconds
```

Every mint inside one bucket produces a byte-identical URL. Grace covers a page
rendered just before rollover and still sitting in a cache; for `draft` it covers
clock skew only. An expired-beyond-grace signature fails with `expired`; nothing
validates that `exp` is not further in the future than the tier could have produced.

## URL shapes

Blob — images and any single file:

```
{origin}/c/{classroomId}/blob/{sha}.{ext}?p={tier}&v={keyVersion}&exp={unix}&sig={b64url}
                                          [&w={800|1600|2560}][&fmt={webp|avif|auto}]
```

Theme folder — a directory served path-addressed so relative CSS `url()` keeps
working. The signature lives in the path, so relative resolution inherits it:

```
{origin}/c/{classroomId}/theme/{theme}/{treeSha}/{p}.{v}.{exp}.{sig}/{relPath}
```

The theme signature covers everything up to and including the policy segment, not
`relPath`: authorizing the folder authorizes every file under it. Verification
requires `relPath` to be a normalized relative path with no `..`.

The leading `/c/` segment is the URL-scheme marker for canonical version `cm1`.
A future canonical version gets a new segment (`/c2/`, …); an unrecognized one
fails with `unsupported-version` rather than `malformed`.

## Canonical signing strings

`sig` is HMAC-SHA256 over the string, with the derived key, base64url, unpadded.

```
cm1|blob|{classroomId}|{sha}|{ext}|{p}|{v}|{exp}|{w or ''}|{fmt or ''}
cm1|theme|{classroomId}|{theme}|{treeSha}|{p}|{v}|{exp}
```

Rejected at parse time: anything where `classroomId` is not a lowercase UUID,
`sha`/`treeSha` not 40-hex, `ext` not <= 8 lowercase alphanumerics, `theme` not
`[a-z0-9._-]+`, `p` not a known tier, `v`/`exp` not non-negative integers, `w` not
one of the three widths, or `fmt` not one of the three formats.

Signature comparison runs inside `crypto.subtle.verify` — never string equality.

## Usage

Minting (Node app):

```ts
import { signBlobUrl, signSrcSet, signThemeBase } from '@classmoji/content-signing';

const ctx = { master: env.CONTENT_MASTER_SECRET, classroomId, keyVersion, tier: 'enrolled' };

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

`signSrcSet` emits only widths `<= sourceWidth` (never upscales); with no
`sourceWidth` it emits all three. When the source is narrower than 800 it returns
the untransformed original. `src` is the largest signed rendition.

## Tests

```
npm run test -w packages/content-signing
```
