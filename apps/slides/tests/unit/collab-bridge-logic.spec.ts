/**
 * The live deck bridge's pure decisions and DOM helpers (no browser, no dev
 * stack): when an html edit is written / claimed / waits / is put back, when
 * a remote change re-renders a slide, when a held slide is released, how a
 * textarea caret survives a remote notes edit, and how sections are read and
 * written without disturbing Reveal's runtime paint.
 */
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { LOCK_BLUR_RELEASE_MS, LOCK_RELEASE_IDLE_MS } from '@classmoji/collab';

import {
  decideLocalEdit,
  editingLabel,
  heartbeatDue,
  shouldRelease,
  shouldRenderRemoteHtml,
} from '../../app/utils/collab/bridgeLogic.ts';
import { transformIndex } from '../../app/utils/collab/textCursor.ts';
import {
  applySectionAttrs,
  arrangeChildren,
  scanDeckDom,
  serializeSection,
} from '../../app/utils/collab/bridgeDom.ts';
import { changedSlideIds } from '../../app/utils/collab/previewHighlight.ts';

const dom = (html: string): Document => new JSDOM(html).window.document;

test.describe('decideLocalEdit', () => {
  test('free → claim, mine+confirmed → write, mine unconfirmed → wait, others → revert', () => {
    expect(decideLocalEdit('free', false)).toBe('claim');
    expect(decideLocalEdit('mine', true)).toBe('write');
    expect(decideLocalEdit('mine', false)).toBe('wait');
    expect(decideLocalEdit('held', false)).toBe('revert');
    // A stale lock still needs an explicit takeover.
    expect(decideLocalEdit('stale', false)).toBe('revert');
  });
});

test.describe('shouldRenderRemoteHtml', () => {
  const base = { yHtml: '<p>new</p>', renderedYHtml: '<p>old</p>' };
  test('renders a changed slide nobody here holds', () => {
    expect(shouldRenderRemoteHtml({ ...base, heldByMe: false, claiming: false })).toBe(true);
  });
  test('never re-renders the slide being edited here', () => {
    expect(shouldRenderRemoteHtml({ ...base, heldByMe: true, claiming: false })).toBe(false);
    expect(shouldRenderRemoteHtml({ ...base, heldByMe: false, claiming: true })).toBe(false);
  });
  test('unchanged → nothing to do', () => {
    expect(
      shouldRenderRemoteHtml({ yHtml: 'a', renderedYHtml: 'a', heldByMe: false, claiming: false })
    ).toBe(false);
  });
});

test.describe('shouldRelease / heartbeat', () => {
  test('30 s idle releases even with focus; blur releases after 5 s', () => {
    const now = 1_000_000;
    expect(
      shouldRelease({ now, lastEditAt: now - LOCK_RELEASE_IDLE_MS, focused: true, blurredAt: null })
    ).toBe(true);
    expect(shouldRelease({ now, lastEditAt: now - 1000, focused: true, blurredAt: null })).toBe(
      false
    );
    expect(
      shouldRelease({
        now,
        lastEditAt: now - 10_000,
        focused: false,
        blurredAt: now - LOCK_BLUR_RELEASE_MS,
      })
    ).toBe(true);
    expect(
      shouldRelease({ now, lastEditAt: now - 10_000, focused: false, blurredAt: now - 1000 })
    ).toBe(false);
  });
  test('heartbeat at most every 10 s', () => {
    expect(heartbeatDue(0, 9_999)).toBe(false);
    expect(heartbeatDue(0, 10_000)).toBe(true);
  });
  test('"Tim is editing"', () => {
    expect(editingLabel('Tim Tregubov')).toBe('Tim is editing');
    expect(editingLabel('  ')).toBe('Someone is editing');
  });
});

test.describe('transformIndex (notes caret)', () => {
  test('inserts before the caret push it right, after leave it', () => {
    expect(transformIndex(5, [{ retain: 2 }, { insert: 'abc' }])).toBe(8);
    expect(transformIndex(5, [{ retain: 7 }, { insert: 'abc' }])).toBe(5);
  });
  test('deletes before pull it left; a delete spanning the caret lands at its start', () => {
    expect(transformIndex(5, [{ delete: 2 }])).toBe(3);
    expect(transformIndex(5, [{ retain: 3 }, { delete: 5 }])).toBe(3);
    expect(transformIndex(5, [{ retain: 6 }, { delete: 2 }])).toBe(5);
  });
});

