/**
 * Unit tests for the pending-submission helpers behind the upload indicator.
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — both
 * functions under test are pure, take plain values and touch nothing else.
 *
 * The two contracts that matter:
 *
 *   1. The pending flag covers the WHOLE round trip. `submitting` is the bytes
 *      going up; the `loading` tail after the action answers is the redirect or
 *      the revalidation, and the form is still not usable then. It must go
 *      false again the moment the navigation settles, or an error leaves the
 *      screen stuck behind a spinner that will never stop.
 *   2. A file's size is quoted in the same units as the limit it is measured
 *      against. Showing "78.6 MB" beside a 75 MB cap the file actually fits
 *      under is a bug report waiting to happen.
 */

import { test, expect } from '@playwright/test';

import { formatBytes, isSubmissionPending } from '../../app/utils/pendingSubmission.ts';

test.describe('isSubmissionPending', () => {
  test('idle is never pending', () => {
    expect(isSubmissionPending({ state: 'idle' })).toBe(false);
    // An idle navigation carries no method, but a stale one must not resurrect it.
    expect(isSubmissionPending({ state: 'idle', formMethod: 'POST' })).toBe(false);
  });

  test('submitting is pending — this is the upload itself', () => {
    expect(isSubmissionPending({ state: 'submitting', formMethod: 'POST' })).toBe(true);
    // Even with no method reported: the state alone settles it.
    expect(isSubmissionPending({ state: 'submitting' })).toBe(true);
  });

  test('the loading tail of a POST is still pending', () => {
    // The action has answered and React Router is following the redirect or
    // revalidating. The form must stay frozen through it.
    expect(isSubmissionPending({ state: 'loading', formMethod: 'POST' })).toBe(true);
    expect(isSubmissionPending({ state: 'loading', formMethod: 'post' })).toBe(true);
    expect(isSubmissionPending({ state: 'loading', formMethod: 'PUT' })).toBe(true);
  });

  test('a plain page navigation is not our submission', () => {
    // A GET happening alongside — a link, a search — must not freeze the form.
    expect(isSubmissionPending({ state: 'loading' })).toBe(false);
    expect(isSubmissionPending({ state: 'loading', formMethod: 'GET' })).toBe(false);
    expect(isSubmissionPending({ state: 'loading', formMethod: 'get' })).toBe(false);
    expect(isSubmissionPending({ state: 'loading', formMethod: null })).toBe(false);
  });

  test('an error settling clears it', () => {
    // The lifecycle a 413 walks through: submit, action answers, back to idle
    // with the message rendered and the form usable again.
    expect(isSubmissionPending({ state: 'submitting', formMethod: 'POST' })).toBe(true);
    expect(isSubmissionPending({ state: 'loading', formMethod: 'POST' })).toBe(true);
    expect(isSubmissionPending({ state: 'idle' })).toBe(false);
  });
});

test.describe('formatBytes', () => {
  test('whole bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('binary units, one decimal, matching the limit they sit beside', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    // The panel's worked example.
    expect(formatBytes(43_200_512)).toBe('41.2 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  test('a value that would round to 1024 steps up instead', () => {
    // Never "1024.0 KB" — half a kilobyte shy of a megabyte reads as one.
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    // Comfortably below the boundary, the unit holds.
    expect(formatBytes(1000 * 1024)).toBe('1000.0 KB');
  });

  test('the upload cap itself reads as the number the form promises', () => {
    // SLIDE_FILE_MAX_BYTES is 75 MB; a file at the cap must not read as 78.6.
    expect(formatBytes(75 * 1024 * 1024)).toBe('75.0 MB');
  });

  test('nonsense in, empty string out — never "NaN MB" in the panel', () => {
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});
