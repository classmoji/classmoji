import { createContext, useContext } from 'react';

import type { FrameHosts } from '~/components/editor/blocks/safeFrame.ts';
import { buildEmbeddedPageHref } from '~/routes/$classroomSlug/embedBridge.ts';
import type { ReaderLinks, ReaderSurfaceKind } from '~/utils/readerPayload.ts';

/**
 * What the page's blocks need to know about where they are drawn, handed down
 * through context (BlockNote portals every block render into the
 * `BlockNoteView` tree, so a provider above the view reaches them).
 *
 * The blocks never import a router: navigation, link targets and origins come
 * from here. The shared reader (`PageReader`) provides it with the viewer's
 * link map; the app route provides it around its editors with no map and its
 * navigate function.
 */
export interface ReaderSurfaceValue {
  surface: ReaderSurfaceKind;
  /**
   * The pages THIS viewer may open that the document names (`pageId → link`).
   * Present in the shared reader, where a read-only `pageLink` or page
   * directory draws real links from it and a page missing from it draws
   * nothing. Null in the editors and their read-only states, which keep the
   * blocks' own rendering.
   */
  links: ReaderLinks | null;
  /** A page directory's schedule tile target, or null (no tile in the reader). */
  scheduleHref: string | null;
  /** Prefix for Download links ('' on the pages host itself). */
  downloadOrigin: string;
  /** Prefix for the reader's API calls ('' on the pages host itself). */
  apiBase: string;
  /** The classroom the page belongs to (for the editors' in-app page hrefs). */
  classroomSlug: string | null;
  /**
   * Client-side navigation to another page of this classroom, where the host
   * has a router (the pages app: it keeps the embed context of the webapp's
   * docked and peek views, `buildEmbeddedPageHref`). Null: links are plain
   * links.
   */
  navigatePage: ((pageId: string) => void) | null;
  /**
   * Our own hosts, as the server named them (the reader's payload, the
   * editor's loader data): an embed or video naming one is a link, never a
   * frame, and only the delivery host frames a file of the class's own
   * (`decideFrame`). Null where none were sent: only the page's own origin
   * is refused, and nothing is framed unsandboxed.
   */
  frameHosts: FrameHosts | null;
}

export const DEFAULT_READER_SURFACE: ReaderSurfaceValue = Object.freeze({
  surface: 'app',
  links: null,
  scheduleHref: null,
  downloadOrigin: '',
  apiBase: '',
  classroomSlug: null,
  navigatePage: null,
  frameHosts: null,
}) as ReaderSurfaceValue;

export const ReaderSurfaceContext = createContext<ReaderSurfaceValue>(DEFAULT_READER_SURFACE);

export function useReaderSurface(): ReaderSurfaceValue {
  return useContext(ReaderSurfaceContext);
}

/**
 * The classroom slug for an in-app page href: the surface's, else the first
 * path segment of this document's address (the pages app's `/:classroomSlug/…`
 * — the editors' long-standing fallback).
 */
export function classroomSlugFor(surface: ReaderSurfaceValue): string {
  if (surface.classroomSlug) return surface.classroomSlug;
  if (typeof window === 'undefined') return '';
  return window.location.pathname.split('/')[1] ?? '';
}

/**
 * The in-app address of another page of the classroom, keeping the embed
 * context of the current address (`buildEmbeddedPageHref`) — or null when
 * there is no classroom slug or page id to build one from. Null means no
 * link and no navigation: never a `//<pageId>` that would leave the site.
 */
export function inAppPageHref(
  classroomSlug: string | null | undefined,
  pageId: string | null | undefined,
  currentSearch = ''
): string | null {
  if (!classroomSlug || !pageId) return null;
  return buildEmbeddedPageHref(classroomSlug, pageId, currentSearch);
}
