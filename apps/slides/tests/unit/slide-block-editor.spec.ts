/**
 * The editor's side of svg and html blocks, and of deleting slides, under
 * jsdom: an svg read from a file or the source editor, overview thumbnails
 * that never run an html block, slide keys that follow the slide (not its
 * position), and a delete that only ever removes the slide it was asked for.
 */
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { htmlBlockMarkup, HTML_BLOCK_SANDBOX } from '@classmoji/services/slides/runtime-attrs';

import {
  DEFAULT_SVG_SOURCE,
  captureSlideTarget,
  countLeafSlides,
  createSlideKeyer,
  ensureBlockIds,
  removeSlideElement,
  slideHtmlLengthWith,
  slideHtmlOverCap,
  resolveDeleteTarget,
  svgFitOf,
  svgFromSource,
  thumbnailHtml,
} from '../../app/components/blocks/slideBlocks.ts';
import { lockSourceBlockContent, prepareEditorSection } from '../../app/utils/collab/bridgeDom.ts';

const jsdom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const doc: Document = jsdom.window.document;

function slides(html: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'slides';
  el.innerHTML = html;
  doc.body.replaceChildren(el);
  return el;
}

test.describe('svgFromSource', () => {
  test('keeps one svg, held to the lists, sized to the block', () => {
    const result = svgFromSource(
      '<?xml version="1.0"?><!-- exported --><svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" onload="x()">' +
        '<script>alert(1)</script><foreignObject><div>hi</div></foreignObject>' +
        '<a href="javascript:alert(1)"><rect width="10" height="10" onclick="y()"/></a>' +
        '<circle r="4" fill="currentColor"/></svg>',
      doc
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const svg = result.svg;
    expect(svg.ownerDocument).toBe(doc);
    expect(svg.getAttribute('onload')).toBeNull();
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.getAttribute('height')).toBe('100%');
    expect(svg.getAttribute('viewBox')).toBe('0 0 120 80');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(svg.querySelector('script')).toBeNull();
    expect(svg.querySelector('foreignObject')).toBeNull();
    expect(svg.querySelector('a')?.getAttribute('href')).toBeNull();
    expect(svg.querySelector('rect')?.getAttribute('onclick')).toBeNull();
    expect(svg.querySelector('circle')?.getAttribute('fill')).toBe('currentColor');
  });

  test('keeps an authored viewBox and fit', () => {
    const result = svgFromSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="5cm" preserveAspectRatio="none"/>',
      doc
    );
    expect(result.ok && result.svg.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(result.ok && svgFitOf(result.svg)).toBe('none');
  });

  test('no viewBox is made up from non-numeric sizes', () => {
    const result = svgFromSource(
      '<svg xmlns="http://www.w3.org/2000/svg" width="50%" height="2em"/>',
      doc
    );
    expect(result.ok && result.svg.hasAttribute('viewBox')).toBe(false);
  });

  test('refuses anything that is not exactly one svg', () => {
    for (const text of [
      '',
      '<div>no</div>',
      '<svg xmlns="http://www.w3.org/2000/svg"></svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'text <svg></svg>',
      '<p>a</p><svg></svg>',
    ]) {
      expect(svgFromSource(text, doc).ok, text).toBe(false);
    }
  });

  test('reads loose markup as the browser does (no xmlns, an unclosed element)', () => {
    for (const text of [
      '<svg><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>',
    ]) {
      expect(svgFromSource(text, doc).ok, text).toBe(true);
    }
  });

  test('the default drawing passes its own rules', () => {
    const result = svgFromSource(DEFAULT_SVG_SOURCE, doc);
    expect(result.ok).toBe(true);
    expect(result.ok && svgFitOf(result.svg)).toBe('meet');
  });

  test('fit reads back from preserveAspectRatio', () => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    expect(svgFitOf(svg)).toBe('meet');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    expect(svgFitOf(svg)).toBe('slice');
    svg.setAttribute('preserveAspectRatio', 'none');
    expect(svgFitOf(svg)).toBe('none');
  });
});

