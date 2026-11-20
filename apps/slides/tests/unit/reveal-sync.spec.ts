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

// The page-based tests drive the installed Chrome, which refuses autoplay
// with sound until the page is clicked (as a browser does on a fresh tab).
// The videos the tests watch play are muted (always allowed); the tests of a
// refused video run their steps in the page, since `page.evaluate` counts as
// a click.
test.use({
  channel: 'chrome',
  launchOptions: { args: ['--autoplay-policy=user-gesture-required'] },
});

const ORIGIN = 'http://cm-reveal-sync.test';
const revealDist = dirname(createRequire(import.meta.url).resolve('reveal.js'));
const revealVersion = (
  JSON.parse(readFileSync(join(revealDist, '..', 'package.json'), 'utf8')) as { version: string }
).version;

/** A mono 8 kHz tone as WAV: media that loads offline (a `<video>` plays it too). */
function toneWav(seconds = 2): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
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

interface PageOptions {
  /** Reveal options over the defaults (the editor's: `hash: true, history: true`). */
  config?: string;
  /**
   * Runs in the page once the deck is ready, instead of the test moving to
   * `at` with `page.evaluate` (which Chrome counts as a user gesture, after
   * which it allows sound).
   */
  script?: string;
}

const LONG_WAV = toneWav(30);

function pageHtml(slides: string, { config = '', script = '' }: PageOptions = {}): string {
  return `<!doctype html><html><head><link rel="stylesheet" href="/reveal.css">
<style>html, body { margin: 0; height: 100%; }</style></head><body>
<div class="reveal"><div class="slides">${slides}</div></div>
<script type="module">
import Reveal from '/reveal.mjs';
import * as revealSync from '/revealSync.js';
const deck = new Reveal(document.querySelector('.reveal'), {
  hash: false, history: false, transition: 'none', keyboard: false, controls: false, progress: false,
  ${config}
});
await deck.initialize();
const events = [];
window.revealSyncTest = { deck, revealSync, events };
const label = s => s ? s.id || s.dataset.name || null : null;
deck.on('slidechanged', e => {
  events.push({ h: e.indexh, v: e.indexv, prev: label(e.previousSlide), cur: label(e.currentSlide) });
});
document.documentElement.dataset.ready = '';
${script}
</script></body></html>`;
}

