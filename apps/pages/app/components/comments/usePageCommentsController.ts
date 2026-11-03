import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePageComments, type PageCommentsData } from '~/hooks/usePageComments.ts';
import { CommentsBridge } from './commentsBridge.ts';
import type { CommentAnchor, CommentResolution } from './commentsPlugin.ts';
import { shouldRefetch, type RefetchReason } from './refetchPolicy.ts';
import type { CommentIntent, CommentThread, NewThreadDraft, ReaderComments } from './types.ts';

/**
 * Everything the page route needs for comments: the threads (lazy), the
 * panel's state, and the bridge to the BlockNote host on the page.
 *
 * Null when the loader sent no `readerComments` (signed out, not a member,
 * the class site): then nothing comment-related is drawn at all.
 */
export type CommentsTab = 'open' | 'resolved';

export interface PageCommentsController {
  bridge: CommentsBridge;
  data: PageCommentsData;
  threads: CommentThread[] | null;
  /** Open threads (the header's number). */
  openCount: number;
  canWrite: boolean;
  canResolve: boolean;
  frozen: boolean;
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  tab: CommentsTab;
  setTab: (tab: CommentsTab) => void;
  /** The panel shows one block's threads only. */
  focusBlockId: string | null;
  setFocusBlockId: (blockId: string | null) => void;
  draft: NewThreadDraft | null;
  startThread: (draft: NewThreadDraft) => void;
  cancelDraft: () => void;
  /** Post the draft; true when posted. */
  submitDraft: (body: string) => Promise<boolean>;
  act: (payload: CommentIntent) => Promise<boolean>;
  activeThreadId: string | null;
  /** A thread picked in the panel: its block scrolled to and flashed. */
  selectThread: (thread: CommentThread) => void;
  /**
   * Open the panel on the Open tab with this thread active; the panel
   * scrolls its card into view and flashes it (`flash`).
   */
  focusThread: (threadId: string) => void;
  /** The last `focusThread` (a new nonce each time, so a repeat flashes again). */
  flash: { threadId: string; nonce: number } | null;
  /** Where each thread was found on the page (empty until the host reports). */
  resolution: CommentResolution;
}

const NO_RESOLUTION: CommentResolution = Object.freeze({});

