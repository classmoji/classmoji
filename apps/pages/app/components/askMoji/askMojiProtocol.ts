/**
 * Ask Moji host: the pure half of hosting the webapp's Ask Moji panel in this
 * app.
 *
 * The panel itself lives only in the webapp, at
 * `${WEBAPP_URL}/ask-moji/<classroomSlug>/embed`. This app frames it and talks
 * to it over postMessage. Everything here is a plain function of its
 * arguments, so the decisions that are easy to get subtly wrong are testable
 * without a browser or a database:
 *   1. who sees the launcher (`askMojiHostDecision`);
 *   2. what URL the frame loads (`askMojiEmbedUrl`);
 *   3. which window messages the host believes (`readAskMojiMessage`);
 *   4. what the frame is told the reader is looking at (`pageViewing`,
 *      `viewingMessage`).
 *
 * The slides app keeps its own copy of this module (no cross-app imports).
 *
 * THE PROTOCOL. Messages are plain objects.
 *   host → frame, posted to the frame's window with targetOrigin = the webapp
 *   origin:
 *     { type: 'askmoji:viewing', viewing, title? }
 *                                            viewing: {kind:'page', id} | null;
 *                                            title: the page's, for the chip
 *     { type: 'askmoji:open' }
 *     { type: 'askmoji:close' }
 *   frame → host, believed only from the webapp origin AND our own frame:
 *     { type: 'askmoji:ready' }              → host re-sends viewing + open/close
 *     { type: 'askmoji:request-close' }      → host closes the panel
 *     { type: 'askmoji:busy', busy: boolean }→ a dot on the launcher
 *
 * `viewing` is a hint. The webapp resolves and checks it on its own server.
 * `title` labels the frame's "Viewing" chip and nothing else; the frame takes
 * a string of at most `MAX_TITLE_CHARS` and drops anything else.
 */

export const ASKMOJI_VIEWING = 'askmoji:viewing';
export const ASKMOJI_OPEN = 'askmoji:open';
export const ASKMOJI_CLOSE = 'askmoji:close';
export const ASKMOJI_READY = 'askmoji:ready';
export const ASKMOJI_REQUEST_CLOSE = 'askmoji:request-close';
export const ASKMOJI_BUSY = 'askmoji:busy';

/** The attribute on the launcher and the panel container. */
export const ASKMOJI_ATTR = 'data-askmoji';

/** What the reader has open. Null: nothing in particular (the page list). */
export type AskMojiViewing = { kind: 'page'; id: string } | null;

/** The longest title the frame takes (it drops a longer one). */
export const MAX_TITLE_CHARS = 200;

export type AskMojiHostMessage =
  | { type: typeof ASKMOJI_VIEWING; viewing: AskMojiViewing; title?: string }
  | { type: typeof ASKMOJI_OPEN }
  | { type: typeof ASKMOJI_CLOSE };

export type AskMojiFrameMessage =
  | { type: typeof ASKMOJI_READY }
  | { type: typeof ASKMOJI_REQUEST_CLOSE }
  | { type: typeof ASKMOJI_BUSY; busy: boolean };

