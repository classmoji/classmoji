import { test, expect } from '@playwright/test';

import {
  ADDRESS_PROBE_LIMIT,
  ADDRESS_PROBE_WINDOW_MS,
  SUBMISSION_RATE_LIMIT,
  SUBMISSION_RATE_WINDOW_MS,
  clientBucketFor,
  clientIpFor,
  mayLearnDeliveryOutcome,
  recordAddressProbe,
  recordSubmissionAttempt,
  resetSubmissionRateLimiter,
} from '../../app/utils/submissionRate.server.ts';

/**
 * The per-IP ceiling on anonymous form submissions, as pure functions.
 *
 * ── Why unit tests and not only HTTP ───────────────────────────────────────
 * The interesting cases are a full window, an EXPIRED window, and a client the
 * request cannot be attributed to. Reproducing the first over HTTP means twenty
 * real submissions; reproducing the second means waiting ten minutes; the third
 * cannot be produced from a browser at all. The e2e suite still asserts the
 * endpoint refuses (`forms-fill.spec.ts`), because "the counter says no" and
 * "the route says no" are different claims — this file is the one that can say
 * WHY.
 *
 * Runs in the Playwright runner with no browser and no dev stack, like
 * `forms-origin.spec.ts`.
 */

const request = (headers: Record<string, string>) =>
  new Request('https://pages.classmoji.io/cs52/forms/w', { method: 'POST', headers });

test.describe('clientIpFor', () => {
  test('prefers Fly-Client-IP, which the proxy writes and a client cannot', () => {
    expect(
      clientIpFor(
        request({ 'fly-client-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' })
      )
    ).toBe('203.0.113.9');
  });

  test('falls back to the LAST forwarded hop, never the first', () => {
    // A client can put anything at the head of X-Forwarded-For; the proxy
    // APPENDS the address it actually saw. Reading the first entry would let a
    // caller pick its own rate-limit bucket, which is the limiter switched off.
    expect(clientIpFor(request({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }))).toBe('203.0.113.9');
  });

  test('reports "unknown" rather than guessing when no proxy spoke', () => {
    expect(clientIpFor(request({}))).toBeNull();
  });
});

test.describe('recordSubmissionAttempt', () => {
  test.beforeEach(() => resetSubmissionRateLimiter());

  test('allows a client up to the ceiling and refuses the one after', () => {
    for (let n = 1; n <= SUBMISSION_RATE_LIMIT; n++) {
      expect(recordSubmissionAttempt('203.0.113.1', 'form-a').allowed, `attempt ${n}`).toBe(true);
    }

    const refused = recordSubmissionAttempt('203.0.113.1', 'form-a');
    expect(refused.allowed).toBe(false);
    // A Retry-After a caller can act on, not a bare refusal.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(SUBMISSION_RATE_WINDOW_MS / 1000);
  });

  test('budgets are per form, so one abused form cannot shut another', () => {
    for (let n = 0; n <= SUBMISSION_RATE_LIMIT; n++) {
      recordSubmissionAttempt('203.0.113.2', 'form-a');
    }
    expect(recordSubmissionAttempt('203.0.113.2', 'form-a').allowed).toBe(false);
    expect(recordSubmissionAttempt('203.0.113.2', 'form-b').allowed).toBe(true);
  });

  test('budgets are per client, so one abuser cannot shut the form for everyone', () => {
    // The whole reason this is not a global counter: a shared bucket would make
    // the anti-abuse measure into the denial of service it exists to prevent.
    for (let n = 0; n <= SUBMISSION_RATE_LIMIT; n++) {
      recordSubmissionAttempt('203.0.113.3', 'form-a');
    }
    expect(recordSubmissionAttempt('203.0.113.3', 'form-a').allowed).toBe(false);
    expect(recordSubmissionAttempt('203.0.113.4', 'form-a').allowed).toBe(true);
  });

  test('the window rolls over', () => {
    const start = 1_700_000_000_000;
    for (let n = 0; n <= SUBMISSION_RATE_LIMIT; n++) {
      recordSubmissionAttempt('203.0.113.5', 'form-a', start);
    }
    expect(recordSubmissionAttempt('203.0.113.5', 'form-a', start).allowed).toBe(false);

    const later = start + SUBMISSION_RATE_WINDOW_MS + 1;
    expect(recordSubmissionAttempt('203.0.113.5', 'form-a', later).allowed).toBe(true);
  });

  test('an unattributable request is not counted into a shared bucket', () => {
    // Null means no trusted proxy told us who this is. Counting it would put
    // every such request in ONE bucket — which is the global counter again.
    for (let n = 0; n < SUBMISSION_RATE_LIMIT * 3; n++) {
      expect(recordSubmissionAttempt(null, 'form-a').allowed).toBe(true);
    }
  });

  test('counts attempts, not successes', () => {
    // Nothing here reports an outcome — the count rises on the attempt alone,
    // so a caller cannot probe at full speed by making every probe fail.
    const before = recordSubmissionAttempt('203.0.113.6', 'form-a');
    expect(before.allowed).toBe(true);
    for (let n = 1; n < SUBMISSION_RATE_LIMIT; n++) {
      recordSubmissionAttempt('203.0.113.6', 'form-a');
    }
    expect(recordSubmissionAttempt('203.0.113.6', 'form-a').allowed).toBe(false);
  });
});

