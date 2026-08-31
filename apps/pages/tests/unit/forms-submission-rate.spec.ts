import { test, expect } from '@playwright/test';

import {
  SUBMISSION_RATE_LIMIT,
  SUBMISSION_RATE_WINDOW_MS,
  clientIpFor,
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
