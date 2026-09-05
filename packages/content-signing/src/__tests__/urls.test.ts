import { describe, expect, it } from 'vitest';

import { bucketExpiry } from '../bucket.ts';
import {
  TRANSFORM_WIDTHS,
  blobCanonicalString,
  hostOf,
  themeCanonicalString,
} from '../canonical.ts';
import { signBlobUrl, signSrcSet, signThemeBase } from '../urls.ts';
import { parseContentUrl } from '../verify.ts';
import { CLASSROOM_A, HOST, NOW, ORIGIN, SHA, TREE_SHA, ctx } from './fixtures.ts';

function widthOf(url: string): number | null {
  const raw = new URL(url).searchParams.get('w');
  return raw === null ? null : Number(raw);
}

function entriesOf(srcset: string): { url: string; descriptor: number }[] {
  return srcset.split(', ').map(entry => {
    const [url, descriptor] = entry.split(' ');
    return { url, descriptor: Number(descriptor.replace(/w$/, '')) };
  });
}

describe('hostOf', () => {
  it('lowercases, keeps the port, and ignores the scheme', () => {
    expect(hostOf('https://CDN.Classmoji.Test')).toBe('cdn.classmoji.test');
    expect(hostOf('http://cdn.classmoji.test')).toBe('cdn.classmoji.test');
    expect(hostOf('https://cdn.classmoji.test:8443/base')).toBe('cdn.classmoji.test:8443');
    expect(() => hostOf('not-a-url')).toThrow(TypeError);
  });
});

describe('canonical strings', () => {
  it('pins the blob shape', () => {
    expect(
      blobCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        sha: SHA,
        ext: 'png',
        tier: 'public',
        keyVersion: 3,
        exp: 1767225600,
      })
    ).toBe(`cm1|blob|${HOST}|${CLASSROOM_A}|${SHA}|png|public|3|1767225600||`);

    expect(
      blobCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        sha: SHA,
        ext: 'png',
        tier: 'draft',
        keyVersion: 0,
        exp: 1767225600,
        transform: { w: 1600, fmt: 'avif' },
      })
    ).toBe(`cm1|blob|${HOST}|${CLASSROOM_A}|${SHA}|png|draft|0|1767225600|1600|avif`);
  });

  it('pins the theme shape', () => {
    expect(
      themeCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        theme: 'cosmo-dark',
        treeSha: TREE_SHA,
        tier: 'enrolled',
        keyVersion: 2,
        exp: 1767225600,
      })
    ).toBe(`cm1|theme|${HOST}|${CLASSROOM_A}|cosmo-dark|${TREE_SHA}|enrolled|2|1767225600`);
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

  it('rejects an origin with no host', async () => {
    await expect(
      signBlobUrl('cdn.classmoji.test', ctx('public'), { sha: SHA, ext: 'png' })
    ).rejects.toThrow(TypeError);
  });

  it('signs the text extensions the delivery layer serves', async () => {
    // Root content — a deck's index.html, a page's content.json, a theme's css
    // and fonts — is signed by exactly the same call an image is. There is no
    // separate text scheme and no per-extension allowlist: the extension is a
    // FIELD of the canonical string, so a signature for one extension can
    // never serve another.
    for (const ext of ['html', 'json', 'css', 'js', 'md', 'txt', 'svg', 'woff', 'woff2', 'ttf']) {
      const url = await signBlobUrl(ORIGIN, ctx('enrolled'), { sha: SHA, ext });
      expect(url.startsWith(`${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.${ext}?`)).toBe(true);
      const parsed = parseContentUrl(url);
      expect(parsed).toMatchObject({ kind: 'blob', sha: SHA, ext });
    }
  });

  it('gives one blob a different signature per extension', async () => {
    // The guarantee behind "never sniff" on the Worker: re-labelling a signed
    // .json as .html is not a URL edit, it is a forgery.
    const asJson = await signBlobUrl(ORIGIN, ctx('enrolled'), { sha: SHA, ext: 'json' });
    const asHtml = await signBlobUrl(ORIGIN, ctx('enrolled'), { sha: SHA, ext: 'html' });
    expect(new URL(asJson).searchParams.get('sig')).not.toBe(
      new URL(asHtml).searchParams.get('sig')
    );
  });

  it('rejects a nonsense now or keyVersion at mint', async () => {
    for (const now of [Number.NaN, -1, 1.5, Infinity]) {
      await expect(
        signBlobUrl(ORIGIN, ctx('public', { now }), { sha: SHA, ext: 'png' })
      ).rejects.toThrow(TypeError);
    }
    for (const keyVersion of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        signBlobUrl(ORIGIN, ctx('public', { keyVersion }), { sha: SHA, ext: 'png' })
      ).rejects.toThrow(TypeError);
    }
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

  it('rejects malformed refs, including a leading dot in the theme', async () => {
    await expect(
      signThemeBase(ORIGIN, ctx('public'), { theme: 'Cosmo Dark', treeSha: TREE_SHA })
    ).rejects.toThrow(TypeError);
    await expect(
      signThemeBase(ORIGIN, ctx('public'), { theme: 'cosmo', treeSha: 'nope' })
    ).rejects.toThrow(TypeError);
    for (const theme of ['.git', '..', '.', '.hidden']) {
      await expect(
        signThemeBase(ORIGIN, ctx('public'), { theme, treeSha: TREE_SHA })
      ).rejects.toThrow(TypeError);
    }
  });
});

