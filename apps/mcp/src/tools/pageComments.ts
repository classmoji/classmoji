/**
 * Page comments over MCP: the same threads, replies, reactions and
 * resolve/reopen as the comment panel of a course page (apps/pages).
 *
 *   - `page_comments_list` (read): the threads the caller sees on one page,
 *     with a plain-text excerpt of each thread's block from the CALLER's
 *     redacted tree, the ids to act on, and what the caller may do.
 *   - `page_comment_create`: a new thread (page, block or quote) or a reply.
 *   - `page_comment_update`: edit one's own comment.
 *   - `page_comment_delete`: one's own comment, or anyone's for an accepted
 *     OWNER/TEACHER (audited `moderated: true`). Destructive.
 *   - `page_comment_react`: add or remove one's own emoji reaction.
 *   - `page_comment_resolve`: resolve or reopen a thread (teaching team).
 *   - `openCommentFields`: `content_get`'s `open_comments` count.
 *
 * Every rule lives in `ClassmojiService.pageComments` (the pages app's
 * `/api/page-comments` reads the same one): who reads and writes
 * (`commentAccess`: ACCEPTED members only, drafts for `canViewDrafts`, a
 * LOCKED classroom read-only for all but its owner), which threads a reader
 * sees (a thread inside a locked body they have not unlocked does not exist
 * for them), what a write may hold, and the audit row each write leaves.
 * This file adds the transport: the page is found by a query naming the
 * bound classroom, its blocks are read the way `page_section_*` read them,
 * service errors become ToolErrors, and audit rows go through `writeAudit`.
 *
 * The registry's role gate reads memberships in any invite state, so a
 * pending invitee passes it; the service's accepted-member check answers
 * them "not found", as the page does. Writes are not `readerState`: the
 * registry's mutation gate refuses them in a LOCKED classroom (CLASSROOM_LOCKED)
 * and the service refuses the same with the same code, so web and MCP agree.
 *
 * Reads write no VIEW row (plan D8): the thread list is the shared discussion
 * every member sees, not a staff view of student activity.
 *
 * Which document: a page editor who edits live reads the live document
 * (falling back to git), everyone else git's copy, as on the page; a page
 * without content.json is an empty document (page-level threads only).
 *
 * Impersonation and Ask Moji: write tools need the `write` scope, which is
 * never issued while impersonating, and Ask Moji's minted tokens are
 * read-only (`ASK_MOJI_SCOPES`), so it sees `page_comments_list` only. A
 * session run under impersonation (`impersonatedBy`) is listed with every
 * write flag off and its writes are refused, as on the page.
 */

import { z } from 'zod';
import { ClassmojiService } from '@classmoji/services';
import {
  blockText,
  countQuoteOccurrences,
  findBlock,
  normalizeQuoteText,
  quoteOccurrenceIndex,
} from '@classmoji/page-schema/sections';
import type { ClassroomStatus } from '@prisma/client';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { MEMBER } from '../resources/shape.ts';
import { liveStateFor } from '../collab/client.ts';
import { readLivePage } from '../collab/livePage.ts';
import {
  containsLockedSection,
  findPageInClassroom,
  loadPageBlocks,
  readerRuleFor,
  type SectionPageRecord,
  type SectionReaderRule,
} from './pageSections.ts';
import { TEACHING_TEAM, ok, scopedNotFound, writeAudit } from './shared.ts';

type CommentsService = typeof ClassmojiService.pageComments;
type CommentContext = ReturnType<CommentsService['commentContext']>;
type Thread = NonNullable<Awaited<ReturnType<CommentsService['listThreads']>>>[number];
type WriteResult = Awaited<ReturnType<CommentsService['createThread']>>;
type CommentAccess = CommentContext['access'];

// ─── The caller's comment context on one page ───────────────────────────────

/** The page row as the comment rules read it: its own classroom's status. */
function commentPageOf(page: SectionPageRecord) {
  const status = page.classroom?.status;
  return {
    id: page.id,
    classroom_id: page.classroom_id,
    is_draft: page.is_draft,
    // An unknown status admits nobody (the service's rule).
    classroom: { status: typeof status === 'string' ? status : '' },
  };
}

