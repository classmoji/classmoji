/**
 * THE FIXTURE GATE (plan §9 P3).
 *
 * Invariants:
 *  - Semantic idempotence: parse(generate(parse(F))) ≡ parse(F) for ALL fixtures.
 *  - Byte-stability on the parse image: generate(parse(generate(d))) === generate(d).
 *  - Sandpack script JSON byte-identical through round-trip.
 *  - Code stays escaped; notes extracted and re-inserted; id uniqueness enforced.
 */

import { describe, it, expect } from 'vitest';
import { generateDeckHtml, parseDeckHtml, DeckParseError } from '../deckHtml.ts';
import {
  ROUND_TRIP_FIXTURES,
  ZERO_SECTIONS_FIXTURE,
  SANDPACK_FIXTURE,
  SANDPACK_JSON,
  ESCAPED_CODE_FIXTURE,
  CANONICAL_FIXTURE,
  CRUFT_FIXTURE,
  STACKS_FIXTURE,
  IMPORTER_FIXTURE,
  STARTER_FIXTURE,
  SHARED_THEME_FIXTURE,
  SHARED_THEME_URLS,
  MULTI_ASIDE_FIXTURE,
  QUOTE_ATTR_FIXTURE,
  DUP_ID_FIXTURE,
  STRAY_LINK_FIXTURE,
  BACKGROUND_FIXTURE,
  seededIdGen,
} from './fixtures.ts';

const TITLE = 'Round Trip';

describe('round-trip invariants (all fixtures)', () => {
  for (const fixture of ROUND_TRIP_FIXTURES) {
    describe(fixture.name, () => {
      it('parse ∘ generate ∘ parse ≡ parse (semantic idempotence)', () => {
        const p1 = parseDeckHtml(fixture.html, { idGen: seededIdGen() });
        const h1 = generateDeckHtml(p1.deck, { title: TITLE, themeUrls: fixture.themeUrls });
        const p2 = parseDeckHtml(h1, { idGen: seededIdGen('x') });
        expect(p2.deck).toEqual(p1.deck);
      });

      it('generate ∘ parse ∘ generate is byte-equal on the parse image', () => {
        const p1 = parseDeckHtml(fixture.html, { idGen: seededIdGen() });
        const h1 = generateDeckHtml(p1.deck, { title: TITLE, themeUrls: fixture.themeUrls });
        const p2 = parseDeckHtml(h1, { idGen: seededIdGen('x') });
        const h2 = generateDeckHtml(p2.deck, { title: TITLE, themeUrls: fixture.themeUrls });
        expect(h2).toBe(h1);
      });

      it('re-parsing generator output produces no warnings', () => {
        const p1 = parseDeckHtml(fixture.html, { idGen: seededIdGen() });
        const h1 = generateDeckHtml(p1.deck, { title: TITLE, themeUrls: fixture.themeUrls });
        const p2 = parseDeckHtml(h1, { idGen: seededIdGen('x') });
        expect(p2.warnings).toEqual([]);
      });
    });
  }
});

describe('starter template fixture', () => {
  it('parses the legacy starter output (missing data-theme, monokai via reveal plugin path)', () => {
    const { deck, warnings } = parseDeckHtml(STARTER_FIXTURE, { idGen: seededIdGen() });
    expect(warnings).toEqual([]);
    expect(deck.theme).toBe('white'); // inferred from the theme link
    expect(deck.codeTheme).toBe('monokai'); // reveal.js@*/plugin/highlight/monokai.css
    expect(deck.themeDark).toBeUndefined();
    expect(deck.config).toEqual({ center: false });
    expect(deck.customCss).toContain('.reveal h1, .reveal h2, .reveal h3 { color: #333; }');
    expect(deck.slides).toHaveLength(4);
    expect(deck.slides[0].html).toContain('<h1>Intro to JavaScript</h1>');
    expect(deck.slides[2].html).toContain('language-javascript');
    // Ids minted (template has none)
    for (const slide of deck.slides) {
      expect(slide.id).toMatch(/^[\w-]{8}$/);
    }
    expect(deck.extraCss).toBeUndefined();
  });
});

