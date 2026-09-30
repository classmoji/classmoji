import { useEffect, useId, useState } from 'react';
import { IconExternalLink } from '@tabler/icons-react';
import dayjs from 'dayjs';

import { ActionErrorNote, CreateFailureList, type CreateFlowError } from './CreatingProgress.tsx';
import {
  SET_FINISHED_TEXT,
  SET_STATUS_LABELS,
  TEAMS_LABELS,
  createdByText,
  createdTitle,
} from './teamsView.ts';
import type { CreateProgressView, CreatedLinks } from './types.ts';

/**
 * Team sets — the Created summary, the landing of a set whose teams exist.
 *
 * Presentational: the create as the set loaded it, the links the loader built
 * for this viewer, and one callback. "Open in Teams" and "Make a group
 * assignment for this tag" go to the webapp (another origin, so plain anchors),
 * and only owners get them: the loader passes null for a screen the viewer
 * has no route to, and a null link is left out. "Start a new set from this
 * setup" is for owners and teachers; the set page opens its name dialog and
 * posts `new-set-from-setup`.
 *
 * A PARTIAL create (every team exists, some members or tags were not added)
 * gets the same card in amber, its status label, and the failures.
 *
 * The date is formatted after mount, in the browser's zone (the builder's
 * reason: the server's zone is not the viewer's, and formatting during render
 * is a hydration mismatch); until then the line keeps its height.
 *
 * Render CreatedTeamsList after it; the fixed "This set is finished." line
 * sits between the two, as here.
 */

/** "26 Sep at 3:12 pm", as createdByText expects it. */
const FINISHED_FORMAT = 'D MMM [at] h:mm a';

export interface CreatedSummaryProps {
  /** A DONE or PARTIAL create. */
  create: CreateProgressView;
  /** The viewer's user id ("By you"). */
  viewerId: string;
  /** Webapp links; null = not for this viewer (teachers). */
  links: CreatedLinks;
  /** Start a new set from this setup (the page opens its name dialog). */
  onStartNewSet: () => void;
  /** The new-set post is in flight. */
  busy?: boolean;
  /** The new-set refusal, if the action returned one. */
  error?: CreateFlowError | null;
}

export function CreatedSummary({
  create,
  viewerId,
  links,
  onStartNewSet,
  busy = false,
  error = null,
}: CreatedSummaryProps) {
  const titleId = useId();
  const partial = create.status === 'PARTIAL';
  const when = create.finished_at ?? create.started_at;

  const [finishedOn, setFinishedOn] = useState<string | null>(null);
  useEffect(() => {
    const parsed = dayjs(when);
    setFinishedOn(when && parsed.isValid() ? parsed.format(FINISHED_FORMAT) : null);
  }, [when]);

  return (
    <div>
      <section
        aria-labelledby={titleId}
        className={`space-y-3 rounded-xl border px-4 py-4 ${
          partial
            ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30'
            : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id={titleId}
            className={`break-all text-base font-semibold ${
              partial
                ? 'text-amber-900 dark:text-amber-100'
                : 'text-emerald-900 dark:text-emerald-100'
            }`}
          >
            {createdTitle(create)}
          </h2>
          {partial ? (
            <span className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {SET_STATUS_LABELS.partial}
            </span>
          ) : null}
        </div>

        <p className="min-h-5 text-sm text-gray-700 dark:text-gray-300">
          {finishedOn ? createdByText(create, viewerId, finishedOn) : null}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {links.teamsUrl ? (
            <a
              href={links.teamsUrl}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
            >
              {TEAMS_LABELS.openInTeams}
              <IconExternalLink size={14} aria-hidden="true" />
            </a>
          ) : null}
          {links.assignmentUrl ? (
            <a
              href={links.assignmentUrl}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              {TEAMS_LABELS.makeGroupAssignment}
              <IconExternalLink size={14} aria-hidden="true" />
            </a>
          ) : null}
          <span className="hidden flex-1 sm:block" aria-hidden="true" />
          <button
            type="button"
            onClick={onStartNewSet}
            disabled={busy}
            aria-busy={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-white/70 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-200 dark:hover:bg-gray-900/60"
          >
            {TEAMS_LABELS.startNewSet}
          </button>
        </div>

        {create.failures.length > 0 ? <CreateFailureList failures={create.failures} /> : null}
        {error ? <ActionErrorNote error={error} /> : null}
      </section>

      <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">{SET_FINISHED_TEXT}</p>
    </div>
  );
}
