import getPrisma from '@classmoji/database';
import { Prisma } from '@prisma/client';
import type { FeedbackCategory, FeedbackStatus } from '@prisma/client';
import { createNotifications } from './notification.service.ts';

/**
 * The public feedback board: anyone reads, signed-in users post, vote, comment
 * and follow, platform admins move posts through a status (which places them on
 * the roadmap). Who may call what is decided by the route; this module checks
 * the content and keeps the denormalized counts honest.
 */

export const FEEDBACK_STATUSES = ['IN_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETED'] as const;
export const FEEDBACK_CATEGORIES = ['FEATURE', 'BUG', 'INTEGRATION'] as const;

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  IN_REVIEW: 'In review',
  PLANNED: 'Planned',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
};

export type FeedbackSort = 'top' | 'new' | 'trending';

const LIMITS = { titleMin: 3, titleMax: 120, body: 5000, comment: 3000 };
/** The board shows at most this many posts; search narrows it. */
const LIST_LIMIT = 200;

export class FeedbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackValidationError';
  }
}

export class FeedbackNotFoundError extends Error {
  constructor(message = 'That post no longer exists.') {
    super(message);
    this.name = 'FeedbackNotFoundError';
  }
}

/** Only a name and avatar ever leave this module, never an email. */
const PUBLIC_AUTHOR = { select: { id: true, name: true, image: true } } as const;

export const isFeedbackStatus = (value: unknown): value is FeedbackStatus =>
  typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value);

export const isFeedbackCategory = (value: unknown): value is FeedbackCategory =>
  typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);

/**
 * A post as the public sees it: the raw `author_id` never leaves this module,
 * and an anonymous post has no author at all. `viewerIsAuthor` still lets the
 * person who wrote it manage it.
 */
const publicPost = <P extends { author_id: string | null; is_anonymous: boolean; author: unknown }>(
  post: P,
  viewerId: string | null | undefined
) => {
  const { author_id, ...rest } = post;
  return {
    ...rest,
    author: post.is_anonymous ? null : post.author,
    viewerIsAuthor: Boolean(viewerId && author_id === viewerId),
  };
};

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

// ─────────────────── Reading ───────────────────

/**
 * Posts for the board. `trending` weighs votes by age (newer rises), the rest
 * sort in the database. `viewerVoted` is filled in when a viewer is signed in.
 */
export const listPosts = async ({
  sort = 'top',
  status,
  query,
  viewerId,
}: {
  sort?: FeedbackSort;
  status?: FeedbackStatus | null;
  query?: string;
  viewerId?: string | null;
}) => {
  const q = query?.trim();
  const posts = await getPrisma().feedbackPost.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { body: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy:
      sort === 'new' ? [{ created_at: 'desc' }] : [{ vote_count: 'desc' }, { created_at: 'desc' }],
    take: LIST_LIMIT,
    include: { author: PUBLIC_AUTHOR },
  });

  const ordered =
    sort === 'trending' ? [...posts].sort((a, b) => trendScore(b) - trendScore(a)) : posts;

  const voted = await votedPostIds(
    viewerId,
    ordered.map(p => p.id)
  );
  return ordered.map(post => ({ ...publicPost(post, viewerId), viewerVoted: voted.has(post.id) }));
};

const trendScore = (post: { vote_count: number; created_at: Date }) => {
  const ageDays = (Date.now() - post.created_at.getTime()) / 86_400_000;
  return post.vote_count / Math.pow(ageDays + 2, 1.2);
};

/** The latest posts marked Completed, newest first: proof the board ships. */
export const listRecentlyShipped = async (limit = 5) =>
  getPrisma().feedbackPost.findMany({
    where: { status: 'COMPLETED' },
    orderBy: [{ status_changed_at: { sort: 'desc', nulls: 'last' } }, { updated_at: 'desc' }],
    take: limit,
    select: { id: true, title: true, status_changed_at: true, vote_count: true },
  });

