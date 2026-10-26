/**
 * The platform-wide feedback board (/feedback) over MCP: feature requests, bug
 * reports and integration ideas for Classmoji itself, not tied to a classroom.
 *
 *   - `feedback_read` (read): search posts across every status, the roadmap,
 *     or one post with its comment thread.
 *   - `feedback_write` (write): file a post, comment, set a vote, set a follow.
 *   - `feedback_delete` (write, destructive): the caller's own post or comment.
 *
 * Every tool is `roles: null` (any signed-in user, like whoami): the board has
 * no classroom. The acting user is always `ctx.viewer.userId`; arguments only
 * name posts and comments.
 *
 * What leaves here is what the service's `publicPost` / `publicComment` return,
 * picked field by field: never a raw row, never `author_id`, and an anonymous
 * post or comment has no author at all.
 *
 * Votes and follows are SET, not toggled (the web's buttons toggle): an agent
 * that retries a call must not undo its own vote.
 *
 * Deleting is author-only. A platform admin may delete anyone's post or
 * comment on the web; that stays web-only on purpose.
 *
 * No audit rows, by decision: the webapp writes none for the board either
 * (the registry header names this exception).
 */

import { z } from 'zod';
import {
  ClassmojiService,
  FEEDBACK_CATEGORIES,
  FEEDBACK_RATE_LIMITS,
  FEEDBACK_STATUSES,
  ROADMAP_STATUSES,
  FeedbackNotFoundError,
  FeedbackValidationError,
  type FeedbackRateKind,
} from '@classmoji/services';
import { WEBAPP_URL } from '../config.ts';
import { ToolError } from '../mcp/errors.ts';
import { DEFAULT_RATE_LIMIT, tryConsume } from '../mcp/rateLimit.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok } from './shared.ts';

const feedback = () => ClassmojiService.feedback;

const SORTS = ['top', 'new', 'trending'] as const;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const EXCERPT_CHARS = 200;

const idArg = (what: string) => z.string().uuid().describe(what);

/** The post's page on the web board. */
const postUrl = (postId: string) => `${WEBAPP_URL}/feedback/p/${encodeURIComponent(postId)}`;

/** Service refusals become the tool errors a caller can act on. */
async function onBoard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FeedbackValidationError) {
      throw new ToolError('invalid_params', error.message);
    }
    if (error instanceof FeedbackNotFoundError) throw new ToolError('not_found', error.message);
    throw error;
  }
}

// ─── Shaping ────────────────────────────────────────────────────────────────

/** What `publicPost` / `publicComment` leave of an author: a name, or nothing. */
type PublicAuthor = { name?: string | null } | null;

interface PublicPost {
  id: string;
  title: string;
  body: string;
  category: string;
  status: string | null;
  is_anonymous: boolean;
  vote_count: number;
  comment_count: number;
  created_at: Date;
  author: unknown;
  viewerIsAuthor: boolean;
  viewerVoted: boolean;
}

interface PublicComment {
  id: string;
  body: string;
  is_anonymous: boolean;
  vote_count: number;
  created_at: Date;
  author: unknown;
  viewerIsAuthor: boolean;
  viewerVoted: boolean;
}

/** The author's display name; null when anonymous (the service already nulled it). */
const authorName = (author: unknown) => (author as PublicAuthor)?.name ?? null;

const excerpt = (body: string) => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : flat;
};

/** One line of a list: no full body, no comments. */
const compactPost = (post: PublicPost) => ({
  id: post.id,
  title: post.title,
  category: post.category,
  status: post.status,
  vote_count: post.vote_count,
  comment_count: post.comment_count,
  created_at: post.created_at,
  author: authorName(post.author),
  is_anonymous: post.is_anonymous,
  viewerVoted: post.viewerVoted,
  viewerIsAuthor: post.viewerIsAuthor,
  excerpt: excerpt(post.body),
  url: postUrl(post.id),
});

const shapeComment = (comment: PublicComment) => ({
  id: comment.id,
  body: comment.body,
  author: authorName(comment.author),
  is_anonymous: comment.is_anonymous,
  vote_count: comment.vote_count,
  created_at: comment.created_at,
  viewerVoted: comment.viewerVoted,
  viewerIsAuthor: comment.viewerIsAuthor,
});

// ─── feedback_read ──────────────────────────────────────────────────────────