/** What the caller may do with this page's comments (the service's `commentAccess`). */
function accessOf(page: SectionPageRecord, rule: SectionReaderRule) {
  const commentPage = commentPageOf(page);
  return ClassmojiService.pageComments.commentAccess({
    viewer: rule,
    page: commentPage,
    classroom: commentPage.classroom,
  });
}

/**
 * The access a session acts with: one a platform admin runs while viewing as
 * someone (Ask Moji under impersonation) reads and never writes, every write
 * flag off — the pages app's `accessForSession`.
 */
function actingAccess(access: CommentAccess, ctx: ToolContext): CommentAccess {
  if (!ctx.viewer.impersonatedBy) return access;
  return { ...access, canWrite: false, canResolve: false, canModerate: false };
}

/**
 * The FULL blocks comments are listed and anchored against, from the document
 * the page shows this caller (the pages app's `commentBlocksFor`): a page
 * editor who edits live (OWNER/TEACHER in any invite state, in a live
 * classroom open for their writes) gets the live document through
 * page_content_get's live read, falling back to git's copy on any failure;
 * everyone else gets git's copy. Null when no content.json could be read: a
 * page with none (legacy HTML, nothing saved yet) and a failed read look the
 * same here (`fetchContentText` never throws), so the service fails closed
 * on it: page-level threads only, unless the reader reveals all.
 */
async function commentBlocks(
  page: SectionPageRecord,
  rule: SectionReaderRule,
  label: string
): Promise<unknown[] | null> {
  const status = page.classroom?.status;
  const editsLive =
    rule.canEditAnyState &&
    rule.role !== null &&
    typeof status === 'string' &&
    ClassmojiService.pageComments.canMutateClassroomStatus({
      status: status as ClassroomStatus,
      role: rule.role,
    });
  const live = editsLive ? liveStateFor(page.classroom) : null;
  if (live?.env) {
    try {
      // No viewer: a comment read is not an editing read, so it pins nothing.
      const read = await readLivePage(live.env, page, null);
      if ('snapshot' in read) {
        const blocks = (read.snapshot.content as { blocks?: unknown } | null)?.blocks;
        return Array.isArray(blocks) ? blocks : [];
      }
    } catch (error) {
      console.warn('[mcp] page comments: live snapshot unavailable; anchoring on git:', error);
    }
  }
  return loadPageBlocks(page, label);
}

/**
 * The caller's context from the blocks (the service's `commentContext`, on
 * the reader rule already read). Their unlocks are read only when they can
 * matter: never for a reader who reveals all or is not an accepted member,
 * and with `unlocks: 'if-locked'` only when the page holds a locked section.
 */
async function contextFrom(
  page: SectionPageRecord,
  rule: SectionReaderRule,
  blocks: unknown[] | null,
  ctx: ToolContext,
  unlocks: 'always' | 'if-locked'
): Promise<CommentContext> {
  const userId = ctx.viewer.userId;
  const commentPage = commentPageOf(page);
  const needUnlocks =
    !rule.revealAll &&
    rule.acceptedRole !== null &&
    (unlocks === 'always' || containsLockedSection(blocks));
  const state = needUnlocks
    ? await ClassmojiService.pageSections.readerState({ pageId: page.id, userId })
    : null;
  const commentCtx = ClassmojiService.pageComments.commentContext({
    userId,
    viewer: rule,
    page: commentPage,
    classroom: commentPage.classroom,
    blocks,
    unlockedSectionIds: state ? Object.keys(state.unlocked) : [],
  });
  return { ...commentCtx, access: actingAccess(commentCtx.access, ctx) };
}

/**
 * The caller's context on a page of the bound classroom, or "not found" when
 * there is no such page here or the caller may not read its comments (not an
 * accepted member, a draft without `canViewDrafts`, UNPUBLISHED for a
 * non-owner). Access is decided before the content is read.
 */
