/**
 * Page comments: threads readers start on a course page, on a block, on a
 * quote inside a block, or on the page as a whole; replies, emoji reactions,
 * edits and deletes; the teaching team resolves and reopens threads.
 *
 * The ONE rule source for every surface (the pages app's `/api/page-comments`
 * and loader, and the MCP tools): who may read and write (`commentAccess`),
 * which threads a reader sees (`threadVisible`), what a write may contain
 * (`cleanCommentBody`, `resolveCommentAnchor`, `isValidReactionEmoji`), what a
 * thread looks like on the wire (`Thread`), and the audit row each write
 * leaves (`commentAuditRow`). Callers add only their transport: sessions,
 * impersonation (callers refuse writes while impersonated; not this module's
 * concern), rate limits, status codes.
 *
 * Every id is SERVER-DERIVED. A caller builds one `CommentContext` from the
 * page row it loaded, the session's user, that user's `SectionViewer` in the
 * page's OWN classroom, the page's stored blocks and the user's unlocked
 * sections (`commentContext`). Every query is scoped by that page AND its
 * classroom: a thread or comment id from another page or classroom is "not
 * found", the same as one that does not exist. A thread the reader cannot see
 * (inside a locked body they have not unlocked) is "not found" too, for reads
 * and writes alike.
 *
 * Reads answer null for a viewer who may not read; writes throw:
 *   - `PageCommentsNotFoundError`   → 404 (no page access, no such thread/comment)
 *   - `PageCommentsForbiddenError`  → 403 (locked classroom, not the author,
 *                                         not teaching team)
 *   - `PageCommentsValidationError` → 400 (with a `code`)
 */
import getPrisma from '@classmoji/database';
// A workspace package resolved from the root node_modules; this package's
// package.json does not list it (see pageHtmlBlocks.ts). `/sections` is pure:
// no BlockNote, no DOM.
import {
  blockIdsInOrder,
  blockText,
  enclosingLockedSectionId,
  findBlock,
  normalizeQuoteText,
  quoteOccurrenceIndex,
  redactLockedSections,
} from '@classmoji/page-schema/sections'; // eslint-disable-line import/no-unresolved
import type { AuditLogAction, ClassroomStatus, Prisma, Role } from '@prisma/client';

import {
  isBlockId,
  isSectionId,
  readerState,
  sectionViewer,
  type SectionViewer,
} from './pageSections.service.ts';

// ── Limits ─────────────────────────────────────────────────────────────────

/** Longest comment body, after cleaning (UTF-16 units). */
export const COMMENT_BODY_MAX_LENGTH = 4000;
/** Longest quote, after whitespace normalization. */
export const COMMENT_QUOTE_MAX_LENGTH = 500;
/** Highest `quoteOccurrence` accepted (no block holds more matches in practice). */
export const COMMENT_QUOTE_OCCURRENCE_MAX = 10_000;
/** Longest reaction emoji (UTF-16 units). */
export const REACTION_EMOJI_MAX_LENGTH = 32;
/** Most distinct emoji on one comment. */
export const MAX_DISTINCT_REACTIONS = 20;

// ── Errors ─────────────────────────────────────────────────────────────────

export type PageCommentsValidationCode =
  | 'INVALID_ID'
  | 'INVALID_VALUE'
  | 'INVALID_BODY'
  | 'INVALID_BLOCK'
  | 'INVALID_QUOTE'
  | 'INVALID_EMOJI'
  | 'TOO_MANY_REACTIONS'
  | 'THREAD_RESOLVED';

/** A write that cannot be done as asked (→ 400). */
export class PageCommentsValidationError extends Error {
  readonly code: PageCommentsValidationCode;
  constructor(code: PageCommentsValidationCode, message: string) {
    super(message);
    this.name = 'PageCommentsValidationError';
    this.code = code;
  }
}

/**
 * The page is not this viewer's to read, or the thread/comment is not on this
 * page, or not visible to this viewer (→ 404). One answer for all of them, so
 * ids cannot be probed.
 */
export class PageCommentsNotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'PageCommentsNotFoundError';
  }
}

export type PageCommentsForbiddenCode = 'CLASSROOM_LOCKED' | 'NOT_AUTHOR' | 'NOT_TEACHING_TEAM';

/** A reader who may see the thread but not do this to it (→ 403). */
export class PageCommentsForbiddenError extends Error {
  readonly code: PageCommentsForbiddenCode;
  constructor(code: PageCommentsForbiddenCode, message: string) {
    super(message);
    this.name = 'PageCommentsForbiddenError';
    this.code = code;
  }
}

const invalid = (code: PageCommentsValidationCode, message: string) =>
  new PageCommentsValidationError(code, message);

function requireId(value: unknown, label: string): asserts value is string {
  if (!isSectionId(value)) throw invalid('INVALID_ID', `Invalid ${label} id`);
}

// ── Access ─────────────────────────────────────────────────────────────────

const CLASSROOM_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'LOCKED', 'UNPUBLISHED']);

/**
 * `canEnterClassroom` from `@classmoji/auth/predicates`, mirrored (that
 * package depends on this one). UNPUBLISHED admits only its owner; LOCKED
 * admits everyone. A unit test pins the two together.
 */
export function canEnterClassroomStatus({
  status,
  role,
}: {
  status: ClassroomStatus;
  role: Role;
}): boolean {
  return !(status === 'UNPUBLISHED' && role !== 'OWNER');
}

/**
 * `canMutateClassroom` from `@classmoji/auth/predicates`, mirrored: owners
 * may always write; everyone else only while ACTIVE. The pages app's
 * `pageMutationBlocked` and the MCP's `assertMutationAllowed` read the same
 * rule. A unit test pins the two together.
 */