interface ReadArgs {
  view?: 'search' | 'roadmap' | 'post';
  query?: string;
  status?: (typeof FEEDBACK_STATUSES)[number];
  sort?: (typeof SORTS)[number];
  limit?: number;
  post_id?: string;
}

export const feedbackReadTool: ToolDefinition<ReadArgs> = {
  name: 'feedback_read',
  title: 'Read the feedback board',
  description:
    'Reads the Classmoji feedback board: platform-wide feature requests, bug reports and ' +
    'questions about Classmoji itself, not tied to a classroom. ' +
    "view 'search' (default) lists posts of EVERY status, Completed included, matching query " +
    "(title and body) and status, sorted 'top', 'new' or 'trending', up to limit (default 25, " +
    'max 100), each with a short excerpt and a link. Statuses by type: feature requests ' +
    'IN_REVIEW, PLANNED, IN_PROGRESS, COMPLETED; bugs FIXED (open until then); questions ANSWERED. ' +
    "view 'roadmap' lists triaged feature requests by status (IN_REVIEW, PLANNED, " +
    "IN_PROGRESS, COMPLETED). view 'post' returns one post " +
    "(post_id) with its full body, the team's public status notes (updates) and the comment " +
    'thread; a post merged into another opens the original (merged_from names the one asked ' +
    'for). Merged duplicates never appear in search or the roadmap. viewerVoted and viewerIsAuthor describe ' +
    'you; anonymous posts and comments have author null. Search here before filing a post ' +
    'with feedback_write.',
  scope: 'read',
  roles: null,
  inputSchema: {
    view: z
      .enum(['search', 'roadmap', 'post'])
      .optional()
      .describe("'search' (default), 'roadmap', or 'post' (needs post_id)"),
    query: z.string().max(200).optional().describe('search: words to find in titles and bodies'),
    status: z.enum(FEEDBACK_STATUSES).optional().describe('search: only posts with this status'),
    sort: z.enum(SORTS).optional().describe("search: 'top' (default), 'new' or 'trending'"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`search: at most this many posts (default ${DEFAULT_LIMIT}); roadmap: per status`),
    post_id: idArg('post: the post to open').optional(),
  },
  handler: async (args, { viewer }) => {
    const view = args.view ?? 'search';
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    if (view === 'post') {
      if (!args.post_id) throw new ToolError('invalid_params', "view 'post' needs post_id");
      let post = await feedback().getPost(args.post_id, viewer.userId);
      // A merged duplicate lives on in its original, as on the web.
      const mergedFrom = post?.duplicate_of_id ? post.id : null;
      if (post?.duplicate_of_id)
        post = await feedback().getPost(post.duplicate_of_id, viewer.userId);
      if (!post) throw new ToolError('not_found', 'That post no longer exists.');
      return ok({
        ...(mergedFrom ? { merged_from: mergedFrom } : {}),
        id: post.id,
        title: post.title,
        body: post.body,
        category: post.category,
        status: post.status,
        status_changed_at: post.status_changed_at,
        vote_count: post.vote_count,
        comment_count: post.comment_count,
        created_at: post.created_at,
        author: authorName(post.author),
        is_anonymous: post.is_anonymous,
        viewerVoted: post.viewerVoted,
        viewerFollows: post.viewerFollows,
        viewerIsAuthor: post.viewerIsAuthor,
        url: postUrl(post.id),
        // The team's public notes on status changes, newest first.
        updates: post.updates.map(update => ({
          from_status: update.from_status,
          to_status: update.to_status,
          note: update.note,
          created_at: update.created_at,
        })),
        comments: post.comments.map(comment => ({
          ...shapeComment(comment),
          replies: comment.replies.map(shapeComment),
        })),
      });
    }

    if (view === 'roadmap') {
      const columns = await feedback().listRoadmap(viewer.userId);
      return ok({
        columns: Object.fromEntries(
          ROADMAP_STATUSES.map(status => [
            status,
            {
              total: columns[status].length,
              posts: columns[status].slice(0, limit).map(compactPost),
            },
          ])
        ),
      });
    }

    // Unlike the web board, an unfiltered search includes Completed posts: an
    // agent looking for a duplicate must find the one that already shipped.
    const posts = await feedback().listPosts({
      sort: args.sort ?? 'top',
      status: args.status ?? null,
      query: args.query,
      viewerId: viewer.userId,
      includeCompleted: true,
    });
    return ok({ posts: posts.slice(0, limit).map(compactPost), more: posts.length > limit });
  },
};

