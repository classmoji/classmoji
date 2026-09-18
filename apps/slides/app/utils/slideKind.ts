/**
 * slideKind.ts — what this app RESPONDS with for a slide that is not a deck.
 *
 * A `Slide` is a reveal.js deck (`kind: 'DECK'`), an uploaded document students
 * download (`'FILE'`), or an external URL they are redirected to (`'LINK'`).
 * Every route in this app was written when only the first existed, so each one
 * needs the same two answers: "is this mine to render?" and "if not, what does
 * the viewer get instead?". The second question is answered HERE, once.
 *
 * ## Pure, and deliberately so
 *
 * Nothing in this file imports Prisma, `@classmoji/services`, or anything else
 * that reaches a network. It builds `Response` objects out of values a caller
 * already has, which is why `tests/unit/slide-kind.spec.ts` can assert the
 * headers of a download without a database or a dev stack — and why a route
 * component importing it by accident cannot drag the deck engine into the
 * browser bundle.
 *
 * The POLICY question — which kinds are decks — is deliberately NOT duplicated
 * here. `isDeckSlide` in `@classmoji/services/slides` owns it, every caller
 * below asks that, and these helpers only take the answer.
 *
 * ## Why `no-store` and `no-referrer` are on every one of these
 *
 * `Cache-Control: no-store`: a FILE redirect carries a short-lived signed URL
 * in its `Location`, and a cached 302 would hand a later viewer a URL minted
 * for an earlier one — or, once it expired, a download that simply fails. The
 * bytes themselves are no different: a slide in a private classroom must not
 * sit in a shared proxy keyed only by `/{slideId}`.
 *
 * `Referrer-Policy: no-referrer`: the destination of a LINK slide is somebody
 * else's server, and the slide id in our URL is the thing that identifies a
 * private classroom's material. It has no business appearing in their logs.
 */

/** The two headers every non-deck response carries. See the note above. */
export const NON_DECK_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
});

/** `NON_DECK_HEADERS` plus whatever this particular response adds. */
export function nonDeckHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ ...NON_DECK_HEADERS, ...extra });
}

/**
 * The shape `slideFileService.openSlideFile` hands back.
 *
 * Restated structurally rather than imported so this module stays free of
 * `@classmoji/services` entirely — the service's own type is assignable to it,
 * so the two cannot drift without a compile error at the call site.
 */
export type SlideFileDeliveryLike =
  | { mode: 'redirect'; url: string; filename: string }
  | {
      mode: 'stream';
      body: Uint8Array;
      filename: string;
      contentType: string;
      disposition: string;
    }
  | { mode: 'unavailable'; reason: string };

/** The sentence a viewer gets when a slide's file or link cannot be served. */
export const SLIDE_SOURCE_UNAVAILABLE = 'This slide has no file to download.';

/**
 * Turn a delivery decision into the response the browser gets.
 *
 * `redirect` is the ordinary path: the bytes live in R2 behind the content
 * Worker and never touch this app. `stream` is the fallback for a classroom
 * with no delivery layer — this app read the file from GitHub itself, and must
 * now send the header the Worker would have sent, which is why the service
 * hands over a pre-formatted `disposition` rather than a bare filename.
 *
 * The streamed branch carries the Worker's download hardening too: `nosniff`
 * plus a `default-src 'none'; sandbox allow-downloads` CSP. That matters more
 * here than it does there — these bytes are served from the SLIDES origin,
 * where a "PDF" that is really HTML would otherwise run with a session cookie
 * in scope. `attachment` alone already prevents the render; these two make it
 * so that a browser that ignores the disposition still cannot.
 */
export function slideFileResponse(delivery: SlideFileDeliveryLike): Response {
  if (delivery.mode === 'redirect') {
    return new Response(null, {
      status: 302,
      headers: nonDeckHeaders({ Location: delivery.url }),
    });
  }

  if (delivery.mode === 'stream') {
    // `BodyInit` in TypeScript's DOM lib wants `ArrayBufferView<ArrayBuffer>`,
    // and a Node `Buffer` is `Buffer<ArrayBufferLike>`. `Response` accepts
    // either at runtime; the generic parameter is the whole of the difference.
    return new Response(delivery.body as unknown as BodyInit, {
      status: 200,
      headers: nonDeckHeaders({
        'Content-Type': delivery.contentType,
        'Content-Disposition': delivery.disposition,
        'Content-Length': String(delivery.body.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox allow-downloads",
      }),
    });
  }

  return new Response(SLIDE_SOURCE_UNAVAILABLE, {
    status: 404,
    headers: nonDeckHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
  });
}

/**
 * Send the viewer to a LINK slide's destination.
 *
 * No interstitial, by decision: a linked slide behaves like the thing it points
 * at. `source_url` was validated as an absolute `https:` URL by
 * `validateSlideLinkUrl` before it was ever stored, so this does not re-parse
 * it — but a row with an empty one is a slide with nothing behind it.
 *
 * RETURNS the redirect and THROWS the 404, because the caller is a loader on a
 * route that has a component: React Router passes a returned REDIRECT straight
 * through to the browser (headers and all), while a returned 404 would be
 * parsed into route data and rendered as a normal page. A thrown one reaches
 * the error boundary with its status intact. Resource routes have no such
 * split, which is why `slideFileResponse` below returns both.
 */
export function slideLinkRedirect(url: string | null | undefined): Response {
  if (!url) {
    throw new Response('This slide has no link to open.', {
      status: 404,
      headers: nonDeckHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
    });
  }
  return new Response(null, {
    status: 302,
    headers: nonDeckHeaders({ Location: url }),
  });
}

/**
 * COSMETIC ONLY: is this kind a deck, for a component that must not import the
 * deck engine to ask?
 *
 * `isDeckSlide` in `@classmoji/services/slides` is the authority and is what
 * every SERVER check calls; this exists because `@classmoji/services/slides`
 * pulls cheerio and the whole deck engine, and a React component may not. Use
 * it to decide whether to DRAW a button, never to decide whether an action may
 * run — the route behind each one refuses on its own.
 *
 * Absent `kind` reads as DECK, exactly as the service's does.
 */
export function isDeckKind(kind: string | null | undefined): boolean {
  return !kind || kind === 'DECK';
}

/** How a slide of this kind is described to a person. */
export function slideKindNoun(kind: string | null | undefined): string {
  if (kind === 'FILE') return 'an uploaded file';
  if (kind === 'LINK') return 'a link';
  return 'not a slide deck';
}

/** "This slide is a link, so there is nothing to present." */
export function deckOnlyMessage(kind: string | null | undefined, operation: string): string {
  return `This slide is ${slideKindNoun(kind)}, so there is nothing to ${operation}.`;
}

/**
 * The refusal a deck-only SCREEN gives a non-deck slide.
 *
 * 404 rather than a redirect to `/{slideId}`: for a FILE slide that redirect
 * would start a download nobody asked for, and for a LINK it would bounce the
 * viewer to somebody else's site from a URL they typed as `/present`. Neither
 * is reachable from the product — the toolbar that links to these surfaces only
 * renders on a deck — so the honest answer to a hand-typed or stale URL is that
 * the page is not there.
 */
export function deckOnlyRefusal(kind: string | null | undefined, operation: string): Response {
  return new Response(deckOnlyMessage(kind, operation), {
    status: 404,
    headers: nonDeckHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
  });
}
