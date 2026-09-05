/**
 * The read-time asset rewrite for deck HTML.
 *
 * What this guards is that the pass is a DOM pass and behaves like one: it
 * changes the attributes that actually carry a URL — including Reveal's
 * slide-background pair, which is a repo asset addressed from `data-*` rather
 * than from an `<img>` — leaves everything the resolver declines
 * byte-identical, and — the reason it is not a regex — does not touch
 * URL-shaped text that merely lives inside an author's `data-*` attribute or
 * code sample.
 */

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  collectDeckAssetRefs,
  collectSlideAttrRefs,
  rewriteDeckAssetUrls,
  rewriteFragmentAssetUrls,
  rewriteSlideAttrs,
} from '../deckAssets.ts';

const SIGNED = 'https://cdn.test/c/3f2504e0-4f89-41d3-9a0c-0305e82c3301/blob/abc.png?sig=x';
const REF = '/content/org/repo/slides/deck/images/a.png';

/** Resolve only what the test names, exactly as the route's resolver does. */
const resolver = (pairs: Record<string, string>) => async (refs: string[]) =>
  new Map(refs.filter(ref => ref in pairs).map(ref => [ref, pairs[ref]]));

describe('rewriteDeckAssetUrls', () => {
  it('rewrites src, href, srcset and inline style url() together', async () => {
    const html = [
      `<img src="${REF}">`,
      `<a href="${REF}">download</a>`,
      `<img srcset="${REF} 800w, ${REF} 1600w">`,
      `<div style="background-image: url('${REF}'); color: red"></div>`,
    ].join('');

    const out = await rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }));

    expect(out).toContain(`src="${SIGNED}"`);
    expect(out).toContain(`href="${SIGNED}"`);
    // Descriptors survive, and each candidate is rewritten independently.
    expect(out).toContain(`${SIGNED} 800w, ${SIGNED} 1600w`);
    expect(out).toContain(`url('${SIGNED}')`);
    // Untouched declarations in the same style attribute stay put.
    expect(out).toContain('color: red');
    expect(out).not.toContain(REF);
  });

  it('leaves every reference the resolver declines exactly as it found it', async () => {
    const html =
      '<img src="https://example.com/x.png">' +
      '<a href="https://docs.example.com/guide">docs</a>' +
      '<link rel="stylesheet" href="/content/org/repo/.slidesthemes/midnight/lib/offline-v2.css">';

    // The theme link is precisely the case the route's resolver filters out:
    // themes are signed as a FOLDER so their relative url() keeps resolving.
    await expect(rewriteDeckAssetUrls(html, resolver({}))).resolves.toBe(html);
  });

  it('does NOT touch a URL that only appears inside an author-controlled attribute', async () => {
    // The reason this is a DOM pass. A regex over `src="..."` matches here.
    const html = `<pre data-code="&lt;img src=&quot;${REF}&quot;&gt;"></pre>`;

    await expect(rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }))).resolves.toBe(html);
  });

  it('returns the input untouched when nothing resolves — no re-serialization', async () => {
    const html = '<section><p>no assets here</p></section>';
    await expect(rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }))).resolves.toBe(html);
  });

  it("signs Reveal's slide background image", async () => {
    const html = `<section ${'data-background-image'}="${REF}" data-background-size="cover"><h2>t</h2></section>`;

    const out = await rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }));

    expect(out).toContain(`data-background-image="${SIGNED}"`);
    // Sibling background settings are not URLs and are left alone.
    expect(out).toContain('data-background-size="cover"');
    expect(out).not.toContain(REF);
  });

  it('leaves a foreign or inline slide background exactly as it found it', async () => {
    const html =
      '<section data-background-image="https://example.com/hero.png"></section>' +
      '<section data-background-image="data:image/gif;base64,R0lGOD"></section>' +
      // A page to embed, not an asset: never signed, whatever the resolver says.
      `<section data-background-iframe="${REF}"></section>`;

    await expect(rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }))).resolves.toBe(html);
  });

  it('signs each source of a background video list and keeps the order', async () => {
    const FOREIGN = 'https://example.com/promo.webm';
    const MP4 = '/content/org/repo/slides/deck/video/clip.mp4';
    const MP4_SIGNED = 'https://cdn.test/c/3f2504e0-4f89-41d3-9a0c-0305e82c3301/blob/def.mp4?sig=y';
    const html = `<section data-background-video="${MP4}, ${FOREIGN}" data-background-video-loop></section>`;

    const out = await rewriteDeckAssetUrls(html, resolver({ [MP4]: MP4_SIGNED }));

    expect(out).toContain(`data-background-video="${MP4_SIGNED},${FOREIGN}"`);
    expect(out).not.toContain(MP4);
  });

  it('leaves a background video list alone when no source resolves', async () => {
    const html =
      '<section data-background-video="https://example.com/a.mp4, https://example.com/b.webm"></section>';

    await expect(rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }))).resolves.toBe(html);
  });

  it("escapes a signed URL's query string so it survives serialization", async () => {
    // Every real signed URL carries a multi-parameter policy. Serialized into
    // an attribute the `&` must become `&amp;`, and must decode back to the
    // exact URL the resolver minted — an over- or under-escaped one is a
    // broken signature, not a cosmetic difference.
    const MULTI = `https://cdn.test/c/3f2504e0-4f89-41d3-9a0c-0305e82c3301/blob/abc.png?p=week&v=0&exp=1&sig=abc`;
    const html = `<section data-background-image="${REF}"><img src="${REF}"></section>`;

    const out = await rewriteDeckAssetUrls(html, resolver({ [REF]: MULTI }));

    expect(out).toContain('?p=week&amp;v=0&amp;exp=1&amp;sig=abc');
    expect(out).not.toContain('?p=week&v=0');

    // Re-parsing is what the browser and the deck parser both do; the URL that
    // comes back out must be the one that went in.
    const $ = cheerio.load(out);
    expect($('img').attr('src')).toBe(MULTI);
    expect($('section').attr('data-background-image')).toBe(MULTI);
  });

  it('keeps a full document a full document', async () => {
    const html = `<!DOCTYPE html><html><head><title>d</title></head><body><img src="${REF}"></body></html>`;

    const out = await rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }));

    expect(out).toContain('<!DOCTYPE html>');
    expect(out).toContain('<title>d</title>');
    expect(out).toContain(`src="${SIGNED}"`);
  });
});

