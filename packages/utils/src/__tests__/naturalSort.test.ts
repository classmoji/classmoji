import { describe, it, expect } from 'vitest';
import { compareNatural, sortNaturallyBy } from '../naturalSort.ts';

const sorted = (names: string[]) => [...names].sort(compareNatural);

describe('compareNatural', () => {
  it('orders digit runs as numbers, not characters', () => {
    expect(sorted(['group-a10', 'group-a2', 'group-a1'])).toEqual([
      'group-a1',
      'group-a2',
      'group-a10',
    ]);
  });

  it('keeps mixed capitalisation in one run', () => {
    // A real roster: Group-A1 and group-a8 were typed by different people.
    expect(sorted(['group-a8', 'Group-A1', 'Group-b2', 'group-a2'])).toEqual([
      'Group-A1',
      'group-a2',
      'group-a8',
      'Group-b2',
    ]);
  });

  it('sorts missing names last rather than first', () => {
    expect(sorted(['b', '', 'a'])).toEqual(['a', 'b', '']);
    expect(compareNatural(null, 'a')).toBeGreaterThan(0);
    expect(compareNatural('a', undefined)).toBeLessThan(0);
    expect(compareNatural(null, undefined)).toBe(0);
  });
});

describe('sortNaturallyBy', () => {
  it('reads the key off each item', () => {
    const rows = [{ team: 'lab-10' }, { team: 'lab-2' }];
    expect(rows.sort(sortNaturallyBy(r => r.team)).map(r => r.team)).toEqual(['lab-2', 'lab-10']);
  });

  it('tolerates a missing key without throwing', () => {
    const rows = [{ team: null }, { team: 'a' }];
    expect(rows.sort(sortNaturallyBy(r => r.team)).map(r => r.team)).toEqual(['a', null]);
  });
});