async function open(
  page: Page,
  slides: string,
  at: [number, number] | null = [0, 0],
  options: PageOptions = {}
) {
  const syncSource = stripTypeScriptTypes(
    readFileSync(new URL('../../app/utils/revealSync.ts', import.meta.url), 'utf8')
  );
  await page.route(`${ORIGIN}/**`, async routed => {
    const path = new URL(routed.request().url()).pathname;
    const js = 'text/javascript';
    if (path === '/deck')
      return routed.fulfill({ contentType: 'text/html', body: pageHtml(slides, options) });
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
    if (path === '/long.wav') {
      // Served in ranges, as the app's media are: without them Chrome cannot
      // seek it (a seek lands back at 0).
      const body = LONG_WAV;
      const range = /bytes=(\d+)-(\d*)/.exec(routed.request().headers()['range'] ?? '');
      if (!range) return routed.fulfill({ contentType: 'audio/wav', body });
      const from = Number(range[1]);
      const to = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      return routed.fulfill({
        status: 206,
        contentType: 'audio/wav',
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${from}-${to}/${body.length}`,
        },
        body: body.subarray(from, to + 1),
      });
    }
    if (path === '/frame.html')
      return routed.fulfill({ contentType: 'text/html', body: '<p>frame</p>' });
    return routed.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/deck`);
  // A script runs the steps itself; waiting on the page here would evaluate
  // in it, which Chrome counts as a click.
  if (options.script) return;
  await page.waitForSelector('html[data-ready]', { state: 'attached' });
  if (!at) return;
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
  /** Set by a page script: the media button and mark before its steps… */
  before?: { button: boolean; mark: string | null };
  /** …and the slide it took out. */
  gone?: HTMLElement;
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
    const label = (s: HTMLElement | null | undefined) =>
      s ? s.id || s.dataset.name || null : null;
    return {
      shown: label(shown),
      current: label(w.deck.getCurrentSlide()),
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

  test("the toolbar's delete takes the slide out, then shows the one beside it", () => {
    const remove = between(
      source('../../app/components/SlideToolbar.tsx'),
      'const performDeleteSlide = useCallback(',
      '// Live editing: someone else holds the slide on screen.'
    );
    expect(remove).toMatch(
      /const beside = slideBeside\(revealInstance, currentSlide\);\s*removeSlideElement\(currentSlide\);\s*syncShowing\(revealInstance, beside\);/
    );
    // No step away first: Reveal would start the next slide's media, then
    // stop and restart it when the deck shifts under it.
    for (const step of ['.left()', '.right()', '.up()', '.down()']) {
      expect(remove).not.toContain(step);
    }
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

/** A muted autoplaying video (always allowed to play) that runs 30 s, so it never loops in a test. */
const CLIP = '<video id="clip" data-autoplay muted loop preload="auto" src="/long.wav"></video>';

/**
 * Waits until the clip can play (it has data: Reveal starts it at once when
 * its slide is shown), and counts its pauses and seeks from now on.
 */
async function watchClip(page: Page, { playing = false } = {}) {
  await page.waitForFunction(
    playing => {
      const clip = document.getElementById('clip') as HTMLVideoElement;
      return clip.readyState >= 2 && (!playing || (!clip.paused && clip.currentTime > 0.2));
    },
    playing,
    { timeout: 15_000 }
  );
  await page.evaluate(() => {
    const clip = document.getElementById('clip') as HTMLVideoElement & { counts?: object };
    // Reveal marks media it paused and never unmarks them: a mark from
    // before (moving to the slide the test starts on) is not under test.
    clip.removeAttribute('data-paused-by-reveal');
    const counts = { pause: 0, seeking: 0 };
    clip.counts = counts;
    clip.addEventListener('pause', () => counts.pause++);
    clip.addEventListener('seeking', () => counts.seeking++);
  });
}

/** The clip's playback: sampled, then again 600 ms later. */
async function clipPlayback(page: Page) {
  const read = () =>
    page.evaluate(() => {
      const clip = document.getElementById('clip') as HTMLVideoElement & { counts?: object };
      return {
        paused: clip.paused,
        time: clip.currentTime,
        stamped: clip.hasAttribute('data-paused-by-reveal'),
        counts: clip.counts,
      };
    });
  const first = await read();
  await page.waitForTimeout(600);
  const second = await read();
  return {
    paused: second.paused,
    advancing: second.time - first.time > 0.3,
    stamped: second.stamped,
    counts: second.counts,
    time: second.time,
  };
}

test.describe('deleting the slide on screen from the toolbar', () => {
  /**
   * SlideToolbar.performDeleteSlide: the slide shown next is picked while the
   * deleted one is still in place, the slide (or its emptied stack) goes,
   * then syncShowing shows the one picked.
   */
  const toolbarDelete = (page: Page) =>
    page.evaluate(() => {
      const w = window.revealSyncTest as TestWindow;
      const target = w.deck.getCurrentSlide();
      const beside = w.revealSync.slideBeside(w.deck, target);
      const parent = target.parentElement as HTMLElement;
      const onlyChild =
        parent.localName === 'section' &&
        Array.from(parent.children).filter(k => k.localName === 'section').length <= 1;
      (onlyChild ? parent : target).remove();
      w.revealSync.syncShowing(w.deck, beside);
      w.deck.layout();
    });

  const stack = (...kids: string[]) => `<section id="st">${kids.join('')}</section>`;
  for (const [name, slides, path, gone, shown, h, v] of [
    [
      'the first slide: the next one',
      slide('a') + slide('b', CLIP) + slide('c'),
      [[0, 0]],
      'a',
      'b',
      0,
      0,
    ],
    [
      'a middle slide: the one before it',
      slide('a', CLIP) + slide('b') + slide('c'),
      [[1, 0]],
      'b',
      'a',
      0,
      0,
    ],
    [
      'the last slide: the one before it',
      slide('a') + slide('b', CLIP) + slide('c'),
      [[2, 0]],
      'c',
      'b',
      1,
      0,
    ],
    [
      "a stack's first child: the one below it",
      slide('a') + stack(slide('s1'), slide('s2', CLIP), slide('s3')) + slide('c'),
      [[1, 0]],
      's1',
      's2',
      1,
      0,
    ],
    [
      "a stack's middle child: the one above it",
      slide('a') + stack(slide('s1', CLIP), slide('s2'), slide('s3')) + slide('c'),
      [[1, 1]],
      's2',
      's1',
      1,
      0,
    ],
    [
      "a stack's last child: the one above it",
      slide('a') + stack(slide('s1'), slide('s2', CLIP), slide('s3')) + slide('c'),
      [[1, 2]],
      's3',
      's2',
      1,
      1,
    ],
    [
      "a stack's only child: the slide to its left (the stack goes)",
      slide('a', CLIP) + stack(slide('s1')) + slide('c'),
      [[1, 0]],
      's1',
      'a',
      0,
      0,
    ],
    [
      "the first slide, a stack's only child: the slide to its right (the stack goes)",
      stack(slide('s1')) + slide('b', CLIP) + slide('c'),
      [[0, 0]],
      's1',
      'b',
      0,
      0,
    ],
    [
      'the slide after a stack: the stack, on the child it was left on',
      slide('a') + stack(slide('s1'), slide('s2', CLIP)) + slide('c'),
      [
        [1, 1],
        [2, 0],
      ],
      'c',
      's2',
      1,
      1,
    ],
  ] as const) {
    test(`${name} is shown, live, announced once, its video playing`, async ({ page }) => {
      await open(page, slides, [...path[0]]);
      await page.evaluate(
        rest => {
          const w = window.revealSyncTest as TestWindow;
          for (const [h, v] of rest) w.deck.slide(h, v);
          w.events.length = 0;
        },
        path.slice(1).map(p => [...p])
      );
      await watchClip(page);
      await toolbarDelete(page);
      const after = await state(page);
      const clip = await clipPlayback(page);
      expect({
        shown: after.shown,
        current: after.current,
        shownInert: after.shownInert,
        indices: { h: after.indices.h, v: after.indices.v },
        events: after.events,
        clip: { paused: clip.paused, advancing: clip.advancing, stamped: clip.stamped },
      }).toEqual({
        shown,
        current: shown,
        shownInert: false,
        indices: { h, v },
        events: [{ h, v, prev: gone, cur: shown }],
        clip: { paused: false, advancing: true, stamped: false },
      });
    });
  }
});

test.describe('deleting a slide before the one on screen', () => {
  /**
   * The overview's delete of another slide than the one on screen (and the
   * toolbar's, when the slide it was opened on is no longer on screen): the
   * slide (or its emptied stack) goes, syncShowing keeps the one on screen.
   */
  const removeOther = (page: Page, id: string) =>
    page.evaluate(id => {
      const w = window.revealSyncTest as TestWindow;
      const onScreen = w.deck.getCurrentSlide();
      const target = (document.getElementById(id) ??
        document.querySelector(`[data-name="${id}"]`)) as HTMLElement;
      const parent = target.parentElement as HTMLElement;
      const onlyChild =
        parent.localName === 'section' &&
        Array.from(parent.children).filter(k => k.localName === 'section').length <= 1;
      (onlyChild ? parent : target).remove();
      w.revealSync.syncShowing(w.deck, onScreen);
      w.deck.layout();
    }, id);

  // A slide follows the one on screen in each deck: were it the last, sync()
  // would clamp Reveal's old index onto it and nothing would move.
  for (const [name, slides, at, gone, shown, h, v] of [
    ['a slide', slide('a') + slide('b') + slide('c', CLIP) + slide('d'), [2, 0], 'a', 'c', 1, 0],
    [
      'a stack child above it',
      slide('a') +
        `<section id="st">${slide('s1')}${slide('s2')}${slide('s3', CLIP)}${slide('s4')}</section>` +
        slide('c'),
      [1, 2],
      's1',
      's3',
      1,
      1,
    ],
    [
      "a stack's only child (the stack goes)",
      `<section id="st">${slide('s1')}</section>` + slide('b') + slide('c', CLIP) + slide('d'),
      [2, 0],
      's1',
      'c',
      1,
      0,
    ],
  ] as const) {
    test(`${name}: the video on screen plays on, nothing is announced`, async ({ page }) => {
      await open(page, slides, [...at]);
      await watchClip(page, { playing: true });
      await removeOther(page, gone);
      const after = await state(page);
      const clip = await clipPlayback(page);
      expect({
        shown: after.shown,
        current: after.current,
        shownInert: after.shownInert,
        indices: { h: after.indices.h, v: after.indices.v },
        events: after.events,
        clip: {
          paused: clip.paused,
          advancing: clip.advancing,
          stamped: clip.stamped,
          counts: clip.counts,
        },
      }).toEqual({
        shown,
        current: shown,
        shownInert: false,
        indices: { h, v },
        events: [],
        clip: { paused: false, advancing: true, stamped: false, counts: { pause: 0, seeking: 0 } },
      });
      // Reveal moves on from it: the slide to its left comes next.
      await page.evaluate(() => (window.revealSyncTest as TestWindow).deck.left());
      const next = await state(page);
      expect(next.current).not.toBe(shown);
      expect(next.events).toEqual([expect.objectContaining({ prev: shown, cur: next.current })]);
    });
  }

  test('a video paused on the slide on screen stays paused where it was', async ({ page }) => {
    await open(page, slide('a') + slide('b') + slide('c', CLIP) + slide('d'), [2, 0]);
    await watchClip(page, { playing: true });
    const time = await page.evaluate(() => {
      const clip = document.getElementById('clip') as HTMLVideoElement;
      clip.pause();
      return clip.currentTime;
    });
    await removeOther(page, 'a');
    const clip = await clipPlayback(page);
    expect(clip).toMatchObject({ paused: true, stamped: false });
    expect(clip.time).toBeCloseTo(time, 3);
  });

  test('the frame on screen is not reloaded', async ({ page }) => {
    await open(
      page,
      slide('a') +
        slide('b') +
        slide('c', '<iframe id="lazy" data-src="/frame.html"></iframe>') +
        slide('d'),
      null
    );
    await page.evaluate(() => {
      const w = window.revealSyncTest as TestWindow;
      const frame = document.getElementById('lazy') as HTMLIFrameElement & { loads?: number };
      frame.loads = 0;
      frame.addEventListener('load', () => (frame.loads = (frame.loads ?? 0) + 1));
      w.deck.slide(2, 0);
      w.events.length = 0;
    });
    const loads = () =>
      page.evaluate(() => {
        const frame = document.getElementById('lazy') as HTMLIFrameElement & { loads?: number };
        return { loads: frame.loads, src: frame.getAttribute('src') };
      });
    await expect.poll(loads).toEqual({ loads: 1, src: '/frame.html' });
    await removeOther(page, 'a');
    await page.waitForTimeout(500);
    expect(await loads()).toEqual({ loads: 1, src: '/frame.html' });
    expect(await state(page)).toMatchObject({ shown: 'c', current: 'c', events: [] });
  });

  for (const named of [false, true]) {
    test(`with the editor's URL options, a slide ${named ? 'with' : 'without'} an id: the hash follows it, no extra history`, async ({
      page,
    }) => {
      const tag = (name: string) =>
        named
          ? `<section id="${name}"><h2>${name}</h2></section>`
          : `<section data-name="${name}"><h2>${name}</h2></section>`;
      await open(page, tag('a') + tag('b') + tag('c') + tag('d'), [2, 0], {
        config: 'hash: true, history: true,',
      });
      const before = await page.evaluate(() => ({
        hash: location.hash,
        length: history.length,
      }));
      expect(before.hash).toBe(named ? '#/c' : '#/2');
      await removeOther(page, 'a');
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
      // Reveal writes the new hash once, as one slide() does; a slide named
      // by its id keeps its hash and adds no entry.
      expect(after).toEqual({
        hash: named ? '#/c' : '#/1',
        length: named ? before.length : before.length + 1,
      });
      expect(await state(page)).toMatchObject({ current: 'c', indices: { h: 1 }, events: [] });
    });
  }
});

test.describe('with autoplay with sound refused (no click on the page yet)', () => {
  const LOUD = (id: string) =>
    `<video id="${id}" data-autoplay loop preload="auto" src="/tone.wav"></video>`;
  /**
   * Shows b, whose video Reveal plays muted with its unmute button; then, in
   * the page (no user gesture), deletes b as the overview does.
   */
  const SCRIPT = `
deck.slide(1, 0);
events.length = 0;
setTimeout(() => {
  const b = document.getElementById('b');
  window.revealSyncTest.before = {
    button: !!document.querySelector('.r-media-play-button'),
    mark: document.getElementById('loud1').getAttribute('data-muted-by-reveal'),
  };
  window.revealSyncTest.gone = b;
  const onScreen = deck.getCurrentSlide();
  b.remove();
  revealSync.syncShowing(deck, onScreen === b ? null : onScreen);
  deck.layout();
  document.documentElement.dataset.done = '';
}, 1500);`;

  /** Read once, by time: any wait on the page before would count as a click. */
  const after = async (page: Page) => {
    await page.waitForTimeout(4000);
    return page.evaluate(() => {
      const w = window.revealSyncTest as TestWindow;
      const goneVideo = w.gone?.querySelector('video') as HTMLVideoElement;
      return {
        done: document.documentElement.hasAttribute('data-done'),
        before: w.before,
        button: !!document.querySelector('.r-media-play-button'),
        marked: Array.from(document.querySelectorAll('[data-muted-by-reveal]')).map(el => el.id),
        gone: { mark: goneVideo.getAttribute('data-muted-by-reveal'), muted: goneVideo.muted },
        events: w.events,
      };
    });
  };

  test('the slide whose video Reveal muted goes: so do its unmute button and mark', async ({
    page,
  }) => {
    await open(page, slide('a') + slide('b', LOUD('loud1')) + slide('c'), null, {
      script: SCRIPT,
    });
    expect(await after(page)).toEqual({
      done: true,
      before: { button: true, mark: 'true' },
      button: false,
      marked: [],
      gone: { mark: null, muted: false },
      events: [{ h: 1, v: 0, prev: 'b', cur: 'c' }],
    });
  });

  test('the slide shown next has its own refused video: it gets the button and mark', async ({
    page,
  }) => {
    await open(page, slide('a') + slide('b', LOUD('loud1')) + slide('c', LOUD('loud2')), null, {
      script: SCRIPT,
    });
    expect(await after(page)).toEqual({
      done: true,
      before: { button: true, mark: 'true' },
      button: true,
      marked: ['loud2'],
      gone: { mark: null, muted: false },
      events: [{ h: 1, v: 0, prev: 'b', cur: 'c' }],
    });
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
