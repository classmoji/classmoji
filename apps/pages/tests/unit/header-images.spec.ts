/**
 * Unit tests for the page-list header image swap
 * (`app/utils/headerImages.ts`).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module is pure, which is exactly why the collect-and-swap lives there and the
 * resolve lives in the loader.
 *
 * The regression behind it: `pages.header_image_url` is a legacy DB column, and
 * every list view rendered it STRAIGHT from the row. A page render resolves its
 * cover; the list beside it did not, so the same image was a signed URL on the
 * page and a bare repo path — a 404 against the pages origin — in the list.
 */

import { test, expect } from '@playwright/test';
import { headerImageRefs, withResolvedHeaderImages } from '../../app/utils/headerImages.ts';

const REF = 'pages/lab-1/assets/hero.png';
const SIGNED = 'https://content.classmoji.io/c/abc/blob/aaa.png?p=enrolled&sig=x';

test.describe('headerImageRefs', () => {
  test('collects each reference once and skips rows without one', () => {
    const refs = headerImageRefs([
      { header_image_url: REF },
      { header_image_url: REF },
      { header_image_url: null },
      { header_image_url: '' },
      {},
      { header_image_url: 'pages/lab-2/assets/b.png' },
    ]);

    expect(refs).toEqual([REF, 'pages/lab-2/assets/b.png']);
  });

  test('is empty for a list with no thumbnails, so the loader can skip the resolve', () => {
    expect(headerImageRefs([{ header_image_url: null }, {}])).toEqual([]);
  });
});

test.describe('withResolvedHeaderImages', () => {
  test('swaps a resolved reference and leaves the rest of the row alone', () => {
    const pages = [{ id: 'p1', title: 'Lab 1', header_image_url: REF }];

    const out = withResolvedHeaderImages(pages, new Map([[REF, SIGNED]]));

    expect(out[0]).toEqual({ id: 'p1', title: 'Lab 1', header_image_url: SIGNED });
  });

  test('leaves a miss as the stored reference — external images, data: URIs, layer off', () => {
    const pages = [
      { header_image_url: 'https://images.example.com/x.png' },
      { header_image_url: 'data:image/png;base64,AAAA' },
      { header_image_url: REF },
    ];

    const out = withResolvedHeaderImages(pages, new Map());

    expect(out.map(p => p.header_image_url)).toEqual([
      'https://images.example.com/x.png',
      'data:image/png;base64,AAAA',
      REF,
    ]);
  });

  test('returns unchanged rows by identity', () => {
    // Not a micro-optimization for its own sake: the loader passes these rows
    // straight into the payload, and a fresh object per row on every request
    // would be pure garbage for the common case of a list with no thumbnails.
    const row = { header_image_url: null };
    const resolvedRow = { header_image_url: REF };

    const out = withResolvedHeaderImages([row, resolvedRow], new Map([[REF, REF]]));

    expect(out[0]).toBe(row);
    // A resolve that answers with the reference itself is a miss, not a change.
    expect(out[1]).toBe(resolvedRow);
  });
});
