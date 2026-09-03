import { describe, expect, it } from 'vitest';
// The canonical builders come from the package itself: these assertions guard
// the signing contract, so they must not be able to drift with the Worker's
// seam. Verification goes through the seam, as the Worker does, so the
// re-export stays exercised too.
import { TIER_POLICY, blobCanonicalString, themeCanonicalString } from '@classmoji/content-signing';
import { cacheControlFor, nowSeconds, verifyContentUrl } from '../src/verify.ts';
import {
  BLOB_SHA,
  CLASSROOM,
  HOST,
  MASTER,
  ORIGIN,
  TREE_SHA,
  futureExp,
  signedBlobUrl,
  signedThemeUrl,
} from './helpers.ts';

describe('canonical strings', () => {
  it('puts the lowercased host immediately after the scheme', () => {
    expect(
      blobCanonicalString({
        host: HOST,
        classroomId: CLASSROOM,
        sha: BLOB_SHA,
        ext: 'png',
        tier: 'public',
        keyVersion: 1,
        exp: 1_700_000_000,
        transform: { w: 800, fmt: 'auto' },
      })
    ).toBe(`cm1|blob|${HOST}|${CLASSROOM}|${BLOB_SHA}|png|public|1|1700000000|800|auto`);

    expect(
      themeCanonicalString({
        host: HOST,
        classroomId: CLASSROOM,
        theme: 'aurora',
        treeSha: TREE_SHA,
        tier: 'enrolled',
        keyVersion: 2,
        exp: 1_700_000_000,
      })
    ).toBe(`cm1|theme|${HOST}|${CLASSROOM}|aurora|${TREE_SHA}|enrolled|2|1700000000`);
  });

  it('leaves the transform fields empty when there is no transform', () => {
    expect(
      blobCanonicalString({
        host: HOST,
        classroomId: CLASSROOM,
        sha: BLOB_SHA,
        ext: 'css',
        tier: 'draft',
        keyVersion: 0,
        exp: 1_700_000_000,
      })
    ).toBe(`cm1|blob|${HOST}|${CLASSROOM}|${BLOB_SHA}|css|draft|0|1700000000||`);
  });
});