test.describe('thumbnailHtml', () => {
  const box = { left: 0, top: 0, width: 100, height: 100 };

  test('no frame inside an html block loads; the live slide is untouched', () => {
    const root = slides(
      `<section>${htmlBlockMarkup({ id: 'b1', box, source: '<p>game</p>' })}` +
        '<div class="sl-block" data-block-type="iframe"><div class="sl-block-content">' +
        '<iframe data-src="/content/x/index.html"></iframe></div></div></section>'
    );
    const section = root.querySelector('section') as HTMLElement;
    const before = section.innerHTML;

    const holder = doc.createElement('div');
    holder.innerHTML = thumbnailHtml(section);
    const htmlFrame = holder.querySelector('.sl-block[data-block-type="html"] iframe') as Element;
    expect(htmlFrame.hasAttribute('srcdoc')).toBe(false);
    expect(htmlFrame.getAttribute('data-cm-inert-srcdoc')).toContain('<p>game</p>');
    expect(htmlFrame.getAttribute('sandbox')).toBe(HTML_BLOCK_SANDBOX);
    // An iframe embed is not an html block: as it was.
    expect(
      holder.querySelector('.sl-block[data-block-type="iframe"] iframe')?.getAttribute('data-src')
    ).toBe('/content/x/index.html');
    expect(section.innerHTML).toBe(before);
  });

  test('a frame already inert on the slide stays inert', () => {
    const root = slides(
      '<section><div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
        '<iframe data-cm-inert-srcdoc="&lt;p&gt;x&lt;/p&gt;" src="https://example.com"></iframe></div></div></section>'
    );
    const holder = doc.createElement('div');
    holder.innerHTML = thumbnailHtml(root.querySelector('section') as Element);
    const frame = holder.querySelector('iframe') as Element;
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.getAttribute('data-cm-inert-src')).toBe('https://example.com');
    expect(frame.getAttribute('data-cm-inert-srcdoc')).toBe('<p>x</p>');
  });
});

test.describe('slide keys', () => {
  test('keys follow the slide: an insert before it does not move them', () => {
    const keyer = createSlideKeyer();
    const root = slides(
      '<section data-cm-id="a"></section><section></section><section data-cm-id="c"></section>'
    );
    const [a, b, c] = Array.from(root.children);
    const first = keyer.keysFor([a, b, c]);

    const inserted = doc.createElement('section');
    root.insertBefore(inserted, a);
    const second = keyer.keysFor([inserted, a, b, c]);
    expect(second.slice(1)).toEqual(first);
    expect(new Set(second).size).toBe(4);
    expect(keyer.keyOf(a)).toBe('id-a');
  });

  test('a repeated data-cm-id (a copied slide) gets its own key', () => {
    const keyer = createSlideKeyer();
    const root = slides('<section data-cm-id="a"></section><section data-cm-id="a"></section>');
    const [x, y] = Array.from(root.children);
    const keys = keyer.keysFor([x, y]);
    expect(keys[0]).toBe('id-a');
    expect(keys[1]).not.toBe('id-a');
    expect(keyer.keysFor([x, y])).toEqual(keys);
  });
});

test.describe('the slide a delete aims at', () => {
  test('resolves to the captured slide, wherever it is now', () => {
    const root = slides('<section data-cm-id="a"></section><section data-cm-id="b"></section>');
    const b = root.children[1];
    const target = captureSlideTarget(b);
    // A co-editor inserts a slide in front: positions shift, the target does not.
    root.insertBefore(doc.createElement('section'), root.firstChild);
    expect(resolveDeleteTarget(target, root)).toBe(b);
  });

  test('a slide without an id (the git editor) is found by its element', () => {
    const root = slides('<section></section><section></section>');
    const second = root.children[1];
    expect(resolveDeleteTarget(captureSlideTarget(second), root)).toBe(second);
  });

  test('nothing when the slide is gone, re-identified, or never captured', () => {
    const root = slides('<section data-cm-id="a"></section><section data-cm-id="b"></section>');
    const [a, b] = Array.from(root.children);
    const ta = captureSlideTarget(a);
    const tb = captureSlideTarget(b);
    a.remove();
    expect(resolveDeleteTarget(ta, root)).toBeNull();
    b.setAttribute('data-cm-id', 'other');
    expect(resolveDeleteTarget(tb, root)).toBeNull();
    expect(resolveDeleteTarget(null, root)).toBeNull();
    expect(resolveDeleteTarget(captureSlideTarget(b), null)).toBeNull();
    // Not in this deck.
    const elsewhere = doc.createElement('section');
    doc.body.appendChild(elsewhere);
    expect(resolveDeleteTarget(captureSlideTarget(elsewhere), root)).toBeNull();
  });

  test('removing the last slide of a stack removes the stack', () => {
    const root = slides(
      '<section data-cm-id="s"><section data-cm-id="s1"></section></section>' +
        '<section data-cm-id="t"><section data-cm-id="t1"></section><section data-cm-id="t2"></section></section>'
    );
    expect(countLeafSlides(root)).toBe(3);
    removeSlideElement(root.querySelector('[data-cm-id="t2"]') as Element);
    expect(root.querySelector('[data-cm-id="t"]')?.children.length).toBe(1);
    removeSlideElement(root.querySelector('[data-cm-id="s1"]') as Element);
    expect(root.querySelector('[data-cm-id="s"]')).toBeNull();
    expect(countLeafSlides(root)).toBe(1);
  });
});