export function canMutateClassroomStatus({
  status,
  role,
}: {
  status: ClassroomStatus;
  role: Role;
}): boolean {
  if (role === 'OWNER') return true;
  return status === 'ACTIVE';
}

/** What a viewer may do with the comments on one page. */
export interface CommentAccess {
  /** An accepted member of the page's classroom who may open this page there. */
  canRead: boolean;
  /** canRead and not frozen: start threads, reply, react, edit/delete own comments. */
  canWrite: boolean;
  /** canWrite and accepted OWNER/TEACHER/ASSISTANT: resolve and reopen threads. */
  canResolve: boolean;
  /** canWrite and accepted OWNER/TEACHER: delete anyone's comment. */
  canModerate: boolean;
  /** canRead but the classroom is read-only for this viewer (LOCKED, not its owner). */
  frozen: boolean;
  /** The viewer's highest ACCEPTED role (the audit row's role), or null. */
  role: Role | null;
}

export const NO_COMMENT_ACCESS: Readonly<CommentAccess> = Object.freeze({
  canRead: false,
  canWrite: false,
  canResolve: false,
  canModerate: false,
  frozen: false,
  role: null,
});

/**
 * The comment rule (plan D3, Q1–Q3):
 *   - only ACCEPTED members of the page's classroom (`acceptedRole`) read or write;
 *   - a draft page only for `canViewDrafts` (the pages app's draft rule);
 *   - an UNPUBLISHED classroom admits only its owner (the entry rule, read on
 *     the ACCEPTED role);
 *   - a LOCKED classroom is read-only for everyone but its owner (the
 *     mutation rule): `frozen`;
 *   - resolve/reopen: the accepted teaching team; moderate: accepted OWNER/TEACHER.
 * An unknown status admits nobody.
 */
export function commentAccess({
  viewer,
  page,
  classroom,
}: {
  viewer: Pick<SectionViewer, 'acceptedRole' | 'teachingTeam' | 'canViewDrafts'>;
  page: { is_draft: boolean };
  classroom: { status: ClassroomStatus | string };
}): CommentAccess {
  const role = viewer?.acceptedRole ?? null;
  const status = classroom?.status;
  if (role === null || typeof status !== 'string' || !CLASSROOM_STATUSES.has(status)) {
    return { ...NO_COMMENT_ACCESS };
  }
  if (page?.is_draft !== false && !viewer.canViewDrafts) return { ...NO_COMMENT_ACCESS };
  const gate = { status: status as ClassroomStatus, role };
  if (!canEnterClassroomStatus(gate)) return { ...NO_COMMENT_ACCESS };

  const frozen = !canMutateClassroomStatus(gate);
  const canWrite = !frozen;
  return {
    canRead: true,
    canWrite,
    canResolve: canWrite && viewer.teachingTeam === true,
    canModerate: canWrite && (role === 'OWNER' || role === 'TEACHER'),
    frozen,
    role,
  };
}

// ── Visibility ─────────────────────────────────────────────────────────────

/** What decides which threads one reader sees (plan D2). */
export interface ThreadFilter {
  /** Block ids in the reader's REDACTED tree. */
  visibleBlockIds: ReadonlySet<string>;
  /** Block ids in the FULL document. */
  allBlockIds: ReadonlySet<string>;
  /** The reader receives every locked body (`SectionViewer.revealAll`). */
  revealAll: boolean;
  /** Locked sections this reader unlocked. */
  unlockedSectionIds: ReadonlySet<string>;
  /**
   * The document could not be read (as opposed to read and empty), so no
   * block can be placed: a reader who does not reveal all then sees
   * page-level threads only (fail closed; a block thread could sit in a
   * locked body).
   */
  documentUnknown?: boolean;
}

/**
 * Does this reader see this thread?
 *   - its block is in the reader's tree → yes;
 *   - its block is in the document but not in the reader's tree (inside a
 *     locked body they have not unlocked) → no;
 *   - page-level, or its block is gone from the document → only if it was not
 *     started inside a locked section, or the reader reveals all, or unlocked
 *     that section;
 *   - the document could not be read → page-level threads only, unless the
 *     reader reveals all.
 */
export function threadVisible(
  thread: { block_id: string | null; locked_section_id: string | null },
  filter: ThreadFilter
): boolean {
  const sectionOpen =
    thread.locked_section_id === null ||
    filter.revealAll ||
    filter.unlockedSectionIds.has(thread.locked_section_id);
  if (thread.block_id === null) return sectionOpen;
  if (filter.documentUnknown && !filter.revealAll) return false;
  if (filter.visibleBlockIds.has(thread.block_id)) return true;
  if (filter.allBlockIds.has(thread.block_id)) return false;
  return sectionOpen;
}

// ── Context ────────────────────────────────────────────────────────────────

/** The page row fields this module reads. */
export interface CommentPage {
  id: string;
  classroom_id: string;
  is_draft: boolean;
}

/**
 * Everything one viewer's reads and writes on one page are decided from,
 * built once per request by `commentContext`.
 */
export interface CommentContext {
  page: { id: string; classroom_id: string };
  userId: string;
  access: CommentAccess;
  /** The stored document (every locked body present). */
  fullBlocks: unknown[];
  /** The document this reader receives (`documentForReader`). */
  readerBlocks: unknown[];
  filter: ThreadFilter;
  /** Block ids of the reader's tree in document order (thread order). */
  blockOrder: string[];
}

