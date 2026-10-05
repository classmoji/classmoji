/**
 * svg and html slide blocks: the isolation rule for html blocks, the svg
 * lists, the browser-form serialization, and the block markup builders.
 *
 * The srcdoc rule must hold on every surface; here the server half is pinned
 * (normalizeSlideHtml at write time, the generator for render-view and
 * thumbnails). The DOM half (bridge, viewer, presenter) is pinned in
 * apps/slides/tests/unit/slide-blocks.spec.ts with the same cases.
 */

import { describe, expect, it } from 'vitest';
import {
  generateDeckHtml,
  htmlEquivalentModuloBrowserSerialization,
  neutralizeHtmlBlocksInHtml,
  normalizeSlideHtml,
  normalizeSvgBlockSource,
  parseDeckHtml,
  readSlideBlocks,
  removeSlideBlock,
  secureSlideBlocksInHtml,
  SlideBlockError,
  SlideHtmlError,
  updateSlideBlock,
} from '../deckHtml.ts';
import {
  HTML_BLOCK_SANDBOX,
  HTML_BLOCK_STORAGE_SHIM,
  blockBoxStyle,
  blockMarkup,
  escapeBlockAttr,
  htmlBlockMarkup,
  htmlBlockSource,
  htmlBlockSrcdoc,
  isAllowedSvgAnimation,
  isAllowedSvgAttr,
  isAllowedSvgLink,
  isBlockedFrameAttr,
  isPinnedHtmlBlockAllow,
  isSafeHtmlBlockSandbox,
  MAX_SLIDE_HTML_LENGTH,
  mintBlockId,
  scopeSvgStyleText,
} from '../deckBlocks.ts';
import { MAX_SLIDE_HTML } from '../deckOps.ts';
import { browserFixture } from './fixtures/browserSerialization.ts';
import type { DeckJson } from '../deckTypes.ts';

const BOX = { left: 80, top: 60, width: 800, height: 500 };

function htmlBlockWithSandbox(sandbox: string | null, source = '<p>hi</p>'): string {
  const block = htmlBlockMarkup({ id: 'b1', box: BOX, source });
  return sandbox === null
    ? block.replace(` sandbox="${HTML_BLOCK_SANDBOX}"`, '')
    : block.replace(`sandbox="${HTML_BLOCK_SANDBOX}"`, `sandbox="${sandbox}"`);
}

describe('isSafeHtmlBlockSandbox', () => {
  it.each([
    [HTML_BLOCK_SANDBOX, true],
    ['allow-scripts', true],
    ['', true], // fully sandboxed: nothing runs
    ['  ALLOW-SCRIPTS\tallow-modals\n', true],
    ['allow-scripts allow-forms allow-downloads', true],
    [null, false], // no sandbox at all
    ['allow-scripts allow-same-origin', false],
    ['allow-same-origin', false],
    ['allow-scripts ALLOW-SAME-ORIGIN', false],
    ['allow-scripts allow-top-navigation', false],
    ['allow-scripts allow-top-navigation-by-user-activation', false],
    ['allow-scripts allow-top-navigation-to-custom-protocols', false],
    ['allow-scripts allow-popups-to-escape-sandbox', false],
    ['allow-scripts allow-storage-access-by-user-activation', false],
    ['allow-scripts made-up-token', false],
  ])('%j → %s', (value, safe) => {
    expect(isSafeHtmlBlockSandbox(value)).toBe(safe);
  });
});

