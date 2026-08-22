import { describe, it, expect } from 'vitest';

import {
  buildAvailabilityResponse,
  SUBDOMAIN_STATUS_MESSAGE,
  type ServiceAvailability,
} from '../availability.ts';

/**
 * The wire contract for /api/site/availability. The route is auth plus one
 * service call, so this is where the response shape is pinned — in particular
 * the two answers the service itself never returns: nothing typed, and a
 * rejection reason this build does not recognize. Both must land on
 * `subdomain_available: false`, because that boolean gates the Claim button.
 */

describe('buildAvailabilityResponse', () => {
  it('reports a free label as available', () => {
    const availability: ServiceAvailability = { available: true, normalized: 'cs52' };
    expect(buildAvailabilityResponse(availability)).toEqual({
      subdomain_available: true,
      normalized: 'cs52',
      status: 'available',
      message: 'Available',
    });
  });

  it.each([
    ['SUBDOMAIN_INVALID', 'invalid', 'Invalid'],
    ['SUBDOMAIN_RESERVED', 'reserved', 'Reserved'],
    ['SUBDOMAIN_TAKEN', 'taken', 'Taken'],
  ])('distinguishes %s as its own status', (reason, status, message) => {
    expect(buildAvailabilityResponse({ available: false, normalized: 'app', reason })).toEqual({
      subdomain_available: false,
      normalized: 'app',
      status,
      message,
    });
  });

  it('reports nothing-typed as empty, not as available', () => {
    // Divergence from the classroom-slug route on purpose: an empty label is
    // not claimable, so it must not leave the Claim button enabled.
    expect(buildAvailabilityResponse(null)).toEqual({
      subdomain_available: false,
      normalized: '',
      status: 'empty',
      message: '',
    });
  });

  it('degrades an unrecognized rejection to invalid rather than available', () => {
    const answer = buildAvailabilityResponse({
      available: false,
      normalized: 'cs52',
      reason: 'SOMETHING_ADDED_LATER',
    });
    expect(answer.subdomain_available).toBe(false);
    expect(answer.status).toBe('invalid');
  });

  it('carries the normalized label back, so the caller can match a stale answer', () => {
    // The client debounces; without `normalized` it cannot tell whether the
    // answer in hand is about the text currently in the box.
    expect(buildAvailabilityResponse({ available: true, normalized: 'cs52' }).normalized).toBe(
      'cs52'
    );
  });

  it('has a message for every status', () => {
    const statuses = ['empty', 'available', 'invalid', 'reserved', 'taken'] as const;
    for (const status of statuses) {
      expect(SUBDOMAIN_STATUS_MESSAGE[status]).toBeTypeOf('string');
    }
  });
});
