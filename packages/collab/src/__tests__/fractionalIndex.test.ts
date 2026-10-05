import { describe, expect, it } from 'vitest';
import { compareKeys, initialKeys, keyBetween, keysBetween } from '../fractionalIndex.ts';
import { userColor } from '../color.ts';

describe('fractional indexes', () => {
  it('orders between neighbours and at both ends', () => {
    const [a, b] = initialKeys(2);
    const mid = keyBetween(a, b);
    const first = keyBetween(null, a);
    const last = keyBetween(b, null);
    const sorted = [last, mid, b, first, a].sort(compareKeys);
    expect(sorted).toEqual([first, a, mid, b, last]);
  });

  it('makes n ascending keys in a gap', () => {
    const [a, b] = initialKeys(2);
    const keys = keysBetween(a, b, 5);
    expect(keys).toHaveLength(5);
    expect([...keys].sort(compareKeys)).toEqual(keys);
    expect(compareKeys(a, keys[0])).toBe(-1);
    expect(compareKeys(keys[4], b)).toBe(-1);
  });
});

describe('userColor', () => {
  it('is stable per user', () => {
    expect(userColor('u1')).toBe(userColor('u1'));
    expect(userColor('u1')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
