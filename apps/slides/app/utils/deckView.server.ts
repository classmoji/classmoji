/**
 * deckView.server.ts — the document behind `/:slideId/render-view`.
 *
 * The MCP's `deck_render` tool points a headless browser here so an agent that
 * edits a deck blind can SEE it: the real reveal.js deck (theme, custom CSS,
 * fonts, all fragments shown), read from the copy the agent asked for —
 * the LIVE collab document when the classroom edits live, git main otherwise,
 * or the pending preview branch — plus a small window API the driver calls to
 * step to a slide, wait for its images and measure how far its content runs
 * past the deck's logical size.
 *
 * Authorised by a view token in the `cm_view` cookie and nothing else (same
 * reasoning as `$slideId_.thumbnail-source`): one deck, one target (`at:pin`),
 * one host, 120 seconds. Speaker notes are never emitted. Assets are signed at
 * the deck's own visibility tier, or rewritten to the public CDN where the
 * delivery layer cannot serve the classroom — exactly the thumbnail's rules.
 */

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import {
  generateDeckHtml,
  isDeckSlide,
  loadDeck,
  previewBranchName,
  type DeckJson,
} from '@classmoji/services/slides';
import {
  DEFAULT_DECK_HEIGHT,
  DEFAULT_DECK_WIDTH,
  VIEW_API_GLOBAL,
  VIEW_HEADERS,
  VIEW_META_ELEMENT_ID,
  VIEW_READY_ATTRIBUTE,
  parseViewQuery,
  viewTarget,
  viewTokenFromCookies,
  type DeckViewMeta,
} from '@classmoji/services/render-contract';
import { verifyDocViewToken } from '@classmoji/services/render-token';
import { CollabRequestError } from './collab/env.server.ts';
import { fetchLiveDeck, liveEditingEnv } from './collab/collab.server.ts';
import {
  deckDeliveryContext,
  publicDeckThemeUrls,
  resolveDeckAssets,
  resolveDeckAssetsPublic,
  resolveDeliveryThemeUrls,
} from './deckDelivery.server.ts';

const HTML_HEADERS = { ...VIEW_HEADERS, 'Content-Type': 'text/html; charset=utf-8' };

/** The ONE refusal: unknown deck, bad token and missing content look identical. */
export function viewRefusal(): Response {
  return new Response('Forbidden', { status: 403, headers: HTML_HEADERS });
}

/**
 * Sequential ids for legacy (index.html-parsed) decks, matching the MCP's
 * `legacyIdGen` so the ids an agent read from deck_outline are the ids here.
 */
function legacyIdGen(): () => string {
  let n = 0;
  return () => `s${++n}`;
}