/** The origin half of a configured URL, or null when it is missing or unusable. */
export function originOf(rawUrl: string | null | undefined): string | null {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The frame's src. `parentOrigin` is this document's own origin, passed so the
 * embed knows where to post back; the embed checks it against its own
 * configuration (PAGES_URL / SLIDES_URL) and treats it as a claim only.
 */
export function askMojiEmbedUrl(
  webappOrigin: string,
  classroomSlug: string,
  parentOrigin?: string | null
): string {
  const base = `${webappOrigin}/ask-moji/${encodeURIComponent(classroomSlug)}/embed`;
  if (!parentOrigin) return base;
  return `${base}?${new URLSearchParams({ parentOrigin })}`;
}

/** The viewing for a page route: the page on screen, or null on the page list. */
export function pageViewing(pageId: string | null | undefined): AskMojiViewing {
  return typeof pageId === 'string' && pageId ? { kind: 'page', id: pageId } : null;
}

/**
 * The page title for the chip, from the layout's page list (loader data):
 * trimmed and cut to MAX_TITLE_CHARS, or undefined when there is none.
 */
export function pageTitle(
  pageId: string | null | undefined,
  pages: readonly { id: string; title?: string | null }[]
): string | undefined {
  if (!pageId) return undefined;
  const title = pages.find(p => p.id === pageId)?.title?.trim();
  return title ? title.slice(0, MAX_TITLE_CHARS) : undefined;
}

/** The viewing message: the title only with a viewing, and only when there is one. */
export function viewingMessage(viewing: AskMojiViewing, title?: string | null): AskMojiHostMessage {
  const t = title?.trim().slice(0, MAX_TITLE_CHARS);
  return viewing && t
    ? { type: ASKMOJI_VIEWING, viewing, title: t }
    : { type: ASKMOJI_VIEWING, viewing };
}

/** Structural check: the wire format is untrusted even after origin and source match. */
function parseFrameMessage(data: unknown): AskMojiFrameMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  switch (raw.type) {
    case ASKMOJI_READY:
      return { type: ASKMOJI_READY };
    case ASKMOJI_REQUEST_CLOSE:
      return { type: ASKMOJI_REQUEST_CLOSE };
    case ASKMOJI_BUSY:
      return typeof raw.busy === 'boolean' ? { type: ASKMOJI_BUSY, busy: raw.busy } : null;
    default:
      return null;
  }
}

/**
 * Accept a window message only if it came from the webapp origin, from the
 * frame this host created, and has a known shape.
 *
 *  - `origin` stops any other site in any other frame;
 *  - `source` stops another window on the webapp origin (a second tab, a
 *    different frame) from driving this panel. Unlike the page reader's check,
 *    the frame window is REQUIRED: before the frame exists nothing is believed.
 */
export function readAskMojiMessage(
  event: { origin: string; data: unknown; source?: unknown },
  { webappOrigin, frameWindow }: { webappOrigin: string | null; frameWindow: unknown }
): AskMojiFrameMessage | null {
  if (!webappOrigin || event.origin !== webappOrigin) return null;
  if (!frameWindow || event.source !== frameWindow) return null;
  return parseFrameMessage(event.data);
}

/** The messages that bring a (re)loaded frame up to date: viewing, then open/close. */
export function syncMessages(
  viewing: AskMojiViewing,
  open: boolean,
  title?: string | null
): AskMojiHostMessage[] {
  return [viewingMessage(viewing, title), { type: open ? ASKMOJI_OPEN : ASKMOJI_CLOSE }];
}

/** Whether a DOM event started on the launcher or inside the panel container. */
export function isAskMojiTarget(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === 'function' && Boolean(el.closest(`[${ASKMOJI_ATTR}]`));
}

/**
 * Who gets the launcher, decided on the server from facts the server derived.
 *
 * Every condition must hold: an ACCEPTED member of this classroom, Ask Moji
 * switched on for it, the Trigger runtime selected (`triggerRuntime`: the
 * shared `isAskMojiTriggerRuntime()` parse, read by the server module), a
 * usable webapp origin, and not inside the webapp's own reader frame (it
 * shows its own panel). This is for the UI only; the embed route enforces
 * the real gates.
 */
export function askMojiHostDecision({
  acceptedRole,
  botEnabled,
  triggerRuntime,
  webappUrl,
  embedded,
}: {
  acceptedRole: string | null | undefined;
  botEnabled: boolean | null | undefined;
  triggerRuntime: boolean;
  webappUrl: string | null | undefined;
  embedded: boolean;
}): { enabled: boolean; origin: string | null } {
  const origin = originOf(webappUrl);
  const enabled =
    !embedded && triggerRuntime && Boolean(origin) && Boolean(acceptedRole) && botEnabled === true;
  return enabled ? { enabled: true, origin } : { enabled: false, origin: null };
}
