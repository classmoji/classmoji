import type { ReactNode } from 'react';

import {
  RUN_STATUS_LABELS,
  TEAMS_LABELS,
  runStartedText,
  runTitle,
  runningSteps,
  type RunningStep,
} from './teamsView.ts';
import type { RunViewModel, TeamSetRunStatus } from './types.ts';

/**
 * A run that hasn't finished: who started it, then its four steps with the
 * counts they worked from. No times anywhere: the steps say what is done, not
 * how long anything takes.
 *
 * Read answers and Checked the Must rules are done by the time a run is
 * queued; Solving is live while the run is RUNNING (pending while QUEUED);
 * Score and save completes with the run, so it stays pending here. The route
 * swaps this card for Results or Can't solve when the poll sees the run end.
 *
 * Presentational: `children` render under the card (the route's link to the
 * last solved run).
 */

/** Rendered for QUEUED and RUNNING runs; `status` is the run's own. */
export type RunningCardRun = Pick<RunViewModel, 'number' | 'status' | 'created_by' | 'progress'>;

export interface RunningCardProps {
  run: RunningCardRun;
  /** The viewer's user id: their own run reads "Started by you". */
  viewerId: string;
  children?: ReactNode;
}

type StepState = 'done' | 'live' | 'pending';

function stepState(step: RunningStep, status: TeamSetRunStatus): StepState {
  if (step.key === 'read' || step.key === 'checked') return 'done';
  if (step.key === 'solving' && status === 'RUNNING') return 'live';
  return 'pending';
}

function StepMark({ state, index }: { state: StepState; index: number }) {
  if (state === 'done') {
    return (
      <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-blue-600 text-[11px] font-bold text-white dark:bg-blue-500">
        <span aria-hidden="true">✓</span>
        <span className="sr-only">{TEAMS_LABELS.stepDone}</span>
      </span>
    );
  }
  if (state === 'live') {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 h-5 w-5 rounded-full border-2 border-blue-600 ring-4 ring-blue-100 dark:border-blue-400 dark:ring-blue-950"
      />
    );
  }
  return (
    <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-gray-300 text-[11px] font-bold text-gray-400 dark:border-gray-600 dark:text-gray-500">
      {index + 1}
    </span>
  );
}

export function RunningCard({ run, viewerId, children }: RunningCardProps) {
  const steps = runningSteps(run.progress);

  return (
    <div className="grid gap-3">
      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-200 bg-gray-50 px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            {runTitle(run.number)}
          </h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {runStartedText(run.created_by, run.progress.pins, viewerId)}
          </span>
          {run.status === 'QUEUED' ? (
            <span className="ml-auto rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-300">
              {RUN_STATUS_LABELS.QUEUED}
            </span>
          ) : null}
        </header>
        <ol className="divide-y divide-gray-200 dark:divide-gray-700">
          {steps.map((step, index) => {
            const state = stepState(step, run.status);
            return (
              <li
                key={step.key}
                aria-current={state === 'live' ? 'step' : undefined}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 px-4 py-3"
              >
                <StepMark state={state} index={index} />
                <div className="min-w-0">
                  <div
                    className={`text-sm font-semibold ${
                      state === 'pending'
                        ? 'text-gray-500 dark:text-gray-400'
                        : 'text-gray-900 dark:text-white'
                    }`}
                  >
                    {step.label}
                  </div>
                  {step.detail ? (
                    <div className="text-xs text-gray-500 dark:text-gray-400">{step.detail}</div>
                  ) : null}
                  {state === 'live' ? (
                    <div
                      aria-hidden="true"
                      className="mt-2 h-2 overflow-hidden rounded-full border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800"
                    >
                      <div className="h-full w-2/5 rounded-full bg-blue-600 motion-safe:animate-pulse dark:bg-blue-500" />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

export default RunningCard;
