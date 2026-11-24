import { normalizeCodeBlockContent } from '@classmoji/page-schema';
import { collectBlockAssetRefs } from '@classmoji/utils';

import type { ReaderComments } from '~/components/comments/types.ts';
import { emptyPageDocument } from './legacyPage.ts';
import {
  hasScheduleEntry,
  linkedPageIds,
  redactDocumentForViewer,
  removeBlocks,
  type ViewerLinkResolver,
} from './linkRedaction.server.ts';
import { downloadMapRole, type MediaDownloads } from './mediaDownloads.ts';
import { hasMediaPlaceholderShape, hasMediaScheme } from './mediaRefs.ts';
import {
  documentForReader,
  type ReaderSections,
  type SectionViewerAccess,
} from './pageSections.server.ts';
import {
  describeBlocks,
  type ReaderCover,
  type ReaderLinks,
  type ReaderPayload,
  type ReaderSurfaceKind,
} from './readerPayload.ts';

/**
 * ONE builder for what a page's reader receives, whichever surface mounts the
 * shared reader (`components/reader/PageReader.tsx`): the pages app's page
 * route today, the class site and the MCP's page render next.
 *
 * Pure on purpose, like `pageSections.server.ts`: nothing here imports Prisma,
 * `~/utils/db.server.ts` or `@classmoji/services`. The I/O comes in as
 * `ReaderPayloadDeps` (`readerDeps.server.ts` binds the real ones), so the
 * unit suite drives every leak case with fakes.
 *
 * Who the viewer is, is the CALLER's decision (`viewer`): the app passes
 * exactly the reader rule its loader reads, the site will pass its
 * accepted-membership viewer or null. Nothing in here widens or narrows it.
 *
 * Every per-viewer data rule runs here, in this order, for every surface:
 *   1. `documentForReader` — locked bodies this viewer may not see leave first,
 *      before anything else reads the document;
 *   2. link redaction — `pageLink` blocks and page-directory entries naming a
 *      page this viewer may not open are REMOVED (titles included; a visible
 *      link carries the live title), unset file blocks too, and the schedule
 *      entry when there is no schedule;
 *   3. `normalizeCodeBlockContent`;
 *   4. media blocks whose reference could not be resolved are removed (the
 *      resolution itself runs alongside the link lookup, on the
 *      section-redacted document);
 *   5. the URL, srcset, download and links maps, cut to what the final
 *      document (and cover) references, and the description.
 * Every step is non-mutating: the content read may be a shared cache entry.
 */

/** The page row fields the builder reads. */
export interface ReaderPageRow {
  id: string;
  classroom_id: string;
  is_draft: boolean;
  is_public: boolean;
  header_image_url?: string | null;
  header_image_position?: number | null;
}

/** The classroom the page belongs to (its id scopes every lookup). */
export type ReaderClassroom = { id: string } & Record<string, unknown>;

/** Who is reading, as the CALLER decided it. Null: nobody signed in (or, on the site, a non-member). */
export interface ReaderViewer {
  userId: string;
  /** The reader rule (`pageSections.sectionViewer`, or the site's accepted-only equivalent). */
  access: SectionViewerAccess;
  /** This reader's own section state and abilities (`readerSectionsFor`). */
  readerSections: ReaderSections;
  /** A platform admin viewing as this user: passed through to comments as today. */
  impersonated: boolean;
}

/** A page another block links to, as the links lookup reads it. */
export interface LinkedPageRow {
  id: string;
  classroom_id: string;
  title: string | null;
  slug: string | null;
  is_public: boolean;
  is_draft: boolean;
}

/** The surface's own link rule: who may open a linked page, and where its link goes. */
export interface ReaderLinkPolicy {
  canOpen(page: LinkedPageRow, viewer: ReaderViewer | null): boolean;
  href(page: LinkedPageRow): string;
}

/** The I/O the builder needs. */
export interface ReaderPayloadDeps {
  /** The resolve context for this classroom and lifetime, or null where nothing can be signed. */
  assetContext(classroom: ReaderClassroom, tier: string): unknown | null;
  /** One resolve pass for the document's refs plus `extraRefs` (the cover). */
  resolveAssets(
    ctx: unknown | null,
    blocks: unknown,
    extraRefs: Array<string | null | undefined>
  ): Promise<{ assets: Record<string, string>; srcSets: Record<string, string> }>;
  /** `ref → downloadable` for this role (the READY rows of this classroom). */
  loadMediaDownloads(classroomId: string, blocks: unknown, role: string): Promise<MediaDownloads>;
  /** The pages with these ids IN this classroom (scoped in the query). */
  linkedPages(classroomId: string, pageIds: string[]): Promise<LinkedPageRow[]>;
  /** The page comments: open-thread counts for a member who may read them, else undefined. */
  readerComments(args: {
    userId: string;
    viewer: SectionViewerAccess;
    page: ReaderPageRow;
    classroom: ReaderClassroom;
    blocks: unknown[];
    unlockedSectionIds: string[];
    impersonated: boolean;
  }): Promise<ReaderComments | undefined>;
}

