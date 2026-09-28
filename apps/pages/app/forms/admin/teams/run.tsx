import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useLoaderData, useNavigate } from 'react-router';

import type { TeamSetPinAdd } from '@classmoji/services/team-set-config';

import { ConfirmDialog } from '~/components/forms/ConfirmDialog.tsx';
import { CantSolveView } from '~/components/forms/teams/CantSolveView.tsx';
import { CreateDialog } from '~/components/forms/teams/CreateDialog.tsx';
import {
  ActionErrorNote,
  CreatingProgress,
  type CreateFlowError,
} from '~/components/forms/teams/CreatingProgress.tsx';
import { ResultsView } from '~/components/forms/teams/ResultsView.tsx';
import { RunList } from '~/components/forms/teams/RunList.tsx';
import { Runline } from '~/components/forms/teams/Runline.tsx';
import { RunningCard } from '~/components/forms/teams/RunningCard.tsx';
import { runErrorSentence } from '~/components/forms/teams/teamsErrors.ts';
import {
  TEAMS_LABELS,
  changesNotRunText,
  checkLineText,
  comparePath,
  createBlockedText,
  liveCreate,
  runPath,
  runTitle,
  showRunText,
} from '~/components/forms/teams/teamsView.ts';
import type {
  RunPageData,
  SetActionData,
  TeamSetLayoutData,
} from '~/components/forms/teams/types.ts';
import {
  useSetFetcher,
  useSetLiveStatus,
  useTeamSetLayoutData,
} from '~/components/forms/teams/useSetFetcher.ts';

import { loadRunPage, teamsHeaders, type TeamsRouteArgs } from './teamsData.server.ts';

/**
 * The Runs tab on run n (`runs/:runNumber`): the rail of the set's runs beside
 * the run, shown by its status —
 *   - QUEUED / RUNNING: the Running card, with a link to the newest solved run.
 *     The set layout polls while a run moves and reloads every loader once it
 *     ends, so this page turns into Results or Can't solve by itself.
 *   - SOLVED: the runline (Compare with, Create teams…), then Results: the
 *     changes not run yet, tiles, identity line, team cards, and the why panel
 *     with its pin block. While a create from this run runs, or after it
 *     FAILED, its progress card comes first; after a failure the card's Retry
 *     is the way on, so Create teams… is not offered. When the create
 *     finishes, the set layout moves the page to the Created summary. After a
 *     Discard, the service's notes on what the restored setup left out show
 *     under the runline.
 *   - INFEASIBLE: Can't solve (its own runline, the conflicts, the summary).
 *   - FAILED / CANCELED: the runline and the run error's sentence.
 *
 * Every write posts to the set layout's action through `useSetFetcher`; this
 * route has no action. The run's own part is keyed by the run number, so its
 * fetchers — and with them a "Show which" answer, a preview, a refusal — start
 * empty on every run.
 */

export const loader = (args: TeamsRouteArgs) => loadRunPage(args);

export const headers = teamsHeaders;

const SECONDARY_BUTTON =
  'rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800';

export default function TeamSetRunPage() {
  const page = useLoaderData() as RunPageData;
  const layout = useTeamSetLayoutData();
  const navigate = useNavigate();
  // Marks the live page for tests: a click before hydration reaches no handler.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (!layout) return null;
  const { paths } = layout;

  return (
    <div
      data-testid="run-page"
      data-hydrated={hydrated ? 'true' : 'false'}
      className="grid items-start gap-4 lg:grid-cols-[188px_minmax(0,1fr)] lg:gap-6"
    >
      <RunList
        runs={page.runs}
        selected={page.run.number}
        hrefFor={number => runPath(paths, number)}
        onSelect={number => navigate(runPath(paths, number))}
      />
      <div className="min-w-0">
        <RunBody key={page.run.number} page={page} layout={layout} />
      </div>
    </div>
  );
}

interface RunBodyProps {
  page: RunPageData;
  layout: TeamSetLayoutData;
}

