/**
 * Pure link + postMessage logic for the in-app page reader (Option C).
 *
 * Everything in this file is a plain function of its arguments so the three
 * decisions that are easy to get subtly wrong are unit-testable without a
 * browser:
 *   1. where the ↗ button points (class site vs in-app full view);
 *   2. what URL the panel iframes;
 *   3. which window messages the panel is allowed to believe.
 *
 * (3) is the security-relevant one. The panel updates its own header and its
 * ↗ target from messages the embedded document sends, so an unchecked
 * `message` listener would let ANY page in ANY frame retitle the drawer and
 * repoint its outbound link.
 */

/** The nav ping the embedded pages app sends on every route change. */
export interface PageNavMessage {
  type: 'classmoji:page-nav';
  classroomSlug: string;
  pageId: string;
  pageSlug: string | null;
  title: string;
}

/** Escape pressed while focus was inside the iframe. */
export interface PageEscMessage {
  type: 'classmoji:page-esc';
}

export type PagesMessage = PageNavMessage | PageEscMessage;

/** The origin half of a configured URL, or null when it is unusable. */
export function originOf(rawUrl: string | null | undefined): string | null {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The public URL of a page on the class site.
 *
 * Null is the meaningful answer, not a failure: no site, site switched off, or
 * a page that is members-only/draft all land here, and every caller treats that
 * as "there is no site link for this — use the app".
 */
export function sitePageUrl(siteOrigin: string | null, slug: string | null | undefined): string {
  if (!siteOrigin || !slug) return '';
  return `${siteOrigin}/${encodeURIComponent(slug)}`;
}

/** The in-app reader URL for a page, e.g. `/student/cs52/pages/{id}`. */
export function inAppPageUrl(rolePath: string, classSlug: string, pageId: string): string {
  const prefix = rolePath.startsWith('/') ? rolePath : `/${rolePath}`;
  return `${prefix}/${classSlug}/pages/${pageId}`;
}

/**
 * Where the ↗ button opens.
 *
 * Site URL when the page is actually servable there, otherwise the in-app full
 * view. Never a dead link: a members-only page reached through the drawer still
 * has somewhere useful to open, it is just inside the app.
 */
export function resolveOpenTarget({
  siteOrigin,
  siteSlugByPageId,
  pageId,
  fallbackUrl,
}: {
  siteOrigin: string | null;
  siteSlugByPageId: Record<string, string>;
  pageId: string | null;
  fallbackUrl: string;
}): { url: string; isSite: boolean } {
  const slug = pageId ? siteSlugByPageId[pageId] : undefined;
  const url = sitePageUrl(siteOrigin, slug);
  return url ? { url, isSite: true } : { url: fallbackUrl, isSite: false };
}

/**
 * The iframe src for the panel.
 *
 * `parentOrigin` is passed so the embedded app can CHECK that its embedder is
 * the origin its own server config says the webapp lives at. It is a claim to
 * be verified, never the authority — see resolveEmbedParentOrigin in apps/pages.
 */
export function buildEmbedUrl({
  pagesUrl,
  classSlug,
  pageRef,
  parentOrigin,
}: {
  pagesUrl: string;
  classSlug: string;
  pageRef: string;
  parentOrigin?: string | null;
}): string {
  const base = String(pagesUrl ?? '').replace(/\/+$/, '');
  const params = new URLSearchParams({ embed: 'true' });
  if (parentOrigin) params.set('parentOrigin', parentOrigin);
  return `${base}/${encodeURIComponent(classSlug)}/${encodeURIComponent(pageRef)}?${params}`;
}

/** Structural check — the wire format is untrusted even after the origin matches. */
function parseMessage(data: unknown): PagesMessage | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;

  if (raw.type === 'classmoji:page-esc') return { type: 'classmoji:page-esc' };

  if (raw.type !== 'classmoji:page-nav') return null;
  if (typeof raw.pageId !== 'string' || !raw.pageId) return null;
  if (typeof raw.classroomSlug !== 'string' || !raw.classroomSlug) return null;

  return {
    type: 'classmoji:page-nav',
    classroomSlug: raw.classroomSlug,
    pageId: raw.pageId,
    pageSlug: typeof raw.pageSlug === 'string' && raw.pageSlug ? raw.pageSlug : null,
    title: typeof raw.title === 'string' ? raw.title : '',
  };
}

/**
 * Accept a window message only if it came from the pages app, in the frame we
 * put there, for the classroom we are actually looking at.
 *
 * All three checks matter:
 *  - `origin` stops any other site in any other frame from talking to us;
 *  - `source` stops a nested/sibling frame on the SAME origin (the pages app
 *    renders user-authored content) from impersonating the panel's document;
 *  - the classroom check stops a page in class A from retitling a panel that is
 *    showing class B.
 */
export function readPagesMessage(
  event: { origin: string; data: unknown; source?: unknown },
  {
    pagesOrigin,
    frameWindow,
    classSlug,
  }: { pagesOrigin: string | null; frameWindow?: unknown; classSlug?: string }
): PagesMessage | null {
  if (!pagesOrigin || event.origin !== pagesOrigin) return null;
  if (frameWindow && event.source !== frameWindow) return null;

  const message = parseMessage(event.data);
  if (!message) return null;
  if (message.type === 'classmoji:page-nav' && classSlug && message.classroomSlug !== classSlug) {
    return null;
  }
  return message;
}

/* ------------------------------------------------------------------ *
 * Peek drawer state
 * ------------------------------------------------------------------ */

export interface PeekState {
  open: boolean;
  /** The page the panel was opened on — the deep-link/fallback anchor. */
  pageId: string | null;
  /** The page the iframe is CURRENTLY showing (moves as hub links are clicked). */
  currentPageId: string | null;
  title: string;
}

export type PeekAction =
  | { type: 'open'; pageId: string; title: string }
  | { type: 'close' }
  /** The embedded document navigated itself; follow it in the header + ↗. */
  | { type: 'nav'; pageId: string; title: string };

export const INITIAL_PEEK_STATE: PeekState = {
  open: false,
  pageId: null,
  currentPageId: null,
  title: '',
};

export function peekReducer(state: PeekState, action: PeekAction): PeekState {
  switch (action.type) {
    case 'open':
      return {
        open: true,
        pageId: action.pageId,
        currentPageId: action.pageId,
        title: action.title,
      };
    case 'close':
      // Keep nothing: a reopened drawer must not flash the previous page.
      return INITIAL_PEEK_STATE;
    case 'nav':
      // A nav ping from a closed drawer is stale (it can arrive after the
      // iframe unmounts) and must never reopen it.
      if (!state.open) return state;
      return {
        ...state,
        currentPageId: action.pageId,
        title: action.title || state.title,
      };
    default:
      return state;
  }
}