export interface BuildReaderPayloadInput {
  /** The page's content as read (`format` 'json' carries blocks; anything else reads as empty). */
  content: { blocks: unknown; cover: ReaderCover | null | undefined; format: string };
  page: ReaderPageRow;
  classroom: ReaderClassroom;
  viewer: ReaderViewer | null;
  options: {
    /** The asset lifetime the caller chose (`contentDelivery.tierFor`). */
    tier: string;
    /** A staff preview branch: no comments (its blocks are not what threads were written on). */
    previewActive: boolean;
    surface: ReaderSurfaceKind;
    /**
     * Whether this view draws Download buttons at all (default true). The app
     * passes false where a staff member's page is shown read-only for a
     * reason other than a preview, exactly as its loader decided before.
     */
    offerDownloads?: boolean;
    /** Whether page comments may be offered on this surface (default true). */
    comments?: boolean;
  };
  /** The surface's sign-in link for a signed-out reader (asked only when `viewer` is null). */
  signInUrl: () => string | null;
  /** The surface's link rule. */
  links: ReaderLinkPolicy;
  /** Where a page directory's schedule tile goes, or null (asked only when one has the tile). */
  scheduleHref: () => Promise<string | null>;
}

/**
 * The pages app's link rule: a linked page is a link when the page route
 * itself would open it for this viewer — a draft for those who may view
 * drafts, a members-only page for anyone with a role in the classroom (the
 * loader's own two gates, read on the same `sectionViewer`).
 */
export function appLinkPolicy(classroomSlug: string): ReaderLinkPolicy {
  return {
    canOpen: (page: LinkedPageRow, viewer: ReaderViewer | null) => {
      if (!classroomSlug) return false;
      if (page.is_draft && !viewer?.access.canViewDrafts) return false;
      if (!page.is_public && !viewer?.access.role) return false;
      return true;
    },
    href: page => `/${encodeURIComponent(classroomSlug)}/${encodeURIComponent(page.id)}`,
  };
}

/** The most distinct linked pages one document resolves (the rest read as not visible). */
export const READER_LINKED_PAGES_MAX = 2000;

/** Blocks that show a stored file: removed from a reader's document when it cannot be shown. */
const MEDIA_BLOCK_TYPES: ReadonlySet<string> = new Set(['image', 'file', 'audio', 'video']);

/** What a reader with no session may do: nothing, and they have no state. */
export const ANONYMOUS_READER_SECTIONS: Readonly<ReaderSections> = Object.freeze({
  staff: false,
  signedIn: false,
  canCheck: false,
  canUnlock: false,
  checked: [],
  unlocked: {},
});

/** The cover: content.json's metadata, else the legacy DB columns. */
export function pageCover(
  jsonCover: ReaderCover | null | undefined,
  page: Pick<ReaderPageRow, 'header_image_url' | 'header_image_position'>
): ReaderCover | null {
  if (jsonCover) return jsonCover;
  return page.header_image_url
    ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
    : null;
}

