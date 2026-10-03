import { describe, expect, it } from 'vitest';
import { effectiveTokensPerHour } from '../extensionPrice.ts';

describe('effectiveTokensPerHour', () => {
  it("uses the classroom's price when the assignment sets none", () => {
    expect(effectiveTokensPerHour(null, 2)).toBe(2);
    expect(effectiveTokensPerHour(undefined, 2)).toBe(2);
  });

  it("uses the assignment's own price over the classroom's", () => {
    expect(effectiveTokensPerHour(5, 2)).toBe(5);
  });

  it("keeps an assignment's 0: extensions deliberately off", () => {
    expect(effectiveTokensPerHour(0, 2)).toBe(0);
  });

  it('is 0 when neither sets a price', () => {
    expect(effectiveTokensPerHour(null, null)).toBe(0);
    expect(effectiveTokensPerHour(null, undefined)).toBe(0);
  });
});
