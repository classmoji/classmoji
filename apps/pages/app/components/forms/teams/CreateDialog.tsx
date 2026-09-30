import { useEffect, useId, useRef, useState } from 'react';
import { IconLoader2 } from '@tabler/icons-react';

import { ActionErrorNote, type CreateFlowError } from './CreatingProgress.tsx';
import {
  createBlockedText,
  createButtonText,
  createDialogTitle,
  createRetryText,
  studentsText,
  tagStatusText,
  TEAMS_LABELS,
  teamNamesExample,
} from './teamsView.ts';
import type { CreateAvailability, CreatePreviewView, RunViewModel } from './types.ts';

/**
 * Team sets — the Create dialog, opened from a solved run's runline.
 *
 * Presentational: the run page posts `preview-create` when it opens the
 * dialog and hands the answer in as `preview` (null while it is on its way,
 * and for a teacher, whose preview the action refuses); Create calls
 * `onCreate({ githubTeams })`, which the page posts as `intent: 'create'`.
 * The title and the Create button read the run's own teams until the preview
 * lands, so the dialog is named from its first frame.
 *
 * Owner only. `availability` says whether this viewer can create from this run
 * and what stops it (a teacher, a stale run, a create already made or under
 * way, another run's failed create); when something does, Create and the
 * checkbox are disabled and its sentence is shown. The tag is display only:
 * the set's name, new or existing, as the service makes it.
 *
 * The forms admin's hand-rolled dialog (ConfirmDialog): overlay, `role=dialog`,
 * `aria-modal`, Escape and the overlay close it, Tab stays inside, focus
 * starts on Cancel so a stray Return never creates teams, and goes back to
 * the button that opened the dialog when it closes (after a create, that
 * button is disabled, so focus stays on the page).
 */

/** What Tab cycles through inside the panel. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface CreateDialogProps {
  open: boolean;
  /** The run the teams come from; its teams name the dialog before the preview arrives. */
  run: Pick<RunViewModel, 'number' | 'teams'>;
  /** The `preview-create` answer; null while it is pending or when it was refused. */
  preview: CreatePreviewView | null;
  /** Whether this viewer can create from this run (CreateAvailability, from the run loader). */
  availability: CreateAvailability;
  /** The create post is in flight. */
  busy?: boolean;
  /** A refusal from `preview-create` or `create` (name_collision and run_stale carry items). */
  error?: CreateFlowError | null;
  /** Classroom-only teams are off: the checkbox shows checked and can't change. */
  githubTeamsLocked?: boolean;
  onCreate: (choice: { githubTeams: boolean }) => void;
  onCancel: () => void;
}

export function CreateDialog({
  open,
  run,
  preview,
  availability,
  busy = false,
  error = null,
  githubTeamsLocked = false,
  onCreate,
  onCancel,
}: CreateDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const checkboxId = useId();

  // null until the checkbox is touched, so it follows the preview's setting
  // (default on) when the preview lands after the dialog opened.
  const [githubChoice, setGithubChoice] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open) setGithubChoice(null);
  }, [open]);

  // Focus starts on Cancel, and goes back to what opened the dialog when it
  // closes (taken here, before the focus moves).
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
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

  const blocked = createBlockedText(availability);
  const planned = preview ?? { run_number: run.number, teams: run.teams };
  const githubTeams = githubTeamsLocked ? true : (githubChoice ?? preview?.github_teams ?? true);
  // A teacher's refused preview comes back as the same sentence the note shows.
  const shownError = error && error.message !== blocked ? error : null;
  const loading = preview === null && shownError === null && blocked === null;
  const canCreate = preview !== null && blocked === null && !busy;

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
        aria-busy={loading || busy}
        className="relative z-10 flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800"
      >
        <div className="space-y-4 overflow-y-auto px-5 pb-4 pt-5">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-white">
              {createDialogTitle(planned)}
            </h2>
            {preview ? (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {studentsText(preview.students)}
              </p>
            ) : null}
            {preview?.retry ? (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {createRetryText(preview.retry, preview.teams.length)}
              </p>
            ) : null}
          </div>

          {loading ? (
            <div className="flex justify-center py-6 text-gray-400 dark:text-gray-500">
              <IconLoader2 size={22} aria-hidden="true" className="motion-safe:animate-spin" />
            </div>
          ) : null}

          {preview ? (
            <>
              <div className="space-y-1">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                  {TEAMS_LABELS.tagForSet}
                </div>
                <div className="break-all rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 font-mono text-[13px] text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white">
                  {preview.tag.name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {tagStatusText(preview.tag)}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                  {TEAMS_LABELS.teamNames}
                </div>
                <div className="break-all rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 font-mono text-[13px] text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white">
                  {teamNamesExample(preview)}
                </div>
              </div>

              {preview.warnings.length > 0 ? (
                <ul className="list-disc space-y-0.5 rounded-md border border-amber-200 bg-amber-50 py-2 pl-7 pr-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  {preview.warnings.map((warning, index) => (
                    <li key={`${index}:${warning}`}>{warning}</li>
                  ))}
                </ul>
              ) : null}

              <div className="flex items-start gap-2">
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={githubTeams}
                  disabled={githubTeamsLocked || blocked !== null || busy}
                  onChange={event => setGithubChoice(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-500 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900"
                />
                <label
                  htmlFor={checkboxId}
                  className="text-sm font-medium text-gray-900 dark:text-white"
                >
                  {TEAMS_LABELS.alsoGithub}
                </label>
              </div>
            </>
          ) : null}

          {blocked ? (
            <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
              {blocked}
            </p>
          ) : null}

          {shownError ? <ActionErrorNote error={shownError} /> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {TEAMS_LABELS.cancel}
          </button>
          <button
            type="button"
            onClick={() => onCreate({ githubTeams })}
            disabled={!canCreate}
            aria-busy={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            {busy ? (
              <IconLoader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
            ) : null}
            {createButtonText(planned.teams.length)}
          </button>
        </div>
      </div>
    </div>
  );
}
