/**
 * Page comments on the pages app: the `/api/page-comments` handlers, the rate
 * limit, and the loader's `readerComments`.
 *
 * The handlers are driven end to end with fake lookups (no Postgres, no
 * content repo), the `page-sections.spec.ts` approach. The REAL service
 * module is wired in for everything that is not a query: `commentAccess`,
 * `commentContext` (redaction, thread filter), `commentAuditRow`,
 * `toThreadDto`, the body/anchor/emoji validators and the error classes. Only
 * the database calls (`listThreads` and the six writes) are an in-memory
 * store here, scoped and refused the way the service's are (it throws the
 * service's own errors). So the access rule, the status mapping, the
 * impersonation clamp and the audit row are real; the per-write rules
 * themselves (author-only edit, scoping by page AND classroom) are covered
 * against a real database in the services' pageComments tests, and here only
 * through the fake.
 *
 * The page loader needs Postgres to run, so where `readerComments` sits in it
 * is pinned from source, and its pure builder is called directly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import * as service from '../../../../packages/services/src/classmoji/pageComments.service.ts';
import {
  COMMENT_RATE_LIMITS,
  COMMENT_REQUEST_MAX_BYTES,
  accessForSession,
  createCommentRateLimiter,
  handleCommentsGet,
  handleCommentsPost,
  parseCommentRequest,
  readerCommentsFor,
  commentBlocksFor,
  type CommentAuditRow,
  type CommentContext,
  type CommentViewer,
  type PageCommentsDeps,
} from '~/utils/pageComments.server.ts';
import { SECTION_NO_STORE_HEADERS, type SectionsPage } from '~/utils/pageSections.server.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

// ── Fixture document ───────────────────────────────────────────────────────
// A paragraph, and a locked section whose body holds a paragraph only a
// reader who unlocked it (or the teaching team) sees.

function fixture() {
  return [
    { id: 'p-1', type: 'paragraph', props: {}, content: text('Hello world'), children: [] },
    {
      id: 'lock',
      type: 'lockedSection',
      props: { title: 'Answers' },
      children: [
        {
          id: 'p-secret',
          type: 'paragraph',
          props: {},
          content: text('SECRET-ANSWER'),
          children: [],
        },
      ],
    },
  ];
}

/** The live document: git's copy plus a block added live, not yet in git. */
function liveFixture() {
  return [
    ...fixture(),
    { id: 'p-live', type: 'paragraph', props: {}, content: text('Added live'), children: [] },
  ];
}

// ── Classrooms, members, pages ─────────────────────────────────────────────

const ORIGIN = 'http://pages.test';
const CLASS_X = 'class-x';
const CLASS_Y = 'class-y';
const CLASS_LOCKED = 'class-locked';
const CLASS_UNPUBLISHED = 'class-unpublished';

type MemberRow = { role: string; accepted: boolean };
const accepted = (role: string): MemberRow => ({ role, accepted: true });
const pending = (role: string): MemberRow => ({ role, accepted: false });

const MEMBERS: Record<string, Record<string, MemberRow[]>> = {
  'student-a': {
    [CLASS_X]: [accepted('STUDENT')],
    [CLASS_LOCKED]: [accepted('STUDENT')],
    [CLASS_UNPUBLISHED]: [accepted('STUDENT')],
  },
  'student-b': { [CLASS_X]: [accepted('STUDENT')] },
  'ta-x': { [CLASS_X]: [accepted('ASSISTANT')] },
  'teacher-x': { [CLASS_X]: [accepted('TEACHER')] },
  'owner-x': {
    [CLASS_X]: [accepted('OWNER')],
    [CLASS_LOCKED]: [accepted('OWNER')],
    [CLASS_UNPUBLISHED]: [accepted('OWNER')],
  },
  'student-y': { [CLASS_Y]: [accepted('STUDENT')] },
  'owner-y': { [CLASS_Y]: [accepted('OWNER')] },
  'pending-x': { [CLASS_X]: [pending('STUDENT')] },
  // Signed in, no membership anywhere.
  stranger: {},
};

const NAMES: Record<string, string> = {
  'student-a': 'Student A',
  'student-b': 'Student B',
  'ta-x': 'TA X',
  'teacher-x': 'Teacher X',
  'owner-x': 'Owner X',
  'student-y': 'Student Y',
  'owner-y': 'Owner Y',
};

/** The service's `sectionViewer`, from membership rows. */
function viewerFrom(rows: MemberRow[]): CommentViewer {
  const rank: Record<string, number> = { OWNER: 4, TEACHER: 3, ASSISTANT: 2, STUDENT: 1 };
  const highest = (roles: string[]) =>
    roles.reduce<string | null>((best, r) => (!best || rank[r]! > rank[best]! ? r : best), null);
  const role = highest(rows.map(r => r.role));
  const acceptedRole = highest(rows.filter(r => r.accepted).map(r => r.role));
  const teachingTeam = acceptedRole !== null && acceptedRole !== 'STUDENT';
  const student = acceptedRole === 'STUDENT';
  const canEditAnyState = role === 'OWNER' || role === 'TEACHER';
  const revealAll = canEditAnyState || teachingTeam;
  return {
    role,
    acceptedRole,
    teachingTeam,
    student,
    canEditAnyState,
    revealAll,
    canUnlock: student && !revealAll,
    canSeeActivity: acceptedRole === 'OWNER' || acceptedRole === 'TEACHER',
    canViewDrafts: role !== null && role !== 'STUDENT',
  } as CommentViewer;
}

/** `live`: the classroom edits live (an editor's loader reads the live document). */
type Page = SectionsPage & { title: string; live?: boolean };

const inClass = (classroomId: string, status = 'ACTIVE') => ({
  classroom_id: classroomId,
  classroom: { status },
});

const PAGES: Record<string, Page> = {
  'page-x': { id: 'page-x', ...inClass(CLASS_X), is_draft: false, title: 'X' },
  'page-x2': { id: 'page-x2', ...inClass(CLASS_X), is_draft: false, title: 'X two' },
  'page-live': { id: 'page-live', ...inClass(CLASS_X), is_draft: false, title: 'Live', live: true },
  'draft-x': { id: 'draft-x', ...inClass(CLASS_X), is_draft: true, title: 'Draft' },
  'page-y': { id: 'page-y', ...inClass(CLASS_Y), is_draft: false, title: 'Y' },
  'page-locked': {
    id: 'page-locked',
    ...inClass(CLASS_LOCKED, 'LOCKED'),
    is_draft: false,
    title: 'Archived',
  },
  'page-unpublished': {
    id: 'page-unpublished',
    ...inClass(CLASS_UNPUBLISHED, 'UNPUBLISHED'),
    is_draft: false,
    title: 'Unpublished',
  },
};

// ── The in-memory store (the service's queries, faked) ─────────────────────

type StoredComment = {
  id: string;
  thread_id: string;
  author_id: string | null;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  reactions: { emoji: string; user_id: string }[];
};

type StoredThread = {
  id: string;
  page_id: string;
  classroom_id: string;
  block_id: string | null;
  quote: string | null;
  quote_occurrence: number;
  locked_section_id: string | null;
  created_by_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by_id: string | null;
  comments: StoredComment[];
};

