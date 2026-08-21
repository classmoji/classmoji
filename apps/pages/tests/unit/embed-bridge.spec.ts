/**
 * Unit tests for the embed bridge (app/routes/$classroomSlug/embedBridge.ts).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module under test is pure. It carries one security boundary: the origin this
 * document is allowed to postMessage to when the webapp frames it.
 *
 * The rule being pinned down is that `?parentOrigin=` is an ASSERTION by
 * whoever built the embed URL, and WEBAPP_URL is the authority. A mismatch is
 * not "prefer the server value" — it is silence, because a mismatch means
 * something we are not deployed against is framing us.
 */

import { expect, test } from '@playwright/test';
import {
  PAGE_NAV_MESSAGE,
  buildNavMessage,
  resolveEmbedParentOrigin,
  resolveNavGridHref,
} from '../../app/routes/$classroomSlug/embedBridge.ts';

const WEBAPP = 'http://localhost:3040';

test.describe('resolveEmbedParentOrigin', () => {
  test('is inert when the document is not embedded', () => {
    expect(
      resolveEmbedParentOrigin({ isEmbedded: false, parentOriginParam: WEBAPP, webappUrl: WEBAPP })
    ).toBeNull();
  });

  test('is inert when WEBAPP_URL is unset or unparseable — no authority, no messages', () => {
    expect(
      resolveEmbedParentOrigin({ isEmbedded: true, parentOriginParam: WEBAPP, webappUrl: '' })
    ).toBeNull();
    expect(
      resolveEmbedParentOrigin({
        isEmbedded: true,
        parentOriginParam: WEBAPP,
        webappUrl: 'not a url',
      })
    ).toBeNull();
    expect(
      resolveEmbedParentOrigin({ isEmbedded: true, parentOriginParam: WEBAPP })
    ).toBeNull();
  });

  test('uses the configured webapp origin when the URL makes no claim', () => {
    expect(resolveEmbedParentOrigin({ isEmbedded: true, webappUrl: WEBAPP })).toBe(WEBAPP);
    expect(
      resolveEmbedParentOrigin({ isEmbedded: true, parentOriginParam: null, webappUrl: WEBAPP })
    ).toBe(WEBAPP);
  });

  test('accepts a corroborating claim, including one carrying a path', () => {
    expect(
      resolveEmbedParentOrigin({
        isEmbedded: true,
        parentOriginParam: WEBAPP,
        webappUrl: `${WEBAPP}/`,
      })
    ).toBe(WEBAPP);
    expect(
      resolveEmbedParentOrigin({
        isEmbedded: true,
        parentOriginParam: `${WEBAPP}/student/cs52`,
        webappUrl: WEBAPP,
      })
    ).toBe(WEBAPP);
  });

  test('stays silent when the embedder claims an origin we are not deployed against', () => {
    for (const claim of [
      'https://evil.example',
      'http://localhost:3041',
      'https://localhost:3040',
      'http://127.0.0.1:3040',
    ]) {
      expect(
        resolveEmbedParentOrigin({
          isEmbedded: true,
          parentOriginParam: claim,
          webappUrl: WEBAPP,
        }),
        `claim ${claim} must not be trusted`
      ).toBeNull();
    }
  });

  // An opaque scheme parses but yields the origin "null" (the string), which is
  // not our authority — so it lands in the mismatch branch and we stay silent.
  // Pinned deliberately: a present-but-nonsense claim is a wrong claim, and the
  // conservative reading is the one that cannot leak.
  test('treats a present-but-nonsense claim as a mismatch, not as absence', () => {
    for (const claim of ['javascript:alert(1)', 'data:text/html,x', 'about:blank']) {
      expect(
        resolveEmbedParentOrigin({
          isEmbedded: true,
          parentOriginParam: claim,
          webappUrl: WEBAPP,
        }),
        `claim ${claim} must not be trusted`
      ).toBeNull();
    }
  });

  // Whereas a claim that is not a URL at all is indistinguishable from noise
  // and falls through to "no claim made".
  test('falls through to the configured origin when the claim is not a URL', () => {
    expect(
      resolveEmbedParentOrigin({
        isEmbedded: true,
        parentOriginParam: 'not a url',
        webappUrl: WEBAPP,
      })
    ).toBe(WEBAPP);
  });
});

test.describe('buildNavMessage', () => {
  test('carries the identity the host header and ↗ need', () => {
    expect(
      buildNavMessage({
        classroomSlug: 'cs52',
        page: { id: 'p1', title: 'Lab 1', slug: 'lab-1' },
      })
    ).toEqual({
      type: PAGE_NAV_MESSAGE,
      classroomSlug: 'cs52',
      pageId: 'p1',
      pageSlug: 'lab-1',
      title: 'Lab 1',
    });
  });

  test('normalises a slug-less or title-less page', () => {
    expect(buildNavMessage({ classroomSlug: 'cs52', page: { id: 'p1' } })).toEqual({
      type: PAGE_NAV_MESSAGE,
      classroomSlug: 'cs52',
      pageId: 'p1',
      pageSlug: null,
      title: '',
    });
  });
});

test.describe('resolveNavGridHref', () => {
  const anchor = (attrs: Record<string, string>) => ({
    getAttribute: (name: string) => attrs[name] ?? null,
  });

  test('resolves a page entry to an embedded page URL', () => {
    expect(resolveNavGridHref(anchor({ 'data-kind': 'page', 'data-page-id': 'p1' }), 'cs52')).toBe(
      '/cs52/p1?embed=true'
    );
  });

  test('leaves external entries and ordinary links alone', () => {
    expect(resolveNavGridHref(anchor({ 'data-kind': 'external' }), 'cs52')).toBeNull();
    expect(resolveNavGridHref(anchor({ 'data-kind': 'page' }), 'cs52')).toBeNull();
    expect(resolveNavGridHref(null, 'cs52')).toBeNull();
  });

  test('encodes both segments', () => {
    expect(
      resolveNavGridHref(anchor({ 'data-kind': 'page', 'data-page-id': 'a/b' }), 'x y')
    ).toBe('/x%20y/a%2Fb?embed=true');
  });
});