function RunBody({ page, layout }: RunBodyProps) {
  const { run } = page;
  const viewerId = layout.viewer.userId;

  switch (run.status) {
    case 'QUEUED':
    case 'RUNNING':
      return (
        <RunningCard run={run} viewerId={viewerId}>
          {page.lastSolvedRun !== null && page.lastSolvedRun !== run.number ? (
            <Link
              to={runPath(layout.paths, page.lastSolvedRun)}
              data-testid="run-show-last-solved"
              className={SECONDARY_BUTTON}
            >
              {showRunText(page.lastSolvedRun)}
            </Link>
          ) : null}
        </RunningCard>
      );
    case 'SOLVED':
      return <SolvedRun page={page} layout={layout} />;
    case 'INFEASIBLE':
      return <CantSolveView run={run} viewerId={viewerId} setupPath={layout.paths.set} />;
    case 'FAILED':
    case 'CANCELED':
      return (
        <div className="grid gap-3">
          <Runline run={run} />
          <p
            data-testid="run-error"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
          >
            {runErrorSentence(run.error, run.status)}
          </p>
        </div>
      );
  }
}

// ─── Results ────────────────────────────────────────────────────────────────

/**
 * A refusal as the page shows it: the action's sentence, then what it lists —
 * the checks that stop a run (with the people each names), else the items the
 * error names. null when the answer isn't a refusal.
 */
function refusalOf(data: SetActionData | undefined): CreateFlowError | null {
  if (!data?.error) return null;
  const blocking = (data.issues ?? []).filter(line => line.level === 'error');
  const items = blocking.length > 0 ? blocking.map(checkLineText) : (data.errorItems ?? []);
  return { message: data.error, ...(items.length > 0 ? { items } : {}) };
}

