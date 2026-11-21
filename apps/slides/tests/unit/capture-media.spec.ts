/**
 * Media in the two pages a browser photographs — thumbnail-source (card
 * images) and render-view (deck_render) — is held on its first frame, paused.
 *
 * reveal.js 6 retries a refused autoplay with sound muted, so a `data-autoplay`
 * video (and a background video) plays during the capture and no two pictures
 * are the same; muted and native-`autoplay` videos played under reveal.js 5
 * too. The stored `index.html`, opened on its own, keeps reveal's own autoplay.
 *
 * The generated documents themselves, with the installed reveal.js 6 served
 * for their CDN URLs, in Chrome refusing autoplay with sound (as a headless
 * capture browser does). Media is a WAV tone, so nothing binary is checked in.
 */
import { test, expect, type Page } from '@playwright/test';
import { generateDeckHtml, type DeckJson } from '@classmoji/services/slides';
import { VIEW_API_GLOBAL, VIEW_READY_ATTRIBUTE } from '@classmoji/services/render-contract';
import { THUMBNAIL_READY_ATTRIBUTE } from '@classmoji/services/deck-thumbnail-contract';
import { deckViewSlides, withViewScript } from '../../app/utils/deckView.server.ts';
import { MEDIA_STILL_JS } from '../../app/utils/mediaStill.ts';
import {
  firstSlideOnly,
  withReadinessMarker,
} from '../../app/routes/$slideId_.thumbnail-source/route.tsx';
import { routeJsdelivrToInstalled } from '../helpers/revealCdn.helpers.ts';

test.use({
  channel: 'chrome',
  launchOptions: { args: ['--autoplay-policy=user-gesture-required'] },
});

const ORIGIN = 'https://cm-capture.test';

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

const TONE = `${ORIGIN}/tone.wav`;
/** Past the thumbnail page's outer cap (8 s) and the render view's media wait (4 s). */
const LATE_MS = 9000;

/** One slide per case: what reveal.js 6 plays during a capture without the hold. */
const CASES: Array<{ name: string; slide: DeckJson['slides'][number] }> = [
  {
    name: 'a data-autoplay video with sound',
    slide: { id: 'a', html: `<h2>V</h2><video data-autoplay src="${TONE}"></video>` },
  },
  {
    name: 'a muted data-autoplay video',
    slide: { id: 'a', html: `<h2>V</h2><video data-autoplay muted src="${TONE}"></video>` },
  },
  {
    name: 'a native autoplay video',
    slide: { id: 'a', html: `<h2>V</h2><video autoplay muted src="${TONE}"></video>` },
  },
  {
    name: 'a background video',
    slide: { id: 'a', html: '<h2>B</h2>', attrs: { 'data-background-video': TONE } },
  },
];

const deckOf = (slide: DeckJson['slides'][number]): DeckJson => ({
  version: 1,
  theme: 'black',
  codeTheme: 'github',
  slides: [slide, { id: 'z', html: '<h2>Next</h2>' }],
});