/**
 * The fragment pass — the one the SAVE path runs.
 *
 * A stored slide's `html` is the inner content of its `<section>`, not a
 * document. `cheerio.load` promotes a fragment to `<html><head><body>` on
 * parse, so the read-side pass gets away with serializing the root only
 * because it always runs on a whole generated deck. Running that on a slide
 * would have wrapped every rewritten slide in a document.
 */
describe('rewriteFragmentAssetUrls', () => {
  const map = (pairs: Record<string, string>) => (ref: string) => pairs[ref];

  it('rewrites a fragment without wrapping it in a document', () => {
    const out = rewriteFragmentAssetUrls(
      `<h2>Title</h2><img src="${REF}">`,
      map({ [REF]: SIGNED })
    );

    expect(out).toBe(`<h2>Title</h2><img src="${SIGNED}">`);
    expect(out).not.toContain('<html');
    expect(out).not.toContain('<body');
  });

  it('returns the input string by identity when nothing maps', () => {
    // Identity, not an equal string: it is what keeps an untouched slide from
    // being re-serialized (and re-normalized) on every single save.
    const html = `<img src="${REF}">`;
    expect(rewriteFragmentAssetUrls(html, map({}))).toBe(html);
    expect(rewriteFragmentAssetUrls('<p>no assets at all</p>', map({ [REF]: SIGNED }))).toBe(
      '<p>no assets at all</p>'
    );
  });

  it('drops a srcset the predicate claims, and keeps one it does not', () => {
    const ours = rewriteFragmentAssetUrls(
      `<img src="${REF}" srcset="${REF} 800w" sizes="100vw">`,
      map({ [REF]: SIGNED }),
      { isOwnRef: ref => ref === REF }
    );
    expect(ours).toContain(`src="${SIGNED}"`);
    expect(ours).not.toContain('srcset');
    // `sizes` goes with it — a hint for a set that no longer exists is noise.
    expect(ours).not.toContain('sizes');

    const theirs = `<img src="${REF}" srcset="https://cdn.example.com/a@2x.png 2x">`;
    expect(rewriteFragmentAssetUrls(theirs, map({}), { isOwnRef: ref => ref === REF })).toBe(
      theirs
    );
  });

  it('emits a responsive set on an <img>, and never on a background attribute', () => {
    const withSet = rewriteFragmentAssetUrls(`<img src="${REF}">`, map({}), {
      srcSets: new Map([[REF, `${SIGNED} 800w`]]),
      sizes: '100vw',
    });
    expect(withSet).toContain(`srcset="${SIGNED} 800w"`);
    expect(withSet).toContain('sizes="100vw"');

    // Reveal paints these as a CSS background, where `srcset` does not exist.
    const background = `<section data-background-image="${REF}"></section>`;
    expect(
      rewriteFragmentAssetUrls(background, map({}), {
        srcSets: new Map([[REF, `${SIGNED} 800w`]]),
        sizes: '100vw',
      })
    ).toBe(background);
  });
});

/**
 * A slide's `<section>` attributes live in a plain map, not in its HTML — so
 * `data-background-image`, `data-background-video` and `style` are invisible to
 * every pass that walks the markup, and need their own.
 */
describe('rewriteSlideAttrs', () => {
  const map = (pairs: Record<string, string>) => (ref: string) => pairs[ref];

  it('rewrites the background image, the video list and inline url()', () => {
    const out = rewriteSlideAttrs(
      {
        'data-background-image': REF,
        'data-background-video': `${REF}, https://cdn.example.com/b.webm`,
        style: `background-image: url('${REF}'); color: red`,
        'data-transition': 'fade',
      },
      map({ [REF]: SIGNED })
    );

    expect(out['data-background-image']).toBe(SIGNED);
    // Order preserved, the foreign source untouched, the list re-joined trimmed.
    expect(out['data-background-video']).toBe(`${SIGNED},https://cdn.example.com/b.webm`);
    expect(out.style).toBe(`background-image: url('${SIGNED}'); color: red`);
    // Everything the map does not claim is byte-identical.
    expect(out['data-transition']).toBe('fade');
  });

  it('returns the same object when nothing maps', () => {
    const attrs = { 'data-background-image': REF, 'data-transition': 'fade' };
    expect(rewriteSlideAttrs(attrs, map({}))).toBe(attrs);
  });
});

describe('collecting refs for the save pass', () => {
  it('finds every candidate in a fragment, once each', () => {
    const refs = collectDeckAssetRefs(
      `<img src="${REF}" srcset="${REF} 800w, ${SIGNED} 1600w">` +
        `<a href="${REF}">dl</a><div style="background: url(${REF})"></div>`
    );

    expect(refs.sort()).toEqual([REF, SIGNED].sort());
  });

  it('finds the ones that only exist in a slide attrs map', () => {
    expect(
      collectSlideAttrRefs({
        'data-background-image': REF,
        'data-background-video': `${SIGNED}`,
        'data-transition': 'fade',
      }).sort()
    ).toEqual([REF, SIGNED].sort());
    expect(collectSlideAttrRefs(undefined)).toEqual([]);
  });
});