describe('importer media-pair fixture', () => {
  it('captures the light/dark pairs first-class and consumes the not-all fallbacks', () => {
    const { deck, warnings } = parseDeckHtml(IMPORTER_FIXTURE, { idGen: seededIdGen() });
    expect(warnings).toEqual([]);
    expect(deck.theme).toBe('white');
    expect(deck.themeDark).toBe('black');
    expect(deck.codeTheme).toBe('github');
    expect(deck.codeThemeDark).toBe('github-dark');
    expect(deck.config).toEqual({ width: 960, height: 700, center: false });
    expect(deck.customCss).toContain('Override slides.com animation system');
    expect(deck.extraCss).toBeUndefined();
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].attrs).toEqual({ 'data-transition': 'fade' });
    expect(deck.slides[1].notes).toBe('Imported speaker notes');
    // sl-block markup stays opaque inside html
    expect(deck.slides[0].html).toContain('data-animation-type="fade-in"');
  });

  it('re-emits the media link trio for themeDark/codeThemeDark', () => {
    const { deck } = parseDeckHtml(IMPORTER_FIXTURE, { idGen: seededIdGen() });
    const html = generateDeckHtml(deck, { title: TITLE });
    expect(html).toContain(
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" media="(prefers-color-scheme: light)">'
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/black.css" media="(prefers-color-scheme: dark)">'
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" media="not all and (prefers-color-scheme)">'
    );
    expect(html).toContain(
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">'
    );
    expect(html).toContain('width: 960,');
    expect(html).toContain('height: 700,');
    expect(html).toContain('center: false,');
  });
});

describe('shared-theme fixture', () => {
  it('captures the shared theme and consumes .slidesthemes links (never extraCss)', () => {
    const { deck, warnings } = parseDeckHtml(SHARED_THEME_FIXTURE, { idGen: seededIdGen() });
    expect(warnings).toEqual([]);
    expect(deck.theme).toBe('shared:my-theme');
    expect(deck.themeDark).toBeUndefined();
    expect(deck.codeTheme).toBe('github'); // no code links, no attr → default
    expect(deck.extraCss).toBeUndefined();
    expect(deck.customCss).toContain('sl-block-content');
  });

  it('re-emits shared theme links from caller-resolved themeUrls', () => {
    const { deck } = parseDeckHtml(SHARED_THEME_FIXTURE, { idGen: seededIdGen() });
    const html = generateDeckHtml(deck, { title: TITLE, themeUrls: SHARED_THEME_URLS });
    expect(html).toContain(SHARED_THEME_URLS.libCssUrl);
    expect(html).toContain(SHARED_THEME_URLS.customThemeUrl);
    expect(html).toContain(
      '<body class="reveal-viewport theme-font-montserrat theme-color-white-blue">'
    );
    expect(html).toContain('data-theme="shared:my-theme"');
  });
});

describe('canonical editor fixture', () => {
  it('keeps existing data-cm-ids and extracts leaf notes', () => {
    const { deck } = parseDeckHtml(CANONICAL_FIXTURE);
    expect(deck.theme).toBe('league');
    expect(deck.codeTheme).toBe('monokai');
    expect(deck.config).toBeUndefined(); // canonical defaults are not stored
    expect(deck.slides.map(s => s.id)).toEqual(['aaaa1111', 'bbbb2222']);
    expect(deck.slides[1].notes).toBe('Remember to pause');
    expect(deck.slides[1].html).not.toContain('aside');
  });

  it('re-emits notes as the LAST child in the pinned aside shape', () => {
    const { deck } = parseDeckHtml(CANONICAL_FIXTURE);
    const html = generateDeckHtml(deck, { title: TITLE });
    expect(html).toContain('<aside class="notes">Remember to pause</aside></section>');
  });

  it('the view-path strip regex removes exactly what includeNotes:false omits', () => {
    const { deck } = parseDeckHtml(CANONICAL_FIXTURE);
    const withNotes = generateDeckHtml(deck, { title: TITLE });
    const withoutNotes = generateDeckHtml(deck, { title: TITLE, includeNotes: false });
    // The strip regex used by the slides route loader (route.tsx:127-131)
    const stripped = withNotes.replace(/<aside\s+class="notes"[^>]*>[\s\S]*?<\/aside>/gi, '');
    expect(stripped).toBe(withoutNotes);
    expect(withoutNotes).not.toContain('<aside');
  });
});