/**
 * One viewer's comment context on one page. `viewer` must be the user's
 * `sectionViewer` in `page.classroom_id`; `blocks` the page's stored blocks
 * (anything not an array reads as an empty document, so only page-level
 * threads can be started); `unlockedSectionIds` the locked sections the user
 * unlocked on this page (`readerState(...).unlocked`'s keys).
 */
export function commentContext({
  userId,
  viewer,
  page,
  classroom,
  blocks,
  unlockedSectionIds,
}: {
  userId: string;
  viewer: SectionViewer;
  page: CommentPage;
  classroom: { status: ClassroomStatus | string };
  /** The full document; anything but an array means it could not be read. */
  blocks: unknown;
  unlockedSectionIds: Iterable<string>;
}): CommentContext {
  const fullBlocks = Array.isArray(blocks) ? blocks : [];
  const documentUnknown = !Array.isArray(blocks);
  const unlocked = new Set(unlockedSectionIds);
  const revealAll = viewer.revealAll === true;
  const readerBlocks = revealAll
    ? fullBlocks
    : redactLockedSections(fullBlocks, id => unlocked.has(id));
  const blockOrder = blockIdsInOrder(readerBlocks);
  return {
    page: { id: page.id, classroom_id: page.classroom_id },
    userId,
    access: commentAccess({ viewer, page, classroom }),
    fullBlocks,
    readerBlocks,
    filter: {
      visibleBlockIds: new Set(blockOrder),
      allBlockIds: new Set(blockIdsInOrder(fullBlocks)),
      revealAll,
      unlockedSectionIds: unlocked,
      documentUnknown,
    },
    blockOrder,
  };
}

/**
 * `commentContext` with the viewer and their unlocks read from the database.
 * `page.classroom.status` is the page's own classroom's status.
 */
export async function loadCommentContext({
  userId,
  page,
  blocks,
}: {
  userId: string;
  page: CommentPage & { classroom: { status: ClassroomStatus | string } };
  blocks: unknown;
}): Promise<CommentContext> {
  const [viewer, state] = await Promise.all([
    sectionViewer({ userId, classroomId: page.classroom_id }),
    readerState({ pageId: page.id, userId }),
  ]);
  return commentContext({
    userId,
    viewer,
    page,
    classroom: page.classroom,
    blocks,
    unlockedSectionIds: Object.keys(state.unlocked),
  });
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * A comment body as stored: line endings normalized to `\n`, NUL characters
 * (Postgres refuses them) removed, trimmed, 1–4000 characters. Plain text,
 * rendered as text; never HTML.
 */
export function cleanCommentBody(body: unknown): string {
  if (typeof body !== 'string') throw invalid('INVALID_BODY', 'Write a comment.');
  const value = body.replace(/\r\n?/g, '\n').replaceAll('\u0000', '').trim();
  if (!value) throw invalid('INVALID_BODY', 'Write a comment.');
  if (value.length > COMMENT_BODY_MAX_LENGTH) {
    throw invalid('INVALID_BODY', `Keep the comment under ${COMMENT_BODY_MAX_LENGTH} characters.`);
  }
  return value;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * One emoji character (Unicode `Emoji`, so never an unassigned code point),
 * with optional presentation selector and skin tone. Not a digit, `#`, `*`
 * (keycaps only), a lone regional indicator (flags only) or a lone skin tone.
 */
const EMOJI_ELEMENT =
  '(?![0-9#*\\p{Regional_Indicator}\\p{Emoji_Modifier}])\\p{Emoji}\\uFE0F?(?:\\p{Emoji_Modifier}\\uFE0F?)?';
/** An emoji or a ZWJ sequence of them (family, profession, rainbow flag...). */
const ZWJ_SEQUENCE = new RegExp(`^${EMOJI_ELEMENT}(?:\\u200D${EMOJI_ELEMENT})*$`, 'u');
/**
 * Shown as an emoji, not as text: a character that is an emoji by default, or
 * one forced into emoji form by VS16 or a skin tone. So `©️` and `☝🏽` pass,
 * while plain `©`, `®`, `™`, `☝` and `♀` (text by default) do not.
 */
const EMOJI_FORM = /\p{Emoji_Presentation}|️|\p{Emoji_Modifier}/u;
/** A country flag: two regional indicators. */
const FLAG = /^\p{Regional_Indicator}{2}$/u;
/** A keycap: 0-9, # or *, optional VS16, then U+20E3. */
const KEYCAP = /^[0-9#*]️?⃣$/u;
/** A subdivision flag: black flag, tag letters/digits, cancel tag. */
const TAG_FLAG = /^\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,8}\u{E007F}$/u;

/**
 * Exactly one emoji (plan Q4): one grapheme cluster that is an emoji or a ZWJ
 * sequence of them (with optional VS16 and skin tones) in emoji form
 * (`EMOJI_FORM`), a flag (regional-indicator pair or subdivision tag
 * sequence) or a keycap; at most 32 UTF-16 units. Text, digits, text-style
 * symbols (plain `©`, `™`), unassigned code points, several emoji, stray
 * joiners and combining marks are refused.
 */
export function isValidReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > REACTION_EMOJI_MAX_LENGTH) return false;
  let graphemes = 0;
  for (const _ of segmenter.segment(value)) {
    if (++graphemes > 1) return false;
  }
  return (
    (ZWJ_SEQUENCE.test(value) && EMOJI_FORM.test(value)) ||
    FLAG.test(value) ||
    KEYCAP.test(value) ||
    TAG_FLAG.test(value)
  );
}

