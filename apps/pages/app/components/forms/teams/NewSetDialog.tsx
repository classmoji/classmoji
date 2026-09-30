import { useEffect, useId, useRef, useState } from 'react';
import { IconLoader2 } from '@tabler/icons-react';

import { ActionErrorNote, type CreateFlowError } from './CreatingProgress.tsx';
import { TEAMS_LABELS } from './teamsView.ts';

/**
 * Team sets — the name dialog for a new set.
 *
 * Presentational, with two callers that post differently: the sets list
 * (`intent: 'new-set'` to the list's action) and a created set's landing
 * ("Start a new set from this setup", `intent: 'new-set-from-setup'` through
 * `useSetFetcher`). The dialog never posts; Submit hands the typed name to
 * `onSubmit`, trimmed ('' = let the server use its suggestion). Both actions
 * redirect to the new set's Setup, so success closes the dialog by leaving
 * the page; a refusal comes back as `error`.
 *
 * The name input starts from `defaultName` each time the dialog opens. The
 * service stores names as slugs (lowercase, hyphens, at most 40 characters),
 * so the input takes at most that many.
 *
 * The forms admin's hand-rolled dialog (ConfirmDialog, CreateDialog):
 * overlay, `role=dialog`, `aria-modal`, Escape and the overlay close it, Tab
 * stays inside. Focus starts on the name input with its text selected:
 * nothing here is destructive, and typing replaces the suggestion. Closing
 * puts focus back on the button that opened it.
 */

/** The longest name the service keeps (teamSet.service `normalizeSetName`). */
const NAME_MAX_LENGTH = 40;

/** What Tab cycles through inside the panel. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface NewSetDialogProps {
  open: boolean;
  /** The name the input starts with (the suggestion, made free); '' = empty. */
  defaultName: string;
  /** The heading; default "New team set". */
  title?: string;
  /** The post is in flight (or its redirect is loading). */
  busy?: boolean;
  /** The action's refusal: its sentence and the list it names. */
  error?: CreateFlowError | null;
  /** The typed name, trimmed. */
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function NewSetDialog({
  open,
  defaultName,
  title = TEAMS_LABELS.newTeamSet,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: NewSetDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const [name, setName] = useState(defaultName);
  // Read at opening only: a revalidation while the dialog is open (another
  // set made elsewhere) must not replace what the person is typing.
  const defaultRef = useRef(defaultName);
  defaultRef.current = defaultName;

  // Each opening starts from the default again. Focus goes back to what
  // opened the dialog when it closes (taken here, before the focus moves).
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setName(defaultRef.current);
    // After the value is in the input, so the selection covers it.
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
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
        aria-labelledby={titleId}
        aria-busy={busy}
        data-testid="new-set-dialog"
        className="relative z-10 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-800"
      >
        <form
          onSubmit={event => {
            event.preventDefault();
            if (!busy) onSubmit(name.trim());
          }}
        >
          <div className="space-y-4 px-5 pb-4 pt-5">
            <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-white">
              {title}
            </h2>

            <div className="space-y-1">
              <label
                htmlFor={inputId}
                className="block text-xs font-semibold text-gray-600 dark:text-gray-300"
              >
                {TEAMS_LABELS.name}
              </label>
              <input
                ref={inputRef}
                id={inputId}
                type="text"
                name="name"
                value={name}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={event => setName(event.target.value)}
                data-testid="new-set-name"
                className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:focus:border-gray-400 dark:focus:ring-gray-400"
              />
            </div>

            {error ? <ActionErrorNote error={error} /> : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              {TEAMS_LABELS.cancel}
            </button>
            <button
              type="submit"
              disabled={busy}
              aria-busy={busy}
              data-testid="new-set-submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
            >
              {busy ? (
                <IconLoader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
              ) : null}
              {TEAMS_LABELS.startSet}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default NewSetDialog;
