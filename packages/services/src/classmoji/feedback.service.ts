import getPrisma from '@classmoji/database';
import type { FeedbackCategory, FeedbackStatus } from '@prisma/client';
import { createNotifications } from './notification.service.ts';

/**
 * The public feedback board: anyone reads, signed-in users post, vote, comment
 * and follow, platform admins move posts through a status (which places them on
 * the roadmap). Who may call what is decided by the route; this module checks
 * the content and keeps the denormalized counts honest.
 */

export const FEEDBACK_STATUSES = [
  'IN_REVIEW',
  'PLANNED',
  'IN_PROGRESS',
  'COMPLETED',
  'FIXED',
  'ANSWERED',
] as const;
export const FEEDBACK_CATEGORIES = ['FEATURE', 'BUG', 'QUESTION'] as const;

/**
 * The statuses each type of post moves through. Only a feature request's reach
 * the roadmap; a bug is fixed (open until then), a question answered.
 */
export const FEEDBACK_STATUSES_BY_CATEGORY = {
  FEATURE: ['IN_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETED'],
  BUG: ['FIXED'],
  QUESTION: ['ANSWERED'],
} as const satisfies Record<FeedbackCategory, readonly FeedbackStatus[]>;

/** The roadmap's columns, in order. */
export const ROADMAP_STATUSES = FEEDBACK_STATUSES_BY_CATEGORY.FEATURE;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

/** Closed posts: off the board unless asked for by status (answered questions stay, they help). */
const CLOSED_STATUSES: FeedbackStatus[] = ['COMPLETED', 'FIXED'];

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  IN_REVIEW: 'In review',
  PLANNED: 'Planned',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  FIXED: 'Fixed',
  ANSWERED: 'Answered',
};

export const isStatusForCategory = (status: FeedbackStatus, category: FeedbackCategory) =>
  (FEEDBACK_STATUSES_BY_CATEGORY[category] as readonly FeedbackStatus[]).includes(status);

export type FeedbackSort = 'top' | 'new' | 'trending';

const LIMITS = {
  titleMin: 3,
  titleMax: 120,
  body: 5000,
  comment: 3000,
  note: 1000,
  bugField: 3000,
};

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
const publicPost = <
  P extends {
    author_id: string | null;
    is_anonymous: boolean;
    author: unknown;
    duplicated_by_id?: string | null;
  },