describe('runtime-cruft fixture', () => {
  it('strips runtime classes/attributes and only the display style property', () => {
    const { deck } = parseDeckHtml(CRUFT_FIXTURE);
    const [painted, hidden, stack] = deck.slides;

    // present/editing-mode stripped, keep-me kept; display removed, color kept
    expect(painted.attrs).toEqual({ class: 'keep-me', style: 'color: red;' });

    // slide-hidden class + HTML hidden attr stripped; data-hidden promoted
    expect(hidden.hidden).toBe(true);
    expect(hidden.attrs).toBeUndefined();

    // stack class stripped from the container; past/future stripped from children
    expect(stack.attrs).toBeUndefined();
    expect(stack.html).toBeUndefined();
    expect(stack.children).toHaveLength(2);
    expect(stack.children![0].attrs).toBeUndefined();
    expect(stack.children![1].attrs).toBeUndefined();
  });
});

describe('vertical stacks fixture', () => {
  it('parses containers with children, container attrs, and stack-level notes', () => {
    const { deck } = parseDeckHtml(STACKS_FIXTURE);
    expect(deck.slides).toHaveLength(2);
    const stack = deck.slides[1];
    expect(stack.id).toBe('stack001');
    expect(stack.html).toBeUndefined();
    expect(stack.attrs).toEqual({ 'data-transition': 'zoom' });
    expect(stack.notes).toBe('stack-level note');
    expect(stack.children!.map(c => c.id)).toEqual(['leaf0001', 'leaf0002']);
    expect(stack.children![1].notes).toBe('child note');
    expect(stack.children![1].html).not.toContain('aside');
  });
});

describe('sandpack fixture', () => {
  // Cheerio canonicalizes the valueless attribute to data-sandpack-files=""
  // (semantically identical; the editor's `script[data-sandpack-files]`
  // selector matches either form) — the payload itself must stay byte-equal.
  const extractPayload = (html: string): string => {
    const match = html.match(
      /<script type="application\/json" data-sandpack-files(?:="")?>([\s\S]*?)<\/script>/
    );
    return match ? match[1] : '';
  };

  it('the sandpack JSON payload is byte-identical through the round-trip', () => {
    expect(extractPayload(SANDPACK_FIXTURE)).toBe(SANDPACK_JSON);
    const { deck } = parseDeckHtml(SANDPACK_FIXTURE);
    const regenerated = generateDeckHtml(deck, { title: TITLE });
    expect(extractPayload(regenerated)).toBe(SANDPACK_JSON);
  });
});

describe('escaped pre>code fixture', () => {
  it('code stays escaped through the round-trip', () => {
    const { deck } = parseDeckHtml(ESCAPED_CODE_FIXTURE);
    const html = generateDeckHtml(deck, { title: TITLE });
    expect(html).toContain('&lt;div class="box"&gt;');
    expect(html).toContain('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;');
    // The raw (unescaped) markup must NOT appear inside the code block
    expect(deck.slides[0].html).not.toContain('<div class="box">');
  });
});

