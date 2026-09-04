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
import { rewriteDeckAssetUrls } from '../deckAssets.ts';

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
    const MULTI = `https://cdn.test/c/3f2504e0-4f89-41d3-9a0c-0305e82c3301/blob/abc.png?p=enrolled&v=0&exp=1&sig=abc`;
    const html = `<section data-background-image="${REF}"><img src="${REF}"></section>`;

    const out = await rewriteDeckAssetUrls(html, resolver({ [REF]: MULTI }));

    expect(out).toContain('?p=enrolled&amp;v=0&amp;exp=1&amp;sig=abc');
    expect(out).not.toContain('?p=enrolled&v=0');

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
