/**
 * Unit tests for the first-paint guarantee on image (and video, embed, avatar)
 * blocks.
 *
 * The regression: a block's `src` was only corrected in an effect, so the FIRST
 * commit carried the bare stored reference — `pages/lab-1/assets/loop.gif` —
 * and the browser started fetching it against the pages origin before React
 * swapped in the signed URL. Observed in DevTools on staging as a 404 that
 * precedes every image the rendition ladder does not cover: a GIF, an SVG,
 * anything non-raster. Raster images never showed it, and never fixed it
 * either: their `srcset` is computed synchronously, so the browser had a
 * candidate to prefer over `src` and simply never asked for it.
 *
 * The fix is that the answer was never actually async. The loader ships the
 * whole `ref → signed URL` map with the document; `useAssetMap` seeds it during
 * render; `useAssetDisplayUrl` hands it to blocks through context. So these
 * tests pin two things:
 *
 *  - the lookup itself — a seeded ref resolves, everything else passes through;
 *  - that a block rendered with a seeded map emits the signed URL in its very
 *    first HTML, with a `resolveFileUrl` that NEVER settles. If the async path
 *    were still load-bearing, that render would emit the bare path.
 */

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { test, expect } from '@playwright/test';

import { lookupDisplayUrl, seedAssetMap } from '../../app/hooks/useAssetMap.ts';
import {
  AssetDisplayUrlContext,
  IDENTITY_DISPLAY_URL,
  type DisplayUrlLookup,
} from '../../app/hooks/useAssetDisplayUrl.ts';
import { useResolvedFileUrl } from '../../app/components/editor/blocks/useResolvedFileUrl.ts';

const GIF = 'pages/lab-1/assets/loop.gif';
const SIGNED = 'https://content.classmoji.io/c/abc/blob/aaa.gif?p=week&sig=x';
const EXTERNAL = 'https://example.edu/mascot.svg';

test.describe('seedAssetMap', () => {
  test('folds the loader payload into the map', () => {
    const map = seedAssetMap(new Map(), { [GIF]: SIGNED });
    expect(map.get(GIF)).toBe(SIGNED);
  });

  test('merges rather than replaces, so an upload survives a revalidation', () => {
    // `remember` put this there: the asset exists in the repo but the server's
    // map has no row for it yet, so the next loader payload will not mention it.
    const map = seedAssetMap(new Map(), { [GIF]: SIGNED });
    map.set('pages/lab-1/assets/fresh.png', 'https://content.classmoji.io/c/abc/blob/new.png');

    seedAssetMap(map, { [GIF]: `${SIGNED}&t=2` });

    expect(map.get(GIF), 'the reloaded signature wins').toBe(`${SIGNED}&t=2`);
    expect(map.get('pages/lab-1/assets/fresh.png'), 'the upload is still resolvable').toBe(
      'https://content.classmoji.io/c/abc/blob/new.png'
    );
  });

  test('an absent payload is a no-op, not a wipe', () => {
    const map = seedAssetMap(new Map(), { [GIF]: SIGNED });
    expect(seedAssetMap(map, null).get(GIF)).toBe(SIGNED);
    expect(seedAssetMap(map, undefined).get(GIF)).toBe(SIGNED);
  });
});

test.describe('lookupDisplayUrl', () => {
  const map = new Map([[GIF, SIGNED]]);

  test('a seeded reference resolves to its signed URL', () => {
    expect(lookupDisplayUrl(map, GIF)).toBe(SIGNED);
  });

  test('anything else comes back untouched', () => {
    // An external image, a data URI and a ref this document has never heard of
    // are all the same case, and the reference IS the URL for all three — which
    // is also what a deployment with the delivery layer off gets for every ref.
    expect(lookupDisplayUrl(map, EXTERNAL)).toBe(EXTERNAL);
    expect(lookupDisplayUrl(map, 'data:image/gif;base64,R0lGOD')).toBe(
      'data:image/gif;base64,R0lGOD'
    );
    expect(lookupDisplayUrl(map, 'pages/lab-2/assets/loop.gif')).toBe(
      'pages/lab-2/assets/loop.gif'
    );
    expect(lookupDisplayUrl(new Map(), GIF)).toBe(GIF);
  });

  test('empty, null and undefined pass through without a lookup', () => {
    expect(lookupDisplayUrl(map, '')).toBe('');
    expect(lookupDisplayUrl(map, null)).toBeNull();
    expect(lookupDisplayUrl(map, undefined)).toBeUndefined();
  });
});

/** A block, reduced to the one thing under test: what lands in `src`. */
function ImageUnderTest({
  url,
  resolveFileUrl,
}: {
  url: string;
  resolveFileUrl?: (url: string) => Promise<string>;
}) {
  return createElement('img', { src: useResolvedFileUrl(url, resolveFileUrl) });
}

/** A resolver that NEVER settles: only the synchronous path can answer. */
const neverResolves = () => new Promise<string>(() => {});

function firstPaint(element: ReactElement): string {
  const match = renderToStaticMarkup(element).match(/src="([^"]*)"/);
  // `&` in a signed URL's query comes back as `&amp;` — an HTML fact about the
  // serializer, not about the value React put in the attribute.
  return match ? match[1].replace(/&amp;/g, '&') : '';
}

function withMap(map: Record<string, string>, element: ReactElement): ReactElement {
  const displayUrl: DisplayUrlLookup = ref => lookupDisplayUrl(seedAssetMap(new Map(), map), ref);
  return createElement(AssetDisplayUrlContext.Provider, { value: displayUrl }, element);
}

test.describe('first paint', () => {
  test('a seeded ref is signed in the very first commit', () => {
    // The whole bug, in one assertion: no effect has run, no promise has
    // settled, and the markup already carries the signed URL. The bare path is
    // never in the DOM, so the browser never requests it.
    const html = firstPaint(
      withMap(
        { [GIF]: SIGNED },
        createElement(ImageUnderTest, { url: GIF, resolveFileUrl: neverResolves })
      )
    );

    expect(html).toBe(SIGNED);
    expect(html).not.toContain(GIF);
  });

  test('a ref the map does not have falls back to the reference', () => {
    // Not a regression — the reference is the correct URL when the delivery
    // layer is off, and the async resolver is still there for the rest.
    expect(
      firstPaint(
        withMap(
          { [GIF]: SIGNED },
          createElement(ImageUnderTest, { url: EXTERNAL, resolveFileUrl: neverResolves })
        )
      )
    ).toBe(EXTERNAL);
  });

  test('with no provider above it, a block renders the reference', () => {
    // The default context is the identity, so a surface that never mounts a
    // provider degrades exactly as it did before any of this existed.
    expect(IDENTITY_DISPLAY_URL(GIF)).toBe(GIF);
    expect(
      firstPaint(createElement(ImageUnderTest, { url: GIF, resolveFileUrl: neverResolves }))
    ).toBe(GIF);
  });

  test('no resolver at all is still the reference, not an empty src', () => {
    expect(firstPaint(createElement(ImageUnderTest, { url: GIF }))).toBe(GIF);
  });
});