const { PageCommentsNotFoundError, PageCommentsForbiddenError, PageCommentsValidationError } =
  service;

function makeStore() {
  const threads: StoredThread[] = [];
  let seq = 0;
  let clock = Date.parse('2026-10-29T12:00:00.000Z');
  const nextId = (prefix: string) => `${prefix}-${++seq}`;
  const now = () => new Date((clock += 1000));

  const inScope = (ctx: CommentContext, thread: StoredThread) =>
    thread.page_id === ctx.page.id && thread.classroom_id === ctx.page.classroom_id;

  // The user row as the database holds it: email and git login included, so
  // the wire shape is shown to drop them.
  const author = (id: string | null) =>
    id
      ? { id, name: NAMES[id] ?? null, image: null, email: `${id}@school.test`, login: `gh-${id}` }
      : null;

  // The row `toThreadDto` reads (the service's THREAD_INCLUDE shape).
  const toRow = (thread: StoredThread) =>
    ({
      ...thread,
      resolved_by: author(thread.resolved_by_id),
      comments: thread.comments.map(comment => ({ ...comment, author: author(comment.author_id) })),
    }) as unknown as Parameters<typeof service.toThreadDto>[0];

  const dto = (ctx: CommentContext, thread: StoredThread | undefined) =>
    thread
      ? service.toThreadDto(toRow(thread), {
          viewerUserId: ctx.userId,
          access: ctx.access,
          badges: new Map(),
        })
      : null;

  // The service's requireWriter.
  const requireWriter = (ctx: CommentContext) => {
    if (!ctx.access.canRead) throw new PageCommentsNotFoundError();
    if (ctx.access.frozen || !ctx.access.canWrite) {
      throw new PageCommentsForbiddenError('CLASSROOM_LOCKED', 'This class is in read-only mode.');
    }
  };

  // The service's requireId: an id that is not a string is malformed (400).
  const requireId = (id: unknown) => {
    if (typeof id !== 'string' || id === '') {
      throw new PageCommentsValidationError('INVALID_ID', 'Invalid id');
    }
  };

  const findThread = (ctx: CommentContext, id: unknown) => {
    requireId(id);
    const thread = threads.find(t => t.id === id && inScope(ctx, t));
    if (!thread || !service.threadVisible(thread, ctx.filter)) {
      throw new PageCommentsNotFoundError();
    }
    return thread;
  };

  const findComment = (ctx: CommentContext, id: unknown) => {
    requireId(id);
    for (const thread of threads) {
      if (!inScope(ctx, thread)) continue;
      const comment = thread.comments.find(c => c.id === id);
      if (comment) {
        if (!service.threadVisible(thread, ctx.filter)) break;
        return { thread, comment };
      }
    }
    throw new PageCommentsNotFoundError();
  };

  const rules: PageCommentsDeps['rules'] = {
    ...service,
    async listThreads(ctx) {
      if (!ctx.access.canRead) return null;
      const visible = threads.filter(t => inScope(ctx, t) && service.threadVisible(t, ctx.filter));
      return service.sortThreads(visible, ctx.blockOrder).map(t => dto(ctx, t)!);
    },
    async createThread(ctx, input) {
      requireWriter(ctx);
      const body = service.cleanCommentBody(input.body);
      const anchor = service.resolveCommentAnchor({
        readerBlocks: ctx.readerBlocks,
        fullBlocks: ctx.fullBlocks,
        blockId: input.blockId,
        quote: input.quote,
        quoteOccurrence: input.quoteOccurrence,
      });
      const id = nextId('thread');
      const created = now();
      const comment: StoredComment = {
        id: nextId('comment'),
        thread_id: id,
        author_id: ctx.userId,
        body,
        created_at: created,
        edited_at: null,
        reactions: [],
      };
      const thread: StoredThread = {
        id,
        page_id: ctx.page.id,
        classroom_id: ctx.page.classroom_id,
        block_id: anchor.blockId,
        quote: anchor.quote,
        quote_occurrence: anchor.quoteOccurrence,
        locked_section_id: anchor.lockedSectionId,
        created_by_id: ctx.userId,
        created_at: created,
        resolved_at: null,
        resolved_by_id: null,
        comments: [comment],
      };
      threads.push(thread);
      return {
        thread: dto(ctx, thread),
        changed: true,
        event: {
          tool: 'page_comment',
          action: 'CREATE',
          thread_id: id,
          comment_id: comment.id,
          new_thread: true,
          block_id: anchor.blockId,
          quote_length: anchor.quote?.length ?? 0,
          body_length: body.length,
        },
      };
    },
    async reply(ctx, input) {
      requireWriter(ctx);
      const body = service.cleanCommentBody(input.body);
      const thread = findThread(ctx, input.threadId);
      if (thread.resolved_at) {
        throw new PageCommentsValidationError('THREAD_RESOLVED', 'This thread is resolved.');
      }
      const comment: StoredComment = {
        id: nextId('comment'),
        thread_id: thread.id,
        author_id: ctx.userId,
        body,
        created_at: now(),
        edited_at: null,
        reactions: [],
      };
      thread.comments.push(comment);
      return {
        thread: dto(ctx, thread),
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
    },
    async editComment(ctx, input) {
      requireWriter(ctx);
      const body = service.cleanCommentBody(input.body);
      const { thread, comment } = findComment(ctx, input.commentId);
      if (comment.author_id === null || comment.author_id !== ctx.userId) {
        throw new PageCommentsForbiddenError('NOT_AUTHOR', 'Only the author can edit a comment.');
      }
      if (comment.body === body) return { thread: dto(ctx, thread), changed: false, event: null };
      comment.body = body;
      comment.edited_at = now();
      return {
        thread: dto(ctx, thread),
        changed: true,
        event: {
          tool: 'page_comment',
          action: 'UPDATE',
          thread_id: thread.id,
          comment_id: comment.id,
          body_length: body.length,
        },
      };
    },
    async deleteComment(ctx, input) {
      requireWriter(ctx);
      const { thread, comment } = findComment(ctx, input.commentId);
      const own = comment.author_id !== null && comment.author_id === ctx.userId;
      if (!own && !ctx.access.canModerate) {
        throw new PageCommentsForbiddenError('NOT_AUTHOR', 'Only the author can delete a comment.');
      }
      thread.comments = thread.comments.filter(c => c.id !== comment.id);
      const threadDeleted = thread.comments.length === 0;
      if (threadDeleted) threads.splice(threads.indexOf(thread), 1);
      return {
        thread: threadDeleted ? null : dto(ctx, thread),
        changed: true,
        event: {
          tool: 'page_comment',
          action: 'DELETE',
          thread_id: thread.id,
          comment_id: comment.id,
          thread_deleted: threadDeleted,
          moderated: !own,
          ...(own ? {} : { comment_author_id: comment.author_id }),
        },
      };
    },
    async setReaction(ctx, input) {
      requireWriter(ctx);
      if (typeof input.on !== 'boolean') {
        throw new PageCommentsValidationError('INVALID_VALUE', 'Invalid reaction value');
      }
      if (!service.isValidReactionEmoji(input.emoji)) {
        throw new PageCommentsValidationError('INVALID_EMOJI', 'React with one emoji.');
      }
      const emoji = input.emoji;
      const { thread, comment } = findComment(ctx, input.commentId);
      const index = comment.reactions.findIndex(r => r.emoji === emoji && r.user_id === ctx.userId);
      let changed = false;
      if (input.on && index < 0) {
        comment.reactions.push({ emoji, user_id: ctx.userId });
        changed = true;
      } else if (!input.on && index >= 0) {
        comment.reactions.splice(index, 1);
        changed = true;
      }
      return {
        thread: dto(ctx, thread),
        changed,
        event: changed
          ? {
              tool: 'page_comment_reaction',
              action: input.on ? 'CREATE' : 'DELETE',
              thread_id: thread.id,
              comment_id: comment.id,
              emoji,
            }
          : null,
      };
    },
    async setResolved(ctx, input) {
      requireWriter(ctx);
      if (!ctx.access.canResolve) {
        throw new PageCommentsForbiddenError('NOT_TEACHING_TEAM', 'Only the teaching team.');
      }
      if (typeof input.resolved !== 'boolean') {
        throw new PageCommentsValidationError('INVALID_VALUE', 'Invalid resolved value');
      }
      const thread = findThread(ctx, input.threadId);
      const changed = input.resolved ? thread.resolved_at === null : thread.resolved_at !== null;
      if (changed) {
        thread.resolved_at = input.resolved ? now() : null;
        thread.resolved_by_id = input.resolved ? ctx.userId : null;
      }
      return {
        thread: dto(ctx, thread),
        changed,
        event: changed
          ? {
              tool: 'page_comment_thread',
              action: 'UPDATE',
              thread_id: thread.id,
              resolved: input.resolved,
            }
          : null,
      };
    },
  };

  return { threads, rules };
}

function makeDeps(overrides: Partial<PageCommentsDeps<Page>> = {}) {
  const store = makeStore();
  const calls = {
    loadPageBlocks: 0,
    audit: [] as CommentAuditRow[],
    rateLimit: [] as Array<{ userId: string; kind: string }>,
  };
  const unlocks: Record<string, Record<string, string>> = {}; // userId -> sectionId -> iso
  const deps: PageCommentsDeps<Page> = {
    async getSession(request) {
      const user = request.headers.get('x-user');
      if (!user) return null;
      const by = request.headers.get('x-impersonated-by');
      return {
        userId: user,
        impersonated: request.headers.get('x-impersonated') === '1' || Boolean(by),
        impersonatedBy: by,
      };
    },
    async findPage(id) {
      return PAGES[id] ?? null;
    },
    async sectionViewer({ userId, classroomId }) {
      return viewerFrom(MEMBERS[userId]?.[classroomId] ?? []);
    },
    async readerState({ userId }) {
      return { checked: [], unlocked: { ...(unlocks[userId] ?? {}) } };
    },
    // The route's choice, faked: an editor of a live page anchors on the live
    // document (git's copy plus a block not checkpointed yet), everyone else on git.
    async loadCommentBlocks(page, viewer) {
      calls.loadPageBlocks++;
      return page.live && viewer.canEditAnyState ? liveFixture() : fixture();
    },
    rules: store.rules,
    async audit(row) {
      calls.audit.push(row);
    },
    rateLimit: {
      take(userId, kind) {
        calls.rateLimit.push({ userId, kind });
        return true;
      },
      refund() {},
    },
    ...overrides,
  };
  return { deps, calls, store, unlocks };
}

function post(
  body: unknown,
  {
    user,
    impersonated,
    origin = ORIGIN,
  }: { user?: string; impersonated?: boolean; origin?: string } = {}
) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin };
  if (user) headers['x-user'] = user;
  if (impersonated) headers['x-impersonated-by'] = 'admin-1';
  return new Request(`${ORIGIN}/api/page-comments`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(
  pageId: string | null,
  user?: string,
  { impersonatedBy }: { impersonatedBy?: string } = {}
) {
  const headers: Record<string, string> = {};
  if (user) headers['x-user'] = user;
  if (impersonatedBy) headers['x-impersonated-by'] = impersonatedBy;
  const query = pageId === null ? '' : `?pageId=${encodeURIComponent(pageId)}`;
  return new Request(`${ORIGIN}/api/page-comments${query}`, { method: 'GET', headers });
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(response: Promise<Response>) {
  const res = await response;
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
}

/** POST as a user and return the parsed answer. */
const send = (deps: PageCommentsDeps<Page>, user: string | undefined, body: Json, extra = {}) =>
  call(handleCommentsPost(post(body, { user, ...extra }), deps));

/** A new thread on page-x by `user`; returns its thread and first comment ids. */
async function seedThread(
  deps: PageCommentsDeps<Page>,
  user: string,
  fields: Json = {},
  pageId = 'page-x'
) {
  const res = await send(deps, user, { pageId, intent: 'create', body: 'First!', ...fields });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    threadId: res.body.thread.id as string,
    commentId: res.body.thread.comments[0].id as string,
  };
}

// ── Request parsing ────────────────────────────────────────────────────────

test.describe('request parsing', () => {
  test('an object with a page id and a known intent; nothing else', () => {
    expect(parseCommentRequest({ pageId: 'p', intent: 'create', body: 'x' })?.intent).toBe(
      'create'
    );
    for (const intent of ['create', 'reply', 'edit', 'delete', 'react', 'resolve']) {
      expect(parseCommentRequest({ pageId: 'p', intent })).not.toBeNull();
    }
    expect(parseCommentRequest(null)).toBeNull();
    expect(parseCommentRequest([])).toBeNull();
    expect(parseCommentRequest('x')).toBeNull();
    expect(parseCommentRequest({ intent: 'create' })).toBeNull();
    expect(parseCommentRequest({ pageId: '', intent: 'create' })).toBeNull();
    expect(parseCommentRequest({ pageId: 'p'.repeat(256), intent: 'create' })).toBeNull();
    expect(parseCommentRequest({ pageId: 'p', intent: 'unreact' })).toBeNull();
    expect(parseCommentRequest({ pageId: 'p', intent: 'toString' })).toBeNull();
  });
});

// ── POST: the status ladder ────────────────────────────────────────────────

test.describe('POST /api/page-comments', () => {
  test('every answer is private, no-store, varied on Cookie', async () => {
    const { deps } = makeDeps({
      findPage: async id => {
        if (id === 'boom') throw new Error('db down');
        return PAGES[id] ?? null;
      },
    });
    for (const req of [
      post({ pageId: 'page-x', intent: 'create', body: 'hi' }, { user: 'student-a' }),
      post({ pageId: 'page-x', intent: 'create', body: 'hi' }),
      post({ pageId: 'nope', intent: 'create', body: 'hi' }, { user: 'student-a' }),
      post({ pageId: 'boom', intent: 'create', body: 'hi' }, { user: 'student-a' }),
      post('{nope', { user: 'student-a' }),
    ]) {
      const res = await handleCommentsPost(req, deps);
      for (const [key, value] of Object.entries(SECTION_NO_STORE_HEADERS)) {
        expect(res.headers.get(key)).toBe(value);
      }
    }
  });

  test('method, origin, size and shape are refused before anything is read', async () => {
    const { deps, calls } = makeDeps();
    const wrongMethod = new Request(`${ORIGIN}/api/page-comments`, { method: 'PUT', body: '{}' });
    const r405 = await call(handleCommentsPost(wrongMethod, deps));
    expect(r405.status).toBe(405);
    expect(r405.body.error).toBe('METHOD_NOT_ALLOWED');

    const r403 = await call(
      handleCommentsPost(
        post(
          { pageId: 'page-x', intent: 'create', body: 'hi' },
          { user: 'student-a', origin: 'https://evil.example' }
        ),
        deps
      )
    );
    expect(r403.status).toBe(403);

    const huge = JSON.stringify({
      pageId: 'page-x',
      intent: 'create',
      body: 'x'.repeat(COMMENT_REQUEST_MAX_BYTES),
    });
    expect((await handleCommentsPost(post(huge, { user: 'student-a' }), deps)).status).toBe(413);

    // The longest valid bodies fit: 4000 UTF-16 units that JSON escapes as
    // `\uXXXX` (control characters, lone surrogates), or 4-byte emoji.
    for (const longBody of ['\u0001'.repeat(4000), 'a\ud800'.repeat(2000), '😀'.repeat(2000)]) {
      const longest = JSON.stringify({ pageId: 'page-x', intent: 'create', body: longBody });
      expect(new TextEncoder().encode(longest).length).toBeLessThan(COMMENT_REQUEST_MAX_BYTES);
    }
    const escaped = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      body: '\u0001'.repeat(4000),
    });
    expect(escaped.status).toBe(200);
    calls.loadPageBlocks = 0;
    calls.rateLimit.length = 0;

    for (const bad of [
      '{nope',
      '[]',
      '"x"',
      JSON.stringify({ intent: 'create', body: 'hi' }),
      JSON.stringify({ pageId: 'page-x', intent: 'unreact' }),
      JSON.stringify({ pageId: 'page-x' }),
    ]) {
      const res = await call(handleCommentsPost(post(bad, { user: 'student-a' }), deps));
      expect(res.status, bad).toBe(400);
      expect(res.body).toEqual({ error: 'INVALID_REQUEST', message: 'Invalid request' });
    }
    expect(calls.loadPageBlocks).toBe(0);
    expect(calls.rateLimit).toEqual([]);
  });

  test('anonymous → 401', async () => {
    const { deps } = makeDeps();
    const res = await send(deps, undefined, { pageId: 'page-x', intent: 'create', body: 'hi' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  test('unknown page, another classroom’s page, a pending invite, a stranger and a student’s draft all look the same: 404', async () => {
    const { deps, calls, store } = makeDeps();
    const create = { intent: 'create', body: 'hi' };
    const answers = await Promise.all([
      send(deps, 'student-a', { pageId: 'nope', ...create }),
      send(deps, 'student-a', { pageId: 'page-y', ...create }),
      send(deps, 'pending-x', { pageId: 'page-x', ...create }),
      send(deps, 'stranger', { pageId: 'page-x', ...create }),
      send(deps, 'student-a', { pageId: 'draft-x', ...create }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Not found' });
    }
    expect(calls.loadPageBlocks).toBe(0);
    expect(calls.rateLimit).toEqual([]);
    expect(store.threads).toEqual([]);
  });

  test('a draft is open to the teaching team', async () => {
    const { deps } = makeDeps();
    for (const user of ['ta-x', 'teacher-x', 'owner-x']) {
      const res = await send(deps, user, { pageId: 'draft-x', intent: 'create', body: 'hi' });
      expect(res.status, user).toBe(200);
    }
  });

  test('an UNPUBLISHED classroom: 403 CLASSROOM_UNPUBLISHED for a member, open to its owner', async () => {
    const { deps, calls } = makeDeps();
    const student = await send(deps, 'student-a', {
      pageId: 'page-unpublished',
      intent: 'create',
      body: 'hi',
    });
    expect(student.status).toBe(403);
    expect(student.body.error).toBe('CLASSROOM_UNPUBLISHED');
    expect(calls.loadPageBlocks).toBe(0);

    const owner = await send(deps, 'owner-x', {
      pageId: 'page-unpublished',
      intent: 'create',
      body: 'hi',
    });
    expect(owner.status).toBe(200);
  });

  test('an impersonated session never writes (403), before the rate limit', async () => {
    const { deps, calls, store } = makeDeps();
    for (const intent of ['create', 'reply', 'edit', 'delete', 'react', 'resolve']) {
      const res = await send(
        deps,
        'student-a',
        { pageId: 'page-x', intent, body: 'hi', threadId: 'x', commentId: 'x' },
        { impersonated: true }
      );
      expect(res.status, intent).toBe(403);
      expect(res.body.error).toBe('IMPERSONATED');
    }
    expect(calls.rateLimit).toEqual([]);
    expect(calls.audit).toEqual([]);
    expect(store.threads).toEqual([]);
  });

  test('a LOCKED classroom is read-only: 403 CLASSROOM_LOCKED, but its owner still writes', async () => {
    const { deps, calls } = makeDeps();
    const student = await send(deps, 'student-a', {
      pageId: 'page-locked',
      intent: 'create',
      body: 'hi',
    });
    expect(student.status).toBe(403);
    expect(student.body.error).toBe('CLASSROOM_LOCKED');
    expect(typeof student.body.message).toBe('string');
    expect(calls.audit).toEqual([]);

    const owner = await send(deps, 'owner-x', {
      pageId: 'page-locked',
      intent: 'create',
      body: 'hi',
    });
    expect(owner.status).toBe(200);
  });

  test('the service’s validation errors are a 400 carrying their code and message', async () => {
    const { deps } = makeDeps();
    const base = { pageId: 'page-x' };
    const empty = await send(deps, 'student-a', { ...base, intent: 'create', body: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: 'INVALID_BODY', message: 'Write a comment.' });

    const tooLong = await send(deps, 'student-a', {
      ...base,
      intent: 'create',
      body: 'x'.repeat(4001),
    });
    expect([tooLong.status, tooLong.body.error]).toEqual([400, 'INVALID_BODY']);

    // A block inside a locked body this student has not unlocked is "not on this page".
    const hidden = await send(deps, 'student-a', {
      ...base,
      intent: 'create',
      blockId: 'p-secret',
      body: 'hi',
    });
    expect([hidden.status, hidden.body.error]).toEqual([400, 'INVALID_BLOCK']);

    const badQuote = await send(deps, 'student-a', {
      ...base,
      intent: 'create',
      blockId: 'p-1',
      quote: 'not there',
      body: 'hi',
    });
    expect([badQuote.status, badQuote.body.error]).toEqual([400, 'INVALID_QUOTE']);

    const { commentId, threadId } = await seedThread(deps, 'student-a', {
      blockId: 'p-1',
      quote: 'world',
    });
    const badEmoji = await send(deps, 'student-a', {
      ...base,
      intent: 'react',
      commentId,
      emoji: 'ab',
      on: true,
    });
    expect([badEmoji.status, badEmoji.body.error]).toEqual([400, 'INVALID_EMOJI']);

    const badId = await send(deps, 'student-a', {
      ...base,
      intent: 'reply',
      threadId: 42,
      body: 'x',
    });
    expect([badId.status, badId.body.error]).toEqual([400, 'INVALID_ID']);
    const unknownId = await send(deps, 'student-a', {
      ...base,
      intent: 'reply',
      threadId: 'no-such-thread',
      body: 'x',
    });
    expect(unknownId.status).toBe(404);

    await send(deps, 'teacher-x', { ...base, intent: 'resolve', threadId, resolved: true });
    const resolved = await send(deps, 'student-b', {
      ...base,
      intent: 'reply',
      threadId,
      body: 'x',
    });
    expect([resolved.status, resolved.body.error]).toEqual([400, 'THREAD_RESOLVED']);
  });

  test('resolve is the teaching team’s: 403 NOT_TEACHING_TEAM for a student', async () => {
    const { deps } = makeDeps();
    const { threadId } = await seedThread(deps, 'student-a');
    const student = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'resolve',
      threadId,
      resolved: true,
    });
    expect([student.status, student.body.error]).toEqual([403, 'NOT_TEACHING_TEAM']);
    for (const user of ['ta-x', 'teacher-x', 'owner-x']) {
      const res = await send(deps, user, {
        pageId: 'page-x',
        intent: 'resolve',
        threadId,
        resolved: user !== 'teacher-x',
      });
      expect(res.status, user).toBe(200);
    }
  });

  test('an unexpected failure is a guarded 500', async () => {
    const { deps } = makeDeps({
      loadCommentBlocks: async () => {
        throw new Error('content repo down');
      },
    });
    const res = await send(deps, 'student-a', { pageId: 'page-x', intent: 'create', body: 'hi' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'SERVER_ERROR', message: 'Something went wrong' });
    const sessionDown = await call(
      handleCommentsPost(post({ pageId: 'page-x', intent: 'create', body: 'hi' }, { user: 'x' }), {
        ...deps,
        getSession: async () => {
          throw new Error('session store down');
        },
      })
    );
    expect(sessionDown.status).toBe(500);
  });

  test('a write answers the thread as it is now; deleting the last comment answers null', async () => {
    const { deps, store } = makeDeps();
    const created = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      blockId: 'p-1',
      quote: 'world',
      body: 'Is this right?',
    });
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect(created.body.thread).toMatchObject({
      blockId: 'p-1',
      quote: 'world',
      quoteOccurrence: 0,
      resolvedAt: null,
      comments: [{ body: 'Is this right?', canEdit: true, canDelete: true }],
    });
    expect(created.body.thread.comments[0].author).toEqual({
      name: 'Student A',
      image: null,
      badge: null,
    });

    const commentId = created.body.thread.comments[0].id;
    const deleted = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'delete',
      commentId,
    });
    expect(deleted.body).toEqual({ ok: true, thread: null });
    expect(store.threads).toEqual([]);
  });
});

