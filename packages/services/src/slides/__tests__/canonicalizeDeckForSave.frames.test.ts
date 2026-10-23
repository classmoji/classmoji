/**
 * `canonicalizeDeckForSave`'s frame backstop: whatever path a deck takes to a
 * save (editor, checkpoint, MCP), a files URL of this classroom and this
 * deck's editor frame URL are stored as deck-relative references, and display
 * attributes never reach a commit — with or without the asset map.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signFilesBase } from '@classmoji/content-signing';
import type { DeckJson } from '../deckTypes.ts';

vi.mock('@classmoji/database', () => ({
  default: () => {
    throw new Error('no database in this test');
  },
}));

const canonicalizeManyMock = vi.fn();
vi.mock('../../classmoji/contentDelivery.service.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../classmoji/contentDelivery.service.ts')>();
  return { ...actual, canonicalizeMany: (...args: unknown[]) => canonicalizeManyMock(...args) };
});

const { canonicalizeDeckForSave } = await import('../slideContent.service.ts');

const ORIGIN = 'https://content-staging.classmoji.io';
const CLASSROOM = '11111111-2222-4333-8444-555555555555';
const OTHER_CLASSROOM = '99999999-2222-4333-8444-555555555555';
const SLIDE_ID = '7a1b2c3d-0000-4000-8000-00000000000a';

const slide = {
  id: SLIDE_ID,
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

const deckWith = (html: string, attrs?: Record<string, string>): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [{ id: 'aaaa1111', html, ...(attrs ? { attrs } : {}) }],
});

const base = (classroomId: string) =>
  signFilesBase(
    ORIGIN,
    { master: 'secret', classroomId, keyVersion: 1, tier: 'week' },
    { folders: [{ path: 'slides/deck/games', treeSha: 'a'.repeat(40) }] }
  );

let savedOrigin: string | undefined;
beforeEach(() => {
  savedOrigin = process.env.CONTENT_DELIVERY_ORIGIN;
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  canonicalizeManyMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.CONTENT_DELIVERY_ORIGIN;
  else process.env.CONTENT_DELIVERY_ORIGIN = savedOrigin;
  vi.restoreAllMocks();
});

describe('canonicalizeDeckForSave — frames', () => {
  for (const mapState of ['available', 'unavailable'] as const) {
    it(`stores deck-relative references (asset map ${mapState})`, async () => {
      if (mapState === 'available') {
        canonicalizeManyMock.mockImplementation(
          async (_ctx: unknown, refs: string[]) => new Map(refs.map(ref => [ref, ref]))
        );
      } else {
        canonicalizeManyMock.mockRejectedValue(new Error('asset map unavailable'));
      }
      const signed = `${await base(CLASSROOM)}slides/deck/games/snake/index.html?level=2`;
      const out = await canonicalizeDeckForSave(
        slide,
        deckWith(
          `<iframe src="${signed}"></iframe>` +
            `<div class="sl-block" data-block-type="html"><div class="sl-block-content">` +
            `<iframe data-cm-src="blocks/ab12cd34.html" data-cm-rev="r1" src="/${SLIDE_ID}/frame/slides/deck/blocks/ab12cd34.html?cm-rev=r1" data-cm-orig-src="x"></iframe>` +
            `</div></div>`,
          { 'data-background-iframe': `/${SLIDE_ID}/frame/games/sketchkit/draw.html?deck=d` }
        )
      );
      expect(out.slides[0].html).toBe(
        '<iframe src="games/snake/index.html?level=2"></iframe>' +
          '<div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
          '<iframe data-cm-src="blocks/ab12cd34.html" data-cm-rev="r1"></iframe>' +
          '</div></div>'
      );
      expect(out.slides[0].attrs).toEqual({
        'data-background-iframe': '../../games/sketchkit/draw.html?deck=d',
      });
    });
  }

  it("leaves another classroom's files URL and another deck's editor URL as they are", async () => {
    canonicalizeManyMock.mockImplementation(
      async (_ctx: unknown, refs: string[]) => new Map(refs.map(ref => [ref, ref]))
    );
    const foreign = `${await base(OTHER_CLASSROOM)}slides/deck/games/a.html`;
    const otherDeck = '/8a1b2c3d-0000-4000-8000-00000000000b/frame/slides/deck/games/a.html';
    const html = `<iframe src="${foreign}"></iframe><iframe src="${otherDeck}"></iframe>`;
    const out = await canonicalizeDeckForSave(slide, deckWith(html));
    expect(out.slides[0].html).toBe(html);
  });
});
