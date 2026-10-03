import { describe, expect, it } from 'vitest';
import { withHiddenRows } from '../hiddenRows.ts';

// `a b q*` is three rows in their current order; a trailing * marks one the
// caller was never shown.
const rows = (spec: string) =>
  spec.split(' ').map(s => ({ id: s.replace('*', ''), hidden: s.endsWith('*') }));

describe('withHiddenRows', () => {
  it('returns the order unchanged when nothing is hidden', () => {
    expect(withHiddenRows(rows('a b c'), ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('keeps each hidden row after the row it follows, and a leading one at the front', () => {
    expect(withHiddenRows(rows('q1* a b q2*'), ['b', 'a'])).toEqual(['q1', 'b', 'q2', 'a']);
  });

  it('does not drift when a row is inserted above a trailing hidden row', () => {
    // By index, q would land at 2 and split a from b.
    expect(withHiddenRows(rows('a b q*'), ['m', 'a', 'b'])).toEqual(['m', 'a', 'b', 'q']);
  });

  it('keeps hidden rows that share an anchor in their current order', () => {
    expect(withHiddenRows(rows('a q1* q2* b'), ['b', 'a'])).toEqual(['b', 'a', 'q1', 'q2']);
  });

  it('does not add back a visible row the caller left out', () => {
    // b is missing from the list; the services refuse it, as they would anyway.
    expect(withHiddenRows(rows('a b q* c'), ['c', 'a'])).toEqual(['c', 'a', 'q']);
  });

  it('leaves a hidden row the caller did name where the caller put it', () => {
    expect(withHiddenRows(rows('a q* b'), ['q', 'b', 'a'])).toEqual(['q', 'b', 'a']);
  });

  it('returns only the hidden rows for an empty ordering', () => {
    expect(withHiddenRows(rows('q1* q2*'), [])).toEqual(['q1', 'q2']);
  });
});
