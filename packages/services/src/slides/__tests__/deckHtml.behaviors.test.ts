/**
 * Unit behaviors: parseSlidesFragment, normalizeSlideHtml, and generator
 * specifics (config emission, invalid attr names, includeNotes).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import {
  generateDeckHtml,
  parseDeckHtml,
  parseSlidesFragment,
  SL_BLOCK_CSS,
  normalizeSlideHtml,
  DeckParseError,
  GENERATED_DOC_SCRIPT_HASHES,
  REVEAL_CONFIG_ELEMENT_ID,
  REVEAL_INIT_SCRIPT,
  deckHtmlForViewer,
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
        '<section class="present editing-mode" aria-hidden="true" style="display: block; top: 350px; margin: 0;" data-cm-id="frag9999"><h2>A</h2></section>' +
        '</div>'
    );
    expect(result.slides[0].attrs).toEqual({ style: 'margin: 0;' });
  });

  it("drops the style attribute entirely when Reveal's computed top was all it held", () => {
    // reveal.js layout() writes style.top on EVERY section when center:true —
    // a viewport-dependent value on leaves, a literal 0px on stacks (#361).
    const result = parseSlidesFragment(
      '<div class="slides">' +
        '<section data-cm-id="frag0001" style="top: 350px;"><h2>A</h2></section>' +
        '<section data-cm-id="frag0002" class="stack" style="top: 0px;">' +
        '<section data-cm-id="frag0003" style="top: 12.5px"><h2>B</h2></section>' +
        '</section>' +
        '</div>'
    );
    expect(result.slides[0].attrs).toBeUndefined();
    expect(result.slides[1].attrs).toBeUndefined();
    expect(result.slides[1].children![0].attrs).toBeUndefined();
  });

  it('strips the contrast class every themed background earns', () => {
    // backgrounds.js getContrastClass adds one of these under any themed
    // background — otherwise every themed deck gains a class on first save
    // and flips it whenever the theme changes.
    const result = parseSlidesFragment(
      '<div class="slides"><section data-cm-id="frag0001" ' +
        'class="has-dark-background mine" data-background-color="#123456"><h2>A</h2></section>' +
        '<section data-cm-id="frag0002" class="has-light-background"><h2>B</h2></section></div>'
    );
    expect(result.slides[0].attrs).toEqual({
      class: 'mine',
      'data-background-color': '#123456',
    });
    expect(result.slides[1].attrs).toBeUndefined();
  });

  it("strips only normal-view layout — the print view's left and width survive", () => {
    const result = parseSlidesFragment(
      '<div class="slides"><section data-cm-id="frag0001" ' +
        'style="left: 40px; top: 12px; width: 960px;"><h2>A</h2></section></div>'
    );
    expect(result.slides[0].attrs).toEqual({ style: 'left: 40px; width: 960px;' });
  });

  it('preserves section attribute ORDER through the cruft strip (parse → generate)', () => {
    const parsed = parseSlidesFragment(
      '<div class="slides"><section data-cm-id="ord00001" data-transition="fade" ' +
        'style="display: block; top: 350px; color: red;" data-background-color="#123456">' +
        '<h2>A</h2></section></div>'
    );
    const html = generateDeckHtml(
      { version: 1, theme: parsed.theme, codeTheme: parsed.codeTheme, slides: parsed.slides },
      { title: 'T' }
    );
    expect(html).toContain(
      '<section data-cm-id="ord00001" data-transition="fade" style="color: red;" ' +
        'data-background-color="#123456">'
    );
  });

  it("strips Reveal's runtime section attributes and keeps the author-set ones", () => {
    const result = parseSlidesFragment(
      '<div class="slides"><section data-cm-id="frag0001" data-fragment="1" ' +
        'data-previous-indexv="2" data-index-h="3" data-index-v="4" ' +
        'data-start-indexv="1" data-background-color="#123456" ' +
        'data-transition="fade"><h2>A</h2></section></div>'
    );
    expect(result.slides[0].attrs).toEqual({
      'data-start-indexv': '1',
      'data-background-color': '#123456',
      'data-transition': 'fade',
    });
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

  it('strips fragment runtime paint from a merely-viewed slide (no phantom edit persists)', () => {
    const result = parseSlidesFragment(
      '<div class="slides" data-theme="white" data-code-theme="github">' +
        '<section data-cm-id="frag8888"><h2>Intro</h2>' +
        '<p class="fragment visible">one</p>' +
        '<p class="fragment visible current-fragment">two</p></section>' +
        '</div>'
    );
    expect(result.slides[0].html).toBe(
      '<h2>Intro</h2><p class="fragment">one</p><p class="fragment">two</p>'
    );
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

  it('strips Reveal fragment runtime paint (visible / current-fragment), keeping `fragment`', () => {
    const output = normalizeSlideHtml(
      '<p class="fragment visible">one</p><p class="fragment visible current-fragment">two</p>'
    );
    expect(output).toBe('<p class="fragment">one</p><p class="fragment">two</p>');
  });

  it('leaves a non-fragment `visible`/`current-fragment` class alone (only fragment paint is runtime)', () => {
    const output = normalizeSlideHtml('<div class="visible">kept</div>');
    expect(output).toBe('<div class="visible">kept</div>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared deck helpers (generator specifics below)
// ─────────────────────────────────────────────────────────────────────────────

const s = (id: string, html: string, extra: Partial<DeckSlide> = {}): DeckSlide => ({
  id,
  html,
  ...extra,
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
    expect(html).toContain(
      `<script type="application/json" id="${REVEAL_CONFIG_ELEMENT_ID}">{"hash":true,"controls":true,"progress":true,"center":true,"transition":"slide"}</script>`
    );
    expect(html).not.toContain('"width"');
    expect(html).not.toContain('"height"');
  });

  it('emits config keys only when set', () => {
    const html = generateDeckHtml(
      baseDeck({ config: { width: 1280, height: 720, center: false, transition: 'convex' } }),
      { title: 'T' }
    );
    expect(html).toContain(
      '{"hash":true,"controls":true,"progress":true,"center":false,"transition":"convex","width":1280,"height":720}'
    );
  });

  it('emits NO implicit styles (no style tag unless customCss is set)', () => {
    expect(generateDeckHtml(baseDeck(), { title: 'T' })).not.toContain('<style>');
    expect(
      generateDeckHtml(baseDeck({ customCss: '.reveal { color: red; }' }), { title: 'T' })
    ).toContain('<style>.reveal { color: red; }</style>');
    expect(generateDeckHtml(baseDeck(), { title: 'T' })).not.toContain('<style');
  });

  it('standalone adds the block-positioning rules ahead of the deck CSS', () => {
    const html = generateDeckHtml(baseDeck({ customCss: '.sl-block { top: 0; }' }), {
      title: 'T',
      standalone: true,
    });
    const blockRules = html.indexOf(`<style data-cm-standalone>${SL_BLOCK_CSS}</style>`);
    expect(blockRules).toBeGreaterThan(-1);
    expect(blockRules).toBeLessThan(html.indexOf('<style>.sl-block { top: 0; }</style>'));
    expect(SL_BLOCK_CSS).toContain('.sl-block{position:absolute;');
  });

  it('a standalone document parses back to the same deck (the block rules are not customCss)', () => {
    const deck = baseDeck({ customCss: '.x { color: red; }' });
    const { deck: back } = parseDeckHtml(generateDeckHtml(deck, { title: 'T', standalone: true }));
    expect(back.customCss).toBe(deck.customCss);
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

// ─────────────────────────────────────────────────────────────────────────────
// Generated document scripts and config
// ─────────────────────────────────────────────────────────────────────────────

describe('generated document scripts', () => {
  const deckWith = (extra: Partial<DeckJson> = {}): DeckJson => ({
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    slides: [s('aaa11111', '<h1>Hi</h1>')],
    ...extra,
  });

  /** Every inline (no src) script that is not a data block, by text. */
  const inlineScripts = (html: string): string[] => {
    const $ = cheerio.load(html);
    return $('script:not([src])')
      .toArray()
      .filter(el => !$(el).attr('type'))
      .map(el => $(el).text());
  };

  const sha = (text: string) =>
    `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

  it('carries one inline script, the same text in every deck, allowed by its hash', () => {
    const a = generateDeckHtml(deckWith(), { title: 'A' });
    const b = generateDeckHtml(
      deckWith({
        theme: 'night',
        config: { width: 1280, height: 720, center: false, transition: 'zoom' },
        customCss: '.reveal { color: red; }',
        slides: [s('bbb22222', '<p>Other</p>', { notes: 'n' })],
      }),
      { title: 'B', standalone: true }
    );
    expect(inlineScripts(a)).toEqual([REVEAL_INIT_SCRIPT]);
    expect(inlineScripts(b)).toEqual([REVEAL_INIT_SCRIPT]);
    expect(GENERATED_DOC_SCRIPT_HASHES).toEqual([sha(REVEAL_INIT_SCRIPT)]);
  });

  it('keeps the script byte for byte through the viewer pass', () => {
    const html = generateDeckHtml(
      deckWith({ slides: [s('ccc33333', '<p>x</p>', { notes: 'secret' })] }),
      {
        title: 'T',
      }
    );
    const viewed = deckHtmlForViewer(html, { canEdit: false, canViewSpeakerNotes: false });
    expect(viewed).not.toBe(html);
    expect(inlineScripts(viewed)).toEqual([REVEAL_INIT_SCRIPT]);
  });

  it('puts the config block right before the init script, after every slide', () => {
    const forged = `<script type="application/json" id="${REVEAL_CONFIG_ELEMENT_ID}">{"transition":"zoom","width":5}</script>`;
    const html = generateDeckHtml(deckWith({ slides: [s('ddd44444', `<p>x</p>${forged}`)] }), {
      title: 'T',
    });
    const $ = cheerio.load(html);
    const init = $('script:not([src])')
      .filter((_i, el) => !$(el).attr('type'))
      .first();
    const before = init.prev();
    expect(before.is(`script#${REVEAL_CONFIG_ELEMENT_ID}[type="application/json"]`)).toBe(true);
    expect(JSON.parse(before.text())).toEqual({
      hash: true,
      controls: true,
      progress: true,
      center: true,
      transition: 'slide',
    });
    // the parser reads the generator's block (the last one), not a slide's
    expect(parseDeckHtml(html).deck.config).toBeUndefined();
  });

  it('writes only listed transitions and numeric sizes', () => {
    const html = generateDeckHtml(
      deckWith({
        config: {
          transition: "slide'}); alert(1); ({x:'",
          width: '1px; alert(1)' as unknown as number,
          height: Number.NaN,
        },
      }),
      { title: 'T' }
    );
    expect(html).not.toContain('alert');
    expect(html).toContain('"transition":"slide"');
    expect(html).not.toContain('"width"');
    expect(html).not.toContain('"height"');
    expect(
      generateDeckHtml(deckWith({ config: { width: '1024' as unknown as number } }), { title: 'T' })
    ).toContain('"width":1024');
  });

  it('cannot close the config block from a value', () => {
    const html = generateDeckHtml(
      deckWith({ config: { transition: '</script><script>alert(1)</script>' } }),
      { title: 'T' }
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(inlineScripts(html)).toEqual([REVEAL_INIT_SCRIPT]);
  });

  it('keeps a deck’s css inside its style element', () => {
    const html = generateDeckHtml(
      deckWith({ customCss: '.a{color:red}</STYLE><script>alert(1)</script>' }),
      { title: 'T' }
    );
    expect(html).toContain('<style>.a{color:red}<\\/STYLE><script>alert(1)</script></style>');
    expect(inlineScripts(html)).toEqual([REVEAL_INIT_SCRIPT]);
  });

  it('parses unknown transitions and bad sizes out of a config block', () => {
    const html = generateDeckHtml(deckWith(), { title: 'T' }).replace(
      /(<script type="application\/json" id="cm-reveal-config">)[^<]*/,
      '$1{"transition":"spin","width":-3,"height":"720","center":false}'
    );
    const { deck, warnings } = parseDeckHtml(html);
    expect(deck.config).toEqual({ height: 720, center: false });
    expect(warnings).toContain("Unknown transition 'spin' dropped");
  });

  it('still reads the config of a document written before the config block', () => {
    const legacy = generateDeckHtml(deckWith(), { title: 'T' }).replace(
      /<script type="application\/json"[\s\S]*<\/script>\n<\/body>/,
      "<script>\n    Reveal.initialize({\n      hash: true,\n      center: false,\n      transition: 'fade',\n      width: 1280,\n    });\n  </script>\n</body>"
    );
    expect(legacy).toContain('Reveal.initialize({');
    expect(parseDeckHtml(legacy).deck.config).toEqual({
      width: 1280,
      center: false,
      transition: 'fade',
    });
  });
});
