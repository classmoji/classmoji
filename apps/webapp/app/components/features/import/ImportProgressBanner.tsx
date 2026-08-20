/**
 * ImportProgressBanner — live status for a background classroom import.
 *
 * Classroom creation now returns as soon as the `ImportJob` row exists, so the
 * GitHub-bound phases (template duplication, the content-repo copy, modules)
 * finish minutes AFTER the user lands in their new classroom. This banner is
 * the only thing that tells them that work is still happening, how far along it
 * is, and — the case it was built for — that a long pause is a GitHub rate-limit
 * wait rather than a hang.
 *
 * Polls the admin-gated read endpoint every 2s while the job is live and stops
 * dead on a terminal status; a completed run tidies itself away, and a failed
 * one stays put with a retry that RESUMES rather than restarts.
 */

import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import {
  overallPercent,
  IMPORT_PHASE_LABELS,
  IMPORT_PHASE_ORDER,
  COUNTED_PHASE_KEYS,
  type CountedPhaseProgress,
  type ImportPhaseKey,
  type ImportPhaseStatus,
  type ImportProgress,
} from '@classmoji/services/import-progress';
import type { ImportJobView } from '~/routes/api.import-jobs.$jobId/route';

/** Poll cadence while the job is live. Matches the task's ~1s progress writes. */
const POLL_INTERVAL_MS = 2000;

/** How long a finished banner stays up before tidying itself away. */
const COMPLETED_AUTOHIDE_MS = 8000;

/** A completed run stays REOPENABLE this long, so the summary isn't lost on a stray click. */
const COMPLETED_REOPEN_WINDOW_MS = 10 * 60 * 1000;

/** Human names for the coarse `phase` column, for the retry button's label. */
const COARSE_PHASE_LABELS: Record<string, string> = {
  config: 'settings',
  repositories: 'repositories',
  templates: 'template repositories',
  content: 'content',
  modules: 'modules',
};

const isCounted = (key: ImportPhaseKey): boolean =>
  (COUNTED_PHASE_KEYS as readonly string[]).includes(key);

/** Per-status chip colours, in both themes. */
const CHIP_STYLES: Record<ImportPhaseStatus, string> = {
  done: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  running:
    'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300',
  failed:
    'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300',
  pending:
    'border-gray-200 bg-gray-50 text-gray-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-gray-400',
  skipped:
    'border-gray-200 bg-gray-50 text-gray-400 dark:border-neutral-700 dark:bg-neutral-800 dark:text-gray-500',
};

const Spinner = () => (
  <svg
    className="h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
  </svg>
);

