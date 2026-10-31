/**
 * pageComments.service against a REAL Postgres: whose comments one user may
 * touch, and that one classroom's (or page's) threads never answer through
 * another's.
 *
 * Two classrooms (X and Y), each with an owner, a teacher, an assistant and
 * two students, and one published page with a locked section. Every write and
 * read goes through a `CommentContext` built the way the pages API and the
 * MCP build it (`loadCommentContext`), so the ids under test are the ones a
 * caller would pass.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in afterAll
 * by deleting the git organization (cascades classrooms → pages → threads →
 * comments → reactions), then the users. Nothing is truncated. Skipped unless
 * DATABASE_URL names a LOCAL, non-shared database, like the other integration
 * tests here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';

import getPrisma from '@classmoji/database';
import * as comments from '../pageComments.service.ts';
import * as sections from '../pageSections.service.ts';
import * as audit from '../audit.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const { PageCommentsForbiddenError, PageCommentsNotFoundError, PageCommentsValidationError } =
  comments;

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const p = (id: string, value: string) => ({
  id,
  type: 'paragraph',
  props: {},
  content: text(value),
  children: [],
});
const DOC = [
  p('intro', 'Read the lab notes before the lab.'),
  {
    id: 'L1',
    type: 'lockedSection',
    props: { title: 'Solution' },
    children: [p('L1-body', 'The answer is 42.')],
  },
  p('outro', 'Good luck'),
];
/** The same page after the author deleted the solution's body block. */
const DOC_WITHOUT_BODY = [DOC[0], { ...DOC[1], children: [] }, DOC[2]];

type PageRow = {
  id: string;
  classroom_id: string;
  is_draft: boolean;
  classroom: { status: string };
};

