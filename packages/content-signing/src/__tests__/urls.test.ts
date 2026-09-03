import { describe, expect, it } from 'vitest';

import { bucketExpiry } from '../bucket.ts';
import { TRANSFORM_WIDTHS, blobCanonicalString, themeCanonicalString } from '../canonical.ts';
import { signBlobUrl, signSrcSet, signThemeBase } from '../urls.ts';
import { parseContentUrl } from '../verify.ts';
import { CLASSROOM_A, NOW, ORIGIN, SHA, TREE_SHA, ctx } from './fixtures.ts';

function widthOf(url: string): number | null {
  const raw = new URL(url).searchParams.get('w');
  return raw === null ? null : Number(raw);
}

describe('canonical strings', () => {
  it('pins the blob shape', () => {
    expect(
      blobCanonicalString({
        classroomId: CLASSROOM_A,
        sha: SHA,
        ext: 'png',
        tier: 'public',
        keyVersion: 3,
        exp: 1767225600,
      })
    ).toBe(`cm1|blob|${CLASSROOM_A}|${SHA}|png|public|3|1767225600||`);

    expect(
      blobCanonicalString({
        classroomId: CLASSROOM_A,
        sha: SHA,
        ext: 'png',
        tier: 'draft',
        keyVersion: 0,
        exp: 1767225600,
        transform: { w: 1600, fmt: 'avif' },
      })
    ).toBe(`cm1|blob|${CLASSROOM_A}|${SHA}|png|draft|0|1767225600|1600|avif`);
  });

  it('pins the theme shape', () => {
    expect(
      themeCanonicalString({
        classroomId: CLASSROOM_A,
        theme: 'cosmo-dark',
        treeSha: TREE_SHA,
        tier: 'enrolled',
        keyVersion: 2,
        exp: 1767225600,
      })
    ).toBe(`cm1|theme|${CLASSROOM_A}|cosmo-dark|${TREE_SHA}|enrolled|2|1767225600`);
  });
});

describe('signBlobUrl', () => {
  it('emits the documented shape', async () => {
    const url = await signBlobUrl(ORIGIN, ctx('public'), { sha: SHA, ext: 'png' });
    const exp = bucketExpiry('public', CLASSROOM_A, NOW);
    expect(url.startsWith(`${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?`)).toBe(true);

    const params = new URL(url).searchParams;
    expect(params.get('p')).toBe('public');
    expect(params.get('v')).toBe('0');
    expect(params.get('exp')).toBe(String(exp));
    expect(params.get('sig')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('w')).toBeNull();
    expect(params.get('fmt')).toBeNull();
  });

  it('carries transform params', async () => {
    const url = await signBlobUrl(ORIGIN, ctx('enrolled'), {
      sha: SHA,
      ext: 'jpg',
      transform: { w: 2560, fmt: 'webp' },
    });
    const params = new URL(url).searchParams;
    expect(params.get('w')).toBe('2560');
    expect(params.get('fmt')).toBe('webp');
  });

  it('is byte-identical for every mint inside one bucket', async () => {
    const first = await signBlobUrl(ORIGIN, ctx('public'), { sha: SHA, ext: 'png' });
    const later = await signBlobUrl(ORIGIN, ctx('public', { now: NOW + 3600 }), {
      sha: SHA,
      ext: 'png',
    });
    expect(later).toBe(first);
  });

  it('trims a trailing slash off the origin', async () => {
    const url = await signBlobUrl(`${ORIGIN}/`, ctx('public'), { sha: SHA, ext: 'png' });
    expect(url.startsWith(`${ORIGIN}/c/`)).toBe(true);
  });

  it('rejects malformed refs', async () => {
    await expect(signBlobUrl(ORIGIN, ctx('public'), { sha: 'nope', ext: 'png' })).rejects.toThrow(
      TypeError
    );
    await expect(signBlobUrl(ORIGIN, ctx('public'), { sha: SHA, ext: 'PNG' })).rejects.toThrow(
      TypeError
    );
    await expect(
      // @ts-expect-error - exercising the runtime guard
      signBlobUrl(ORIGIN, ctx('public'), { sha: SHA, ext: 'png', transform: { w: 1024 } })
    ).rejects.toThrow(TypeError);
  });
});

