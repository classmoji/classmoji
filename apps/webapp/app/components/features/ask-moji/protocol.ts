/**
 * The frame side of the Ask Moji embed protocol (the host side is
 * apps/pages and apps/slides `components/askMoji/askMojiProtocol.ts`).
 *
 *   host → frame   { type: 'askmoji:viewing', viewing, title? }
 *                                             viewing or null; title: the
 *                                             page or deck title, for the
 *                                             chip only
 *                  { type: 'askmoji:open' }
 *                  { type: 'askmoji:close' }
 *   frame → host   { type: 'askmoji:ready' }              after the listener is installed
 *                  { type: 'askmoji:request-close' }
 *                  { type: 'askmoji:busy', busy }
 *
 * The host is never trusted: a message is believed only when it comes from
 * the parent window, from the parent origin the embed route checked against
 * PAGES_URL / SLIDES_URL, with a known shape; `viewing` is a hint the server
 * resolves and checks. `title` is a string of at most
 * `MAX_HOST_TITLE_CHARS` (anything else is dropped, not the message) and is
 * only ever the chip's label: it never goes on a message or to the server.
 * Pure functions, so the rules are testable without a browser.
 */
import { MAX_SLIDE_INDEX, VIEWING_KINDS } from '@classmoji/utils/ask-moji';

export const ASKMOJI_VIEWING = 'askmoji:viewing';
export const ASKMOJI_OPEN = 'askmoji:open';
export const ASKMOJI_CLOSE = 'askmoji:close';
export const ASKMOJI_READY = 'askmoji:ready';
export const ASKMOJI_REQUEST_CLOSE = 'askmoji:request-close';
export const ASKMOJI_BUSY = 'askmoji:busy';

export type EmbedViewing = {
  kind: (typeof VIEWING_KINDS)[number];
  id?: string;
  slide?: number;
};

/** The longest host title the embed shows on the chip. */
export const MAX_HOST_TITLE_CHARS = 200;

export type AskMojiHostMessage =
  | { type: typeof ASKMOJI_VIEWING; viewing: EmbedViewing | null; title?: string }
  | { type: typeof ASKMOJI_OPEN }
  | { type: typeof ASKMOJI_CLOSE };

export type AskMojiFrameMessage =
  | { type: typeof ASKMOJI_READY }
  | { type: typeof ASKMOJI_REQUEST_CLOSE }
  | { type: typeof ASKMOJI_BUSY; busy: boolean };

/** The origin of a URL, or null when it is missing or not http(s). */
export function originOf(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The origins allowed to frame the embed: the pages and slides apps, nothing else. */
export function allowedParentOrigins(urls: {
  pagesUrl?: string | null;
  slidesUrl?: string | null;
}): string[] {
  const out: string[] = [];
  for (const raw of [urls.pagesUrl, urls.slidesUrl]) {
    const origin = originOf(raw);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The `parentOrigin` query parameter, only when it is exactly one of the
 * allowed origins (a claim the route checks; the browser's `frame-ancestors`
 * enforces who may frame at all). Anything else is null: the embed then
 * posts nothing.
 */
export function checkedParentOrigin(
  claimed: string | null | undefined,
  allowed: readonly string[]
): string | null {
  if (typeof claimed !== 'string' || !claimed) return null;
  const origin = originOf(claimed);
  return origin && origin === claimed && allowed.includes(origin) ? origin : null;
}

/** The `frame-ancestors` directive for the embed. With no allowed origin, none. */
export function frameAncestors(allowed: readonly string[]): string {
  return `frame-ancestors ${allowed.length > 0 ? allowed.join(' ') : "'none'"}`;
}

const parseViewing = (raw: unknown): EmbedViewing | null | undefined => {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (!(VIEWING_KINDS as readonly unknown[]).includes(v.kind)) return undefined;
  const out: EmbedViewing = { kind: v.kind as EmbedViewing['kind'] };
  if (v.id !== undefined) {
    if (typeof v.id !== 'string' || !v.id || v.id.length > 128) return undefined;
    out.id = v.id;
  }
  if (v.slide !== undefined) {
    if (
      typeof v.slide !== 'number' ||
      !Number.isInteger(v.slide) ||
      v.slide < 0 ||
      v.slide > MAX_SLIDE_INDEX
    ) {
      return undefined;
    }
    out.slide = v.slide;
  }
  return out;
};

/** A chip title: a non-blank string of at most MAX_HOST_TITLE_CHARS, else none. */
const parseTitle = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || raw.length > MAX_HOST_TITLE_CHARS) return undefined;
  const title = raw.trim();
  return title ? title : undefined;
};

/** Structural check of a host message (untrusted even after origin and source match). */
export function parseHostMessage(data: unknown): AskMojiHostMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  switch (raw.type) {
    case ASKMOJI_OPEN:
      return { type: ASKMOJI_OPEN };
    case ASKMOJI_CLOSE:
      return { type: ASKMOJI_CLOSE };
    case ASKMOJI_VIEWING: {
      const viewing = parseViewing(raw.viewing);
      if (viewing === undefined) return null;
      const title = parseTitle(raw.title);
      return viewing && title
        ? { type: ASKMOJI_VIEWING, viewing, title }
        : { type: ASKMOJI_VIEWING, viewing };
    }
    default:
      return null;
  }
}

/**
 * A window message the embed believes: from `parentOrigin` (already checked),
 * from the parent window itself (not another frame on that origin), with a
 * known shape. Null otherwise.
 */
export function readHostMessage(
  event: { origin: string; data: unknown; source?: unknown },
  { parentOrigin, parentWindow }: { parentOrigin: string | null; parentWindow: unknown }
): AskMojiHostMessage | null {
  if (!parentOrigin || event.origin !== parentOrigin) return null;
  if (!parentWindow || event.source !== parentWindow) return null;
  return parseHostMessage(event.data);
}