describe.skipIf(!RUN)('pageComments.service (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;

  type Fixture = {
    classroomId: string;
    page: PageRow;
    draft: PageRow;
    other: PageRow;
    owner: string;
    teacher: string;
    ta: string;
    studentA: string;
    studentB: string;
  };
  let X: Fixture;
  let Y: Fixture;

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        name: `Comments ${label} ${suite}`,
        email: `comments-${suite}-${label}@example.test`,
        image: `https://avatars.example/${suite}-${label}.png`,
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `comments-${suite}-${label}`,
            username: `comments-${suite}-${label}`,
          },
        },
      },
    });
    userIds.push(user.id);
    return user.id;
  };

  const join = (classroomId: string, userId: string, role: Role, accepted = true) =>
    prisma.classroomMembership.create({
      data: { classroom_id: classroomId, user_id: userId, role, has_accepted_invite: accepted },
    });

  const PAGE_SELECT = {
    id: true,
    classroom_id: true,
    is_draft: true,
    classroom: { select: { status: true } },
  } as const;

  const makeClassroom = async (tag: string): Promise<Fixture> => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `comments-${suite}-${tag}`,
        git_org_id: orgId,
        name: `Comments ${tag} ${suite}`,
        content_namespace: `comments-${suite}-${tag}`,
        content_repo: `content-comments-${suite}-${tag}`,
      },
    });
    const owner = await makeUser(`${tag}-owner`);
    const teacher = await makeUser(`${tag}-teacher`);
    const ta = await makeUser(`${tag}-ta`);
    const studentA = await makeUser(`${tag}-a`);
    const studentB = await makeUser(`${tag}-b`);
    await join(classroom.id, owner, 'OWNER');
    await join(classroom.id, teacher, 'TEACHER');
    await join(classroom.id, ta, 'ASSISTANT');
    await join(classroom.id, studentA, 'STUDENT');
    await join(classroom.id, studentB, 'STUDENT');

    const makePage = (title: string, is_draft: boolean) =>
      prisma.page.create({
        data: {
          classroom_id: classroom.id,
          title: `${title} ${tag} ${suite}`,
          content_path: `pages/${title}-${tag}-${suite}`,
          created_by: owner,
          is_draft,
        },
        select: PAGE_SELECT,
      });
    return {
      classroomId: classroom.id,
      page: await makePage('lab', false),
      draft: await makePage('draft', true),
      other: await makePage('other', false),
      owner,
      teacher,
      ta,
      studentA,
      studentB,
    };
  };

  const ctx = (userId: string, page: PageRow, blocks: unknown = DOC) =>
    comments.loadCommentContext({ userId, page, blocks });

  const start = async (userId: string, page: PageRow, input: Record<string, unknown> = {}) => {
    const result = await comments.createThread(await ctx(userId, page), {
      body: 'A question',
      ...input,
    });
    return result.thread!;
  };

  const rejects = async (promise: Promise<unknown>, type: unknown, code?: string) => {
    const error = await promise.then(
      () => null,
      e => e
    );
    expect(error).toBeInstanceOf(type as never);
    if (code) expect((error as { code?: string }).code).toBe(code);
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `comments-${suite}`,
        login: `comments-org-${suite}`,
      },
    });
    orgId = org.id;
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });

  it('creates a thread on a quote and lists it for every member, with author badges', async () => {
    const thread = await start(X.studentA, X.page, {
      blockId: 'intro',
      quote: 'the lab',
      quoteOccurrence: 1,
      body: 'Which lab?\r\n',
    });
    expect(thread).toMatchObject({
      blockId: 'intro',
      quote: 'the lab',
      quoteOccurrence: 1,
      resolvedAt: null,
      comments: [
        {
          body: 'Which lab?',
          author: { name: `Comments x-a ${suite}`, badge: null },
          canEdit: true,
          canDelete: true,
        },
      ],
    });

    const ta = await comments.reply(await ctx(X.ta, X.page), {
      threadId: thread.id,
      body: 'Lab 2.',
    });
    expect(ta.event).toMatchObject({ tool: 'page_comment', action: 'CREATE', new_thread: false });
    expect(ta.thread!.comments.map(c => c.author?.badge)).toEqual([null, 'TA']);

    const asB = await comments.listThreads(await ctx(X.studentB, X.page));
    const seen = asB!.find(t => t.id === thread.id)!;
    expect(seen.comments.map(c => [c.canEdit, c.canDelete])).toEqual([
      [false, false],
      [false, false],
    ]);
    const json = JSON.stringify(asB);
    for (const id of [X.studentA, X.ta, X.classroomId]) expect(json).not.toContain(id);
    expect(json).not.toContain('@example.test');
    expect(json).not.toContain(`comments-${suite}-x-a"`);
  });

  it('user B can neither edit nor delete A’s comment; only an owner/teacher moderates', async () => {
    const thread = await start(X.studentA, X.page, { body: 'Mine' });
    const commentId = thread.comments[0]!.id;

    await rejects(
      comments.editComment(await ctx(X.studentB, X.page), { commentId, body: 'hijack' }),
      PageCommentsForbiddenError,
      'NOT_AUTHOR'
    );
    await rejects(
      comments.editComment(await ctx(X.owner, X.page), { commentId, body: 'owner edit' }),
      PageCommentsForbiddenError,
      'NOT_AUTHOR'
    );
    await rejects(
      comments.deleteComment(await ctx(X.studentB, X.page), { commentId }),
      PageCommentsForbiddenError,
      'NOT_AUTHOR'
    );
    await rejects(
      comments.deleteComment(await ctx(X.ta, X.page), { commentId }),
      PageCommentsForbiddenError,
      'NOT_AUTHOR'
    );

    // The author edits: "edited", body changed; the same body again is a no-op.
    const edited = await comments.editComment(await ctx(X.studentA, X.page), {
      commentId,
      body: 'Mine, edited',
    });
    expect(edited).toMatchObject({ changed: true, event: { action: 'UPDATE', body_length: 12 } });
    expect(edited.thread!.comments[0]).toMatchObject({ body: 'Mine, edited' });
    expect(edited.thread!.comments[0]!.editedAt).not.toBeNull();
    const again = await comments.editComment(await ctx(X.studentA, X.page), {
      commentId,
      body: ' Mine, edited ',
    });
    expect(again).toMatchObject({ changed: false, event: null });

    // The teacher moderates: flagged, and the thread (now empty) goes.
    const moderated = await comments.deleteComment(await ctx(X.teacher, X.page), { commentId });
    expect(moderated).toMatchObject({
      thread: null,
      changed: true,
      event: {
        action: 'DELETE',
        moderated: true,
        comment_author_id: X.studentA,
        thread_deleted: true,
      },
    });
    expect(await prisma.pageCommentThread.findUnique({ where: { id: thread.id } })).toBeNull();
  });

  it('deleting the last comment removes the thread; deleting one of two keeps it', async () => {
    const thread = await start(X.studentA, X.page, { body: 'one' });
    const second = await comments.reply(await ctx(X.studentB, X.page), {
      threadId: thread.id,
      body: 'two',
    });
    const [first, reply] = second.thread!.comments;

    const kept = await comments.deleteComment(await ctx(X.studentA, X.page), {
      commentId: first!.id,
    });
    expect(kept).toMatchObject({
      changed: true,
      event: { moderated: false, thread_deleted: false },
    });
    expect(kept.thread!.comments.map(c => c.id)).toEqual([reply!.id]);

    const gone = await comments.deleteComment(await ctx(X.studentB, X.page), {
      commentId: reply!.id,
    });
    expect(gone).toMatchObject({ thread: null, event: { thread_deleted: true } });
    // Deleting it again: not found (the comment is gone).
    await rejects(
      comments.deleteComment(await ctx(X.studentB, X.page), { commentId: reply!.id }),
      PageCommentsNotFoundError
    );
  });

  it('classroom X vs Y: Y’s thread and comment ids are not found through X’s page', async () => {
    const yThread = await start(Y.studentA, Y.page, { blockId: 'intro', body: 'In Y' });
    const yComment = yThread.comments[0]!.id;
    const owner = await ctx(X.owner, X.page);

    await rejects(
      comments.reply(owner, { threadId: yThread.id, body: 'x' }),
      PageCommentsNotFoundError
    );
    await rejects(
      comments.editComment(await ctx(Y.studentA, X.page), { commentId: yComment, body: 'x' }),
      PageCommentsNotFoundError
    );
    await rejects(
      comments.deleteComment(owner, { commentId: yComment }),
      PageCommentsNotFoundError
    );
    await rejects(
      comments.setReaction(owner, { commentId: yComment, emoji: '👍', on: true }),
      PageCommentsNotFoundError
    );
    await rejects(
      comments.setResolved(owner, { threadId: yThread.id, resolved: true }),
      PageCommentsNotFoundError
    );

    // Listing X's page never includes Y's threads; a Y student has no access to X's page.
    const xList = await comments.listThreads(owner);
    expect(xList!.some(t => t.id === yThread.id)).toBe(false);
    expect(await comments.listThreads(await ctx(Y.studentA, X.page))).toBeNull();
    await rejects(
      comments.createThread(await ctx(Y.studentA, X.page), { body: 'intrude' }),
      PageCommentsNotFoundError
    );

    // Nothing changed in Y.
    const yList = await comments.listThreads(await ctx(Y.studentA, Y.page));
    const still = yList!.find(t => t.id === yThread.id)!;
    expect(still).toMatchObject({ resolvedAt: null, comments: [{ body: 'In Y', reactions: [] }] });
  });

  it('a thread id from another page of the SAME classroom is not found', async () => {
    const elsewhere = await start(X.studentA, X.other, { body: 'Other page' });
    const onPage = await ctx(X.studentA, X.page);
    await rejects(
      comments.reply(onPage, { threadId: elsewhere.id, body: 'x' }),
      PageCommentsNotFoundError
    );
    await rejects(
      comments.editComment(onPage, { commentId: elsewhere.comments[0]!.id, body: 'x' }),
      PageCommentsNotFoundError
    );
    expect((await comments.listThreads(onPage))!.some(t => t.id === elsewhere.id)).toBe(false);
  });

  it('a pending-invite student and a non-member are refused; drafts are staff-only', async () => {
    const pending = await makeUser('x-pending');
    await join(X.classroomId, pending, 'STUDENT', false);
    const pendingCtx = await ctx(pending, X.page);
    expect(pendingCtx.access.canRead).toBe(false);
    expect(await comments.listThreads(pendingCtx)).toBeNull();
    expect(await comments.countsForViewer(pendingCtx)).toBeNull();
    await rejects(comments.createThread(pendingCtx, { body: 'hi' }), PageCommentsNotFoundError);

    expect(await comments.listThreads(await ctx(X.studentA, X.draft))).toBeNull();
    await rejects(
      comments.createThread(await ctx(X.studentA, X.draft), { body: 'hi' }),
      PageCommentsNotFoundError
    );
    const staff = await start(X.ta, X.draft, { body: 'Draft note' });
    expect(staff.comments[0]!.author?.badge).toBe('TA');
  });

  it('a resolved thread refuses replies until reopened; students cannot resolve', async () => {
    const thread = await start(X.studentA, X.page, { body: 'Typo here' });
    await rejects(
      comments.setResolved(await ctx(X.studentA, X.page), { threadId: thread.id, resolved: true }),
      PageCommentsForbiddenError,
      'NOT_TEACHING_TEAM'
    );

    const taCtx = await ctx(X.ta, X.page);
    const resolved = await comments.setResolved(taCtx, { threadId: thread.id, resolved: true });
    expect(resolved).toMatchObject({
      changed: true,
      event: { tool: 'page_comment_thread', action: 'UPDATE', resolved: true },
      thread: { resolvedBy: { badge: 'TA' } },
    });
    expect(resolved.thread!.resolvedAt).not.toBeNull();
    expect(
      await comments.setResolved(taCtx, { threadId: thread.id, resolved: true })
    ).toMatchObject({ changed: false, event: null });

    await rejects(
      comments.reply(await ctx(X.studentB, X.page), { threadId: thread.id, body: 'me too' }),
      PageCommentsValidationError,
      'THREAD_RESOLVED'
    );
    // Resolved threads leave the open counts but stay listed.
    const counts = await comments.countsForViewer(await ctx(X.studentB, X.page));
    const list = await comments.listThreads(await ctx(X.studentB, X.page));
    expect(list!.some(t => t.id === thread.id)).toBe(true);
    expect(counts!.open).toBe(list!.filter(t => t.resolvedAt === null).length);

    const reopened = await comments.setResolved(await ctx(X.teacher, X.page), {
      threadId: thread.id,
      resolved: false,
    });
    expect(reopened.thread).toMatchObject({ resolvedAt: null, resolvedBy: null });
    const replied = await comments.reply(await ctx(X.studentB, X.page), {
      threadId: thread.id,
      body: 'me too',
    });
    expect(replied.thread!.comments).toHaveLength(2);
  });

  it('reactions are idempotent both ways, per user, capped at 20 distinct emoji', async () => {
    const thread = await start(X.studentA, X.page, { body: 'React to me' });
    const commentId = thread.comments[0]!.id;
    const a = await ctx(X.studentA, X.page);
    const b = await ctx(X.studentB, X.page);

    const on = await comments.setReaction(a, { commentId, emoji: '👍', on: true });
    expect(on).toMatchObject({
      changed: true,
      event: { tool: 'page_comment_reaction', action: 'CREATE', emoji: '👍' },
    });
    expect(await comments.setReaction(a, { commentId, emoji: '👍', on: true })).toMatchObject({
      changed: false,
      event: null,
    });
    const both = await comments.setReaction(b, { commentId, emoji: '👍', on: true });
    expect(both.thread!.comments[0]!.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);

    const off = await comments.setReaction(a, { commentId, emoji: '👍', on: false });
    expect(off).toMatchObject({ changed: true, event: { action: 'DELETE' } });
    expect(off.thread!.comments[0]!.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(await comments.setReaction(a, { commentId, emoji: '👍', on: false })).toMatchObject({
      changed: false,
    });

    // Fill to 20 distinct emoji; the 21st new one is refused, an existing one is fine.
    const emoji = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂'];
    expect(emoji).toHaveLength(19);
    for (const e of emoji) await comments.setReaction(a, { commentId, emoji: e, on: true });
    await rejects(
      comments.setReaction(a, { commentId, emoji: '🎉', on: true }),
      PageCommentsValidationError,
      'TOO_MANY_REACTIONS'
    );
    expect((await comments.setReaction(a, { commentId, emoji: '👍', on: true })).changed).toBe(
      true
    );
  });

  it('a reply racing the delete of the last comment is never lost after reporting success', async () => {
    for (let round = 0; round < 12; round++) {
      const thread = await start(X.studentA, X.page, { body: `race ${round}` });
      const [deleted, replied] = await Promise.allSettled([
        comments.deleteComment(await ctx(X.studentA, X.page), {
          commentId: thread.comments[0]!.id,
        }),
        comments.reply(await ctx(X.studentB, X.page), { threadId: thread.id, body: 'late' }),
      ]);
      expect(deleted.status).toBe('fulfilled');
      if (replied.status === 'fulfilled') {
        // The reply won: its comment and the thread survive the delete.
        const id = (replied.value.event as { comment_id: string }).comment_id;
        expect(await prisma.pageComment.count({ where: { id } })).toBe(1);
        expect(deleted.status === 'fulfilled' && deleted.value.thread).not.toBeNull();
      } else {
        // The delete won: the thread is gone and the reply was told so.
        expect(replied.reason).toBeInstanceOf(PageCommentsNotFoundError);
        expect(await prisma.pageCommentThread.count({ where: { id: thread.id } })).toBe(0);
      }
    }
  });

  it('concurrent new emoji never push a comment past 20 distinct', async () => {
    const thread = await start(X.studentA, X.page, { body: 'cap race' });
    const commentId = thread.comments[0]!.id;
    const a = await ctx(X.studentA, X.page);
    for (const e of [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚']) {
      await comments.setReaction(a, { commentId, emoji: e, on: true });
    }
    const results = await Promise.allSettled(
      [...'🎉🚀👀🔥💯'].map(async (emoji, i) =>
        comments.setReaction(
          await ctx([X.studentA, X.studentB, X.ta, X.teacher, X.owner][i]!, X.page),
          {
            commentId,
            emoji,
            on: true,
          }
        )
      )
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect((r.reason as { code?: string }).code).toBe('TOO_MANY_REACTIONS');
      }
    }
    const distinct = await prisma.pageCommentReaction.findMany({
      where: { comment_id: commentId },
      distinct: ['emoji'],
    });
    expect(distinct).toHaveLength(20);
  });

  it('locked sections: a thread inside stays hidden until unlocked, even once its block is gone', async () => {
    const owner = await ctx(X.owner, X.page);
    const inside = (
      await comments.createThread(owner, { blockId: 'L1-body', quote: '42', body: 'Spoiler' })
    ).thread!;
    expect(
      await prisma.pageCommentThread.findUnique({
        where: { id: inside.id },
        select: { locked_section_id: true },
      })
    ).toEqual({ locked_section_id: 'L1' });

    const before = await ctx(X.studentB, X.page);
    expect((await comments.listThreads(before))!.some(t => t.id === inside.id)).toBe(false);
    await rejects(
      comments.reply(before, { threadId: inside.id, body: 'peek' }),
      PageCommentsNotFoundError
    );
    await rejects(
      comments.setReaction(before, { commentId: inside.comments[0]!.id, emoji: '👀', on: true }),
      PageCommentsNotFoundError
    );
    await rejects(
      comments.createThread(before, { blockId: 'L1-body', body: 'probe' }),
      PageCommentsValidationError,
      'INVALID_BLOCK'
    );

    // The block is deleted from the page: still gated by its locked section.
    const goneBefore = await ctx(X.studentB, X.page, DOC_WITHOUT_BODY);
    expect((await comments.listThreads(goneBefore))!.some(t => t.id === inside.id)).toBe(false);
    expect(
      (await comments.listThreads(await ctx(X.ta, X.page, DOC_WITHOUT_BODY)))!.some(
        t => t.id === inside.id
      )
    ).toBe(true);

    await sections.recordUnlock({
      page: { id: X.page.id, classroom_id: X.classroomId },
      userId: X.studentB,
      blockId: 'L1',
    });
    const after = await ctx(X.studentB, X.page);
    expect((await comments.listThreads(after))!.some(t => t.id === inside.id)).toBe(true);
    expect((await comments.countsForViewer(after))!.counts['L1-body']).toBe(1);
    const goneAfter = await ctx(X.studentB, X.page, DOC_WITHOUT_BODY);
    expect((await comments.listThreads(goneAfter))!.some(t => t.id === inside.id)).toBe(true);
  });

  it('orders threads by document position, then page-level, then orphans', async () => {
    const fresh = await prisma.page.create({
      data: {
        classroom_id: X.classroomId,
        title: `order x ${suite}`,
        content_path: `pages/order-x-${suite}`,
        created_by: X.owner,
        is_draft: false,
      },
      select: PAGE_SELECT,
    });
    const outro = await start(X.studentA, fresh, { blockId: 'outro', body: '1' });
    const page = await start(X.studentA, fresh, { body: '2' });
    const intro = await start(X.studentA, fresh, { blockId: 'intro', body: '3' });
    const orphan = await start(X.owner, fresh, { blockId: 'L1-body', body: '4' });
    const list = await comments.listThreads(await ctx(X.owner, fresh, DOC_WITHOUT_BODY));
    expect(list!.map(t => t.id)).toEqual([intro.id, outro.id, page.id, orphan.id]);
    expect(await comments.countsForViewer(await ctx(X.owner, fresh, DOC_WITHOUT_BODY))).toEqual({
      counts: { intro: 1, outro: 1 },
      pageLevel: 1,
      open: 4,
    });
  });

  it('a deleted user’s comment shows a null author and only a moderator may delete it', async () => {
    const ghost = await makeUser('x-ghost');
    await join(X.classroomId, ghost, 'STUDENT');
    const thread = await start(ghost, X.page, { body: 'Soon gone' });
    await prisma.user.delete({ where: { id: ghost } });

    const list = await comments.listThreads(await ctx(X.studentA, X.page));
    const seen = list!.find(t => t.id === thread.id)!;
    expect(seen.comments[0]).toMatchObject({
      author: null,
      body: 'Soon gone',
      canEdit: false,
      canDelete: false,
    });
    await rejects(
      comments.deleteComment(await ctx(X.studentA, X.page), { commentId: seen.comments[0]!.id }),
      PageCommentsForbiddenError,
      'NOT_AUTHOR'
    );
    const removed = await comments.deleteComment(await ctx(X.owner, X.page), {
      commentId: seen.comments[0]!.id,
    });
    expect(removed.event).toMatchObject({ moderated: true, comment_author_id: null });
  });

  it('badges follow the CURRENT membership; a removed member keeps their name', async () => {
    const leaver = await makeUser('x-leaver');
    await join(X.classroomId, leaver, 'ASSISTANT');
    const thread = await start(leaver, X.page, { body: 'TA here' });
    expect(thread.comments[0]!.author).toMatchObject({ badge: 'TA' });
    await prisma.classroomMembership.deleteMany({
      where: { user_id: leaver, classroom_id: X.classroomId },
    });
    const list = await comments.listThreads(await ctx(X.studentA, X.page));
    expect(list!.find(t => t.id === thread.id)!.comments[0]!.author).toEqual({
      name: `Comments x-leaver ${suite}`,
      image: `https://avatars.example/${suite}-x-leaver.png`,
      badge: null,
    });
  });

  it('a LOCKED classroom reads but refuses writes, except for its owner', async () => {
    const thread = await start(X.studentA, X.page, { body: 'Before the lock' });
    await prisma.classroom.update({ where: { id: X.classroomId }, data: { status: 'LOCKED' } });
    try {
      const lockedPage = { ...X.page, classroom: { status: 'LOCKED' } };
      const student = await ctx(X.studentA, lockedPage);
      expect(student.access).toMatchObject({ canRead: true, canWrite: false, frozen: true });
      expect((await comments.listThreads(student))!.some(t => t.id === thread.id)).toBe(true);
      await rejects(
        comments.reply(student, { threadId: thread.id, body: 'x' }),
        PageCommentsForbiddenError,
        'CLASSROOM_LOCKED'
      );
      const owner = await ctx(X.owner, lockedPage);
      expect(owner.access.frozen).toBe(false);
    } finally {
      await prisma.classroom.update({ where: { id: X.classroomId }, data: { status: 'ACTIVE' } });
    }
  });

  it('writes the audit row without body text, one per event (dedupe off)', async () => {
    const studentCtx = await ctx(X.studentA, X.page);
    const result = await comments.createThread(studentCtx, { body: 'secret words here' });
    for (let i = 0; i < 2; i++) {
      const row = comments.commentAuditRow({ ctx: studentCtx, event: result.event, via: 'web' })!;
      await audit.create(row, { dedupe: false });
    }
    const rows = await prisma.auditLog.findMany({
      where: { classroom_id: X.classroomId, resource_id: X.page.id, user_id: X.studentA },
    });
    const mine = rows.filter(
      r => (r.data as { thread_id?: string } | null)?.thread_id === result.thread!.id
    );
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ resource_type: 'PAGES', action: 'CREATE', role: 'STUDENT' });
    expect(mine[0]!.data).toMatchObject({ tool: 'page_comment', via: 'web', body_length: 17 });
    expect(JSON.stringify(mine)).not.toContain('secret');
  });

  it('a page delete takes its threads, comments and reactions', async () => {
    const doomed = await prisma.page.create({
      data: {
        classroom_id: X.classroomId,
        title: `doomed x ${suite}`,
        content_path: `pages/doomed-x-${suite}`,
        created_by: X.owner,
        is_draft: false,
      },
      select: PAGE_SELECT,
    });
    const thread = await start(X.studentA, doomed, { body: 'bye' });
    await comments.setReaction(await ctx(X.studentB, doomed), {
      commentId: thread.comments[0]!.id,
      emoji: '👋',
      on: true,
    });
    await prisma.page.delete({ where: { id: doomed.id } });
    expect(await prisma.pageCommentThread.count({ where: { id: thread.id } })).toBe(0);
    expect(await prisma.pageComment.count({ where: { thread_id: thread.id } })).toBe(0);
    expect(
      await prisma.pageCommentReaction.count({ where: { comment_id: thread.comments[0]!.id } })
    ).toBe(0);
  });
});
