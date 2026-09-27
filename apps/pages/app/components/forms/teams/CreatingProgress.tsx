import { useId } from 'react';
import { IconCheck, IconLoader2, IconX } from '@tabler/icons-react';

import { createFailureSentence, memberFailureSentence, teamsErrorSentence } from './teamsErrors.ts';
import {
  SET_STATUS_LABELS,
  TEAMS_LABELS,
  createRetryText,
  createStartedText,
  createTeamRowText,
  personName,
  renamedText,
} from './teamsView.ts';
import type {
  CreateProgressView,
  CreateTeamProgress,
  TeamSetCreateStatus,
  TeamSetStatus,
} from './types.ts';

/**
 * Team sets — the Creating card: one row per team while a create runs, and
 * what failed once it stops.
 *
 * Presentational: renders a `CreateProgressView` (the layout's, or the status
 * poll's between revalidations) and calls `onRetry`; the set page posts
 * `retry-create` through `useSetFetcher`. The counts line ("3 of 5 teams done
 * · 18 of 24 members added") is the layout's Creating banner, so this card
 * does not repeat it.
 *
 * Every string is a teamsView template, a teamsErrors sentence, a team name or
 * a person's name. A failed create says, beside Retry, how many of its teams
 * were made ("2 of 5 teams already created."): a retry keeps them. `failures` overlap the rows: a failed row already says its
 * reason, so a failure is attached to its team's row and only what the row
 * does not say (another reason, the members) is added under it. A failure of
 * the whole create (`team: '*'`) and one for a team without a row are listed
 * under the rows.
 *
 * Also exports the create flow's shared pieces (`CreateFailureList`,
 * `ActionErrorNote`, `createStatusKind`), which CreateDialog and CreatedSummary
 * use.
 */

/** A refusal the set action returned: its sentence (teamsErrors) and the list it names. */
export interface CreateFlowError {
  message: string;
  items?: readonly string[];
}

/** The set status a claimed create's status reads as (`setStatus` in team-set-explain). */
export function createStatusKind(status: TeamSetCreateStatus): TeamSetStatus {
  switch (status) {
    case 'RUNNING':
      return 'creating';
    case 'DONE':
      return 'created';
    case 'PARTIAL':
      return 'partial';
    case 'FAILED':
      return 'create_failed';
  }
}

type CreateFailure = CreateProgressView['failures'][number];
type MemberFailure = NonNullable<CreateFailure['members']>[number];

/**
 * A create's failures, split into the ones a team row shows (by team name) and
 * the rest: the whole create's (`'*'`) and any for a team without a row.
 */
export function splitCreateFailures(create: Pick<CreateProgressView, 'teams' | 'failures'>): {
  byTeam: Map<string, CreateFailure[]>;
  rest: CreateFailure[];
} {
  const rowNames = new Set(create.teams.map(team => team.name));
  const byTeam = new Map<string, CreateFailure[]>();
  const rest: CreateFailure[] = [];
  for (const failure of create.failures) {
    if (failure.team !== '*' && rowNames.has(failure.team)) {
      byTeam.set(failure.team, [...(byTeam.get(failure.team) ?? []), failure]);
    } else {
      rest.push(failure);
    }
  }
  return { byTeam, rest };
}

