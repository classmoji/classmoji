import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';

import type {
  CommentIntent,
  CommentThread,
  CommentsActionResponse,
  CommentsListResponse,
  CommentsViewer,
} from '~/components/comments/types.ts';

/**
 * The threads on one page, for this reader (`/api/page-comments`).
 *
 * Nothing is fetched until asked (`load`): the loader only sends counts
 * (plan D10). No realtime (D9): the caller loads on panel open, on window
 * focus, and this hook loads again after each of the reader's own actions.
 * A POST answers with the thread as it is now (null: gone), which replaces
 * the one held here at once; a GET started before that answer is dropped, so
 * a slow list never overwrites a newer action.
 */
const API = '/api/page-comments';

const SLOW_DOWN = 'Slow down — try again in a moment.';
const LOCKED = 'This classroom is locked. Comments are read-only.';
const LOAD_FAILED = 'Couldn’t load comments. Try again.';
const ACTION_FAILED: Record<CommentIntent['intent'], string> = {
  create: 'Couldn’t post that comment. Try again.',
  reply: 'Couldn’t post that reply. Try again.',
  edit: 'Couldn’t save your edit. Try again.',
  delete: 'Couldn’t delete that comment. Try again.',
  react: 'Couldn’t save that reaction. Try again.',
  resolve: 'Couldn’t update that thread. Try again.',
};

interface ErrorBody {
  error?: unknown;
  message?: unknown;
}

const isLocked = (status: number, body: ErrorBody | null) =>
  status === 403 && body?.error === 'CLASSROOM_LOCKED';

/** The server's sentence when it sent one, never a bare code. */
const messageOf = (body: ErrorBody | null, fallback: string) =>
  typeof body?.message === 'string' && body.message.trim() ? body.message : fallback;

/** The thread an intent is about (before the answer, which may be null). */
function threadOf(threads: CommentThread[] | null, payload: CommentIntent): string | null {
  if ('threadId' in payload) return payload.threadId;
  if ('commentId' in payload) {
    const id = payload.commentId;
    return threads?.find(thread => thread.comments.some(comment => comment.id === id))?.id ?? null;
  }
  return null;
}

export interface PageCommentsData {
  /** null until the first list has arrived. */
  /** The full list; null until it has been loaded. */
  threads: CommentThread[] | null;
  /**
   * Threads the server answered with (an own create, say) before the list
   * was ever loaded: the caller adds them to the loader's counts. Emptied
   * when the list arrives (it has them).
   */
  early: CommentThread[];
  viewer: CommentsViewer | null;
  loading: boolean;
  /** A write came back 403 CLASSROOM_LOCKED: hide every composer. */
  frozen: boolean;
  /** Fetch the list. `quiet`: no toast on failure (background refreshes). */
  load: (options?: { quiet?: boolean }) => Promise<void>;
  /** POST one intent; true when the server took it. */
  act: (payload: CommentIntent) => Promise<boolean>;
}

export function usePageComments(pageId: string, enabled: boolean): PageCommentsData {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [early, setEarly] = useState<CommentThread[]>([]);
  const [viewer, setViewer] = useState<CommentsViewer | null>(null);
  const [loading, setLoading] = useState(false);
  const [frozen, setFrozen] = useState(false);

  // A different page: nothing of the last one carries over.
  const [seenPage, setSeenPage] = useState(pageId);
  if (seenPage !== pageId) {
    setSeenPage(pageId);
    setThreads(null);
    setEarly([]);
    setViewer(null);
    setLoading(false);
    setFrozen(false);
  }

  const pageRef = useRef(pageId);
  pageRef.current = pageId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const earlyRef = useRef(early);
  earlyRef.current = early;
  // Bumped by every answered POST and every page change: a list fetched
  // before it is stale.
  const generation = useRef(0);
  const inFlight = useRef<{
    pageId: string;
    generation: number;
    promise: Promise<void>;
    token: object;
  } | null>(null);
  useEffect(() => {
    generation.current++;
  }, [pageId]);

  const load = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!enabledRef.current) return;
    const page = pageRef.current;
    const started = generation.current;
    const running = inFlight.current;
    if (running && running.pageId === page && running.generation === started) {
      return running.promise;
    }
    const token = {};
    const promise = (async () => {
      setLoading(true);
      try {
        const response = await fetch(`${API}?pageId=${encodeURIComponent(page)}`, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        const body = (await response.json().catch(() => null)) as
          | (CommentsListResponse & ErrorBody)
          | null;
        if (pageRef.current !== page || generation.current !== started) return;
        if (!response.ok || !body || !Array.isArray(body.threads)) {
          if (!quiet) toast.error(response.status === 429 ? SLOW_DOWN : LOAD_FAILED);
          return;
        }
        setThreads(body.threads);
        setEarly([]);
        setViewer(body.viewer ?? null);
        if (body.viewer?.frozen) setFrozen(true);
      } catch {
        if (!quiet && pageRef.current === page) toast.error(LOAD_FAILED);
      } finally {
        if (pageRef.current === page) setLoading(false);
        if (inFlight.current?.token === token) inFlight.current = null;
      }
    })();
    inFlight.current = { pageId: page, generation: started, promise, token };
    return promise;
  }, []);

  const act = useCallback(
    async (payload: CommentIntent): Promise<boolean> => {
      if (!enabledRef.current) return false;
      const page = pageRef.current;
      const target = threadOf(threadsRef.current ?? earlyRef.current, payload);
      let response: Response;
      let body: (CommentsActionResponse & ErrorBody) | null;
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ pageId: page, ...payload }),
        });
        body = (await response.json().catch(() => null)) as typeof body;
      } catch {
        toast.error(ACTION_FAILED[payload.intent]);
        return false;
      }
      if (pageRef.current !== page) return false;

      if (!response.ok || body?.ok !== true) {
        if (response.status === 429) toast.error(SLOW_DOWN);
        else if (isLocked(response.status, body)) {
          setFrozen(true);
          toast.error(LOCKED);
        } else toast.error(messageOf(body, ACTION_FAILED[payload.intent]));
        return false;
      }

      generation.current++;
      const thread = body.thread ?? null;
      const merge = (list: CommentThread[]) => {
        if (!thread) return target ? list.filter(item => item.id !== target) : list;
        const index = list.findIndex(item => item.id === thread.id);
        if (index < 0) return [...list, thread];
        const next = list.slice();
        next[index] = thread;
        return next;
      };
      // Into the list once it is loaded; before that, aside (the list is
      // still to load, and the threads it will bring are not dropped).
      if (threadsRef.current) setThreads(previous => (previous ? merge(previous) : previous));
      else setEarly(merge);
      // Others may have written meanwhile: refresh in the background.
      void load({ quiet: true });
      return true;
    },
    [load]
  );

  return { threads, early, viewer, loading, frozen, load, act };
}
