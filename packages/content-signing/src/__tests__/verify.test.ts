import { describe, expect, it } from 'vitest';

import { TIER_POLICY, bucketExpiry } from '../bucket.ts';
import { signBlobUrl, signThemeBase } from '../urls.ts';
import type { Tier } from '../types.ts';
import {
  cacheControlFor,
  parseContentUrl,
  verifyBlobUrl,
  verifyContentUrl,
  verifyThemeUrl,
} from '../verify.ts';
import {
  CLASSROOM_A,
  CLASSROOM_B,
  MASTER,
  NOW,
  ORIGIN,
  OTHER_MASTER,
  OTHER_SHA,
  SHA,
  TREE_SHA,
  ctx,
  withParam,
  withoutParam,
} from './fixtures.ts';

const TIERS: Tier[] = ['public', 'enrolled', 'draft'];

const blob = (tier: Tier, transform?: { w?: 800 | 1600 | 2560; fmt?: 'webp' | 'avif' | 'auto' }) =>
  signBlobUrl(ORIGIN, ctx(tier), { sha: SHA, ext: 'png', transform });

const themeBase = (tier: Tier) =>
  signThemeBase(ORIGIN, ctx(tier), { theme: 'cosmo-dark', treeSha: TREE_SHA });

describe('round trip', () => {
  it.each(TIERS)('verifies a freshly minted blob URL for %s', async tier => {
    const url = await blob(tier);
    const result = await verifyBlobUrl(MASTER, url, NOW);
    expect(result).toEqual({
      ok: true,
      kind: 'blob',
      classroomId: CLASSROOM_A,
      sha: SHA,
      ext: 'png',
      tier,
      keyVersion: 0,
      exp: bucketExpiry(tier, CLASSROOM_A, NOW),
      inGrace: false,
    });
  });

  it.each(TIERS)('verifies a blob URL with a transform for %s', async tier => {
    const url = await blob(tier, { w: 1600, fmt: 'webp' });
    const result = await verifyBlobUrl(MASTER, url, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transform).toEqual({ w: 1600, fmt: 'webp' });
    expect(result.inGrace).toBe(false);
  });

  it.each(TIERS)('verifies a theme folder and any file under it for %s', async tier => {
    const base = await themeBase(tier);
    const exp = bucketExpiry(tier, CLASSROOM_A, NOW);

    const folder = await verifyThemeUrl(MASTER, base, NOW);
    expect(folder).toEqual({
      ok: true,
      kind: 'theme',
      classroomId: CLASSROOM_A,
      theme: 'cosmo-dark',
      treeSha: TREE_SHA,
      tier,
      keyVersion: 0,
      exp,
      relPath: '',
      inGrace: false,
    });

    for (const relPath of ['theme.css', 'fonts/inter.woff2', 'img/hero%20shot.png']) {
      const file = await verifyThemeUrl(MASTER, `${base}${relPath}`, NOW);
      expect(file.ok).toBe(true);
      if (file.ok) expect(file.relPath).toBe(decodeURIComponent(relPath));
    }
  });

  it('dispatches on shape through verifyContentUrl', async () => {
    const blobResult = await verifyContentUrl(MASTER, await blob('public'), NOW);
    expect(blobResult.ok && blobResult.kind).toBe('blob');

    const themeResult = await verifyContentUrl(MASTER, `${await themeBase('public')}a.css`, NOW);
    expect(themeResult.ok && themeResult.kind).toBe('theme');
  });

  it('accepts a URL object as well as a string', async () => {
    const url = await blob('enrolled');
    expect((await verifyBlobUrl(MASTER, new URL(url), NOW)).ok).toBe(true);
  });

  it('survives a keyVersion bump only under the matching version', async () => {
    const v0 = await blob('public');
    const v1 = await signBlobUrl(ORIGIN, ctx('public', { keyVersion: 1 }), {
      sha: SHA,
      ext: 'png',
    });
    expect(v0).not.toBe(v1);
    expect((await verifyBlobUrl(MASTER, v0, NOW)).ok).toBe(true);
    expect((await verifyBlobUrl(MASTER, v1, NOW)).ok).toBe(true);
  });
});

