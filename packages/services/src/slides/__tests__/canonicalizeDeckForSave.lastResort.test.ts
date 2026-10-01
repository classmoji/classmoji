/**
 * `canonicalizeDeckForSave` when both structured passes fail.
 *
 * The full pass needs the asset map; the fallback needs only the HTML parse.
 * If that parse throws too, the deck must still never be committed with a
 * signed media URL in it — an expiring signature frozen into the document — so
 * the last resort strips them at the text level, scoped to the delivery host
 * and this classroom, and leaves everything else exactly as it was.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DeckJson } from '../deckTypes.ts';

vi.mock('@classmoji/database', () => ({
  default: () => {
    throw new Error('no database in this test');
  },
}));

vi.mock('../deckAssets.ts', () => ({
  canonicalizeDeckAssets: async () => {
    throw new Error('parse failed');
  },
}));

const { canonicalizeDeckForSave } = await import('../slideContent.service.ts');

const ORIGIN = 'https://content-staging.classmoji.io';
const CLASSROOM = '11111111-2222-4333-8444-555555555555';
const OTHER_CLASSROOM = '99999999-2222-4333-8444-555555555555';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SIGNED = `${ORIGIN}/c/${CLASSROOM}/media/${MEDIA_ID}/orig.mp4?p=week&e=1&s=abc`;
const FOREIGN_HOST = `https://elsewhere.example/c/${CLASSROOM}/media/${MEDIA_ID}/orig.mp4?e=1`;
const OTHER_CLASS = `${ORIGIN}/c/${OTHER_CLASSROOM}/media/${MEDIA_ID}/orig.mp4?e=1`;

const slide = {
  id: 'slide-1',
  title: 'Deck',
  content_path: 'slides/deck',
  classroom: {
    id: CLASSROOM,
    content_key_version: 1,
    content_repo: 'content',
    content_delivery_enabled: true,
    git_organization: { provider: 'GITHUB', login: 'org' },
  },
};

const deck = (html: string, customCss?: string): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  ...(customCss ? { customCss } : {}),
  slides: [{ id: 'aaaa1111', html }],
});

let savedOrigin: string | undefined;
beforeEach(() => {
  savedOrigin = process.env.CONTENT_DELIVERY_ORIGIN;
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.CONTENT_DELIVERY_ORIGIN;
  else process.env.CONTENT_DELIVERY_ORIGIN = savedOrigin;
  vi.restoreAllMocks();
});

describe('canonicalizeDeckForSave — every structured pass throws', () => {
  it('still stores media://{id} for each signed media url of ours, wherever it is', async () => {
    const escaped = SIGNED.replace(/&/g, '&amp;');
    const out = await canonicalizeDeckForSave(
      slide,
      deck(
        `<video src="${escaped}"></video>` +
          `<section data-background-video="${SIGNED},${SIGNED}"></section>` +
          `<div style="background:url(&quot;${escaped}&quot;)"></div>`,
        `.a { background: url("${SIGNED}"); }`
      )
    );
    const html = out.slides[0].html ?? '';
    expect(html).not.toContain(ORIGIN);
    expect(out.customCss).toBe(`.a { background: url("media://${MEDIA_ID}"); }`);
    expect(html).toBe(
      `<video src="media://${MEDIA_ID}"></video>` +
        `<section data-background-video="media://${MEDIA_ID},media://${MEDIA_ID}"></section>` +
        `<div style="background:url(&quot;media://${MEDIA_ID}&quot;)"></div>`
    );
  });

  it('leaves another host, another classroom and plain text alone', async () => {
    const html = `<video src="${FOREIGN_HOST}"></video><video src="${OTHER_CLASS}"></video><p>hello</p>`;
    const out = await canonicalizeDeckForSave(slide, deck(html));
    expect(out.slides[0].html).toBe(html);
  });

  it('with no delivery origin, no host is ours and nothing changes', async () => {
    delete process.env.CONTENT_DELIVERY_ORIGIN;
    const input = deck(`<video src="${SIGNED}"></video>`);
    const out = await canonicalizeDeckForSave(slide, input);
    expect(out).toEqual(input);
  });
});
