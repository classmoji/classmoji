import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IconMessageCircle, IconMessagePlus, IconX } from '@tabler/icons-react';

import { ConfirmDialog } from '~/components/forms/ConfirmDialog.tsx';
import { Composer } from './Composer.tsx';
import { ThreadAnchor, ThreadCard } from './ThreadCard.tsx';
import type { CommentsTab, PageCommentsController } from './usePageCommentsController.ts';
import type { CommentThread, PageComment } from './types.ts';

import './comments.css';

/**
 * The comments panel: right side of the page, a bottom sheet on narrow
 * screens. Open / Resolved tabs, threads in the server's order (document
 * order, page-level and orphaned last), a composer for a new thread on top.
 * Escape closes it (focus back on the button that opened it).
 */
interface CommentsPanelProps {
  controller: PageCommentsController;
  /** The page is in an iframe with no header: the panel starts at the top. */
  embedded?: boolean;
}

export function CommentsButton({
  controller,
  floating = false,
}: {
  controller: PageCommentsController;
  /** No header (embedded): a floating button top-right. */
  floating?: boolean;
}) {
  const count = controller.openCount;
  const label = `Comments${count > 0 ? ` (${count} open)` : ''}`;
  return (
    <button
      type="button"
      data-comments-toggle=""
      onClick={controller.togglePanel}
      aria-label={label}
      aria-expanded={controller.panelOpen}
      aria-controls="page-comments-panel"
      title="Comments"
      className={
        floating
          ? 'fixed right-3 top-3 z-40 flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1.5 text-sm text-gray-700 shadow-md ring-1 ring-stone-200 backdrop-blur hover:bg-gray-50 dark:bg-neutral-900/95 dark:text-gray-200 dark:ring-neutral-700 dark:hover:bg-neutral-800'
          : `flex items-center gap-1 rounded p-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 ${
              controller.panelOpen
                ? 'text-gray-900 dark:text-white'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`
      }
    >
      <IconMessageCircle size={18} />
      {count > 0 && <span className="text-xs font-semibold tabular-nums">{count}</span>}
    </button>
  );
}