describe('html block isolation rule (server side)', () => {
  const unsafe = [
    null,
    'allow-scripts allow-same-origin',
    'allow-scripts allow-top-navigation',
    'allow-same-origin allow-scripts allow-popups',
  ];

  it.each(unsafe)('sandbox %j: normalizeSlideHtml stores the frame inert', sandbox => {
    const out = normalizeSlideHtml(htmlBlockWithSandbox(sandbox));
    expect(out).toContain('data-cm-inert-srcdoc=');
    expect(out).not.toMatch(/\ssrcdoc=/);
  });

  it.each(unsafe)('sandbox %j: the generator emits the frame inert', sandbox => {
    const html = generateDeckHtml(
      {
        version: 1,
        theme: 'white',
        codeTheme: 'github',
        slides: [{ id: 's1', html: htmlBlockWithSandbox(sandbox) }],
      },
      { title: 't', standalone: true }
    );
    expect(html).toContain('data-cm-inert-srcdoc=');
    expect(html).not.toMatch(/\ssrcdoc=/);
  });

  it('src and data-src of an unsafe html-block frame go inert too; object/embed never load there', () => {
    const block =
      '<div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
      '<iframe data-src="/content/x/index.html"></iframe><iframe src="/x"></iframe>' +
      '<object data="/x.html"></object><embed src="/x.swf"></div></div>';
    const out = normalizeSlideHtml(block);
    expect(out).toContain('data-cm-inert-data-src="/content/x/index.html"');
    expect(out).toContain('data-cm-inert-src="/x"');
    expect(out).toContain('<object data-cm-inert-data="/x.html">');
    expect(out).toContain('<embed data-cm-inert-src="/x.swf">');
  });

  it('a safe html block passes through byte for byte', () => {
    const block = htmlBlockWithSandbox(HTML_BLOCK_SANDBOX);
    expect(neutralizeHtmlBlocksInHtml(block)).toBe(block);
    expect(normalizeSlideHtml(block)).toBe(block);
  });

  it('iframes outside html blocks are left as authored (scope: html blocks only)', () => {
    const embed = browserFixture('iframe-embed-data-src').roundtrip;
    const sameOrigin =
      '<div class="sl-block" data-block-type="iframe"><div class="sl-block-content">' +
      '<iframe sandbox="allow-scripts allow-same-origin" srcdoc="&lt;b&gt;x&lt;/b&gt;"></iframe></div></div>';
    expect(normalizeSlideHtml(embed)).toBe(embed);
    expect(normalizeSlideHtml(sameOrigin)).toBe(sameOrigin);
    expect(neutralizeHtmlBlocksInHtml(sameOrigin)).toBe(sameOrigin);
  });

  it('attribute order is kept when a frame goes inert', () => {
    const out = normalizeSlideHtml(htmlBlockWithSandbox('allow-same-origin allow-scripts'));
    const tag = out.match(/<iframe[^>]*>/)?.[0] ?? '';
    expect(tag.indexOf('sandbox=')).toBeLessThan(tag.indexOf('allow='));
    expect(tag.indexOf('style=')).toBeLessThan(tag.indexOf('data-cm-inert-srcdoc='));
  });

  it('the generator emits a safe html block exactly as stored', () => {
    const slide = { id: 's1', html: htmlBlockWithSandbox(HTML_BLOCK_SANDBOX) };
    const generated = generateDeckHtml(
      { version: 1, theme: 'white', codeTheme: 'github', slides: [slide] },
      { title: 't' }
    );
    expect(generated).toContain(`<section data-cm-id="s1">${slide.html}</section>`);
  });
});

describe('browser-form serialization (Chromium escapes < and > in attribute values)', () => {
  it.each(['html-block-srcdoc', 'html-block-srcdoc-escaped', 'svg-block', 'iframe-embed-data-src'])(
    '%s: normalizeSlideHtml writes exactly what Chromium reads back',
    name => {
      const fixture = browserFixture(name);
      expect(normalizeSlideHtml(fixture.input)).toBe(fixture.roundtrip);
      expect(normalizeSlideHtml(fixture.roundtrip)).toBe(fixture.roundtrip);
    }
  );

  it('the cheerio form and the Chromium form are equivalent for merges', () => {
    const fixture = browserFixture('html-block-srcdoc');
    expect(htmlEquivalentModuloBrowserSerialization(fixture.input, fixture.roundtrip)).toBe(true);
  });

  it('is idempotent', () => {
    const html = '<p title="a < b > c">x</p><img alt="1<2" src="x.png">';
    const once = normalizeSlideHtml(html);
    expect(once).toBe('<p title="a &lt; b &gt; c">x</p><img alt="1&lt;2" src="x.png">');
    expect(normalizeSlideHtml(once)).toBe(once);
  });

  it('leaves fragments that already carry the private-use stand-ins alone', () => {
    const html = '<p title="\uE000 a < b">x</p>';
    expect(normalizeSlideHtml(html)).toBe('<p title="\uE000 a < b">x</p>');
  });
});