describe('signThemeBase', () => {
  it('puts the policy in the path and ends with a slash', async () => {
    const base = await signThemeBase(ORIGIN, ctx('enrolled'), {
      theme: 'cosmo-dark',
      treeSha: TREE_SHA,
    });
    const exp = bucketExpiry('enrolled', CLASSROOM_A, NOW);
    expect(base.endsWith('/')).toBe(true);

    const prefix = `${ORIGIN}/c/${CLASSROOM_A}/theme/cosmo-dark/${TREE_SHA}/`;
    expect(base.startsWith(prefix)).toBe(true);

    const policy = base.slice(prefix.length, -1).split('.');
    expect(policy.length).toBe(4);
    expect(policy[0]).toBe('enrolled');
    expect(policy[1]).toBe('0');
    expect(policy[2]).toBe(String(exp));
    expect(policy[3]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('authorizes any relative path under the folder', async () => {
    const base = await signThemeBase(ORIGIN, ctx('public'), {
      theme: 'cosmo-dark',
      treeSha: TREE_SHA,
    });
    const parsed = parseContentUrl(`${base}fonts/inter.woff2`);
    expect(parsed?.kind).toBe('theme');
    expect(parsed && parsed.kind === 'theme' ? parsed.relPath : null).toBe('fonts/inter.woff2');
  });

  it('rejects malformed refs', async () => {
    await expect(
      signThemeBase(ORIGIN, ctx('public'), { theme: 'Cosmo Dark', treeSha: TREE_SHA })
    ).rejects.toThrow(TypeError);
    await expect(
      signThemeBase(ORIGIN, ctx('public'), { theme: 'cosmo', treeSha: 'nope' })
    ).rejects.toThrow(TypeError);
  });
});

describe('signSrcSet', () => {
  it('emits all three widths when the source width is unknown', async () => {
    const { src, srcset } = await signSrcSet(ORIGIN, ctx('public'), { sha: SHA, ext: 'png' });
    const entries = srcset.split(', ');
    expect(entries.length).toBe(3);
    expect(entries.map(entry => entry.split(' ')[1])).toEqual(['800w', '1600w', '2560w']);
    expect(widthOf(src)).toBe(2560);
  });

  it('never emits a width larger than sourceWidth', async () => {
    for (const sourceWidth of [800, 900, 1600, 1700, 2560, 4000]) {
      const { src, srcset } = await signSrcSet(ORIGIN, ctx('public'), {
        sha: SHA,
        ext: 'png',
        sourceWidth,
      });
      const urls = srcset.split(', ').map(entry => entry.split(' ')[0]);
      for (const url of urls) {
        const width = widthOf(url);
        expect(width).not.toBeNull();
        expect(width as number).toBeLessThanOrEqual(sourceWidth);
      }
      expect(urls.length).toBe(TRANSFORM_WIDTHS.filter(w => w <= sourceWidth).length);
      expect(widthOf(src)).toBeLessThanOrEqual(sourceWidth);
    }
  });

  it('serves an untransformed original when the source is narrower than 800', async () => {
    const { src, srcset } = await signSrcSet(ORIGIN, ctx('public'), {
      sha: SHA,
      ext: 'png',
      sourceWidth: 500,
    });
    expect(widthOf(src)).toBeNull();
    expect(srcset).toBe(`${src} 500w`);
  });

  it('threads the format through every rendition', async () => {
    const { srcset } = await signSrcSet(ORIGIN, ctx('public'), {
      sha: SHA,
      ext: 'png',
      fmt: 'avif',
    });
    for (const entry of srcset.split(', ')) {
      expect(new URL(entry.split(' ')[0]).searchParams.get('fmt')).toBe('avif');
    }
  });

  it('rejects a nonsense sourceWidth', async () => {
    await expect(
      signSrcSet(ORIGIN, ctx('public'), { sha: SHA, ext: 'png', sourceWidth: 0 })
    ).rejects.toThrow(TypeError);
  });
});