/**
 * The distinct-address ceiling — the bound on SELF-probing.
 *
 * Cookie-scoping the delivery endpoint stops a stranger asking about somebody
 * else's send. It does nothing about the person who types an address they are
 * curious about, lets us mail it, and reads their own bounce: they chose the
 * address and they own the cookie, so every other check passes. Counting
 * DISTINCT addresses is what closes the axis an enumeration sweep would use,
 * and these tests are the reason it must not be "simplified away" later.
 */
test.describe('the distinct-address ceiling', () => {
  test.beforeEach(() => resetSubmissionRateLimiter());

  test('lets an ordinary typo correction through', () => {
    // The real shape of this: got it wrong, fixed it. Nowhere near the ceiling.
    expect(recordAddressProbe('198.51.100.1', 'cs52/waitlist', 'me@dartmuoth.edu')).toBe(true);
    expect(recordAddressProbe('198.51.100.1', 'cs52/waitlist', 'me@dartmouth.edu')).toBe(true);
    expect(mayLearnDeliveryOutcome('198.51.100.1', 'cs52/waitlist')).toBe(true);
  });

  test('the SAME address is free however many times it is retyped', () => {
    // Tabbing through the field, or pressing resend, reveals nothing new — so
    // it must never consume budget a real correction would need.
    for (let i = 0; i < ADDRESS_PROBE_LIMIT * 5; i += 1) {
      expect(recordAddressProbe('198.51.100.2', 'cs52/waitlist', 'same@dartmouth.edu')).toBe(true);
    }
    expect(mayLearnDeliveryOutcome('198.51.100.2', 'cs52/waitlist')).toBe(true);
  });

  test('stops reporting outcomes once a client walks past the ceiling', () => {
    for (let i = 0; i < ADDRESS_PROBE_LIMIT; i += 1) {
      expect(recordAddressProbe('198.51.100.3', 'cs52/waitlist', `probe${i}@example.edu`)).toBe(
        true
      );
    }
    // One more DISTINCT address is one more than any real person needs.
    expect(recordAddressProbe('198.51.100.3', 'cs52/waitlist', 'probe-extra@example.edu')).toBe(
      false
    );
    expect(mayLearnDeliveryOutcome('198.51.100.3', 'cs52/waitlist')).toBe(false);
  });

  test('is per form, so one abused form does not silence another', () => {
    for (let i = 0; i < ADDRESS_PROBE_LIMIT + 1; i += 1) {
      recordAddressProbe('198.51.100.4', 'cs52/waitlist', `probe${i}@example.edu`);
    }
    expect(mayLearnDeliveryOutcome('198.51.100.4', 'cs52/waitlist')).toBe(false);
    expect(mayLearnDeliveryOutcome('198.51.100.4', 'cs52/other-form')).toBe(true);
  });

  test('is per client, so one sweeper does not silence everybody else', () => {
    for (let i = 0; i < ADDRESS_PROBE_LIMIT + 1; i += 1) {
      recordAddressProbe('198.51.100.5', 'cs52/waitlist', `probe${i}@example.edu`);
    }
    expect(mayLearnDeliveryOutcome('198.51.100.5', 'cs52/waitlist')).toBe(false);
    expect(mayLearnDeliveryOutcome('198.51.100.6', 'cs52/waitlist')).toBe(true);
  });

  test('forgets the window, so a long session is not permanently silenced', () => {
    const start = Date.now();
    for (let i = 0; i < ADDRESS_PROBE_LIMIT + 1; i += 1) {
      recordAddressProbe('198.51.100.7', 'cs52/waitlist', `probe${i}@example.edu`, start);
    }
    expect(mayLearnDeliveryOutcome('198.51.100.7', 'cs52/waitlist', start)).toBe(false);
    expect(
      mayLearnDeliveryOutcome('198.51.100.7', 'cs52/waitlist', start + ADDRESS_PROBE_WINDOW_MS + 1)
    ).toBe(true);
  });

  /**
   * A LECTURE HALL MUST NOT TRIP IT.
   *
   * These are students behind institutional NAT, and course-selection week puts
   * a whole lab on one exit address. Thirty people each correcting one typo is
   * sixty distinct... no: thirty people using one address each, plus a handful
   * of corrections. The ceiling has to sit comfortably above that, because the
   * busiest legitimate hour this form ever sees looks exactly like the thing
   * being defended against.
   */
  test('a lab full of students on one NAT address stays under it', () => {
    const nat = '198.51.100.50';
    // Thirty students, a third of whom mistype once and fix it.
    let addresses = 0;
    for (let student = 0; student < 30; student += 1) {
      if (student % 3 === 0) {
        recordAddressProbe(nat, 'cs52/waitlist', `student${student}@dartmuoth.edu`);
        addresses += 1;
      }
      recordAddressProbe(nat, 'cs52/waitlist', `student${student}@dartmouth.edu`);
      addresses += 1;
    }

    expect(addresses).toBeLessThan(ADDRESS_PROBE_LIMIT);
    expect(mayLearnDeliveryOutcome(nat, 'cs52/waitlist')).toBe(true);
  });

  /**
   * IPv6 IS BUCKETED BY /64, OR THE CEILING IS A DECORATION.
   *
   * One IPv6 allocation is billions of addresses and a host can take a fresh
   * one per connection. Counting per address would let a sweeper reset the
   * budget for free, so the /64 — roughly "one subscriber" — is what counts.
   */
  test('cannot be evaded by rotating within an IPv6 /64', () => {
    for (let i = 0; i <= ADDRESS_PROBE_LIMIT; i += 1) {
      // A different source address every time, all inside one /64.
      recordAddressProbe(
        `2001:db8:1234:5678::${(i + 1).toString(16)}`,
        'cs52/waitlist',
        `probe${i}@example.edu`
      );
    }

    // Asked from yet another address in the same /64: still refused.
    expect(mayLearnDeliveryOutcome('2001:db8:1234:5678::ffff', 'cs52/waitlist')).toBe(false);
    // A genuinely different subscriber prefix is untouched.
    expect(mayLearnDeliveryOutcome('2001:db8:1234:9999::1', 'cs52/waitlist')).toBe(true);
  });
});

