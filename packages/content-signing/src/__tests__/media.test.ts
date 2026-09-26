/**
 * Media URLs — the third signed shape, beside blob and theme.
 *
 * A media object is a row in the media bucket rather than a git blob: the key
 * is classroom-scoped, the bytes are the primary copy, and the URL names one of
 * three variants. Everything else is the blob rules verbatim — the same tiers,
 * the same bucketed expiry, the same derived key, the same `dl` policy — so
 * most of what this suite proves is that "verbatim" is true, and that the two
 * namespaces cannot be replayed into each other.
 */
import { describe, expect, it } from 'vitest';

import { bucketExpiry, graceFor } from '../bucket.ts';
import { mediaCanonicalString, mediaKey, toBase64Url } from '../canonical.ts';
import { deriveKey, signCanonical } from '../derive.ts';
import { encodeDownloadFilename } from '../downloads.ts';
import { contentTypeForMediaExt } from '../mediaTypes.ts';
import type { Tier } from '../types.ts';
import { signBlobUrl, signMediaUrl, signThemeBase } from '../urls.ts';
import {
  parseContentUrl,
  verifyBlobUrl,
  verifyContentUrl,
  verifyMediaUrl,
  verifyThemeUrl,
} from '../verify.ts';
import {
  CLASSROOM_A,
  CLASSROOM_B,
  HOST,
  MASTER,
  NOW,
  ORIGIN,
  OTHER_MASTER,
  OTHER_ORIGIN,
  SHA,
  TREE_SHA,
  ctx,
  withParam,
} from './fixtures.ts';

const TIERS: Tier[] = ['month', 'week', 'edit', 'download'];

const MEDIA_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_MEDIA_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

const media = (tier: Tier, variant = 'orig.mov') =>
  signMediaUrl(ORIGIN, ctx(tier), { mediaId: MEDIA_ID, variant });

/** A save-to-disk media URL: the `download` tier plus the filename it carries. */
const download = (dl: string) =>
  signMediaUrl(ORIGIN, ctx('download'), { mediaId: MEDIA_ID, variant: 'orig.mov', dl });

/**
 * The same URL on a longer-lived tier — which `signMediaUrl` refuses to mint.
 *
 * That refusal is a MINT-side rule, so proving the verifier is unaffected takes
 * a signature the mint path would not produce. Everything security-relevant is
 * still the package's: its canonical string, its key derivation, its HMAC.
 */
async function downloadOnTier(dl: string, tier: Tier): Promise<string> {
  const encoded = encodeDownloadFilename(dl);
  const exp = bucketExpiry(tier, CLASSROOM_A, NOW);
  const canonical = mediaCanonicalString({
    host: HOST,
    classroomId: CLASSROOM_A,
    mediaId: MEDIA_ID,
    variant: 'orig.mov',
    tier,
    keyVersion: 0,
    exp,
    dl: encoded,
  });
  const key = await deriveKey(MASTER, CLASSROOM_A, 0);
  const sig = toBase64Url(await signCanonical(key, canonical));
  return (
    `${ORIGIN}/c/${CLASSROOM_A}/media/${MEDIA_ID}/orig.mov` +
    `?p=${tier}&v=0&exp=${exp}&sig=${sig}&dl=${encoded}`
  );
}

describe('mediaKey', () => {
  it('is classroom-scoped, and spells the variant out', () => {
    expect(mediaKey(CLASSROOM_A, MEDIA_ID, 'orig.mov')).toBe(
      `m/${CLASSROOM_A}/${MEDIA_ID}/orig.mov`
    );
    expect(mediaKey(CLASSROOM_A, MEDIA_ID, 'web.mp4')).toBe(`m/${CLASSROOM_A}/${MEDIA_ID}/web.mp4`);
    expect(mediaKey(CLASSROOM_A, MEDIA_ID, 'poster.webp')).toBe(
      `m/${CLASSROOM_A}/${MEDIA_ID}/poster.webp`
    );
  });

  it('refuses anything that is not a uuid or a known variant', () => {
    // The key is a storage address built from values that arrived over the
    // network, so nothing here is taken on trust.
    expect(() => mediaKey('not-a-uuid', MEDIA_ID, 'orig.mov')).toThrow(TypeError);
    expect(() => mediaKey(CLASSROOM_A, MEDIA_ID.toUpperCase(), 'orig.mov')).toThrow(TypeError);
    expect(() => mediaKey(CLASSROOM_A, MEDIA_ID, '../../blobs/secret')).toThrow(TypeError);
    expect(() => mediaKey(CLASSROOM_A, MEDIA_ID, 'orig.mov/../web.mp4')).toThrow(TypeError);
    expect(() => mediaKey(CLASSROOM_A, MEDIA_ID, 'orig.')).toThrow(TypeError);
    expect(() => mediaKey(CLASSROOM_A, MEDIA_ID, 'orig.thisistoolong')).toThrow(TypeError);
  });
});