/** Where a new thread is anchored, as stored. */
export interface CommentAnchor {
  blockId: string | null;
  quote: string | null;
  quoteOccurrence: number;
  /** The locked section enclosing the block in the FULL document, or null. */
  lockedSectionId: string | null;
}

/**
 * A new thread's anchor, checked against the READER's tree:
 *   - no block → a page-level thread (no quote allowed);
 *   - a block → must be in the reader's redacted tree (a body this reader
 *     cannot see cannot be commented on, or probed for its block ids);
 *   - a quote → whitespace-normalized and trimmed, at most 500 characters,
 *     and its `quoteOccurrence`-th (0-based, overlapping) match must exist in
 *     the block's text (`blockText`) in the reader's tree.
 * `lockedSectionId` comes from the FULL document (the reader may have
 * unlocked the section; the gate must outlive the block).
 */
export function resolveCommentAnchor({
  readerBlocks,
  fullBlocks,
  blockId,
  quote,
  quoteOccurrence,
}: {
  readerBlocks: unknown;
  fullBlocks: unknown;
  blockId?: unknown;
  quote?: unknown;
  quoteOccurrence?: unknown;
}): CommentAnchor {
  const hasQuote = quote !== undefined && quote !== null && quote !== '';
  const occurrence =
    quoteOccurrence === undefined || quoteOccurrence === null ? 0 : quoteOccurrence;
  if (
    typeof occurrence !== 'number' ||
    !Number.isInteger(occurrence) ||
    occurrence < 0 ||
    occurrence > COMMENT_QUOTE_OCCURRENCE_MAX
  ) {
    throw invalid('INVALID_QUOTE', 'Invalid quote occurrence');
  }

  if (blockId === undefined || blockId === null) {
    if (hasQuote || occurrence !== 0) {
      throw invalid('INVALID_QUOTE', 'A quote needs a block');
    }
    return { blockId: null, quote: null, quoteOccurrence: 0, lockedSectionId: null };
  }

  if (!isBlockId(blockId)) throw invalid('INVALID_BLOCK', 'Invalid block id');
  const block = findBlock(readerBlocks, blockId);
  if (!block) throw invalid('INVALID_BLOCK', 'That block is not on this page');
  const lockedSectionId = enclosingLockedSectionId(fullBlocks, blockId);

  if (!hasQuote) {
    if (occurrence !== 0) throw invalid('INVALID_QUOTE', 'A quote occurrence needs a quote');
    return { blockId, quote: null, quoteOccurrence: 0, lockedSectionId };
  }
  if (typeof quote !== 'string') throw invalid('INVALID_QUOTE', 'Invalid quote');
  const cleaned = normalizeQuoteText(quote).trim();
  if (!cleaned) throw invalid('INVALID_QUOTE', 'Invalid quote');
  if (cleaned.length > COMMENT_QUOTE_MAX_LENGTH) {
    throw invalid('INVALID_QUOTE', `Keep the quote under ${COMMENT_QUOTE_MAX_LENGTH} characters.`);
  }
  if (quoteOccurrenceIndex(blockText(block), cleaned, occurrence) === -1) {
    throw invalid('INVALID_QUOTE', 'That text is not in the block');
  }
  return { blockId, quote: cleaned, quoteOccurrence: occurrence, lockedSectionId };
}

// ── Wire shapes (the API contract) ─────────────────────────────────────────

export type AuthorBadge = 'Instructor' | 'TA';

/** A comment's or resolver's author. Null = a deleted user. No ids, emails or logins. */
export interface Author {
  name: string;
  image: string | null;
  badge: AuthorBadge | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface Comment {
  id: string;
  author: Author | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  reactions: Reaction[];
  canEdit: boolean;
  canDelete: boolean;
}

export interface Thread {
  id: string;
  blockId: string | null;
  quote: string | null;
  quoteOccurrence: number;
  resolvedAt: string | null;
  resolvedBy: Author | null;
  createdAt: string;
  comments: Comment[];
}

/** Shown for a user row without a name (never a login or an email). */
export const UNNAMED_AUTHOR = 'Class member';

/** Accepted OWNER/TEACHER → 'Instructor', ASSISTANT → 'TA', otherwise none. */
export function badgeForRole(role: Role | null | undefined): AuthorBadge | null {
  if (role === 'OWNER' || role === 'TEACHER') return 'Instructor';
  if (role === 'ASSISTANT') return 'TA';
  return null;
}

/** Reaction rows (oldest first) → one entry per emoji, in first-reacted order. */
export function groupReactions(
  rows: ReadonlyArray<{ emoji: string; user_id: string }>,
  viewerUserId: string
): Reaction[] {
  const byEmoji = new Map<string, Reaction>();
  for (const row of rows) {
    let entry = byEmoji.get(row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, count: 0, mine: false };
      byEmoji.set(row.emoji, entry);
    }
    entry.count++;
    if (row.user_id === viewerUserId) entry.mine = true;
  }
  return [...byEmoji.values()];
}

const AUTHOR_SELECT = { id: true, name: true, image: true } as const;

const THREAD_INCLUDE = {
  resolved_by: { select: AUTHOR_SELECT },
  comments: {
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    include: {
      author: { select: AUTHOR_SELECT },
      reactions: {
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        select: { emoji: true, user_id: true },
      },
    },
  },
} satisfies Prisma.PageCommentThreadInclude;

/** A thread row as `listThreads` reads it. */
export type ThreadRow = Prisma.PageCommentThreadGetPayload<{ include: typeof THREAD_INCLUDE }>;

type AuthorRow = { id: string; name: string | null; image: string | null } | null;

