import { describe, expect, it } from 'vitest';

import { TIER_POLICY, bucketExpiry, bucketOffset, fnv1a32 } from '../bucket.ts';
import { CLASSROOM_A, CLASSROOM_B, NOW } from './fixtures.ts';

const DAY = 86400;
const HOUR = 3600;

describe('fnv1a32', () => {
  it('is a stable unsigned 32-bit hash', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    expect(fnv1a32(CLASSROOM_A)).toBeGreaterThanOrEqual(0);
    expect(fnv1a32(CLASSROOM_A)).toBeLessThan(2 ** 32);
  });
});

describe('bucketExpiry', () => {
  it('gives draft an exact now + 4h', () => {
    expect(bucketExpiry('draft', CLASSROOM_A, NOW)).toBe(NOW + 4 * HOUR);
    expect(bucketExpiry('draft', CLASSROOM_B, NOW)).toBe(NOW + 4 * HOUR);
    expect(bucketExpiry('draft', CLASSROOM_A, NOW + 1)).toBe(NOW + 1 + 4 * HOUR);
  });

  it('rounds bucketed tiers up to the end of the current bucket', () => {
    for (const tier of ['public', 'enrolled'] as const) {
      const length = TIER_POLICY[tier].bucketSeconds as number;
      const exp = bucketExpiry(tier, CLASSROOM_A, NOW);
      expect(exp).toBeGreaterThan(NOW);
      expect(exp - NOW).toBeLessThanOrEqual(length);
      // The boundary sits on this classroom's stagger offset.
      expect(exp % length).toBe(bucketOffset(CLASSROOM_A, length) % length);
    }
  });

  it('uses 30-day buckets for public and 7-day for enrolled', () => {
    expect(TIER_POLICY.public.bucketSeconds).toBe(30 * DAY);
    expect(TIER_POLICY.enrolled.bucketSeconds).toBe(7 * DAY);
  });

  it('is stable for every instant inside one bucket', () => {
    const exp = bucketExpiry('enrolled', CLASSROOM_A, NOW);
    expect(bucketExpiry('enrolled', CLASSROOM_A, NOW + 60)).toBe(exp);
    expect(bucketExpiry('enrolled', CLASSROOM_A, exp - 1)).toBe(exp);
    // Crossing the boundary moves to the next bucket, exactly one length on.
    expect(bucketExpiry('enrolled', CLASSROOM_A, exp)).toBe(exp + 7 * DAY);
  });

  it('staggers boundaries across classrooms so the fleet does not cold-fill at once', () => {
    for (const tier of ['public', 'enrolled'] as const) {
      const a = bucketExpiry(tier, CLASSROOM_A, NOW);
      const b = bucketExpiry(tier, CLASSROOM_B, NOW);
      expect(a).not.toBe(b);
      const length = TIER_POLICY[tier].bucketSeconds as number;
      expect(bucketOffset(CLASSROOM_A, length)).not.toBe(bucketOffset(CLASSROOM_B, length));
    }
  });

  it('handles a now that lands before the classroom offset', () => {
    const length = TIER_POLICY.public.bucketSeconds as number;
    const offset = bucketOffset(CLASSROOM_A, length);
    const exp = bucketExpiry('public', CLASSROOM_A, offset - 1);
    expect(exp).toBe(offset);
    expect(exp).toBeGreaterThan(offset - 1);
  });

  it('rejects a bad tier or classroomId', () => {
    // @ts-expect-error - exercising the runtime guard
    expect(() => bucketExpiry('secret', CLASSROOM_A, NOW)).toThrow(TypeError);
    expect(() => bucketExpiry('public', 'not-a-uuid', NOW)).toThrow(TypeError);
  });
});