test.describe('clientBucketFor', () => {
  test('keeps IPv4 exact — those are shared by NAT, not handed out in blocks', () => {
    expect(clientBucketFor('203.0.113.9')).toBe('203.0.113.9');
    expect(clientBucketFor('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  test('truncates IPv6 to its /64', () => {
    expect(clientBucketFor('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe(
      '2001:db8:1234:5678::/64'
    );
    // Two addresses in one allocation land in one bucket.
    expect(clientBucketFor('2001:db8:1234:5678::1')).toBe(clientBucketFor('2001:db8:1234:5678::2'));
    // Different allocations do not.
    expect(clientBucketFor('2001:db8:1234:5678::1')).not.toBe(
      clientBucketFor('2001:db8:1234:5679::1')
    );
  });

  test('survives the forms an address actually arrives in', () => {
    expect(clientBucketFor('[2001:db8:1234:5678::1]')).toBe('2001:db8:1234:5678::/64');
    expect(clientBucketFor('2001:db8:1234:5678::1%eth0')).toBe('2001:db8:1234:5678::/64');
    expect(clientBucketFor('::1')).toBe('0:0:0:0::/64');
  });

  test('does not count an unattributable client, which would be a shared bucket', () => {
    // Same reasoning as the request limiter: one shared bucket is an attacker
    // turning the warning off for everyone.
    for (let i = 0; i < ADDRESS_PROBE_LIMIT + 5; i += 1) {
      expect(recordAddressProbe(null, 'cs52/waitlist', `probe${i}@example.edu`)).toBe(true);
    }
    expect(mayLearnDeliveryOutcome(null, 'cs52/waitlist')).toBe(true);
  });
});