describe('grace', () => {
  it.each(['public', 'enrolled'] as const)(
    'accepts a previous-bucket %s signature inside 6h, not after',
    async tier => {
      const url = await blob(tier);
      const exp = bucketExpiry(tier, CLASSROOM_A, NOW);
      const grace = TIER_POLICY[tier].graceSeconds;
      expect(grace).toBe(6 * 3600);

      const atExpiry = await verifyBlobUrl(MASTER, url, exp);
      expect(atExpiry.ok && atExpiry.inGrace).toBe(false);

      const inGrace = await verifyBlobUrl(MASTER, url, exp + grace);
      expect(inGrace.ok).toBe(true);
      if (inGrace.ok) expect(inGrace.inGrace).toBe(true);

      expect(await verifyBlobUrl(MASTER, url, exp + grace + 1)).toEqual({
        ok: false,
        reason: 'expired',
      });
    }
  );

  it('gives draft only a 5 minute skew allowance', async () => {
    const url = await blob('draft');
    const exp = NOW + 4 * 3600;
    expect(TIER_POLICY.draft.graceSeconds).toBe(300);

    const inGrace = await verifyBlobUrl(MASTER, url, exp + 300);
    expect(inGrace.ok).toBe(true);
    if (inGrace.ok) expect(inGrace.inGrace).toBe(true);

    expect(await verifyBlobUrl(MASTER, url, exp + 301)).toEqual({ ok: false, reason: 'expired' });
    // A 6h grace would have covered this; draft must not.
    expect(await verifyBlobUrl(MASTER, url, exp + 3600)).toEqual({ ok: false, reason: 'expired' });
  });

  it('applies the same grace to theme URLs', async () => {
    const base = await themeBase('enrolled');
    const exp = bucketExpiry('enrolled', CLASSROOM_A, NOW);
    const inGrace = await verifyThemeUrl(MASTER, `${base}theme.css`, exp + 60);
    expect(inGrace.ok).toBe(true);
    if (inGrace.ok) expect(inGrace.inGrace).toBe(true);

    expect(await verifyThemeUrl(MASTER, `${base}theme.css`, exp + 6 * 3600 + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('tamper vectors', () => {
  it('rejects a stripped signature as malformed', async () => {
    const url = withoutParam(await blob('public'), 'sig');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a flipped tier', async () => {
    const url = withParam(await blob('enrolled'), 'p', 'public');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered width', async () => {
    const url = withParam(await blob('public', { w: 800 }), 'w', '2560');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an added width on an untransformed URL', async () => {
    const url = withParam(await blob('public'), 'w', '800');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered format', async () => {
    const url = withParam(await blob('public', { fmt: 'webp' }), 'fmt', 'avif');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered sha', async () => {
    const url = (await blob('public')).replace(SHA, OTHER_SHA);
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered ext', async () => {
    const url = (await blob('public')).replace(`${SHA}.png`, `${SHA}.gif`);
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a swapped classroomId', async () => {
    const url = (await blob('public')).replace(CLASSROOM_A, CLASSROOM_B);
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a bumped keyVersion', async () => {
    const url = withParam(await blob('public'), 'v', '1');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a stretched expiry', async () => {
    const url = await blob('draft');
    const stretched = withParam(url, 'exp', String(NOW + 400 * 86400));
    expect(await verifyBlobUrl(MASTER, stretched, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a theme relPath that escapes the folder', async () => {
    const base = await themeBase('public');
    // Escaping eats the policy segment, so there is nothing left to verify against.
    for (const relPath of ['../secret.css', 'css/../../secret.css', '../../../../etc/passwd']) {
      expect(await verifyThemeUrl(MASTER, `${base}${relPath}`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('never lets a traversal survive into relPath', async () => {
    const base = await themeBase('public');
    // %2e%2e is a dot segment to the URL parser: this collapses back inside the
    // folder rather than escaping it, and what the Worker sees is the normalized path.
    const result = await verifyThemeUrl(MASTER, `${base}css/%2e%2e/theme.css`, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relPath).toBe('theme.css');
    expect(result.relPath).not.toContain('..');
  });

  it('rejects a tampered theme policy segment', async () => {
    const base = await themeBase('enrolled');
    const tampered = base.replace('/enrolled.', '/public.');
    expect(await verifyThemeUrl(MASTER, `${tampered}theme.css`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects an unknown canonical version', async () => {
    const url = (await blob('public')).replace('/c/', '/c2/');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });

    const base = (await themeBase('public')).replace('/c/', '/c9/');
    expect(await verifyThemeUrl(MASTER, `${base}theme.css`, NOW)).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
  });

  it('rejects structurally broken URLs as malformed', async () => {
    const cases = [
      'not-a-url',
      `${ORIGIN}/`,
      `${ORIGIN}/c/${CLASSROOM_A}`,
      `${ORIGIN}/c/not-a-uuid/blob/${SHA}.png?p=public&v=0&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/other/${SHA}.png?p=public&v=0&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=teacher&v=0&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=public&v=x&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=public&v=0&exp=1&sig=AA*A`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=public&v=0&exp=1&sig=AAAA&w=999`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}?p=public&v=0&exp=1&sig=AAAA`,
    ];
    for (const url of cases) {
      expect(await verifyContentUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('will not verify a blob URL as a theme URL, or vice versa', async () => {
    expect(await verifyThemeUrl(MASTER, await blob('public'), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyBlobUrl(MASTER, `${await themeBase('public')}a.css`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('master secret', () => {
  it('rejects everything signed under a different master', async () => {
    expect(await verifyBlobUrl(OTHER_MASTER, await blob('public'), NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    expect(await verifyThemeUrl(OTHER_MASTER, `${await themeBase('public')}a.css`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('parseContentUrl', () => {
  it('returns raw fields without touching key material', async () => {
    const url = await blob('draft', { w: 800 });
    const parsed = parseContentUrl(url);
    expect(parsed).toMatchObject({
      kind: 'blob',
      classroomId: CLASSROOM_A,
      sha: SHA,
      ext: 'png',
      tier: 'draft',
      keyVersion: 0,
      exp: NOW + 4 * 3600,
      transform: { w: 800 },
    });
    // It is a structural parse only: a forged signature still parses.
    expect(parseContentUrl(withParam(url, 'sig', 'AAAA'))).not.toBeNull();
  });

  it('returns null on anything unparseable', () => {
    expect(parseContentUrl('https://example.test/nope')).toBeNull();
    expect(parseContentUrl(`${ORIGIN}/c2/${CLASSROOM_A}/blob/${SHA}.png`)).toBeNull();
  });
});

describe('cacheControlFor', () => {
  it('never stores draft', () => {
    expect(cacheControlFor('draft', NOW + 4 * 3600, NOW)).toBe('no-store');
  });

  it('caches the rest for exactly the remaining life of the signature', () => {
    expect(cacheControlFor('public', NOW + 100, NOW)).toBe('public, max-age=100, immutable');
    expect(cacheControlFor('enrolled', NOW + 604800, NOW)).toBe(
      'public, max-age=604800, immutable'
    );
  });

  it('floors at zero once expired', () => {
    expect(cacheControlFor('public', NOW - 10, NOW)).toBe('public, max-age=0, immutable');
  });
});