// ─── feedback_write ─────────────────────────────────────────────────────────

interface WriteArgs {
  action: 'post' | 'comment' | 'vote' | 'follow';
  title?: string;
  body?: string;
  category?: (typeof FEEDBACK_CATEGORIES)[number];
  anonymous?: boolean;
  post_id?: string;
  comment_id?: string;
  parent_comment_id?: string;
  voted?: boolean;
  following?: boolean;
}

/** The board budget each action spends; following has none, as on the web. */
const RATE_KIND: Record<WriteArgs['action'], FeedbackRateKind | null> = {
  post: 'post',
  comment: 'comment',
  vote: 'vote',
  follow: null,
};

const missing = (message: string) => new ToolError('invalid_params', message);

export const feedbackWriteTool: ToolDefinition<WriteArgs> = {
  name: 'feedback_write',
  title: 'Write to the feedback board',
  // Post and comment add a row on every call; vote and follow are set-not-toggle.
  annotations: { destructive: false, idempotent: false, openWorld: false },
  // The registry's per-tool bucket is raised to the widest board budget
  // (vote's burst of 60), so for any one action the board budget in the
  // handler binds first. Across a mixed burst of actions, and for follow
  // (which has no board budget), this shared bucket binds.
  rateLimit: {
    capacity: FEEDBACK_RATE_LIMITS.vote.capacity,
    refillPerSecond: DEFAULT_RATE_LIMIT.refillPerSecond,
  },
  description:
    'Writes to the Classmoji feedback board (platform-wide feature requests, bug reports and ' +
    'integration ideas for Classmoji itself, not tied to a classroom) as you. Before filing a ' +
    "post, run feedback_read (view 'search') with a few keywords: if a post already covers it, " +
    'vote for it or comment on it instead of filing a duplicate. ' +
    "action 'post': title and body; category FEATURE (default), BUG or QUESTION. You vote " +
    "for and follow your new post. Returns post_id. action 'comment': body (up to 3000 " +
    'characters) on post_id; parent_comment_id replies to a top-level comment. Returns ' +
    "comment_id. action 'vote': post_id OR comment_id, and voted (true adds your vote, false " +
    "removes it). Voting for a post also follows it. action 'follow': post_id and following " +
    '(true/false), to hear about status changes. Votes and follows are set, not toggled: ' +
    'repeating a call changes nothing. ' +
    'anonymous: true (post, comment) hides your name from everyone; you can still delete it. ' +
    'Posts, comments and votes are rate limited per hour.',
  scope: 'write',
  roles: null,
  inputSchema: {
    action: z.enum(['post', 'comment', 'vote', 'follow']).describe('What to do'),
    // The service's own limits (it trims and collapses whitespace first, and
    // caps comments at 3000), so a title it would refuse never spends a token.
    title: z.string().min(3).max(120).optional().describe('post: the title (3 to 120 characters)'),
    body: z
      .string()
      .max(5000)
      .optional()
      .describe('post: the description (up to 5000); comment: the text (up to 3000)'),
    category: z
      .enum(FEEDBACK_CATEGORIES)
      .optional()
      .describe('post: FEATURE (default), BUG or QUESTION'),
    anonymous: z
      .boolean()
      .optional()
      .describe('post/comment: hide your name from everyone (default false)'),
    post_id: idArg('comment/follow: the post; vote: the post to vote on').optional(),
    comment_id: idArg('vote: the comment to vote on (instead of post_id)').optional(),
    parent_comment_id: idArg('comment: the top-level comment to reply to').optional(),
    voted: z.boolean().optional().describe('vote: true to vote, false to remove your vote'),
    following: z.boolean().optional().describe('follow: true to follow, false to stop'),
  },
  handler: async (args, { viewer }) => {
    const userId = viewer.userId;

    // Spent before validation, like the web route. This is on top of the
    // registry's own per-tool bucket on purpose (see `rateLimit` above): one
    // is the MCP's floor for any tool, this is the board's budget per action,
    // the same numbers the web applies to its own buckets.
    const kind = RATE_KIND[args.action];
    if (kind) {
      const limit = FEEDBACK_RATE_LIMITS[kind];
      if (
        !tryConsume(`${userId}:feedback:${kind}`, {
          capacity: limit.capacity,
          refillPerSecond: limit.perHour / 3600,
        })
      ) {
        throw new ToolError(
          'rate_limited',
          `Too many feedback ${kind}s for now (${limit.perHour} an hour); retry later`
        );
      }
    }

    const { title, body, post_id: postId, comment_id: commentId } = args;
    switch (args.action) {
      case 'post': {
        if (!title || !body) throw missing("action 'post' needs title and body");
        const { id } = await onBoard(() =>
          feedback().createPost({
            authorId: userId,
            title,
            body,
            category: args.category ?? 'FEATURE',
            isAnonymous: args.anonymous ?? false,
          })
        );
        return ok({ post_id: id, url: postUrl(id) });
      }
      case 'comment': {
        if (!postId || !body) throw missing("action 'comment' needs post_id and body");
        const { id } = await onBoard(() =>
          feedback().addComment({
            postId,
            authorId: userId,
            body,
            parentId: args.parent_comment_id ?? null,
            isAnonymous: args.anonymous ?? false,
          })
        );
        return ok({ comment_id: id, post_id: postId, url: postUrl(postId) });
      }
      case 'vote': {
        if (Boolean(postId) === Boolean(commentId)) {
          throw missing("action 'vote' needs exactly one of post_id or comment_id");
        }
        const voted = args.voted;
        if (typeof voted !== 'boolean') throw missing("action 'vote' needs voted (true/false)");
        const result = await onBoard(() =>
          postId
            ? feedback().setPostVote(postId, userId, voted)
            : feedback().setCommentVote(commentId as string, userId, voted)
        );
        return ok({
          ...(postId ? { post_id: postId } : { comment_id: commentId }),
          voted: result.voted,
          vote_count: result.voteCount,
        });
      }
      case 'follow': {
        if (!postId) throw missing("action 'follow' needs post_id");
        const following = args.following;
        if (typeof following !== 'boolean') {
          throw missing("action 'follow' needs following (true/false)");
        }
        const result = await onBoard(() => feedback().setFollow(postId, userId, following));
        return ok({ post_id: postId, following: result.following });
      }
      default:
        throw missing('Unknown action');
    }
  },
};