export function CommentsPanel({ controller, embedded = false }: CommentsPanelProps) {
  const {
    panelOpen,
    closePanel,
    threads,
    tab,
    setTab,
    focusBlockId,
    setFocusBlockId,
    draft,
    startThread,
    cancelDraft,
    submitDraft,
    canWrite,
    canResolve,
    frozen,
    act,
    activeThreadId,
    selectThread,
    resolution,
    data,
  } = controller;

  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    comment: PageComment;
    thread: CommentThread;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Wide screens: the page makes room for the panel instead of sliding under
  // it (comments.css pads <body> by the panel's width while this is set), so
  // no bubble, highlight or button ends up beneath it. Narrow screens keep
  // the bottom sheet as an overlay (the rule only applies from `md`).
  useEffect(() => {
    if (!panelOpen) return;
    const root = document.documentElement;
    root.dataset.commentsPanel = 'open';
    return () => {
      delete root.dataset.commentsPanel;
    };
  }, [panelOpen]);

  // On open: focus into the panel; on close: back to the toggle button.
  useEffect(() => {
    if (!panelOpen) return;
    const before = document.activeElement as HTMLElement | null;
    if (!draft) closeRef.current?.focus();
    return () => {
      // Only when the panel took the focus with it (Escape, Close). Closed by
      // anything else (a navigation, a click elsewhere), focus stays put.
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const toggle = document.querySelector<HTMLElement>('[data-comments-toggle]');
      (toggle ?? before)?.focus?.();
    };
    // Only on open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen]);

  // The active thread's card, scrolled into the panel's view.
  useEffect(() => {
    if (!panelOpen || !activeThreadId) return;
    const card = panelRef.current?.querySelector(
      `[data-thread-id="${CSS.escape(activeThreadId)}"]`
    );
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [panelOpen, activeThreadId, threads]);

  const { open, resolved } = useMemo(() => {
    const all = threads ?? [];
    const inScope = focusBlockId ? all.filter(thread => thread.blockId === focusBlockId) : all;
    return {
      open: inScope.filter(thread => thread.resolvedAt === null),
      resolved: inScope.filter(thread => thread.resolvedAt !== null),
    };
  }, [threads, focusBlockId]);
  const shown = tab === 'open' ? open : resolved;

  if (!panelOpen) return null;

  // Tabs: arrow keys, Home and End move between them (roving tabindex).
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const order: CommentsTab[] = ['open', 'resolved'];
    const index = order.indexOf(tab);
    let next: CommentsTab | null = null;
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length];
    else if (event.key === 'ArrowLeft') next = order[(index + order.length - 1) % order.length];
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    if (!next) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`page-comments-tab-${next}`)?.focus();
  };

  const tabClass = (selected: boolean) =>
    `rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
      selected
        ? 'bg-stone-100 text-gray-900 dark:bg-neutral-800 dark:text-white'
        : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
    }`;

  return (
    <>
      <aside
        id="page-comments-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="page-comments-title"
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape' && !pendingDelete) {
            event.preventDefault();
            closePanel();
          }
        }}
        className={`fixed z-[45] flex flex-col overflow-hidden bg-stone-50 shadow-xl ring-1 ring-stone-200 dark:bg-[#141414] dark:ring-neutral-800 max-md:inset-x-0 max-md:bottom-0 max-md:h-[72dvh] max-md:rounded-t-2xl md:right-4 md:w-[min(380px,calc(100vw-2rem))] md:rounded-2xl ${
          // Embedded: no header above; and clear of the live-status pill
          // floating in the bottom-right corner (route.tsx).
          embedded ? 'md:top-4 md:bottom-16' : 'md:top-14 md:bottom-4'
        }`}
      >
        <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-2.5 dark:border-neutral-800">
          <h2
            id="page-comments-title"
            className="text-sm font-semibold text-gray-900 dark:text-white"
          >
            Comments
          </h2>
          <div role="tablist" aria-label="Comment threads" className="ml-2 flex gap-1">
            {(['open', 'resolved'] as const).map(id => (
              <button
                key={id}
                id={`page-comments-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls="page-comments-tabpanel"
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={onTabKey}
                className={tabClass(tab === id)}
              >
                {id === 'open' ? 'Open' : 'Resolved'}{' '}
                <span className="tabular-nums text-gray-400 dark:text-gray-500">
                  {id === 'open' ? open.length : resolved.length}
                </span>
              </button>
            ))}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={closePanel}
            aria-label="Close comments"
            title="Close (Esc)"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-stone-200/60 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
          >
            <IconX size={16} />
          </button>
        </div>

        {(focusBlockId || (canWrite && !draft)) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-4 py-2 text-xs dark:border-neutral-800">
            {focusBlockId && (
              <>
                <span className="text-gray-600 dark:text-gray-300">Comments on one block</span>
                <button
                  type="button"
                  onClick={() => setFocusBlockId(null)}
                  className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Show all
                </button>
              </>
            )}
            {canWrite && !draft && (
              <button
                type="button"
                onClick={() =>
                  startThread({ blockId: focusBlockId, quote: null, quoteOccurrence: 0 })
                }
                className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 font-medium text-gray-700 ring-1 ring-stone-200 hover:bg-white dark:text-gray-200 dark:ring-neutral-700 dark:hover:bg-neutral-800"
              >
                <IconMessagePlus size={14} />
                {focusBlockId ? 'Comment on this block' : 'Comment on page'}
              </button>
            )}
          </div>
        )}

        {frozen && (
          <p className="border-b border-stone-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-neutral-800 dark:bg-amber-950/40 dark:text-amber-200">
            This classroom is locked. Comments are read-only.
          </p>
        )}

        <div
          id="page-comments-tabpanel"
          role="tabpanel"
          aria-labelledby={`page-comments-tab-${tab}`}
          className="flex-1 space-y-3 overflow-y-auto p-3"
        >
          {draft && canWrite && (
            <div className="rounded-xl bg-white p-3 ring-2 ring-blue-400/70 dark:bg-neutral-900 dark:ring-blue-500/60">
              <div className="mb-2">
                <ThreadAnchor
                  blockId={draft.blockId}
                  quote={draft.quote}
                  resolution={
                    draft.blockId && !draft.quote ? undefined : { status: 'found', excerpt: '' }
                  }
                />
              </div>
              <Composer
                label="New comment"
                placeholder={draft.blockId ? 'Add a comment…' : 'Add a comment on the page…'}
                submitLabel="Post comment"
                autoFocus
                cancelLabel="Cancel"
                onCancel={() => {
                  cancelDraft();
                  // The composer goes away: keep focus in the panel (Escape closes it).
                  closeRef.current?.focus();
                }}
                onSubmit={submitDraft}
              />
            </div>
          )}

          {threads === null ? (
            <div className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              {data.loading ? 'Loading comments…' : 'Comments could not be loaded.'}
            </div>
          ) : shown.length === 0 ? (
            !draft && (
              <div className="py-12 text-center text-gray-500 dark:text-gray-400">
                <div className="font-medium">
                  {tab === 'open' ? 'No open comments' : 'No resolved comments'}
                </div>
                <div className="text-sm">
                  {tab === 'open' && canWrite
                    ? 'Select text on the page, or comment on the page as a whole.'
                    : ''}
                </div>
              </div>
            )
          ) : (
            shown.map(thread => (
              <div key={thread.id} data-thread-id={thread.id}>
                <ThreadCard
                  thread={thread}
                  resolution={resolution[thread.id]}
                  active={thread.id === activeThreadId}
                  canWrite={canWrite}
                  canResolve={canResolve}
                  frozen={frozen}
                  act={act}
                  onSelect={selectThread}
                  onRequestDelete={(comment, owner) => setPendingDelete({ comment, thread: owner })}
                />
              </div>
            ))
          )}
        </div>
      </aside>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this comment?"
        body={
          pendingDelete && pendingDelete.thread.comments.length === 1
            ? [
                'It is removed for everyone.',
                'It is the only comment in its thread, so the thread goes too.',
              ]
            : 'It is removed for everyone.'
        }
        confirmLabel="Delete"
        variant="danger"
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          setDeleting(true);
          await act({ intent: 'delete', commentId: pendingDelete.comment.id });
          setDeleting(false);
          setPendingDelete(null);
        }}
      />
    </>
  );
}