/** Triaged posts grouped by status for the roadmap, most-voted first. */
export const listRoadmap = async (viewerId?: string | null) => {
  const posts = await getPrisma().feedbackPost.findMany({
    where: { status: { not: null } },
    orderBy: [{ vote_count: 'desc' }, { created_at: 'desc' }],
    include: { author: PUBLIC_AUTHOR },
  });
  const voted = await votedPostIds(
    viewerId,
    posts.map(p => p.id)
  );
  type RoadmapPost = ReturnType<typeof publicPost<(typeof posts)[number]>> & {
    viewerVoted: boolean;
  };
  const columns = Object.fromEntries(
    FEEDBACK_STATUSES.map(status => [status, [] as RoadmapPost[]])
  ) as Record<FeedbackStatus, RoadmapPost[]>;
  for (const post of posts) {
    if (post.status) {
      columns[post.status].push({ ...publicPost(post, viewerId), viewerVoted: voted.has(post.id) });
    }
  }
  return columns;
};

const votedPostIds = async (viewerId: string | null | undefined, postIds: string[]) => {
  if (!viewerId || postIds.length === 0) return new Set<string>();
  const votes = await getPrisma().feedbackVote.findMany({
    where: { user_id: viewerId, post_id: { in: postIds } },
    select: { post_id: true },
  });
  return new Set(votes.map(v => v.post_id));
};

/** One post with its comments and replies, and the viewer's votes and follow. */
export const getPost = async (postId: string, viewerId?: string | null) => {
  const post = await getPrisma().feedbackPost.findUnique({
    where: { id: postId },
    include: {
      author: PUBLIC_AUTHOR,
      comments: {
        where: { parent_id: null },
        orderBy: { created_at: 'asc' },
        include: {
          author: PUBLIC_AUTHOR,
          replies: { orderBy: { created_at: 'asc' }, include: { author: PUBLIC_AUTHOR } },
        },
      },
    },
  });
  if (!post) return null;

  const commentIds = post.comments.flatMap(c => [c.id, ...c.replies.map(r => r.id)]);
  const [vote, follow, commentVotes] = viewerId
    ? await Promise.all([
        getPrisma().feedbackVote.findUnique({
          where: { post_id_user_id: { post_id: postId, user_id: viewerId } },
          select: { id: true },
        }),
        getPrisma().feedbackFollow.findUnique({
          where: { post_id_user_id: { post_id: postId, user_id: viewerId } },
          select: { id: true },
        }),
        getPrisma().feedbackCommentVote.findMany({
          where: { user_id: viewerId, comment_id: { in: commentIds } },
          select: { comment_id: true },
        }),
      ])
    : [null, null, []];

  const votedComments = new Set(commentVotes.map(v => v.comment_id));
  const withVote = <T extends { id: string }>(c: T) => ({
    ...c,
    viewerVoted: votedComments.has(c.id),
  });

  return {
    ...publicPost(post, viewerId),
    comments: post.comments.map(c => ({ ...withVote(c), replies: c.replies.map(withVote) })),
    viewerVoted: Boolean(vote),
    viewerFollows: Boolean(follow),
  };
};

// ─────────────────── Writing ───────────────────

const cleanTitle = (title: string) => {
  const value = title.trim().replace(/\s+/g, ' ');
  if (value.length < LIMITS.titleMin) throw new FeedbackValidationError('Give your post a title.');
  if (value.length > LIMITS.titleMax)
    throw new FeedbackValidationError(`Keep the title under ${LIMITS.titleMax} characters.`);
  return value;
};

const cleanBody = (body: string, max: number, required: boolean, what: string) => {
  const value = body.replace(/\r\n/g, '\n').trim();
  if (required && !value) throw new FeedbackValidationError(`Write a ${what}.`);
  if (value.length > max)
    throw new FeedbackValidationError(`Keep the ${what} under ${max} characters.`);
  return value;
};

