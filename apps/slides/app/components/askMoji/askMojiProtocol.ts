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
 *   4. which slide the frame is told is on screen (`visibleFlatIndex`).
 *
 * The pages app keeps its own copy of this module (no cross-app imports).
 *
 * THE PROTOCOL. Messages are plain objects.
 *   host → frame, posted to the frame's window with targetOrigin = the webapp
 *   origin:
 *     { type: 'askmoji:viewing', viewing, title? }
 *                                            viewing: {kind:'deck', id, slide} | null;
 *                                            title: the deck's, for the chip (the
 *                                            frame adds the slide number)
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
 *
 * THE SLIDE NUMBER. `slide` is one zero-based integer: how many slides come
 * before the current one in reading order, counting the deck as a non-editor
 * sees it (hidden slides removed, by the rule in
 * `@classmoji/services/slides/hidden`). Reading order is horizontal-major: every
 * slide of stack 0, then stack 1, and so on. A stack with vertical children
 * counts each child once and not the stack itself; a top-level slide with no
 * children counts once. So `#/0`, `#/1/0`, `#/1/1`, `#/2` are 0, 1, 2, 3.
 * The editor keeps hidden slides on screen; there the position is first mapped
 * to the viewer's numbering, and a hidden slide counts as the visible slide
 * that takes its place. The present, follow and speaker views use the same
 * numbering.
 */

import {
  toVisibleIndices,
  type SlideIndices,
  type SlideSlot,
} from '@classmoji/services/slides/hidden';

export const ASKMOJI_VIEWING = 'askmoji:viewing';
export const ASKMOJI_OPEN = 'askmoji:open';
export const ASKMOJI_CLOSE = 'askmoji:close';
export const ASKMOJI_READY = 'askmoji:ready';
export const ASKMOJI_REQUEST_CLOSE = 'askmoji:request-close';
export const ASKMOJI_BUSY = 'askmoji:busy';

/** The attribute on the launcher and the panel container. */
export const ASKMOJI_ATTR = 'data-askmoji';

/** What the viewer has open. */
export type AskMojiViewing = { kind: 'deck'; id: string; slide: number } | null;

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

/* ------------------------------------------------------------------ *
 * The slide number
 * ------------------------------------------------------------------ */

const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/**
 * The flat index of `{h, v}` in a deck whose stacks hold `stackSizes` slides
 * each (1 for a slide with no vertical children). Out-of-range positions are
 * clamped into the deck; an empty deck is 0.
 */
export function flatSlideIndex(stackSizes: readonly number[], at: SlideIndices): number {
  if (stackSizes.length === 0) return 0;
  const h = Math.min(whole(at.h), stackSizes.length - 1);
  let before = 0;
  for (let i = 0; i < h; i++) before += Math.max(1, whole(stackSizes[i]));
  const size = Math.max(1, whole(stackSizes[h]));
  return before + Math.min(whole(at.v), size - 1);
}

/** Each visible stack's size, from the hidden-slide rule's layout of the deck on screen. */
export function visibleStackSizes(layout: readonly SlideSlot[]): number[] {
  return layout
    .filter(slot => slot.keep)
    .map(slot => {
      const kept = slot.children.filter(Boolean).length;
      // No children, or every child hidden but the stack kept for its own
      // content: one flat slide.
      return kept === 0 ? 1 : kept;
    });
}

/**
 * The flat index (see THE SLIDE NUMBER above) of Reveal's position `at` in the
 * deck on screen, whose hidden-slide layout is `layout`. In view mode hidden
 * slides are already gone and this is a plain count; in the editor `at` is
 * mapped to the viewer's numbering first.
 */
export function visibleFlatIndex(layout: SlideSlot[], at: SlideIndices): number {
  return flatSlideIndex(visibleStackSizes(layout), toVisibleIndices(layout, at));
}

/** The viewing for a deck route. */
export function deckViewing(deckId: string | null | undefined, slide: number): AskMojiViewing {
  if (typeof deckId !== 'string' || !deckId) return null;
  return { kind: 'deck', id: deckId, slide: whole(slide) };
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/** A title for the chip (the deck's, from loader data): trimmed and cut, or undefined. */
export function chipTitle(raw: string | null | undefined): string | undefined {
  const title = raw?.trim().slice(0, MAX_TITLE_CHARS);
  return title ? title : undefined;
}

/** The viewing message: the title only with a viewing, and only when there is one. */
export function viewingMessage(viewing: AskMojiViewing, title?: string | null): AskMojiHostMessage {
  const t = chipTitle(title);
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
 *  - `origin` stops any other site in any other frame (decks run authored
 *    content, so this document has frames of its own);
 *  - `source` stops another window on the webapp origin from driving this
 *    panel. The frame window is REQUIRED: before the frame exists nothing is
 *    believed.
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

/**
 * Whether a DOM event started on the launcher or inside the panel container.
 * Every deck keyboard and click handler in this app ignores such events, so
 * pressing Space on the launcher never turns the slide.
 */
export function isAskMojiTarget(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === 'function' && Boolean(el.closest(`[${ASKMOJI_ATTR}]`));
}

/* ------------------------------------------------------------------ *
 * Who gets the launcher
 * ------------------------------------------------------------------ */

/**
 * How `assertSlideAccess` let this viewer in. Public and share-code access
 * never get the launcher, even for a member.
 */
export type SlideAccessVia =
  | 'public'
  | 'membership'
  | 'role'
  | 'ownership'
  | 'team_edit'
  | 'shareCode'
  | null;

/**
 * Who gets the launcher, decided on the server from facts the server derived.
 *
 * Every condition must hold: let in as a member of the deck's classroom (not
 * as the public or through a share code), an ACCEPTED member of it, Ask Moji
 * switched on for the classroom, the Trigger runtime selected
 * (`triggerRuntime`: the shared `isAskMojiTriggerRuntime()` parse, read by the
 * server module), and a usable webapp origin. This is for the UI only; the
 * embed route enforces the real gates.
 */
export function askMojiHostDecision({
  via,
  acceptedRole,
  botEnabled,
  triggerRuntime,
  webappUrl,
}: {
  via: SlideAccessVia | undefined;
  acceptedRole: string | null | undefined;
  botEnabled: boolean | null | undefined;
  triggerRuntime: boolean;
  webappUrl: string | null | undefined;
}): { enabled: boolean; origin: string | null } {
  const origin = originOf(webappUrl);
  const memberAccess =
    via === 'membership' || via === 'role' || via === 'ownership' || via === 'team_edit';
  const enabled =
    memberAccess &&
    triggerRuntime &&
    Boolean(origin) &&
    Boolean(acceptedRole) &&
    botEnabled === true;
  return enabled ? { enabled: true, origin } : { enabled: false, origin: null };
}