function toAuthor(user: AuthorRow, badges: ReadonlyMap<string, AuthorBadge | null>): Author | null {
  if (!user) return null;
  return {
    name: user.name?.trim() || UNNAMED_AUTHOR,
    image: user.image ?? null,
    badge: badges.get(user.id) ?? null,
  };
}

/**
 * A thread row → the wire `Thread` for one viewer: author name/image/badge
 * only, reactions grouped with the viewer's own marked, and per comment what
 * the viewer may do (edit: own and may write; delete: own and may write, or
 * moderator).
 */
export function toThreadDto(
  row: ThreadRow,
  {
    viewerUserId,
    access,
    badges,
  }: {
    viewerUserId: string;
    access: Pick<CommentAccess, 'canWrite' | 'canModerate'>;
    badges: ReadonlyMap<string, AuthorBadge | null>;
  }
): Thread {
  return {
    id: row.id,
    blockId: row.block_id,
    quote: row.quote,
    quoteOccurrence: row.quote_occurrence,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    resolvedBy: toAuthor(row.resolved_by, badges),
    createdAt: row.created_at.toISOString(),
    comments: row.comments.map(comment => {
      const own = comment.author_id !== null && comment.author_id === viewerUserId;
      return {
        id: comment.id,
        author: toAuthor(comment.author, badges),
        body: comment.body,
        createdAt: comment.created_at.toISOString(),
        editedAt: comment.edited_at ? comment.edited_at.toISOString() : null,
        reactions: groupReactions(comment.reactions, viewerUserId),
        canEdit: access.canWrite && own,
        canDelete: (access.canWrite && own) || access.canModerate,
      };
    }),
  };
}

/**
 * Thread order (plan): threads on blocks of the reader's tree in document
 * order, then page-level threads, then threads whose block is gone; oldest
 * first within each block and group (ties by id).
 */
export function sortThreads<T extends { block_id: string | null; created_at: Date; id: string }>(
  threads: readonly T[],
  blockOrder: readonly string[]
): T[] {
  const position = new Map<string, number>();
  blockOrder.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  const PAGE_LEVEL = blockOrder.length;
  const ORPHAN = blockOrder.length + 1;
  const rank = (thread: T) =>
    thread.block_id === null ? PAGE_LEVEL : (position.get(thread.block_id) ?? ORPHAN);
  return [...threads].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.created_at.getTime() - b.created_at.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Open (unresolved) visible threads → counts per block, page-level, total. */
export interface CommentCounts {
  /** Block id → open threads on that block (blocks in the reader's tree only). */
  counts: Record<string, number>;
  /** Open page-level threads. */
  pageLevel: number;
  /** Every open visible thread, orphans included. */
  open: number;
}

export function countOpenThreads(
  threads: ReadonlyArray<{
    block_id: string | null;
    locked_section_id: string | null;
    resolved_at: Date | null;
  }>,
  filter: ThreadFilter
): CommentCounts {
  const counts: Record<string, number> = {};
  let pageLevel = 0;
  let open = 0;
  for (const thread of threads) {
    if (thread.resolved_at !== null || !threadVisible(thread, filter)) continue;
    open++;
    if (thread.block_id === null) pageLevel++;
    else if (filter.visibleBlockIds.has(thread.block_id)) {
      counts[thread.block_id] = (counts[thread.block_id] ?? 0) + 1;
    }
  }
  return { counts, pageLevel, open };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** Each user's badge from their CURRENT accepted membership in the classroom. */
async function authorBadges(
  classroomId: string,
  userIds: Iterable<string>
): Promise<Map<string, AuthorBadge | null>> {
  const ids = [...new Set(userIds)];
  const badges = new Map<string, AuthorBadge | null>();
  if (ids.length === 0) return badges;
  const rows = await getPrisma().classroomMembership.findMany({
    where: { classroom_id: classroomId, user_id: { in: ids }, has_accepted_invite: true },
    select: { user_id: true, role: true },
  });
  for (const row of rows) {
    const badge = badgeForRole(row.role);
    const current = badges.get(row.user_id) ?? null;
    if (current !== 'Instructor') badges.set(row.user_id, badge ?? current);
  }
  return badges;
}

function userIdsOf(rows: readonly ThreadRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.resolved_by) ids.push(row.resolved_by.id);
    for (const comment of row.comments) if (comment.author) ids.push(comment.author.id);
  }
  return ids;
}

async function toDtos(ctx: CommentContext, rows: readonly ThreadRow[]): Promise<Thread[]> {
  const badges = await authorBadges(ctx.page.classroom_id, userIdsOf(rows));
  return rows.map(row =>
    toThreadDto(row, { viewerUserId: ctx.userId, access: ctx.access, badges })
  );
}

/** The page scope every query carries: this page AND its own classroom. */
const pageScope = (ctx: CommentContext) => ({
  page_id: ctx.page.id,
  classroom_id: ctx.page.classroom_id,
});

function usableContext(ctx: CommentContext): boolean {
  return (
    isSectionId(ctx?.page?.id) && isSectionId(ctx?.page?.classroom_id) && isSectionId(ctx?.userId)
  );
}

/**
 * Every thread on the page this viewer sees (open and resolved), in thread
 * order, or null when the viewer may not read the page's comments.
 */
export async function listThreads(ctx: CommentContext): Promise<Thread[] | null> {
  if (!ctx?.access?.canRead || !usableContext(ctx)) return null;
  const rows = await getPrisma().pageCommentThread.findMany({
    where: pageScope(ctx),
    include: THREAD_INCLUDE,
  });
  const visible = rows.filter(row => threadVisible(row, ctx.filter));
  return toDtos(ctx, sortThreads(visible, ctx.blockOrder));
}

