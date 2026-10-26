/**
 * The feedback board's "what to build next" layer against a REAL Postgres:
 * similar-post suggestions, the Github bug template fields, status changes with a public note, reply notifications, the asker
 * marking a question answered, merging duplicates, and the admin ranking.
 *
 * Leak checks: B cannot mark A's question answered; voters' emails never
 * reach the board; a merge never counts a voter twice.
 *
 * SAFETY: fixtures are users, an org, classrooms and posts named with a fresh
 * uuid, deleted in afterAll. Skipped unless DATABASE_URL names a LOCAL,
 * non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as feedback from '../feedback.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('feedback decisions (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let alice: string; // instructor in class X
  let bob: string; // student in class Y
  let admin: string;
  let orgId: string;
  let classX: string;
  let classY: string;

  const makeUser = async (name: string) =>
    (
      await prisma.user.create({
        data: { name: `${name} ${suite}`, email: `${name}-${suite}@feedback.test` },
        select: { id: true },
      })
    ).id;

  const makeClassroom = async (label: string) =>
    (
      await prisma.classroom.create({
        data: {
          slug: `fbdec-${label}-${suite}`,
          git_org_id: orgId,
          name: `Feedback ${label} ${suite}`,
          content_namespace: `fbdec-${label}-${suite}`,
          content_repo: `content-fbdec-${label}-${suite}`,
        },
      })
    ).id;

  const post = (
    authorId: string,
    title: string,
    category: 'FEATURE' | 'BUG' | 'QUESTION' = 'FEATURE'
  ) =>
    feedback
      .createPost({ authorId, title: `${title} ${suite}`, body: 'Details', category })
      .then(p => p.id);

  beforeAll(async () => {
    alice = await makeUser('alice');
    bob = await makeUser('bob');
    admin = await makeUser('admin');
    orgId = (
      await prisma.gitOrganization.create({
        data: { provider: 'GITHUB', provider_id: `fbdec-${suite}`, login: `fbdec-${suite}` },
      })
    ).id;
    classX = await makeClassroom('x');
    classY = await makeClassroom('y');
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classX, user_id: alice, role: 'OWNER', has_accepted_invite: true },
        { classroom_id: classY, user_id: bob, role: 'STUDENT', has_accepted_invite: true },
      ],
    });
  });

  afterAll(async () => {
    await prisma.feedbackPost.deleteMany({ where: { title: { contains: suite } } });
    await prisma.notification.deleteMany({ where: { user_id: { in: [alice, bob, admin] } } });
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [alice, bob, admin] } } });
  });

  it('suggests posts sharing the title words, best match first, same type only', async () => {
    const exportBug = await post(alice, 'Gradebook export misses extra credit', 'BUG');
    await post(alice, 'Gradebook colors', 'BUG');
    await post(alice, 'Export grades to Canvas'); // a feature, not a bug

    const found = await feedback.findSimilarPosts({
      title: `gradebook export extra ${suite}`,
      category: 'BUG',
    });
    expect(found[0]?.id).toBe(exportBug);
    expect(found.every(p => p.category === 'BUG')).toBe(true);
    expect(Object.keys(found[0]).sort()).toEqual(
      ['category', 'comment_count', 'id', 'status', 'title', 'vote_count'].sort()
    );
    expect(await feedback.findSimilarPosts({ title: 'the and for' })).toEqual([]);
  });

  it('stores a bug report as the Github template fields, steps optional', async () => {
    const { id } = await feedback.createPost({
      authorId: bob,
      title: `CSV export empty ${suite}`,
      category: 'BUG',
      bug: { whatHappened: 'Nothing downloads', expected: 'A CSV file', additionalInfo: 'Chrome' },
    });
    const stored = await prisma.feedbackPost.findUniqueOrThrow({ where: { id } });
    expect(stored.bug_what_happened).toBe('Nothing downloads');
    expect(stored.bug_steps).toBeNull();
    expect(stored.body).toBe(
      'What happened?\nNothing downloads\n\nWhat should have happened?\nA CSV file\n\nAdditional info\nChrome'
    );
    await expect(
      feedback.createPost({
        authorId: bob,
        title: `Missing expected ${suite}`,
        category: 'BUG',
        bug: { whatHappened: 'Broken', expected: '  ' },
      })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);
  });

  it('records a status change with its public note and sends it to followers, not the admin', async () => {
    const idea = await post(alice, 'Canvas sync');
    await feedback.setPostVote(idea, bob, true); // voting follows

    await feedback.setStatus({
      postId: idea,
      status: 'PLANNED',
      actorId: admin,
      note: 'Planned for next month.',
    });
    const full = await feedback.getPost(idea);
    expect(full?.updates.map(u => [u.to_status, u.note])).toEqual([
      ['PLANNED', 'Planned for next month.'],
    ]);
    expect(JSON.stringify(full?.updates)).not.toContain(admin);

    const notes = await prisma.notification.findMany({
      where: { resource_id: idea, type: 'FEEDBACK_STATUS_CHANGED' },
      select: { user_id: true, metadata: true },
    });
    expect(notes.map(n => n.user_id).sort()).toEqual([alice, bob].sort());
    expect((notes[0].metadata as { note?: string }).note).toBe('Planned for next month.');
  });

  it('changes status without a note, recording no public update', async () => {
    const idea = await post(alice, 'Dark mode for slides');
    await feedback.setStatus({ postId: idea, status: 'IN_PROGRESS', actorId: admin });
    const full = await feedback.getPost(idea);
    expect(full?.status).toBe('IN_PROGRESS');
    expect(full?.updates).toEqual([]);
  });

  it("notifies a post's author of someone else's reply, never of their own", async () => {
    const question = await post(alice, 'How do TAs grade', 'QUESTION');
    await feedback.addComment({ postId: question, authorId: alice, body: 'More context' });
    expect(
      await prisma.notification.count({ where: { resource_id: question, type: 'FEEDBACK_REPLY' } })
    ).toBe(0);

    await feedback.addComment({ postId: question, authorId: bob, body: 'Here is how' });
    const replies = await prisma.notification.findMany({
      where: { resource_id: question, type: 'FEEDBACK_REPLY' },
      select: { user_id: true },
    });
    expect(replies.map(r => r.user_id)).toEqual([alice]);
  });

  it('lets only the asker mark a question answered', async () => {
    const question = await post(alice, 'Repo visibility', 'QUESTION');
    await expect(
      feedback.markQuestionAnswered({ postId: question, userId: bob, answered: true })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);
    await feedback.markQuestionAnswered({ postId: question, userId: alice, answered: true });
    expect((await feedback.getPost(question))?.status).toBe('ANSWERED');
    await feedback.markQuestionAnswered({ postId: question, userId: alice, answered: false });
    expect((await feedback.getPost(question))?.status).toBeNull();

    const idea = await post(alice, 'Not a question');
    await expect(
      feedback.markQuestionAnswered({ postId: idea, userId: alice, answered: true })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);
  });

  it('merges a duplicate without counting anyone twice, and hides it', async () => {
    const original = await post(alice, 'Dark mode site');
    const copy = await post(bob, 'Dark theme for site');
    const older = await post(admin, 'Night mode site');
    await feedback.setPostVote(original, bob, true); // bob voted on both
    await feedback.addComment({ postId: copy, authorId: alice, body: 'Yes please' });
    // An older duplicate of the copy follows it to the original.
    await feedback.markDuplicate({ postId: older, originalId: copy, actorId: admin });

    await expect(
      feedback.markDuplicate({ postId: copy, originalId: copy, actorId: admin })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);

    const { originalId } = await feedback.markDuplicate({
      postId: copy,
      originalId: original,
      actorId: admin,
    });
    expect(originalId).toBe(original);

    const merged = await prisma.feedbackPost.findUniqueOrThrow({ where: { id: original } });
    // alice (author), bob (both), admin (author of the older copy): three people, three votes.
    expect(merged.vote_count).toBe(3);
    expect(await prisma.feedbackVote.count({ where: { post_id: original } })).toBe(3);
    expect(merged.comment_count).toBe(1);
    expect(
      (await prisma.feedbackPost.findUniqueOrThrow({ where: { id: older } })).duplicate_of_id
    ).toBe(original);

    const listed = (await feedback.listPosts({ query: suite })).map(p => p.id);
    expect(listed).toContain(original);
    expect(listed).not.toContain(copy);
    expect(listed).not.toContain(older);
    // The merger is not public.
    expect(JSON.stringify(await feedback.getPost(copy))).not.toContain(admin);
    await expect(
      feedback.markDuplicate({ postId: copy, originalId: original, actorId: admin })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);
  });

  it("ranks open feature requests by voters, with each voter's highest role", async () => {
    const top = await post(bob, 'Peer review');
    await feedback.setPostVote(top, alice, true);

    const ranking = (await feedback.listFeatureRanking()).filter(p => p.title.includes(suite));
    const row = ranking.find(p => p.id === top);
    expect(row).toMatchObject({ voters: 2 });
    expect(row?.roles).toEqual({ INSTRUCTOR: 1, TA: 0, STUDENT: 1, OTHER: 0 });
    // No bugs or questions in the ranking.
    expect(ranking.every(p => !p.title.startsWith('Repo visibility'))).toBe(true);

    const voters = await feedback.listFeatureVoters(top);
    expect(voters.map(v => [v.userId, v.role]).sort()).toEqual(
      [
        [alice, 'INSTRUCTOR'],
        [bob, 'STUDENT'],
      ].sort()
    );
    // Voters' emails never reach the board.
    expect(JSON.stringify(await feedback.getPost(top))).not.toContain(`alice-${suite}@`);
  });
});
