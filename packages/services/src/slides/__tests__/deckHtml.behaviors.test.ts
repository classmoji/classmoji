/**
 * Unit behaviors: parseSlidesFragment, normalizeSlideHtml, diffDeckUnits,
 * and generator specifics (config emission, invalid attr names, includeNotes).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateDeckHtml,
  parseSlidesFragment,
  normalizeSlideHtml,
  diffDeckUnits,
  DeckParseError,
  SlideHtmlError,
  mintSlideId,
} from '../deckHtml.ts';
import type { DeckJson, DeckSlide } from '../deckTypes.ts';
import { EDITOR_FRAGMENT, seededIdGen } from './fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSlidesFragment
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSlidesFragment', () => {
  it('parses the editor wrapper shape (theme, codeTheme, sections, stacks, notes)', () => {
    const result = parseSlidesFragment(EDITOR_FRAGMENT);
    expect(result.theme).toBe('moon');
    expect(result.codeTheme).toBe('github-dark');
    expect(result.slides).toHaveLength(3);
    expect(result.slides.map(s => s.id)).toEqual(['frag0001', 'frag0002', 'frag0003']);
    expect(result.slides[1].notes).toBe('frag note');
    expect(result.slides[2].children!.map(c => c.id)).toEqual(['frag0004']);
  });

  it('defaults theme/codeTheme when the wrapper carries no data attributes', () => {
    const result = parseSlidesFragment('<div class="slides"><section><h2>A</h2></section></div>', {
      idGen: seededIdGen(),
    });
    expect(result.theme).toBe('white');
    expect(result.codeTheme).toBe('github');
    expect(result.slides[0].id).toBe('s0000001');
  });

  it('strips runtime cruft exactly like the document parser', () => {
    const result = parseSlidesFragment(
      '<div class="slides" data-theme="white" data-code-theme="github">' +
        '<section class="present editing-mode" aria-hidden="true" style="display: block; margin: 0;" data-cm-id="frag9999"><h2>A</h2></section>' +
        '</div>'
    );
    expect(result.slides[0].attrs).toEqual({ style: 'margin: 0;' });
  });

  it('strips event-handler attributes from sections (converging with the generator)', () => {
    const result = parseSlidesFragment(
      '<div class="slides"><section data-cm-id="evil0001" onclick="alert(1)" ' +
        'ONMouseOver="alert(2)" style="color: red" data-ok="yes"><h2>A</h2></section></div>'
    );
    // style survives (cruft-strip normalizes it with a trailing ';')
    expect(result.slides[0].attrs).toEqual({ style: 'color: red;', 'data-ok': 'yes' });
    expect(result.warnings.filter(w => w.includes('Event-handler'))).toHaveLength(2);
  });

  it('throws DeckParseError on a fragment with zero sections', () => {
    expect(() => parseSlidesFragment('<div class="slides"></div>')).toThrow(DeckParseError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeSlideHtml
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeSlideHtml', () => {
  it('flattens pre>code children to escaped text and removes the hljs class', () => {
    const input =
      '<h2>Hi</h2><pre><code class="language-js hljs">' +
      '<span class="hljs-keyword">const</span> x = <span>1</span> &lt; 2;</code></pre>';
    const output = normalizeSlideHtml(input);
    expect(output).not.toContain('<span');
    expect(output).not.toContain('hljs');
    expect(output).toContain('<code class="language-js">const x = 1 &lt; 2;</code>');
  });

  it('drops the class attribute entirely when hljs was the only class', () => {
    const output = normalizeSlideHtml('<pre><code class="hljs">x &amp;&amp; y</code></pre>');
    expect(output).toBe('<pre><code>x &amp;&amp; y</code></pre>');
  });

  it('passes benign fragments through the cheerio round-trip', () => {
    const output = normalizeSlideHtml('<p>a &amp; b</p><img src="x.png">');
    expect(output).toBe('<p>a &amp; b</p><img src="x.png">');
  });

  it('rejects a stray </section> (would corrupt sibling sections)', () => {
    expect(() => normalizeSlideHtml('<p>x</p></section><section><h1>inject</h1>')).toThrow(
      SlideHtmlError
    );
  });

  it('rejects nested <section> tags (would silently change deck structure)', () => {
    expect(() => normalizeSlideHtml('<section><h1>y</h1></section>')).toThrow(SlideHtmlError);
    try {
      normalizeSlideHtml('<section>x</section>');
    } catch (error) {
      expect((error as SlideHtmlError).code).toBe('INVALID_SLIDE_HTML');
    }
  });

  it('normalizes unbalanced non-section tags instead of letting them corrupt siblings', () => {
    const output = normalizeSlideHtml('<div><p>unclosed');
    expect(output).toBe('<div><p>unclosed</p></div>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diffDeckUnits
// ─────────────────────────────────────────────────────────────────────────────

function makeDeck(slides: DeckSlide[]): DeckJson {
  return { version: 1, theme: 'white', codeTheme: 'github', slides };
}

const s = (id: string, html: string, extra: Partial<DeckSlide> = {}): DeckSlide => ({
  id,
  html,
  ...extra,
});

describe('diffDeckUnits', () => {
  const base = makeDeck([s('aaa11111', '<h1>One</h1>'), s('bbb22222', '<h2>Two</h2>')]);

  it('reports no conflicts when the sides change different units', () => {
    const ours = makeDeck([s('aaa11111', '<h1>One edited</h1>'), s('bbb22222', '<h2>Two</h2>')]);
    const theirs = makeDeck([s('aaa11111', '<h1>One</h1>'), s('bbb22222', '<h2>Two edited</h2>')]);
    const result = diffDeckUnits(base, ours, theirs);
    expect(result.units).toEqual([]);
    expect(result.orderConflict).toBeUndefined();
  });

  it('reports a conflict when both sides change the same unit differently', () => {
    const ours = makeDeck([s('aaa11111', '<h1>Ours</h1>'), s('bbb22222', '<h2>Two</h2>')]);
    const theirs = makeDeck([s('aaa11111', '<h1>Theirs</h1>'), s('bbb22222', '<h2>Two</h2>')]);
    const result = diffDeckUnits(base, ours, theirs);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({
      id: 'aaa11111',
      index: '1',
      ours: { html: '<h1>Ours</h1>' },
      theirs: { html: '<h1>Theirs</h1>' },
    });
    expect(result.units[0].base).toEqual(s('aaa11111', '<h1>One</h1>'));
  });

  it('does not report a conflict when both sides made the identical change', () => {
    const same = makeDeck([s('aaa11111', '<h1>Same</h1>'), s('bbb22222', '<h2>Two</h2>')]);
    const result = diffDeckUnits(base, same, makeDeck([...same.slides]));
    expect(result.units).toEqual([]);
  });

  it('reports delete-vs-edit as a conflict with null for the deleted side', () => {
    const ours = makeDeck([s('bbb22222', '<h2>Two</h2>')]); // deleted aaa
    const theirs = makeDeck([s('aaa11111', '<h1>Edited</h1>'), s('bbb22222', '<h2>Two</h2>')]);
    const result = diffDeckUnits(base, ours, theirs);
    expect(result.units).toHaveLength(1);
    expect(result.units[0].id).toBe('aaa11111');
    expect(result.units[0].ours).toBeNull();
    expect(result.units[0].theirs).toEqual(s('aaa11111', '<h1>Edited</h1>'));
    // Order changed on ours only (deletion) — no order conflict
    expect(result.orderConflict).toBeUndefined();
  });

  it('reports an order conflict only when both sides reordered differently', () => {
    const ours = makeDeck([base.slides[1], base.slides[0]]);
    const theirs = makeDeck([base.slides[0], base.slides[1]]);
    expect(diffDeckUnits(base, ours, theirs).orderConflict).toBeUndefined();

    const theirs2 = makeDeck([s('ccc33333', '<h3>New</h3>'), base.slides[0], base.slides[1]]);
    const conflict = diffDeckUnits(base, ours, theirs2).orderConflict;
    expect(conflict).toEqual({
      base: ['aaa11111', 'bbb22222'],
      ours: ['bbb22222', 'aaa11111'],
      theirs: ['ccc33333', 'aaa11111', 'bbb22222'],
    });
  });

  it('walks container children as their own units with dotted indexes', () => {
    const containerBase = makeDeck([
      s('flat0001', '<h1>Flat</h1>'),
      { id: 'stack001', children: [s('leaf0001', '<p>a</p>'), s('leaf0002', '<p>b</p>')] },
    ]);
    const ours = makeDeck([
      s('flat0001', '<h1>Flat</h1>'),
      { id: 'stack001', children: [s('leaf0001', '<p>ours</p>'), s('leaf0002', '<p>b</p>')] },
    ]);
    const theirs = makeDeck([
      s('flat0001', '<h1>Flat</h1>'),
      { id: 'stack001', children: [s('leaf0001', '<p>theirs</p>'), s('leaf0002', '<p>b</p>')] },
    ]);
    const result = diffDeckUnits(containerBase, ours, theirs);
    expect(result.units).toHaveLength(1);
    expect(result.units[0].id).toBe('leaf0001');
    expect(result.units[0].index).toBe('2.1');
  });

  it('treats attrs key order as irrelevant (sorted comparison)', () => {
    const withAttrs = (order: 'ab' | 'ba') =>
      makeDeck([
        {
          id: 'aaa11111',
          html: '<h1>One</h1>',
          attrs:
            order === 'ab' ? { 'data-a': '1', 'data-b': '2' } : { 'data-b': '2', 'data-a': '1' },
        },
        s('bbb22222', '<h2>Two</h2>'),
      ]);
    const result = diffDeckUnits(withAttrs('ab'), withAttrs('ba'), withAttrs('ab'));
    expect(result.units).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Generator specifics
// ─────────────────────────────────────────────────────────────────────────────

describe('generateDeckHtml specifics', () => {
  const baseDeck = (extra: Partial<DeckJson> = {}): DeckJson => ({
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    slides: [s('aaa11111', '<h1>Hi</h1>')],
    ...extra,
  });

  it('emits canonical defaults when config is absent', () => {
    const html = generateDeckHtml(baseDeck(), { title: 'T' });
    expect(html).toContain('hash: true,');
    expect(html).toContain('controls: true,');
    expect(html).toContain('progress: true,');
    expect(html).toContain('center: true,');
    expect(html).toContain("transition: 'slide',");
    expect(html).not.toContain('width:');
    expect(html).not.toContain('height:');
  });

  it('emits config keys only when set', () => {
    const html = generateDeckHtml(
      baseDeck({ config: { width: 1280, height: 720, center: false, transition: 'convex' } }),
      { title: 'T' }
    );
    expect(html).toContain('width: 1280,');
    expect(html).toContain('height: 720,');
    expect(html).toContain('center: false,');
    expect(html).toContain("transition: 'convex',");
  });

  it('emits NO implicit styles (no style tag unless customCss is set)', () => {
    expect(generateDeckHtml(baseDeck(), { title: 'T' })).not.toContain('<style>');
    expect(
      generateDeckHtml(baseDeck({ customCss: '.reveal { color: red; }' }), { title: 'T' })
    ).toContain('<style>.reveal { color: red; }</style>');
  });

  it('emits data-cm-id on every section, including stack children', () => {
    const html = generateDeckHtml(
      baseDeck({
        slides: [
          s('aaa11111', '<h1>Hi</h1>'),
          { id: 'stack001', children: [s('leaf0001', '<p>a</p>')] },
        ],
      }),
      { title: 'T' }
    );
    expect(html).toContain('<section data-cm-id="aaa11111">');
    expect(html).toContain('<section data-cm-id="stack001">');
    expect(html).toContain('<section data-cm-id="leaf0001">');
  });

  it('drops invalid attribute names with a warning, keeps valid ones escaped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = generateDeckHtml(
      baseDeck({
        slides: [
          {
            id: 'aaa11111',
            html: '<h1>Hi</h1>',
            attrs: { 'data-ok': 'yes', '"onmouseover=alert(1)': 'x', '1bad': 'y' },
          },
        ],
      }),
      { title: 'T' }
    );
    expect(html).toContain('data-ok="yes"');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('1bad');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('drops event-handler attribute names (onclick, ONLoad, …) with a warning, keeps style', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = generateDeckHtml(
      baseDeck({
        slides: [
          {
            id: 'aaa11111',
            html: '<h1>Hi</h1>',
            attrs: {
              onclick: 'alert(1)',
              ONLoad: 'alert(2)',
              onerror: 'alert(3)',
              style: 'color: red',
              'data-ok': 'yes',
            },
          },
        ],
      }),
      { title: 'T' }
    );
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('ONLoad');
    expect(html).not.toContain('onerror');
    expect(html).toContain('style="color: red"');
    expect(html).toContain('data-ok="yes"');
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('escapes the document title', () => {
    const html = generateDeckHtml(baseDeck(), { title: 'A <b> & c' });
    expect(html).toContain('<title>A &lt;b&gt; &amp; c</title>');
  });

  it('omits all asides with includeNotes: false', () => {
    const html = generateDeckHtml(
      baseDeck({
        slides: [
          { id: 'aaa11111', html: '<h1>Hi</h1>', notes: 'leaf note' },
          { id: 'stack001', notes: 'stack note', children: [s('leaf0001', '<p>a</p>')] },
        ],
      }),
      { title: 'T', includeNotes: false }
    );
    expect(html).not.toContain('<aside');
  });

  it('emits a custom theme link only when the caller resolves one', () => {
    const deck = baseDeck({ theme: 'custom:mytheme.css' });
    const without = generateDeckHtml(deck, { title: 'T' });
    expect(without).not.toMatch(/<link[^>]*mytheme\.css/);
    expect(without).toContain('data-theme="custom:mytheme.css"');
    const withUrl = generateDeckHtml(deck, {
      title: 'T',
      themeUrls: { themeUrl: '/content/org/repo/slides/x/mytheme.css' },
    });
    expect(withUrl).toContain(
      '<link rel="stylesheet" href="/content/org/repo/slides/x/mytheme.css">'
    );
  });

  it('falls back to the white theme URL for unknown builtin names (canonical parity)', () => {
    const html = generateDeckHtml(baseDeck({ theme: 'not-a-theme' }), { title: 'T' });
    expect(html).toContain('dist/theme/white.css');
    expect(html).toContain('data-theme="not-a-theme"');
  });

  it('mintSlideId produces 8-char ids', () => {
    expect(mintSlideId()).toMatch(/^[0-9a-f]{8}$/);
    expect(mintSlideId()).not.toBe(mintSlideId());
  });
});
