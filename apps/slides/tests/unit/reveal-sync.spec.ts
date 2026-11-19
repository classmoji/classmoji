/**
 * revealSync.ts against the real reveal.js 6.0.2 in Chrome: after the editor
 * adds or removes sections, the slide on screen is the one Reveal holds as
 * current (so it is the one not marked `inert`), everything that follows the
 * current slide hears about it once (`slidechanged`), and media follow the
 * slide shown.
 *
 * The page loads reveal.js's own `dist/reveal.mjs` and revealSync.ts with its
 * types stripped (the module has no imports), served by `page.route`. Each
 * structure change does to the DOM what its editor path does (SlideToolbar,
 * the overview's delete, useSlideStructure's rebuild) and then calls the
 * revealSync function that path calls.
 */
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// The page-based tests drive the installed Chrome.
test.use({ channel: 'chrome' });

const ORIGIN = 'http://cm-reveal-sync.test';
const revealDist = dirname(createRequire(import.meta.url).resolve('reveal.js'));
const revealVersion = (
  JSON.parse(readFileSync(join(revealDist, '..', 'package.json'), 'utf8')) as { version: string }
).version;

/** A 2 s mono 8 kHz tone as WAV: media that loads offline (a `<video>` plays it too). */
function toneWav(): Buffer {
  const rate = 8000;
  const samples = rate * 2;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  }
  return buf;
}

function pageHtml(slides: string): string {
  return `<!doctype html><html><head><link rel="stylesheet" href="/reveal.css">
<style>html, body { margin: 0; height: 100%; }</style></head><body>
<div class="reveal"><div class="slides">${slides}</div></div>
<script type="module">
import Reveal from '/reveal.mjs';
import * as revealSync from '/revealSync.js';
const deck = new Reveal(document.querySelector('.reveal'), {
  hash: false, history: false, transition: 'none', keyboard: false, controls: false, progress: false,
});
await deck.initialize();
const events = [];
window.revealSyncTest = { deck, revealSync, events };
deck.on('slidechanged', e => {
  events.push({ h: e.indexh, v: e.indexv, prev: e.previousSlide?.id ?? null, cur: e.currentSlide?.id ?? null });
});
document.documentElement.dataset.ready = '';
</script></body></html>`;
}