describe('contentTypeForMediaExt', () => {
  it('answers the type the media store assigns, case-insensitively', () => {
    // One table, read by the app when it stores an object and by the Worker
    // when it has to say what an object is without a stored type.
    expect(contentTypeForMediaExt('mov')).toBe('video/quicktime');
    expect(contentTypeForMediaExt('MP3')).toBe('audio/mpeg');
    expect(contentTypeForMediaExt('zip')).toBe('application/zip');
    expect(contentTypeForMediaExt('key')).toBe('application/zip');
    expect(contentTypeForMediaExt('jpeg')).toBe('image/jpeg');
  });

  it('has no type for anything a browser could be talked into executing', () => {
    for (const ext of ['html', 'htm', 'svg', 'js', 'mjs', 'xml', 'exe', '']) {
      expect(contentTypeForMediaExt(ext)).toBeNull();
    }
  });
});

describe('canonical string', () => {
  it('pins the media shape', () => {
    expect(
      mediaCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        mediaId: MEDIA_ID,
        variant: 'web.mp4',
        tier: 'month',
        keyVersion: 3,
        exp: 1767225600,
      })
    ).toBe(`cm1|media|${HOST}|${CLASSROOM_A}|${MEDIA_ID}|web.mp4|month|3|1767225600`);
  });

  it('appends a dl suffix, exactly as the blob shape does', () => {
    const dl = encodeDownloadFilename('lecture.mov');
    expect(
      mediaCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        mediaId: MEDIA_ID,
        variant: 'orig.mov',
        tier: 'download',
        keyVersion: 0,
        exp: 1767225600,
        dl,
      })
    ).toBe(`cm1|media|${HOST}|${CLASSROOM_A}|${MEDIA_ID}|orig.mov|download|0|1767225600|dl|${dl}`);
  });

  it('carries a discriminator no other shape uses', () => {
    // `blob`, `theme`, `render` and `media` are four namespaces under one key.
    // A signature taken over one can never satisfy another, because the whole
    // string is covered and the second field always differs.
    const canonical = mediaCanonicalString({
      host: HOST,
      classroomId: CLASSROOM_A,
      mediaId: MEDIA_ID,
      variant: 'orig.mov',
      tier: 'week',
      keyVersion: 0,
      exp: 1767225600,
    });
    expect(canonical.split('|')[1]).toBe('media');
  });
});