describe('signSrcSet', () => {
  it('emits all three widths when the source width is unknown', async () => {
    const { src, srcset } = await signSrcSet(ORIGIN, ctx('public'), { sha: SHA, ext: 'png' });
    const entries = entriesOf(srcset);
    expect(entries.map(entry => entry.descriptor)).toEqual([800, 1600, 2560]);
    expect(widthOf(src)).toBe(2560);
  });

  it('never emits a width larger than sourceWidth', async () => {
    for (const sourceWidth of [800, 900, 1599, 1600, 1700, 2560, 4000]) {
      const { src, srcset } = await signSrcSet(ORIGIN, ctx('public'), {
        sha: SHA,
        ext: 'png',
        sourceWidth,
      });
      const entries = entriesOf(srcset);
      for (const entry of entries) {
        expect(entry.descriptor).toBeLessThanOrEqual(sourceWidth);
        const width = widthOf(entry.url);
        if (width !== null) expect(width).toBeLessThanOrEqual(sourceWidth);
      }
      // At most one candidate is the untransformed original.
      expect(entries.filter(entry => widthOf(entry.url) === null).length).toBeLessThanOrEqual(1);
      const srcWidth = widthOf(src);
      if (srcWidth !== null) expect(srcWidth).toBeLessThanOrEqual(sourceWidth);
    }
  });

  it('fills the gap with the original when the source sits between rungs', async () => {
    const { srcset } = await signSrcSet(ORIGIN, ctx('public'), {
      sha: SHA,
      ext: 'png',
      sourceWidth: 1599,
    });
    const entries = entriesOf(srcset);
    expect(entries.map(entry => entry.descriptor)).toEqual([800, 1599]);
    // The gap-filler is the untransformed original, not an upscale.
    expect(widthOf(entries[0].url)).toBe(800);
    expect(widthOf(entries[1].url)).toBeNull();
  });

  it('does not add an original above the top rung, where the cap is deliberate', async () => {
    for (const sourceWidth of [2560, 4000]) {
      const { srcset } = await signSrcSet(ORIGIN, ctx('public'), {
        sha: SHA,
        ext: 'png',
        sourceWidth,
      });
      expect(entriesOf(srcset).map(entry => entry.descriptor)).toEqual([800, 1600, 2560]);
    }
  });

  it('lands exactly on the ladder without a duplicate original', async () => {
    for (const sourceWidth of TRANSFORM_WIDTHS) {
      const { srcset } = await signSrcSet(ORIGIN, ctx('public'), {
        sha: SHA,
        ext: 'png',
        sourceWidth,
      });
      const entries = entriesOf(srcset);
      expect(entries.every(entry => widthOf(entry.url) !== null)).toBe(true);
      expect(entries.map(entry => entry.descriptor)).toEqual(
        TRANSFORM_WIDTHS.filter(width => width <= sourceWidth)
      );
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
      sourceWidth: 1599,
    });
    for (const entry of entriesOf(srcset)) {
      expect(new URL(entry.url).searchParams.get('fmt')).toBe('avif');
    }
  });

  it('rejects a nonsense sourceWidth', async () => {
    await expect(
      signSrcSet(ORIGIN, ctx('public'), { sha: SHA, ext: 'png', sourceWidth: 0 })
    ).rejects.toThrow(TypeError);
  });
});