// ── User A vs B, classroom X vs Y ──────────────────────────────────────────

test.describe('user A vs B, classroom X vs Y', () => {
  test('B cannot edit or delete A’s comment (403 NOT_AUTHOR); A’s text is unchanged', async () => {
    const { deps, store, calls } = makeDeps();
    const { commentId } = await seedThread(deps, 'student-a', {}, 'page-x');
    calls.audit.length = 0;

    const edit = await send(deps, 'student-b', {
      pageId: 'page-x',
      intent: 'edit',
      commentId,
      body: 'hijacked',
    });
    expect([edit.status, edit.body.error]).toEqual([403, 'NOT_AUTHOR']);
    const del = await send(deps, 'student-b', { pageId: 'page-x', intent: 'delete', commentId });
    expect([del.status, del.body.error]).toEqual([403, 'NOT_AUTHOR']);
    // A TA resolves but does not moderate.
    const ta = await send(deps, 'ta-x', { pageId: 'page-x', intent: 'delete', commentId });
    expect([ta.status, ta.body.error]).toEqual([403, 'NOT_AUTHOR']);

    expect(store.threads[0]!.comments[0]!.body).toBe('First!');
    expect(calls.audit).toEqual([]);

    // B's list marks A's comment as not theirs.
    const list = await call(handleCommentsGet(get('page-x', 'student-b'), deps));
    expect(list.body.threads[0].comments[0]).toMatchObject({ canEdit: false, canDelete: false });
    // A's own list does.
    const own = await call(handleCommentsGet(get('page-x', 'student-a'), deps));
    expect(own.body.threads[0].comments[0]).toMatchObject({ canEdit: true, canDelete: true });
  });

  test('a teacher (moderator) deletes A’s comment, audited as moderated', async () => {
    const { deps, calls } = makeDeps();
    const { commentId } = await seedThread(deps, 'student-a');
    calls.audit.length = 0;
    const res = await send(deps, 'teacher-x', { pageId: 'page-x', intent: 'delete', commentId });
    expect(res.status).toBe(200);
    expect(calls.audit).toHaveLength(1);
    expect(calls.audit[0]).toMatchObject({
      user_id: 'teacher-x',
      role: 'TEACHER',
      action: 'DELETE',
      data: { tool: 'page_comment', moderated: true, comment_author_id: 'student-a', via: 'web' },
    });
  });

  test('a thread or comment id from classroom Y’s page, sent with X’s page id, is 404', async () => {
    const { deps, store } = makeDeps();
    const y = await seedThread(deps, 'student-y', {}, 'page-y');
    // student-a is a member of X, posting X's page id with Y's ids.
    for (const body of [
      { intent: 'reply', threadId: y.threadId, body: 'x' },
      { intent: 'edit', commentId: y.commentId, body: 'x' },
      { intent: 'delete', commentId: y.commentId },
      { intent: 'react', commentId: y.commentId, emoji: '👍', on: true },
    ]) {
      const res = await send(deps, 'student-a', { pageId: 'page-x', ...body });
      expect(res.status, body.intent).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Not found' });
    }
    // Even Y's owner, sending X's page id (not their classroom) → 404.
    const ownerY = await send(deps, 'owner-y', {
      pageId: 'page-x',
      intent: 'delete',
      commentId: y.commentId,
    });
    expect(ownerY.status).toBe(404);
    // Y's thread untouched.
    expect(store.threads.find(t => t.id === y.threadId)!.comments).toHaveLength(1);
  });

  test('another page in the same classroom: its ids are not this page’s', async () => {
    const { deps } = makeDeps();
    const other = await seedThread(deps, 'student-a', {}, 'page-x2');
    const res = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'reply',
      threadId: other.threadId,
      body: 'x',
    });
    expect(res.status).toBe(404);
  });

  test('a member of Y cannot list X’s threads; X’s threads never show on Y’s page', async () => {
    const { deps } = makeDeps();
    await seedThread(deps, 'student-a', { body: 'X-ONLY-TEXT' });
    const yOnX = await call(handleCommentsGet(get('page-x', 'student-y'), deps));
    expect(yOnX.status).toBe(404);
    const xOnY = await call(handleCommentsGet(get('page-y', 'owner-y'), deps));
    expect(xOnY.status).toBe(200);
    expect(xOnY.body.threads).toEqual([]);
    expect(JSON.stringify(xOnY.body)).not.toContain('X-ONLY-TEXT');
  });
});

