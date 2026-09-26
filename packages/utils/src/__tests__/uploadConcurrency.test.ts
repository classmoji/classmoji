/**
 * Unit tests for the per-process upload slot limiter.
 *
 * The size cap in `../uploadLimit` bounds ONE upload; this is the other half
 * of the same problem — ten of them arriving together. See the module
 * comment in `../uploadConcurrency.ts` for why this lives in one shared
 * place instead of a copy per app.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_CONCURRENT_UPLOADS,
  acquireUploadSlot,
  releaseUploadSlot,
  uploadsInFlight,
} from '../uploadConcurrency.ts';

describe('the concurrency limit', () => {
  it('hands out a fixed number of slots and then says no', () => {
    const taken: boolean[] = [];
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) taken.push(acquireUploadSlot());
    expect(taken.every(Boolean)).toBe(true);
    expect(uploadsInFlight()).toBe(MAX_CONCURRENT_UPLOADS);

    // The one over the line is refused rather than queued: a queued upload
    // holds its socket open for as long as the ones ahead of it take, which is
    // the same resource problem one step later.
    expect(acquireUploadSlot()).toBe(false);

    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) releaseUploadSlot();
    expect(uploadsInFlight()).toBe(0);
  });

  it('a release frees exactly one slot', () => {
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) acquireUploadSlot();
    expect(acquireUploadSlot()).toBe(false);

    releaseUploadSlot();
    expect(acquireUploadSlot()).toBe(true);

    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i += 1) releaseUploadSlot();
  });

  it('never counts below zero, whatever a caller does', () => {
    // A `finally` that runs twice, or one that runs after an acquire returned
    // false, must not leave the process with more slots than it has.
    releaseUploadSlot();
    releaseUploadSlot();
    expect(uploadsInFlight()).toBe(0);
  });
});
