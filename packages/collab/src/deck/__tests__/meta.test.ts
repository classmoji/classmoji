import { describe, expect, it } from 'vitest';

// Relative: the lint resolver does not follow package subpath exports.
import { slideService, type DeckJson } from '../../../../services/src/slides/index.ts';
import { deckToYDoc, yDocToDeck } from '../convert.ts';
import { DECK_STARTER_CUSTOM_CSS, readDeckThemes, setDeckThemes } from '../meta.ts';

describe('deck themes', () => {
  it('the starter css copy matches the server constant', () => {
    expect(DECK_STARTER_CUSTOM_CSS).toBe(slideService.STARTER_CUSTOM_CSS);
  });

  it('applies buildEditorDeck merge rules', () => {
    const deck: DeckJson = {
      version: 1,
      theme: 'white',
      codeTheme: 'github',
      themeDark: 'black',
      codeThemeDark: 'github-dark',
      customCss: DECK_STARTER_CUSTOM_CSS,
      slides: [{ id: 'a', html: 'x' }],
    };
    const doc = deckToYDoc(deck);
    expect(setDeckThemes(doc, { theme: 'white', codeTheme: 'github' })).toBe(false);
    setDeckThemes(doc, { theme: 'moon' });
    const expected = slideService.buildEditorDeck({
      theme: 'moon',
      codeTheme: 'github',
      slides: deck.slides,
      currentDeck: deck,
    });
    const back = yDocToDeck(doc);
    expect(back.themeDark).toBe(expected.themeDark);
    expect(back.customCss).toBe(expected.customCss);
    expect(back.codeThemeDark).toBe('github-dark');
    setDeckThemes(doc, { codeTheme: 'monokai' });
    expect(yDocToDeck(doc).codeThemeDark).toBeUndefined();
    expect(readDeckThemes(doc)).toEqual({ theme: 'moon', codeTheme: 'monokai' });
  });
});