async function commentContextFor(
  pageId: string,
  ctx: ToolContext,
  label: string
): Promise<CommentContext> {
  const [page, rule] = await Promise.all([findPageInClassroom(pageId, ctx), readerRuleFor(ctx)]);
  if (!page || !accessOf(page, rule).canRead) throw scopedNotFound('Page');
  const blocks = await commentBlocks(page, rule, label);
  const commentCtx = await contextFrom(page, rule, blocks, ctx, 'always');
  if (!commentCtx.access.canRead) throw scopedNotFound('Page');
  return commentCtx;
}

/** The service's refusals as the MCP's: 404 → not_found, 403 → forbidden, 400 → invalid_params. */
export function toCommentToolError(error: unknown): unknown {
  const service = ClassmojiService.pageComments;
  if (error instanceof service.PageCommentsNotFoundError) {
    return new ToolError('not_found', 'No such thread or comment on this page');
  }
  if (error instanceof service.PageCommentsForbiddenError) {
    return new ToolError('forbidden', error.message, error.code);
  }
  if (error instanceof service.PageCommentsValidationError) {
    return new ToolError('invalid_params', error.message, error.code);
  }
  return error;
}

/**
 * The audit row the service builds for a write (`via: 'mcp'`, ids and
 * lengths only, never the text), written once per real change. A failed write
 * after the act is logged, never turned into a tool error.
 */
async function auditWrite(
  ctx: ToolContext,
  commentCtx: CommentContext,
  event: WriteResult['event']
): Promise<void> {
  const row = ClassmojiService.pageComments.commentAuditRow({ ctx: commentCtx, event, via: 'mcp' });
  if (!row) return;
  try {
    await writeAudit(ctx, {
      role: row.role,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      action: row.action,
      data: row.data,
      dedupe: false,
    });
  } catch (error) {
    console.warn(`[mcp] page comments audit (${String(row.data.tool)}) failed:`, error);
  }
}

/** Run one service write for the caller, audit it, and present its answer. */
async function runWrite(
  args: { page_id: string },
  ctx: ToolContext,
  label: string,
  write: (commentCtx: CommentContext) => Promise<WriteResult>
) {
  // A write token is never issued while impersonating; refused here too, as
  // on the page.
  if (ctx.viewer.impersonatedBy) {
    throw new ToolError(
      'forbidden',
      'Comments are read-only while viewing as someone else',
      'IMPERSONATED'
    );
  }
  const commentCtx = await commentContextFor(args.page_id, ctx, label);
  let result: WriteResult;
  try {
    result = await write(commentCtx);
  } catch (error) {
    throw toCommentToolError(error);
  }
  await auditWrite(ctx, commentCtx, result.event);
  return { commentCtx, result };
}

// ─── Presenting threads ─────────────────────────────────────────────────────

const EXCERPT_MAX_LENGTH = 240;

/**
 * A short plain-text excerpt of a thread's block, from the reader's REDACTED
 * tree only (a locked body the reader has not opened is not in it), centred
 * on the quote when the block is long. Null for a page-level thread or a
 * block that is gone.
 */
export function blockExcerpt(
  readerBlocks: unknown[],
  blockId: string | null,
  quote: string | null,
  quoteOccurrence: number
): string | null {
  if (!blockId) return null;
  const block = findBlock(readerBlocks, blockId);
  if (!block) return null;
  const text = normalizeQuoteText(blockText(block)).trim();
  if (text.length <= EXCERPT_MAX_LENGTH) return text;
  let start = 0;
  if (quote) {
    const at = quoteOccurrenceIndex(text, quote, quoteOccurrence);
    if (at > 0) {
      const room = Math.max(0, EXCERPT_MAX_LENGTH - quote.length);
      start = Math.min(Math.max(0, at - Math.floor(room / 2)), text.length - EXCERPT_MAX_LENGTH);
    }
  }
  const end = start + EXCERPT_MAX_LENGTH;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Every block in document order, at any depth (children included). */
function blocksInOrder(blocks: unknown, out: Array<{ id: string; block: unknown }> = []) {
  if (!Array.isArray(blocks)) return out;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const id = (block as { id?: unknown }).id;
    if (typeof id === 'string' && id) out.push({ id, block });
    blocksInOrder((block as { children?: unknown }).children, out);
  }
  return out;
}

