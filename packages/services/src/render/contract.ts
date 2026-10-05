/**
 * render/contract.ts — what the MCP's render driver and the two token-gated
 * render routes (slides `/:slideId/render-view`, pages `/_render/page/:pageId`)
 * must agree on. PURE: no Node, no services barrel — the routes import it.
 *
 * An agent editing a deck or page through the MCP cannot see it. `deck_render`
 * / `page_render` point a headless browser at these routes, which render the
 * REAL document (live collab doc, git main, or the pending preview) and expose
 * a small window API the driver calls to step through slides and read
 * measurements. The token travels in a host-scoped cookie, as the thumbnail
 * render token does (see deckThumbnail.contract.ts for why never a header or
 * a query param).
 */

/** The cookie the view token travels in. Not `cm_render`: a different token. */
export const VIEW_TOKEN_COOKIE = 'cm_view';

/** Raised on <html> once the document has laid out and the API is ready. */
export const VIEW_READY_ATTRIBUTE = 'data-render-ready';
export const VIEW_READY_SELECTOR = `[${VIEW_READY_ATTRIBUTE}]`;

/** `window[VIEW_API_GLOBAL]` — the deck route's driver API (see deck route). */
export const VIEW_API_GLOBAL = '__cmView';

/** `<script type="application/json" id=…>` carrying what the route rendered. */
export const VIEW_META_ELEMENT_ID = 'cm-view-meta';

/** Which copy of the document: main (the live doc when live editing is on) or the preview. */
export type ViewAt = 'main' | 'preview';

/** Reveal's own default logical size, used when a deck sets none. */
export const DEFAULT_DECK_WIDTH = 960;
export const DEFAULT_DECK_HEIGHT = 700;

/**
 * The token's target string: `at:pin`. `pin` is the version the caller read
 * (`live:3.12`, a blob sha) or `head` when it read none.
 */
export function viewTarget(at: ViewAt, pin: string | null | undefined): string {
  return `${at}:${pin || 'head'}`;
}

function base(origin: string): string {
  return origin.replace(/\/+$/, '');
}

function query(at: ViewAt, pin: string | null | undefined): string {
  const params = new URLSearchParams({ at, pin: pin || 'head' });
  return params.toString();
}

/** The deck render page. No credential in it — see VIEW_TOKEN_COOKIE. */
export function deckViewUrl(
  origin: string,
  slideId: string,
  at: ViewAt,
  pin?: string | null
): string {
  return `${base(origin)}/${slideId}/render-view?${query(at, pin)}`;
}

/** The page render page. */
export function pageViewUrl(
  origin: string,
  pageId: string,
  at: ViewAt,
  pin?: string | null
): string {
  return `${base(origin)}/_render/page/${pageId}?${query(at, pin)}`;
}

/** Parse `?at=&pin=` the way the routes must: anything unknown is null. */
export function parseViewQuery(url: URL): { at: ViewAt; pin: string } | null {
  const at = url.searchParams.get('at');
  const pin = url.searchParams.get('pin');
  if ((at !== 'main' && at !== 'preview') || !pin || !/^[A-Za-z0-9:._-]{1,100}$/.test(pin)) {
    return null;
  }
  return { at, pin };
}

/** Playwright's `addCookies` shape. */
export interface ViewTokenCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict';
}

/**
 * The one cookie the render browser carries. `secure` follows the origin's
 * scheme: a dev origin like `http://100.x.y.z:6510` is not a trustworthy
 * origin, so Chrome would silently drop a Secure cookie there.
 */
export function viewTokenCookie(origin: string, token: string): ViewTokenCookie {
  const url = new URL(origin);
  return {
    name: VIEW_TOKEN_COOKIE,
    value: token,
    domain: url.hostname,
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'Strict',
  };
}

/** Pull `cm_view` out of a Cookie header. Nothing else, and no session code. */
export function viewTokenFromCookies(header: string | null): string | null {
  if (!header) return null;
  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');
    if (at === -1 || pair.slice(0, at).trim() !== VIEW_TOKEN_COOKIE) continue;
    const raw = pair.slice(at + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Headers for both render routes: never cached, indexed or framed. */
export const VIEW_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// ─── What the deck page reports back ────────────────────────────────────────

/** Logical px a slide's content extends past its box, per side (0 = fits). */
export interface OverflowPx {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One slide's measurement, in the deck's logical px. */
export interface SlideMeasure {
  id: string;
  /** '4' or '4.2' (vertical stack child). */
  index: string;
  overflow_px: OverflowPx;
  /** The element (or text) reaching furthest out: `tag.class "text…"`. */
  element?: string;
  /** Scroll boxes (code blocks, overflow:hidden) hiding content: px hidden per axis. */
  clipped?: Array<{ element: string; hidden_px: { x: number; y: number } }>;
}

/** The meta blob the deck page carries. */
export interface DeckViewMeta {
  kind: 'deck';
  /** What was actually rendered: `live:E.V`, a blob sha, … */
  version: string;
  width: number;
  height: number;
  slides: Array<{ id: string; index: string; h: number; v: number }>;
}

/** The meta blob the page page carries. */
export interface PageViewMeta {
  kind: 'page';
  version: string;
}
