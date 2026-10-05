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
import {
  mayHaveHiddenSlides,
  remapRevealHash,
  toFullIndices,
  toVisibleIndices,
  withoutHiddenSlides,
  type SlideIndices,
  type SlideSlot,
} from '../hiddenSlides.ts';
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

describe('slide positions across the hidden-slide rule', () => {
  // 0: A   1: [B hidden]   2: stack [C1, C2 hidden, C3]   3: stack [D1 hidden] + own content   4: E
  const layout: SlideSlot[] = [
    { keep: true, children: [] },
    { keep: false, children: [] },
    { keep: true, children: [true, false, true] },
    { keep: true, children: [false] },
    { keep: true, children: [] },
  ];

  it('maps every visible editor slide to the viewer and back', () => {
    const pairs: Array<[SlideIndices, SlideIndices]> = [
      [
        { h: 0, v: 0 },
        { h: 0, v: 0 },
      ],
      [
        { h: 2, v: 0 },
        { h: 1, v: 0 },
      ],
      [
        { h: 2, v: 2 },
        { h: 1, v: 1 },
      ],
      [
        { h: 4, v: 0 },
        { h: 3, v: 0 },
      ],
    ];
    for (const [full, visible] of pairs) {
      expect(toVisibleIndices(layout, full)).toEqual(visible);
      expect(toFullIndices(layout, visible)).toEqual(full);
    }
  });

  it('lands a hidden slide on the next visible one, else the previous', () => {
    expect(toVisibleIndices(layout, { h: 1, v: 0 })).toEqual({ h: 1, v: 0 });
    expect(toVisibleIndices(layout, { h: 2, v: 1 })).toEqual({ h: 1, v: 1 });
    const tail: SlideSlot[] = [
      { keep: true, children: [] },
      { keep: false, children: [] },
    ];
    expect(toVisibleIndices(tail, { h: 1, v: 0 })).toEqual({ h: 0, v: 0 });
    expect(toVisibleIndices([{ keep: false, children: [] }], { h: 0, v: 0 })).toEqual({
      h: 0,
      v: 0,
    });
  });

  it('a kept stack whose children all went is one flat slide', () => {
    expect(toVisibleIndices(layout, { h: 3, v: 0 })).toEqual({ h: 2, v: 0 });
    expect(toFullIndices(layout, { h: 2, v: 0 })).toEqual({ h: 3, v: 0 });
  });

  it('clamps a position past the end', () => {
    expect(toVisibleIndices(layout, { h: 9, v: 0 })).toEqual({ h: 3, v: 0 });
    expect(toFullIndices(layout, { h: 1, v: 7 })).toEqual({ h: 2, v: 2 });
  });

  it('rewrites a numeric hash, keeping a fragment only on the same slide', () => {
    expect(remapRevealHash('#/2/2', layout, 'visible')).toBe('#/1/1');
    expect(remapRevealHash('#/2/2/3', layout, 'visible')).toBe('#/1/1/3');
    expect(remapRevealHash('#/2/1/3', layout, 'visible')).toBe('#/1/1');
    expect(remapRevealHash('#/1/1', layout, 'full')).toBe('#/2/2');
    expect(remapRevealHash('#/0', layout, 'full')).toBeNull();
    expect(remapRevealHash('', layout, 'visible')).toBeNull();
    expect(remapRevealHash('#/', layout, 'visible')).toBeNull();
  });

  it('rewrites a named hash only when its slide is hidden', () => {
    const ids: Record<string, SlideIndices> = { intro: { h: 0, v: 0 }, retired: { h: 1, v: 0 } };
    const find = (id: string) => ids[id] ?? null;
    expect(remapRevealHash('#/intro', layout, 'visible', find)).toBeNull();
    expect(remapRevealHash('#/retired', layout, 'visible', find)).toBe('#/1');
    expect(remapRevealHash('#/retired', layout, 'full', find)).toBeNull();
    expect(remapRevealHash('#/unknown', layout, 'visible', find)).toBeNull();
  });
});
