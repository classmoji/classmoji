import { describe, expect, it } from 'vitest';

import { TIER_POLICY, bucketExpiry } from '../bucket.ts';
import { clearKeyCache } from '../derive.ts';
import { signBlobUrl, signThemeBase } from '../urls.ts';
import type { Tier } from '../types.ts';
import {
  cacheControlFor,
  normalizeRelPath,
  parseContentUrl,
  verifyBlobUrl,
  verifyContentUrl,
  verifyThemeUrl,
} from '../verify.ts';
import {
  CLASSROOM_A,
  CLASSROOM_B,
  MASTER,
  HOST,
  NOW,
  ORIGIN,
  OTHER_MASTER,
  OTHER_ORIGIN,
  OTHER_SHA,
  SHA,
  TREE_SHA,
  ctx,
  withParam,
  withoutParam,
} from './fixtures.ts';

const TIERS: Tier[] = ['month', 'week', 'edit'];

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
      keySlot: 'current',
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
      keySlot: 'current',
    });

    for (const relPath of ['theme.css', 'fonts/inter.woff2', 'img/hero%20shot.png']) {
      const file = await verifyThemeUrl(MASTER, `${base}${relPath}`, NOW);
      expect(file.ok).toBe(true);
      if (file.ok) expect(file.relPath).toBe(decodeURIComponent(relPath));
    }
  });

  it('dispatches on shape through verifyContentUrl', async () => {
    const blobResult = await verifyContentUrl(MASTER, await blob('month'), NOW);
    expect(blobResult.ok && blobResult.kind).toBe('blob');

    const themeResult = await verifyContentUrl(MASTER, `${await themeBase('month')}a.css`, NOW);
    expect(themeResult.ok && themeResult.kind).toBe('theme');
  });

  it('accepts a URL object as well as a string', async () => {
    const url = await blob('week');
    expect((await verifyBlobUrl(MASTER, new URL(url), NOW)).ok).toBe(true);
  });

  it('survives a keyVersion bump only under the matching version', async () => {
    const v0 = await blob('month');
    const v1 = await signBlobUrl(ORIGIN, ctx('month', { keyVersion: 1 }), {
      sha: SHA,
      ext: 'png',
    });
    expect(v0).not.toBe(v1);
    expect((await verifyBlobUrl(MASTER, v0, NOW)).ok).toBe(true);
    expect((await verifyBlobUrl(MASTER, v1, NOW)).ok).toBe(true);
  });
});

