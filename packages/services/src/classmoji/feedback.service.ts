import getPrisma from '@classmoji/database';
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

/**
 * Per-user budgets for writing to the board: a burst, then tokens back per
 * hour. Each surface (the webapp route, the MCP) keeps its own buckets with
 * these numbers; post and comment votes share the `vote` budget.
 */
export const FEEDBACK_RATE_LIMITS = {
  post: { capacity: 5, perHour: 10 },
  comment: { capacity: 20, perHour: 60 },
  vote: { capacity: 60, perHour: 600 },
} as const satisfies Record<string, { capacity: number; perHour: number }>;

export type FeedbackRateKind = keyof typeof FEEDBACK_RATE_LIMITS;

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

/** A comment as the public sees it, under the same rule as `publicPost`. */
const publicComment = <
  C extends { author_id: string | null; is_anonymous: boolean; author: unknown },
>(
  comment: C,
  viewerId: string | null | undefined
) => {
  const { author_id, ...rest } = comment;
  return {
    ...rest,
    author: comment.is_anonymous ? null : comment.author,
    viewerIsAuthor: Boolean(viewerId && author_id === viewerId),
  };
};

// ─────────────────── Reading ───────────────────

/**
 * Posts for the board. `trending` weighs votes by age (newer rises), the rest
 * sort in the database. `viewerVoted` is filled in when a viewer is signed in.
 * Completed posts show only when asked for by status: unfiltered, the board
 * lists what is still open, and shipped work lives on the roadmap.
 * `includeCompleted` lifts that for a search across every status (the MCP).
 */