/**
 * Open visible threads per block, page-level and in total (the loader's
 * badge counts), or null when the viewer may not read the page's comments.
 */
export async function countsForViewer(ctx: CommentContext): Promise<CommentCounts | null> {
  if (!ctx?.access?.canRead || !usableContext(ctx)) return null;
  const rows = await getPrisma().pageCommentThread.findMany({
    where: { ...pageScope(ctx), resolved_at: null },
    select: { block_id: true, locked_section_id: true, resolved_at: true },
  });
  return countOpenThreads(rows, ctx.filter);
}

async function threadDto(ctx: CommentContext, threadId: string): Promise<Thread | null> {
  const row = await getPrisma().pageCommentThread.findFirst({
    where: { id: threadId, ...pageScope(ctx) },
    include: THREAD_INCLUDE,
  });
  if (!row) return null;
  const [dto] = await toDtos(ctx, [row]);
  return dto ?? null;
}

// ── Writes ─────────────────────────────────────────────────────────────────

/** What a write did, for the audit row (`commentAuditRow`). No body text. */
export type PageCommentEvent =
  | {
      tool: 'page_comment';
      action: 'CREATE';
      thread_id: string;
      comment_id: string;
      new_thread: boolean;
      block_id: string | null;
      quote_length: number;
      body_length: number;
    }
  | {
      tool: 'page_comment';
      action: 'UPDATE';
      thread_id: string;
      comment_id: string;
      body_length: number;
    }
  | {
      tool: 'page_comment';
      action: 'DELETE';
      thread_id: string;
      comment_id: string;
      thread_deleted: boolean;
      /** A moderator deleted someone else's (or a deleted user's) comment. */
      moderated: boolean;
      /** The deleted comment's author, when moderated (null: a deleted user). */
      comment_author_id?: string | null;
    }
  | {
      tool: 'page_comment_reaction';
      action: 'CREATE' | 'DELETE';
      thread_id: string;
      comment_id: string;
      emoji: string;
    }
  | {
      tool: 'page_comment_thread';
      action: 'UPDATE';
      thread_id: string;
      resolved: boolean;
    };

/** Every write's answer: the thread as the actor now sees it (null: gone). */
export interface CommentWriteResult {
  thread: Thread | null;
  /** False when the write was a no-op (same body, reaction already there, ...). */
  changed: boolean;
  /** The audit event, or null when nothing changed (callers write no row). */
  event: PageCommentEvent | null;
}

/** Writes need read access (else not found) and a classroom open for writing. */
function requireWriter(ctx: CommentContext): void {
  if (!ctx?.access?.canRead || !usableContext(ctx)) throw new PageCommentsNotFoundError();
  if (ctx.access.frozen || !ctx.access.canWrite) {
    throw new PageCommentsForbiddenError(
      'CLASSROOM_LOCKED',
      'This class is in read-only mode. The owner has locked it.'
    );
  }
}

const isMissingRelation = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2003' || code === 'P2025';
};

type Tx = Prisma.TransactionClient;

/**
 * Lock one thread row (on this page) for the rest of the transaction, so
 * "insert a comment into it" and "delete it once it has no comment left"
 * serialize: under READ COMMITTED a reply inserted while the last comment is
 * deleted would otherwise be cascaded away after it reported success. Null
 * when the thread is gone.
 */
async function lockThread(
  tx: Tx,
  ctx: CommentContext,
  threadId: string
): Promise<{ id: string; resolved_at: Date | null } | null> {
  const rows = await tx.$queryRaw<{ id: string; resolved_at: Date | null }[]>`
    SELECT id, resolved_at FROM page_comment_threads
    WHERE id = ${threadId} AND page_id = ${ctx.page.id} AND classroom_id = ${ctx.page.classroom_id}
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** Lock one comment row for the transaction (the distinct-emoji cap holds under concurrency). */
async function lockComment(tx: Tx, commentId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM page_comments WHERE id = ${commentId} FOR UPDATE`;
  return rows.length > 0;
}

/** The thread, on this page, visible to this reader; else not found. */
async function findVisibleThread(ctx: CommentContext, threadId: unknown) {
  requireId(threadId, 'thread');
  const thread = await getPrisma().pageCommentThread.findFirst({
    where: { id: threadId, ...pageScope(ctx) },
    select: { id: true, block_id: true, locked_section_id: true, resolved_at: true },
  });
  if (!thread || !threadVisible(thread, ctx.filter)) throw new PageCommentsNotFoundError();
  return thread;
}

/** The comment, in a thread on this page visible to this reader; else not found. */
async function findVisibleComment(ctx: CommentContext, commentId: unknown) {
  requireId(commentId, 'comment');
  const comment = await getPrisma().pageComment.findFirst({
    where: { id: commentId, thread: pageScope(ctx) },
    select: {
      id: true,
      author_id: true,
      body: true,
      thread: { select: { id: true, block_id: true, locked_section_id: true } },
    },
  });
  if (!comment || !threadVisible(comment.thread, ctx.filter)) {
    throw new PageCommentsNotFoundError();
  }
  return comment;
}