test.describe('scanDeckDom', () => {
  test('stamps ids on new and duplicated sections, reads stacks', () => {
    const doc = dom(`<div class="slides">
      <section data-cm-id="aaaa0001"><p>1</p></section>
      <section><p>new</p></section>
      <section data-cm-id="stack001">
        <section data-cm-id="aaaa0002"><p>c</p></section>
        <section data-cm-id="aaaa0002"><p>copy</p></section>
      </section>
    </div>`);
    let n = 0;
    const scan = scanDeckDom(doc.querySelector('.slides') as Element, () => `mint000${++n}`);
    expect(scan.minted).toEqual(['mint0001', 'mint0002']);
    expect(scan.structure.scopes.get(null)).toEqual(['aaaa0001', 'mint0001', 'stack001']);
    expect(scan.structure.scopes.get('stack001')).toEqual(['aaaa0002', 'mint0002']);
    expect([...scan.structure.containers]).toEqual(['stack001']);
    expect(doc.querySelectorAll('[data-cm-id="mint0002"]')).toHaveLength(1);
  });
});

test.describe('serializeSection', () => {
  test('cleans editor/runtime additions; notes and child sections excluded', () => {
    const doc = dom(`<div class="slides"><section data-cm-id="s1" contenteditable="true"
      class="intro present editing-mode cm-held cm-locked" style="top: 12px; color: red; display: block"
      data-background-color="#000" data-hidden="true" aria-hidden="true" data-index-h="0">
      <h2 class="fragment visible current-fragment">Hi</h2>
      <pre><code class="hljs language-js"><span class="hljs-keyword">const</span> a = 1 &lt; 2;</code></pre>
      <aside class="notes">say hi</aside>
    </section></div>`);
    const el = doc.querySelector('section') as HTMLElement;
    const ser = serializeSection(el);
    expect(ser.hidden).toBe(true);
    expect(ser.asideNotes).toBe('say hi');
    expect(ser.attrs).toEqual({
      class: 'intro',
      style: 'color: red;',
      'data-background-color': '#000',
    });
    expect(ser.html).not.toContain('aside');
    expect(ser.html).toContain('<h2 class="fragment">Hi</h2>');
    expect(ser.html).toContain('<code class="language-js">const a = 1 &lt; 2;</code>');
    // The live element is untouched.
    expect(el.getAttribute('contenteditable')).toBe('true');
  });

  test('a stack container has no html', () => {
    const doc = dom(
      `<div class="slides"><section data-cm-id="st"><section data-cm-id="c"><p>c</p></section></section></div>`
    );
    expect(serializeSection(doc.querySelector('section') as HTMLElement).html).toBeUndefined();
  });

  test('Sandpack: the live mount goes, every embed attribute stays', () => {
    const doc = dom(
      `<div class="slides"><section data-cm-id="sp"><div class="sandpack-embed" data-template="react" data-visible-files='["/App.js"]' contenteditable="false"><script type="application/json" data-sandpack-files>{"/App.js":{"code":"x"}}</script><div class="sandpack-mount"><div class="cm-editor">typed</div></div></div></section></div>`
    );
    const html = serializeSection(doc.querySelector('section') as HTMLElement).html ?? '';
    expect(html).toContain('data-visible-files');
    expect(html).toContain('data-sandpack-files');
    expect(html).not.toContain('sandpack-mount');
    expect(html).not.toContain('contenteditable');
  });
});