/**
 * A quote given without a block: the block of its `occurrence`-th match
 * (0-based) on the page, counting block by block in document order over the
 * reader's REDACTED tree, and the match's index inside that block. Null when
 * the page has no such match. Linear: each block's matches are counted once
 * and whole blocks are skipped. The service then checks the anchor as usual.
 */
export function locateQuote(
  readerBlocks: unknown[],
  quote: string,
  occurrence: number
): { blockId: string; quoteOccurrence: number } | null {
  const needle = normalizeQuoteText(quote).trim();
  if (!needle || !Number.isInteger(occurrence) || occurrence < 0) return null;
  let remaining = occurrence;
  for (const { id, block } of blocksInOrder(readerBlocks)) {
    const count = countQuoteOccurrences(blockText(block), needle);
    if (remaining < count) return { blockId: id, quoteOccurrence: remaining };
    remaining -= count;
  }
  return null;
}

/** Where a thread sits for this reader: on the page, on its block, or lost. */
function anchorState(
  readerBlocks: unknown[],
  thread: Pick<Thread, 'blockId' | 'quote' | 'quoteOccurrence'>
): 'page' | 'ok' | 'text_changed' | 'block_removed' {
  if (!thread.blockId) return 'page';
  const block = findBlock(readerBlocks, thread.blockId);
  if (!block) return 'block_removed';
  if (
    thread.quote &&
    quoteOccurrenceIndex(blockText(block), thread.quote, thread.quoteOccurrence) === -1
  ) {
    return 'text_changed';
  }
  return 'ok';
}

/** The contract's `Thread`, in the MCP's snake_case, with its block excerpt. */
export function presentThread(thread: Thread, readerBlocks: unknown[]) {
  return {
    thread_id: thread.id,
    block_id: thread.blockId,
    quote: thread.quote,
    quote_occurrence: thread.quoteOccurrence,
    anchor: anchorState(readerBlocks, thread),
    block_excerpt: blockExcerpt(readerBlocks, thread.blockId, thread.quote, thread.quoteOccurrence),
    resolved: thread.resolvedAt !== null,
    resolved_at: thread.resolvedAt,
    resolved_by: thread.resolvedBy,
    created_at: thread.createdAt,
    comments: thread.comments.map(comment => ({
      comment_id: comment.id,
      author: comment.author,
      body: comment.body,
      created_at: comment.createdAt,
      edited_at: comment.editedAt,
      reactions: comment.reactions,
      can_edit: comment.canEdit,
      can_delete: comment.canDelete,
    })),
  };
}

const presentResult = (commentCtx: CommentContext, result: WriteResult) => ({
  changed: result.changed,
  thread: result.thread ? presentThread(result.thread, commentCtx.readerBlocks) : null,
});

/** content_get's line pointing at the threads. */
export const COMMENTS_HINT =
  'Class members comment on this page: read the threads with page_comments_list.';

/**
 * `content_get`'s comment fields for a page: the caller's visible open thread
 * count (and, when there are any, where to read them), for an accepted member
 * who may read the page's comments; nothing otherwise. `blocks` null (no
 * content.json read) counts page-level threads only for a reader who does not
 * reveal all (see `commentBlocks`). The caller's unlocks are read only when
 * the page holds a locked section. A failure leaves the fields out: the
 * count never fails the read it rides on.
 */
export async function openCommentFields(
  page: SectionPageRecord,
  blocks: unknown[] | null,
  ctx: ToolContext,
  rule?: SectionReaderRule
): Promise<{ open_comments?: number; comments_hint?: string }> {
  try {
    const reader = rule ?? (await readerRuleFor(ctx));
    if (!accessOf(page, reader).canRead) return {};
    const commentCtx = await contextFrom(page, reader, blocks, ctx, 'if-locked');
    const counts = await ClassmojiService.pageComments.countsForViewer(commentCtx);
    if (!counts) return {};
    return {
      open_comments: counts.open,
      ...(counts.open > 0 ? { comments_hint: COMMENTS_HINT } : {}),
    };
  } catch (error) {
    console.warn('[mcp] content_get: open comment count failed:', error);
    return {};
  }
}