/** Start a thread (on the page, a block, or a quote in a block) with its first comment. */
export async function createThread(
  ctx: CommentContext,
  input: { blockId?: unknown; quote?: unknown; quoteOccurrence?: unknown; body: unknown }
): Promise<CommentWriteResult> {
  requireWriter(ctx);
  const body = cleanCommentBody(input?.body);
  const anchor = resolveCommentAnchor({
    readerBlocks: ctx.readerBlocks,
    fullBlocks: ctx.fullBlocks,
    blockId: input?.blockId,
    quote: input?.quote,
    quoteOccurrence: input?.quoteOccurrence,
  });

  let created: { id: string; comments: { id: string }[] };
  try {
    created = await getPrisma().pageCommentThread.create({
      data: {
        page_id: ctx.page.id,
        classroom_id: ctx.page.classroom_id,
        block_id: anchor.blockId,
        quote: anchor.quote,
        quote_occurrence: anchor.quoteOccurrence,
        locked_section_id: anchor.lockedSectionId,
        created_by_id: ctx.userId,
        comments: { create: { author_id: ctx.userId, body } },
      },
      select: { id: true, comments: { select: { id: true } } },
    });
  } catch (error) {
    if (isMissingRelation(error)) throw new PageCommentsNotFoundError();
    throw error;
  }

  return {
    thread: await threadDto(ctx, created.id),
    changed: true,
    event: {
      tool: 'page_comment',
      action: 'CREATE',
      thread_id: created.id,
      comment_id: created.comments[0]?.id ?? '',
      new_thread: true,
      block_id: anchor.blockId,
      quote_length: anchor.quote?.length ?? 0,
      body_length: body.length,
    },
  };
}

/** Reply to an open thread. A resolved thread refuses replies until reopened. */
export async function reply(
  ctx: CommentContext,
  input: { threadId: unknown; body: unknown }
): Promise<CommentWriteResult> {
  requireWriter(ctx);
  const body = cleanCommentBody(input?.body);
  const thread = await findVisibleThread(ctx, input?.threadId);
  if (thread.resolved_at !== null) {
    throw invalid('THREAD_RESOLVED', 'This thread is resolved. Reopen it to reply.');
  }

  // Under the thread's row lock: a concurrent delete of its last comment
  // either ran first (the thread is gone → not found) or waits and then sees
  // this reply; a concurrent resolve is seen here too.
  const comment = await getPrisma().$transaction(async tx => {
    const locked = await lockThread(tx, ctx, thread.id);
    if (!locked) throw new PageCommentsNotFoundError();
    if (locked.resolved_at !== null) {
      throw invalid('THREAD_RESOLVED', 'This thread is resolved. Reopen it to reply.');
    }
    return tx.pageComment.create({
      data: { thread_id: thread.id, author_id: ctx.userId, body },
      select: { id: true },
    });
  });

  return {
    thread: await threadDto(ctx, thread.id),
    changed: true,
    event: {
      tool: 'page_comment',
      action: 'CREATE',
      thread_id: thread.id,
      comment_id: comment.id,
      new_thread: false,
      block_id: thread.block_id,
      quote_length: 0,
      body_length: body.length,
    },
  };
}

/** Edit one's own comment. The same body again is a no-op (no "edited" mark). */
export async function editComment(
  ctx: CommentContext,
  input: { commentId: unknown; body: unknown }
): Promise<CommentWriteResult> {
  requireWriter(ctx);
  const body = cleanCommentBody(input?.body);
  const comment = await findVisibleComment(ctx, input?.commentId);
  if (comment.author_id === null || comment.author_id !== ctx.userId) {
    throw new PageCommentsForbiddenError('NOT_AUTHOR', 'Only the author can edit a comment.');
  }

  if (comment.body === body) {
    return { thread: await threadDto(ctx, comment.thread.id), changed: false, event: null };
  }

  const { count } = await getPrisma().pageComment.updateMany({
    where: { id: comment.id, author_id: ctx.userId, thread: pageScope(ctx) },
    data: { body, edited_at: new Date() },
  });
  if (count === 0) throw new PageCommentsNotFoundError();

  return {
    thread: await threadDto(ctx, comment.thread.id),
    changed: true,
    event: {
      tool: 'page_comment',
      action: 'UPDATE',
      thread_id: comment.thread.id,
      comment_id: comment.id,
      body_length: body.length,
    },
  };
}

/**
 * Delete a comment: one's own, or anyone's for a moderator (accepted
 * OWNER/TEACHER; flagged `moderated`). Its reactions go with it; a thread
 * left without comments is deleted too (`thread: null`).
 */
export async function deleteComment(
  ctx: CommentContext,
  input: { commentId: unknown }
): Promise<CommentWriteResult> {
  requireWriter(ctx);
  const comment = await findVisibleComment(ctx, input?.commentId);
  const own = comment.author_id !== null && comment.author_id === ctx.userId;
  if (!own && !ctx.access.canModerate) {
    throw new PageCommentsForbiddenError('NOT_AUTHOR', 'Only the author can delete a comment.');
  }
  const threadId = comment.thread.id;

  const { removed, threadDeleted } = await getPrisma().$transaction(async tx => {
    // The thread's row lock makes "no comment left → delete the thread"
    // atomic with respect to replies (which take the same lock).
    if (!(await lockThread(tx, ctx, threadId))) return { removed: false, threadDeleted: false };
    const { count } = await tx.pageComment.deleteMany({
      where: { id: comment.id, thread: pageScope(ctx) },
    });
    // Only a thread that has NO comment left goes.
    const gone = await tx.pageCommentThread.deleteMany({
      where: { id: threadId, ...pageScope(ctx), comments: { none: {} } },
    });
    return { removed: count > 0, threadDeleted: gone.count > 0 };
  });

  const thread = threadDeleted ? null : await threadDto(ctx, threadId);
  if (!removed) return { thread, changed: false, event: null };

  return {
    thread,
    changed: true,
    event: {
      tool: 'page_comment',
      action: 'DELETE',
      thread_id: threadId,
      comment_id: comment.id,
      thread_deleted: threadDeleted,
      moderated: !own,
      ...(own ? {} : { comment_author_id: comment.author_id }),
    },
  };
}

