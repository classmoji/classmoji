/**
 * The server side of the hidden-slide rule (#436): what a non-editor is sent.
 * The rule itself — which sections go — is pinned across all three tree shapes
 * in apps/slides/tests/unit/hidden-slides.spec.ts; this covers the document
 * handling around it.
 */

import { describe, expect, it } from 'vitest';
import {
  deckHtmlForViewer,
  generateDeckHtml,
  mayHaveSpeakerNotes,
  parseDeckHtml,
  stripHiddenSlidesFromHtml,
} from '../deckHtml.ts';
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

describe('deckHtmlForViewer', () => {
  const deck = [
    '<section data-cm-id="a"><h1>A</h1><aside class="notes">say A</aside></section>',
    '<section data-cm-id="b" data-hidden="true"><h1>B</h1><aside class="notes">say B</aside></section>',
    '<section data-cm-id="c"><h1>C</h1><aside data-x="1" class="speaker notes">say C</aside></section>',
  ].join('');

  it('gives an editor (always allowed notes) the deck byte for byte', () => {
    expect(deckHtmlForViewer(deck, { canEdit: true, canViewSpeakerNotes: true })).toBe(deck);
  });

  it('strips notes, in any attribute order or class list, for a caller not allowed them', () => {
    const out = deckHtmlForViewer(deck, { canEdit: false, canViewSpeakerNotes: false });
    expect(out).not.toContain('say A');
    expect(out).not.toContain('say C');
    expect(out).not.toContain('<h1>B</h1>');
    expect(out).toContain('<h1>A</h1>');
    expect(out).toContain('<h1>C</h1>');
  });

  it('keeps notes for a viewer the deck shows them to, still without hidden slides', () => {
    const out = deckHtmlForViewer(deck, { canEdit: false, canViewSpeakerNotes: true });
    expect(out).toContain('say A');
    expect(out).not.toContain('say B');
  });

  it('keeps a whole document whole', () => {
    const doc = generateDeckHtml(parseDeckHtml(CRUFT_FIXTURE).deck, {
      title: 'Cruft Deck',
      includeNotes: true,
    });
    const out = deckHtmlForViewer(doc, { canEdit: false, canViewSpeakerNotes: false });
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).not.toMatch(/<aside[^>]*class="notes"/);
    expect(out).toContain('Reveal.initialize');
  });

  it('leaves a non-notes aside alone', () => {
    const html = '<section><aside class="callout">keep</aside></section>';
    expect(deckHtmlForViewer(html, { canEdit: false, canViewSpeakerNotes: false })).toBe(html);
  });

  it('judges hidden stacks before the notes go, so slide positions match the presenter', () => {
    // A stack whose children are all hidden but whose own content is notes:
    // the presenter (who sees notes) keeps it as a slide, so a follower must too.
    const html =
      '<section><section data-hidden="true">x</section><aside class="notes">n</aside></section><section>y</section>';
    const out = deckHtmlForViewer(html, { canEdit: false, canViewSpeakerNotes: false });
    expect(out).toBe('<section></section><section>y</section>');
  });
});

describe('mayHaveSpeakerNotes', () => {
  it('is a cheap superset check', () => {
    expect(mayHaveSpeakerNotes('<ASIDE class="notes">')).toBe(true);
    expect(mayHaveSpeakerNotes('<section>no notes</section>')).toBe(false);
  });
});