// ─── feedback_delete ────────────────────────────────────────────────────────

interface DeleteArgs {
  post_id?: string;
  comment_id?: string;
}

export const feedbackDeleteTool: ToolDefinition<DeleteArgs> = {
  name: 'feedback_delete',
  title: 'Delete your feedback post or comment',
  annotations: { destructive: true, idempotent: false, openWorld: false },
  description:
    'Permanently deletes YOUR OWN post (post_id) or comment (comment_id) on the Classmoji ' +
    'feedback board. Pass exactly one. Deleting a post removes its comments and votes; ' +
    'deleting a comment removes its replies. Anything someone else wrote is refused, anonymous ' +
    'or not.',
  scope: 'write',
  roles: null,
  inputSchema: {
    post_id: idArg('The post to delete').optional(),
    comment_id: idArg('The comment to delete').optional(),
  },
  handler: async (args, { viewer }) => {
    if (Boolean(args.post_id) === Boolean(args.comment_id)) {
      throw new ToolError('invalid_params', 'Pass exactly one of post_id or comment_id');
    }

    // Author only, platform admins included: deleting other people's posts
    // and comments stays on the web.
    const { post_id: postId, comment_id: commentId } = args;
    if (postId) {
      const post = await feedback().findPostAuthor(postId);
      if (!post) throw new ToolError('not_found', 'That post no longer exists.');
      if (post.author_id !== viewer.userId) {
        throw new ToolError('forbidden', 'You can delete only your own posts');
      }
      await onBoard(() => feedback().deletePost(postId));
      return ok({ deleted: 'post', post_id: postId });
    }

    if (!commentId) throw new ToolError('invalid_params', 'Pass post_id or comment_id');
    const comment = await feedback().findCommentAuthor(commentId);
    if (!comment) throw new ToolError('not_found', 'That comment no longer exists.');
    if (comment.author_id !== viewer.userId) {
      throw new ToolError('forbidden', 'You can delete only your own comments');
    }
    await onBoard(() => feedback().deleteComment(commentId));
    return ok({ deleted: 'comment', comment_id: commentId });
  },
};
