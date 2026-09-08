/**
 * `/{slideId}/thumbnail-source` — the page a screenshot is taken OF.
 *
 * A deck's card image on the slides index is a stored WebP, rendered once per
 * save by Cloudflare Browser Run (`deck-thumbnail-render`) and committed into
 * the classroom's content repo. Browser Run navigates HERE, waits for
 * `[data-thumbnail-ready]`, and screenshots a 1280×720 viewport.
 *
 * A RESOURCE route on purpose — no default export, no React, no app chrome.
 * The response IS the deck's own generated document, trimmed to its first
 * slide. Reusing `$slideId` would have put the viewer's toolbar, preview
 * banner and Sandpack mounts inside the frame and then required cropping them
 * back out; there is nothing to crop out of a page that never had them.
 *
 * ── What authorises the request ────────────────────────────────────────────
 * A signed render token in the `cm_render` COOKIE, and NOTHING ELSE. No session
 * is consulted and the session cookie machinery is never touched: the caller is
 * a headless browser on infrastructure we do not control, and it must be able to
 * read exactly one deck for exactly two minutes. The token binds `{host,
 * classroomId, slideId, exp}` under the classroom's derived key, in its own
 * `cm1|render|` namespace (see packages/content-signing/src/render.ts).
 *
 * A COOKIE, and only a cookie. The two channels it is NOT allowed to arrive on
 * are the two it used to:
 *
 *   - `?render=` in the query string, which this app's own `morgan` access log
 *     writes on every request, which proxies cache, and which travels onward in
 *     a `Referer`;
 *   - an `X-Render-Token` header, which Browser Run attaches to every request
 *     the PAGE makes — so a deck's images carried the live token to
 *     `*.github.io` and to the content Worker.
 *
 * A cookie is scoped BY HOST by the browser itself: it reaches this origin and
 * no other. Neither of the old channels is accepted as a fallback — a
 * credential channel nobody uses is a credential channel nobody watches, and a
 * request presenting one is refused exactly like a request presenting nothing.
 *
 * ── What it is allowed to see ──────────────────────────────────────────────
 * The FIRST slide, with NO speaker notes. Notes are dropped structurally —
 * `includeNotes: false` means the generator never emits an `<aside
 * class="notes">` at all, rather than the view path's after-the-fact regex
 * strip — because this image is later served to everyone who can see the deck's
 * card, and a private note baked into it could not be taken back.
 *
 * Asset URLs are signed at the deck's own visibility tier (`month` public,
 * `week` otherwise), never `edit`: the delivery pass here is a READ like any
 * other, and `deckAccessFor`'s reasoning applies unchanged. For a classroom the
 * delivery layer is NOT on for there is nothing to sign, and the stored
 * `/content/…` references point at a session-gated proxy this caller cannot
 * satisfy — so those are rewritten to the public Pages CDN instead (see the
 * loader). Either way the render input needs no session.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import {
  generateDeckHtml,
  loadDeck,
  type DeckJson,
  type DeckSlide,
} from '@classmoji/services/slides';
import {
  deckDeliveryContext,
  publicDeckThemeUrls,
  resolveDeckAssets,
  resolveDeckAssetsPublic,
  resolveDeliveryThemeUrls,
} from '~/utils/deckDelivery.server';

/**
 * Geometry and the readiness attribute come from the shared contract in
 * `@classmoji/services`, not from a constant here: the render task waits for
 * exactly this attribute and renders at exactly this size, and it cannot import
 * this route.
 */
const { RENDER_TOKEN_COOKIE, THUMBNAIL_READY_ATTRIBUTE } = ClassmojiService.deckThumbnail;

/**
 * Never cached, never indexed, never framed. The SAME headers on the refusal
 * and on the render — a 403 that leaked into a cache or an index would be its
 * own small problem, and there is no reason for the two answers to differ.
 *
 * `no-store` because the response is one deck's content served without a
 * session; `noindex` because the route is reachable by URL and a crawler that
 * got hold of one should not keep it; `no-referrer` so the URL cannot travel
 * onward through anything the page loads.
 */
export const RENDER_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * The ONE refusal this route has.
 *
 * An unknown slide id and a bad token answer byte-for-byte identically, so the
 * response tells a caller nothing about which decks exist. That is only true if
 * there is a single place that builds it — two `new Response('Forbidden')`
 * literals drift, and the drift is the oracle.
 */
