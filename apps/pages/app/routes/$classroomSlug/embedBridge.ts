/**
 * The embed bridge: how a page rendered inside the webapp's reader tells its
 * host where it just went.
 *
 * The webapp frames this app (`?embed=true`) for the peek drawer and the docked
 * Pages view. Those panels show a header title and an "open on the site" button
 * that must follow the reader as they click through the authored page
 * directory — but the frame is cross-origin, so the only channel is
 * postMessage, and postMessage without a concrete `targetOrigin` broadcasts to
 * whoever happens to be embedding.
 *
 * WHERE THE TARGET ORIGIN COMES FROM — the decision worth reading twice.
 * The embed URL carries `?parentOrigin=`, but that is a CLAIM by whoever built
 * the URL, and anyone can frame this app with any query string they like. So it
 * is treated as an assertion to check, never as the answer: the authority is
 * WEBAPP_URL, this app's own server configuration.
 *
 *   - no WEBAPP_URL configured → the bridge is inert (no messages at all);
 *   - parentOrigin absent      → post to the configured webapp origin;
 *   - parentOrigin matches     → same thing, now corroborated;
 *   - parentOrigin differs     → post NOTHING. Someone is framing us and
 *                                claiming to be an origin we are not deployed
 *                                against; the honest response is silence.
 *
 * The alternative — trusting the param behind a "looks like localhost or our
 * base domain" allowlist — would have to guess at what counts as ours, and
 * every such guess is one hostname registration away from being wrong.
 * document.referrer is worse still: it is empty under common referrer policies
 * and degrades to this app's own origin after any in-frame navigation.
 */

export const PAGE_NAV_MESSAGE = 'classmoji:page-nav';
export const PAGE_ESC_MESSAGE = 'classmoji:page-esc';

export interface EmbedNavMessage {
  type: typeof PAGE_NAV_MESSAGE;
  classroomSlug: string;
  pageId: string;
  pageSlug: string | null;
  title: string;
}

/** Origin half of a URL, or null when it is missing/unparseable. */
function originOf(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The one origin this document may postMessage to, or null to stay silent.
 *
 * Pure: the caller passes the request's `parentOrigin` param and the server's
 * WEBAPP_URL, so the whole decision is testable without a browser.
 */
export function resolveEmbedParentOrigin({
  isEmbedded,
  parentOriginParam,
  webappUrl,
}: {
  isEmbedded: boolean;
  parentOriginParam?: string | null;
  webappUrl?: string | null;
}): string | null {
  if (!isEmbedded) return null;

  const authority = originOf(webappUrl);
  if (!authority) return null;

  const claimed = originOf(parentOriginParam);
  if (claimed && claimed !== authority) return null;

  return authority;
}

/** The nav ping for the page currently on screen. */
export function buildNavMessage({
  classroomSlug,
  page,
}: {
  classroomSlug: string;
  page: { id: string; title?: string | null; slug?: string | null };
}): EmbedNavMessage {
  return {
    type: PAGE_NAV_MESSAGE,
    classroomSlug,
    pageId: page.id,
    pageSlug: page.slug ?? null,
    title: page.title ?? '',
  };
}

/**
 * Resolve a NavGrid page anchor to the URL this embedded document should go to.
 *
 * NavGridStatic emits `href="#"` + `data-page-id` and leaves resolution to its
 * consumer (that is the documented export contract — see NavGridBlock). The
 * class-site renderer is one consumer; the embedded reader is the other, and
 * without this the authored hub — the thing the docked Pages view exists to
 * show — would be a grid of dead links.
 *
 * Returns null when the element is not a page anchor, so ordinary links and
 * external entries are left completely alone.
 */
export function resolveNavGridHref(
  anchor: { getAttribute: (name: string) => string | null } | null,
  classroomSlug: string
): string | null {
  if (!anchor) return null;
  if (anchor.getAttribute('data-kind') !== 'page') return null;
  const pageId = anchor.getAttribute('data-page-id');
  if (!pageId) return null;
  return `/${encodeURIComponent(classroomSlug)}/${encodeURIComponent(pageId)}?embed=true`;
}