// ── GET ────────────────────────────────────────────────────────────────────

test.describe('GET /api/page-comments', () => {
  test('a member gets the threads and what they may do; nothing is audited', async () => {
    const { deps, calls } = makeDeps();
    await seedThread(deps, 'student-a', { blockId: 'p-1' });
    calls.audit.length = 0;

    const student = await call(handleCommentsGet(get('page-x', 'student-b'), deps));
    expect(student.status).toBe(200);
    expect(student.body.viewer).toEqual({
      canWrite: true,
      canResolve: false,
      canModerate: false,
      frozen: false,
    });
    expect(student.body.threads).toHaveLength(1);
    for (const [key, value] of Object.entries(SECTION_NO_STORE_HEADERS)) {
      expect(student.headers.get(key)).toBe(value);
    }

    const teacher = await call(handleCommentsGet(get('page-x', 'teacher-x'), deps));
    expect(teacher.body.viewer).toEqual({
      canWrite: true,
      canResolve: true,
      canModerate: true,
      frozen: false,
    });
    const ta = await call(handleCommentsGet(get('page-x', 'ta-x'), deps));
    expect(ta.body.viewer).toMatchObject({ canResolve: true, canModerate: false });

    expect(calls.audit).toEqual([]);
  });

  test('anonymous → 401; non-members, pending invites and unknown pages → the same 404', async () => {
    const { deps } = makeDeps();
    await seedThread(deps, 'student-a');
    expect((await call(handleCommentsGet(get('page-x'), deps))).status).toBe(401);
    const answers = await Promise.all([
      call(handleCommentsGet(get('page-x', 'stranger'), deps)),
      call(handleCommentsGet(get('page-x', 'pending-x'), deps)),
      call(handleCommentsGet(get('page-x', 'student-y'), deps)),
      call(handleCommentsGet(get('nope', 'student-a'), deps)),
      call(handleCommentsGet(get(null, 'student-a'), deps)),
      call(handleCommentsGet(get('draft-x', 'student-a'), deps)),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Not found' });
      expect(res.body.threads).toBeUndefined();
    }
  });

  test('an UNPUBLISHED classroom: 403 for a member, open to its owner', async () => {
    const { deps } = makeDeps();
    const student = await call(handleCommentsGet(get('page-unpublished', 'student-a'), deps));
    expect([student.status, student.body.error]).toEqual([403, 'CLASSROOM_UNPUBLISHED']);
    const owner = await call(handleCommentsGet(get('page-unpublished', 'owner-x'), deps));
    expect(owner.status).toBe(200);
  });

  test('a LOCKED classroom reads, frozen', async () => {
    const { deps } = makeDeps();
    const res = await call(handleCommentsGet(get('page-locked', 'student-a'), deps));
    expect(res.status).toBe(200);
    expect(res.body.viewer).toEqual({
      canWrite: false,
      canResolve: false,
      canModerate: false,
      frozen: true,
    });
  });

  test('an impersonated session reads, with every write flag off (list and comments)', async () => {
    const { deps } = makeDeps();
    await seedThread(deps, 'teacher-x');
    const res = await call(
      handleCommentsGet(get('page-x', 'teacher-x', { impersonatedBy: 'admin-1' }), deps)
    );
    expect(res.status).toBe(200);
    expect(res.body.viewer).toEqual({
      canWrite: false,
      canResolve: false,
      canModerate: false,
      frozen: false,
    });
    expect(res.body.threads[0].comments[0]).toMatchObject({ canEdit: false, canDelete: false });
  });

  test('a thread inside a locked body is hidden until this student unlocks it (D2)', async () => {
    const { deps, unlocks } = makeDeps();
    // The teaching team sees every body, so a TA can comment inside it.
    const res = await send(deps, 'ta-x', {
      pageId: 'page-x',
      intent: 'create',
      blockId: 'p-secret',
      quote: 'SECRET',
      body: 'Hint here',
    });
    expect(res.status).toBe(200);

    const before = await call(handleCommentsGet(get('page-x', 'student-a'), deps));
    expect(before.body.threads).toEqual([]);
    expect(JSON.stringify(before.body)).not.toContain('SECRET');

    unlocks['student-a'] = { lock: '2026-10-29T12:00:00.000Z' };
    const after = await call(handleCommentsGet(get('page-x', 'student-a'), deps));
    expect(after.body.threads).toHaveLength(1);
    // Still hidden from B, who has not unlocked it.
    const other = await call(handleCommentsGet(get('page-x', 'student-b'), deps));
    expect(other.body.threads).toEqual([]);
  });

  test('a non-GET to the loader is 405', async () => {
    const { deps } = makeDeps();
    const req = new Request(`${ORIGIN}/api/page-comments?pageId=page-x`, {
      method: 'DELETE',
      headers: { 'x-user': 'student-a' },
    });
    expect((await handleCommentsGet(req, deps)).status).toBe(405);
  });
});

// ── What never leaves the server ───────────────────────────────────────────

test.describe('payload discipline', () => {
  test('no author email or git login in any GET or POST answer', async () => {
    const { deps } = makeDeps();
    const answers: unknown[] = [];
    const created = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      blockId: 'p-1',
      body: 'hi',
    });
    answers.push(created.body);
    const threadId = created.body.thread.id;
    const commentId = created.body.thread.comments[0].id;
    answers.push(
      (await send(deps, 'teacher-x', { pageId: 'page-x', intent: 'reply', threadId, body: 'yo' }))
        .body,
      (
        await send(deps, 'student-b', {
          pageId: 'page-x',
          intent: 'react',
          commentId,
          emoji: '👍',
          on: true,
        })
      ).body,
      (await send(deps, 'ta-x', { pageId: 'page-x', intent: 'resolve', threadId, resolved: true }))
        .body
    );
    for (const user of ['student-a', 'student-b', 'teacher-x', 'owner-x']) {
      answers.push((await call(handleCommentsGet(get('page-x', user), deps))).body);
    }
    const wire = JSON.stringify(answers);
    expect(wire).toContain('Teacher X'); // the authors are there…
    for (const user of ['student-a', 'student-b', 'teacher-x', 'ta-x']) {
      expect(wire).not.toContain(`${user}@school.test`); // …without their email
      expect(wire).not.toContain(`gh-${user}`); // …or git login
    }
    expect(wire).not.toContain('@');
  });
});