describe('hidden + background fixture', () => {
  it('promotes data-hidden and keeps data-background-* verbatim in attrs', () => {
    const { deck } = parseDeckHtml(BACKGROUND_FIXTURE);
    expect(deck.slides[0].attrs).toEqual({ 'data-background-color': '#ff5500' });
    expect(deck.slides[0].hidden).toBeUndefined();
    expect(deck.slides[1].hidden).toBe(true);
    expect(deck.slides[1].attrs).toEqual({
      'data-background-image': 'https://example.com/img.png?a=1&b=2',
      'data-background-size': 'cover',
    });
    expect(deck.config).toEqual({ transition: 'fade' });
  });

  it('re-emits data-hidden and escaped attr values', () => {
    const { deck } = parseDeckHtml(BACKGROUND_FIXTURE);
    const html = generateDeckHtml(deck, { title: TITLE });
    expect(html).toContain('data-hidden="true"');
    expect(html).toContain('data-background-image="https://example.com/img.png?a=1&amp;b=2"');
    expect(html).toContain("transition: 'fade',");
  });
});

describe('multi-aside fixture', () => {
  it('concatenates multiple asides with \\n (tolerant attr order/quoting/case)', () => {
    const { deck } = parseDeckHtml(MULTI_ASIDE_FIXTURE);
    expect(deck.slides[0].notes).toBe('First note\nSecond note');
    expect(deck.slides[0].html).toContain('<p>Body between asides</p>');
    expect(deck.slides[0].html).not.toContain('<aside');
  });
});

describe('quote-bearing attr values fixture', () => {
  it('decodes and re-escapes attribute values losslessly', () => {
    const { deck } = parseDeckHtml(QUOTE_ATTR_FIXTURE);
    expect(deck.slides[0].attrs).toEqual({
      'data-caption': 'He said "hi" & left',
      'data-note': 'a < b',
    });
    const html = generateDeckHtml(deck, { title: TITLE });
    expect(html).toContain('data-caption="He said &quot;hi&quot; &amp; left"');
    expect(html).toContain('data-note="a &lt; b"');
  });
});

describe('duplicate-id fixture', () => {
  it('enforces id uniqueness: first keeps, later duplicates re-minted with warning', () => {
    const { deck, warnings } = parseDeckHtml(DUP_ID_FIXTURE, { idGen: seededIdGen() });
    expect(deck.slides[0].id).toBe('dupdupdu');
    expect(deck.slides[1].id).not.toBe('dupdupdu');
    expect(deck.slides[1].id).toMatch(/^[\w-]{8}$/);
    expect(warnings.some(w => w.includes('dupdupdu'))).toBe(true);
  });
});

describe('stray-theme-link fixture', () => {
  it('drops non-fitting builtin links with a warning, never into extraCss', () => {
    const { deck, warnings } = parseDeckHtml(STRAY_LINK_FIXTURE);
    expect(deck.theme).toBe('white');
    expect(warnings.some(w => w.includes('beige'))).toBe(true);
    // extraCss holds only the genuinely unrecognized link, media preserved
    expect(deck.extraCss).toEqual([
      { href: 'https://fonts.googleapis.com/css2?family=Inter', media: 'print' },
    ]);
  });

  it('re-emits extraCss links verbatim', () => {
    const { deck } = parseDeckHtml(STRAY_LINK_FIXTURE);
    const html = generateDeckHtml(deck, { title: TITLE });
    expect(html).toContain(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" media="print">'
    );
    expect(html).not.toContain('beige');
  });
});

describe('zero-sections document', () => {
  it('throws a typed DeckParseError with warnings attached', () => {
    expect(() => parseDeckHtml(ZERO_SECTIONS_FIXTURE)).toThrow(DeckParseError);
    try {
      parseDeckHtml(ZERO_SECTIONS_FIXTURE);
    } catch (error) {
      expect((error as DeckParseError).code).toBe('DECK_PARSE_FAILED');
      expect(Array.isArray((error as DeckParseError).warnings)).toBe(true);
    }
  });
});