test.describe('svg and html block content at display time', () => {
  test('is not part of the editable slide; nothing else changes', () => {
    const root = slides(
      '<section data-cm-id="a">' +
        '<div class="sl-block" data-block-type="svg"><div class="sl-block-content"><svg></svg></div></div>' +
        '<div class="sl-block" data-block-type="html"><div class="sl-block-content"><iframe></iframe></div></div>' +
        '<div class="sl-block" data-block-type="text"><div class="sl-block-content"><p>t</p></div></div>' +
        '</section>'
    );
    const section = root.querySelector('section') as HTMLElement;
    prepareEditorSection(section, true);
    expect(section.getAttribute('contenteditable')).toBe('true');
    const editable = (type: string) =>
      section
        .querySelector(`.sl-block[data-block-type="${type}"] > .sl-block-content`)
        ?.getAttribute('contenteditable');
    expect(editable('svg')).toBe('false');
    expect(editable('html')).toBe('false');
    expect(editable('text')).toBeNull();
    lockSourceBlockContent(root);
    expect(editable('svg')).toBe('false');
  });
});

test.describe('svgFromSource reads the source the way the slide will', () => {
  test('attribute names that differ only in case cannot hide an animation target', () => {
    const result = svgFromSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><a>' +
        '<animate attributeName="href" values="#x;javascript:void(0)" ATTRIBUTENAME="fill" VALUES="red"/>' +
        '<rect width="10" height="10"/></a></svg>',
      doc
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg.querySelector('animate')).toBeNull();
    expect(result.svg.outerHTML).not.toContain('javascript:');
  });

  test('an xml prolog and comments around the drawing are fine', () => {
    const result = svgFromSource(
      '<?xml version="1.0"?>\n<!-- exported -->\n<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
      doc
    );
    expect(result.ok).toBe(true);
  });
});

test.describe("svgFromSource scopes a drawing's styles", () => {
  test('a <style> in <defs> lands under the <svg>, wrapped in @scope', () => {
    const result = svgFromSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><style>.cls-1{fill:red}</style>' +
        '</defs><rect class="cls-1" width="10" height="10"/></svg>',
      doc
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.svg.firstElementChild;
    expect(first?.localName).toBe('style');
    expect(first?.textContent).toBe('@scope {\n.cls-1{fill:red}\n}');
  });
});

test.describe('slide html size before a block edit', () => {
  test('measures the slide with one part swapped, escaping included', () => {
    const root = slides(
      '<section><h2>t</h2><div class="sl-block"><div class="sl-block-content"><b>old</b></div></div></section>'
    );
    const block = root.querySelector('.sl-block') as HTMLElement;
    const section = root.querySelector('section') as HTMLElement;
    const before = section.innerHTML.length;
    expect(slideHtmlLengthWith(block, '<b>old</b>', '<i>new!</i>')).toBe(before + 1);
  });

  test('over the cap says by how much, in KB; at or under the cap is fine', () => {
    expect(slideHtmlOverCap(200_000)).toBeNull();
    expect(slideHtmlOverCap(230_400)).toBe(
      'This slide would hold 231 KB of HTML; the limit is 200 KB.'
    );
  });
});

test.describe('block ids on an edited slide', () => {
  const block = (id: string | null) =>
    `<div class="sl-block"${id ? ` data-cm-block-id="${id}"` : ''}><div class="sl-block-content">x</div></div>`;
  let n = 0;
  const mint = () => `new${++n}`;

  test('a pasted copy gets a new id even when it lands first; the original keeps its own', () => {
    n = 0;
    const root = slides(`<section>${block('aaaa0001')}${block('aaaa0001')}</section>`);
    const [pasted, original] = Array.from(root.querySelectorAll('.sl-block'));
    const changed = ensureBlockIds(
      root.querySelector('section') as Element,
      new Set([pasted]),
      mint
    );
    expect(changed).toEqual([pasted]);
    expect(original.getAttribute('data-cm-block-id')).toBe('aaaa0001');
    expect(pasted.getAttribute('data-cm-block-id')).toBe('new1');
  });

  test('blocks without an id get one; duplicates among old blocks: the first keeps it', () => {
    n = 0;
    const root = slides(`<section>${block('b1')}${block(null)}${block('b1')}</section>`);
    const els = Array.from(root.querySelectorAll('.sl-block'));
    ensureBlockIds(root.querySelector('section') as Element, new Set(), mint);
    expect(els.map(el => el.getAttribute('data-cm-block-id'))).toEqual(['b1', 'new1', 'new2']);
  });

  test('blocks inside blocks are left alone; a slide in order is untouched', () => {
    n = 0;
    const html = `<section><div class="sl-block" data-cm-block-id="o1"><div class="sl-block">in</div></div>${block('o2')}</section>`;
    const root = slides(html);
    expect(ensureBlockIds(root.querySelector('section') as Element, new Set(), mint)).toEqual([]);
    expect(root.innerHTML).toBe(html);
  });
});
