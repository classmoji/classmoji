/**
 * The quota numbers.
 *
 * Pinned rather than asserted-by-arithmetic: these are what a Pro subscription
 * includes, so a change to one should show up in a diff as a change to a
 * product decision, not slip through because the test recomputed it the same
 * wrong way.
 */

import { describe, expect, it } from 'vitest';

import {
  FREE_QUOTA_BYTES,
  MAX_PARTS_PER_SIGN,
  PART_SIZE_BYTES,
  PER_FILE_MAX_BYTES,
  PRO_QUOTA_BYTES,
  RESERVATION_WINDOW_MS,
  partCountFor,
  quotaBytesFor,
} from '../mediaQuota.ts';

const GIB = 1024 * 1024 * 1024;

describe('the numbers', () => {
  it('is 0 free, 10 GiB Pro, 2 GiB per file', () => {
    expect(FREE_QUOTA_BYTES).toBe(0);
    expect(PRO_QUOTA_BYTES).toBe(10 * GIB);
    expect(PER_FILE_MAX_BYTES).toBe(2 * GIB);
  });

  it('reserves an unfinished upload for 24 hours', () => {
    expect(RESERVATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('uses a 32 MiB part, inside R2 5 MiB–5 GiB range', () => {
    expect(PART_SIZE_BYTES).toBe(32 * 1024 * 1024);
    expect(PART_SIZE_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(PART_SIZE_BYTES).toBeLessThanOrEqual(5 * GIB);
  });
});

describe('quotaBytesFor', () => {
  it('gives a free classroom nothing at all', () => {
    expect(quotaBytesFor(false)).toBe(0);
    expect(quotaBytesFor(true)).toBe(PRO_QUOTA_BYTES);
  });
});

describe('partCountFor', () => {
  it('rounds up, and never returns zero', () => {
    expect(partCountFor(1)).toBe(1);
    expect(partCountFor(PART_SIZE_BYTES)).toBe(1);
    expect(partCountFor(PART_SIZE_BYTES + 1)).toBe(2);
    expect(partCountFor(0)).toBe(1);
  });

  it('keeps the largest allowed file inside one signing batch per few rounds', () => {
    // 2 GiB in 32 MiB parts is 64 — small enough that a whole upload is a
    // handful of `signParts` calls rather than hundreds, and well under S3's
    // 10,000-part ceiling.
    expect(partCountFor(PER_FILE_MAX_BYTES)).toBe(64);
    expect(partCountFor(PER_FILE_MAX_BYTES)).toBeLessThan(10000);
    expect(partCountFor(PER_FILE_MAX_BYTES) / MAX_PARTS_PER_SIGN).toBeLessThan(3);
  });
});