/**
 * A new post; its author votes for it and follows it, like on any board. An
 * anonymous post still records its author (for deleting, rate limits and
 * status updates) but never shows it.
 */
export const createPost = async ({
  authorId,
  title,
  body,
  category = 'FEATURE',
  isAnonymous = false,
}: {
  authorId: string;
  title: string;
  body: string;
  category?: FeedbackCategory;
  isAnonymous?: boolean;
}) => {
  if (!isFeedbackCategory(category)) throw new FeedbackValidationError('Pick a category.');
  const data = {
    title: cleanTitle(title),
    body: cleanBody(body, LIMITS.body, true, 'description'),
    category,
    is_anonymous: isAnonymous,
  };
  return getPrisma().feedbackPost.create({
    data: {
      ...data,
      author_id: authorId,
      vote_count: 1,
      votes: { create: { user_id: authorId } },
      follows: { create: { user_id: authorId } },
    },
    select: { id: true },
  });
};

/** Adds or removes the user's vote. Voting also follows the post. */
export const togglePostVote = async (postId: string, userId: string) => {
  const prisma = getPrisma();
  return prisma.$transaction(async tx => {
    const post = await tx.feedbackPost.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) throw new FeedbackNotFoundError();
    const existing = await tx.feedbackVote.findUnique({
      where: { post_id_user_id: { post_id: postId, user_id: userId } },
      select: { id: true },
    });
    if (existing) {
      await tx.feedbackVote.delete({ where: { id: existing.id } });
      const { vote_count } = await tx.feedbackPost.update({
        where: { id: postId },
        data: { vote_count: { decrement: 1 } },
        select: { vote_count: true },
      });
      return { voted: false, voteCount: vote_count };
    }
    try {
      await tx.feedbackVote.create({ data: { post_id: postId, user_id: userId } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    await tx.feedbackFollow.upsert({
      where: { post_id_user_id: { post_id: postId, user_id: userId } },
      create: { post_id: postId, user_id: userId },
      update: {},
    });
    const { vote_count } = await tx.feedbackPost.update({
      where: { id: postId },
      data: { vote_count: { increment: 1 } },
      select: { vote_count: true },
    });
    return { voted: true, voteCount: vote_count };
  });
};

/** A comment, or a reply to a top-level comment on the same post. */
export const addComment = async ({
  postId,
  authorId,
  body,
  parentId,
}: {
  postId: string;
  authorId: string;
  body: string;
  parentId?: string | null;
}) => {
  const text = cleanBody(body, LIMITS.comment, true, 'comment');
  const prisma = getPrisma();
  return prisma.$transaction(async tx => {
    const post = await tx.feedbackPost.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) throw new FeedbackNotFoundError();
    if (parentId) {
      const parent = await tx.feedbackComment.findUnique({
        where: { id: parentId },
        select: { post_id: true, parent_id: true },
      });
      if (!parent || parent.post_id !== postId || parent.parent_id) {
        throw new FeedbackValidationError('You can only reply to a comment on this post.');
      }
    }
    const comment = await tx.feedbackComment.create({
      data: { post_id: postId, author_id: authorId, parent_id: parentId ?? null, body: text },
      select: { id: true },
    });
    await tx.feedbackPost.update({
      where: { id: postId },
      data: { comment_count: { increment: 1 } },
    });
    return comment;
  });
};

export const toggleCommentVote = async (commentId: string, userId: string) => {
  const prisma = getPrisma();
  return prisma.$transaction(async tx => {
    const comment = await tx.feedbackComment.findUnique({
      where: { id: commentId },
      select: { id: true },
    });
    if (!comment) throw new FeedbackNotFoundError('That comment no longer exists.');
    const existing = await tx.feedbackCommentVote.findUnique({
      where: { comment_id_user_id: { comment_id: commentId, user_id: userId } },
      select: { id: true },
    });
    if (existing) {
      await tx.feedbackCommentVote.delete({ where: { id: existing.id } });
      const { vote_count } = await tx.feedbackComment.update({
        where: { id: commentId },
        data: { vote_count: { decrement: 1 } },
        select: { vote_count: true },
      });
      return { voted: false, voteCount: vote_count };
    }
    try {
      await tx.feedbackCommentVote.create({ data: { comment_id: commentId, user_id: userId } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const { vote_count } = await tx.feedbackComment.update({
      where: { id: commentId },
      data: { vote_count: { increment: 1 } },
      select: { vote_count: true },
    });
    return { voted: true, voteCount: vote_count };
  });
};

export const toggleFollow = async (postId: string, userId: string) => {
  const prisma = getPrisma();
  const existing = await prisma.feedbackFollow.findUnique({
    where: { post_id_user_id: { post_id: postId, user_id: userId } },
    select: { id: true },
  });
  if (existing) {
    await prisma.feedbackFollow.delete({ where: { id: existing.id } });
    return { following: false };
  }
  const post = await prisma.feedbackPost.findUnique({
    where: { id: postId },
    select: { id: true },
  });
  if (!post) throw new FeedbackNotFoundError();
  try {
    await prisma.feedbackFollow.create({ data: { post_id: postId, user_id: userId } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return { following: true };
};

/**
 * Moves a post to a status (null takes it off the roadmap) and tells its
 * followers, except whoever made the change. Notifying never fails the update.
 */
export const setStatus = async ({
  postId,
  status,
  actorId,
}: {
  postId: string;
  status: FeedbackStatus | null;
  actorId: string;
}) => {
  if (status !== null && !isFeedbackStatus(status))
    throw new FeedbackValidationError('Unknown status.');
  const prisma = getPrisma();
  const before = await prisma.feedbackPost.findUnique({
    where: { id: postId },
    select: { status: true },
  });
  if (!before) throw new FeedbackNotFoundError();
  const post = await prisma.feedbackPost.update({
    where: { id: postId },
    data: { status, ...(status !== before.status ? { status_changed_at: new Date() } : {}) },
    select: { id: true, title: true, status: true },
  });

  if (status && status !== before.status) {
    const followers = await prisma.feedbackFollow.findMany({
      where: { post_id: postId, user_id: { not: actorId } },
      select: { user_id: true },
    });
    await createNotifications({
      type: 'FEEDBACK_STATUS_CHANGED',
      classroomId: null,
      recipientUserIds: followers.map(f => f.user_id),
      resourceType: 'feedback_post',
      resourceId: postId,
      title: post.title,
      metadata: { status, status_label: FEEDBACK_STATUS_LABELS[status] },
    });
  }
  return post;
};

/** Who wrote a post or comment, so the route can let authors delete their own. */
export const getPostAuthorId = async (postId: string) =>
  (
    await getPrisma().feedbackPost.findUnique({
      where: { id: postId },
      select: { author_id: true },
    })
  )?.author_id ?? null;

export const getCommentAuthorId = async (commentId: string) =>
  (
    await getPrisma().feedbackComment.findUnique({
      where: { id: commentId },
      select: { author_id: true },
    })
  )?.author_id ?? null;

export const deletePost = async (postId: string) => {
  await getPrisma().feedbackPost.delete({ where: { id: postId } });
};

/** Deletes a comment and its replies, and keeps the post's count in step. */
export const deleteComment = async (commentId: string) => {
  const prisma = getPrisma();
  await prisma.$transaction(async tx => {
    const comment = await tx.feedbackComment.findUnique({
      where: { id: commentId },
      select: { post_id: true, _count: { select: { replies: true } } },
    });
    if (!comment) throw new FeedbackNotFoundError('That comment no longer exists.');
    await tx.feedbackComment.delete({ where: { id: commentId } });
    await tx.feedbackPost.update({
      where: { id: comment.post_id },
      data: { comment_count: { decrement: 1 + comment._count.replies } },
    });
  });
};