// ─── Arguments ──────────────────────────────────────────────────────────────

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");
const pageIdArg = z.string().uuid().describe('Page id (from list_pages or content_list)');
const threadIdArg = z.string().uuid().describe('Thread id, from page_comments_list');
const commentIdArg = z.string().uuid().describe('Comment id, from page_comments_list');
// The service trims, normalizes line endings and enforces 1–4000 characters.
const bodyArg = z
  .string()
  .min(1)
  .max(8000)
  .describe('Comment text (plain text, up to 4000 characters)');

/** The pages app's budgets (COMMENT_RATE_LIMITS): posting 20 and reacting 60 per 10 minutes. */
const CREATE_RATE_LIMIT = { capacity: 20, refillPerSecond: 20 / 600 };
const REACT_RATE_LIMIT = { capacity: 60, refillPerSecond: 60 / 600 };

// ─── page_comments_list ─────────────────────────────────────────────────────

interface ListArgs {
  classroom: string;
  page_id: string;
  status?: 'open' | 'resolved' | 'all';
}

export const pageCommentsListTool: ToolDefinition<ListArgs> = {
  name: 'page_comments_list',
  title: 'List comments on a page',
  description:
    "Lists the comment threads class members left on one course page, as the page's comment " +
    'panel shows them to YOU: in document order, page-level and orphaned threads last. Each ' +
    'thread has its id, its block id, the quoted text if any, `block_excerpt` (the text ' +
    'of that block, so you can see what a correction refers to), `anchor` (ok, page, ' +
    'text_changed: the quote is no longer in the block, block_removed), and its comments with ' +
    'ids, author name and badge (Instructor/TA), body, reactions and whether you may edit or ' +
    'delete each. `viewer` says whether you may comment, resolve and moderate. status: open ' +
    '(default), resolved or all.',
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    page_id: pageIdArg,
    status: z
      .enum(['open', 'resolved', 'all'])
      .optional()
      .describe('Which threads: open (default), resolved or all'),
  },
  handler: async (args, ctx) => {
    const commentCtx = await commentContextFor(args.page_id, ctx, 'page_comments_list');
    const threads = await ClassmojiService.pageComments.listThreads(commentCtx);
    if (!threads) throw scopedNotFound('Page');

    const status = args.status ?? 'open';
    const open = threads.filter(thread => thread.resolvedAt === null);
    const resolved = threads.filter(thread => thread.resolvedAt !== null);
    const shown = status === 'open' ? open : status === 'resolved' ? resolved : threads;
    const { access } = commentCtx;

    return ok({
      page_id: commentCtx.page.id,
      status,
      open: open.length,
      resolved: resolved.length,
      viewer: {
        can_write: access.canWrite,
        can_resolve: access.canResolve,
        can_moderate: access.canModerate,
        frozen: access.frozen,
        // A read-only connection (Ask Moji) cannot call the write tools.
        write_tools: ctx.viewer.scopes.has('write'),
      },
      threads: shown.map(thread => presentThread(thread, commentCtx.readerBlocks)),
    });
  },
};

// ─── page_comment_create ────────────────────────────────────────────────────

interface CreateArgs {
  classroom: string;
  page_id: string;
  body: string;
  thread_id?: string;
  block_id?: string;
  quote?: string;
  quote_occurrence?: number;
}