describe('round trip', () => {
  it.each(TIERS)('verifies a freshly minted media URL for %s', async tier => {
    const url = await media(tier);
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({
      ok: true,
      kind: 'media',
      classroomId: CLASSROOM_A,
      mediaId: MEDIA_ID,
      variant: 'orig.mov',
      tier,
      keyVersion: 0,
      exp: bucketExpiry(tier, CLASSROOM_A, NOW),
      inGrace: false,
      keySlot: 'current',
    });
  });

  it('mints the path and query the Worker routes on', async () => {
    const url = new URL(await media('month'));
    expect(url.pathname).toBe(`/c/${CLASSROOM_A}/media/${MEDIA_ID}/orig.mov`);
    expect([...url.searchParams.keys()]).toEqual(['p', 'v', 'exp', 'sig']);
  });

  it.each(['orig.mp4', 'orig.mov', 'orig.pdf', 'orig.zip', 'web.mp4', 'poster.webp'])(
    'round trips the %s variant',
    async variant => {
      const result = await verifyMediaUrl(MASTER, await media('week', variant), NOW);
      expect(result.ok && result.variant).toBe(variant);
    }
  );

  it('dispatches on shape through verifyContentUrl, leaving the other kinds alone', async () => {
    const mediaResult = await verifyContentUrl(MASTER, await media('month'), NOW);
    expect(mediaResult.ok && mediaResult.kind).toBe('media');

    const blobResult = await verifyContentUrl(
      MASTER,
      await signBlobUrl(ORIGIN, ctx('month'), { sha: SHA, ext: 'png' }),
      NOW
    );
    expect(blobResult.ok && blobResult.kind).toBe('blob');

    const themeUrl = `${await signThemeBase(ORIGIN, ctx('month'), { theme: 'cosmo-dark', treeSha: TREE_SHA })}a.css`;
    const themeResult = await verifyContentUrl(MASTER, themeUrl, NOW);
    expect(themeResult.ok && themeResult.kind).toBe('theme');
  });

  it('parses structurally without any key material', async () => {
    const parsed = parseContentUrl(await media('week', 'web.mp4'));
    expect(parsed?.kind).toBe('media');
    expect(parsed && parsed.kind === 'media' && parsed.mediaId).toBe(MEDIA_ID);
    expect(parsed && parsed.kind === 'media' && parsed.variant).toBe('web.mp4');
  });
});

describe('mint-side refusals', () => {
  it('refuses a media id that is not a lowercase uuid', async () => {
    await expect(
      signMediaUrl(ORIGIN, ctx('week'), { mediaId: 'not-a-uuid', variant: 'orig.mov' })
    ).rejects.toThrow(TypeError);
    await expect(
      signMediaUrl(ORIGIN, ctx('week'), { mediaId: MEDIA_ID.toUpperCase(), variant: 'orig.mov' })
    ).rejects.toThrow(TypeError);
    await expect(
      signMediaUrl(ORIGIN, ctx('week'), { mediaId: SHA, variant: 'orig.mov' })
    ).rejects.toThrow(TypeError);
  });

  it.each([
    'orig',
    'orig.',
    'orig.MOV',
    'orig.thisistoolong',
    'web.webm',
    'poster.png',
    'poster.webp/x',
    '../orig.mov',
    'orig.mov?x=1',
  ])('refuses the variant %s', async variant => {
    await expect(signMediaUrl(ORIGIN, ctx('week'), { mediaId: MEDIA_ID, variant })).rejects.toThrow(
      TypeError
    );
  });

  it('refuses a dl filename on any tier but download', async () => {
    for (const tier of ['month', 'week', 'edit'] as Tier[]) {
      await expect(
        signMediaUrl(ORIGIN, ctx(tier), {
          mediaId: MEDIA_ID,
          variant: 'orig.mov',
          dl: 'lecture.mov',
        })
      ).rejects.toThrow(/requires the download tier/);
    }
  });

  it('refuses a filename nothing could be saved under', async () => {
    await expect(
      signMediaUrl(ORIGIN, ctx('download'), { mediaId: MEDIA_ID, variant: 'orig.mov', dl: '   ' })
    ).rejects.toThrow(/unusable download filename/);
  });
});

