/**
 * Page comments: the shapes the pages API sends (`/api/page-comments`) and the
 * page loader's `readerComments`. Fixed by the page-comments plan's API
 * contract; the server is the only source of every flag here.
 */

/** A comment's author. `null` where an author is expected: a deleted user. */
export interface CommentAuthor {
  name: string;
  image: string | null;
  badge: 'Instructor' | 'TA' | null;
}

export interface CommentReaction {
  emoji: string;
  count: number;
  /** The viewer reacted with this emoji. */
  mine: boolean;
}

export interface PageComment {
  id: string;
  author: CommentAuthor | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  reactions: CommentReaction[];
  canEdit: boolean;
  canDelete: boolean;
}

export interface CommentThread {
  id: string;
  /** null: a thread on the page as a whole. */
  blockId: string | null;
  /** The selected text, or null for a thread on a whole block (or the page). */
  quote: string | null;
  /** Which match of `quote` in the block's text (`quoteAnchor.ts`). */
  quoteOccurrence: number;
  resolvedAt: string | null;
  resolvedBy: CommentAuthor | null;
  createdAt: string;
  comments: PageComment[];
}

export interface CommentsViewer {
  canWrite: boolean;
  canResolve: boolean;
  canModerate: boolean;
  /** The classroom is locked: comments are read-only. */
  frozen: boolean;
}

/** `GET /api/page-comments?pageId=` */
export interface CommentsListResponse {
  threads: CommentThread[];
  viewer: CommentsViewer;
}

/** `POST /api/page-comments`: the thread as it is now, or null when it is gone. */
export interface CommentsActionResponse {
  ok: true;
  thread: CommentThread | null;
}

/**
 * The page loader's `readerComments`: present only for a signed-in accepted
 * member of the page's classroom; absent (no comment UI at all) otherwise.
 */
export interface ReaderComments {
  /** Open threads per block id (as this reader may see them). */
  counts: Record<string, number>;
  /** Open page-level threads. */
  pageLevel: number;
  /** All open threads. */
  open: number;
  canWrite: boolean;
  canResolve: boolean;
  frozen: boolean;
}

/** The POST intents and their fields (`pageId` is added by the hook). */
export type CommentIntent =
  | {
      intent: 'create';
      blockId: string | null;
      quote?: string;
      quoteOccurrence?: number;
      body: string;
    }
  | { intent: 'reply'; threadId: string; body: string }
  | { intent: 'edit'; commentId: string; body: string }
  | { intent: 'delete'; commentId: string }
  | { intent: 'react'; commentId: string; emoji: string; on: boolean }
  | { intent: 'resolve'; threadId: string; resolved: boolean };

/** A thread about to be started (the composer at the top of the panel). */
export interface NewThreadDraft {
  blockId: string | null;
  quote: string | null;
  quoteOccurrence: number;
}

/** Longest comment body, in characters (D6). */
export const COMMENT_BODY_MAX = 4000;
/** Longest quote, in characters (D1). */
export const QUOTE_MAX = 500;
