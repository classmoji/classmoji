/**
 * Unit tests for the non-deck branch of the slides app.
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module under test builds `Response` objects out of values it is handed and
 * touches nothing else.
 *
 * Two contracts are pinned here:
 *
 *   1. Every non-deck response carries `Cache-Control: no-store` and
 *      `Referrer-Policy: no-referrer`. The first stops a shared cache from
 *      handing a later viewer a signed URL minted for an earlier one; the
 *      second keeps a private classroom's slide id out of a third party's logs.
 *   2. A streamed download is served as an attachment that cannot render in
 *      this origin: the disposition the Worker would have sent, plus `nosniff`
 *      and a `sandbox` CSP.
 */

import { test, expect } from '@playwright/test';

import {
  NON_DECK_HEADERS,
  deckOnlyMessage,
  deckOnlyRefusal,
  nonDeckHeaders,
  slideFileResponse,
  slideKindNoun,
  slideLinkRedirect,
} from '../../app/utils/slideKind.ts';

function expectNoStoreAndNoReferrer(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}

test.describe('shared headers', () => {
  test('both headers are on the constant', () => {
    expect(NON_DECK_HEADERS['Cache-Control']).toBe('no-store');
    expect(NON_DECK_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });

  test('extras are added without losing the two', () => {
    const headers = nonDeckHeaders({ Location: 'https://example.com/x' });
    expect(headers.get('Location')).toBe('https://example.com/x');
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

test.describe('LINK slides', () => {
  test('redirect straight through, with no interstitial', () => {
    const response = slideLinkRedirect('https://example.com/deck');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://example.com/deck');
    expectNoStoreAndNoReferrer(response);
  });

  test('a link row with no destination throws a 404 rather than redirecting nowhere', () => {
    // THROWN, not returned: this is called from a loader on a route that has a
    // component, where a returned 404 would be parsed into route data and
    // rendered as an ordinary page.
    let thrown: unknown;
    try {
      slideLinkRedirect(null);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });
});

test.describe('FILE slides', () => {
  test('the signed-URL path is a 302 and never touches the bytes', async () => {
    const response = slideFileResponse({
      mode: 'redirect',
      url: 'https://content.classmoji.io/blob/abc?dl=xyz',
      filename: 'Lecture 3.pdf',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://content.classmoji.io/blob/abc?dl=xyz');
    expect(await response.text()).toBe('');
    expectNoStoreAndNoReferrer(response);
  });

  test('the fallback path sends the bytes as a locked-down attachment', async () => {
    const body = new TextEncoder().encode('%PDF-1.7 pretend');
    const response = slideFileResponse({
      mode: 'stream',
      body,
      filename: 'Lecture 3.pdf',
      contentType: 'application/pdf',
      disposition: 'attachment; filename="Lecture 3.pdf"',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    // The disposition is replayed verbatim — it is the Worker's, formatted by
    // the same helper, so the two delivery paths cannot disagree about the name
    // a student's browser saves.
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="Lecture 3.pdf"'
    );
    expect(response.headers.get('Content-Length')).toBe(String(body.byteLength));
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox allow-downloads"
    );
    expectNoStoreAndNoReferrer(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  test('nothing to serve is a 404, not an empty download', async () => {
    const response = slideFileResponse({ mode: 'unavailable', reason: 'not_in_map' });
    expect(response.status).toBe(404);
    // The reason is for the server log; the student gets a sentence.
    expect(await response.text()).not.toContain('not_in_map');
    expectNoStoreAndNoReferrer(response);
  });
});

test.describe('deck-only surfaces', () => {
  test('name the kind in the refusal', () => {
    expect(slideKindNoun('FILE')).toBe('an uploaded file');
    expect(slideKindNoun('LINK')).toBe('a link');
    expect(slideKindNoun('DECK')).toBe('not a slide deck');
    expect(slideKindNoun(null)).toBe('not a slide deck');
  });

  test('the message says what cannot be done and why', () => {
    expect(deckOnlyMessage('FILE', 'present')).toBe(
      'This slide is an uploaded file, so there is nothing to present.'
    );
    expect(deckOnlyMessage('LINK', 'follow')).toBe(
      'This slide is a link, so there is nothing to follow.'
    );
  });

  test('the refusal is a 404 — never a redirect that would start a download', async () => {
    const response = deckOnlyRefusal('FILE', 'present');
    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toContain('nothing to present');
    expectNoStoreAndNoReferrer(response);
  });
});