describe('grace', () => {
  it.each(['month', 'week'] as const)(
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

  it('gives edit only a 5 minute skew allowance', async () => {
    const url = await blob('edit');
    const exp = NOW + 4 * 3600;
    expect(TIER_POLICY.edit.graceSeconds).toBe(300);

    const inGrace = await verifyBlobUrl(MASTER, url, exp + 300);
    expect(inGrace.ok).toBe(true);
    if (inGrace.ok) expect(inGrace.inGrace).toBe(true);

    expect(await verifyBlobUrl(MASTER, url, exp + 301)).toEqual({ ok: false, reason: 'expired' });
    // A 6h grace would have covered this; edit must not.
    expect(await verifyBlobUrl(MASTER, url, exp + 3600)).toEqual({ ok: false, reason: 'expired' });
  });

  it('applies the same grace to theme URLs', async () => {
    const base = await themeBase('week');
    const exp = bucketExpiry('week', CLASSROOM_A, NOW);
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
    const url = withoutParam(await blob('month'), 'sig');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a flipped tier', async () => {
    const url = withParam(await blob('week'), 'p', 'month');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered width', async () => {
    const url = withParam(await blob('month', { w: 800 }), 'w', '2560');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an added width on an untransformed URL', async () => {
    const url = withParam(await blob('month'), 'w', '800');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered format', async () => {
    const url = withParam(await blob('month', { fmt: 'webp' }), 'fmt', 'avif');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered sha', async () => {
    const url = (await blob('month')).replace(SHA, OTHER_SHA);
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an altered ext', async () => {
    const url = (await blob('month')).replace(`${SHA}.png`, `${SHA}.gif`);
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a swapped classroomId', async () => {
    const url = (await blob('month')).replace(CLASSROOM_A, CLASSROOM_B);
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a bumped keyVersion', async () => {
    const url = withParam(await blob('month'), 'v', '1');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a stretched expiry', async () => {
    const url = await blob('edit');
    const stretched = withParam(url, 'exp', String(NOW + 400 * 86400));
    expect(await verifyBlobUrl(MASTER, stretched, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a theme relPath that escapes the folder', async () => {
    const base = await themeBase('month');
    // Escaping eats the policy segment, so there is nothing left to verify against.
    for (const relPath of ['../secret.css', 'css/../../secret.css', '../../../../etc/passwd']) {
      expect(await verifyThemeUrl(MASTER, `${base}${relPath}`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('never lets a traversal survive into relPath', async () => {
    const base = await themeBase('month');
    // %2e%2e is a dot segment to the URL parser: this collapses back inside the
    // folder rather than escaping it, and what the Worker sees is the normalized path.
    const result = await verifyThemeUrl(MASTER, `${base}css/%2e%2e/theme.css`, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relPath).toBe('theme.css');
    expect(result.relPath).not.toContain('..');
  });

  it('rejects a tampered theme policy segment', async () => {
    const base = await themeBase('week');
    const tampered = base.replace('/week.', '/month.');
    expect(await verifyThemeUrl(MASTER, `${tampered}theme.css`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects an unknown canonical version', async () => {
    const url = (await blob('month')).replace('/c/', '/c2/');
    expect(await verifyBlobUrl(MASTER, url, NOW)).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });

    const base = (await themeBase('month')).replace('/c/', '/c9/');
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
      `${ORIGIN}/c/not-a-uuid/blob/${SHA}.png?p=month&v=0&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/other/${SHA}.png?p=month&v=0&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=teacher&v=0&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=month&v=x&exp=1&sig=AAAA`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=month&v=0&exp=1&sig=AA*A`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=month&v=0&exp=1&sig=AAAA&w=999`,
      `${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}?p=month&v=0&exp=1&sig=AAAA`,
    ];
    for (const url of cases) {
      expect(await verifyContentUrl(MASTER, url, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('will not verify a blob URL as a theme URL, or vice versa', async () => {
    expect(await verifyThemeUrl(MASTER, await blob('month'), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifyBlobUrl(MASTER, `${await themeBase('month')}a.css`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('master secret', () => {
  it('rejects everything signed under a different master', async () => {
    expect(await verifyBlobUrl(OTHER_MASTER, await blob('month'), NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    expect(await verifyThemeUrl(OTHER_MASTER, `${await themeBase('month')}a.css`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('parseContentUrl', () => {
  it('returns raw fields without touching key material', async () => {
    const url = await blob('edit', { w: 800 });
    const parsed = parseContentUrl(url);
    expect(parsed).toMatchObject({
      kind: 'blob',
      classroomId: CLASSROOM_A,
      sha: SHA,
      ext: 'png',
      tier: 'edit',
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
  it('never stores edit', () => {
    expect(cacheControlFor('edit', NOW + 4 * 3600, NOW)).toBe('no-store');
  });

  it('caches the rest for exactly the remaining life of the signature', () => {
    expect(cacheControlFor('month', NOW + 100, NOW)).toBe('public, max-age=100, immutable');
    expect(cacheControlFor('week', NOW + 604800, NOW)).toBe('public, max-age=604800, immutable');
  });

  it('gives a short positive TTL inside grace, never immutable', () => {
    expect(cacheControlFor('month', NOW - 10, NOW)).toBe('public, max-age=60');
    expect(cacheControlFor('week', NOW, NOW)).toBe('public, max-age=60');
    expect(cacheControlFor('edit', NOW - 10, NOW)).toBe('no-store');
  });
});

describe('host binding', () => {
  it('rejects a URL replayed against another host', async () => {
    const url = await blob('month');
    expect(await verifyBlobUrl(MASTER, url.replace(ORIGIN, OTHER_ORIGIN), NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });

    const base = await themeBase('month');
    expect(
      await verifyThemeUrl(MASTER, `${base.replace(ORIGIN, OTHER_ORIGIN)}theme.css`, NOW)
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects the same host on a different port', async () => {
    const url = await blob('month');
    expect(await verifyBlobUrl(MASTER, url.replace(HOST, `${HOST}:8443`), NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('does not distinguish http from https on the same host', async () => {
    const url = await blob('month');
    const overHttp = await verifyBlobUrl(MASTER, url.replace('https://', 'http://'), NOW);
    expect(overHttp.ok).toBe(true);
  });

  it('is case-insensitive about the host', async () => {
    const url = await blob('month');
    const shouted = await verifyBlobUrl(MASTER, url.replace(HOST, HOST.toUpperCase()), NOW);
    expect(shouted.ok).toBe(true);
  });
});

describe('query parameters', () => {
  it('rejects a repeated key', async () => {
    const withWidth = await blob('month', { w: 800 });
    expect(await verifyBlobUrl(MASTER, `${withWidth}&w=2560`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const url = await blob('month');
    expect(await verifyBlobUrl(MASTER, `${url}&sig=AAAA`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects an unsigned extra key', async () => {
    const url = await blob('month');
    for (const extra of ['attacker=1', 'utm_source=x', 'W=800']) {
      expect(await verifyBlobUrl(MASTER, `${url}&${extra}`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('accepts exactly the allowlist', async () => {
    const url = await blob('month', { w: 1600, fmt: 'webp' });
    expect([...new URL(url).searchParams.keys()].sort()).toEqual([
      'exp',
      'fmt',
      'p',
      'sig',
      'v',
      'w',
    ]);
    expect((await verifyBlobUrl(MASTER, url, NOW)).ok).toBe(true);
  });

  it('rejects any query at all on a theme URL', async () => {
    const base = await themeBase('month');
    expect((await verifyThemeUrl(MASTER, `${base}theme.css`, NOW)).ok).toBe(true);
    for (const query of ['?x=1', '?p=edit', '?sig=AAAA']) {
      expect(await verifyThemeUrl(MASTER, `${base}theme.css${query}`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

describe('relPath decoding', () => {
  it('rejects a double-encoded traversal', async () => {
    const base = await themeBase('month');
    for (const relPath of [
      '%252e%252e%252fsecret.css',
      'css/%252e%252e%252f%252e%252e%252fsecret.css',
      '%252e%252e',
    ]) {
      expect(await verifyThemeUrl(MASTER, `${base}${relPath}`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects an encoded separator, backslash, or NUL', async () => {
    const base = await themeBase('month');
    for (const relPath of ['a%5c..%5cb.css', 'a%2fb.css', 'theme%00.css']) {
      expect(await verifyThemeUrl(MASTER, `${base}${relPath}`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('collapses a singly-encoded dot segment inside the folder instead of escaping', async () => {
    const base = await themeBase('month');
    const result = await verifyThemeUrl(MASTER, `${base}css/%2e%2e/theme.css`, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.relPath).toBe('theme.css');
      expect(result.relPath).not.toContain('..');
    }
  });

  it('guards segments that never went through URL normalization', () => {
    expect(normalizeRelPath([])).toBe('');
    expect(normalizeRelPath([''])).toBe('');
    expect(normalizeRelPath(['css', 'main.css'])).toBe('css/main.css');
    expect(normalizeRelPath(['css', ''])).toBe('css');
    expect(normalizeRelPath(['hero%20shot.png'])).toBe('hero shot.png');

    for (const segments of [
      ['..'],
      ['.'],
      ['a', '..', 'b'],
      ['', 'css'],
      ['a', '', 'b'],
      ['%2e%2e'],
      ['%252e%252e'],
      ['a%5cb'],
      ['a%2fb'],
      ['a%00b'],
    ]) {
      expect(normalizeRelPath(segments)).toBeNull();
    }
  });
});

/**
 * Rotation: verification accepts an ordered list of masters, the current one
 * first. Signing never does — the apps mint under one key, and the second slot
 * exists only so URLs already in browsers and caches survive the change.
 */
describe('key rotation', () => {
  /** The key rotated IN. `MASTER` plays the one being retired. */
  const ROTATED = 'the-rotated-in-master-secret';
  const both = [ROTATED, MASTER] as const;

  const mintedUnder = (master: string) =>
    signBlobUrl(ORIGIN, ctx('month', { master }), { sha: SHA, ext: 'png' });

  it('verifies a current-key URL and says which key did it', async () => {
    const url = await mintedUnder(ROTATED);
    const result = await verifyBlobUrl(both, url, NOW);
    expect(result.ok && result.keySlot).toBe('current');
  });

  it('verifies a previous-key URL and reports the previous slot', async () => {
    const url = await mintedUnder(MASTER);
    const result = await verifyBlobUrl(both, url, NOW);
    expect(result.ok && result.keySlot).toBe('previous');
  });

  it('reports the current slot for the single-key API', async () => {
    const url = await mintedUnder(MASTER);
    expect((await verifyBlobUrl(MASTER, url, NOW)).ok).toBe(true);
    const result = await verifyBlobUrl(MASTER, url, NOW);
    expect(result.ok && result.keySlot).toBe('current');
    // A one-element list is the same thing spelled differently.
    const asList = await verifyBlobUrl([MASTER], url, NOW);
    expect(asList.ok && asList.keySlot).toBe('current');
  });

  it('rejects a URL neither key signed', async () => {
    const url = await mintedUnder(OTHER_MASTER);
    expect(await verifyBlobUrl(both, url, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('stops accepting the previous key once the slot is cleared', async () => {
    const url = await mintedUnder(MASTER);

    // While the rotation is in flight, the old URL still works.
    const during = await verifyBlobUrl(both, url, NOW);
    expect(during.ok && during.keySlot).toBe('previous');

    // Clearing the slot — dropping the entry, or blanking it — retires it.
    expect(await verifyBlobUrl([ROTATED], url, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    expect(await verifyBlobUrl([ROTATED, ''], url, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('treats a whitespace-only slot as cleared, not as a key', async () => {
    // The realistic way a slot gets "emptied": a space or a stray newline left
    // behind in a secret store. Honouring it would make ` ` a live master key.
    for (const blank of ['   ', '\n', '\t ']) {
      expect(await verifyBlobUrl([ROTATED, blank], await mintedUnder(MASTER), NOW)).toEqual({
        ok: false,
        reason: 'bad-signature',
      });

      const signedWithBlank = await signBlobUrl(ORIGIN, ctx('month', { master: blank }), {
        sha: SHA,
        ext: 'png',
      });
      expect(await verifyBlobUrl([ROTATED, blank], signedWithBlank, NOW)).toEqual({
        ok: false,
        reason: 'bad-signature',
      });
    }

    // And a list of nothing but blanks is still an unconfigured deployment.
    await expect(verifyBlobUrl(['  ', '\n'], await mintedUnder(MASTER), NOW)).rejects.toThrow(
      TypeError
    );
  });

  it('never trims a key it does accept', async () => {
    // Trimming here would silently disagree with the apps, which sign with the
    // exact bytes their secret store handed them.
    const padded = `  ${MASTER}  `;
    const url = await mintedUnder(padded);
    expect((await verifyBlobUrl(padded, url, NOW)).ok).toBe(true);
    expect((await verifyBlobUrl(MASTER, url, NOW)).ok).toBe(false);
  });

  it('applies the same fallback to theme URLs', async () => {
    const base = await signThemeBase(ORIGIN, ctx('month', { master: MASTER }), {
      theme: 'cosmo-dark',
      treeSha: TREE_SHA,
    });
    const result = await verifyThemeUrl(both, `${base}css/site.css`, NOW);
    expect(result.ok && result.keySlot).toBe('previous');
    expect(result.ok && result.relPath).toBe('css/site.css');
  });

  it('refuses to verify with no usable key at all', async () => {
    const url = await mintedUnder(MASTER);
    // Not `bad-signature`: an unconfigured deployment is a deployment bug, and
    // reporting it as a forged URL would send the operator hunting an attacker.
    await expect(verifyBlobUrl([], url, NOW)).rejects.toThrow(TypeError);
    await expect(verifyBlobUrl('', url, NOW)).rejects.toThrow(TypeError);
    await expect(verifyBlobUrl(['', ''], url, NOW)).rejects.toThrow(TypeError);
  });

  it('keys the derived-key cache by master, not just classroom and version', async () => {
    clearKeyCache();

    // Same classroom and keyVersion under both masters: everything in the
    // cache key except the master itself is identical, so a cache that ignored
    // the master would hand the second derive the first one's key.
    const currentUrl = await mintedUnder(ROTATED);
    expect((await verifyBlobUrl(ROTATED, currentUrl, NOW)).ok).toBe(true);

    const previousUrl = await mintedUnder(MASTER);
    expect(previousUrl).not.toBe(currentUrl);
    expect((await verifyBlobUrl(MASTER, previousUrl, NOW)).ok).toBe(true);

    expect((await verifyBlobUrl(MASTER, currentUrl, NOW)).ok).toBe(false);
    expect((await verifyBlobUrl(ROTATED, previousUrl, NOW)).ok).toBe(false);
  });
});
