/**
 * Preview decks (the speaker view's current and next panes, thumbnails:
 * RevealPresenter's previewMode) with the browser refusing autoplay with
 * sound, as Chrome does in a frame nobody has clicked.
 *
 * reveal.js 5 left a video it could not autoplay paused. reveal.js 6 plays it
 * muted instead and shows an unmute button; in a preview nobody can click it.
 * previewMedia.ts keeps the reveal.js 5 behaviour there, and global.css
 * hides the button; muted videos (and muted background videos) still play.
 *
 * Real reveal.js 6.0.2 in Chrome; previewMedia.ts is loaded with its types
 * stripped (the module has no imports).
 */
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

test.use({
  channel: 'chrome',
  launchOptions: { args: ['--autoplay-policy=user-gesture-required'] },
});

const ORIGIN = 'http://cm-preview-media.test';
const revealDist = dirname(createRequire(import.meta.url).resolve('reveal.js'));

/** The preview rule from global.css, as the app ships it. */
const PREVIEW_CSS = (() => {
  const css = readFileSync(new URL('../../app/styles/global.css', import.meta.url), 'utf8');
  return css.match(/\.reveal\[data-preview\] \.r-media-play-button \{[^}]*\}/)?.[0] ?? '';
})();

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

const SLIDES =
  '<section id="a"><h2>Media</h2>' +
  '<video id="loud" data-autoplay loop src="/tone.wav"></video>' +
  '<video id="quiet" data-autoplay muted loop src="/tone.wav"></video></section>' +
  // Two sources: reveal.js carries one <video> across slides with the same background.
  '<section id="b" data-background-video="/tone.wav?b" data-background-video-loop><h2>Background</h2></section>' +
  '<section id="c" data-background-video="/tone.wav?c" data-background-video-loop data-background-video-muted><h2>Muted background</h2></section>';

/**
 * The deck opened on slide `start`. Nothing here may run from the test
 * (`page.evaluate` counts as a user gesture, after which Chrome allows sound).
 */
function pageHtml(preview: boolean, start: number): string {
  return `<!doctype html><html><head><link rel="stylesheet" href="/reveal.css">
<style>html, body { margin: 0; height: 100%; } ${PREVIEW_CSS}</style></head><body>
<div class="reveal"${preview ? ' data-preview=""' : ''}><div class="slides">${SLIDES}</div></div>
<script type="module">
import Reveal from '/reveal.mjs';
import { keepRefusedAutoplayPaused } from '/previewMedia.js';
const el = document.querySelector('.reveal');
${preview ? 'keepRefusedAutoplayPaused(el);' : ''}
const deck = new Reveal(el, {
  hash: false, history: false, transition: 'none', controls: false, progress: false, keyboard: false,
});
await deck.initialize();
deck.slide(${start}, 0);
document.documentElement.dataset.ready = '';
</script></body></html>`;
}

async function open(page: Page, preview: boolean, start = 0) {
  const helper = stripTypeScriptTypes(
    readFileSync(new URL('../../app/utils/previewMedia.ts', import.meta.url), 'utf8')
  );
  await page.route(`${ORIGIN}/**`, async routed => {
    const path = new URL(routed.request().url()).pathname;
    const js = 'text/javascript';
    if (path === '/deck')
      return routed.fulfill({ contentType: 'text/html', body: pageHtml(preview, start) });
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
    if (path === '/previewMedia.js') return routed.fulfill({ contentType: js, body: helper });
    if (path === '/tone.wav') return routed.fulfill({ contentType: 'audio/wav', body: toneWav() });
    return routed.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/deck`);
  await page.waitForSelector('html[data-ready]', { state: 'attached' });
}

/** Each video's playback, and whether reveal's media button is on screen. */
async function media(page: Page) {
  // Long enough for the media to load, reveal to retry muted, and the hold to act.
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const show = (v: HTMLMediaElement | null) =>
      v && { paused: v.paused, muted: v.muted, mark: v.getAttribute('data-muted-by-reveal') };
    const button = document.querySelector<HTMLElement>('.r-media-play-button');
    return {
      loud: show(document.getElementById('loud') as HTMLMediaElement | null),
      quiet: show(document.getElementById('quiet') as HTMLMediaElement | null),
      background: show(document.querySelector('.slide-background.present video')),
      buttonShown: !!button && getComputedStyle(button).display !== 'none',
    };
  });
}

test('the app ships the preview rule that hides the media button', () => {
  expect(PREVIEW_CSS).not.toBe('');
});

test('a preview deck is marked and holds refused autoplay from before Reveal starts', () => {
  const presenter = readFileSync(
    new URL('../../app/components/RevealPresenter.tsx', import.meta.url),
    'utf8'
  );
  expect(presenter).toContain("data-preview={previewMode ? '' : undefined}");
  const hold = presenter.indexOf('stopPreviewMedia = keepRefusedAutoplayPaused(deckRef.current);');
  expect(hold).toBeGreaterThan(-1);
  expect(presenter.lastIndexOf('if (previewMode) {', hold)).toBeGreaterThan(-1);
  expect(hold).toBeLessThan(presenter.indexOf('new Reveal(deckRef.current, config)'));
  // …and lets go when the deck is torn down.
  const cleanup = presenter.indexOf(
    'stopPreviewMedia();',
    presenter.indexOf('return () => {', hold)
  );
  expect(cleanup).toBeGreaterThan(-1);
});

test.describe('a video whose autoplay with sound is refused', () => {
  test('outside a preview: reveal.js 6 plays it muted and offers to unmute (the control)', async ({
    page,
  }) => {
    await open(page, false);
    expect(await media(page)).toMatchObject({
      loud: { paused: false, muted: true, mark: 'true' },
      quiet: { paused: false, muted: true },
      buttonShown: true,
    });
  });

  test('in a preview: it stays paused, unmuted, with no button; a muted video still plays', async ({
    page,
  }) => {
    await open(page, true);
    expect(await media(page)).toMatchObject({
      loud: { paused: true, muted: false, mark: null },
      quiet: { paused: false, muted: true },
      buttonShown: false,
    });
  });
});

test.describe('background videos', () => {
  for (const preview of [false, true]) {
    const where = preview ? 'in a preview' : 'outside a preview';
    test(`${where}: a muted one plays`, async ({ page }) => {
      await open(page, preview, 2);
      expect((await media(page)).background).toMatchObject({ paused: false, muted: true });
    });

    test(`${where}: one with sound ${preview ? 'waits, as before' : 'plays muted (the control)'}`, async ({
      page,
    }) => {
      await open(page, preview, 1);
      expect(await media(page)).toMatchObject(
        preview
          ? { background: { paused: true, muted: false, mark: null }, buttonShown: false }
          : { background: { paused: false, muted: true, mark: 'true' }, buttonShown: true }
      );
    });
  }
});
