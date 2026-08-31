import { useEffect, useRef } from 'react';

/**
 * The confirmation the forms admin surfaces ask for before a destructive or
 * irreversible action.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 * These three prompts (publish-a-new-version, delete-a-form, delete-responses)
 * were native browser confirms. That is wrong here for reasons beyond taste
 * (and a repo-wide grep guards against the pattern coming back, which is why
 * this note spells none of those calls out literally):
 *
 *  - it renders the ORIGIN in Chrome's chrome, so an instructor on a class
 *    subdomain is asked to approve a deletion by "cs52.classmoji.io says";
 *  - it cannot say which of the two buttons is the dangerous one, so a
 *    form-delete and a form-publish look identical;
 *  - `\n\n` is the only formatting it has, and it ignores the app's theme;
 *  - it blocks the main thread, and Playwright auto-dismisses it, so no test
 *    can ever assert that the person was actually asked.
 *
 * The idiom is deliberately the hand-rolled one already used by the New Form
 * drawer and the response detail panel on this surface — overlay + `role
 * ="dialog"` + `aria-modal` + Escape — rather than Mantine's `Modal`. Mantine
 * is mounted at the root, but only to serve BlockNote; nothing in the forms
 * admin uses it, and a single Mantine surface among hand-rolled siblings would
 * inherit a different type scale and a different overlay.
 *
 * Focus goes to the DISMISSING button on open, not the confirming one. A
 * stray Return keypress arriving a frame after the dialog mounts should cancel
 * a deletion, never complete one.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** Rendered as its own paragraph per entry — this is the `\n\n` a native confirm could only approximate. */
  body: string | string[];
  confirmLabel: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      // A modal that lets Tab wander back into the page behind it is a modal in
      // name only: a keyboard user tabs "past" the dialog and operates the very
      // table the dialog is asking about. Two focusable elements make the trap
      // cheap enough to hand-roll — wrap at both ends.
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const paragraphs = Array.isArray(body) ? body : [body];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
        role="presentation"
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative z-10 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-800"
      >
        <div className="px-5 pb-3 pt-5">
          <h2
            id="confirm-dialog-title"
            className="text-base font-semibold text-gray-900 dark:text-white"
          >
            {title}
          </h2>
          <div className="mt-2 space-y-2">
            {paragraphs.map(paragraph => (
              <p key={paragraph} className="text-sm text-gray-600 dark:text-gray-300">
                {paragraph}
              </p>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={
              variant === 'danger'
                ? 'rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40'
                : 'rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