// ── Audit ──────────────────────────────────────────────────────────────────

test.describe('audit rows', () => {
  test('each changing write leaves one row, via web, with no body or quote text', async () => {
    const { deps, calls } = makeDeps();
    const BODY = 'PRIVATE-BODY-TEXT that nobody should log';
    const created = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      blockId: 'p-1',
      quote: 'Hello',
      body: BODY,
    });
    const threadId = created.body.thread.id;
    const commentId = created.body.thread.comments[0].id;
    await send(deps, 'student-b', { pageId: 'page-x', intent: 'reply', threadId, body: BODY });
    await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'edit',
      commentId,
      body: `${BODY} (edited)`,
    });
    await send(deps, 'student-b', {
      pageId: 'page-x',
      intent: 'react',
      commentId,
      emoji: '👍',
      on: true,
    });
    await send(deps, 'ta-x', { pageId: 'page-x', intent: 'resolve', threadId, resolved: true });

    expect(calls.audit.map(row => [row.action, row.data.tool])).toEqual([
      ['CREATE', 'page_comment'],
      ['CREATE', 'page_comment'],
      ['UPDATE', 'page_comment'],
      ['CREATE', 'page_comment_reaction'],
      ['UPDATE', 'page_comment_thread'],
    ]);
    for (const row of calls.audit) {
      expect(row).toMatchObject({
        classroom_id: CLASS_X,
        resource_type: 'PAGES',
        resource_id: 'page-x',
        data: { via: 'web', page_id: 'page-x', thread_id: threadId },
      });
      expect(row.data).not.toHaveProperty('impersonated_by');
    }
    expect(calls.audit[0]).toMatchObject({
      user_id: 'student-a',
      role: 'STUDENT',
      data: { new_thread: true, block_id: 'p-1', quote_length: 5, body_length: BODY.length },
    });
    expect(calls.audit[4]).toMatchObject({ user_id: 'ta-x', role: 'ASSISTANT' });

    const logged = JSON.stringify(calls.audit);
    expect(logged).not.toContain('PRIVATE-BODY-TEXT');
    expect(logged).not.toContain('Hello');
  });

  test('a no-op writes no row; a failing audit does not fail the write', async () => {
    const { deps, calls } = makeDeps();
    const { commentId, threadId } = await seedThread(deps, 'student-a');
    calls.audit.length = 0;
    // Same body again, removing a reaction that is not there, reopening an open thread.
    await send(deps, 'student-a', { pageId: 'page-x', intent: 'edit', commentId, body: 'First!' });
    await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'react',
      commentId,
      emoji: '👍',
      on: false,
    });
    await send(deps, 'teacher-x', {
      pageId: 'page-x',
      intent: 'resolve',
      threadId,
      resolved: false,
    });
    expect(calls.audit).toEqual([]);

    const failing = { ...deps, audit: async () => Promise.reject(new Error('audit down')) };
    const res = await send(failing, 'student-a', {
      pageId: 'page-x',
      intent: 'reply',
      threadId,
      body: 'still saved',
    });
    expect(res.status).toBe(200);
    expect(res.body.thread.comments).toHaveLength(2);
  });
});