export function usePageCommentsController(
  pageId: string,
  readerComments: ReaderComments | null | undefined
): PageCommentsController | null {
  const enabled = Boolean(readerComments);
  const data = usePageComments(pageId, enabled);
  const { threads, early, viewer, load, act } = data;

  const [bridge] = useState(() => new CommentsBridge());
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<CommentsTab>('open');
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewThreadDraft | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [resolution, setResolution] = useState<CommentResolution>(NO_RESOLUTION);
  const [flash, setFlash] = useState<{ threadId: string; nonce: number } | null>(null);

  // A different page: the panel's state starts over.
  const [seenPage, setSeenPage] = useState(pageId);
  if (seenPage !== pageId) {
    setSeenPage(pageId);
    setPanelOpen(false);
    setTab('open');
    setFocusBlockId(null);
    setDraft(null);
    setActiveThreadId(null);
    setResolution(NO_RESOLUTION);
    setFlash(null);
  }

  const frozen = Boolean(readerComments?.frozen || viewer?.frozen || data.frozen);
  const canWrite = Boolean(viewer ? viewer.canWrite : readerComments?.canWrite) && !frozen;
  const canResolve = Boolean(viewer ? viewer.canResolve : readerComments?.canResolve) && !frozen;

  // Highlights need the quotes: fetch once on arrival when there is anything
  // open to draw. Resolved threads wait for the panel.
  const openOnLoad = readerComments?.open ?? 0;
  useEffect(() => {
    if (enabled && openOnLoad > 0) void load({ quiet: true }); // reason 'mount': always
    // Once per page (and when comments become available).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, enabled]);

  // A panel open or a window focus fetches again only when the list held is
  // stale (`refetchPolicy.ts`: one freshness rule, whatever fetched it last).
  // The arrival load above and the refresh after an own action always fetch.
  const { lastFetchAt } = data;
  const hasListRef = useRef(threads !== null);
  hasListRef.current = threads !== null;
  const refresh = useCallback(
    (reason: RefetchReason, options?: { quiet?: boolean }) => {
      if (
        shouldRefetch({
          reason,
          hasList: hasListRef.current,
          lastFetchAt: lastFetchAt(),
          now: Date.now(),
        })
      ) {
        void load(options);
      }
    },
    [load, lastFetchAt]
  );

  // Back to the tab: others may have written.
  const loaded = threads !== null;
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      if (!loaded && !panelOpen) return;
      refresh('focus', { quiet: true });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, loaded, panelOpen, refresh]);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    refresh('panel');
  }, [refresh]);
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setActiveThreadId(null);
    setFocusBlockId(null);
    setDraft(null);
    setFlash(null);
  }, []);
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const togglePanel = useCallback(() => {
    if (panelOpenRef.current) closePanel();
    else openPanel();
  }, [openPanel, closePanel]);

  const startThread = useCallback(
    (next: NewThreadDraft) => {
      setDraft(next);
      setTab('open');
      setFocusBlockId(null);
      setPanelOpen(true);
      refresh('panel', { quiet: true });
    },
    [refresh]
  );
  const cancelDraft = useCallback(() => setDraft(null), []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const submitDraft = useCallback(
    async (body: string) => {
      const current = draftRef.current;
      if (!current) return false;
      const ok = await act({
        intent: 'create',
        blockId: current.blockId,
        ...(current.quote
          ? { quote: current.quote, quoteOccurrence: current.quoteOccurrence }
          : {}),
        body,
      });
      if (ok && draftRef.current === current) setDraft(null);
      return ok;
    },
    [act]
  );

  const selectThread = useCallback(
    (thread: CommentThread) => {
      setActiveThreadId(thread.id);
      if (thread.blockId) bridge.focusBlock(thread.blockId);
    },
    [bridge]
  );

  const flashNonce = useRef(0);
  const focusThread = useCallback(
    (threadId: string) => {
      setActiveThreadId(threadId);
      setFocusBlockId(null);
      setTab('open');
      setPanelOpen(true);
      flashNonce.current += 1;
      setFlash({ threadId, nonce: flashNonce.current });
      refresh('panel', { quiet: true });
    },
    [refresh]
  );

  // What the host's buttons do (read by the host at call time). Before the
  // publish below, so the host's first report after a publish has them.
  useEffect(() => {
    bridge.actions = {
      openBlock: blockId => {
        setFocusBlockId(blockId);
        setTab('open');
        setPanelOpen(true);
        refresh('panel');
      },
      openThread: threadId => {
        setActiveThreadId(threadId);
        setFocusBlockId(null);
        setTab('open');
        setPanelOpen(true);
        refresh('panel', { quiet: true });
      },
      startThread,
      setResolution,
    };
  }, [bridge, refresh, startThread]);

  // What the host draws: every thread located, open ones highlighted;
  // the bubbles from the list once it is in, from the loader's counts before.
  const anchors = useMemo<CommentAnchor[]>(
    () =>
      (threads ?? early).flatMap(thread =>
        thread.blockId
          ? [
              {
                id: thread.id,
                blockId: thread.blockId,
                quote: thread.quote,
                occurrence: thread.quoteOccurrence,
                open: thread.resolvedAt === null,
              },
            ]
          : []
      ),
    [threads, early]
  );
  const loaderCounts = readerComments?.counts;
  const counts = useMemo<Record<string, number>>(() => {
    if (!threads) {
      // Not loaded yet: the loader's counts, plus threads answered since.
      const out: Record<string, number> = { ...(loaderCounts ?? {}) };
      for (const thread of early) {
        if (thread.blockId && thread.resolvedAt === null) {
          out[thread.blockId] = (out[thread.blockId] ?? 0) + 1;
        }
      }
      return out;
    }
    const out: Record<string, number> = {};
    for (const thread of threads) {
      if (thread.blockId && thread.resolvedAt === null) {
        out[thread.blockId] = (out[thread.blockId] ?? 0) + 1;
      }
    }
    return out;
  }, [threads, early, loaderCounts]);
  const openCount = threads
    ? threads.filter(thread => thread.resolvedAt === null).length
    : (readerComments?.open ?? 0) + early.filter(thread => thread.resolvedAt === null).length;

  const draftAnchor = useMemo(
    () =>
      draft?.blockId && draft.quote
        ? { blockId: draft.blockId, quote: draft.quote, occurrence: draft.quoteOccurrence }
        : null,
    [draft]
  );

  useEffect(() => {
    bridge.publish({
      input: enabled
        ? { anchors, counts, activeId: activeThreadId, draft: draftAnchor }
        : { anchors: [], counts: {}, activeId: null, draft: null },
      canWrite: enabled && canWrite,
    });
  }, [bridge, enabled, anchors, counts, activeThreadId, draftAnchor, canWrite]);

  if (!enabled) return null;
  return {
    bridge,
    data,
    threads,
    openCount,
    canWrite,
    canResolve,
    frozen,
    panelOpen,
    openPanel,
    closePanel,
    togglePanel,
    tab,
    setTab,
    focusBlockId,
    setFocusBlockId,
    draft,
    startThread,
    cancelDraft,
    submitDraft,
    act,
    activeThreadId,
    selectThread,
    focusThread,
    flash,
    resolution,
  };
}
