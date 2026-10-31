/**
 * The comment-anchor helpers in `@classmoji/page-schema/sections`: block
 * order, the locked section enclosing a block, a block's quotable text and
 * quote matching. The server validates a new quote and the browser finds it
 * again for the highlight with these same functions.
 */
import { describe, expect, it } from 'vitest';

import {
  blockIdsInOrder,
  blockText,
  countQuoteOccurrences,
  enclosingLockedSectionId,
  normalizeQuoteText,
  quoteOccurrenceIndex,
  redactLockedSections,
} from '../sections.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const p = (id: string, children: unknown[] = [], value = id) => ({
  id,
  type: 'paragraph',
  props: {},
  content: text(value),
  children,
});
const locked = (id: string, title: string, children: unknown[]) => ({
  id,
  type: 'lockedSection',
  props: { title },
  children,
});

const doc = [
  p('intro'),
  locked('L1', 'Solution', [
    p('L1-body', [p('L1-nested')]),
    locked('L1-inner', 'Hint', [p('L1-inner-body')]),
  ]),
  {
    id: 'cols',
    type: 'columnList',
    children: [{ id: 'col', type: 'column', children: [locked('L2', 'Answer', [p('L2-body')])] }],
  },
  p('outro'),
];

describe('blockIdsInOrder', () => {
  it('lists every id depth-first, parents before children', () => {
    expect(blockIdsInOrder(doc)).toEqual([
      'intro',
      'L1',
      'L1-body',
      'L1-nested',
      'L1-inner',
      'L1-inner-body',
      'cols',
      'col',
      'L2',
      'L2-body',
      'outro',
    ]);
  });

  it('follows the redacted tree: a locked body is not listed', () => {
    const redacted = redactLockedSections(doc, () => false);
    expect(blockIdsInOrder(redacted)).toEqual(['intro', 'L1', 'cols', 'col', 'L2', 'outro']);
  });

  it('tolerates junk', () => {
    expect(blockIdsInOrder(null)).toEqual([]);
    expect(blockIdsInOrder([null, 3, { id: 5 }, { id: 'ok' }])).toEqual(['ok']);
  });
});

describe('enclosingLockedSectionId', () => {
  it('answers the nearest enclosing locked section at any depth', () => {
    expect(enclosingLockedSectionId(doc, 'L1-body')).toBe('L1');
    expect(enclosingLockedSectionId(doc, 'L1-nested')).toBe('L1');
    expect(enclosingLockedSectionId(doc, 'L1-inner-body')).toBe('L1-inner');
    expect(enclosingLockedSectionId(doc, 'L2-body')).toBe('L2');
  });

  it('a locked section is not inside itself (its title is public); a nested one answers the outer', () => {
    expect(enclosingLockedSectionId(doc, 'L1')).toBeNull();
    expect(enclosingLockedSectionId(doc, 'L2')).toBeNull();
    expect(enclosingLockedSectionId(doc, 'L1-inner')).toBe('L1');
  });

  it('null for public blocks, missing blocks and junk', () => {
    expect(enclosingLockedSectionId(doc, 'intro')).toBeNull();
    expect(enclosingLockedSectionId(doc, 'col')).toBeNull();
    expect(enclosingLockedSectionId(doc, 'gone')).toBeNull();
    expect(enclosingLockedSectionId(doc, '')).toBeNull();
    expect(enclosingLockedSectionId('nope', 'intro')).toBeNull();
  });
});

describe('blockText', () => {
  it('reads inline text and link runs, not children', () => {
    const block = {
      id: 'b',
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ', styles: {} },
        {
          type: 'link',
          href: 'https://x',
          content: [{ type: 'text', text: 'the docs', styles: {} }],
        },
        { type: 'text', text: ' now.', styles: { bold: true } },
      ],
      children: [p('child')],
    };
    expect(blockText(block)).toBe('See the docs now.');
  });

  it("a locked section's text is its title; a table's is its cells", () => {
    expect(blockText(locked('L', 'Solution part 1', [p('secret')]))).toBe('Solution part 1');
    const table = {
      id: 't',
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [
          { cells: [text('a1'), { type: 'tableCell', content: text('b1') }] },
          { cells: [text('a2'), text('b2')] },
        ],
      },
    };
    expect(blockText(table)).toBe('a1 b1 a2 b2');
  });

  it("'' for junk", () => {
    expect(blockText(null)).toBe('');
    expect(blockText({ id: 'x', type: 'image' })).toBe('');
  });
});

describe('quote matching', () => {
  it('normalizes every whitespace run to one space', () => {
    expect(normalizeQuoteText('a \n\t b c')).toBe('a b c');
  });

  it('finds the n-th match, overlapping, on normalized text', () => {
    expect(quoteOccurrenceIndex('the cat and the hat', 'the', 0)).toBe(0);
    expect(quoteOccurrenceIndex('the cat and the hat', 'the', 1)).toBe(12);
    expect(quoteOccurrenceIndex('the cat and the hat', 'the', 2)).toBe(-1);
    expect(quoteOccurrenceIndex('aaa', 'aa', 1)).toBe(1);
    expect(countQuoteOccurrences('aaa', 'aa')).toBe(2);
    expect(quoteOccurrenceIndex('line one\n  line two', 'one line', 0)).toBe(5);
  });

  it('refuses an empty quote and a bad occurrence', () => {
    expect(quoteOccurrenceIndex('abc', '', 0)).toBe(-1);
    expect(quoteOccurrenceIndex('abc', 'a', -1)).toBe(-1);
    expect(quoteOccurrenceIndex('abc', 'a', 0.5)).toBe(-1);
    expect(countQuoteOccurrences('abc', '')).toBe(0);
  });
});