>(
  post: P,
  viewerId: string | null | undefined
) => {
  // Neither the author's id nor the admin who merged a duplicate is public.
  const { author_id, duplicated_by_id: _mergedBy, ...rest } = post;
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
 * Closed posts (Completed features, Fixed bugs) show only when asked for by
 * status: unfiltered, the board lists what is still open, and shipped work
 * lives on the roadmap. Answered questions stay listed.
 * `includeCompleted` lifts that for a search across every status (the MCP).
 */
export const listPosts = async ({
  sort = 'top',
  status,
  category,
  query,
  viewerId,
  includeCompleted = false,
}: {
  sort?: FeedbackSort;
  status?: FeedbackStatus | null;
  /** One type of post (feature request, bug, question); null lists them all. */
  category?: FeedbackCategory | null;
  query?: string;
  viewerId?: string | null;
  includeCompleted?: boolean;
}) => {
  const q = query?.trim();
  const posts = await getPrisma().feedbackPost.findMany({
    where: {
      // A duplicate lives on in its original; its link redirects there.
      duplicate_of_id: null,
      ...(category ? { category } : {}),
      // `not` alone would drop untriaged posts (status null) too.
      ...(status
        ? { status }
        : includeCompleted
          ? {}
          : { OR: [{ status: null }, { status: { notIn: CLOSED_STATUSES } }] }),
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

/**
 * The latest feature requests marked Completed, newest first: proof the board
 * ships. Bugs and questions are not "shipped".
 */
export const listRecentlyShipped = async (limit = 5) =>
  getPrisma().feedbackPost.findMany({
    where: { status: 'COMPLETED', category: 'FEATURE', duplicate_of_id: null },
    orderBy: [{ status_changed_at: { sort: 'desc', nulls: 'last' } }, { updated_at: 'desc' }],
    take: limit,
    select: { id: true, title: true, status_changed_at: true, vote_count: true },
  });

/**
 * Triaged feature requests grouped by status for the roadmap, most-voted
 * first. Only feature requests reach the roadmap: bugs and questions stay on
 * the board.
 */
export const listRoadmap = async (viewerId?: string | null) => {
  const posts = await getPrisma().feedbackPost.findMany({
    where: { status: { not: null }, category: 'FEATURE', duplicate_of_id: null },
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
    ROADMAP_STATUSES.map(status => [status, [] as RoadmapPost[]])
  ) as Record<RoadmapStatus, RoadmapPost[]>;
  for (const post of posts) {
    const column = post.status ? columns[post.status as RoadmapStatus] : undefined;
    column?.push({ ...publicPost(post, viewerId), viewerVoted: voted.has(post.id) });
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
      // The team's public notes, newest first. Who wrote one is not shown.
      updates: {
        orderBy: { created_at: 'desc' },
        select: { id: true, from_status: true, to_status: true, note: true, created_at: true },
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

/** Words worth matching on: lower case, 3+ letters, minus the filler. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'not',
  'are',
  'was',
  'when',
  'what',
  'how',
  'can',
  'does',
  'did',
  'this',
  'that',
  'from',
  'have',
  'has',
  'into',
  'should',
  'would',
  'could',
  'there',
  'their',
  'they',
  'you',
  'your',
  'our',
  'but',
  'all',
  'any',
  'get',
  'isn',
  'doesn',
  'don',
  'cant',
  'wont',
  'why',
  'who',
  'where',
  'which',
  'its',
  'more',
  'add',
  'make',
  'use',
  'able',
]);

const titleWords = (title: string) =>
  Array.from(
    new Set((title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(w => !STOP_WORDS.has(w)))
  ).slice(0, 8);

/**
 * Posts whose title shares words with `title`, best match first, for the
 * "already posted?" box while someone writes a new post. Public fields only
 * (anyone can read the board). A word matches inside a longer one, so
 * "export" finds "exports"; no duplicates, which live on in their original.
 */
export const findSimilarPosts = async ({
  title,
  category,
  limit = 5,
}: {
  title: string;
  category?: FeedbackCategory | null;
  limit?: number;
}) => {
  const words = titleWords(title);
  if (words.length === 0) return [];
  const candidates = await getPrisma().feedbackPost.findMany({
    where: {
      duplicate_of_id: null,
      ...(category ? { category } : {}),
      OR: words.map(word => ({ title: { contains: word, mode: 'insensitive' as const } })),
    },
    orderBy: [{ vote_count: 'desc' }, { created_at: 'desc' }],
    take: 50,
    select: {
      id: true,
      title: true,
      category: true,
      status: true,
      vote_count: true,
      comment_count: true,
    },
  });
  // Rank by how many of the words each title holds; one stray word in a
  // long title is not "similar" when the new title has several.
  const needed = words.length >= 3 ? 2 : 1;
  return candidates
    .map(post => {
      const lower = post.title.toLowerCase();
      return { post, score: words.filter(w => lower.includes(w)).length };
    })
    .filter(({ score }) => score >= needed)
    .sort((a, b) => b.score - a.score || b.post.vote_count - a.post.vote_count)
    .slice(0, limit)
    .map(({ post }) => post);
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
 * A bug report's fields, as on the Github bug template
 * (.github/ISSUE_TEMPLATE/bug_report.yml): what happened and what should have
 * are required, steps and additional info optional.
 */
export interface BugReportFields {
  whatHappened: string;
  expected: string;
  steps?: string | null;
  additionalInfo?: string | null;
}

/** The headings a bug report's `body` is written under, in the template's order. */
export const BUG_SECTION_LABELS = {
  whatHappened: 'What happened?',
  expected: 'What should have happened?',
  steps: 'Steps to reproduce',
  additionalInfo: 'Additional info',
} as const;

const cleanBugFields = (fields: BugReportFields) => ({
  bug_what_happened: cleanBody(
    fields.whatHappened ?? '',
    LIMITS.bugField,
    true,
    'description of what happened'
  ),
  bug_expected: cleanBody(
    fields.expected ?? '',
    LIMITS.bugField,
    true,
    'description of what should have happened'
  ),
  bug_steps: cleanBody(fields.steps ?? '', LIMITS.bugField, false, 'list of steps') || null,
  bug_additional_info:
    cleanBody(fields.additionalInfo ?? '', LIMITS.bugField, false, 'additional info') || null,
});

/** A readable body from the bug fields, so search, excerpts and the MCP read one text. */
const bugBody = (bug: ReturnType<typeof cleanBugFields>) =>
  [
    [BUG_SECTION_LABELS.whatHappened, bug.bug_what_happened],
    [BUG_SECTION_LABELS.expected, bug.bug_expected],
    [BUG_SECTION_LABELS.steps, bug.bug_steps],
    [BUG_SECTION_LABELS.additionalInfo, bug.bug_additional_info],
  ]
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}\n${text}`)
    .join('\n\n');

/**
 * A new post; its author votes for it and follows it, like on any board. An
 * anonymous post still records its author (for deleting, rate limits and
 * status updates) but never shows it. A bug with `bug` fields stores them and
 * writes `body` from them; a bug without (older clients, the MCP) is a plain
 * body like any post.
 */
export const createPost = async ({
  authorId,
  title,
  body,
  category = 'FEATURE',
  isAnonymous = false,
  bug,
}: {
  authorId: string;
  title: string;
  body?: string;
  category?: FeedbackCategory;
  isAnonymous?: boolean;
  bug?: BugReportFields | null;
}) => {
  if (!isFeedbackCategory(category)) throw new FeedbackValidationError('Pick a category.');
  const bugFields = category === 'BUG' && bug ? cleanBugFields(bug) : null;
  const text = bugFields
    ? bugBody(bugFields)
    : cleanBody(body ?? '', LIMITS.body, true, 'description');
  if (text.length > LIMITS.body)
    throw new FeedbackValidationError(`Keep the post under ${LIMITS.body} characters.`);
  const data = {
    title: cleanTitle(title),
    body: text,
    category,
    is_anonymous: isAnonymous,
    ...(bugFields ?? {}),
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
  const created = await prisma.$transaction(async tx => {
    const post = await tx.feedbackPost.findUnique({
      where: { id: postId },
      select: { id: true, title: true, author_id: true, category: true },
    });
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
    return { comment, post };
  });

  // Tell the post's author someone replied (not about their own comment).
  // The commenter is never named: they may be anonymous. Never fails the comment.
  const { comment, post } = created;
  if (post.author_id && post.author_id !== authorId) {
    await createNotifications({
      type: 'FEEDBACK_REPLY',
      classroomId: null,
      recipientUserIds: [post.author_id],
      resourceType: 'feedback_post',
      resourceId: postId,
      title: post.title,
      metadata: { category: post.category },
    });
  }
  return comment;
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
 * followers, except whoever made the change. Voters follow automatically, so
 * this reaches every voter who has not unfollowed. With `note` (required when
 * `requireNote`, the admin path) the change is recorded as a public update on
 * the post, and the note goes with the notification. Notifying never fails
 * the update.
 */
export const setStatus = async ({
  postId,
  status,
  actorId,
  note,
  requireNote = false,
}: {
  postId: string;
  status: FeedbackStatus | null;
  actorId: string;
  note?: string | null;
  requireNote?: boolean;
}) => {
  if (status !== null && !isFeedbackStatus(status))
    throw new FeedbackValidationError('Unknown status.');
  const text = cleanBody(note ?? '', LIMITS.note, false, 'note');
  if (requireNote && status !== null && !text) {
    throw new FeedbackValidationError('Write a short note: followers get it with the update.');
  }
  const prisma = getPrisma();
  const before = await prisma.feedbackPost.findUnique({
    where: { id: postId },
    select: { status: true, category: true, duplicate_of_id: true },
  });
  if (!before) throw new FeedbackNotFoundError();
  if (before.duplicate_of_id) {
    throw new FeedbackValidationError('This post was merged into another; update that one.');
  }
  // A bug is never "Planned", a feature never "Answered".
  if (status !== null && !isStatusForCategory(status, before.category)) {
    throw new FeedbackValidationError(
      `A ${before.category.toLowerCase()} post can't be ${FEEDBACK_STATUS_LABELS[status]}.`
    );
  }
  const changed = status !== before.status;
  const post = await prisma.$transaction(async tx => {
    const updated = await tx.feedbackPost.update({
      where: { id: postId },
      data: { status, ...(changed ? { status_changed_at: new Date() } : {}) },
      select: { id: true, title: true, status: true },
    });
    // A note is kept even without a status change: "still planned, here is why".
    if (text) {
      await tx.feedbackUpdate.create({
        data: {
          post_id: postId,
          actor_id: actorId,
          from_status: before.status,
          to_status: status,
          note: text,
        },
      });
    }
    return updated;
  });

  if (status && (changed || text)) {
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
      metadata: {
        status,
        status_label: FEEDBACK_STATUS_LABELS[status],
        ...(text ? { note: text.slice(0, 500) } : {}),
      },
    });
  }
  return post;
};

/**
 * The asker marks their question answered (or not). Only the author of a
 * question; admins use `setStatus` with a note. No note, no notification:
 * the asker is the one who follows.
 */
export const markQuestionAnswered = async ({
  postId,
  userId,
  answered,
}: {
  postId: string;
  userId: string;
  answered: boolean;
}) => {
  const prisma = getPrisma();
  const post = await prisma.feedbackPost.findUnique({
    where: { id: postId },
    select: { author_id: true, category: true, status: true },
  });
  if (!post) throw new FeedbackNotFoundError();
  if (post.category !== 'QUESTION') {
    throw new FeedbackValidationError('Only a question can be marked answered.');
  }
  if (!post.author_id || post.author_id !== userId) {
    throw new FeedbackValidationError('Only the person who asked can mark it answered.');
  }
  const status = answered ? ('ANSWERED' as const) : null;
  if (post.status === status) return { status };
  await prisma.feedbackPost.update({
    where: { id: postId },
    data: { status, status_changed_at: new Date() },
  });
  return { status };
};

/**
 * Merges a duplicate into the original: its comments, votes and follows move
 * over (one vote and one follow per person, never two), both counts are
 * recomputed, posts already merged into the duplicate now point at the
 * original, and the duplicate leaves every list while its link redirects.
 * Admins only (the route decides). Merging into a duplicate merges into its
 * original instead.
 */
export const markDuplicate = async ({
  postId,
  originalId,
  actorId,
}: {
  postId: string;
  originalId: string;
  actorId: string;
}) => {
  const prisma = getPrisma();
  return prisma.$transaction(async tx => {
    const [source, target] = await Promise.all([
      tx.feedbackPost.findUnique({
        where: { id: postId },
        select: { id: true, duplicate_of_id: true },
      }),
      tx.feedbackPost.findUnique({
        where: { id: originalId },
        select: { id: true, duplicate_of_id: true },
      }),
    ]);
    if (!source || !target) throw new FeedbackNotFoundError();
    if (source.duplicate_of_id) {
      throw new FeedbackValidationError('This post is already marked as a duplicate.');
    }
    const canonicalId = target.duplicate_of_id ?? target.id;
    if (canonicalId === source.id) {
      throw new FeedbackValidationError('A post cannot be a duplicate of itself.');
    }

    // Votes and follows: move the ones the original does not have, drop the rest.
    for (const model of ['feedbackVote', 'feedbackFollow'] as const) {
      const delegate = tx[model] as unknown as {
        findMany: (a: object) => Promise<{ user_id: string }[]>;
        deleteMany: (a: object) => Promise<unknown>;
        updateMany: (a: object) => Promise<unknown>;
      };
      const already = await delegate.findMany({
        where: { post_id: canonicalId },
        select: { user_id: true },
      });
      await delegate.deleteMany({
        where: { post_id: source.id, user_id: { in: already.map(r => r.user_id) } },
      });
      await delegate.updateMany({
        where: { post_id: source.id },
        data: { post_id: canonicalId },
      });
    }
    // Comments (with their replies) move as they are.
    await tx.feedbackComment.updateMany({
      where: { post_id: source.id },
      data: { post_id: canonicalId },
    });
    // Earlier duplicates of this post now point at the original.
    await tx.feedbackPost.updateMany({
      where: { duplicate_of_id: source.id },
      data: { duplicate_of_id: canonicalId },
    });

    const [votes, comments] = await Promise.all([
      tx.feedbackVote.count({ where: { post_id: canonicalId } }),
      tx.feedbackComment.count({ where: { post_id: canonicalId } }),
    ]);
    await tx.feedbackPost.update({
      where: { id: canonicalId },
      data: { vote_count: votes, comment_count: comments },
    });
    await tx.feedbackPost.update({
      where: { id: source.id },
      data: {
        duplicate_of_id: canonicalId,
        duplicated_at: new Date(),
        duplicated_by_id: actorId,
        vote_count: 0,
        comment_count: 0,
        status: null,
      },
    });
    return { originalId: canonicalId };
  });
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

// ─────────────────── Platform admin: what to build next ───────────────────

/** How a voter is counted in the ranking: by their role in their classes. */
export type VoterRole = 'INSTRUCTOR' | 'TA' | 'STUDENT' | 'OTHER';

const ROLE_RANK: Record<string, number> = { OWNER: 3, TEACHER: 3, ASSISTANT: 2, STUDENT: 1 };
const asVoterRole = (role: string | undefined): VoterRole =>
  role === 'OWNER' || role === 'TEACHER'
    ? 'INSTRUCTOR'
    : role === 'ASSISTANT'
      ? 'TA'
      : role === 'STUDENT'
        ? 'STUDENT'
        : 'OTHER';

/**
 * Each voter's highest role in any (non-example) class: an instructor who is
 * also a student somewhere counts as an instructor. Current memberships, not
 * a snapshot at voting time.
 */
const voterRoles = async (userIds: string[]) => {
  const unique = Array.from(new Set(userIds));
  const memberships = unique.length
    ? await getPrisma().classroomMembership.findMany({
        where: { user_id: { in: unique }, classroom: { is_example: false } },
        select: { user_id: true, role: true },
      })
    : [];
  const best = new Map<string, string>();
  for (const m of memberships) {
    const current = best.get(m.user_id);
    if ((ROLE_RANK[m.role] ?? 0) > (ROLE_RANK[current ?? ''] ?? 0)) best.set(m.user_id, m.role);
  }
  return (userId: string): VoterRole => asVoterRole(best.get(userId));
};

/**
 * Open feature requests ranked for deciding what to build: most voters first,
 * then newest. No weighted score: the count is shown as it is, with who the
 * voters are by role.
 * PLATFORM ADMINS ONLY: the caller must check (apps/admin).
 */
export const listFeatureRanking = async () => {
  const posts = await getPrisma().feedbackPost.findMany({
    where: {
      category: 'FEATURE',
      duplicate_of_id: null,
      OR: [{ status: null }, { status: { not: 'COMPLETED' } }],
    },
    select: {
      id: true,
      title: true,
      status: true,
      vote_count: true,
      comment_count: true,
      created_at: true,
      votes: { select: { user_id: true } },
    },
  });
  const roleOf = await voterRoles(posts.flatMap(p => p.votes.map(v => v.user_id)));
  return posts
    .map(({ votes, ...post }) => {
      const roles: Record<VoterRole, number> = { INSTRUCTOR: 0, TA: 0, STUDENT: 0, OTHER: 0 };
      for (const vote of votes) roles[roleOf(vote.user_id)] += 1;
      return { ...post, voters: votes.length, roles };
    })
    .sort((a, b) => b.voters - a.voters || b.created_at.getTime() - a.created_at.getTime());
};

/**
 * Who voted for one feature request: name, email and role.
 * PLATFORM ADMINS ONLY: the caller must check (apps/admin).
 */
export const listFeatureVoters = async (postId: string) => {
  const votes = await getPrisma().feedbackVote.findMany({
    where: { post_id: postId },
    orderBy: { created_at: 'asc' },
    select: { created_at: true, user: { select: { id: true, name: true, email: true } } },
  });
  const roleOf = await voterRoles(votes.map(v => v.user.id));
  return votes.map(vote => ({
    userId: vote.user.id,
    name: vote.user.name,
    email: vote.user.email,
    role: roleOf(vote.user.id),
    votedAt: vote.created_at,
  }));
};
