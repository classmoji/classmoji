/**
 * The feedback board's service against a REAL Postgres: the denormalized vote
 * and comment counts must stay in step with the rows under toggles and deletes,
 * voting must follow, and a status change must notify followers but not the
 * admin who made it.
 *
 * SAFETY: fixtures are users and posts named with a fresh uuid, deleted in
 * afterAll. Nothing is truncated. Skipped unless DATABASE_URL names a LOCAL,
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

describe.skipIf(!RUN)('feedback.service (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let author: string;
  let voter: string;
  let admin: string;
  let postId: string;

  const makeUser = async (name: string) =>
    (
      await prisma.user.create({
        data: { name: `${name} ${suite}`, email: `${name}-${suite}@feedback.test` },
        select: { id: true },
      })
    ).id;

  beforeAll(async () => {
    author = await makeUser('author');
    voter = await makeUser('voter');
    admin = await makeUser('admin');
  });

  afterAll(async () => {
    await prisma.feedbackPost.deleteMany({ where: { title: { contains: suite } } });
    await prisma.notification.deleteMany({ where: { user_id: { in: [author, voter, admin] } } });
    await prisma.user.deleteMany({ where: { id: { in: [author, voter, admin] } } });
  });

  it('creates a post the author has voted for and follows', async () => {
    ({ id: postId } = await feedback.createPost({
      authorId: author,
      title: `Sync grades to Canvas ${suite}`,
      body: 'Please',
      category: 'INTEGRATION',
    }));
    const post = await feedback.getPost(postId, author);
    expect(post?.vote_count).toBe(1);
    expect(post?.viewerVoted).toBe(true);
    expect(post?.viewerFollows).toBe(true);
    expect(post?.status).toBeNull();
  });

  it('rejects an empty title or empty details', async () => {
    await expect(
      feedback.createPost({ authorId: author, title: '  ', body: 'Details', category: 'FEATURE' })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);
    await expect(
      feedback.createPost({ authorId: author, title: `No details ${suite}`, body: '  ' })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);
  });

  it('hides the author of an anonymous post but lets them manage it', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `Anonymous idea ${suite}`,
      body: 'Quietly',
      isAnonymous: true,
    });
    const asOther = await feedback.getPost(id, voter);
    expect(asOther?.author).toBeNull();
    expect(asOther).not.toHaveProperty('author_id');
    expect(asOther?.viewerIsAuthor).toBe(false);
    expect((await feedback.getPost(id, author))?.viewerIsAuthor).toBe(true);
    const listed = await feedback.listPosts({ query: `Anonymous idea ${suite}` });
    expect(listed[0]?.author).toBeNull();
    expect(listed[0]).not.toHaveProperty('author_id');
  });

  it('keeps vote_count in step and follows on vote', async () => {
    expect(await feedback.togglePostVote(postId, voter)).toEqual({ voted: true, voteCount: 2 });
    expect((await feedback.getPost(postId, voter))?.viewerFollows).toBe(true);
    expect(await feedback.togglePostVote(postId, voter)).toEqual({ voted: false, voteCount: 1 });
    expect(await feedback.togglePostVote(postId, voter)).toEqual({ voted: true, voteCount: 2 });
  });

  it('threads one level of replies and counts every comment', async () => {
    const top = await feedback.addComment({ postId, authorId: voter, body: 'Same here' });
    const reply = await feedback.addComment({
      postId,
      authorId: author,
      body: 'Thanks',
      parentId: top.id,
    });
    await expect(
      feedback.addComment({ postId, authorId: voter, body: 'Nested', parentId: reply.id })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);

    expect(await feedback.toggleCommentVote(top.id, author)).toEqual({ voted: true, voteCount: 1 });

    const post = await feedback.getPost(postId, author);
    expect(post?.comment_count).toBe(2);
    expect(post?.comments).toHaveLength(1);
    expect(post?.comments[0].replies).toHaveLength(1);
    expect(post?.comments[0].viewerVoted).toBe(true);

    await feedback.deleteComment(top.id);
    expect((await feedback.getPost(postId))?.comment_count).toBe(0);
  });

  it('puts a post on the roadmap and notifies followers except the actor', async () => {
    await feedback.togglePostVote(postId, admin); // the admin follows too
    await feedback.setStatus({ postId, status: 'PLANNED', actorId: admin });

    const roadmap = await feedback.listRoadmap();
    expect(roadmap.PLANNED.map(p => p.id)).toContain(postId);

    const notified = await prisma.notification.findMany({
      where: { resource_id: postId, type: 'FEEDBACK_STATUS_CHANGED' },
      select: { user_id: true },
    });
    expect(notified.map(n => n.user_id).sort()).toEqual([author, voter].sort());
  });

  it('lists a completed post under recently shipped', async () => {
    await feedback.setStatus({ postId, status: 'COMPLETED', actorId: admin });
    const shipped = await feedback.listRecentlyShipped(50);
    expect(shipped.map(p => p.id)).toContain(postId);
    expect(shipped.find(p => p.id === postId)?.status_changed_at).toBeInstanceOf(Date);
  });

  it('lists by top and finds by search', async () => {
    const found = await feedback.listPosts({ sort: 'top', query: suite, viewerId: voter });
    expect(found[0]?.id).toBe(postId);
    expect(found[0]?.viewerVoted).toBe(true);
    expect(found[0]?.author).not.toHaveProperty('email');
  });
});