// ── Rate limit ─────────────────────────────────────────────────────────────

test.describe('rate limit', () => {
  test('a burst of 20 posts and 60 reactions per user, refilled over 10 minutes', () => {
    let now = 0;
    const limiter = createCommentRateLimiter({ now: () => now });
    const allow = limiter.take;
    expect(COMMENT_RATE_LIMITS.post.capacity).toBe(20);
    expect(COMMENT_RATE_LIMITS.react.capacity).toBe(60);
    for (let i = 0; i < 20; i++) expect(allow('a', 'post'), `post ${i}`).toBe(true);
    expect(allow('a', 'post')).toBe(false);
    // Other users and the other kind have their own buckets.
    expect(allow('b', 'post')).toBe(true);
    for (let i = 0; i < 60; i++) expect(allow('a', 'react')).toBe(true);
    expect(allow('a', 'react')).toBe(false);
    // One token back every 30 s for posts.
    now += 30_000;
    expect(allow('a', 'post')).toBe(true);
    expect(allow('a', 'post')).toBe(false);
    // A full window refills, but never past the burst.
    now += 60 * 60 * 1000;
    for (let i = 0; i < 20; i++) expect(allow('a', 'post')).toBe(true);
    expect(allow('a', 'post')).toBe(false);
    // A refund gives one back, never past the burst.
    limiter.refund('a', 'post');
    expect(allow('a', 'post')).toBe(true);
    expect(allow('a', 'post')).toBe(false);
    limiter.refund('c', 'post'); // no bucket yet: nothing to give back
    for (let i = 0; i < 20; i++) expect(allow('c', 'post')).toBe(true);
    expect(allow('c', 'post')).toBe(false);
  });

  test('a 403 is never masked by a 429 and spends nothing; a 400 still spends', async () => {
    const tiny = () =>
      createCommentRateLimiter({
        now: () => 0,
        limits: { post: { capacity: 1, windowMs: 1000 }, react: { capacity: 1, windowMs: 1000 } },
      });

    // A LOCKED classroom: CLASSROOM_LOCKED every time, the limiter never asked.
    const locked = makeDeps({ rateLimit: tiny() });
    for (let i = 0; i < 5; i++) {
      const res = await send(locked.deps, 'student-a', {
        pageId: 'page-locked',
        intent: i % 2 ? 'react' : 'create',
        commentId: 'c',
        emoji: '👍',
        on: true,
        body: 'hi',
      });
      expect([res.status, res.body.error], `try ${i}`).toEqual([403, 'CLASSROOM_LOCKED']);
    }

    // A 403 the service gives after the token was taken (the classroom locked
    // mid-request) gives it back: the next post goes through.
    const refunded = makeDeps({ rateLimit: tiny() });
    const realCreate = refunded.deps.rules.createThread;
    let lockOnce = true;
    refunded.deps.rules = {
      ...refunded.deps.rules,
      async createThread(ctx, input) {
        if (lockOnce) {
          lockOnce = false;
          throw new service.PageCommentsForbiddenError('CLASSROOM_LOCKED', 'Locked.');
        }
        return realCreate(ctx, input);
      },
    };
    const first = await send(refunded.deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      body: 'hi',
    });
    expect([first.status, first.body.error]).toEqual([403, 'CLASSROOM_LOCKED']);
    const second = await send(refunded.deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      body: 'hi',
    });
    expect(second.status).toBe(200);

    // A refused body (400) keeps its token spent.
    const invalid = makeDeps({ rateLimit: tiny() });
    const bad = await send(invalid.deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      body: '   ',
    });
    expect([bad.status, bad.body.error]).toEqual([400, 'INVALID_BODY']);
    const next = await send(invalid.deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      body: 'hi',
    });
    expect(next.status).toBe(429);
  });

  test('create and reply share the post budget, react has its own, the rest are not limited; 429 before the service runs', async () => {
    const limiter = createCommentRateLimiter({
      now: () => 0,
      limits: { post: { capacity: 2, windowMs: 1000 }, react: { capacity: 1, windowMs: 1000 } },
    });
    const { deps, calls, store } = makeDeps({ rateLimit: limiter });
    const { threadId, commentId } = await seedThread(deps, 'student-a');
    const reply = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'reply',
      threadId,
      body: 'x',
    });
    expect(reply.status).toBe(200);
    const blocked = await send(deps, 'student-a', {
      pageId: 'page-x',
      intent: 'create',
      body: 'third',
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
    expect(typeof blocked.body.message).toBe('string');
    expect(store.threads).toHaveLength(1);

    const react = { pageId: 'page-x', intent: 'react', commentId, emoji: '🎉', on: true };
    expect((await send(deps, 'student-a', react)).status).toBe(200);
    expect((await send(deps, 'student-a', { ...react, emoji: '👍' })).status).toBe(429);

    // Edits, deletes and resolves are not limited.
    expect(
      (await send(deps, 'student-a', { pageId: 'page-x', intent: 'edit', commentId, body: 'e' }))
        .status
    ).toBe(200);
    // Another user is not affected.
    expect(
      (await send(deps, 'student-b', { pageId: 'page-x', intent: 'reply', threadId, body: 'y' }))
        .status
    ).toBe(200);
    expect(calls.audit.filter(row => row.user_id === 'student-a')).toHaveLength(4);
  });
});

