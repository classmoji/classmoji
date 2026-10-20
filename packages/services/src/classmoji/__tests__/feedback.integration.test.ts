/**
 * The feedback board's service against a REAL Postgres: the denormalized vote
 * and comment counts must stay in step with the rows under toggles, sets and
 * deletes, voting must follow, setting a state twice must change nothing, and a
 * status change must notify followers but not the admin who made it.
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

  it('hides the author of an anonymous comment but lets them manage it', async () => {
    const { id: anonPostId } = await feedback.createPost({
      authorId: author,
      title: `Anonymous comment ${suite}`,
      body: 'Thread',
    });
    await feedback.addComment({
      postId: anonPostId,
      authorId: voter,
      body: 'Quietly agree',
      isAnonymous: true,
    });
    const asOther = await feedback.getPost(anonPostId, author);
    expect(asOther?.comments[0]?.author).toBeNull();
    expect(asOther?.comments[0]).not.toHaveProperty('author_id');
    expect(asOther?.comments[0]?.viewerIsAuthor).toBe(false);
    expect((await feedback.getPost(anonPostId, voter))?.comments[0]?.viewerIsAuthor).toBe(true);
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

  it('leaves a completed post off the board unless asked for by status', async () => {
    const open = await feedback.listPosts({ query: suite });
    expect(open.map(p => p.id)).not.toContain(postId);
    // Other open posts in the suite still list.
    expect(open.length).toBeGreaterThan(0);
  });

  it('includes completed posts in an unfiltered search only when asked', async () => {
    const all = await feedback.listPosts({ query: suite, includeCompleted: true });
    expect(all.map(p => p.id)).toContain(postId);
    expect(all.length).toBeGreaterThan(1);
    const open = await feedback.listPosts({ query: suite });
    expect(open.map(p => p.id)).not.toContain(postId);
  });

  it('lists by top and finds by search', async () => {
    const found = await feedback.listPosts({
      sort: 'top',
      status: 'COMPLETED',
      query: suite,
      viewerId: voter,
    });
    expect(found[0]?.id).toBe(postId);
    expect(found[0]?.viewerVoted).toBe(true);
    expect(found[0]?.author).not.toHaveProperty('email');
  });

  it('stores a category and refuses an unknown one', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `A bug ${suite}`,
      body: 'Broken',
      category: 'BUG',
    });
    expect((await feedback.getPost(id))?.category).toBe('BUG');
    await expect(
      feedback.createPost({
        authorId: author,
        title: `Unknown kind ${suite}`,
        body: 'Body',
        category: 'QUESTION' as never,
      })
    ).rejects.toBeInstanceOf(feedback.FeedbackValidationError);
  });

  it('sets a post vote: twice changes nothing, false removes, voting follows', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `Set votes ${suite}`,
      body: 'Body',
    });
    expect(await feedback.setPostVote(id, voter, true)).toEqual({ voted: true, voteCount: 2 });
    expect(await feedback.setPostVote(id, voter, true)).toEqual({ voted: true, voteCount: 2 });
    expect(await prisma.feedbackVote.count({ where: { post_id: id } })).toBe(2);
    expect((await feedback.getPost(id, voter))?.viewerFollows).toBe(true);

    expect(await feedback.setPostVote(id, voter, false)).toEqual({ voted: false, voteCount: 1 });
    expect(await feedback.setPostVote(id, voter, false)).toEqual({ voted: false, voteCount: 1 });
    expect(await prisma.feedbackVote.count({ where: { post_id: id } })).toBe(1);
    expect((await prisma.feedbackPost.findUnique({ where: { id } }))?.vote_count).toBe(1);
  });

  it('sets a comment vote: twice changes nothing, false removes', async () => {
    const { id: commentPost } = await feedback.createPost({
      authorId: author,
      title: `Comment votes ${suite}`,
      body: 'Body',
    });
    const { id } = await feedback.addComment({ postId: commentPost, authorId: author, body: 'Hi' });
    expect(await feedback.setCommentVote(id, voter, true)).toEqual({ voted: true, voteCount: 1 });
    expect(await feedback.setCommentVote(id, voter, true)).toEqual({ voted: true, voteCount: 1 });
    expect(await prisma.feedbackCommentVote.count({ where: { comment_id: id } })).toBe(1);
    expect(await feedback.setCommentVote(id, voter, false)).toEqual({
      voted: false,
      voteCount: 0,
    });
    expect(await feedback.setCommentVote(id, voter, false)).toEqual({
      voted: false,
      voteCount: 0,
    });
    expect(await prisma.feedbackCommentVote.count({ where: { comment_id: id } })).toBe(0);
  });

  it('sets a follow: twice changes nothing, false removes', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `Follows ${suite}`,
      body: 'Body',
    });
    const followRows = () =>
      prisma.feedbackFollow.count({ where: { post_id: id, user_id: voter } });
    expect(await feedback.setFollow(id, voter, true)).toEqual({ following: true });
    expect(await feedback.setFollow(id, voter, true)).toEqual({ following: true });
    expect(await followRows()).toBe(1);
    expect(await feedback.setFollow(id, voter, false)).toEqual({ following: false });
    expect(await feedback.setFollow(id, voter, false)).toEqual({ following: false });
    expect(await followRows()).toBe(0);
  });

  it('toggles a follow on, then off', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `Toggle follow ${suite}`,
      body: 'Body',
    });
    const followRows = () =>
      prisma.feedbackFollow.count({ where: { post_id: id, user_id: voter } });
    expect(await feedback.toggleFollow(id, voter)).toEqual({ following: true });
    expect(await followRows()).toBe(1);
    expect(await feedback.toggleFollow(id, voter)).toEqual({ following: false });
    expect(await followRows()).toBe(0);
  });

  it('moves the count only by the rows written when the same vote races', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `Racing votes ${suite}`,
      body: 'Body',
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => feedback.setPostVote(id, voter, true))
    );
    expect(await prisma.feedbackVote.count({ where: { post_id: id, user_id: voter } })).toBe(1);
    const rows = await prisma.feedbackVote.count({ where: { post_id: id } });
    expect(rows).toBe(2);
    expect((await prisma.feedbackPost.findUnique({ where: { id } }))?.vote_count).toBe(rows);
    // Every caller, the losers included, is told the count after the winner.
    for (const result of results) expect(result).toEqual({ voted: true, voteCount: rows });
  });

  it('keeps vote_count equal to the vote rows through a mixed burst', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `Mixed votes ${suite}`,
      body: 'Body',
    });
    await Promise.all(
      [voter, admin, author].flatMap(user => [
        feedback.togglePostVote(id, user),
        feedback.setPostVote(id, user, true),
        feedback.togglePostVote(id, user),
        feedback.setPostVote(id, user, false),
        feedback.togglePostVote(id, user),
        feedback.setPostVote(id, user, true),
      ])
    );
    const rows = await prisma.feedbackVote.count({ where: { post_id: id } });
    expect((await prisma.feedbackPost.findUnique({ where: { id } }))?.vote_count).toBe(rows);

    const { id: commentId } = await feedback.addComment({
      postId: id,
      authorId: author,
      body: 'Hi',
    });
    await Promise.all(
      [voter, admin, author].flatMap(user => [
        feedback.toggleCommentVote(commentId, user),
        feedback.setCommentVote(commentId, user, true),
        feedback.toggleCommentVote(commentId, user),
        feedback.setCommentVote(commentId, user, false),
        feedback.toggleCommentVote(commentId, user),
      ])
    );
    const commentRows = await prisma.feedbackCommentVote.count({
      where: { comment_id: commentId },
    });
    expect(
      (await prisma.feedbackComment.findUnique({ where: { id: commentId } }))?.vote_count
    ).toBe(commentRows);
  });

  it('refuses a delete of a post or comment already gone', async () => {
    const { id } = await feedback.createPost({
      authorId: author,
      title: `Deleted twice ${suite}`,
      body: 'Body',
    });
    const { id: commentId } = await feedback.addComment({
      postId: id,
      authorId: voter,
      body: 'Hi',
    });
    await feedback.deleteComment(commentId);
    await expect(feedback.deleteComment(commentId)).rejects.toBeInstanceOf(
      feedback.FeedbackNotFoundError
    );
    await feedback.deletePost(id);
    await expect(feedback.deletePost(id)).rejects.toBeInstanceOf(feedback.FeedbackNotFoundError);
  });

  it('refuses a set on a missing post or comment, even when nothing would change', async () => {
    const missing = randomUUID();
    for (const run of [
      () => feedback.setPostVote(missing, voter, false),
      () => feedback.setPostVote(missing, voter, true),
      () => feedback.setCommentVote(missing, voter, false),
      () => feedback.setCommentVote(missing, voter, true),
      () => feedback.setFollow(missing, voter, false),
      () => feedback.setFollow(missing, voter, true),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(feedback.FeedbackNotFoundError);
    }
  });
});