describe('verifyContentUrl — blob', () => {
  it('accepts a correctly signed URL', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    expect(await verifyContentUrl(MASTER, url)).toMatchObject({
      ok: true,
      kind: 'blob',
      classroomId: CLASSROOM,
      sha: BLOB_SHA,
      ext: 'png',
      tier: 'public',
      keyVersion: 1,
    });
  });

  it('carries the transform through when w/fmt are signed', async () => {
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'jpg',
      transform: { w: 1600, fmt: 'auto' },
    });
    expect(await verifyContentUrl(MASTER, url)).toMatchObject({
      ok: true,
      transform: { w: 1600, fmt: 'auto' },
    });
  });

  it('rejects a tampered width — the transform is part of the signed string', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'jpg', transform: { w: 800 } });
    expect(await verifyContentUrl(MASTER, url.replace('w=800', 'w=2560'))).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a width outside the allowed set', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'jpg', transform: { w: 800 } });
    expect(await verifyContentUrl(MASTER, url.replace('w=800', 'w=999'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a signature made with a different master key', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', master: 'other-secret' });
    expect(await verifyContentUrl(MASTER, url)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a URL missing its signature params', async () => {
    expect(await verifyContentUrl(MASTER, `${ORIGIN}/c/${CLASSROOM}/blob/${BLOB_SHA}.png`)).toEqual(
      {
        ok: false,
        reason: 'malformed',
      }
    );
  });

  it('rejects a sha that is not a git sha', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    expect(await verifyContentUrl(MASTER, url.replace(BLOB_SHA, 'deadbeef'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses a signature minted for another delivery host', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', signedHost: 'evil.example.com' });
    expect(await verifyContentUrl(MASTER, url)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a URL minted for one host and replayed against another', async () => {
    const minted = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'png',
      origin: 'http://localhost:8787',
    });
    expect(await verifyContentUrl(MASTER, minted)).toMatchObject({ ok: true });

    const replayed = minted.replace('http://localhost:8787', ORIGIN);
    expect(await verifyContentUrl(MASTER, replayed)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('binds the port, not just the hostname', async () => {
    const minted = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'png',
      origin: 'http://localhost:8787',
    });
    const otherPort = minted.replace('localhost:8787', 'localhost:9999');
    expect(await verifyContentUrl(MASTER, otherPort)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('signs the lowercased host, so case in the request does not matter', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    expect(await verifyContentUrl(MASTER, url.replace(HOST, HOST.toUpperCase()))).toMatchObject({
      ok: true,
    });
  });

  it('rejects a query param outside the allowlist', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    expect(await verifyContentUrl(MASTER, `${url}&cb=12345`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a duplicated query param rather than picking one', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'jpg', transform: { w: 800 } });
    expect(await verifyContentUrl(MASTER, `${url}&w=2560`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('calls a newer scheme segment unsupported rather than malformed', async () => {
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png' });
    expect(await verifyContentUrl(MASTER, url.replace('/c/', '/c2/'))).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
  });

  it('serves inside the tier grace window, and refuses past it', async () => {
    const justExpired = nowSeconds() - 10;
    const url = await signedBlobUrl({
      sha: BLOB_SHA,
      ext: 'png',
      tier: 'enrolled',
      exp: justExpired,
    });
    expect(await verifyContentUrl(MASTER, url)).toMatchObject({ ok: true, inGrace: true });

    const past = justExpired + TIER_POLICY.enrolled.graceSeconds + 60;
    expect(await verifyContentUrl(MASTER, url, past)).toEqual({ ok: false, reason: 'expired' });
  });

  it('gives draft a much shorter grace than enrolled', async () => {
    const justExpired = nowSeconds() - 10;
    const url = await signedBlobUrl({ sha: BLOB_SHA, ext: 'png', tier: 'draft', exp: justExpired });
    const afterDraftGrace = justExpired + TIER_POLICY.draft.graceSeconds + 60;
    expect(TIER_POLICY.draft.graceSeconds).toBeLessThan(TIER_POLICY.enrolled.graceSeconds);
    expect(await verifyContentUrl(MASTER, url, afterDraftGrace)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('verifyContentUrl — theme', () => {
  it('accepts a correctly signed theme URL and returns the relative path', async () => {
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });
    expect(await verifyContentUrl(MASTER, url)).toMatchObject({
      ok: true,
      kind: 'theme',
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });
  });

  it('rejects path traversal in the relative path', async () => {
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: '../secrets.env',
    });
    expect(await verifyContentUrl(MASTER, url)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an encoded traversal too', async () => {
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });
    expect(
      await verifyContentUrl(MASTER, url.replace('css/site.css', '%2e%2e/secrets.env'))
    ).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects any query string on a theme URL', async () => {
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });
    expect(await verifyContentUrl(MASTER, `${url}?v=2`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a segment that is still encoded after one decode', async () => {
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });
    expect(
      await verifyContentUrl(MASTER, url.replace('css/site.css', '%252e%252e/secrets.env'))
    ).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses a theme signature minted for another host', async () => {
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
      signedHost: 'evil.example.com',
    });
    expect(await verifyContentUrl(MASTER, url)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a swapped tree sha — it is part of the signed string', async () => {
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
    });
    const other = 'cccccccccccccccccccccccccccccccccccccccc';
    expect(await verifyContentUrl(MASTER, url.replace(TREE_SHA, other))).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('cacheControlFor', () => {
  it('never stores draft content', () => {
    expect(cacheControlFor('draft', futureExp(), nowSeconds())).toBe('no-store');
  });

  it('caches until the signature dies', () => {
    const now = 1_700_000_000;
    expect(cacheControlFor('public', now + 600, now)).toBe('public, max-age=600, immutable');
    expect(cacheControlFor('enrolled', now + 60, now)).toBe('public, max-age=60, immutable');
  });

  it('gives a past expiry a short positive TTL instead of pinning it immutable', () => {
    const now = 1_700_000_000;
    // Inside grace the URL is still served, but a zero max-age would send every
    // cache back to the origin at once — and it must not be pinned immutable.
    expect(cacheControlFor('public', now - 600, now)).toBe('public, max-age=60');
    expect(cacheControlFor('public', now, now)).toBe('public, max-age=60');
  });
});