/** The refusal banner the create flow shows under its buttons. */
export function ActionErrorNote({ error }: { error: CreateFlowError }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
    >
      <p>{error.message}</p>
      {error.items && error.items.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {error.items.map((item, index) => (
            <li key={`${index}:${item}`} className="break-all">
              {item}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One person who wasn't added: name, GitHub login when known, the reason. */
function MemberFailureLines({ members }: { members: readonly MemberFailure[] }) {
  if (members.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {members.map(member => (
        <li
          key={`${member.user_id}:${member.reason}`}
          className="text-xs text-red-700 dark:text-red-300"
        >
          <span className="font-medium">{personName(member)}</span>
          {member.login ? (
            <span className="font-mono text-red-600 dark:text-red-400"> {member.login}</span>
          ) : null}
          <span> · {memberFailureSentence(member.reason)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Failures as a list: the team's name (none for the whole create), the
 * reason, and the members who weren't added. CreatedSummary lists a partial
 * create's failures with it; this card lists the ones no row shows.
 */
export function CreateFailureList({ failures }: { failures: readonly CreateFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <ul className="space-y-2">
      {failures.map((failure, index) => (
        <li
          key={`${failure.team}:${failure.reason}:${index}`}
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950/40"
        >
          <p className="text-sm text-red-800 dark:text-red-200">
            {failure.team !== '*' ? (
              <>
                <span className="break-all font-mono text-[13px]">{failure.team}</span>
                <span> · </span>
              </>
            ) : null}
            {createFailureSentence(failure.reason)}
          </p>
          <MemberFailureLines members={failure.members ?? []} />
        </li>
      ))}
    </ul>
  );
}

/** The row's marker: a check when done, a spinner while live, its number while queued, a cross when failed. */
function RowMarker({ team }: { team: CreateTeamProgress }) {
  const base =
    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums';
  switch (team.state) {
    case 'done':
      return (
        <span
          aria-hidden="true"
          className={`${base} bg-emerald-600 text-white dark:bg-emerald-500`}
        >
          <IconCheck size={12} stroke={3} />
        </span>
      );
    case 'live':
      return (
        <span
          aria-hidden="true"
          className={`${base} border border-blue-500 text-blue-600 ring-4 ring-blue-100 dark:text-blue-400 dark:ring-blue-950`}
        >
          <IconLoader2 size={12} className="motion-safe:animate-spin" />
        </span>
      );
    case 'queued':
      return (
        <span
          aria-hidden="true"
          className={`${base} border border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400`}
        >
          {team.n}
        </span>
      );
    case 'failed':
      return (
        <span aria-hidden="true" className={`${base} bg-red-600 text-white dark:bg-red-500`}>
          <IconX size={12} stroke={3} />
        </span>
      );
  }
}

function TeamRow({
  team,
  failures,
}: {
  team: CreateTeamProgress;
  failures: readonly CreateFailure[];
}) {
  const rowText = createTeamRowText(team);
  // The row already says its own reason; add only what it doesn't.
  const extra = failures
    .map(failure => createFailureSentence(failure.reason))
    .filter((sentence, index, all) => sentence !== rowText && all.indexOf(sentence) === index);
  const members = failures.flatMap(failure => failure.members ?? []);
  return (
    <li className="flex gap-3 px-4 py-3" data-state={team.state}>
      <RowMarker team={team} />
      <div className="min-w-0 flex-1">
        <div className="break-all font-mono text-[13px] text-gray-900 dark:text-white">
          {team.name}
        </div>
        <div
          className={`text-xs ${
            team.state === 'failed'
              ? 'text-red-700 dark:text-red-300'
              : 'text-gray-500 dark:text-gray-400'
          }`}
        >
          {rowText}
        </div>
        {extra.map(sentence => (
          <div key={sentence} className="text-xs text-red-700 dark:text-red-300">
            {sentence}
          </div>
        ))}
        <MemberFailureLines members={members} />
      </div>
    </li>
  );
}

export interface CreatingProgressProps {
  /** The create as the layout loaded it, or as the status poll last reported it. */
  create: CreateProgressView;
  /** The viewer's user id ("started by you"). */
  viewerId: string;
  /** Only owners retry; teachers see Retry disabled. */
  isOwner: boolean;
  /** A retry post is in flight. */
  busy?: boolean;
  /** The retry's refusal, if the action returned one. */
  error?: CreateFlowError | null;
  /** Resume the create (the set page posts `retry-create`). Enabled only after it FAILED. */
  onRetry: () => void;
}

export function CreatingProgress({
  create,
  viewerId,
  isOwner,
  busy = false,
  error = null,
  onRetry,
}: CreatingProgressProps) {
  const failed = create.status === 'FAILED';
  const { byTeam, rest } = splitCreateFailures(create);
  const canRetry = failed && isOwner && !busy;
  const ownerNote = failed && !isOwner ? teamsErrorSentence('owner_only') : null;
  // What a retry keeps: the teams the failed attempt made.
  const kept =
    failed && create.counts.teams_created > 0
      ? createRetryText(
          { attempt: create.attempt + 1, teams_already_created: create.counts.teams_created },
          create.total
        )
      : null;
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={create.status === 'RUNNING'}
      className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h2 id={titleId} className="text-sm font-semibold text-gray-900 dark:text-white">
          {SET_STATUS_LABELS[createStatusKind(create.status)]}
        </h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {createStartedText(create, viewerId)}
        </span>
      </div>

      {create.teams.length > 0 ? (
        <ol className="divide-y divide-gray-100 dark:divide-gray-800">
          {create.teams.map(team => (
            <TeamRow key={team.n} team={team} failures={byTeam.get(team.name) ?? []} />
          ))}
        </ol>
      ) : null}

      <div className="space-y-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700">
        {create.renamed.map(renamed => (
          <p
            key={renamed.n}
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {renamedText(renamed)}
          </p>
        ))}
        <CreateFailureList failures={rest} />
        {error ? <ActionErrorNote error={error} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            disabled={!canRetry}
            aria-busy={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {busy ? (
              <IconLoader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />
            ) : null}
            {TEAMS_LABELS.retry}
          </button>
          {kept ? (
            <span
              data-testid="create-retry-kept"
              className="text-xs text-gray-500 dark:text-gray-400"
            >
              {kept}
            </span>
          ) : null}
          {ownerNote ? (
            <span className="text-xs text-gray-500 dark:text-gray-400">{ownerNote}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