export const pageCommentCreateTool: ToolDefinition<CreateArgs> = {
  name: 'page_comment_create',
  title: 'Comment on a page',
  annotations: { destructive: false, idempotent: false, openWorld: false },
  description:
    'Posts a comment on a course page as YOU; every class member who can read the page sees it ' +
    'with your name. With thread_id it replies to that thread (a resolved thread must be ' +
    'reopened first). Without it, it starts a thread: on the whole page (no block_id, no ' +
    'quote), or on a passage: pass `quote`, the exact text as it reads on the page (content_get ' +
    'shows it); the page is searched in order and quote_occurrence picks the match (0 = first). ' +
    'Page editors (owners, teachers) may also pass block_id, from page_content_get, to anchor ' +
    'on that block (and a quote inside it). Text you cannot see cannot be commented on.',
  scope: 'write',
  roles: MEMBER,
  rateLimit: CREATE_RATE_LIMIT,
  inputSchema: {
    classroom: classroomArg,
    page_id: pageIdArg,
    body: bodyArg,
    thread_id: threadIdArg.optional().describe('Reply to this thread instead of starting one'),
    block_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, 'Must be a block id')
      .optional()
      .describe(
        'Block id from page_content_get (page editors); omit to anchor by quote or on the page'
      ),
    quote: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('Text on the page to anchor on (up to 500 characters)'),
    quote_occurrence: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe('Which match of the quote, 0-based (default 0): in the block, or on the page'),
  },
  handler: async (args, ctx) => {
    const replying = args.thread_id !== undefined;
    if (
      replying &&
      (args.block_id !== undefined ||
        args.quote !== undefined ||
        args.quote_occurrence !== undefined)
    ) {
      throw new ToolError(
        'invalid_params',
        'A reply takes thread_id only; block_id, quote and quote_occurrence start a new thread'
      );
    }
    const { commentCtx, result } = await runWrite(args, ctx, 'page_comment_create', commentCtx =>
      replying
        ? ClassmojiService.pageComments.reply(commentCtx, {
            threadId: args.thread_id,
            body: args.body,
          })
        : ClassmojiService.pageComments.createThread(commentCtx, {
            ...anchorFor(commentCtx, args),
            body: args.body,
          })
    );
    const event = result.event;
    return ok({
      page_id: commentCtx.page.id,
      ...(event && 'comment_id' in event ? { comment_id: event.comment_id } : {}),
      new_thread: !replying,
      ...presentResult(commentCtx, result),
    });
  },
};

/** A new thread's anchor: as given, or a block-less quote located on the page. */
function anchorFor(commentCtx: CommentContext, args: CreateArgs) {
  if (args.block_id !== undefined || args.quote === undefined) {
    return { blockId: args.block_id, quote: args.quote, quoteOccurrence: args.quote_occurrence };
  }
  const located = locateQuote(commentCtx.readerBlocks, args.quote, args.quote_occurrence ?? 0);
  if (!located) {
    throw new ToolError('invalid_params', 'That text is not on this page', 'INVALID_QUOTE');
  }
  return { blockId: located.blockId, quote: args.quote, quoteOccurrence: located.quoteOccurrence };
}

// ─── page_comment_update ────────────────────────────────────────────────────

interface UpdateArgs {
  classroom: string;
  page_id: string;
  comment_id: string;
  body: string;
}

export const pageCommentUpdateTool: ToolDefinition<UpdateArgs> = {
  name: 'page_comment_update',
  title: 'Edit your comment on a page',
  annotations: { destructive: false, idempotent: true, openWorld: false },
  description:
    'Replaces the text of one of YOUR OWN comments on a course page; readers see it marked ' +
    '"(edited)". Only the author can edit a comment. The same text again changes nothing.',
  scope: 'write',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    page_id: pageIdArg,
    comment_id: commentIdArg,
    body: bodyArg,
  },
  handler: async (args, ctx) => {
    const { commentCtx, result } = await runWrite(args, ctx, 'page_comment_update', commentCtx =>
      ClassmojiService.pageComments.editComment(commentCtx, {
        commentId: args.comment_id,
        body: args.body,
      })
    );
    return ok({
      page_id: commentCtx.page.id,
      comment_id: args.comment_id,
      ...presentResult(commentCtx, result),
    });
  },
};

// ─── page_comment_delete ────────────────────────────────────────────────────

interface DeleteArgs {
  classroom: string;
  page_id: string;
  comment_id: string;
}

