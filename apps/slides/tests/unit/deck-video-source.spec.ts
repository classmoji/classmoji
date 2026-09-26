/**
 * A video moved to Cloudinary is read out of the content repo and then deleted
 * there, so the file its URL names must belong to the deck being edited.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { deckVideoSource } from '../../app/utils/deckVideoSource.ts';

const DECK = { org: 'cs52', repo: 'cs52-content', contentPath: 'slides/week-1' };

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/routes/api.video.upload-cloudinary/route.tsx', import.meta.url)),
  'utf8'
);

test.describe('deckVideoSource', () => {
  test('a file in the deck folder is the deck’s', () => {
    expect(
      deckVideoSource('/content/cs52/cs52-content/slides/week-1/videos/intro.mp4', DECK)
    ).toEqual({
      kind: 'repo',
      org: 'cs52',
      repo: 'cs52-content',
      path: 'slides/week-1/videos/intro.mp4',
    });
  });

  test('the dev stack’s absolute localhost URL parses the same way', () => {
    expect(
      deckVideoSource(
        'http://localhost:6500/content/cs52/cs52-content/slides/week-1/videos/intro.mp4?x=1',
        DECK
      )
    ).toMatchObject({ kind: 'repo', path: 'slides/week-1/videos/intro.mp4' });
  });

  test('an external URL is left to Cloudinary', () => {
    expect(deckVideoSource('https://example.com/intro.mp4', DECK)).toEqual({ kind: 'external' });
  });

  for (const [why, url] of [
    ['another org', '/content/other-org/cs52-content/slides/week-1/videos/intro.mp4'],
    ['another repo', '/content/cs52/other-repo/slides/week-1/videos/intro.mp4'],
    ['another deck', '/content/cs52/cs52-content/slides/week-2/videos/intro.mp4'],
    ['a sibling whose name starts the same', '/content/cs52/cs52-content/slides/week-10/a.mp4'],
    ['a path that climbs out', '/content/cs52/cs52-content/slides/week-1/../week-2/a.mp4'],
    ['a file at the repo root', '/content/cs52/cs52-content/secret.mp4'],
  ] as const) {
    test(`${why} is refused`, () => {
      expect(deckVideoSource(url, DECK)).toEqual({ kind: 'foreign' });
    });
  }

  test('a deck with no folder owns nothing', () => {
    expect(
      deckVideoSource('/content/cs52/cs52-content/slides/week-1/a.mp4', {
        ...DECK,
        contentPath: null,
      })
    ).toEqual({ kind: 'foreign' });
  });
});

test.describe('the Cloudinary route', () => {
  test('refuses a foreign file before it reads or deletes anything', () => {
    const check = ROUTE_SOURCE.indexOf("if (source.kind === 'foreign')");
    const read = ROUTE_SOURCE.indexOf('await fetchContent(');
    const remove = ROUTE_SOURCE.indexOf('await ContentService.delete(');

    for (const at of [check, read, remove]) expect(at).toBeGreaterThan(-1);
    expect(check).toBeLessThan(read);
    expect(check).toBeLessThan(remove);
  });
});
