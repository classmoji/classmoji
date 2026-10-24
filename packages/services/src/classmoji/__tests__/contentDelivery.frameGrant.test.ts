/**
 * Which folders a frame grant names (`chooseFrameGrantFolders`): the folder
 * rules with no database. The signer reads the layout from the asset map and
 * the slide/page rows; here it is built by hand.
 */

import { describe, it, expect } from 'vitest';

import { encodeFilesGrant } from '@classmoji/content-signing';

import { chooseFrameGrantFolders, type FrameLayout } from '../contentDelivery.service.ts';

const DECK = 'slides/week-1';
const sha = (char: string) => char.repeat(40);

function layout(
  subfolders: string[],
  extra: Partial<Omit<FrameLayout, 'subfolders'>> & { shas?: Record<string, string> } = {}
): FrameLayout {
  return {
    subfolders: new Map(
      subfolders.map(name => {
        const path = `${DECK}/${name}`;
        return [path, extra.shas?.[path] ?? sha('a')];
      })
    ),
    itemFolders: extra.itemFolders ?? [DECK, 'slides/week-2', 'pages/lab-1'],
    sourcePaths: extra.sourcePaths ?? [],
  };
}

const choose = (target: string, l: FrameLayout = layout(['blocks', 'games'])) =>
  chooseFrameGrantFolders(target, DECK, l);

describe('chooseFrameGrantFolders', () => {
  it("a target in the deck: the deck's subfolders, never the deck folder itself", () => {
    expect(choose(`${DECK}/blocks/a.html`)).toEqual({
      folders: [`${DECK}/blocks`, `${DECK}/games`],
      targetFolder: `${DECK}/blocks`,
    });
  });

  it("a target outside the deck: the deck's subfolders plus the target's own folder", () => {
    expect(choose('games/sketchkit/draw.html')).toEqual({
      folders: ['games/sketchkit', `${DECK}/blocks`, `${DECK}/games`],
      targetFolder: 'games/sketchkit',
    });
  });

  it('a target directly in the deck folder: that folder alone', () => {
    expect(choose(`${DECK}/demo.html`)).toEqual({ folders: [DECK], targetFolder: DECK });
  });

  it('a subfolder of another deck may be embedded', () => {
    expect(choose('slides/week-2/games/x.html')).toMatchObject({
      targetFolder: 'slides/week-2/games',
    });
  });

  it('refuses stored documents, the repo root and reserved folders', () => {
    for (const target of [
      `${DECK}/index.html`,
      `${DECK}/deck.json`,
      'pages/lab-1/content.json',
      'index.html',
      '.github/workflows/x.html',
      '.classmoji/x.html',
      'bot-context/a/x.html',
      '.slidesthemes/dark/x.html',
      'slides/x.html',
      'pages/x.html',
    ]) {
      expect(choose(target), target).toHaveProperty('refusal');
    }
  });

  it('refuses a folder that is or holds a slide or page, or holds a FILE slide', () => {
    expect(choose('slides/week-2/x.html')).toHaveProperty('refusal');
    expect(choose('pages/lab-1/x.html')).toHaveProperty('refusal');
    expect(
      choose('course/x.html', layout([], { itemFolders: [DECK, 'course/slides-deck'] }))
    ).toHaveProperty('refusal');
    expect(
      choose('handouts/x.html', layout([], { sourcePaths: ['handouts/week1.html'] }))
    ).toHaveProperty('refusal');
  });

  it('refuses a target folder whose name a grant cannot carry', () => {
    expect(choose('games/a%20b/x.html')).toHaveProperty('refusal');
  });

  it('leaves out subfolders a grant cannot carry; the rest still sign', () => {
    const odd = layout(['blocks', 'tab\there', 'pct%20name', 'games', 'badsha'], {
      shas: { [`${DECK}/badsha`]: 'not-a-sha' },
    });
    expect(choose(`${DECK}/blocks/a.html`, odd)).toEqual({
      folders: [`${DECK}/blocks`, `${DECK}/games`],
      targetFolder: `${DECK}/blocks`,
    });
    // A subfolder that holds another item is left out the same way.
    const nested = layout(['blocks', 'inner'], {
      itemFolders: [DECK, `${DECK}/inner/deck`],
    });
    expect(choose(`${DECK}/blocks/a.html`, nested)).toEqual({
      folders: [`${DECK}/blocks`],
      targetFolder: `${DECK}/blocks`,
    });
  });

  it('caps the subfolders at ten, always keeping the target folder', () => {
    const names = Array.from({ length: 14 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    const many = layout(names);

    const inDeck = choose(`${DECK}/f13/x.html`, many);
    expect(inDeck.folders).toHaveLength(10);
    expect(inDeck.folders).toContain(`${DECK}/f13`);
    expect(inDeck.folders).toContain(`${DECK}/f08`);
    expect(inDeck.folders).not.toContain(`${DECK}/f09`);

    const outside = choose('games/a/x.html', many);
    expect(outside.folders).toHaveLength(11);
    expect(outside.folders).toContain('games/a');
  });

  it('drops other folders until the grant fits its length limit', () => {
    const long = (i: number) => `${String(i)}${'x'.repeat(300)}`;
    const big = layout(Array.from({ length: 10 }, (_, i) => long(i)));
    const folders = choose('games/a/x.html', big).folders ?? [];
    expect(folders).toContain('games/a');
    expect(folders.length).toBeGreaterThan(1);
    expect(folders.length).toBeLessThan(11);
    // The signer takes it.
    expect(() =>
      encodeFilesGrant(folders.map(path => ({ path, treeSha: sha('a') })))
    ).not.toThrow();
  });
});
