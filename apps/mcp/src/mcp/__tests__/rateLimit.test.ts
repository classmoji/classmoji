/**
 * Unit tests for the per-user, per-tool token-bucket rate limiter (S6).
 * Time is controlled with fake timers (tryConsume reads Date.now()).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RATE_LIMIT, resetRateLimits, tryConsume } from '../rateLimit.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  resetRateLimits();
});

describe('tryConsume', () => {
  it('allows a burst up to capacity, then rejects', () => {
    const config = { capacity: 3, refillPerSecond: 1 };
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(true);
    // Bucket empty — no time has passed, so no refill.
    expect(tryConsume('u1:tool', config)).toBe(false);
  });

  it('refills at refillPerSecond over elapsed time', () => {
    const config = { capacity: 2, refillPerSecond: 1 };
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(false);

    // After 1 second exactly one token has refilled: one call passes, next fails.
    vi.advanceTimersByTime(1_000);
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(false);
  });

  it('refills fractionally — a token becomes available only once a WHOLE token accrues', () => {
    const config = { capacity: 1, refillPerSecond: 0.5 };
    expect(tryConsume('u1:tool', config)).toBe(true);

    // 0.5 tokens after 1s — still not enough.
    vi.advanceTimersByTime(1_000);
    expect(tryConsume('u1:tool', config)).toBe(false);

    // The failed attempt above still refreshed the refill timestamp; another
    // second brings the bucket to a full token.
    vi.advanceTimersByTime(1_000);
    expect(tryConsume('u1:tool', config)).toBe(true);
  });

  it('never refills beyond capacity', () => {
    const config = { capacity: 2, refillPerSecond: 10 };
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(true);

    // Long idle: refill is clamped at capacity (2), not 10*60.
    vi.advanceTimersByTime(60_000);
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(false);
  });

  it('isolates buckets per userId:toolName key', () => {
    const config = { capacity: 1, refillPerSecond: 0 };

    // Exhausting u1's bucket for tool A affects neither u2:A nor u1:B.
    expect(tryConsume('u1:tool_a', config)).toBe(true);
    expect(tryConsume('u1:tool_a', config)).toBe(false);

    expect(tryConsume('u2:tool_a', config)).toBe(true);
    expect(tryConsume('u1:tool_b', config)).toBe(true);
  });

  it('uses DEFAULT_RATE_LIMIT when no config is given', () => {
    for (let i = 0; i < DEFAULT_RATE_LIMIT.capacity; i++) {
      expect(tryConsume('u1:tool')).toBe(true);
    }
    expect(tryConsume('u1:tool')).toBe(false);
  });
});

describe('resetRateLimits', () => {
  it('clears all buckets (test isolation helper)', () => {
    const config = { capacity: 1, refillPerSecond: 0 };
    expect(tryConsume('u1:tool', config)).toBe(true);
    expect(tryConsume('u1:tool', config)).toBe(false);

    resetRateLimits();
    expect(tryConsume('u1:tool', config)).toBe(true);
  });
});
