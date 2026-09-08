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
 *   - the render TOKEN never reaches an access log, and never reaches a
 *     third-party host either — which is the whole reason it travels in a
 *     host-scoped cookie rather than the query string or the extra request
 *     header it used before.
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
  renderTokenFromCookies,
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

test.describe('the render token travels in a host-scoped cookie', () => {
  const TOKEN = '1767225720.c2lnbmF0dXJl';

  test('the URL Browser Run is pointed at carries no credential', () => {
    const url = ClassmojiService.deckThumbnail.thumbnailSourceUrl(
      'https://slides.classmoji.io',
      'deck-1'
    );
    expect(url).toBe('https://slides.classmoji.io/deck-1/thumbnail-source');
    expect(url).not.toContain('?');
    expect(url).not.toContain('render=');
  });

  test('the cookie is scoped to the render host, httpOnly, secure and Strict', () => {
    // Host scoping is the whole point: an extra request HEADER is attached to
    // every subresource the page fetches, which handed the live token to
    // `*.github.io` and to the content Worker. A cookie reaches this origin and
    // nothing else. The domain is a HOST — no scheme, no port — or the browser
    // never sends it.
    const cookie = ClassmojiService.deckThumbnail.renderTokenCookie(
      'https://slides.classmoji.io',
      TOKEN
    );

    expect(cookie).toEqual({
      name: 'cm_render',
      value: TOKEN,
      domain: 'slides.classmoji.io',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
  });

  test('a domain never carries a scheme or a port', () => {
    expect(
      ClassmojiService.deckThumbnail.renderTokenCookie('http://localhost:6500', TOKEN).domain
    ).toBe('localhost');
  });

  test('the route reads that cookie and only that cookie', () => {
    expect(renderTokenFromCookies(`cm_render=${TOKEN}`)).toBe(TOKEN);
    expect(renderTokenFromCookies(`a=1; cm_render=${TOKEN}; b=2`)).toBe(TOKEN);
    expect(renderTokenFromCookies('classmoji.session_token=abc; other=1')).toBeNull();
    expect(renderTokenFromCookies(null)).toBeNull();
    expect(renderTokenFromCookies('')).toBeNull();
    // A prefix match must not count.
    expect(renderTokenFromCookies(`x_cm_render=${TOKEN}`)).toBeNull();
  });

  test('a malformed percent-escape is a bad token, never a 500', () => {
    // This route's whole job is to refuse; throwing out of the parser would
    // turn a bad cookie into a server error.
    expect(renderTokenFromCookies('cm_render=%E0%A4%A')).toBe('%E0%A4%A');
  });

  test('it never touches the session cookie machinery', () => {
    // A route with no session must not acquire the means to resolve one. Ten
    // lines of `split(';')` cannot; `@classmoji/auth` can.
    expect(ROUTE_SOURCE).not.toContain('@classmoji/auth');
    expect(ROUTE_SOURCE).not.toContain('sessionTokenFromCookieHeader');
    expect(ROUTE_SOURCE).not.toContain('getAuthSession');
  });

  test('a token in a header or a query string is refused, not accepted', () => {
    // Neither old channel is a fallback: a credential channel nobody uses is a
    // credential channel nobody watches. A request presenting one presents no
    // cookie, so it takes the same refusal as a request presenting nothing.
    expect(ROUTE_SOURCE).toContain("renderTokenFromCookies(request.headers.get('cookie'))");
    expect(ROUTE_SOURCE).not.toContain("searchParams.get('render')");
    expect(ROUTE_SOURCE).not.toContain('RENDER_TOKEN_HEADER');

    // A header-bearing request carries no `cm_render`, so the parser answers
    // null and the loader refuses exactly as it does for an absent token.
    expect(renderTokenFromCookies('x-render-token=' + TOKEN)).toBeNull();
  });

  test('the production access-log format cannot contain the cookie', () => {
    // `morgan('tiny')` is `:method :url :status :res[content-length] -
    // :response-time ms`. None of those can carry a request header, so the
    // `Cookie` header never reaches the log — and the URL carries no credential
    // either. A format with `:req[...]` in it, or a custom format string, would
    // need this test rewritten, which is the point.
    const format = SERVER_SOURCE.match(/app\.use\(morgan\((['"])([^'"]+)\1\)\)/);
    expect(format, 'server.ts should configure morgan with a named format').not.toBeNull();
    expect(['tiny', 'short', 'common', 'dev']).toContain(format?.[2]);
    expect(SERVER_SOURCE).not.toContain(':req[');
    expect(SERVER_SOURCE).not.toContain('cm_render');
  });
});
