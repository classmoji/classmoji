import { describe, expect, it } from 'vitest';

import { itemHash, stableJson } from '../hash.ts';

describe('itemHash', () => {
  it('ignores key order and undefined members', () => {
    expect(itemHash({ a: 1, b: { y: 2, x: [1, { q: 1, p: 2 }] } })).toBe(
      itemHash({ b: { x: [1, { p: 2, q: 1 }], y: 2 }, a: 1, c: undefined })
    );
  });

  it('changes with any value', () => {
    expect(itemHash({ a: 1 })).not.toBe(itemHash({ a: 2 }));
    expect(itemHash([1, 2])).not.toBe(itemHash([2, 1]));
  });

  it('is sha1 hex of the stable JSON', () => {
    expect(stableJson({ b: 1, a: [undefined, 'x'] })).toBe('{"a":[null,"x"],"b":1}');
    expect(itemHash({})).toMatch(/^[0-9a-f]{40}$/);
  });
});
