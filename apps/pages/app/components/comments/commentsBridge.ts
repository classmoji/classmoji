import type { CommentDecorationInput, CommentResolution } from './commentsPlugin.ts';
import type { NewThreadDraft } from './types.ts';

/**
 * The link between the page route (which owns the threads and the panel) and
 * the BlockNote host on the page (the viewer, or the editor), which owns the
 * document. One per page view, made by `usePageCommentsController`.
 *
 * Route → host: what to draw (`snapshot`), and "show this block".
 * Host → route: what the reader asked for (a bubble, a highlight, a
 * selection, a block's hover button) and where each thread was found.
 */
export interface CommentsHostSnapshot {
  input: CommentDecorationInput;
  /** Offer the selection and block buttons. */
  canWrite: boolean;
}

export interface CommentsHostHandle {
  /** Scroll the block into view and flash it. False when it is not on the page. */
  focusBlock: (blockId: string) => boolean;
}

export interface CommentsHostActions {
  openBlock: (blockId: string) => void;
  openThread: (threadId: string) => void;
  startThread: (draft: NewThreadDraft) => void;
  setResolution: (resolution: CommentResolution) => void;
}

const EMPTY_SNAPSHOT: CommentsHostSnapshot = {
  input: { anchors: [], counts: {}, activeId: null, draft: null },
  canWrite: false,
};

export class CommentsBridge {
  private snapshot: CommentsHostSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private host: CommentsHostHandle | null = null;
  /** Set by the controller on every render (read at call time). */
  actions: CommentsHostActions = {
    openBlock: () => {},
    openThread: () => {},
    startThread: () => {},
    setResolution: () => {},
  };

  getSnapshot = (): CommentsHostSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  publish(snapshot: CommentsHostSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  /** The host on the page registers itself; returns its unregister. */
  attachHost(host: CommentsHostHandle): () => void {
    this.host = host;
    return () => {
      if (this.host === host) this.host = null;
    };
  }

  focusBlock(blockId: string): boolean {
    return this.host?.focusBlock(blockId) ?? false;
  }
}
