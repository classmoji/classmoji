/**
 * deck_render pictures show the whole slide, whatever the deck's size.
 *
 * The driver lays the deck out with margin 0, and reveal.js 6 rounds its scale
 * to two decimals: a scale rounded UP (1280x720 at 480 px: 0.375 drawn at
 * 0.38) put the slide past the viewport and cut its edges off, and so did
 * reveal's minScale (0.2) for a deck that needs less. The driver caps the
 * scale at the exact fit floored to two decimals; a 960x700 deck (every deck
 * in use today) keeps exactly 0.5 and 1.
 *
 * The generated render-view document with the installed reveal.js 6, sized
 * the way the MCP sizes it (apps/mcp/src/render/deckRender.ts): opened at the
 * 960x700 aspect, resized to the deck's own once the ready flag is up.
 */
import { test, expect } from '@playwright/test';
import { generateDeckHtml, type DeckJson } from '@classmoji/services/slides';
import { VIEW_API_GLOBAL, VIEW_READY_ATTRIBUTE } from '@classmoji/services/render-contract';
import { deckViewSlides, withViewScript } from '../../app/utils/deckView.server.ts';
import { routeJsdelivrToInstalled } from '../helpers/revealCdn.helpers.ts';

test.use({ channel: 'chrome' });

const ORIGIN = 'https://cm-render-fit.test';

/** deckRender.ts's `heightFor`. */
const heightFor = (width: number, size: { width: number; height: number }) =>
  Math.max(1, Math.round((width * size.height) / size.width));

function deckOf(width: number, height: number): DeckJson {
  return {
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    config: { width, height, center: false },
    slides: [
      {
        id: 'frame',
        html: `<div style="position:absolute;left:0;top:0;width:${width}px;height:${height}px;box-sizing:border-box;border:6px solid #e11"></div>`,
      },
      { id: 'text', html: `<h1>${width}x${height}</h1>` },
    ],
  };
}

for (const [deckWidth, deckHeight] of [
  [1280, 720],
  [1920, 1080],
  [800, 600],
  [960, 700],
  // Below reveal's minScale (0.2) at 480 px: the cap wins over that clamp too.
  [2560, 1440],
]) {
  for (const width of [480, 960]) {
    test(`a ${deckWidth}x${deckHeight} deck at ${width} px fits the picture`, async ({ page }) => {
      const deck = deckOf(deckWidth, deckHeight);
      const html = withViewScript(
        generateDeckHtml(deck, { title: 'T', includeNotes: false, standalone: true }),
        {
          kind: 'deck',
          version: 'x',
          width: deckWidth,
          height: deckHeight,
          slides: deckViewSlides(deck),
        }
      );
      await routeJsdelivrToInstalled(page);
      await page.route(`${ORIGIN}/**`, routed =>
        routed.fulfill({ contentType: 'text/html', body: html })
      );
      await page.setViewportSize({ width, height: heightFor(width, { width: 960, height: 700 }) });
      await page.goto(`${ORIGIN}/view`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[${VIEW_READY_ATTRIBUTE}]`, { state: 'attached' });
      const viewport = {
        width,
        height: heightFor(width, { width: deckWidth, height: deckHeight }),
      };
      await page.setViewportSize(viewport);
      // The cap never goes through Reveal.configure, which re-syncs the deck
      // (embeds, backgrounds) and changes slides that hold an embed.
      await page.evaluate(() => {
        const reveal = Reflect.get(window, 'Reveal') as { configure(...args: unknown[]): void };
        const configure = reveal.configure.bind(reveal);
        Reflect.set(window, '__configures', 0);
        reveal.configure = (...args: unknown[]) => {
          Reflect.set(window, '__configures', Number(Reflect.get(window, '__configures')) + 1);
          configure(...args);
        };
      });

      for (const id of ['frame', 'text']) {
        const measured = await page.evaluate(
          ([api, slide]) =>
            (Reflect.get(window, api) as { show(id: string): Promise<unknown> }).show(slide),
          [VIEW_API_GLOBAL, id] as const
        );
        // Measured in the deck's own px, so the cap changes no verdict.
        expect(measured).toMatchObject({
          id,
          overflow_px: { top: 0, right: 0, bottom: 0, left: 0 },
        });
        const { scale, box } = await page.evaluate(() => {
          const r = document.querySelector('.reveal .slides')?.getBoundingClientRect();
          const reveal = Reflect.get(window, 'Reveal') as { getScale(): number };
          return { scale: reveal.getScale(), box: r ? [r.left, r.top, r.right, r.bottom] : [] };
        });
        const exact = Math.min(viewport.width / deckWidth, viewport.height / deckHeight);
        expect(scale).toBeLessThanOrEqual(exact + 1e-9);
        expect(scale).toBeGreaterThan(exact - 0.01);
        // Inside the viewport, to layout precision (1/64 px).
        const [left, top, right, bottom] = box;
        expect(left).toBeGreaterThanOrEqual(-0.02);
        expect(top).toBeGreaterThanOrEqual(-0.02);
        expect(right).toBeLessThanOrEqual(viewport.width + 0.02);
        expect(bottom).toBeLessThanOrEqual(viewport.height + 0.02);
        if (deckWidth === 960 && deckHeight === 700) {
          // Today's decks: exactly the scale they always had, edge to edge.
          expect(scale).toBe(width / 960);
          expect(box).toEqual([0, 0, viewport.width, viewport.height]);
        }
      }
      expect(await page.evaluate(() => Reflect.get(window, '__configures'))).toBe(0);
    });
  }
}