/** One phase, with its count when it has one. */
const PhaseChip = ({
  phaseKey,
  progress,
}: {
  phaseKey: ImportPhaseKey;
  progress: ImportProgress;
}) => {
  const phase = progress.phases?.[phaseKey];
  if (!phase || phase.status === 'skipped') return null;

  const counted = isCounted(phaseKey) ? (phase as CountedPhaseProgress) : null;
  const showCount = counted && counted.total > 0 && phase.status !== 'pending';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${CHIP_STYLES[phase.status]}`}
    >
      {phase.status === 'done' && <span aria-hidden="true">✓</span>}
      {phase.status === 'failed' && <span aria-hidden="true">✕</span>}
      {IMPORT_PHASE_LABELS[phaseKey]}
      {showCount && (
        <span className="tabular-nums opacity-80">
          {counted.done}/{counted.total}
        </span>
      )}
    </span>
  );
};

export interface ImportProgressBannerProps {
  /** The job as the layout loader saw it; polling takes over from here. */
  job: ImportJobView;
  /** Source classroom name, for the title. Falls back to a generic phrase. */
  sourceName?: string | null;
}

const ImportProgressBanner = ({ job: initialJob, sourceName }: ImportProgressBannerProps) => {
  const poll = useFetcher<ImportJobView>();
  const retry = useFetcher<ImportJobView | { error: string }>();

  // Session-only dismissal: deliberately NOT persisted. The banner describes one
  // run in flight; a remembered dismissal would silently hide a later failure.
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const autoHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Freshest of: the loader's row, the poll's response, the retry's response.
  //
  // Compared by `updated_at` rather than by precedence, because a fetcher keeps
  // its data after the submission settles: a retry response would otherwise
  // outrank every later poll FOREVER, freezing the banner on the PENDING
  // snapshot it returned — a hung progress bar, which is the exact failure this
  // component exists to prevent.
  const retried = retry.data && 'id' in retry.data ? retry.data : null;
  const job = [initialJob, poll.data, retried]
    .filter((candidate): candidate is ImportJobView => Boolean(candidate))
    .reduce((newest, candidate) =>
      new Date(newest.updated_at) >= new Date(candidate.updated_at) ? newest : candidate
    );
  const isLive = job.status === 'PENDING' || job.status === 'RUNNING';

  const jobId = job.id;
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!isLive || dismissed) return;
    const timer = setInterval(() => {
      // `load` is a no-op while one is already in flight, so a slow response
      // cannot stack up requests.
      if (pollRef.current.state === 'idle') {
        pollRef.current.load(`/api/import-jobs/${jobId}`);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isLive, dismissed, jobId]);

  // A finished import tidies itself away, but stays reopenable for a while —
  // the summary line is the only place the final counts are shown.
  //
  // A completed-with-warnings import does NOT tidy itself away. Something the
  // user asked for was not imported, and collapsing that after 8 seconds is how
  // an empty classroom goes unnoticed until the term starts. They dismiss it.
  useEffect(() => {
    if (job.status !== 'COMPLETED' || job.warnings?.length > 0) return;
    autoHideRef.current = setTimeout(() => setCollapsed(true), COMPLETED_AUTOHIDE_MS);
    return () => {
      if (autoHideRef.current) clearTimeout(autoHideRef.current);
    };
  }, [job.status, job.warnings?.length]);

  if (dismissed) return null;

  const progress = (job.progress ?? { phases: {} }) as ImportProgress;
  const percent = progress.phases ? overallPercent(progress) : 0;
  const age = Date.now() - new Date(job.updated_at).getTime();

  if (job.status === 'COMPLETED' && collapsed) {
    // Past the reopen window the banner is simply done.
    if (age > COMPLETED_REOPEN_WINDOW_MS) return null;
    return (
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900"
        >
          ✓ Import complete — view summary
        </button>
      </div>
    );
  }

  // The first phase still reporting a transient note (a GitHub rate-limit wait,
  // repo pacing). Surfacing it is the whole reason `note` exists: without it a
  // 60s backoff is indistinguishable from a dead job.
  const notedPhase = IMPORT_PHASE_ORDER.map(key => progress.phases?.[key])
    .filter(Boolean)
    .find(phase => phase?.note);
  const waitingNote = notedPhase?.note;
  // Amber is reserved for genuine limit waits; routine activity (cloning,
  // pushing) reads as neutral status, not a warning.
  const noteIsWarn = notedPhase?.note_level === 'warn';

  const failed = job.status === 'FAILED';
  const completed = job.status === 'COMPLETED';
  const retryLabel = job.phase
    ? `Retry ${COARSE_PHASE_LABELS[job.phase] ?? job.phase}`
    : 'Retry import';
  const retryError = retry.data && 'error' in retry.data ? retry.data.error : null;

  const tone = failed
    ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
    : completed
      ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40'
      : 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40';

  return (
    <div className={`mb-4 rounded-xl border p-4 ${tone}`} role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {isLive && <Spinner />}
          <h2 className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
            {failed
              ? 'Import stopped'
              : completed
                ? 'Import complete'
                : `Importing from ${sourceName || 'the source classroom'}…`}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Hide import progress"
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-black/5 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
        >
          ✕
        </button>
      </div>

      {!failed && !completed && (
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/50">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-500 dark:bg-blue-400"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-1 text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {percent}%
          </div>
        </div>
      )}

      {completed && (
        <p className="mt-2 text-sm text-emerald-800 dark:text-emerald-300">
          {progress.parts && progress.parts.length > 0
            ? `Imported ${progress.parts.join(', ')}.`
            : 'Everything selected has been imported.'}
        </p>
      )}

      {waitingNote && !failed && !completed && (
        <p
          className={`mt-2 rounded-md px-2 py-1 text-xs ${
            noteIsWarn
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              : 'bg-blue-100/70 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200'
          }`}
        >
          {waitingNote}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {IMPORT_PHASE_ORDER.map(key => (
          <PhaseChip key={key} phaseKey={key} progress={progress} />
        ))}
      </div>

      {failed && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-red-800 dark:text-red-300">
            {job.error || 'The import could not finish.'}
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            Everything imported so far is saved. Retrying picks up where it stopped — nothing is
            copied twice.
          </p>
          <retry.Form method="post" action={`/api/import-jobs/${jobId}`}>
            <button
              type="submit"
              disabled={retry.state !== 'idle'}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 dark:bg-red-700 dark:hover:bg-red-600"
            >
              {retry.state === 'idle' ? retryLabel : 'Restarting…'}
            </button>
          </retry.Form>
          {retryError && <p className="text-xs text-red-700 dark:text-red-400">{retryError}</p>}
        </div>
      )}

      {job.warnings?.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {job.warnings.length} item{job.warnings.length === 1 ? '' : 's'} skipped.
          </p>
          {/*
            The count alone is not actionable: a whole content phase can copy
            nothing and report "1 item skipped", which reads as a rounding error
            rather than an empty classroom. Show the text, as the sibling
            _user.import-classroom/StepProgress does. Capped at 6 — per-item
            warnings on a large course can run to dozens.
          */}
          <ul className="ml-5 mt-1 list-disc text-xs text-amber-600 dark:text-amber-400">
            {job.warnings.slice(0, 6).map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
          {job.warnings.length > 6 && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              …and {job.warnings.length - 6} more.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ImportProgressBanner;