function SolvedRun({ page, layout }: RunBodyProps) {
  const { run } = page;
  const { paths } = layout;
  const viewerId = layout.viewer.userId;
  const navigate = useNavigate();
  const blockedId = useId();

  // One fetcher per concern, so each answer lands where it was asked.
  const pins = useSetFetcher();
  const changes = useSetFetcher();
  const reveal = useSetFetcher();
  const preview = useSetFetcher();
  const create = useSetFetcher();
  const retry = useSetFetcher();

  // "Show which": the teams the identity rule missed on, as the action answered.
  const missedTeams =
    reveal.data?.intent === 'reveal-identity' && reveal.data.missedTeams
      ? reveal.data.missedTeams
      : null;

  // Discard asks first; focus goes back to what opened the question (the
  // dialog is ConfirmDialog, which doesn't do that itself). The opener is
  // taken in the click, before the dialog moves focus to its Cancel.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const discardOpener = useRef<HTMLElement | null>(null);
  const closeDiscard = useCallback(() => setConfirmingDiscard(false), []);
  const openDiscard = () => {
    discardOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmingDiscard(true);
  };
  useEffect(() => {
    if (confirmingDiscard) return;
    const opener = discardOpener.current;
    discardOpener.current = null;
    if (opener?.isConnected) opener.focus();
  }, [confirmingDiscard]);

  // Create: the dialog asks for a preview each time it opens, and doesn't show
  // again a create refusal from an earlier opening.
  const [creating, setCreating] = useState(false);
  const [dismissedCreate, setDismissedCreate] = useState<SetActionData | undefined>(undefined);
  const closeCreate = useCallback(() => setCreating(false), []);
  const openCreate = () => {
    setDismissedCreate(create.data);
    setCreating(true);
    preview.post('preview-create', { runNumber: run.number });
  };
  useEffect(() => {
    if (create.data?.intent === 'create' && create.data.ok) setCreating(false);
  }, [create.data]);

  const previewPending = preview.fetcher.state === 'submitting';
  const previewView =
    !previewPending &&
    preview.data?.intent === 'preview-create' &&
    preview.data.preview?.run_number === run.number
      ? preview.data.preview
      : null;
  const createError =
    (create.data !== dismissedCreate ? refusalOf(create.data) : null) ??
    (previewPending ? null : refusalOf(preview.data));

  const blocked = createBlockedText(page.create);
  const compareTargets = page.runs
    .filter(item => item.status === 'SOLVED' && item.number !== run.number)
    .sort((a, b) => b.number - a.number);

  // A create from this run, team by team: the rows the layout loaded, with the
  // layout poll's latest states over them between reloads (the layout polls
  // while the create runs).
  const setCreate = layout.create;
  const showCreating =
    setCreate !== null &&
    setCreate.run_number === run.number &&
    (setCreate.status === 'RUNNING' || setCreate.status === 'FAILED');
  const live = useSetLiveStatus();
  const progress = showCreating ? liveCreate(setCreate, live?.create ?? null) : null;
  // A create from this run failed: Retry (on its card) is the way on, and a
  // Create dialog left open when it failed closes.
  const createFailedHere = progress?.status === 'FAILED';
  useEffect(() => {
    if (createFailedHere) setCreating(false);
  }, [createFailedHere]);

  const refusals = [pins.data, changes.data, reveal.data]
    .map(refusalOf)
    .filter((error): error is CreateFlowError => error !== null);
  // After a Discard: what the run's setup had that the restore left out.
  const discardNotes =
    changes.data?.intent === 'discard' && changes.data.ok ? (changes.data.notes ?? []) : [];

  return (
    <div className="grid gap-4">
      {progress ? (
        <CreatingProgress
          create={progress}
          viewerId={viewerId}
          isOwner={layout.viewer.isOwner}
          busy={retry.busy}
          error={refusalOf(retry.data)}
          onRetry={() => retry.post('retry-create')}
        />
      ) : null}

      <Runline run={run}>
        {compareTargets.length > 0 ? (
          <select
            aria-label={TEAMS_LABELS.compareWith}
            data-testid="run-compare-with"
            value=""
            onChange={event => {
              const other = Number(event.target.value);
              if (Number.isInteger(other) && other > 0) {
                navigate(comparePath(paths, run.number, other));
              }
            }}
            className="max-w-full rounded-lg border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm text-gray-700 hover:border-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-gray-500"
          >
            <option value="" disabled>
              {TEAMS_LABELS.compareWith}
            </option>
            {compareTargets.map(item => (
              <option key={item.number} value={item.number}>
                {runTitle(item.number)}
              </option>
            ))}
          </select>
        ) : null}
        {createFailedHere ? null : (
          <>
            <button
              type="button"
              data-testid="run-create"
              disabled={blocked !== null}
              aria-describedby={blocked ? blockedId : undefined}
              onClick={openCreate}
              className="rounded-lg bg-gray-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              {TEAMS_LABELS.createTeams}
            </button>
            {blocked ? (
              <span
                id={blockedId}
                data-testid="run-create-blocked"
                className="basis-full text-right text-xs text-gray-500 dark:text-gray-400"
              >
                {blocked}
              </span>
            ) : null}
          </>
        )}
      </Runline>

      {refusals.map((error, index) => (
        <ActionErrorNote key={`${index}-${error.message}`} error={error} />
      ))}

      {discardNotes.length > 0 ? (
        <div
          role="status"
          data-testid="discard-notes"
          className="grid gap-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
        >
          {discardNotes.map((note, index) => (
            <p key={`${index}-${note}`} className="m-0">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      <ResultsView
        run={run}
        placements={page.placements}
        pinTargets={page.pinTargets}
        changes={layout.changes}
        viewerId={viewerId}
        locked={layout.set.locked}
        missedTeams={missedTeams}
        revealing={reveal.fetcher.state === 'submitting'}
        onShowWhich={() => reveal.post('reveal-identity', { runNumber: run.number })}
        onAddPin={(pin: TeamSetPinAdd) => pins.post('patch', { patch: { pins: { add: [pin] } } })}
        pinBusy={pins.busy}
        onDiscard={openDiscard}
        onRunAgain={() => changes.post('run')}
        changesBusy={changes.busy}
        runDisabled={layout.activeRun !== null}
      />

      <ConfirmDialog
        open={confirmingDiscard}
        title={changesNotRunText(layout.changes.items.length)}
        body={layout.changes.items.map(item => item.text)}
        confirmLabel={TEAMS_LABELS.discard}
        cancelLabel={TEAMS_LABELS.cancel}
        variant="danger"
        busy={changes.busy}
        onConfirm={() => {
          setConfirmingDiscard(false);
          changes.post('discard');
        }}
        onCancel={closeDiscard}
      />

      <CreateDialog
        open={creating && !createFailedHere}
        run={run}
        preview={previewView}
        availability={page.create}
        busy={create.busy}
        error={createError}
        githubTeamsLocked={layout.githubTeamsLocked}
        onCreate={({ githubTeams }) =>
          create.post('create', { runNumber: run.number, githubTeams })
        }
        onCancel={closeCreate}
      />
    </div>
  );
}