async function serve(page: Page, html: string) {
  await routeJsdelivrToInstalled(page);
  await page.route(`${ORIGIN}/**`, async routed => {
    const path = new URL(routed.request().url()).pathname;
    if (path === '/doc') return routed.fulfill({ contentType: 'text/html', body: html });
    if (path === '/tone.wav') return routed.fulfill({ contentType: 'audio/wav', body: toneWav() });
    // Past every media wait (the hold's 4 s cap): only the play listener is left.
    if (path === '/late.wav') {
      await new Promise(resolve => setTimeout(resolve, LATE_MS));
      return routed.fulfill({ contentType: 'audio/wav', body: toneWav() }).catch(() => {});
    }
    // A host that takes the request and never answers.
    if (path.startsWith('/stall')) return;
    return routed.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/doc`, { waitUntil: 'domcontentloaded' });
}

/** Every media element: paused, at 0, unmuted unless the author muted it, loaded. */
async function mediaState(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('video, audio')].map(el => {
      const media = el as HTMLMediaElement;
      return {
        paused: media.paused,
        atStart: media.currentTime === 0,
        mutedByReveal: media.hasAttribute('data-muted-by-reveal'),
        loaded: media.readyState >= 2,
      };
    })
  );
}

const HELD = { paused: true, atStart: true, mutedByReveal: false, loaded: true };

test.describe('thumbnail-source holds media on its first frame', () => {
  for (const { name, slide } of CASES) {
    test(name, async ({ page }) => {
      const doc = generateDeckHtml(firstSlideOnly(deckOf(slide)), {
        title: 'T',
        includeNotes: false,
        standalone: true,
      });
      await serve(page, withReadinessMarker(doc));
      await page.waitForSelector(`[${THUMBNAIL_READY_ATTRIBUTE}]`, { state: 'attached' });
      // A capture follows the flag at once; and nothing starts after it.
      expect(await mediaState(page)).toEqual([HELD]);
      await page.waitForTimeout(700);
      expect(await mediaState(page)).toEqual([HELD]);
    });
  }
});

test.describe('render-view holds media on its first frame', () => {
  for (const { name, slide } of CASES) {
    test(name, async ({ page }) => {
      const deck = deckOf(slide);
      const doc = generateDeckHtml(deck, { title: 'T', includeNotes: false, standalone: true });
      await serve(
        page,
        withViewScript(doc, {
          kind: 'deck',
          version: 'x',
          width: 960,
          height: 700,
          slides: deckViewSlides(deck),
        })
      );
      await page.waitForSelector(`[${VIEW_READY_ATTRIBUTE}]`, { state: 'attached' });
      const shown = await page.evaluate(
        api => (Reflect.get(window, api) as { show(id: string): Promise<unknown> }).show('a'),
        VIEW_API_GLOBAL
      );
      expect(shown).toMatchObject({ id: 'a' });
      const state = await mediaState(page);
      expect(state.length).toBeGreaterThan(0);
      for (const media of state) expect(media).toEqual(HELD);
    });
  }
});

/** The render-view document for `deck`, opened and ready. */
async function openView(page: Page, deck: DeckJson) {
  const doc = generateDeckHtml(deck, { title: 'T', includeNotes: false, standalone: true });
  await serve(
    page,
    withViewScript(doc, {
      kind: 'deck',
      version: 'x',
      width: 960,
      height: 700,
      slides: deckViewSlides(deck),
    })
  );
  await page.waitForSelector(`[${VIEW_READY_ATTRIBUTE}]`, { state: 'attached' });
}

const show = (page: Page, id: string) =>
  page.evaluate(
    ([api, slide]) =>
      (Reflect.get(window, api) as { show(id: string): Promise<unknown> }).show(slide),
    [VIEW_API_GLOBAL, id] as const
  );

test.describe('media that arrives after every wait is still held', () => {
  const LATE: DeckJson['slides'][number] = {
    id: 'a',
    html: `<h2>V</h2><video data-autoplay muted src="${ORIGIN}/late.wav"></video>`,
  };
  /** The late video: not there when the page is done, then held once it arrives. */
  async function heldAfterArrival(page: Page) {
    expect((await mediaState(page))[0]).toMatchObject({ loaded: false });
    await page.waitForFunction(
      () => (document.querySelector('video')?.readyState ?? 0) >= 2,
      null,
      {
        timeout: 15_000,
      }
    );
    // Longer than Reveal takes to start it; the tone is 2 s, so a video that
    // played would be playing or over.
    await page.waitForTimeout(1500);
    expect(await mediaState(page)).toEqual([
      { paused: true, atStart: true, mutedByReveal: false, loaded: true },
    ]);
  }

  test('on the thumbnail page (after its 8 s outer cap)', async ({ page }) => {
    const doc = generateDeckHtml(firstSlideOnly(deckOf(LATE)), {
      title: 'T',
      includeNotes: false,
      standalone: true,
    });
    await serve(page, withReadinessMarker(doc));
    await page.waitForSelector(`[${THUMBNAIL_READY_ATTRIBUTE}]`, { state: 'attached' });
    await heldAfterArrival(page);
  });

  test('in the render view', async ({ page }) => {
    await openView(page, deckOf(LATE));
    expect(await show(page, 'a')).toMatchObject({ id: 'a' });
    await heldAfterArrival(page);
  });
});

test.describe('render-view waits for media out of one budget per visit', () => {
  test('a deck whose media never loads still returns every slide in time', async ({ page }) => {
    test.setTimeout(90_000);
    // Every kind of media Reveal starts, from a host that never answers.
    const stalled = (n: number): DeckJson['slides'][number] => {
      const src = `${ORIGIN}/stall-${n}.wav`;
      const kinds: Array<DeckJson['slides'][number]> = [
        { id: `s${n}`, html: `<video data-autoplay src="${src}"></video>` },
        { id: `s${n}`, html: '<h2>B</h2>', attrs: { 'data-background-video': src } },
        { id: `s${n}`, html: `<audio data-autoplay src="${src}"></audio>` },
        { id: `s${n}`, html: `<video data-autoplay><source src="${src}"></video>` },
      ];
      return kinds[n % kinds.length];
    };
    const slides = Array.from({ length: 30 }, (_, n) => stalled(n));
    await openView(page, { version: 1, theme: 'black', codeTheme: 'github', slides });

    // As deck_render does: every slide in turn, inside one 60 s render. Stop
    // early rather than run into the test timeout when the waits are per slide.
    const started = Date.now();
    const shown: unknown[] = [];
    for (const { id } of slides) {
      if (Date.now() - started > 25_000) break;
      shown.push(await show(page, id));
    }
    const elapsed = Date.now() - started;
    expect(shown).toHaveLength(30);
    shown.forEach((measure, n) => expect(measure).toMatchObject({ id: `s${n}` }));
    // The budget (8 s) plus a little per slide; never 4 s a slide.
    expect(elapsed).toBeLessThan(15_000);
  });
});

test.describe('the stored document keeps reveal’s own autoplay', () => {
  test('carries none of the hold', () => {
    const doc = generateDeckHtml(deckOf(CASES[1].slide), { title: 'T', includeNotes: true });
    expect(doc).not.toContain('cmHoldMedia');
    expect(doc).not.toContain(MEDIA_STILL_JS.trim().split('\n')[0]);
  });

  test('a muted data-autoplay video plays when the document is opened', async ({ page }) => {
    const doc = generateDeckHtml(deckOf(CASES[1].slide), { title: 'T', includeNotes: true });
    await serve(page, doc);
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return !!video && !video.paused && video.currentTime > 0;
    });
  });
});
