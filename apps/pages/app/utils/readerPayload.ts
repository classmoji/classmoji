/**
 * The shared reader's data: what `buildReaderPayload` (server) hands
 * `PageReader` (client), on every surface that shows a page read-only — the
 * pages app today, the class site and the MCP's page render next.
 *
 * Types and pure helpers only, so the server builder, the client reader and
 * the unit suite can all import it.
 */
import type { ReaderComments } from '~/components/comments/types.ts';
import type { FrameHosts } from '~/components/editor/blocks/safeFrame.ts';
import type { MediaDownloads } from './mediaDownloads.ts';

/** Where the reader is mounted. Decides nothing about access: the payload already did. */
export type ReaderSurfaceKind = 'app' | 'site' | 'render';

/** One page this viewer may open, as the document's links render it. */
export interface ReaderLink {
  href: string;
  /** The page's live title. */
  title: string;
  /** Closed to signed-out readers (only ever true for a viewer who may open it). */
  membersOnly: boolean;
}

/** `pageId → link`, for the pages THIS viewer may open that the shipped document names. */
export type ReaderLinks = Record<string, ReaderLink>;

export interface ReaderCover {
  url: string;
  position?: number;
}

/** A reader's own section state (`readerSectionsFor`). */
export interface ReaderSectionsPayload {
  staff: boolean;
  signedIn: boolean;
  /**
   * Signed in AND an accepted member of the page's classroom. A signed-in
   * reader who is not (a stranger, a pending invite) is told only members can
   * unlock a locked section, instead of being sent to sign in.
   */
  member: boolean;
  canCheck: boolean;
  canUnlock: boolean;
  checked: string[];
  unlocked: Record<string, string>;
}

/** Everything `PageReader` needs for one viewer of one page. */
export interface ReaderPayload {
  /** The document as this viewer may receive it (locked bodies, links, code, media done). */
  content: unknown[];
  coverImage: ReaderCover | null;
  /** Stored ref → display URL, for refs the shipped document (or the cover) holds. */
  assets: Record<string, string>;
  /** Stored ref → srcset, same keys as `assets` (images only). */
  srcSets: Record<string, string>;
  /** Stored ref → downloadable, for a member's media files. */
  mediaDownloads: MediaDownloads;
  readerSections: ReaderSectionsPayload;
  /** Present only for a signed-in member who may read this page's comments. */
  readerComments?: ReaderComments;
  /** A signed-out reader's way in (surface-specific), else null. */
  signInUrl: string | null;
  links: ReaderLinks;
  /** A page directory's schedule tile target, or null (the tile is then not drawn). */
  scheduleHref: string | null;
  /** Plain text from the shipped document, for a page description (≤ 180 chars). */
  description: string | null;
  /** Our own hosts, for the frame rule (`decideFrame`); the same for every reader. */
  frameHosts: FrameHosts | null;
}

// ── Link rendering decisions (pure, so the suite pins them without React) ──

/** What a read-only `pageLink` draws. */
export type PageLinkRender =
  | { kind: 'legacy' }
  | { kind: 'nothing' }
  | { kind: 'link'; href: string; title: string; pageId: string };

/**
 * The read-only `pageLink`: with a link map (the shared reader), a real link
 * to a page in the map with its live title, or nothing for a page outside it;
 * with no map (the editor's own read-only states), the block as it always was.
 */
export function pageLinkRender(
  links: ReaderLinks | null,
  pageId: string,
  storedTitle: string
): PageLinkRender {
  if (!links) return { kind: 'legacy' };
  const link = pageId ? links[pageId] : undefined;
  if (!link) return { kind: 'nothing' };
  return { kind: 'link', href: link.href, title: link.title || storedTitle || 'Untitled', pageId };
}

