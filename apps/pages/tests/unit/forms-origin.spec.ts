import { test, expect } from '@playwright/test';

import {
  MAX_SUBMISSION_BYTES,
  checkOrigin,
  readCappedBody,
} from '../../app/utils/originCheck.server.ts';

/**
 * The forms submission origin check and body cap, as pure functions.
 *
 * ── Why these are unit-tested and not only exercised over HTTP ─────────────
 * In DEVELOPMENT the Vite middleware answers a cross-origin POST with its own
 * 400 before the request ever reaches a route module, so an end-to-end test
 * that asserts "the evil origin is refused" passes whether or not this code
 * exists. In PRODUCTION there is no Vite, and this function is the only thing
 * standing there. Testing it directly is what keeps the check honest — an
 * HTTP-level assertion alone would go on passing if someone deleted the call.
 *
 * The e2e suite still asserts the HTTP behaviour (refused, and no row written),
 * because "the helper says no" and "the endpoint says no" are different claims.
 *
 * Runs in the Playwright runner with no browser and no dev stack, like
 * `forms-paths.spec.ts` — both modules are deliberately import-free so they can
 * be tested as the pure decisions they are.
 */

const request = (
  headers: Record<string, string>,
  url = 'https://pages.classmoji.io/cs52/forms/w'
) => new Request(url, { method: 'POST', headers });

test.describe('checkOrigin', () => {
  test('accepts an Origin that matches the request', () => {
    const result = checkOrigin(request({ origin: 'https://pages.classmoji.io' }));
    expect(result.ok).toBe(true);
  });

  test('refuses a foreign Origin — the case that actually matters', () => {
    const result = checkOrigin(request({ origin: 'https://evil.example' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('origin-mismatch');
  });

  test('refuses a same-host Origin on a different scheme or port', () => {
    // `startsWith`-style comparisons pass these. `URL.origin` does not, which is
    // why the check compares origins rather than hostnames.
    for (const origin of [
      'http://pages.classmoji.io',
      'https://pages.classmoji.io:8443',
      'https://pages.classmoji.io.evil.example',
    ]) {
      expect(checkOrigin(request({ origin })).ok).toBe(false);
    }
  });

  test('refuses the null Origin a sandboxed iframe sends', () => {
    // Also the shape that would throw if the comparison tried to parse it.
    expect(checkOrigin(request({ origin: 'null' })).ok).toBe(false);
  });

  test('falls back to Sec-Fetch-Site when Origin is absent', () => {
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect(checkOrigin(request({ 'sec-fetch-site': site })).ok).toBe(true);
    }
    const cross = checkOrigin(request({ 'sec-fetch-site': 'cross-site' }));
    expect(cross.ok).toBe(false);
    expect(cross.reason).toBe('cross-site-fetch');
  });

  test('allows a request carrying neither header', () => {
    // A non-browser client: curl, a probe, a scripted API call. It holds no
    // ambient cookie to be confused into spending, so there is no CSRF to
    // commit — and refusing it would break every scripted caller while
    // stopping no attack a browser can mount.
    expect(checkOrigin(request({})).ok).toBe(true);
  });

  test('Origin wins over Sec-Fetch-Site when both are present', () => {
    // A client that sets a friendly Sec-Fetch-Site by hand must not thereby
    // excuse a foreign Origin.
    const result = checkOrigin(
      request({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' })
    );
    expect(result.ok).toBe(false);
  });
});

test.describe('readCappedBody', () => {
  const withBody = (body: string, headers: Record<string, string> = {}) =>
    new Request('https://pages.classmoji.io/cs52/forms/w', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  test('returns a body inside the cap', async () => {
    expect(await readCappedBody(withBody('{"answers":{}}'))).toBe('{"answers":{}}');
  });

  test('refuses a body over the cap', async () => {
    expect(await readCappedBody(withBody('x'.repeat(MAX_SUBMISSION_BYTES + 1)))).toBeNull();
  });

  test('refuses on a declared Content-Length before reading anything', async () => {
    expect(
      await readCappedBody(withBody('{}', { 'content-length': String(MAX_SUBMISSION_BYTES + 1) }))
    ).toBeNull();
  });

  test('a body that lies about its length is still refused', async () => {
    // Content-Length is client-supplied, so the decoded length is checked too.
    const oversized = 'x'.repeat(MAX_SUBMISSION_BYTES + 1);
    expect(await readCappedBody(withBody(oversized, { 'content-length': '2' }))).toBeNull();
  });

  test('measures BYTES, not characters', async () => {
    // A multi-byte character costs more than one. Measuring `.length` would let
    // a body roughly three times the cap through.
    const justOver = '✓'.repeat(Math.ceil(MAX_SUBMISSION_BYTES / 3) + 1);
    expect(justOver.length).toBeLessThan(MAX_SUBMISSION_BYTES);
    expect(await readCappedBody(withBody(justOver))).toBeNull();
  });
});