export function renderRefusal(): Response {
  return new Response('Forbidden', { status: 403, headers: RENDER_HEADERS });
}

/**
 * Pull `cm_render` out of a `Cookie` header. Nothing else, and no session code.
 *
 * Deliberately a plain parser rather than anything from the auth package: this
 * route has no session, must never acquire one, and reaching for the session
 * cookie machinery is how a route that "just needs to read a cookie" ends up
 * resolving a membership. Ten lines of `split(';')` cannot do that.
 *
 * The token is `{exp}.{base64url}`, so it needs no encoding — but a cookie value
 * may legally be percent-encoded, and a malformed escape must read as a bad
 * token rather than throw a 500 out of a route whose whole job is to refuse.
 */
export function renderTokenFromCookies(header: string | null): string | null {
  if (!header) return null;

  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    if (at === -1) continue;
    if (pair.slice(0, at).trim() !== RENDER_TOKEN_COOKIE) continue;

    const raw = pair.slice(at + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  return null;
}

/**
 * Why we refused, for the SERVER LOG only. Never reaches the response.
 *
 * `expired` versus `invalid` is the difference between "these two machines
 * disagree about the time" and "that signature is not ours", and one of those is
 * a five-minute fix nobody can make from a bare 403. A render token lives 120
 * seconds and is minted immediately before the POST that presents it, so a
 * positive skew of any size means a clock rather than a slow queue — this repo
 * has already lost an afternoon to a fast Trigger clock reading as an outage.
 */
export function refusalDetail(
  slide: unknown,
  verification: { ok: boolean; reason?: string; exp?: number; skewSeconds?: number }
): string {
  if (!slide) return 'unknown-slide';
  if (verification.reason === 'expired') {
    return `expired ${verification.skewSeconds}s ago (exp ${verification.exp}) — check for clock skew between the render worker and this host`;
  }
  return `invalid (${verification.reason})`;
}

/**
 * The deck reduced to its first slide.
 *
 * A top-level section may be a vertical STACK, in which case Reveal's first
 * slide is that stack's first child — so the stack is kept and everything after
 * its first child is dropped, rather than the stack being flattened. Notes are
 * not stripped here; the generator is told not to emit them.
 */
export function firstSlideOnly(deck: DeckJson): DeckJson {
  const first: DeckSlide | undefined = deck.slides[0];
  if (!first) return { ...deck, slides: [] };
  const trimmed: DeckSlide =
    first.children && first.children.length > 0
      ? { ...first, children: [first.children[0]] }
      : first;
  return { ...deck, slides: [trimmed] };
}

/**
 * The one script the render page carries, plus the chrome suppression.
 *
 * Reveal draws controls, a progress bar and a slide number; none of them belong
 * in a card image. Hiding them in CSS is cheaper and more reliable than
 * re-configuring the deck's own `Reveal.initialize` call, which is emitted by
 * the shared generator and must stay byte-identical to what a save writes.
 *
 * The readiness signal is a HARD-CAPPED settle, not a promise chain that can
 * hang: images and fonts get their chance, then the flag goes up no matter
 * what. Browser Run's `waitForSelector` is the outer bound, and a deck with one
 * unreachable image must produce a slightly incomplete thumbnail rather than
 * burning the whole render budget and producing none.
 */
function readinessScript(): string {
  return [
    '<style>',
    '  .reveal .controls, .reveal .progress, .reveal .slide-number { display: none !important; }',
    '  html, body { margin: 0; overflow: hidden; }',
    '</style>',
    '<script>',
    '  (function () {',
    '    var done = false;',
    '    function mark() {',
    '      if (done) return;',
    '      done = true;',
    `      document.documentElement.setAttribute('${THUMBNAIL_READY_ATTRIBUTE}', '');`,
    '    }',
    '    // Outer cap: whatever else happens, the page declares itself ready.',
    '    setTimeout(mark, 8000);',
    '    function settle() {',
    '      var pending = [];',
    '      var images = document.images || [];',
    '      for (var i = 0; i < images.length; i += 1) {',
    '        var img = images[i];',
    '        if (img.complete) continue;',
    '        pending.push(',
    '          new Promise(function (resolve) {',
    "            img.addEventListener('load', resolve, { once: true });",
    "            img.addEventListener('error', resolve, { once: true });",
    '          })',
    '        );',
    '      }',
    '      if (document.fonts && document.fonts.ready) {',
    '        pending.push(document.fonts.ready.catch(function () {}));',
    '      }',
    '      Promise.all(pending).then(function () {',
    '        requestAnimationFrame(function () { requestAnimationFrame(mark); });',
    '      }, mark);',
    '    }',
    "    if (document.readyState === 'complete') settle();",
    "    else window.addEventListener('load', settle);",
    '  })();',
    '</script>',
  ].join('\n');
}

/** Splice the readiness block in just before `</body>`; append if absent. */
function withReadinessMarker(html: string): string {
  const block = readinessScript();
  const at = html.lastIndexOf('</body>');
  return at === -1 ? `${html}\n${block}` : `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { slideId } = params;
  if (!slideId) throw new Response('Missing slideId', { status: 400 });

  const url = new URL(request.url);
  // The cookie, and only the cookie. See the note at the top of this file.
  const token = renderTokenFromCookies(request.headers.get('cookie'));

  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });

  // 404 before the token check would tell an unauthenticated caller which slide
  // ids exist, so an unknown deck answers exactly what a bad token does.
  const verification = slide
    ? await ClassmojiService.deckRenderToken.verifyDeckRenderToken(token, {
        origin: url.origin,
        classroomId: slide.classroom_id,
        slideId: slide.id,
        keyVersion: slide.classroom?.content_key_version,
      })
    : ({ ok: false, reason: 'malformed' } as const);

  if (!slide || !verification.ok) {
    // SERVER-SIDE ONLY — the caller still gets a bare `Forbidden` with nothing
    // in it. See `refusalDetail` for why the distinction is worth making.
    console.warn(
      `[thumbnail-source] Refused a render for ${slideId}: ${refusalDetail(slide, verification)}`
    );
    throw renderRefusal();
  }

  const gitOrgLogin = slide.classroom?.git_organization?.login;
  const repo = slide.classroom?.content_repo;
  if (!gitOrgLogin || !repo) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  // skipCache: the render is the point of a save, and the 60s response cache is
  // per-process with no cross-instance invalidation — a cached deck here would
  // freeze the PREVIOUS save's picture under the CURRENT save's sha, and the
  // task's skip-if-unchanged check would then never render it again.
  const loaded = await loadDeck(slide, { skipCache: true });
  const deck = firstSlideOnly(loaded.deck);

  // Pinned to the deck's own visibility, exactly as `deckAccessFor` pins every
  // non-viewer surface. `canEdit: false` is not a formality: `edit` mints
  // `no-store` URLs on a 4h exact TTL, which is the wrong bucket for an image
  // whose whole purpose is to be cached hard once it is committed.
  const deliveryCtx = deckDeliveryContext(slide, gitOrgLogin, repo, {
    canEdit: false,
    isPublic: Boolean(slide.is_public),
  });

  // ── The half of this that is NOT about signatures ──────────────────────────
  // A deck stores its images and its shared-theme links as `/content/{org}/
  // {repo}/…`, and that route resolves the caller's MEMBERSHIP before it fetches
  // a byte. The caller here has no membership and no session — it holds a render
  // token and nothing else. Where the delivery layer is on, every one of those
  // references leaves as a signed URL and the proxy is never asked; where it is
  // off, `deckDeliveryContext` returns null, the references would go out
  // unchanged, and each one would be refused inside the screenshot — an image of
  // a deck with holes where its pictures are.
  //
  // So a null context takes the public CDN tier instead: the same one the proxy
  // itself already prefers for exactly these classrooms, built by the same
  // `getContentUrl`. The alternative was teaching the proxy to accept a render
  // token, which puts a second credential on a session-gated route to save a URL
  // rewrite.
  const signedThemeUrls = await resolveDeliveryThemeUrls(deck, gitOrgLogin, repo, deliveryCtx);
  const themeUrls = deliveryCtx
    ? signedThemeUrls
    : publicDeckThemeUrls(signedThemeUrls, gitOrgLogin, repo);

  const generated = generateDeckHtml(deck, {
    title: slide.title,
    themeUrls,
    // Speaker notes never reach the screenshot service. Not stripped after the
    // fact — never emitted.
    includeNotes: false,
  });

  const html =
    (deliveryCtx
      ? await resolveDeckAssets(generated, deliveryCtx)
      : await resolveDeckAssetsPublic(generated, gitOrgLogin, repo)) ?? generated;

  return new Response(withReadinessMarker(html), { headers: RENDER_HEADERS });
};
