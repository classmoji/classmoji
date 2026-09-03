/**
 * The read-time asset rewrite for deck HTML.
 *
 * What this guards is that the pass is a DOM pass and behaves like one: it
 * changes the four attributes that actually carry a URL, leaves everything the
 * resolver declines byte-identical, and — the reason it is not a regex — does
 * not touch URL-shaped text that merely lives inside an author's `data-*`
 * attribute or code sample.
 */

import { describe, it, expect } from 'vitest';
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

  it('keeps a full document a full document', async () => {
    const html = `<!DOCTYPE html><html><head><title>d</title></head><body><img src="${REF}"></body></html>`;

    const out = await rewriteDeckAssetUrls(html, resolver({ [REF]: SIGNED }));

    expect(out).toContain('<!DOCTYPE html>');
    expect(out).toContain('<title>d</title>');
    expect(out).toContain(`src="${SIGNED}"`);
  });
});