/**
 * Add (`on: true`) or remove the viewer's reaction with one emoji on a
 * comment. Idempotent both ways. A comment holds at most 20 distinct emoji.
 */
export async function setReaction(
  ctx: CommentContext,
  input: { commentId: unknown; emoji: unknown; on: unknown }
): Promise<CommentWriteResult> {
  requireWriter(ctx);
  const { commentId, emoji, on } = input ?? ({} as Partial<typeof input>);
  if (typeof on !== 'boolean') throw invalid('INVALID_VALUE', 'Invalid reaction value');
  // Removing reads any stored-looking string, so a reaction stored under an
  // older rule can still be taken back; adding needs exactly one emoji.
  if (
    typeof emoji !== 'string' ||
    !(on
      ? isValidReactionEmoji(emoji)
      : emoji.length > 0 && emoji.length <= REACTION_EMOJI_MAX_LENGTH)
  ) {
    throw invalid('INVALID_EMOJI', 'React with one emoji.');
  }
  const comment = await findVisibleComment(ctx, commentId);

  let changed: boolean;
  if (on) {
    // Check-then-insert under the comment's row lock, so concurrent reactions
    // cannot push a comment past the distinct-emoji cap.
    changed = await getPrisma().$transaction(async tx => {
      if (!(await lockComment(tx, comment.id))) throw new PageCommentsNotFoundError();
      const present = await tx.pageCommentReaction.findMany({
        where: { comment_id: comment.id },
        distinct: ['emoji'],
        select: { emoji: true },
      });
      if (!present.some(row => row.emoji === emoji) && present.length >= MAX_DISTINCT_REACTIONS) {
        throw invalid(
          'TOO_MANY_REACTIONS',
          `A comment can have at most ${MAX_DISTINCT_REACTIONS} different emoji.`
        );
      }
      const { count } = await tx.pageCommentReaction.createMany({
        data: [{ comment_id: comment.id, user_id: ctx.userId, emoji }],
        skipDuplicates: true,
      });
      return count > 0;
    });
  } else {
    const { count } = await getPrisma().pageCommentReaction.deleteMany({
      where: { comment_id: comment.id, user_id: ctx.userId, emoji },
    });
    changed = count > 0;
  }

  return {
    thread: await threadDto(ctx, comment.thread.id),
    changed,
    event: changed
      ? {
          tool: 'page_comment_reaction',
          action: on ? 'CREATE' : 'DELETE',
          thread_id: comment.thread.id,
          comment_id: comment.id,
          emoji,
        }
      : null,
  };
}

/** Resolve (`resolved: true`) or reopen a thread: the teaching team. Idempotent. */
export async function setResolved(
  ctx: CommentContext,
  input: { threadId: unknown; resolved: unknown }
): Promise<CommentWriteResult> {
  requireWriter(ctx);
  if (!ctx.access.canResolve) {
    throw new PageCommentsForbiddenError(
      'NOT_TEACHING_TEAM',
      'Only the teaching team can resolve threads.'
    );
  }
  const resolved = input?.resolved;
  if (typeof resolved !== 'boolean') throw invalid('INVALID_VALUE', 'Invalid resolved value');
  const thread = await findVisibleThread(ctx, input?.threadId);

  const { count } = await getPrisma().pageCommentThread.updateMany({
    where: resolved
      ? { id: thread.id, ...pageScope(ctx), resolved_at: null }
      : { id: thread.id, ...pageScope(ctx), resolved_at: { not: null } },
    data: resolved
      ? { resolved_at: new Date(), resolved_by_id: ctx.userId }
      : { resolved_at: null, resolved_by_id: null },
  });
  const changed = count > 0;

  return {
    thread: await threadDto(ctx, thread.id),
    changed,
    event: changed
      ? { tool: 'page_comment_thread', action: 'UPDATE', thread_id: thread.id, resolved }
      : null,
  };
}

// ── Audit ──────────────────────────────────────────────────────────────────

/** `ClassmojiService.audit.create`'s first argument. */
export interface CommentAuditRow {
  user_id: string;
  classroom_id: string;
  role: Role;
  resource_type: 'PAGES';
  resource_id: string;
  action: AuditLogAction;
  data: Prisma.InputJsonObject;
}

/**
 * The audit row for one comment write (plan D8), identical on the web and the
 * MCP except `via`. Resource = the page; `data.tool` names the surface
 * (`page_comment`, `page_comment_reaction`, `page_comment_thread`); ids, the
 * body's LENGTH and the emoji only, never the body or quote text. Null when
 * the event is null (nothing changed) or the actor has no accepted role.
 * Callers write it with `{ dedupe: false }`: every row is a distinct event.
 */
export function commentAuditRow({
  ctx,
  event,
  via,
  impersonatedBy,
}: {
  ctx: Pick<CommentContext, 'page' | 'userId' | 'access'>;
  event: PageCommentEvent | null;
  via: 'web' | 'mcp';
  impersonatedBy?: string | null;
}): CommentAuditRow | null {
  if (!event || !ctx.access.role) return null;
  const { action, ...fields } = event;
  return {
    user_id: ctx.userId,
    classroom_id: ctx.page.classroom_id,
    role: ctx.access.role,
    resource_type: 'PAGES',
    resource_id: ctx.page.id,
    action,
    data: {
      ...fields,
      via,
      page_id: ctx.page.id,
      ...(impersonatedBy ? { impersonated_by: impersonatedBy } : {}),
    },
  };
}
