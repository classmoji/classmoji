/**
 * svg and html slide blocks on the display side, under jsdom: the html-block
 * isolation rule as the live bridge, the viewer and the presenter apply it,
 * the svg lists with the DOM, and the bridge's inert round trip (what is
 * stored never changes, byte for byte). The server half of the same rules is
 * pinned in packages/services/src/slides/__tests__/deckBlocks.test.ts.
 */
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import {
  HTML_BLOCK_SANDBOX,
  htmlBlockMarkup,
  neutralizeHtmlBlockFrames,
  offListSvgBlockNodes,
  sanitizeSvgBlocks,
  scopeSvgSheets,
  scopeSvgStyles,
} from '@classmoji/services/slides/runtime-attrs';

import {
  restoreInertMarkup,
  safeInnerHtml,
  sectionFromMarkup,
  serializeSection,
  stripUnsafeMarkup,
} from '../../app/utils/collab/bridgeDom.ts';

const jsdom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const doc: Document = jsdom.window.document;

const BOX = { left: 10, top: 20, width: 300, height: 200 };

function block(sandbox: string | null, source = '<b>1 &lt; 2</b>'): string {
  const markup = htmlBlockMarkup({ id: 'blk00001', box: BOX, source });
  return sandbox === null
    ? markup.replace(` sandbox="${HTML_BLOCK_SANDBOX}"`, '')
    : markup.replace(`sandbox="${HTML_BLOCK_SANDBOX}"`, `sandbox="${sandbox}"`);
}

function holder(html: string): HTMLElement {
  const div = doc.createElement('div');
  div.innerHTML = html;
  return div;
}

const UNSAFE = [
  null,
  'allow-scripts allow-same-origin',
  'allow-scripts allow-top-navigation',
  'allow-scripts allow-top-navigation-by-user-activation',
  'ALLOW-SAME-ORIGIN allow-scripts',
  'allow-scripts allow-popups-to-escape-sandbox',
];

