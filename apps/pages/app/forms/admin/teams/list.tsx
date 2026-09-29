import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useFetcher, useLoaderData } from 'react-router';
import dayjs from 'dayjs';

import { BackToClassroom } from '~/components/forms/BackToClassroom.tsx';
import { FormAdminTabs } from '~/components/forms/FormAdminTabs.tsx';
import { NewSetDialog } from '~/components/forms/teams/NewSetDialog.tsx';
import { teamsErrorSentence } from '~/components/forms/teams/teamsErrors.ts';
import {
  FORM_NOT_PUBLISHED_TEXT,
  SET_STATUS_TONES,
  TEAMS_LABELS,
  isRunActive,
  listEmptyText,
  listLatestRunText,
  setStatusChipText,
  shownSetStatus,
  teamSetPaths,
  teamSetsListPath,
} from '~/components/forms/teams/teamsView.ts';
import type { TeamSetListData, TeamSetListRow } from '~/components/forms/teams/types.ts';

import {
  listAction,
  loadTeamSetList,
  teamsHeaders,
  type ListActionData,
  type TeamsRouteArgs,
} from './teamsData.server.ts';

/**
 * A form's team sets: `/:classroomSlug/forms/:formSlug/teams`.
 *
 * The forms admin chrome (back link, breadcrumb Forms / {form} / Teams, the
 * Edit · Responses · Teams switcher), then the sets: name (a link to the set),
 * status chip, the latest run and when the set last changed, most recently
 * changed first. "New team set" opens NewSetDialog on the suggested name and
 * posts `new-set` to this route's action, which redirects to the new set's
 * Setup; a refusal (a name another set has: `name_taken`) shows in the
 * dialog. The status chip carries the facts the row has: "Setting up · Run 5
 * running", "Creating teams · 3 of 5", "Created 12 Sep · from run 4".
 *
 * What the form allows, as fact lines in place of what it can't have:
 *   - PUBLIC: no sets and no New team set (its respondents aren't a roster).
 *   - CLASSROOM, unpublished: New team set is disabled; any sets are listed.
 *
 * The gate, the data and the `new-set` intent live in teamsData.server.ts
 * (`loadTeamSetList`, `listAction`); only types come from it here. Dates are
 * formatted after mount, in the browser's zone (the builder's reason: the
 * server's zone isn't the reader's, and formatting during render is a
 * hydration mismatch).
 */

export const loader = (args: TeamsRouteArgs) => loadTeamSetList(args);

export const action = (args: TeamsRouteArgs) => listAction(args);

export const headers = teamsHeaders;

/** "12 Sep": the status chip's created date and the Updated column. */
const SHORT_DATE = 'D MMM';

const TH =
  'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';

/** An ISO time as "12 Sep", once mounted; null before, and for no time. */
function useShortDate(iso: string | null | undefined): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const parsed = iso ? dayjs(iso) : null;
    setText(parsed?.isValid() ? parsed.format(SHORT_DATE) : null);
  }, [iso]);
  return text;
}

