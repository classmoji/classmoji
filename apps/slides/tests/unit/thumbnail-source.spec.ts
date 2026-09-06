/**
 * Unit tests for `/{slideId}/thumbnail-source` — the page Cloudflare Browser
 * Run screenshots to make a deck's card image.
 *
 * The loader itself needs Postgres and a content repo, so what is pinned here
 * is everything the loader is BUILT OUT OF, plus the structural invariants that
 * only a source read can check. Each one exists because getting it wrong is
 * silent:
 *
 *   - `firstSlideOnly` decides what ends up in the picture. Get the vertical
 *     stack case wrong and a deck's card is its second slide, or nothing.
 *   - the RESPONSE HEADERS are identical on the render and on the refusal. A
 *     403 that got cached, or a render that got indexed, is its own small
 *     problem and there is no reason for the two to differ.
 *   - the REFUSAL is one function, so an unknown slide id and a bad token are
 *     byte-identical. Two `new Response('Forbidden')` literals drift, and the
 *     drift is an oracle for which decks exist.
 *   - the route is a RESOURCE route: no `default` export, no `ErrorBoundary`.
 *     Either one would put React chrome inside the screenshot.
 *   - the render TOKEN never reaches an access log, which is the whole reason
 *     it travels in a header rather than the query string it started in.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import type { DeckJson } from '@classmoji/services/slides';
import {
  RENDER_HEADERS,
  firstSlideOnly,
  refusalDetail,
  renderRefusal,
} from '../../app/routes/$slideId_.thumbnail-source/route.tsx';
import * as thumbnailSourceRoute from '../../app/routes/$slideId_.thumbnail-source/route.tsx';
import { ClassmojiService } from '@classmoji/services';

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/routes/$slideId_.thumbnail-source/route.tsx', import.meta.url)),
  'utf8'
);

const SERVER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../server.ts', import.meta.url)),
  'utf8'
);

function deck(slides: DeckJson['slides']): DeckJson {
  return { version: 1, slides } as unknown as DeckJson;
}

test.describe('firstSlideOnly', () => {
  test('keeps exactly the first section of a flat deck', () => {
    const trimmed = firstSlideOnly(
      deck([
        { html: '<h1>one</h1>' },
        { html: '<h1>two</h1>' },
        { html: '<h1>three</h1>' },
      ] as never)
    );

    expect(trimmed.slides).toHaveLength(1);
    expect(trimmed.slides[0]).toMatchObject({ html: '<h1>one</h1>' });
  });

  test('keeps the STACK and its first child when slide one is a vertical stack', () => {
    // Reveal's first slide is the stack's first child, not the stack itself.
    // Flattening the stack would change the deck's structure; dropping it would
    // photograph slide two. Keep the wrapper, keep one child.
    const trimmed = firstSlideOnly(
      deck([
        { html: '', children: [{ html: '<h1>1.1</h1>' }, { html: '<h1>1.2</h1>' }] },
        { html: '<h1>two</h1>' },
      ] as never)
    );

    expect(trimmed.slides).toHaveLength(1);
    expect(trimmed.slides[0].children).toHaveLength(1);
    expect(trimmed.slides[0].children?.[0]).toMatchObject({ html: '<h1>1.1</h1>' });
  });

  test('answers an empty deck with an empty deck rather than throwing', () => {
    // A deck with no slides is rare and legal. The render then fails on the
    // readiness selector, which keeps whatever thumbnail was there — far better
    // than a 500 in a task nobody is watching.
    const trimmed = firstSlideOnly(deck([]));
    expect(trimmed.slides).toEqual([]);
  });

  test('leaves everything else about the deck alone', () => {
    const original = { ...deck([{ html: 'a' }] as never), theme: 'shared:dartmouth' };
    const trimmed = firstSlideOnly(original as never) as typeof original;
    expect(trimmed.theme).toBe('shared:dartmouth');
  });
});

test.describe('the response headers', () => {
  test('are no-store, noindex and no-referrer', () => {
    expect(RENDER_HEADERS['Cache-Control']).toContain('no-store');
    expect(RENDER_HEADERS['X-Robots-Tag']).toContain('noindex');
    expect(RENDER_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });

  test('are on the 403 as well as the render', () => {
    const refusal = renderRefusal();
    expect(refusal.status).toBe(403);
    expect(refusal.headers.get('cache-control')).toContain('no-store');
    expect(refusal.headers.get('x-robots-tag')).toContain('noindex');
    expect(refusal.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('the rendered 200 is built from the same constant', () => {
    // The loader needs a database, so the success path is checked structurally:
    // there is exactly one place a 200 is constructed and it takes
    // RENDER_HEADERS. A hand-rolled header object on either side is how the two
    // answers start to differ.
    expect(ROUTE_SOURCE).toContain(
      'new Response(withReadinessMarker(html), { headers: RENDER_HEADERS })'
    );
  });
});

test.describe('an unknown slide and a bad token are the same answer', () => {
  test('both go through the one refusal', () => {
    // One condition, one throw. Splitting these — a 404 for an unknown id, a
    // 403 for a bad token — would tell an unauthenticated caller exactly which
    // slide ids exist.
    expect(ROUTE_SOURCE).toContain('if (!slide || !verification.ok)');
    expect(ROUTE_SOURCE.match(/throw renderRefusal\(\)/g)).toHaveLength(1);
    expect(ROUTE_SOURCE.match(/status: 403/g)).toHaveLength(1);
  });

  test('the refusal is byte-identical every time it is built', async () => {
    const a = renderRefusal();
    const b = renderRefusal();

    expect(await a.text()).toBe(await b.text());
    expect(a.status).toBe(b.status);
    expect([...a.headers.entries()].sort()).toEqual([...b.headers.entries()].sort());
  });

  test('the reason reaches the log and never the caller', async () => {
    // The body carries nothing at all; the diagnosis (expired vs invalid, and
    // the clock skew when expired) is a server-side console line.
    expect(await renderRefusal().text()).toBe('Forbidden');
    expect(ROUTE_SOURCE).toContain('check for clock skew');
    expect(ROUTE_SOURCE).toContain('console.warn');
  });
});

test.describe('refusalDetail — what the SERVER learns', () => {
  test('names an unknown slide as such', () => {
    expect(refusalDetail(null, { ok: false, reason: 'malformed' })).toBe('unknown-slide');
  });

  test('an expired token reports how late it was, and points at the clock', () => {
    // A render token lives 120 seconds and is minted immediately before the POST
    // that presents it, so any positive skew is two machines disagreeing about
    // the time — not a slow queue. This repo has lost an afternoon to that once.
    const detail = refusalDetail(
      { id: 'deck-1' },
      { ok: false, reason: 'expired', exp: 1767225720, skewSeconds: 412 }
    );

    expect(detail).toContain('expired 412s ago');
    expect(detail).toContain('1767225720');
    expect(detail).toContain('clock skew');
  });

  test('everything else is invalid, and says which kind', () => {
    // Distinct from `expired` on purpose: "that signature is not ours" and
    // "your clock is fast" are different problems with different fixes.
    expect(refusalDetail({ id: 'deck-1' }, { ok: false, reason: 'bad-signature' })).toBe(
      'invalid (bad-signature)'
    );
    expect(refusalDetail({ id: 'deck-1' }, { ok: false, reason: 'malformed' })).toBe(
      'invalid (malformed)'
    );
  });

  test('is built from the verification, never from the token', () => {
    // The signature is not part of the diagnosis and has no business in a log
    // line — `refusalDetail` is never handed the token at all, so there is no
    // shape of it that could carry one.
    expect(refusalDetail.length).toBe(2);
    expect(ROUTE_SOURCE).not.toContain('refusalDetail(slide, verification, token');
  });
});

test.describe('the resource-route invariant', () => {
  test('exports no default component and no ErrorBoundary', () => {
    // Either one makes React Router render app chrome into the frame Browser
    // Run photographs — and an ErrorBoundary would turn the deliberate 403 into
    // a rendered error page that the screenshot would happily capture.
    expect(thumbnailSourceRoute).not.toHaveProperty('default');
    expect(thumbnailSourceRoute).not.toHaveProperty('ErrorBoundary');
  });

  test('exports the loader and nothing that renders', () => {
    expect(typeof thumbnailSourceRoute.loader).toBe('function');
    expect(ROUTE_SOURCE).not.toContain('export default');
  });
});

test.describe('the render token cannot reach an access log', () => {
  test('the URL Browser Run is pointed at carries no credential', () => {
    const url = ClassmojiService.deckThumbnail.thumbnailSourceUrl(
      'https://slides.classmoji.io',
      'deck-1'
    );
    expect(url).toBe('https://slides.classmoji.io/deck-1/thumbnail-source');
    expect(url).not.toContain('?');
    expect(url).not.toContain('render=');
  });

  test('the route reads the header and refuses the query string', () => {
    // Not a fallback, deliberately: a credential channel nobody uses is a
    // credential channel nobody watches.
    expect(ROUTE_SOURCE).toContain('request.headers.get(RENDER_TOKEN_HEADER)');
    expect(ROUTE_SOURCE).not.toContain("searchParams.get('render')");
  });

  test('the production access-log format has no token that can hold a header', () => {
    // `morgan('tiny')` is `:method :url :status :res[content-length] -
    // :response-time ms`. None of those can carry a request header, and the URL
    // no longer carries the credential either. A format string with
    // `:req[...]` in it — or a custom format — would need this test rewritten,
    // which is the point.
    const format = SERVER_SOURCE.match(/app\.use\(morgan\((['"])([^'"]+)\1\)\)/);
    expect(format, 'server.ts should configure morgan with a named format').not.toBeNull();
    expect(['tiny', 'short', 'common', 'dev']).toContain(format?.[2]);
    expect(SERVER_SOURCE).not.toContain(':req[');
  });
});