test.describe('applySectionAttrs', () => {
  test('authored attributes replaced, Reveal paint and editor chrome kept', () => {
    const doc = dom(
      `<div class="slides"><section data-cm-id="s1" contenteditable="true" class="old present editing-mode cm-held" style="color: blue; display: block; top: 5px;" data-old="x" data-index-h="3"></section></div>`
    );
    const el = doc.querySelector('section') as HTMLElement;
    applySectionAttrs(el, { class: 'new', style: 'color: red;', 'data-transition': 'zoom' }, true);
    expect(el.getAttribute('data-old')).toBeNull();
    expect(el.getAttribute('data-transition')).toBe('zoom');
    expect(el.getAttribute('data-index-h')).toBe('3');
    expect(el.getAttribute('contenteditable')).toBe('true');
    expect(el.getAttribute('data-hidden')).toBe('true');
    expect(el.className.split(' ').sort()).toEqual(
      ['cm-held', 'editing-mode', 'new', 'present', 'slide-hidden'].sort()
    );
    expect(el.getAttribute('style')).toBe('color: red; display: block; top: 5px;');
    // And it serializes back to exactly the authored attributes.
    expect(serializeSection(el).attrs).toEqual({
      class: 'new',
      style: 'color: red;',
      'data-transition': 'zoom',
    });
  });
});

test.describe('arrangeChildren', () => {
  test('moves only the elements asked to move', () => {
    const doc = dom(
      `<div class="slides"><section id="a"></section><section id="b"></section><section id="c"></section></div>`
    );
    const parent = doc.querySelector('.slides') as HTMLElement;
    const [a, b, c] = ['a', 'b', 'c'].map(id => doc.getElementById(id) as HTMLElement);
    const d = doc.createElement('section');
    d.id = 'd';
    arrangeChildren(parent, [b, d, c, a], new Set([a, d]));
    expect(Array.from(parent.children).map(el => el.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});

test.describe('changedSlideIds (preview highlight)', () => {
  test('new and changed slides, stack children included', () => {
    const live = {
      version: 1 as const,
      theme: 'white',
      codeTheme: 'github',
      slides: [
        { id: 'a', html: '<p>a</p>' },
        { id: 'st', children: [{ id: 'c', html: '<p>c</p>' }] },
      ],
    };
    const preview = {
      ...live,
      slides: [
        { id: 'a', html: '<p>a</p>' },
        { id: 'n', html: '<p>new</p>' },
        { id: 'st', children: [{ id: 'c', html: '<p>c!</p>' }] },
      ],
    };
    expect(changedSlideIds(live, preview)).toEqual(['n', 'c']);
  });
});

test.describe('Reveal lazy loading is not an edit', () => {
  test('navigating to and away from a slide serializes back to the stored data-src', () => {
    const stored = `<div class="slides"><section data-cm-id="lz"><img data-src="/content/o/r/a.png" alt=""><iframe data-src="https://example.com/x" width="400"></iframe><video controls><source data-src="/v.mp4" type="video/mp4"></video></section></div>`;
    const before = serializeSection(dom(stored).querySelector('section') as HTMLElement).html;

    // What Reveal's loadSlide does on arrival…
    const doc = dom(stored);
    const section = doc.querySelector('section') as HTMLElement;
    for (const el of Array.from(section.querySelectorAll('[data-src]'))) {
      el.setAttribute('src', el.getAttribute('data-src') as string);
      el.setAttribute('data-lazy-loaded', '');
      el.removeAttribute('data-src');
    }
    expect(serializeSection(section).html).toBe(before);

    // …and unloadSlide on leaving (video/audio/iframe go back to data-src, img stays).
    for (const el of Array.from(
      section.querySelectorAll('iframe[data-lazy-loaded][src], source[src]')
    )) {
      el.setAttribute('data-src', el.getAttribute('src') as string);
      el.removeAttribute('src');
    }
    expect(serializeSection(section).html).toBe(before);
  });

  test('a started iframe (src mirrors data-src) is not an edit either', () => {
    const doc = dom(
      `<div class="slides"><section data-cm-id="if"><iframe data-src="https://e.com/a"></iframe></section></div>`
    );
    const section = doc.querySelector('section') as HTMLElement;
    const before = serializeSection(section).html;
    (section.querySelector('iframe') as HTMLElement).setAttribute('src', 'https://e.com/a');
    expect(serializeSection(section).html).toBe(before);
  });
});