describe('html block source ⇄ srcdoc', () => {
  it('puts the storage shim first, after a leading doctype (standards mode kept)', () => {
    expect(htmlBlockSrcdoc('<p>x</p>')).toBe(`${HTML_BLOCK_STORAGE_SHIM}<p>x</p>`);
    expect(htmlBlockSrcdoc('<!DOCTYPE html><p>x</p>')).toBe(
      `<!DOCTYPE html>${HTML_BLOCK_STORAGE_SHIM}<p>x</p>`
    );
    expect(htmlBlockSrcdoc('  <!-- a -->\n<!doctype html>\n<p>x</p>')).toBe(
      `  <!-- a -->\n<!doctype html>${HTML_BLOCK_STORAGE_SHIM}\n<p>x</p>`
    );
  });

  it.each([
    '<p>x</p>',
    '<!DOCTYPE html><html><head></head><body><script>localStorage.setItem("a", 1 < 2)</script></body></html>',
    '',
    'plain & text "quoted" \u00a0nbsp',
  ])('round trips %j', source => {
    expect(htmlBlockSource(htmlBlockSrcdoc(source))).toBe(source);
  });

  it('a srcdoc without the shim is its own source', () => {
    expect(htmlBlockSource('<b>x</b>')).toBe('<b>x</b>');
  });

  it('block markup escapes the source so it parses back exactly', () => {
    const source =
      '<!DOCTYPE html><canvas id="c"></canvas><script>const ok = 1 < 2 && "a" !== \'b\'; ' +
      'document.title = "&amp; &lt;/script&gt;";</script>\u00a0';
    const html = htmlBlockMarkup({ id: mintBlockId(), box: BOX, source });
    const [block] = readSlideBlocks(normalizeSlideHtml(html));
    expect(block.type).toBe('html');
    expect(block.source).toBe(source);
    expect(block.box).toEqual(BOX);
    // Built markup is already in the browser's form.
    expect(normalizeSlideHtml(html)).toBe(html);
  });

  it('escapeBlockAttr matches the browser form', () => {
    expect(escapeBlockAttr('a&"<>\u00a0b')).toBe('a&amp;&quot;&lt;&gt;&nbsp;b');
  });

  it('block box style is the CSSOM form', () => {
    expect(blockBoxStyle({ left: 0, top: -0, width: 100.256, height: 50 })).toBe(
      'left: 0px; top: 0px; width: 100.26px; height: 50px;'
    );
  });

  it('mints 8-hex block ids', () => {
    expect(mintBlockId()).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('svg block lists', () => {
  it.each([
    ['#g', true],
    ['https://example.com/a.png', true],
    ['data:image/png;base64,AAAA', true],
    ['data:image/svg+xml,%3Csvg%3E', true],
    ['http://example.com/a.png', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<b>', false],
    ['/content/x.png', false],
  ])('link %j → %s', (value, ok) => {
    expect(isAllowedSvgLink(value)).toBe(ok);
  });

  it('attributes: handlers and script URLs never stay', () => {
    expect(isAllowedSvgAttr('onload', 'x()')).toBe(false);
    expect(isAllowedSvgAttr('ONCLICK', 'x()')).toBe(false);
    expect(isAllowedSvgAttr('xlink:href', 'javascript:x()')).toBe(false);
    expect(isAllowedSvgAttr('fill', ' java\tscript:x()')).toBe(false);
    expect(isAllowedSvgAttr('fill', 'url(#g)')).toBe(true);
    expect(isAllowedSvgAttr('viewBox', '0 0 10 10')).toBe(true);
  });

  it('normalizeSvgBlockSource drops script, foreignObject, handlers and bad links; sizes to the box', () => {
    const out = normalizeSvgBlockSource(
      '<?xml version="1.0"?><!-- exported --><svg xmlns="http://www.w3.org/2000/svg" ' +
        'width="200" height="100" onload="x()"><script>alert(1)</script>' +
        '<foreignObject><p>x</p></foreignObject>' +
        '<a xlink:href="javascript:alert(1)"><circle r="5" onclick="y()"/></a>' +
        '<use href="#a"/><image href="https://x/y.png"/><image href="/private.png"/>' +
        '<animate attributeName="href" to="javascript:alert(1)"/>' +
        '<set attributeName="onclick" to="alert(1)"/>' +
        '<animate attributeName="fill" values="red;javascript:alert(1)"/>' +
        '<animate attributeName="r" values="1;2"/><style>.a{fill:red}</style>' +
        '<text title="a<b">t</text></svg>'
    );
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 200 100" ' +
        'preserveAspectRatio="xMidYMid meet"><a><circle r="5"></circle></a><use href="#a"></use>' +
        '<image href="https://x/y.png"></image><image></image>' +
        '<animate attributeName="r" values="1;2"></animate><style>.a{fill:red}</style>' +
        '<text title="a&lt;b">t</text></svg>'
    );
  });

  it('keeps an authored viewBox and preserveAspectRatio', () => {
    const out = normalizeSvgBlockSource(
      '<svg viewBox="0 0 1 1" preserveAspectRatio="none" width="5em"><rect width="1" height="1"/></svg>'
    );
    expect(out).toBe(
      '<svg viewBox="0 0 1 1" preserveAspectRatio="none" width="100%" height="100%"><rect width="1" height="1"></rect></svg>'
    );
  });

  it.each(['<p>no svg</p>', '<svg></svg><svg></svg>', 'text <svg></svg>', ''])(
    'refuses %j (needs exactly one <svg>)',
    svg => {
      expect(() => normalizeSvgBlockSource(svg)).toThrow(SlideHtmlError);
    }
  );

  it('normalizeSlideHtml holds svg blocks to the lists (block and content keep their place)', () => {
    const out = normalizeSlideHtml(
      '<div class="sl-block" data-block-type="svg" onclick="x" style="left: 1px;">' +
        '<div class="sl-block-content" onmouseover="y"><svg viewBox="0 0 1 1"><script>1</script>' +
        '<rect onclick="z" width="1" height="1"/></svg><p>not svg</p></div><img src="x.png"></div>' +
        '<svg><script>outside svg blocks: untouched</script></svg>'
    );
    expect(out).toBe(
      '<div class="sl-block" data-block-type="svg" style="left: 1px;"><div class="sl-block-content">' +
        '<svg viewBox="0 0 1 1"><rect width="1" height="1"></rect></svg></div></div>' +
        '<svg><script>outside svg blocks: untouched</script></svg>'
    );
  });
});

describe('block reads and edits', () => {
  const svgBlock = blockMarkup(
    'svg',
    'svg00001',
    { left: 10, top: 20, width: 300, height: 200 },
    normalizeSvgBlockSource('<svg viewBox="0 0 10 10"><circle r="4"/></svg>')
  );
  const embed =
    '<div class="sl-block" data-block-type="iframe" data-cm-block-id="ifr00001" ' +
    'style="left: 0px; top: 0px; width: 560px; height: 315px; z-index: 3;"><div class="sl-block-content">' +
    '<iframe data-src="/content/a/games/x/index.html" style="width: 100%; height: 100%; border: 0px;" allowfullscreen=""></iframe></div></div>';
  const slideHtml = normalizeSlideHtml(
    `<h2>Title</h2>${htmlBlockMarkup({ id: 'html0001', box: BOX, source: '<b>1 < 2</b>' })}${svgBlock}${embed}` +
      '<div class="sl-block" data-block-type="text" style="left: 5px; top: 5px; width: 100px; height: auto;"><div class="sl-block-content"><p>t</p></div></div>'
  );

  it('reads every top-level block with its id, type, box and decoded content', () => {
    expect(readSlideBlocks(slideHtml)).toEqual([
      { id: 'html0001', type: 'html', box: BOX, source: '<b>1 < 2</b>' },
      {
        id: 'svg00001',
        type: 'svg',
        box: { left: 10, top: 20, width: 300, height: 200 },
        svg: '<svg viewBox="0 0 10 10" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"><circle r="4"></circle></svg>',
      },
      {
        id: 'ifr00001',
        type: 'iframe',
        box: { left: 0, top: 0, width: 560, height: 315 },
        src: '/content/a/games/x/index.html',
      },
      { id: null, type: 'text', box: { left: 5, top: 5, width: 100 } },
    ]);
    expect(readSlideBlocks(slideHtml, { content: false })[0]).toEqual({
      id: 'html0001',
      type: 'html',
      box: BOX,
    });
  });

  it('an inert html block still reads its source', () => {
    const inert = normalizeSlideHtml(htmlBlockWithSandbox(null, '<i>s</i>'));
    expect(readSlideBlocks(inert)[0].source).toBe('<i>s</i>');
  });

  it('updates source (frame rebuilt with the standard sandbox) and box (other style kept)', () => {
    const inert = normalizeSlideHtml(htmlBlockWithSandbox('allow-same-origin', '<i>old</i>'));
    const next = updateSlideBlock(inert, 'b1', {
      source: '<i>new</i>',
      box: { left: 1, height: 2 },
    });
    const [block] = readSlideBlocks(next);
    expect(block.source).toBe('<i>new</i>');
    expect(block.box).toEqual({ left: 1, top: 60, width: 800, height: 2 });
    expect(next).toContain(`sandbox="${HTML_BLOCK_SANDBOX}"`);
    expect(next).not.toContain('data-cm-inert-');

    const moved = updateSlideBlock(slideHtml, 'ifr00001', { box: { top: 40 } });
    expect(moved).toContain(
      'style="left: 0px; top: 40px; width: 560px; height: 315px; z-index: 3;"'
    );
  });

  it('updates svg and iframe src', () => {
    const next = updateSlideBlock(slideHtml, 'svg00001', {
      svg: '<svg viewBox="0 0 2 2"><rect width="2" height="2" onclick="x()"/></svg>',
    });
    expect(readSlideBlocks(next)[1].svg).toBe(
      '<svg viewBox="0 0 2 2" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"><rect width="2" height="2"></rect></svg>'
    );
    const moved = updateSlideBlock(slideHtml, 'ifr00001', { src: '/content/a/games/y/index.html' });
    expect(readSlideBlocks(moved)[2].src).toBe('/content/a/games/y/index.html');
    expect(moved).not.toMatch(/<iframe[^>]*\ssrc=/);
  });

  it('refuses unknown ids and fields that do not fit the type', () => {
    expect(() => updateSlideBlock(slideHtml, 'nope', { box: { left: 1 } })).toThrow(
      SlideBlockError
    );
    expect(() => updateSlideBlock(slideHtml, 'svg00001', { source: 'x' })).toThrow(SlideBlockError);
    expect(() => updateSlideBlock(slideHtml, 'html0001', { svg: '<svg></svg>' })).toThrow(
      SlideBlockError
    );
    expect(() => updateSlideBlock(slideHtml, 'html0001', { src: '/x' })).toThrow(SlideBlockError);
    expect(() => removeSlideBlock(slideHtml, 'nope')).toThrow(SlideBlockError);
  });

  it('removes one block, leaving the rest byte for byte', () => {
    const next = removeSlideBlock(slideHtml, 'svg00001');
    expect(readSlideBlocks(next).map(b => b.id)).toEqual(['html0001', 'ifr00001', null]);
    expect(next).toBe(slideHtml.replace(svgBlock, ''));
  });
});

describe('blocks through the deck round trip', () => {
  it('a deck with svg, html and iframe blocks is byte-stable through generate ∘ parse', () => {
    const deck: DeckJson = {
      version: 1,
      theme: 'white',
      codeTheme: 'github',
      slides: [
        {
          id: 's1',
          html: normalizeSlideHtml(
            htmlBlockMarkup({ id: 'h1', box: BOX, source: '<!DOCTYPE html><p>1 < 2</p>' }) +
              browserFixture('svg-block').roundtrip +
              browserFixture('iframe-embed-data-src').roundtrip
          ),
        },
      ],
    };
    const h1 = generateDeckHtml(deck, { title: 't' });
    const p1 = parseDeckHtml(h1);
    const h2 = generateDeckHtml(p1.deck, { title: 't' });
    expect(h2).toBe(h1);
    expect(p1.warnings).toEqual([]);
    expect(readSlideBlocks(p1.deck.slides[0].html ?? '')[0].source).toBe(
      '<!DOCTYPE html><p>1 < 2</p>'
    );
  });
});

describe('block rules: harder inputs', () => {
  const deckWith = (html: string, notes?: string): string =>
    generateDeckHtml(
      {
        version: 1,
        theme: 'white',
        codeTheme: 'github',
        slides: [{ id: 's1', html, ...(notes !== undefined ? { notes } : {}) }],
      },
      { title: 't' }
    );
  const looseFrame = '<iframe srcdoc="&lt;b&gt;x&lt;/b&gt;"></iframe>';

  it('a declarative shadow root inside an html block never attaches', () => {
    const html =
      '<div class="sl-block" data-block-type="html"><div class="sl-block-content"><div>' +
      `<template shadowrootmode="open">${looseFrame}</template></div></div></div>`;
    expect(normalizeSlideHtml(html)).toContain('<template data-cm-inert-shadowrootmode="open">');
    expect(deckWith(html)).toContain('data-cm-inert-shadowrootmode="open"');
  });

  it('a frame that is itself marked as the html block is held to the rule', () => {
    const html = `<iframe class="sl-block" data-block-type="html" srcdoc="x"></iframe>`;
    expect(normalizeSlideHtml(html)).toContain('data-cm-inert-srcdoc="x"');
    expect(deckWith(html)).toContain('data-cm-inert-srcdoc="x"');
  });

  it('the generator applies the rules to notes and to blocks left open into the notes', () => {
    const block = `<div class="sl-block" data-block-type="html"><div class="sl-block-content">${looseFrame}</div></div>`;
    expect(deckWith('<p>x</p>', block)).not.toMatch(/\ssrcdoc=/);
    const unclosed = '<div class="sl-block" data-block-type="html"><div class="sl-block-content">';
    expect(deckWith(unclosed, looseFrame)).not.toMatch(/\ssrcdoc=/);
  });

  it('a block type written as a character reference is still the same type', () => {
    const html = `<div class="sl-block" data-block-type="&#104;tml">${looseFrame}</div>`;
    expect(deckWith(html)).not.toMatch(/\ssrcdoc=/);
  });

  it('the generator holds svg blocks to the lists and leaves clean ones byte for byte', () => {
    const dirty =
      '<div class="sl-block" data-block-type="svg"><div class="sl-block-content"><svg viewBox="0 0 1 1">' +
      '<a href="javascript:void(0)"><rect width="1" height="1"></rect></a></svg></div></div>';
    expect(secureSlideBlocksInHtml(dirty)).not.toContain('javascript:');
    const clean = browserFixture('svg-block').roundtrip;
    expect(secureSlideBlocksInHtml(clean)).toBe(clean);
  });

  it('element names that are also object keys are ordinary elements', () => {
    expect(isBlockedFrameAttr('constructor', 'a', null, true)).toBe(false);
    expect(isBlockedFrameAttr('toString', 'src', null, true)).toBe(false);
    const html =
      '<div class="sl-block" data-block-type="html"><div class="sl-block-content"><constructor a="1"></constructor></div></div>';
    expect(() => normalizeSlideHtml(html)).not.toThrow();
  });

  it('animations are read whole: every attributeName, any prefix, every value list', () => {
    expect(
      isAllowedSvgAnimation('animate', [
        ['attributeName', 'href'],
        ['ATTRIBUTENAME', 'fill'],
      ])
    ).toBe(false);
    expect(isAllowedSvgAnimation('set', [['attributeName', 'foo:href']])).toBe(false);
    expect(
      isAllowedSvgAnimation('animate', [
        ['attributeName', 'fill'],
        ['values', 'red;#x;javascript:void(0)'],
      ])
    ).toBe(false);
    expect(isAllowedSvgAnimation('animate', { attributeName: 'r', values: '1;2' })).toBe(true);
  });

  it('a script URL anywhere in an svg attribute value is dropped', () => {
    expect(isAllowedSvgAttr('values', '#a;javascript:void(0)')).toBe(false);
    expect(isAllowedSvgAttr('fill', 'red')).toBe(true);
  });

  it('a long run of comments before the source is handled in linear time', () => {
    const source = `${'<!---->'.repeat(20_000)}x`;
    const started = Date.now();
    expect(htmlBlockSource(htmlBlockSrcdoc(source))).toBe(source);
    const doctyped = `${'<!-- c -->'.repeat(5_000)}<!doctype html><p>x</p>`;
    expect(htmlBlockSrcdoc(doctyped)).toContain(`<!doctype html>${HTML_BLOCK_STORAGE_SHIM}<p>`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('block edits reach only top-level blocks', () => {
    const nested =
      '<div class="sl-block" data-block-type="text" data-cm-block-id="outer001" style="left: 0px;">' +
      '<div class="sl-block-content"><div class="sl-block" data-block-type="svg" data-cm-block-id="dup00001">' +
      '<div class="sl-block-content"></div></div></div></div>';
    expect(() => removeSlideBlock(nested, 'dup00001')).toThrow(SlideBlockError);
  });
});

describe('html block frames delegate fullscreen only', () => {
  it.each([
    ['fullscreen', true],
    ['  FullScreen ; ', true],
    ['', true],
    ['fullscreen; camera', false],
    ['camera *', false],
    ['microphone', false],
    ['fullscreen *', false],
  ])('allow=%j pinned: %s', (value, ok) => {
    expect(isPinnedHtmlBlockAllow(value)).toBe(ok);
    expect(isBlockedFrameAttr('iframe', 'allow', HTML_BLOCK_SANDBOX, true, value)).toBe(!ok);
  });

  it('allow is judged only inside html blocks, and only with its value', () => {
    expect(isBlockedFrameAttr('iframe', 'allow', HTML_BLOCK_SANDBOX, false, 'camera')).toBe(false);
    expect(isBlockedFrameAttr('iframe', 'ALLOW', HTML_BLOCK_SANDBOX, true, 'camera')).toBe(true);
    expect(isBlockedFrameAttr('iframe', 'allow', HTML_BLOCK_SANDBOX, true)).toBe(false);
  });

  it('the block builder writes the pinned value', () => {
    expect(htmlBlockMarkup({ id: 'b1', box: BOX, source: 'x' })).toContain('allow="fullscreen"');
  });
});

describe("scopeSvgStyleText: a drawing's styles stay in the drawing", () => {
  const ILLUSTRATOR =
    '.st0{fill:#E6332A;}\n.st1{fill:none;stroke:#1D1D1B;stroke-width:2;}\n' +
    '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}\n' +
    'g > .st0{opacity:.5}';

  it('wraps rules in a prelude-less @scope and keeps unscopable at-rules outside, first', () => {
    const out = scopeSvgStyleText(ILLUSTRATOR);
    expect(out).toBe(
      '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}\n' +
        '@scope {\n.st0{fill:#E6332A;}\n.st1{fill:none;stroke:#1D1D1B;stroke-width:2;}\n' +
        'g > .st0{opacity:.5}\n}'
    );
  });

  it.each([
    ILLUSTRATOR,
    '.cls-1{fill:red}',
    '@import url(x.css);.a{fill:red}',
    '@media (min-width: 10px){.a{fill:red}}',
    '.a{content:"}"}.b{fill:blue}',
    '.a{fill:red}}.leak{fill:blue}',
    '.a{fill:red',
    '.a{fill:red}/* open',
    '.a{content:"open',
    '@scope { .a{} }',
    '@scope (svg) { .a{} }',
    '@scope {.a{}} .b{}',
    '.a\\{fill:red}',
  ])('is idempotent for %j', css => {
    const once = scopeSvgStyleText(css);
    expect(scopeSvgStyleText(once)).toBe(once);
    expect(once.startsWith('@scope') || /^@(import|keyframes)/.test(once)).toBe(true);
  });

  it('a stray close brace cannot end the scope early', () => {
    const out = scopeSvgStyleText('.a{fill:red}}.leak{fill:blue}');
    expect(out).toBe('@scope {\n.a{fill:red}.leak{fill:blue}\n}');
  });

  it('braces inside strings and comments are not structure', () => {
    expect(scopeSvgStyleText('.a{content:"}"}/* } */.b{fill:blue}')).toBe(
      '@scope {\n.a{content:"}"}/* } */.b{fill:blue}\n}'
    );
  });

  it('a cut-off sheet is closed inside the scope', () => {
    expect(scopeSvgStyleText('.a{fill:red')).toBe('@scope {\n.a{fill:red}\n}');
    expect(scopeSvgStyleText('.a{fill:red}/* x')).toBe('@scope {\n.a{fill:red}/* x*/\n}');
  });

  it('an empty or comment-only sheet is left alone; a sheet of only @font-face stays unwrapped', () => {
    expect(scopeSvgStyleText('')).toBe('');
    expect(scopeSvgStyleText('  \n ')).toBe('  \n ');
    expect(scopeSvgStyleText('@font-face{font-family:x;src:url(a.woff)}')).toBe(
      '@font-face{font-family:x;src:url(a.woff)}'
    );
  });

  it('a scope with a prelude is nested inside the drawing scope', () => {
    expect(scopeSvgStyleText('@scope (.x) { .a{} }')).toBe('@scope {\n@scope (.x) { .a{} }\n}');
  });
});

describe('slide html cap', () => {
  it("the editor's cap is the deck ops cap", () => {
    expect(MAX_SLIDE_HTML_LENGTH).toBe(MAX_SLIDE_HTML);
  });
});
