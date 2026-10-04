import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { rejectionNotice, type LiveRefusal } from '~/utils/collab.ts';

const reload = () => window.location.reload();

const primaryButton =
  'rounded px-3 py-1 text-sm font-medium transition-colors bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400';

function Bar({
  testId,
  isEmbedded,
  message,
  children,
}: {
  testId: string;
  isEmbedded: boolean;
  message: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`sticky ${isEmbedded ? 'top-0' : 'top-12'} z-30`}
    >
      <div className="border-y border-amber-300 dark:border-amber-700/70 bg-amber-50/95 dark:bg-amber-950/90 backdrop-blur px-4 sm:px-6 lg:px-8 py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <span className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            {message}
          </span>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The banner for a live session that ended. Every case offers Reload — a
 * refused session is never a dead end. Nothing is shown while the route is
 * reloading by itself.
 */
export function LiveRejectedBanner({
  reason,
  isEmbedded,
  autoReloading,
  onCopyUnsaved = null,
}: {
  reason: LiveRefusal;
  isEmbedded: boolean;
  /** The route is reloading on its own; the banner would only flash. */
  autoReloading: boolean;
  /** Offered when this browser holds edits the server never acknowledged. */
  onCopyUnsaved?: (() => void) | null;
}) {
  if (autoReloading) return null;
  const notice = rejectionNotice(reason);
  return (
    <Bar testId="live-rejected-banner" isEmbedded={isEmbedded} message={notice.message}>
      <div className="flex items-center gap-2">
        {onCopyUnsaved && (
          <button
            type="button"
            onClick={onCopyUnsaved}
            className="rounded px-3 py-1 text-sm font-medium transition-colors text-amber-900 ring-1 ring-amber-400 hover:bg-amber-100 dark:text-amber-100 dark:ring-amber-600 dark:hover:bg-amber-900/50"
          >
            Copy my unsaved changes
          </button>
        )}
        <button type="button" onClick={reload} className={primaryButton} data-reason={reason}>
          Reload
        </button>
      </div>
    </Bar>
  );
}

/** The room did not arrive within the grace period; the page stays readable. */
export function LiveUnreachableNotice({ isEmbedded }: { isEmbedded: boolean }) {
  return (
    <Bar
      testId="live-unreachable"
      isEmbedded={isEmbedded}
      message="Couldn’t connect to live editing. Try again."
    >
      <button type="button" onClick={reload} className={primaryButton}>
        Reload
      </button>
    </Bar>
  );
}

/**
 * Leaving a live page whose edits have not all reached the server: the app's
 * own dialog (never the browser's), with staying as the default.
 */
export function LeaveLiveDialog({
  offline,
  onStay,
  onLeave,
}: {
  offline: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog and comes back to where it was when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  // Tab and Shift+Tab stay inside the dialog; Escape stays on the page.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onStay();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-live-title"
      aria-describedby="leave-live-body"
      data-testid="leave-live-dialog"
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl ring-1 ring-stone-200 dark:bg-neutral-900 dark:ring-neutral-800"
      >
        <h2
          id="leave-live-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          {offline ? 'You’re offline' : 'Your latest edits haven’t synced yet'}
        </h2>
        <p id="leave-live-body" className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          If you leave now, edits that haven’t synced will be lost.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onLeave}
            className="rounded px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-300 hover:bg-gray-100 dark:text-gray-200 dark:ring-neutral-600 dark:hover:bg-neutral-800"
          >
            Leave anyway
          </button>
          <button
            type="button"
            onClick={onStay}
            autoFocus
            className="rounded px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            Stay
          </button>
        </div>
      </div>
    </div>
  );
}