export async function buildReaderPayload(
  input: BuildReaderPayloadInput,
  deps: ReaderPayloadDeps
): Promise<ReaderPayload> {
  const { content, page, classroom, viewer, options } = input;
  const readerSections: ReaderSections = viewer?.readerSections ?? {
    ...ANONYMOUS_READER_SECTIONS,
    checked: [],
    unlocked: {},
  };

  // 'json' is the document; 'none' (both files missing) and 'html' (a legacy
  // page git still holds as index.html only) read as the empty document.
  const stored: unknown =
    content.format === 'json' ? content.blocks : (emptyPageDocument() as unknown[]);

  const commentBlocks =
    content.format === 'json' && Array.isArray(content.blocks) ? content.blocks : [];
  // Comments read the STORED blocks themselves (the service redacts them for
  // this reader), the same document `/api/page-comments` anchors against.
  // Started first and awaited last; a failure leaves the key out.
  const commentsPending =
    viewer &&
    viewer.access.acceptedRole !== null &&
    !options.previewActive &&
    options.comments !== false
      ? deps
          .readerComments({
            userId: viewer.userId,
            viewer: viewer.access,
            page,
            classroom,
            blocks: commentBlocks,
            unlockedSectionIds: Object.keys(readerSections.unlocked),
            impersonated: viewer.impersonated,
          })
          .catch(error => {
            console.warn('[pages] comment counts unavailable:', error);
            return undefined;
          })
      : null;

  // 1. Locked bodies.
  const sectioned = documentForReader(stored, {
    revealAll: viewer?.access.revealAll === true,
    unlocked: readerSections.unlocked,
  });

  // 2-4 run together: the link lookup (and the schedule) and the asset
  // resolution read the same section-redacted document, and link redaction
  // changes no asset reference (a removed block's children are kept), so
  // neither waits for the other. The maps are cut to the shipped document
  // at the end all the same.
  const cover = pageCover(content.cover, page);
  const ctx = deps.assetContext(classroom, options.tier);
  // Only the pages this (already section-redacted) document names — each
  // once, and at most READER_LINKED_PAGES_MAX of them (any beyond are treated
  // as not visible, so a document naming a huge number of ids cannot take
  // the page down) — only in this classroom, only those this viewer may open.
  const ids = linkedPageIds(sectioned).slice(0, READER_LINKED_PAGES_MAX);
  const idSet = new Set(ids);
  const [rows, scheduleHref, resolved] = await Promise.all([
    ids.length > 0 ? deps.linkedPages(page.classroom_id, ids) : Promise.resolve([]),
    hasScheduleEntry(sectioned) ? input.scheduleHref() : Promise.resolve(null),
    deps.resolveAssets(ctx, normalizeCodeBlockContent(sectioned), [cover?.url]),
  ]);
  const openable = new Map<string, LinkedPageRow>();
  for (const row of rows) {
    // The lookup is scoped by classroom already; checked again so a page of
    // another classroom can never become a link here.
    if (row.classroom_id !== page.classroom_id || row.classroom_id !== classroom.id) continue;
    if (!idSet.has(row.id)) continue;
    if (!input.links.canOpen(row, viewer)) continue;
    openable.set(row.id, row);
  }
  const resolveLink: ViewerLinkResolver = pageId => {
    const row = openable.get(pageId);
    if (!row) return null;
    const href = input.links.href(row);
    // A link the surface could not address is no link (never `//<id>`).
    if (!href || href.startsWith('//')) return null;
    return {
      href,
      title: row.title || 'Untitled',
      membersOnly: !row.is_public,
    };
  };

  // 2. Links redacted: hidden ones (and unset file blocks) REMOVED, not blanked.
  const linked = redactDocumentForViewer(sectioned, resolveLink, {
    dropSchedule: !scheduleHref,
    remove: true,
  });

  // 3. Code blocks as plain text (BlockNote 0.55 will not load a link inside one).
  const normalized = normalizeCodeBlockContent(linked);

  // 4. Media that could not be resolved goes: a `media:` reference with no
  //    display URL (unanswered, or too malformed to ask about), or one that
  //    resolved only to the "missing" placeholder. A block left holding one
  //    would draw BlockNote's "Add file" button or a broken element. A repo
  //    path with no entry stays: the delivery layer is off and the path is
  //    the URL.
  const unresolved = (ref: unknown): boolean => {
    if (typeof ref !== 'string' || !ref) return false;
    if (hasMediaScheme(ref) && !Object.hasOwn(resolved.assets, ref)) return true;
    const shown = resolved.assets[ref];
    return typeof shown === 'string' && hasMediaPlaceholderShape(shown);
  };
  const finalBlocks = removeBlocks(
    normalized,
    block =>
      typeof block.type === 'string' &&
      MEDIA_BLOCK_TYPES.has(block.type) &&
      unresolved(block.props?.url)
  );
  const finalCover = cover && unresolved(cover.url) ? null : cover;

  // 5. What the final document needs, and nothing else.
  const shipped = new Set([
    ...collectBlockAssetRefs(finalBlocks),
    ...(finalCover ? [finalCover.url] : []),
  ]);
  const assets: Record<string, string> = {};
  for (const [ref, url] of Object.entries(resolved.assets)) {
    if (shipped.has(ref)) assets[ref] = url;
  }
  const srcSets: Record<string, string> = {};
  for (const [ref, set] of Object.entries(resolved.srcSets)) {
    if (shipped.has(ref)) srcSets[ref] = set;
  }
  const links: ReaderLinks = {};
  for (const id of linkedPageIds(finalBlocks)) {
    const link = resolveLink(id);
    if (link)
      links[id] = { href: link.href, title: link.title, membersOnly: link.membersOnly === true };
  }

  // Download buttons: a signed-in member with a role here, where this view
  // draws them and the classroom can sign at all — drawn for the role
  // `/api/media-download` reads (accepted memberships only; `downloadMapRole`).
  const downloadRole =
    viewer && viewer.access.role && options.offerDownloads !== false && ctx
      ? downloadMapRole(viewer.access.acceptedRole, page.is_draft)
      : null;
  const mediaDownloads: MediaDownloads = downloadRole
    ? await deps.loadMediaDownloads(classroom.id, finalBlocks, downloadRole)
    : {};

  const readerComments = commentsPending ? await commentsPending : undefined;

  return {
    content: Array.isArray(finalBlocks) ? (finalBlocks as unknown[]) : [],
    coverImage: finalCover,
    assets,
    srcSets,
    mediaDownloads,
    readerSections,
    ...(readerComments ? { readerComments } : {}),
    signInUrl: viewer ? null : input.signInUrl(),
    links,
    scheduleHref,
    description: describeBlocks(finalBlocks),
  };
}
