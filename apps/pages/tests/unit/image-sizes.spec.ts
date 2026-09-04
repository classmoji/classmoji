/**
 * Unit tests for the responsive-image decision (`app/utils/imageSizes.ts`).
 *
 * This is the whole of what a block decides about `srcset`/`sizes`, pulled out
 * of the two components that render an image so it can be tested without an
 * editor or a JSDOM. It is shared deliberately: the editor's image block keys
 * the map by the STORED reference (its blocks keep the reference and the
 * display URL rides beside them) and the class site keys it by the SIGNED url
 * (its documents are rewritten before they are rendered). Same map shape, same
 * decision, two keys — and the drift between them is what this pins.
 *
 * The regression behind it: `sizes` used to be one global 1024px constant, so
 * a 64px avatar and an image an author had resized to 300px both told the
 * browser they were a full column wide, and both fetched a 2560px rendition to
 * paint a fraction of it.
 */

import { test, expect } from '@playwright/test';
import {
  AVATAR_SIZES,
  IMAGE_SIZES,
  imageSizesFor,
  responsiveImageAttrs,
} from '../../app/utils/imageSizes.ts';

const REF = 'pages/lab-1/assets/hero.png';
const SIGNED = 'https://content.classmoji.io/c/abc/blob/aaa.png?p=enrolled&sig=x';
const LADDER = `${SIGNED}&w=800&fmt=auto 800w, ${SIGNED}&w=1600&fmt=auto 1600w`;

test.describe('imageSizesFor', () => {
  test('an author-resized image says how wide it will actually be', () => {
    // `previewWidth` is a CAP, not a fixed width — the block still shrinks with
    // the viewport — so `min()` is the honest translation of it.
    expect(imageSizesFor(300)).toBe('min(100vw, 300px)');
    expect(imageSizesFor(1280)).toBe('min(100vw, 1280px)');
    // Sub-pixel widths come out of a drag; the attribute takes integers.
    expect(imageSizesFor(300.4)).toBe('min(100vw, 300px)');
  });

  test('an unresized image falls back to the full article column', () => {
    for (const width of [null, undefined, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(imageSizesFor(width as number | null)).toBe(IMAGE_SIZES);
    }
  });

  test('the avatar hint is the fixed size of the slot, not a column width', () => {
    // `.profile-avatar-image` is 64x64 in blocknote-overrides.css. Saying so is
    // what makes the browser take the smallest rung even on a 3x display.
    expect(AVATAR_SIZES).toBe('64px');
    expect(AVATAR_SIZES).not.toBe(IMAGE_SIZES);
  });
});

test.describe('responsiveImageAttrs', () => {
  test('looks the candidates up by the key it is given — stored ref', () => {
    // The editor's key. The block has this synchronously on its first render;
    // the signed URL arrives later and depends on a clock, an expiry bucket and
    // the viewer's tier, so a block cannot key itself by one.
    const attrs = responsiveImageAttrs({ [REF]: LADDER }, REF, IMAGE_SIZES);

    expect(attrs).toEqual({ srcSet: LADDER, sizes: IMAGE_SIZES });
  });

  test('and by the signed URL, which is the key the class site uses', () => {
    const attrs = responsiveImageAttrs({ [SIGNED]: LADDER }, SIGNED, AVATAR_SIZES);

    expect(attrs).toEqual({ srcSet: LADDER, sizes: AVATAR_SIZES });
  });

  test('returns srcSet and sizes together or neither', () => {
    // A `srcSet` with no `sizes` makes the browser assume the image fills the
    // viewport and fetch the widest rung — worse than shipping no candidates.
    const hit = responsiveImageAttrs({ [REF]: LADDER }, REF, IMAGE_SIZES);
    expect(Object.keys(hit).sort()).toEqual(['sizes', 'srcSet']);
  });

  test('is empty for every reference that should render one size', () => {
    // A gif, an svg, an external image, a non-image, and a classroom the layer
    // is switched off for all arrive here as a miss.
    expect(responsiveImageAttrs({ [REF]: LADDER }, 'pages/lab-1/assets/loop.gif', IMAGE_SIZES))
      .toEqual({});
    expect(responsiveImageAttrs({}, REF, IMAGE_SIZES)).toEqual({});
    expect(responsiveImageAttrs(null, REF, IMAGE_SIZES)).toEqual({});
    expect(responsiveImageAttrs(undefined, REF, IMAGE_SIZES)).toEqual({});
  });

  test('never keys off an empty reference', () => {
    // A block with no image yet has `url: ''`. An empty string is a legal
    // object key, and a map that happened to hold one would decorate every
    // unset image block on the page.
    expect(responsiveImageAttrs({ '': LADDER }, '', IMAGE_SIZES)).toEqual({});
    expect(responsiveImageAttrs({ '': LADDER }, null, IMAGE_SIZES)).toEqual({});
  });
});
