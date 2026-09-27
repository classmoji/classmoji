/**
 * `canonicalizeDeckForSave` when the full pass fails.
 *
 * The full pass reads the asset map (Postgres) to turn signed BLOB urls back
 * into repo paths, and a failure there is swallowed so a save is never lost.
 * But the editor holds every `media://` reference SIGNED, so returning the deck
 * unchanged would commit an expiring media signature for every video on it.
 * Undoing a media url needs no database, so the fallback still does that — and
 * turns `/missing/` placeholders back into their references — while leaving a
 * blob url it cannot trace as it is.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  return {
    ...actual,
    canonicalizeMany: (...args: unknown[]) => canonicalizeManyMock(...args),
  };
});

const { canonicalizeDeckForSave } = await import('../slideContent.service.ts');

const ORIGIN = 'https://content-staging.classmoji.io';
const CLASSROOM = '11111111-2222-4333-8444-555555555555';
const OTHER_CLASSROOM = '99999999-2222-4333-8444-555555555555';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SIGNED_MEDIA = `${ORIGIN}/c/${CLASSROOM}/media/${MEDIA_ID}/orig.mp4?e=1&s=abc`;
const FOREIGN_HOST = `https://elsewhere.example/c/${CLASSROOM}/media/${MEDIA_ID}/orig.mp4?e=1`;
const OTHER_CLASS = `${ORIGIN}/c/${OTHER_CLASSROOM}/media/${MEDIA_ID}/orig.mp4?e=1`;
const SIGNED_BLOB = `${ORIGIN}/c/${CLASSROOM}/blob/0123456789abcdef0123456789abcdef01234567/a.png?e=1`;
const PLACEHOLDER = `${ORIGIN}/c/${CLASSROOM}/missing/${encodeURIComponent(`media://${MEDIA_ID}`)}`;

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

const deckWith = (html: string, notes?: string): DeckJson => ({
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [{ id: 'aaaa1111', html, ...(notes ? { notes } : {}) }],
});

let savedOrigin: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedOrigin = process.env.CONTENT_DELIVERY_ORIGIN;
  // The host check reads this: without it no host is "ours" and nothing would
  // be rewritten — a test passing for the wrong reason.
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  canonicalizeManyMock.mockRejectedValue(new Error('asset map unavailable'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.CONTENT_DELIVERY_ORIGIN;
  else process.env.CONTENT_DELIVERY_ORIGIN = savedOrigin;
  vi.restoreAllMocks();
});

describe('canonicalizeDeckForSave — the full pass throws', () => {
  it('still turns a signed media url of ours back into media://{id}', async () => {
    const out = await canonicalizeDeckForSave(
      slide,
      deckWith(
        `<video src="${SIGNED_MEDIA}"></video><div data-background-video="${SIGNED_MEDIA}"></div>`
      )
    );
    expect(canonicalizeManyMock).toHaveBeenCalled();
    const html = out.slides[0].html ?? '';
    expect(html).not.toContain(ORIGIN);
    expect(html.split(`media://${MEDIA_ID}`).length - 1).toBe(2);
  });

  it('turns a /missing/ placeholder back into its reference', async () => {
    const out = await canonicalizeDeckForSave(
      slide,
      deckWith(`<video src="${PLACEHOLDER}"></video>`)
    );
    expect(out.slides[0].html).toContain(`src="media://${MEDIA_ID}"`);
  });

  it('leaves a blob url it cannot trace, another host and another classroom alone', async () => {
    const html = [
      `<img src="${SIGNED_BLOB}">`,
      `<video src="${FOREIGN_HOST}"></video>`,
      `<video src="${OTHER_CLASS}"></video>`,
    ].join('');
    const out = await canonicalizeDeckForSave(slide, deckWith(html));
    const result = out.slides[0].html ?? '';
    expect(result).toContain(SIGNED_BLOB.replace(/&/g, '&amp;').split('?')[0]);
    expect(result).toContain('https://elsewhere.example/');
    expect(result).toContain(`/c/${OTHER_CLASSROOM}/media/`);
    expect(result).not.toContain('media://');
  });

  it('with no delivery origin, rewrites nothing (no host is ours)', async () => {
    delete process.env.CONTENT_DELIVERY_ORIGIN;
    const out = await canonicalizeDeckForSave(
      slide,
      deckWith(`<video src="${SIGNED_MEDIA}"></video>`)
    );
    expect(out.slides[0].html).not.toContain('media://');
  });
});