export interface NavGridTile {
  kind: 'page' | 'schedule' | 'external';
  key: string;
  href: string;
  label: string;
  /** Always a string: the slot is drawn empty so labels line up. */
  emoji: string;
  pageId?: string;
  membersOnly?: boolean;
  /** Opens elsewhere (an external link, or the schedule on the class site). */
  external: boolean;
}

type GridEntry =
  | { kind: 'page'; pageId: string; title: string; emoji?: string }
  | { kind: 'external'; url: string; label: string; emoji?: string }
  | { kind: 'schedule'; label?: string; emoji?: string };

/**
 * The tiles a read-only page directory draws in the shared reader: page
 * entries only for pages in the map (the authored label first, then the live
 * title, as on the class site), the schedule only when there is a schedule to
 * link to, external links as authored.
 */
export function navGridTiles(
  entries: readonly GridEntry[],
  links: ReaderLinks,
  scheduleHref: string | null,
  labels: { label: (entry: GridEntry) => string; emoji: (entry: GridEntry) => string }
): NavGridTile[] {
  const tiles: NavGridTile[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'page') {
      const link = links[entry.pageId];
      if (!link) return;
      tiles.push({
        kind: 'page',
        key: `page-${entry.pageId}-${index}`,
        href: link.href,
        label: entry.title || link.title || 'Untitled',
        emoji: entry.emoji || '',
        pageId: entry.pageId,
        membersOnly: link.membersOnly,
        external: false,
      });
      return;
    }
    if (entry.kind === 'schedule') {
      if (!scheduleHref) return;
      tiles.push({
        kind: 'schedule',
        key: `schedule-${index}`,
        href: scheduleHref,
        label: labels.label(entry),
        emoji: labels.emoji(entry),
        external: /^https?:\/\//i.test(scheduleHref),
      });
      return;
    }
    tiles.push({
      kind: 'external',
      key: `external-${index}`,
      href: entry.url,
      label: labels.label(entry),
      emoji: entry.emoji || '',
      external: true,
    });
  });
  return tiles;
}

/**
 * Whether a click on an in-app page link should be taken over by client-side
 * navigation: a plain primary click only (a modified click opens a tab, as a
 * link does).
 */
export function isPlainPrimaryClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

// ── Description ────────────────────────────────────────────────────────────

type InlineNode = { type?: unknown; text?: unknown; content?: unknown };

function inlineText(content: unknown, out: string[]): void {
  if (typeof content === 'string') {
    out.push(content);
    return;
  }
  if (!Array.isArray(content)) {
    // A table: `{ type: 'tableContent', rows: [{ cells: [...] }] }`.
    const rows = (content as { rows?: unknown } | null)?.rows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const cells = (row as { cells?: unknown } | null)?.cells;
        if (!Array.isArray(cells)) continue;
        for (const cell of cells) {
          const cellContent = Array.isArray(cell) ? cell : (cell as { content?: unknown })?.content;
          inlineText(cellContent, out);
          out.push(' ');
        }
      }
    }
    return;
  }
  for (const node of content as InlineNode[]) {
    if (!node || typeof node !== 'object') continue;
    if (typeof node.text === 'string') out.push(node.text);
    else if (node.content) inlineText(node.content, out);
  }
}

/**
 * A short plain-text description from a document's text (what a reader reads:
 * paragraphs, headings, callouts, lists, tables, code), for a page
 * description. Built from the document as SHIPPED, so nothing the viewer may
 * not see can be in it. The same length rules as the site's
 * `describeFromHtml`: null under 20 characters, cut at 180.
 */
export function describeBlocks(blocks: unknown): string | null {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const block = node as { content?: unknown; children?: unknown };
    if (block.content !== undefined) {
      inlineText(block.content, out);
      out.push(' ');
    }
    if (block.children) walk(block.children);
  };
  walk(blocks);
  const text = out.join('').replace(/\s+/g, ' ').trim();
  if (text.length < 20) return null;
  return text.length > 180 ? `${text.slice(0, 177).trimEnd()}...` : text;
}
