/**
 * The presenter, follow and speaker views: slide markup and speaker notes go
 * into the page as cleaned fragments, Reveal runs with its cross-window API
 * off, and html blocks that still carry inline code are shown through the
 * content service's preview frame.
 *
 * Runs in the Playwright runner WITHOUT a browser — jsdom stands in for it,
 * with scripts on, so an event handler attribute that reaches the page runs
 * when its event fires.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import {
  deckSlidesFragment,
  hasVisibleSlides,
  renderSpeakerNotes,
} from '../../app/utils/presenterMarkup.ts';
import {
  LEGACY_SRCDOC_ATTR,
  mountLegacyHtmlBlocks,
  previewFrameUrl,
  restoreLegacyHtmlBlocks,
} from '../../app/utils/legacyHtmlBlocks.ts';
import {
  REVEAL_LOCKED_OPTIONS,
  installRevealMessageGuard,
  isRevealApiMessage,
  stripRevealQueryConfig,
} from '../../app/utils/revealHardening.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

type SpyWindow = Window & typeof globalThis & { __spy: string[] };

/** A live page with scripts on and a spy any surviving handler would call. */
function livePage(url = 'https://slides.test/deck/present') {
  const dom = new JSDOM(
    '<!doctype html><body><div class="reveal"><div class="slides"></div></div>',
    {
      url,
      runScripts: 'dangerously',
    }
  );
  const win = dom.window as unknown as SpyWindow;
  win.__spy = [];
  return { dom, win, doc: win.document, slides: win.document.querySelector('.slides') as Element };
}

/** Fire the events inline handlers usually hang on, at every element under `root`. */
function fireEverything(win: SpyWindow, root: ParentNode) {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const type of [
      'error',
      'load',
      'click',
      'focus',
      'mouseover',
      'toggle',
      'animationstart',
    ]) {
      el.dispatchEvent(new win.Event(type));
    }
  }
}

/** Deck markup with a handler (or a script) on every common vector. */
const HOSTILE = [
  '<section><h1>One</h1>',
  '<img src="x" onerror="window.__spy.push(\'img\')">',
  '<svg onload="window.__spy.push(\'svg\')"><circle r="1"></circle></svg>',
  '<a href="javascript:window.__spy.push(\'href\')" onclick="window.__spy.push(\'a\')">go</a>',
  '<details open ontoggle="window.__spy.push(\'details\')"><summary>s</summary></details>',
  "<script>window.__spy.push('script')</script>",
  '<aside class="notes">Say hello</aside>',
  '</section>',
  '<section data-hidden="true"><p>hidden</p></section>',
].join('');