export const listPosts = async ({
  sort = 'top',
  status,
  query,
  viewerId,
  includeCompleted = false,
}: {
  sort?: FeedbackSort;
  status?: FeedbackStatus | null;
  query?: string;
  viewerId?: string | null;
  includeCompleted?: boolean;
}) => {
  const q = query?.trim();
  const posts = await getPrisma().feedbackPost.findMany({
    where: {
      // `not` alone would drop untriaged posts (status null) too.
      ...(status
        ? { status }
        : includeCompleted
          ? {}
          : { OR: [{ status: null }, { status: { not: 'COMPLETED' } }] }),
      ...(q
        ? {
            AND: {
              OR: [
                { title: { contains: q, mode: 'insensitive' } },
                { body: { contains: q, mode: 'insensitive' } },
              ],
            },
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
  const withVote = <
    T extends { id: string; author_id: string | null; is_anonymous: boolean; author: unknown },
  >(
    c: T
  ) => ({
    ...publicComment(c, viewerId),
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

/** The state a vote or follow write asks for: a value, or the opposite of now. */
type Wanted = boolean | 'toggle';

/**
 * Puts the user's vote on a post in the wanted state and keeps `vote_count`
 * in step. The rows written are counted, so a vote added or removed by a
 * concurrent request moves the count only once. Voting also follows the post.
 *
 * The vote is read before the count, and the count read again when a
 * concurrent request wrote the row first: a vote row and its count change
 * commit together, so the count returned is never older than the vote seen.
 */
const writePostVote = (postId: string, userId: string, wanted: Wanted) =>
  getPrisma().$transaction(async tx => {
    const voteCount = async () => {
      const post = await tx.feedbackPost.findUnique({
        where: { id: postId },
        select: { vote_count: true },
      });
      if (!post) throw new FeedbackNotFoundError();
      return post.vote_count;
    };
    const existing = await tx.feedbackVote.findUnique({
      where: { post_id_user_id: { post_id: postId, user_id: userId } },
      select: { id: true },
    });
    // Also the missing-post check, before anything is written.
    const current = await voteCount();
    const voted = wanted === 'toggle' ? !existing : wanted;
    if (voted === Boolean(existing)) return { voted, voteCount: current };

    let delta: number;
    if (voted) {
      ({ count: delta } = await tx.feedbackVote.createMany({
        data: [{ post_id: postId, user_id: userId }],
        skipDuplicates: true,
      }));
      await tx.feedbackFollow.createMany({
        data: [{ post_id: postId, user_id: userId }],
        skipDuplicates: true,
      });
    } else {
      const { count } = await tx.feedbackVote.deleteMany({
        where: { post_id: postId, user_id: userId },
      });
      delta = -count;
    }
    if (delta === 0) return { voted, voteCount: await voteCount() };
    const { vote_count } = await tx.feedbackPost.update({
      where: { id: postId },
      data: { vote_count: { increment: delta } },
      select: { vote_count: true },
    });
    return { voted, voteCount: vote_count };
  });

/** Adds or removes the user's vote. Voting also follows the post. */
export const togglePostVote = (postId: string, userId: string) =>
  writePostVote(postId, userId, 'toggle');

/**
 * Sets the user's vote (`voted`), changing nothing when it is already so: a
 * repeated call never undoes itself. Voting also follows the post.
 */
export const setPostVote = (postId: string, userId: string, voted: boolean) =>
  writePostVote(postId, userId, voted);

/**
 * A comment, or a reply to a top-level comment on the same post. An anonymous
 * one still records its author, as an anonymous post does, but never shows it.
 */
export const addComment = async ({
  postId,
  authorId,
  body,
  parentId,
  isAnonymous = false,
}: {
  postId: string;
  authorId: string;
  body: string;
  parentId?: string | null;
  isAnonymous?: boolean;
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
      data: {
        post_id: postId,
        author_id: authorId,
        parent_id: parentId ?? null,
        body: text,
        is_anonymous: isAnonymous,
      },
      select: { id: true },
    });
    await tx.feedbackPost.update({
      where: { id: postId },
      data: { comment_count: { increment: 1 } },
    });
    return comment;
  });
};

/** `writePostVote` for a comment's vote; a comment vote follows nothing. */
const writeCommentVote = (commentId: string, userId: string, wanted: Wanted) =>
  getPrisma().$transaction(async tx => {
    const voteCount = async () => {
      const comment = await tx.feedbackComment.findUnique({
        where: { id: commentId },
        select: { vote_count: true },
      });
      if (!comment) throw new FeedbackNotFoundError('That comment no longer exists.');
      return comment.vote_count;
    };
    const existing = await tx.feedbackCommentVote.findUnique({
      where: { comment_id_user_id: { comment_id: commentId, user_id: userId } },
      select: { id: true },
    });
    const current = await voteCount();
    const voted = wanted === 'toggle' ? !existing : wanted;
    if (voted === Boolean(existing)) return { voted, voteCount: current };

    const { count } = voted
      ? await tx.feedbackCommentVote.createMany({
          data: [{ comment_id: commentId, user_id: userId }],
          skipDuplicates: true,
        })
      : await tx.feedbackCommentVote.deleteMany({
          where: { comment_id: commentId, user_id: userId },
        });
    if (count === 0) return { voted, voteCount: await voteCount() };
    const { vote_count } = await tx.feedbackComment.update({
      where: { id: commentId },
      data: { vote_count: { increment: voted ? count : -count } },
      select: { vote_count: true },
    });
    return { voted, voteCount: vote_count };
  });

export const toggleCommentVote = (commentId: string, userId: string) =>
  writeCommentVote(commentId, userId, 'toggle');

/** Sets the user's vote on a comment; nothing changes when it is already so. */
export const setCommentVote = (commentId: string, userId: string, voted: boolean) =>
  writeCommentVote(commentId, userId, voted);

/** Puts the user's follow of a post in the wanted state. A missing post throws. */
const writeFollow = async (postId: string, userId: string, wanted: Wanted) => {
  const prisma = getPrisma();
  const post = await prisma.feedbackPost.findUnique({
    where: { id: postId },
    select: { id: true },
  });
  if (!post) throw new FeedbackNotFoundError();
  const existing = await prisma.feedbackFollow.findUnique({
    where: { post_id_user_id: { post_id: postId, user_id: userId } },
    select: { id: true },
  });
  const following = wanted === 'toggle' ? !existing : wanted;
  if (following === Boolean(existing)) return { following };
  if (following) {
    await prisma.feedbackFollow.createMany({
      data: [{ post_id: postId, user_id: userId }],
      skipDuplicates: true,
    });
  } else {
    await prisma.feedbackFollow.deleteMany({ where: { post_id: postId, user_id: userId } });
  }
  return { following };
};

export const toggleFollow = (postId: string, userId: string) =>
  writeFollow(postId, userId, 'toggle');

/** Sets whether the user follows a post; nothing changes when it is already so. */
export const setFollow = (postId: string, userId: string, following: boolean) =>
  writeFollow(postId, userId, following);

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

/**
 * Who wrote a post or comment, or null when there is no such post or comment
 * (`author_id` is null once the author's account is gone). For a caller that
 * must tell "missing" from "someone else's", like the MCP's delete.
 */
export const findPostAuthor = (postId: string) =>
  getPrisma().feedbackPost.findUnique({ where: { id: postId }, select: { author_id: true } });

export const findCommentAuthor = (commentId: string) =>
  getPrisma().feedbackComment.findUnique({
    where: { id: commentId },
    select: { author_id: true },
  });

/** Who wrote a post or comment, so the route can let authors delete their own. */
export const getPostAuthorId = async (postId: string) =>
  (await findPostAuthor(postId))?.author_id ?? null;

export const getCommentAuthorId = async (commentId: string) =>
  (await findCommentAuthor(commentId))?.author_id ?? null;

/**
 * Deletes a post. One already gone (a concurrent delete) throws
 * `FeedbackNotFoundError` rather than Prisma's opaque P2025.
 */
export const deletePost = async (postId: string) => {
  const { count } = await getPrisma().feedbackPost.deleteMany({ where: { id: postId } });
  if (count === 0) throw new FeedbackNotFoundError();
};

/**
 * Deletes a comment and its replies, and keeps the post's count in step. One
 * already gone throws `FeedbackNotFoundError`, as `deletePost` does.
 */
export const deleteComment = async (commentId: string) => {
  const prisma = getPrisma();
  await prisma.$transaction(async tx => {
    const comment = await tx.feedbackComment.findUnique({
      where: { id: commentId },
      select: { post_id: true, _count: { select: { replies: true } } },
    });
    if (!comment) throw new FeedbackNotFoundError('That comment no longer exists.');
    const { count } = await tx.feedbackComment.deleteMany({ where: { id: commentId } });
    if (count === 0) throw new FeedbackNotFoundError('That comment no longer exists.');
    await tx.feedbackPost.update({
      where: { id: comment.post_id },
      data: { comment_count: { decrement: 1 + comment._count.replies } },
    });
  });
};