async function open(page: Page, slides: string, at: [number, number] = [0, 0]) {
  const syncSource = stripTypeScriptTypes(
    readFileSync(new URL('../../app/utils/revealSync.ts', import.meta.url), 'utf8')
  );
  await page.route(`${ORIGIN}/**`, async routed => {
    const path = new URL(routed.request().url()).pathname;
    const js = 'text/javascript';
    if (path === '/deck')
      return routed.fulfill({ contentType: 'text/html', body: pageHtml(slides) });
    if (path === '/reveal.mjs')
      return routed.fulfill({
        contentType: js,
        body: readFileSync(join(revealDist, 'reveal.mjs')),
      });
    if (path === '/reveal.css')
      return routed.fulfill({
        contentType: 'text/css',
        body: readFileSync(join(revealDist, 'reveal.css')),
      });
    if (path === '/revealSync.js') return routed.fulfill({ contentType: js, body: syncSource });
    if (path === '/tone.wav') return routed.fulfill({ contentType: 'audio/wav', body: toneWav() });
    if (path === '/frame.html')
      return routed.fulfill({ contentType: 'text/html', body: '<p>frame</p>' });
    return routed.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/deck`);
  await page.waitForSelector('html[data-ready]', { state: 'attached' });
  await page.evaluate(([h, v]) => {
    const w = window.revealSyncTest as TestWindow;
    w.deck.slide(h, v);
    w.events.length = 0;
  }, at);
}

interface SlideChanged {
  h: number;
  v: number;
  prev: string | null;
  cur: string | null;
}
/** What the page puts on `window.revealSyncTest`. */
interface TestWindow {
  deck: RevealApi;
  revealSync: typeof import('../../app/utils/revealSync.ts');
  events: SlideChanged[];
}
declare global {
  interface Window {
    revealSyncTest?: TestWindow;
  }
}

/** What is on screen, what Reveal holds as current, and what it marks inert. */
async function state(page: Page) {
  return page.evaluate(() => {
    const w = window.revealSyncTest as TestWindow;
    const slides = w.deck.getSlidesElement() as HTMLElement;
    const top = slides.querySelector<HTMLElement>(':scope > section.present');
    const shown = top ? (top.querySelector<HTMLElement>(':scope > section.present') ?? top) : null;
    return {
      shown: shown?.id ?? null,
      current: w.deck.getCurrentSlide()?.id ?? null,
      shownInert: !!shown?.closest('[inert]'),
      indices: w.deck.getIndices(),
      events: w.events.splice(0),
    };
  });
}

const slide = (id: string, body = '') =>
  `<section id="${id}" contenteditable="true"><h2>${id}</h2>${body}</section>`;
const FLAT = slide('a') + slide('b') + slide('c');
const STACKED = slide('a') + `<section id="st">${slide('s1')}${slide('s2')}</section>` + slide('c');

test.describe('reveal.js under test', () => {
  test('is 6.0.2, the version revealSync.ts is written against', () => {
    expect(revealVersion).toBe('6.0.2');
  });
});

test.describe('the editor paths call revealSync', () => {
  const source = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const between = (text: string, from: string, to: string) =>
    text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

  test("the toolbar's add-left shows the new slide through addSlideLeftOf", () => {
    const addLeft = between(
      source('../../app/components/SlideToolbar.tsx'),
      'const addSlideLeft = useCallback(',
      'const addSlideRight = useCallback('
    );
    expect(addLeft).toContain('addSlideLeftOf(revealInstance, currentSlide, createNewSlide());');
    expect(addLeft).not.toContain('.sync()');
    expect(addLeft).not.toContain('.left()');
  });

  test("the overview's rebuild returns to the first slide through showAgain", () => {
    const rebuild = between(
      source('../../app/components/SlideOverview/hooks/useSlideStructure.ts'),
      'const syncToDOM = useCallback(',
      '}, [revealInstance, stacks]);'
    );
    expect(rebuild).toContain('showAgain(revealInstance, revealInstance.getSlide(0, 0) ?? null);');
    expect(rebuild).not.toContain('revealInstance.slide(0, 0)');
  });
});

test.describe('adding a slide to the left (SlideToolbar)', () => {
  const addLeft = (page: Page) =>
    page.evaluate(() => {
      const w = window.revealSyncTest as TestWindow;
      const fresh = document.createElement('section');
      fresh.id = 'new';
      fresh.setAttribute('contenteditable', 'true');
      fresh.innerHTML = '<h2>New Slide</h2><p>Add your content here...</p>';
      w.revealSync.addSlideLeftOf(w.deck, w.deck.getCurrentSlide(), fresh);
      w.deck.layout();
    });

  for (const [name, slides, at, h] of [
    ['of the first slide', FLAT, [0, 0], 0],
    ['of a later slide', FLAT, [2, 0], 2],
    ['of a stack child (before its stack)', STACKED, [1, 1], 1],
  ] as const) {
    test(`${name} shows the new slide, live, and says so once`, async ({ page }) => {
      await open(page, slides, [...at]);
      await addLeft(page);
      const after = await state(page);
      expect(after).toMatchObject({ shown: 'new', current: 'new', shownInert: false });
      expect(after.indices).toMatchObject({ h, v: 0 });
      expect(after.events).toHaveLength(1);
      expect(after.events[0]).toMatchObject({ h, v: 0, cur: 'new' });

      // Typing goes into the slide on screen.
      await page.locator('#new h2').click();
      await page.keyboard.type('ZQ');
      expect(await page.locator('#new h2').textContent()).toContain('ZQ');
    });
  }

  test('stops the media of the slide it moved off', async ({ page }) => {
    await open(
      page,
      slide('a', '<video id="clip" data-autoplay muted loop src="/tone.wav"></video>') + slide('b')
    );
    await page.waitForFunction(() => !(document.getElementById('clip') as HTMLVideoElement).paused);
    await addLeft(page);
    expect(await state(page)).toMatchObject({ shown: 'new', current: 'new' });
    expect(
      await page.evaluate(() => (document.getElementById('clip') as HTMLVideoElement).paused)
    ).toBe(true);
  });
});

test.describe('deleting the slide on screen from the overview', () => {
  /** useSlideStructure.deleteSlide: the section (or its now empty stack) goes, then syncShowing(null). */
  const remove = (page: Page, id: string) =>
    page.evaluate(id => {
      const w = window.revealSyncTest as TestWindow;
      const target = document.getElementById(id) as HTMLElement;
      const parent = target.parentElement as HTMLElement;
      const onlyChild =
        parent.localName === 'section' &&
        Array.from(parent.children).filter(k => k.localName === 'section').length <= 1;
      (onlyChild ? parent : target).remove();
      const onScreen = w.deck.getCurrentSlide();
      w.revealSync.syncShowing(w.deck, onScreen === target ? null : onScreen);
      w.deck.layout();
    }, id);

  for (const [name, slides, at, gone, shown] of [
    ['the first slide', FLAT, [0, 0], 'a', 'b'],
    ['a middle slide', FLAT, [1, 0], 'b', 'c'],
    ['the last slide', FLAT, [2, 0], 'c', 'b'],
    [
      "a stack's only child",
      slide('a') + `<section id="st">${slide('s1')}</section>` + slide('c'),
      [1, 0],
      's1',
      'c',
    ],
  ] as const) {
    test(`${name}: the slide shown next is current, live, and announced once`, async ({ page }) => {
      await open(page, slides, [...at]);
      await remove(page, gone);
      const after = await state(page);
      expect(after).toMatchObject({ shown, current: shown, shownInert: false });
      expect(after.events).toEqual([
        { h: after.indices.h, v: after.indices.v, prev: gone, cur: shown },
      ]);
    });
  }

  test('the slide taken out stops its media; the one shown starts its embeds', async ({ page }) => {
    await open(
      page,
      slide('a', '<video id="clip" data-autoplay muted loop src="/tone.wav"></video>') +
        slide('b', '<iframe id="lazy" data-src="/frame.html"></iframe>') +
        slide('c')
    );
    const clip = await page.waitForFunction(() => {
      const video = document.getElementById('clip') as HTMLVideoElement;
      return !video.paused && video;
    });
    await remove(page, 'a');
    expect(await state(page)).toMatchObject({ shown: 'b', current: 'b' });
    // Out of the document, a media element pauses on its own (HTML: media
    // element removal steps).
    await page.waitForFunction(video => (video as HTMLVideoElement).paused, clip);
    expect(await page.locator('#lazy').getAttribute('src')).toBe('/frame.html');
  });

  test('a slide off screen goes without a slide change', async ({ page }) => {
    await open(page, FLAT, [1, 0]);
    await page.evaluate(() => {
      const w = window.revealSyncTest as TestWindow;
      const onScreen = w.deck.getCurrentSlide();
      (document.getElementById('c') as HTMLElement).remove();
      w.revealSync.syncShowing(w.deck, onScreen);
    });
    expect(await state(page)).toMatchObject({ shown: 'b', current: 'b', events: [] });
  });
});

test.describe('deleting the slide on screen from the toolbar', () => {
  test('Reveal announces the move itself; nothing is sent twice', async ({ page }) => {
    await open(page, FLAT, [0, 0]);
    // SlideToolbar.performDeleteSlide: step away, take the slide out, settle.
    await page.evaluate(() => {
      const w = window.revealSyncTest as TestWindow;
      w.deck.right();
      w.events.length = 0;
      (document.getElementById('a') as HTMLElement).remove();
      w.revealSync.syncShowing(w.deck, w.deck.getCurrentSlide());
    });
    const after = await state(page);
    expect(after).toMatchObject({ shown: 'b', current: 'b', shownInert: false });
    expect(after.events).toEqual([{ h: 0, v: 0, prev: 'b', cur: 'b' }]);
  });
});

test.describe('the overview rebuilding the deck from copies (useSlideStructure)', () => {
  test('at the first slide: the copy shown is current and announced', async ({ page }) => {
    await open(page, FLAT, [0, 0]);
    await page.evaluate(() => {
      const w = window.revealSyncTest as TestWindow;
      const slides = w.deck.getSlidesElement() as HTMLElement;
      const copies = Array.from(slides.children).map(el => {
        const copy = el.cloneNode(true) as HTMLElement;
        copy.id = `${el.id}2`;
        return copy;
      });
      slides.innerHTML = '';
      slides.append(...copies);
      w.deck.sync();
      w.deck.layout();
      w.revealSync.showAgain(w.deck, w.deck.getSlide(0, 0) ?? null);
    });
    const after = await state(page);
    expect(after).toMatchObject({ shown: 'a2', current: 'a2', shownInert: false });
    expect(after.events).toEqual([{ h: 0, v: 0, prev: 'a', cur: 'a2' }]);
  });
});