test.describe('slide markup reaches the page cleaned', () => {
  test('a control: the same markup through innerHTML runs its handlers', () => {
    const { win, doc } = livePage();
    const holder = doc.createElement('div');
    holder.innerHTML = HOSTILE;
    fireEverything(win, holder);
    expect(win.__spy.length).toBeGreaterThan(0);
  });

  test('through deckSlidesFragment, nothing runs', () => {
    const { win, doc, slides } = livePage();
    const fragment = deckSlidesFragment(HOSTILE, doc);
    // Cleaned before anything is inserted.
    fireEverything(win, fragment);
    slides.replaceChildren(fragment);
    fireEverything(win, slides);
    (slides.querySelector('a') as HTMLAnchorElement | null)?.click();
    expect(win.__spy).toEqual([]);
    expect(slides.querySelector('script')).toBeNull();
    expect(slides.innerHTML).not.toMatch(/\son\w+=|javascript:/i);
    // The content stays; hidden slides go; notes stay for the speaker view.
    expect(slides.querySelector('h1')?.textContent).toBe('One');
    expect(slides.querySelectorAll('section')).toHaveLength(1);
    expect(slides.querySelector('aside.notes')?.textContent).toBe('Say hello');
  });

  test('a deck whose every slide is hidden has nothing to present', () => {
    const { doc } = livePage();
    expect(
      hasVisibleSlides(deckSlidesFragment('<section data-hidden="true"><p>x</p></section>', doc))
    ).toBe(false);
    expect(hasVisibleSlides(deckSlidesFragment('<section><p>x</p></section>', doc))).toBe(true);
  });

  test('the presenter inserts fragments only, and reads no content on its own', () => {
    const presenter = source('../../app/components/RevealPresenter.tsx');
    expect(presenter).toContain('deckSlidesFragment(htmlContent, document)');
    expect(presenter).toContain('slidesContainer.replaceChildren(fragment)');
    expect(presenter).not.toMatch(/\.innerHTML\s*=/);
    expect(presenter).not.toMatch(/dangerouslySetInnerHTML/);
    expect(presenter).not.toMatch(/\bfetch\(/);
    expect(presenter).not.toContain('plugin/notes');
  });
});

test.describe('speaker notes', () => {
  test('markdown renders, and markup in it is held to the lists after marked', () => {
    const { win, doc } = livePage();
    const box = doc.createElement('div');
    doc.body.append(box);
    renderSpeakerNotes(
      box,
      [
        '**Bold** and `code`',
        '',
        '<img src=x onerror="window.__spy.push(\'notes\')">',
        '',
        '[link](javascript:window.__spy.push(1))',
        '',
        "<script>window.__spy.push('script')</script>",
      ].join('\n')
    );
    fireEverything(win, box);
    (box.querySelector('a') as HTMLAnchorElement | null)?.click();
    expect(win.__spy).toEqual([]);
    expect(box.querySelector('strong')?.textContent).toBe('Bold');
    expect(box.querySelector('code')?.textContent).toBe('code');
    expect(box.innerHTML).not.toMatch(/onerror|javascript:|<script/i);
  });

  test('the presenter and the speaker view render notes only through it', () => {
    for (const file of ['RevealPresenter.tsx', 'SpeakerView.tsx']) {
      const text = source(`../../app/components/${file}`);
      expect(text, file).toContain('renderSpeakerNotes(');
      expect(text, file).not.toContain('marked.parse');
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
    }
  });
});

test.describe('Reveal hardening', () => {
  test('the presenter locks the options last and guards before initialize', () => {
    const presenter = source('../../app/components/RevealPresenter.tsx');
    const locked = presenter.indexOf('...REVEAL_LOCKED_OPTIONS');
    const configEnd = presenter.indexOf('};', locked);
    expect(locked).toBeGreaterThan(0);
    // Nothing after the locked options inside the config object.
    expect(presenter.slice(locked, configEnd).trim()).toBe('...REVEAL_LOCKED_OPTIONS,');
    const init = presenter.indexOf('deck.initialize()');
    expect(presenter.indexOf('stripRevealQueryConfig()')).toBeLessThan(init);
    expect(presenter.indexOf('installRevealMessageGuard()')).toBeLessThan(init);
    expect(REVEAL_LOCKED_OPTIONS).toEqual({
      postMessage: false,
      postMessageEvents: false,
      previewLinks: false,
    });
  });

  test('query-string config is dropped; the app’s own parameters and the hash stay', () => {
    const { win } = livePage(
      'https://slides.test/deck/follow?shareCode=abc&postMessage=true&previewLinks=true&preview=true#/2/1'
    );
    stripRevealQueryConfig(win);
    expect(win.location.search).toBe('?shareCode=abc&preview=true');
    expect(win.location.hash).toBe('#/2/1');
  });

  test('Reveal API messages stop at the guard; other messages pass', () => {
    const { win } = livePage();
    installRevealMessageGuard(win);
    installRevealMessageGuard(win); // once per window
    const seen: unknown[] = [];
    win.addEventListener('message', (event: MessageEvent) => seen.push(event.data));
    const send = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data }));

    send(JSON.stringify({ method: 'slide', args: [3] }));
    send(` ${JSON.stringify({ namespace: 'reveal', eventName: 'slidechanged' })}`);
    expect(seen).toEqual([]);

    const askMoji = { type: 'ask-moji:open', viewing: { kind: 'deck' } };
    send(askMoji);
    send({ type: 'cm-preview-ready' });
    send('slide:start');
    send(JSON.stringify({ event: 'infoDelivery' }));
    expect(seen).toEqual([
      askMoji,
      { type: 'cm-preview-ready' },
      'slide:start',
      JSON.stringify({ event: 'infoDelivery' }),
    ]);
    expect(isRevealApiMessage('{not json')).toBe(false);
  });
});

test.describe('html blocks that still carry inline code', () => {
  const CONTENT = 'https://content.classmoji.test';
  const LEGACY =
    '<section><div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
    '<iframe sandbox="allow-scripts" srcdoc="&lt;p&gt;game&lt;/p&gt;"></iframe></div></div></section>';

  test('load from the preview frame, which is sent their code each time it is ready', () => {
    const { win, doc, slides } = livePage();
    const fragment = deckSlidesFragment(LEGACY, doc);
    const unmount = mountLegacyHtmlBlocks(fragment, CONTENT, win as unknown as Window);
    slides.replaceChildren(fragment);

    const frame = slides.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('src')).toBe(`${CONTENT}/preview-frame`);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute(LEGACY_SRCDOC_ATTR)).toBe('<p>game</p>');

    const child = frame.contentWindow as Window;
    const posted: Array<[unknown, string]> = [];
    (child as unknown as { postMessage: (m: unknown, o: string) => void }).postMessage = (m, o) =>
      posted.push([m, o]);
    const ready = (source: Window) =>
      win.dispatchEvent(
        new win.MessageEvent('message', { data: { type: 'cm-preview-ready' }, source })
      );

    ready(win); // not from the frame: ignored
    ready(child);
    ready(child); // reloaded: sent again
    expect(posted).toEqual([
      [{ type: 'cm-preview', html: '<p>game</p>' }, '*'],
      [{ type: 'cm-preview', html: '<p>game</p>' }, '*'],
    ]);

    unmount();
    ready(child);
    expect(posted).toHaveLength(2);

    restoreLegacyHtmlBlocks(slides);
    expect(frame.getAttribute('srcdoc')).toBe('<p>game</p>');
    expect(frame.hasAttribute('src')).toBe(false);
  });

  test('with no content service configured they are left as they are', () => {
    const { doc } = livePage();
    const fragment = deckSlidesFragment(LEGACY, doc);
    mountLegacyHtmlBlocks(fragment, null);
    expect(fragment.querySelector('iframe')?.getAttribute('srcdoc')).toBe('<p>game</p>');
    expect(previewFrameUrl(`${CONTENT}/`)).toBe(`${CONTENT}/preview-frame`);
  });
});
