import { useEffect, useId, useRef } from 'react';

/**
 * Asked before leaving the live editor while edits are still on their way.
 * A modal dialog: focus moves to Stay, Tab stays inside, Escape stays, and
 * focus returns to where it was when the dialog closes.
 */
export default function LiveLeaveDialog({
  onStay,
  onLeave,
}: {
  onStay: () => void;
  onLeave: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    stayRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onStay();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []
    );
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
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/30 dark:bg-black/50"
      data-testid="live-leave-dialog"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        className="w-[calc(100%-2rem)] max-w-sm rounded-xl bg-white p-5 shadow-xl ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
      >
        <h2 id={titleId} className="font-semibold text-gray-900 dark:text-gray-100">
          Your latest changes haven&rsquo;t synced yet
        </h2>
        <p id={bodyId} className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          If you leave now, they may be lost.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={stayRef}
            type="button"
            onClick={onStay}
            className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            Stay
          </button>
          <button
            type="button"
            onClick={onLeave}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
          >
            Leave anyway
          </button>
        </div>
      </div>
    </div>
  );
}