// ── Which document a caller anchors on ─────────────────────────────────────

test.describe('live editing: the document comments anchor on', () => {
  test('an editor of a live page anchors on a block only in the live document; a student gets 400', async () => {
    const { deps } = makeDeps();
    const teacher = await send(deps, 'teacher-x', {
      pageId: 'page-live',
      intent: 'create',
      blockId: 'p-live',
      quote: 'live',
      body: 'On the new block',
    });
    expect(teacher.status, JSON.stringify(teacher.body)).toBe(200);
    expect(teacher.body.ok).toBe(true);
    expect(teacher.body.thread).toMatchObject({ blockId: 'p-live', quote: 'live' });
    // The editor's list orders it among the live document's blocks.
    const list = await call(handleCommentsGet(get('page-live', 'teacher-x'), deps));
    expect(list.body.threads.map((t: Json) => t.blockId)).toEqual(['p-live']);

    // A student reads git's copy, where the block is not (yet).
    const student = await send(deps, 'student-a', {
      pageId: 'page-live',
      intent: 'create',
      blockId: 'p-live',
      body: 'Me too',
    });
    expect([student.status, student.body.error]).toEqual([400, 'INVALID_BLOCK']);
    // A TA is no page editor: git's copy too.
    const ta = await send(deps, 'ta-x', {
      pageId: 'page-live',
      intent: 'create',
      blockId: 'p-live',
      body: 'TA',
    });
    expect([ta.status, ta.body.error]).toEqual([400, 'INVALID_BLOCK']);
  });

  test('commentBlocksFor: live document for a live editor, git on any failure, git otherwise', async () => {
    const gitBlocks = [{ id: 'g', type: 'paragraph' }];
    const liveBlocks = [{ id: 'l', type: 'paragraph' }];
    const readGit = async () => ({ format: 'json', content: gitBlocks });
    let liveReads = 0;
    const readLive = async () => {
      liveReads++;
      return { content: { blocks: liveBlocks } };
    };

    expect(await commentBlocksFor({ live: true, readLive, readGit })).toBe(liveBlocks);
    // Not live (a student, a TA, a locked classroom, no live editing): git, no live read.
    liveReads = 0;
    expect(await commentBlocksFor({ live: false, readLive, readGit })).toBe(gitBlocks);
    expect(liveReads).toBe(0);
    // The collab server down or slow: git's copy, like the loader.
    expect(
      await commentBlocksFor({
        live: true,
        readLive: async () => {
          throw new Error('collab timeout');
        },
        readGit,
      })
    ).toBe(gitBlocks);
    // A snapshot without blocks is an empty document.
    expect(await commentBlocksFor({ live: true, readLive: async () => ({}), readGit })).toEqual([]);
    // A legacy HTML page (or none) has no stored block ids.
    expect(
      await commentBlocksFor({
        live: false,
        readLive,
        readGit: async () => ({ format: 'html', content: '<p>hi</p>' }),
      })
    ).toEqual([]);
    // A failing git read is a failure (the handler's guarded 500).
    await expect(
      commentBlocksFor({
        live: false,
        readLive,
        readGit: async () => {
          throw new Error('repo down');
        },
      })
    ).rejects.toThrow('repo down');
  });

  test('the route reads the loader’s source for the caller', () => {
    const ROUTE = source('../../app/routes/api.page-comments/route.ts');
    expect(ROUTE).toContain('const liveEnv = canEdit ? liveEditingEnv(page.classroom) : null;');
    expect(ROUTE).toMatch(/joinsLiveRoom\(\{/);
    expect(ROUTE).toContain('fetchLiveSnapshot(liveEnv, page.id, { timeoutMs: 3000 })');
    expect(ROUTE).toContain('canEdit ? { skipCache: true } : { viaWorker: true }');
  });
});

// ── The loader's readerComments ────────────────────────────────────────────

test.describe('readerComments (the loader contract)', () => {
  const counts = { counts: { 'p-1': 2 }, pageLevel: 1, open: 3 };
  const member = service.commentAccess({
    viewer: viewerFrom([accepted('STUDENT')]),
    page: { is_draft: false },
    classroom: { status: 'ACTIVE' },
  });

  test('absent (undefined) for anonymous, no access, and an unread count', () => {
    expect(
      readerCommentsFor({ signedIn: false, access: member, impersonated: false, counts })
    ).toBeUndefined();
    expect(
      readerCommentsFor({ signedIn: true, access: null, impersonated: false, counts })
    ).toBeUndefined();
    expect(
      readerCommentsFor({
        signedIn: true,
        access: { ...service.NO_COMMENT_ACCESS },
        impersonated: false,
        counts,
      })
    ).toBeUndefined();
    expect(
      readerCommentsFor({ signedIn: true, access: member, impersonated: false, counts: null })
    ).toBeUndefined();
  });

  test('a member gets the counts and their flags; impersonated is read-only', () => {
    expect(
      readerCommentsFor({ signedIn: true, access: member, impersonated: false, counts })
    ).toEqual({
      counts: { 'p-1': 2 },
      pageLevel: 1,
      open: 3,
      canWrite: true,
      canResolve: false,
      frozen: false,
    });
    const owner = service.commentAccess({
      viewer: viewerFrom([accepted('OWNER')]),
      page: { is_draft: false },
      classroom: { status: 'ACTIVE' },
    });
    expect(
      readerCommentsFor({ signedIn: true, access: owner, impersonated: true, counts })
    ).toMatchObject({ canWrite: false, canResolve: false, frozen: false });
    expect(accessForSession(owner, true)).toMatchObject({
      canRead: true,
      canWrite: false,
      canResolve: false,
      canModerate: false,
      role: 'OWNER',
    });
    expect(accessForSession(owner, false)).toBe(owner);
  });

  test('the loader sends the key only when there is one, never null', () => {
    const LOADER = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
    const loaderBody = LOADER.slice(
      LOADER.indexOf('export const loader'),
      LOADER.indexOf('export const action')
    );
    expect(loaderBody).toContain('...(readerComments ? { readerComments } : {}),');
    expect(loaderBody).not.toMatch(/readerComments:\s*readerComments/);
    expect(loaderBody).not.toMatch(/readerComments\s*\?\?\s*null/);
    // Built by the pure builder, only for a signed-in accepted member, never on
    // a preview branch, from the one reader rule already read.
    expect(loaderBody).toMatch(
      /authData\?\.userId && sectionViewer\.acceptedRole !== null && !previewActive/
    );
    expect(loaderBody).toContain('readerCommentsFor({');
    expect(loaderBody).toContain('const readerCommentsPending = commentCtx?.access.canRead');
    expect(loaderBody.match(/pageSections\.sectionViewer\(/g)).toHaveLength(1);
    // The counts read the stored document, the one /api/page-comments anchors against.
    expect(loaderBody).toContain(
      "const commentBlocks = format === 'json' && Array.isArray(content) ? content : [];"
    );
    expect(loaderBody).toContain('blocks: commentBlocks,');
  });
});
