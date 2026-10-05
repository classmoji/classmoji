/**
 * The server side of the hidden-slide rule (#436): what a non-editor is sent.
 * The rule itself — which sections go — is pinned across all three tree shapes
 * in apps/slides/tests/unit/hidden-slides.spec.ts; this covers the document
 * handling around it.
 */

import { describe, expect, it } from 'vitest';
import { generateDeckHtml, parseDeckHtml, stripHiddenSlidesFromHtml } from '../deckHtml.ts';
import { mayHaveHiddenSlides, withoutHiddenSlides } from '../hiddenSlides.ts';
import { CANONICAL_FIXTURE, CRUFT_FIXTURE } from './fixtures.ts';

describe('stripHiddenSlidesFromHtml', () => {
  it('returns a deck with nothing hidden byte for byte', () => {
    expect(stripHiddenSlidesFromHtml(CANONICAL_FIXTURE)).toBe(CANONICAL_FIXTURE);
  });

  it('keeps the whole document around the slides', () => {
    const out = stripHiddenSlidesFromHtml(CRUFT_FIXTURE);

    expect(out).not.toContain('Hidden slide');
    expect(out).not.toContain('data-hidden');
    expect(out).toContain('Painted');
    expect(out).toContain('child two');
    // The head, the theme attributes and Reveal's init script all survive, so
    // the result still opens as a deck.
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<title>Cruft Deck</title>');
    expect(out).toContain('data-theme="white"');
    expect(out).toContain('Reveal.initialize');
    expect(parseDeckHtml(out).deck.slides.map(s => s.id)).toEqual(['cruft001', 'cruft003']);
  });

  it('works on a bare .slides fragment as well', () => {
    expect(
      stripHiddenSlidesFromHtml('<section>a</section><section data-hidden="true">b</section>')
    ).toBe('<section>a</section>');
  });

  it('agrees with the deck.json form on a generated deck', () => {
    const { deck } = parseDeckHtml(CRUFT_FIXTURE);
    const fromJson = generateDeckHtml(withoutHiddenSlides(deck), { title: 'Cruft Deck' });
    const fromHtml = stripHiddenSlidesFromHtml(generateDeckHtml(deck, { title: 'Cruft Deck' }));
    expect(parseDeckHtml(fromHtml).deck).toEqual(parseDeckHtml(fromJson).deck);
  });
});

describe('mayHaveHiddenSlides', () => {
  it('spots the attribute however it is quoted', () => {
    expect(mayHaveHiddenSlides('<section data-hidden="true">')).toBe(true);
    expect(mayHaveHiddenSlides("<section data-hidden='true'>")).toBe(true);
    expect(mayHaveHiddenSlides('<section data-hidden=true>')).toBe(true);
    expect(mayHaveHiddenSlides('<section data-hidden="false">')).toBe(false);
    expect(mayHaveHiddenSlides(CANONICAL_FIXTURE)).toBe(false);
  });
});