test.describe('html block isolation rule (display)', () => {
  for (const sandbox of UNSAFE) {
    test(`sandbox ${JSON.stringify(sandbox)}: viewer/presenter pass makes the frame inert`, () => {
      const root = holder(block(sandbox));
      expect(neutralizeHtmlBlockFrames(root)).toBe(1);
      const frame = root.querySelector('iframe') as HTMLIFrameElement;
      expect(frame.hasAttribute('srcdoc')).toBe(false);
      expect(frame.hasAttribute('data-cm-inert-srcdoc')).toBe(true);
    });

    test(`sandbox ${JSON.stringify(sandbox)}: the live bridge renders it inert and stores it inert`, () => {
      const html = block(sandbox);
      const fragment = safeInnerHtml(doc, html);
      const frame = fragment.querySelector('iframe') as HTMLIFrameElement;
      expect(frame.hasAttribute('srcdoc')).toBe(false);
      // Written in the form the server stores (its normalize renames it the
      // same way), so an edit never differs from the stored slide there.
      const section = sectionFromMarkup(doc, `<section data-cm-id="s1">${html}</section>`);
      expect(section.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(false);
      const inert = holder(html);
      neutralizeHtmlBlockFrames(inert);
      expect(serializeSection(section).html).toBe(inert.innerHTML);
    });
  }

  test('a safe html block renders as is', () => {
    for (const sandbox of [HTML_BLOCK_SANDBOX, 'allow-scripts', '']) {
      const html = block(sandbox);
      const root = holder(html);
      expect(neutralizeHtmlBlockFrames(root)).toBe(0);
      expect(root.innerHTML).toBe(holder(html).innerHTML);
      const fragment = safeInnerHtml(doc, html);
      expect(fragment.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<b>1 &lt; 2</b>');
    }
  });

  test('src and data-src inside an unsafe html block go inert; other iframes are left alone', () => {
    const root = holder(
      '<div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
        '<iframe data-src="/content/x.html"></iframe><object data="/x.html"></object></div></div>' +
        '<div class="sl-block" data-block-type="iframe"><div class="sl-block-content">' +
        '<iframe sandbox="allow-scripts allow-same-origin" data-src="/content/game/index.html"></iframe>' +
        '</div></div>'
    );
    expect(neutralizeHtmlBlockFrames(root)).toBe(2);
    const [inBlock, embed] = Array.from(root.querySelectorAll('iframe'));
    expect(inBlock.getAttribute('data-cm-inert-data-src')).toBe('/content/x.html');
    expect(root.querySelector('object')?.getAttribute('data-cm-inert-data')).toBe('/x.html');
    expect(embed.getAttribute('data-src')).toBe('/content/game/index.html');
  });

  test('the round trip keeps what the frame rule blocks inert, attribute order included', () => {
    const html = block('allow-same-origin allow-scripts');
    const root = holder(html);
    const before = root.innerHTML;
    stripUnsafeMarkup(root);
    const shown = root.innerHTML;
    expect(shown).not.toBe(before);
    restoreInertMarkup(root);
    // The stored form: the blocked source stays inert, in place.
    expect(root.innerHTML).toBe(shown);
    stripUnsafeMarkup(root);
    restoreInertMarkup(root);
    expect(root.innerHTML).toBe(shown);
  });

  test('frame contents never serialize; editor block classes do not either', () => {
    const section = sectionFromMarkup(
      doc,
      `<section data-cm-id="s1">${block(HTML_BLOCK_SANDBOX)}</section>`
    );
    const blockEl = section.querySelector('.sl-block') as HTMLElement;
    blockEl.classList.add('editing-code');
    const serialized = serializeSection(section).html ?? '';
    expect(serialized).not.toContain('editing-code');
    expect(serialized).toBe(holder(block(HTML_BLOCK_SANDBOX)).innerHTML);
  });
});

test.describe('svg block lists (DOM)', () => {
  test('script, foreignObject, handlers, bad links and other content go; drawing stays', () => {
    const root = holder(
      '<div class="sl-block" data-block-type="svg" onclick="x()"><div class="sl-block-content" onmouseover="y()">' +
        '<svg viewBox="0 0 10 10" onload="z()"><script>1</script><foreignObject><p>x</p></foreignObject>' +
        '<a href="javascript:alert(1)"><circle r="4" onclick="w()"></circle></a>' +
        '<use href="#c"></use><image href="https://example.com/a.png"></image><image href="/private.png"></image>' +
        '<animate attributeName="href" to="javascript:alert(1)"></animate>' +
        '<animate attributeName="r" values="1;2"></animate><!-- note --></svg><p>not svg</p>' +
        '</div><img src="x.png"></div>'
    );
    sanitizeSvgBlocks(root);
    expect(root.innerHTML).toBe(
      '<div class="sl-block" data-block-type="svg"><div class="sl-block-content">' +
        '<svg viewBox="0 0 10 10"><a><circle r="4"></circle></a><use href="#c"></use>' +
        '<image href="https://example.com/a.png"></image><image></image>' +
        '<animate attributeName="r" values="1;2"></animate></svg></div></div>'
    );
  });

  test('svg outside svg blocks is not touched', () => {
    const html = '<svg><circle r="1" onclick="x()"></circle></svg>';
    const root = holder(html);
    sanitizeSvgBlocks(root);
    expect(root.innerHTML).toBe(html);
  });
});

test.describe('harder inputs on display', () => {
  test('svg-block attributes off the lists render inert and are stored as authored', () => {
    const html =
      '<div class="sl-block" data-block-type="svg"><div class="sl-block-content"><svg viewBox="0 0 1 1">' +
      '<a href="javascript:void(0)"><animate attributeName="href" values="#a;#b"></animate>' +
      '<rect width="1" height="1"></rect></a></svg></div></div>';
    const fragment = safeInnerHtml(doc, html);
    expect(fragment.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(fragment.querySelector('animate')?.getAttribute('data-cm-inert-attributeName')).toBe(
      'href'
    );
    const section = sectionFromMarkup(doc, `<section data-cm-id="s1">${html}</section>`);
    expect(serializeSection(section).html).toBe(holder(html).innerHTML);
  });

  test('an element named like an object key inside an html block renders', () => {
    const html =
      '<div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
      '<constructor a="1"></constructor></div></div>';
    expect(() => safeInnerHtml(doc, html)).not.toThrow();
    expect(() => neutralizeHtmlBlockFrames(holder(html))).not.toThrow();
  });

  test('a frame marked as the html block itself, and a shadow-root template, stay inert', () => {
    const root = holder(
      '<iframe class="sl-block" data-block-type="html" srcdoc="x"></iframe>' +
        '<div class="sl-block" data-block-type="html"><template shadowrootmode="open"><p>x</p></template></div>'
    );
    expect(neutralizeHtmlBlockFrames(root)).toBe(2);
    expect(root.querySelector('iframe')?.getAttribute('data-cm-inert-srcdoc')).toBe('x');
    expect(root.querySelector('template')?.hasAttribute('shadowrootmode')).toBe(false);
  });
});

test.describe('svg block styles stay in their drawing (DOM)', () => {
  const svgBlock = (inner: string) =>
    '<div class="sl-block" data-block-type="svg" data-cm-block-id="b1">' +
    `<div class="sl-block-content">${inner}</div></div>`;

  test('sheets are held to the drawing with one key, in place; keyframes and inline animations follow', () => {
    const root = holder(
      svgBlock(
        '<svg viewBox="0 0 10 10"><defs><style>.st0{fill:red}@keyframes spin{to{opacity:0}}</style></defs>' +
          '<style>.b{animation:spin 1s}</style><rect class="st0" style="animation: spin 2s"></rect></svg>'
      )
    );
    sanitizeSvgBlocks(root);
    const scoped = scopeSvgSheets([
      '.st0{fill:red}@keyframes spin{to{opacity:0}}',
      '.b{animation:spin 1s}',
    ]);
    const svg = root.querySelector('svg') as Element;
    expect(svg.getAttribute('data-cm-scope')).toBe(scoped.key);
    expect(Array.from(svg.querySelectorAll('style')).map(s => s.textContent)).toEqual(
      scoped.sheets
    );
    expect(svg.querySelector('defs style')).not.toBeNull();
    expect(svg.querySelector('rect')?.getAttribute('style')).toBe(
      `animation: spin_cm-${scoped.key} 2s`
    );
  });

  test('idempotent, the same through scopeSvgStyles; a drawing with no sheets carries no key', () => {
    const root = holder(
      svgBlock(
        '<svg><style>.a{fill:red}</style><g><svg><style>.b{fill:blue}</style></svg></g></svg>'
      ) + svgBlock('<svg data-cm-scope="dstale"><rect></rect></svg>')
    );
    sanitizeSvgBlocks(root);
    const once = root.innerHTML;
    const [outer, plain] = Array.from(root.querySelectorAll('.sl-block-content > svg'));
    expect(outer.getAttribute('data-cm-scope')).toBe(
      scopeSvgSheets(['.a{fill:red}', '.b{fill:blue}']).key
    );
    expect(plain.hasAttribute('data-cm-scope')).toBe(false);
    sanitizeSvgBlocks(root);
    expect(root.innerHTML).toBe(once);
    for (const content of Array.from(root.querySelectorAll('.sl-block-content'))) {
      scopeSvgStyles(content);
    }
    expect(root.innerHTML).toBe(once);
  });

  test('styles outside svg blocks are not touched', () => {
    const html = '<svg><defs><style>.x{fill:red}</style></defs></svg>';
    const root = holder(html);
    sanitizeSvgBlocks(root);
    expect(root.innerHTML).toBe(html);
  });
});

test.describe('one off-list filter for every display path', () => {
  test('lists off-list elements (outermost only), comments and stray block children', () => {
    const root = holder(
      '<div class="sl-block" data-block-type="svg"><div class="sl-block-content"><svg>' +
        '<foreignObject><iframe src="https://example.com"></iframe></foreignObject>' +
        '<circle r="1"></circle><!-- c --><script>1</script></svg></div><img src="x.png"></div>'
    );
    const nodes = offListSvgBlockNodes(root);
    expect(nodes.map(n => (n.nodeType === 1 ? (n as Element).localName : n.nodeType))).toEqual([
      'foreignObject',
      8,
      'script',
      'img',
    ]);
  });
});

test.describe('html block frames delegate fullscreen only (display)', () => {
  test('an allow beyond fullscreen renders inert and is stored inert', () => {
    const html = block(HTML_BLOCK_SANDBOX).replace(
      'allow="fullscreen"',
      'allow="camera; microphone"'
    );
    const root = holder(html);
    expect(neutralizeHtmlBlockFrames(root)).toBe(1);
    const frame = root.querySelector('iframe') as Element;
    expect(frame.hasAttribute('allow')).toBe(false);
    expect(frame.getAttribute('data-cm-inert-allow')).toBe('camera; microphone');
    expect(frame.hasAttribute('srcdoc')).toBe(true);

    const fragment = safeInnerHtml(doc, html);
    expect(fragment.querySelector('iframe')?.hasAttribute('allow')).toBe(false);
    const section = sectionFromMarkup(doc, `<section data-cm-id="s1">${html}</section>`);
    expect(serializeSection(section).html).toBe(root.innerHTML);
  });

  test('the standard frame is left byte for byte', () => {
    const html = block(HTML_BLOCK_SANDBOX);
    const root = holder(html);
    expect(neutralizeHtmlBlockFrames(root)).toBe(0);
    expect(root.innerHTML).toBe(holder(html).innerHTML);
  });
});