export const pageCommentDeleteTool: ToolDefinition<DeleteArgs> = {
  name: 'page_comment_delete',
  title: 'Delete a comment on a page',
  annotations: { destructive: true, idempotent: false, openWorld: false },
  description:
    'Permanently deletes one comment on a course page, with its reactions; a thread left ' +
    'without comments is deleted too. You may delete your own comments; class owners and ' +
    "teachers may delete anyone's (recorded as moderation). Cannot be undone: confirm first.",
  scope: 'write',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    page_id: pageIdArg,
    comment_id: commentIdArg,
  },
  handler: async (args, ctx) => {
    const { commentCtx, result } = await runWrite(args, ctx, 'page_comment_delete', commentCtx =>
      ClassmojiService.pageComments.deleteComment(commentCtx, { commentId: args.comment_id })
    );
    const event = result.event;
    return ok({
      page_id: commentCtx.page.id,
      comment_id: args.comment_id,
      deleted: result.changed,
      thread_deleted:
        event?.tool === 'page_comment' && event.action === 'DELETE' ? event.thread_deleted : false,
      ...presentResult(commentCtx, result),
    });
  },
};

// ─── page_comment_react ─────────────────────────────────────────────────────

interface ReactArgs {
  classroom: string;
  page_id: string;
  comment_id: string;
  emoji: string;
  on: boolean;
}

export const pageCommentReactTool: ToolDefinition<ReactArgs> = {
  name: 'page_comment_react',
  title: 'React to a comment on a page',
  annotations: { destructive: false, idempotent: true, openWorld: false },
  description:
    'Adds (on: true) or removes (on: false) YOUR emoji reaction on one comment of a course ' +
    'page. emoji is exactly one emoji (e.g. 👍); a comment holds at most 20 different emoji. ' +
    'Repeating the call changes nothing.',
  scope: 'write',
  roles: MEMBER,
  rateLimit: REACT_RATE_LIMIT,
  inputSchema: {
    classroom: classroomArg,
    page_id: pageIdArg,
    comment_id: commentIdArg,
    emoji: z.string().min(1).max(32).describe('One emoji'),
    on: z.boolean().describe('true = add your reaction, false = remove it'),
  },
  handler: async (args, ctx) => {
    const { commentCtx, result } = await runWrite(args, ctx, 'page_comment_react', commentCtx =>
      ClassmojiService.pageComments.setReaction(commentCtx, {
        commentId: args.comment_id,
        emoji: args.emoji,
        on: args.on,
      })
    );
    return ok({
      page_id: commentCtx.page.id,
      comment_id: args.comment_id,
      ...presentResult(commentCtx, result),
    });
  },
};

// ─── page_comment_resolve ───────────────────────────────────────────────────

interface ResolveArgs {
  classroom: string;
  page_id: string;
  thread_id: string;
  resolved: boolean;
}

export const pageCommentResolveTool: ToolDefinition<ResolveArgs> = {
  name: 'page_comment_resolve',
  title: 'Resolve or reopen a comment thread',
  annotations: { destructive: false, idempotent: true, openWorld: false },
  description:
    'Resolves (resolved: true) or reopens (resolved: false) one comment thread on a course ' +
    'page. Teaching team only. A resolved thread leaves the page highlights and moves to the ' +
    "panel's Resolved tab; everyone can still read it, and nobody can reply until it is reopened.",
  scope: 'write',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: classroomArg,
    page_id: pageIdArg,
    thread_id: threadIdArg,
    resolved: z.boolean().describe('true = resolve, false = reopen'),
  },
  handler: async (args, ctx) => {
    const { commentCtx, result } = await runWrite(args, ctx, 'page_comment_resolve', commentCtx =>
      ClassmojiService.pageComments.setResolved(commentCtx, {
        threadId: args.thread_id,
        resolved: args.resolved,
      })
    );
    return ok({
      page_id: commentCtx.page.id,
      thread_id: args.thread_id,
      resolved: args.resolved,
      ...presentResult(commentCtx, result),
    });
  },
};

export const pageCommentTools = [
  pageCommentsListTool,
  pageCommentCreateTool,
  pageCommentUpdateTool,
  pageCommentDeleteTool,
  pageCommentReactTool,
  pageCommentResolveTool,
] as const;