describe('downloads', () => {
  it('round trips the display filename on the download tier', async () => {
    const url = await download('Week 3 — Recursion.mov');
    const result = await verifyMediaUrl(MASTER, url, NOW);
    expect(result.ok && result.downloadFilename).toBe('Week 3 — Recursion.mov');
    expect(new URL(url).searchParams.get('dl')).toBe(
      encodeDownloadFilename('Week 3 — Recursion.mov')
    );
  });

  it('leaves dl off every other URL, byte for byte', async () => {
    const url = await media('month');
    expect(url).not.toContain('dl=');
    const result = await verifyMediaUrl(MASTER, url, NOW);
    expect(result.ok && 'downloadFilename' in result).toBe(false);
  });

  it('still honours a dl that was validly signed on another tier', async () => {
    // The mint rule is a mint rule. The verifier accepts whatever this key
    // signed, exactly as it does on the blob path — the tier's cacheability is
    // the serving side's decision, not the signature's.
    const url = await downloadOnTier('lecture.mov', 'month');
    const result = await verifyMediaUrl(MASTER, url, NOW);
    expect(result.ok && result.downloadFilename).toBe('lecture.mov');
    expect(result.ok && result.tier).toBe('month');
  });

  it('refuses a dl appended to a URL that was signed without one', async () => {
    const url = `${await media('download')}&dl=${encodeDownloadFilename('anything.mov')}`;
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('tampering', () => {
  it('refuses a rewritten variant', async () => {
    // The whole point of signing the variant: a poster-frame URL must not be
    // editable into the 2 GB original, and an `orig` URL must not be editable
    // into a variant the app deliberately did not hand out.
    const url = await media('month', 'poster.webp');
    const swapped = url.replace('poster.webp', 'web.mp4');
    expect(await verifyMediaUrl(MASTER, swapped, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a rewritten media id', async () => {
    const url = (await media('month')).replace(MEDIA_ID, OTHER_MEDIA_ID);
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a rewritten classroom', async () => {
    // Both halves fail at once: the canonical string names the classroom, and
    // the key is derived from it. This is the invariant that keeps one
    // classroom's URL from ever addressing another's bucket prefix.
    const url = (await media('month')).replace(CLASSROOM_A, CLASSROOM_B);
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a widened tier', async () => {
    const url = withParam(await media('edit'), 'p', 'month');
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a pushed-out expiry', async () => {
    const url = await media('edit');
    const exp = Number(new URL(url).searchParams.get('exp'));
    const extended = withParam(url, 'exp', String(exp + 86400));
    expect(await verifyMediaUrl(MASTER, extended, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a bumped key version', async () => {
    const url = withParam(await media('month'), 'v', '1');
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a URL minted for another delivery host', async () => {
    const url = (
      await signMediaUrl(OTHER_ORIGIN, ctx('month'), {
        mediaId: MEDIA_ID,
        variant: 'orig.mov',
      })
    ).replace(OTHER_ORIGIN, ORIGIN);
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a URL signed with another master', async () => {
    const url = await media('month');
    expect(await verifyMediaUrl(OTHER_MASTER, url, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it.each(['w', 'fmt', 'cb'])('refuses an unsigned %s param', async key => {
    const url = `${await media('month')}&${key}=1`;
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a repeated param rather than reading the first', async () => {
    const url = `${await media('month')}&p=month`;
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    `/c/${CLASSROOM_A}/media/${MEDIA_ID}`,
    `/c/${CLASSROOM_A}/media/${MEDIA_ID}/orig.mov/extra`,
    `/c/${CLASSROOM_A}/media/not-a-uuid/orig.mov`,
    `/c/${CLASSROOM_A}/media/${MEDIA_ID}/..%2F..%2Fsecret`,
  ])('refuses the path shape %s', async pathname => {
    const url = await media('month');
    const rewritten = new URL(url);
    rewritten.pathname = pathname;
    expect(await verifyMediaUrl(MASTER, rewritten.toString(), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('expiry', () => {
  it('expires past the tier grace window', async () => {
    const url = await media('edit');
    const exp = bucketExpiry('edit', CLASSROOM_A, NOW);

    expect((await verifyMediaUrl(MASTER, url, exp)).ok).toBe(true);

    const inGrace = await verifyMediaUrl(MASTER, url, exp + 1);
    expect(inGrace.ok && inGrace.inGrace).toBe(true);

    expect(await verifyMediaUrl(MASTER, url, exp + graceFor('edit') + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('namespace isolation', () => {
  it('will not verify a media URL as a blob or a theme', async () => {
    const url = await media('month');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyThemeUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('will not verify a blob URL as media', async () => {
    const url = await signBlobUrl(ORIGIN, ctx('month'), { sha: SHA, ext: 'png' });
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('cannot be reached by relabelling a blob URL as media', async () => {
    // Same classroom, same key version, same tier — only the path segment
    // changes, and the discriminator inside the canonical string is what makes
    // that signature worthless here.
    const url = (await signBlobUrl(ORIGIN, ctx('month'), { sha: SHA, ext: 'png' }))
      .replace('/blob/', '/media/')
      .replace(`${SHA}.png`, `${MEDIA_ID}/orig.png`);
    expect(await verifyMediaUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });
});