export default function TeamSetsList() {
  const { classroom, backUrl, form, sets, suggestedName } = useLoaderData() as TeamSetListData;
  const classroomForm = form.access === 'CLASSROOM';
  const canStart = classroomForm && form.published;
  const listPath = teamSetsListPath(classroom.slug, form.slug);
  const factId = useId();

  // Most recently changed first (the service lists oldest first).
  const rows = [...sets].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const fetcher = useFetcher<ListActionData>();
  const { submit: submitFetcher } = fetcher;
  const [open, setOpen] = useState(false);
  // A fetcher keeps its last answer: only a refusal to a post made since this
  // opening is shown.
  const [posted, setPosted] = useState(false);
  const busy = fetcher.state !== 'idle';
  const refusal = posted && !busy && fetcher.data?.error ? fetcher.data : null;

  const close = useCallback(() => setOpen(false), []);
  const submit = useCallback(
    (name: string) => {
      setPosted(true);
      void submitFetcher(
        { intent: 'new-set', ...(name ? { name } : {}) },
        { method: 'post', encType: 'application/json', action: listPath }
      );
    },
    [submitFetcher, listPath]
  );

  const fact = !classroomForm
    ? teamsErrorSentence('form_not_classroom')
    : !form.published
      ? FORM_NOT_PUBLISHED_TEXT
      : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6 min-w-0">
        <BackToClassroom href={backUrl} name={classroom.name} />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 text-base font-semibold text-gray-600 dark:text-gray-400">
            <Link
              to={`/${classroom.slug}/forms`}
              className="hover:text-gray-900 dark:hover:text-white"
            >
              {TEAMS_LABELS.forms}
            </Link>
            <Separator />
            <Link
              to={`/${classroom.slug}/forms/${form.slug}/edit`}
              className="text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
            >
              {form.title}
            </Link>
            <Separator />
            {TEAMS_LABELS.teams}
          </h1>
          <FormAdminTabs
            classroomSlug={classroom.slug}
            formSlug={form.slug}
            access={form.access}
            active="teams"
            responses={form.responsesSubmitted}
          />
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          {TEAMS_LABELS.teamSets}
        </h2>
        {classroomForm ? (
          <button
            type="button"
            data-testid="team-sets-new"
            disabled={!canStart}
            aria-describedby={fact ? factId : undefined}
            onClick={() => {
              setPosted(false);
              setOpen(true);
            }}
            className="rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            {TEAMS_LABELS.newTeamSet}
          </button>
        ) : null}
      </div>

      {fact ? (
        <p
          id={factId}
          data-testid="team-sets-fact"
          className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
        >
          {fact}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <SetsTable rows={rows} classroomSlug={classroom.slug} formSlug={form.slug} />
      ) : canStart ? (
        <div
          data-testid="team-sets-empty"
          className="rounded-lg border border-dashed border-gray-300 py-12 text-center dark:border-gray-700"
        >
          <div className="font-medium text-gray-700 dark:text-gray-200">
            {TEAMS_LABELS.noTeamSets}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {listEmptyText(form.responsesSubmitted)}
          </div>
        </div>
      ) : null}

      <NewSetDialog
        open={open}
        defaultName={suggestedName}
        busy={busy}
        error={refusal ? { message: refusal.error } : null}
        onSubmit={submit}
        onCancel={close}
      />
    </div>
  );
}

function Separator() {
  return <span className="mx-1.5 text-gray-300 dark:text-gray-600">/</span>;
}

function SetsTable({
  rows,
  classroomSlug,
  formSlug,
}: {
  rows: TeamSetListRow[];
  classroomSlug: string;
  formSlug: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full" data-testid="team-sets-table">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th scope="col" className={TH}>
              {TEAMS_LABELS.setColumn}
            </th>
            <th scope="col" className={TH}>
              {TEAMS_LABELS.statusColumn}
            </th>
            <th scope="col" className={TH}>
              {TEAMS_LABELS.latestRunColumn}
            </th>
            <th scope="col" className={TH}>
              {TEAMS_LABELS.updatedColumn}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map(row => (
            <SetRow key={row.id} row={row} classroomSlug={classroomSlug} formSlug={formSlug} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SetRow({
  row,
  classroomSlug,
  formSlug,
}: {
  row: TeamSetListRow;
  classroomSlug: string;
  formSlug: string;
}) {
  const createdOn = useShortDate(row.created?.finished_at);
  const updatedOn = useShortDate(row.updated_at);
  const href = teamSetPaths({ classroomSlug, formSlug, setName: row.name }).set;
  const latest = row.latest_run;
  const progress = row.create_progress;
  const activeRun =
    latest && isRunActive(latest.status)
      ? { number: latest.number, status: latest.status as 'QUEUED' | 'RUNNING' }
      : null;
  // `created` is set once teams exist, and a failed create that made some
  // locks the set (shownSetStatus).
  const status = shownSetStatus(row.status, { locked: row.created !== null, activeRun });
  const chip = setStatusChipText(status, {
    runCount: row.run_count,
    activeRun,
    creating: progress ? { done: progress.done, total: progress.total } : null,
    createRun: row.created?.run_number ?? progress?.run_number ?? null,
    createdOn,
  });

  return (
    <tr
      data-testid="team-sets-row"
      data-set={row.name}
      data-status={row.status}
      className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
    >
      <td className="px-4 py-3">
        <Link
          to={href}
          className="break-all font-mono text-sm font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
        >
          {row.name}
        </Link>
      </td>
      <td className="px-4 py-3">
        <span
          data-testid="team-sets-status"
          className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${SET_STATUS_TONES[status]}`}
        >
          {chip}
        </span>
      </td>
      <td
        data-testid="team-sets-latest"
        className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300"
      >
        {listLatestRunText(row)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        <time dateTime={row.updated_at}>{updatedOn}</time>
      </td>
    </tr>
  );
}
