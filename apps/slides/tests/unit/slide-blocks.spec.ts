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
  sanitizeSvgBlocks,
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

    test(`sandbox ${JSON.stringify(sandbox)}: the live bridge renders it inert and stores it as authored`, () => {
      const html = block(sandbox);
      const fragment = safeInnerHtml(doc, html);
      const frame = fragment.querySelector('iframe') as HTMLIFrameElement;
      expect(frame.hasAttribute('srcdoc')).toBe(false);
      // Serialization restores the authored attribute in place.
      const section = sectionFromMarkup(doc, `<section data-cm-id="s1">${html}</section>`);
      expect(section.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(false);
      expect(serializeSection(section).html).toBe(holder(html).innerHTML);
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

  test('the inert round trip is byte-identical, attribute order included', () => {
    const html = block('allow-same-origin allow-scripts');
    const root = holder(html);
    const before = root.innerHTML;
    stripUnsafeMarkup(root);
    expect(root.innerHTML).not.toBe(before);
    restoreInertMarkup(root);
    expect(root.innerHTML).toBe(before);
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