/** Load the copy of the deck the request names, with the version rendered. */
async function loadViewDeck(
  slide: Parameters<typeof loadDeck>[0] & { id: string; content_path: string; classroom: unknown },
  at: 'main' | 'preview'
): Promise<{ deck: DeckJson; version: string } | null> {
  if (at === 'main') {
    const env = liveEditingEnv(slide.classroom);
    if (env) {
      try {
        const snapshot = await fetchLiveDeck(env, slide.id);
        return { deck: snapshot.content, version: `live:${snapshot.epoch}.${snapshot.version}` };
      } catch (error) {
        // Unreachable or a deck the live service cannot hold: git answers, as
        // it does for the MCP's own reads.
        if (!(error instanceof CollabRequestError)) throw error;
        console.warn(`[render-view] live deck unavailable for ${slide.id}: ${error.message}`);
      }
    }
  }
  try {
    const loaded = await loadDeck(slide, {
      skipCache: true,
      ...(at === 'preview' ? { ref: previewBranchName(slide.content_path) } : {}),
      parseOptions: { idGen: legacyIdGen() },
    });
    return { deck: loaded.deck, version: loaded.sha ?? 'unknown' };
  } catch (error) {
    console.warn(
      `[render-view] could not load ${at} for ${slide.id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** Every slide id with its Reveal indices and outline index ('4', '4.2'). */
export function deckViewSlides(deck: DeckJson): DeckViewMeta['slides'] {
  const out: DeckViewMeta['slides'] = [];
  deck.slides.forEach((slide, h) => {
    out.push({ id: slide.id, index: String(h + 1), h, v: 0 });
    (slide.children ?? []).forEach((child, v) => {
      out.push({ id: child.id, index: `${h + 1}.${v + 1}`, h, v });
    });
  });
  return out;
}

/** `</script>` can't appear inside the JSON blob. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The driver API, as an inline script after the deck's own Reveal.initialize.
 *
 *   window.__cmView.show(id) → Promise<SlideMeasure | {error}>
 *     go to the slide (a stack id shows its first child), reveal every
 *     fragment, wait for its images (capped), lay out, and measure.
 *
 * Measurement is in the deck's LOGICAL px: element and text-node rects
 * relative to `.slides`, divided by the rendered scale. A box that scrolls or
 * clips (overflow ≠ visible) counts by its own rect, and what it hides is
 * reported separately as `clipped`.
 */
export function viewScript(): string {
  return `
<style>
  .reveal .controls, .reveal .progress, .reveal .slide-number { display: none !important; }
  html, body { margin: 0; overflow: hidden; }
  /* A still frame: every transition and animation jumps to its end state, so
     a slide caught mid-transition (a per-slide data-transition) is never
     photographed or measured half-way in. */
  .reveal *, .reveal *::before, .reveal *::after {
    transition-duration: 0s !important; transition-delay: 0s !important;
    animation-duration: 0s !important; animation-delay: 0s !important;
  }
</style>
<script>
(function () {
  var META = JSON.parse(document.getElementById(${JSON.stringify(VIEW_META_ELEMENT_ID)}).textContent);
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function frames() { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); }
  function describe(el, text) {
    var tag = (el.tagName || '').toLowerCase();
    var cls = (el.getAttribute && el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean)[0];
    var t = (text != null ? text : (el.textContent || '')).replace(/\\s+/g, ' ').trim();
    if (t.length > 40) t = t.slice(0, 39) + '\\u2026';
    return tag + (cls ? '.' + cls : '') + (t ? ' "' + t + '"' : '');
  }
  function settleImages(root, capMs) {
    var pending = [];
    root.querySelectorAll('img').forEach(function (img) {
      if (img.complete) return;
      pending.push(new Promise(function (r) {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      }));
    });
    var bg = root.getAttribute('data-background-image') || root.getAttribute('data-background');
    if (bg && !/^(#|rgb|hsl)/i.test(bg)) {
      pending.push(new Promise(function (r) { var i = new Image(); i.onload = r; i.onerror = r; i.src = bg; }));
    }
    if (document.fonts && document.fonts.ready) pending.push(document.fonts.ready.catch(function () {}));
    return Promise.race([Promise.all(pending), sleep(capMs)]);
  }
  function measure(target, entry) {
    var slides = document.querySelector('.reveal .slides');
    var box = slides.getBoundingClientRect();
    var scale = box.width / META.width || 1;
    var ext = { top: 0, right: META.width, bottom: META.height, left: 0 };
    var who = { top: null, right: null, bottom: null, left: null };
    var clipped = [];
    function take(rect, label) {
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      var l = (rect.left - box.left) / scale, t = (rect.top - box.top) / scale;
      var r = (rect.right - box.left) / scale, b = (rect.bottom - box.top) / scale;
      if (l < ext.left) { ext.left = l; who.left = label; }
      if (t < ext.top) { ext.top = t; who.top = label; }
      if (r > ext.right) { ext.right = r; who.right = label; }
      if (b > ext.bottom) { ext.bottom = b; who.bottom = label; }
    }
    function walk(el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
      if (el.matches('aside.notes, script, style, template')) return;
      take(el.getBoundingClientRect(), function () { return describe(el); });
      var clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (clips) {
        var hx = Math.max(0, el.scrollWidth - el.clientWidth), hy = Math.max(0, el.scrollHeight - el.clientHeight);
        if (hx > 1 || hy > 1) clipped.push({ element: describe(el), hidden_px: { x: Math.round(hx), y: Math.round(hy) } });
        return;
      }
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) walk(n);
        else if (n.nodeType === 3 && n.textContent.trim()) {
          var range = document.createRange();
          range.selectNodeContents(n);
          var rects = range.getClientRects();
          // A glyph box is taller than its line when line-height < the font's
          // ascent + descent (Reveal's headings): trim it to the line box, or
          // every heading at the top of a slide "overflows" by a few px.
          var lh = parseFloat(cs.lineHeight) * scale;
          for (var i = 0; i < rects.length; i++) {
            var rc = rects[i], inset = lh && rc.height > lh ? (rc.height - lh) / 2 : 0;
            (function (node, rect) {
              take(rect, function () { return describe(node.parentElement, node.textContent); });
            })(n, { left: rc.left, right: rc.right, width: rc.width, height: rc.height - 2 * inset, top: rc.top + inset, bottom: rc.bottom - inset });
          }
        }
      }
    }
    for (var c = target.firstElementChild; c; c = c.nextElementSibling) walk(c);
    var over = {
      top: Math.max(0, Math.round(-ext.top)),
      right: Math.max(0, Math.round(ext.right - META.width)),
      bottom: Math.max(0, Math.round(ext.bottom - META.height)),
      left: Math.max(0, Math.round(-ext.left)),
    };
    var worst = null, most = 2;
    ['top', 'right', 'bottom', 'left'].forEach(function (side) { if (over[side] <= 2) over[side] = 0; });
    ['bottom', 'right', 'left', 'top'].forEach(function (side) {
      if (over[side] > most && who[side]) { most = over[side]; worst = who[side]; }
    });
    var out = { id: entry.id, index: entry.index, overflow_px: over };
    if (worst) out.element = worst();
    if (clipped.length) out.clipped = clipped.slice(0, 5);
    return out;
  }
  var byId = {};
  META.slides.forEach(function (s) { byId[s.id] = s; });
  function show(id) {
    var entry = byId[id];
    if (!entry) return Promise.resolve({ error: 'unknown-slide', id: id });
    var sec = document.querySelector('.reveal .slides section[data-cm-id="' + CSS.escape(id) + '"]');
    if (!sec) return Promise.resolve({ error: 'unknown-slide', id: id });
    var target = sec.querySelector(':scope > section') || sec;
    var idx = Reveal.getIndices(target);
    Reveal.slide(idx.h, idx.v || 0);
    target.querySelectorAll('.fragment').forEach(function (f) { f.classList.add('visible'); f.classList.remove('current-fragment'); });
    return settleImages(target, 4000).then(function () {
      Reveal.layout();
      return frames();
    }).then(function () { return measure(target, entry); });
  }
  function measureAll() {
    var out = [];
    return META.slides.reduce(function (p, s) {
      return p.then(function () { return show(s.id).then(function (m) { out.push(m); }); });
    }, Promise.resolve()).then(function () { return out; });
  }
  function ready() {
    document.querySelectorAll('.reveal [data-transition], .reveal [data-background-transition], .reveal [data-auto-animate]').forEach(function (el) {
      el.removeAttribute('data-transition');
      el.removeAttribute('data-background-transition');
      el.removeAttribute('data-auto-animate');
    });
    Reveal.configure({
      transition: 'none', backgroundTransition: 'none', controls: false, progress: false,
      slideNumber: false, hash: false, history: false, keyboard: false, touch: false,
      margin: 0, fragments: false, autoAnimate: false, autoSlide: 0, viewDistance: 2,
    });
    window[${JSON.stringify(VIEW_API_GLOBAL)}] = { meta: META, show: show, measureAll: measureAll };
    frames().then(function () { document.documentElement.setAttribute(${JSON.stringify(VIEW_READY_ATTRIBUTE)}, ''); });
  }
  function boot() {
    if (!window.Reveal) return;
    if (Reveal.isReady && Reveal.isReady()) ready();
    else Reveal.on('ready', ready);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>`;
}

/** Splice the meta blob + driver script in before `</body>`. */
function withViewScript(html: string, meta: DeckViewMeta): string {
  const block = `<script type="application/json" id="${VIEW_META_ELEMENT_ID}">${jsonForScript(meta)}</script>\n${viewScript()}`;
  const at = html.lastIndexOf('</body>');
  return at === -1 ? `${html}\n${block}` : `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

export async function deckViewLoader({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}): Promise<Response> {
  const { slideId } = params;
  const url = new URL(request.url);
  const query = parseViewQuery(url);
  if (!slideId || !query) throw viewRefusal();

  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });

  const verification = slide
    ? await verifyDocViewToken(viewTokenFromCookies(request.headers.get('cookie')), {
        origin: url.origin,
        classroomId: slide.classroom_id,
        kind: 'deck',
        docId: slide.id,
        target: viewTarget(query.at, query.pin),
        keyVersion: slide.classroom?.content_key_version,
      })
    : ({ ok: false, reason: 'malformed' } as const);

  if (!slide || !verification.ok || !isDeckSlide(slide)) {
    console.warn(
      `[render-view] Refused a render for ${slideId}: ${
        !slide ? 'unknown-slide' : !verification.ok ? verification.reason : 'not a deck'
      }`
    );
    throw viewRefusal();
  }

  const gitOrgLogin = slide.classroom?.git_organization?.login;
  const repo = slide.classroom?.content_repo;
  if (!gitOrgLogin || !repo) throw viewRefusal();

  const loaded = await loadViewDeck(slide as never, query.at);
  if (!loaded) throw viewRefusal();
  const { deck, version } = loaded;

  const deliveryCtx = ClassmojiService.contentDelivery.canDeliverContent(slide.classroom)
    ? deckDeliveryContext(slide, gitOrgLogin, repo, {
        canEdit: false,
        isPublic: Boolean(slide.is_public),
      })
    : null;
  const signedThemeUrls = await resolveDeliveryThemeUrls(deck, gitOrgLogin, repo, deliveryCtx);
  const themeUrls = deliveryCtx
    ? signedThemeUrls
    : publicDeckThemeUrls(signedThemeUrls, gitOrgLogin, repo);

  const generated = generateDeckHtml(deck, { title: slide.title, themeUrls, includeNotes: false });
  const html =
    (deliveryCtx
      ? await resolveDeckAssets(generated, deliveryCtx)
      : await resolveDeckAssetsPublic(generated, gitOrgLogin, repo, slide.classroom_id)) ??
    generated;

  const meta: DeckViewMeta = {
    kind: 'deck',
    version,
    width: Number(deck.config?.width) || DEFAULT_DECK_WIDTH,
    height: Number(deck.config?.height) || DEFAULT_DECK_HEIGHT,
    slides: deckViewSlides(deck),
  };

  return new Response(withViewScript(html, meta), { headers: HTML_HEADERS });
}
