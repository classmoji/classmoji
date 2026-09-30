import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLoaderData, useLocation, useRevalidator } from 'react-router';

import { ChecksList } from '~/components/forms/teams/ChecksList.tsx';
import { CreatedSummary } from '~/components/forms/teams/CreatedSummary.tsx';
import { CreatedTeamsList, createdTeamCards } from '~/components/forms/teams/CreatedTeamsList.tsx';
import {
  ActionErrorNote,
  CreatingProgress,
  type CreateFlowError,
} from '~/components/forms/teams/CreatingProgress.tsx';
import { NewSetDialog } from '~/components/forms/teams/NewSetDialog.tsx';
import { NonRespondentsCard } from '~/components/forms/teams/NonRespondentsCard.tsx';
import { PinsCard } from '~/components/forms/teams/PinsCard.tsx';
import { ProjectsTable } from '~/components/forms/teams/ProjectsTable.tsx';
import {
  QuestionRow,
  priorityTargets,
  type QuestionRowProps,
} from '~/components/forms/teams/QuestionRow.tsx';
import { QuestionsCard } from '~/components/forms/teams/QuestionsCard.tsx';
import { ReadinessStrip } from '~/components/forms/teams/ReadinessStrip.tsx';
import { TeamShapeCard } from '~/components/forms/teams/TeamShapeCard.tsx';
import {
  PAIRS_IDENTITY_NOTE,
  PROJECTS_FOOTNOTE,
  TEAMS_LABELS,
  createLeadsSet,
  liveCreate,
  nonRespondentModeNotes,
} from '~/components/forms/teams/teamsView.ts';
import type {
  CheckLine,
  CreateProgressView,
  SetActionData,
  SetupPageData,
  SetupQuestion,
  TeamSetConfigPatchInput,
} from '~/components/forms/teams/types.ts';
import {
  useSetFetcher,
  useSetLiveStatus,
  useTeamSetLayoutData,
} from '~/components/forms/teams/useSetFetcher.ts';

import { loadSetupPage, teamsHeaders, type TeamsRouteArgs } from './teamsData.server.ts';

/**
 * A team set's Setup tab: the set layout's index (the set's landing).
 *
 * Readiness, then the Questions card (a row per question: job, strength,
 * weight, Must sentence, the identity block, the Shifts priority controls)
 * beside Team shape, People who didn't answer, Pins and the checks, then the
 * Projects table when the teams are made from a question. The header's Run
 * button (the layout's) runs this setup.
 *
 * Every control autosaves: it posts one `intent: 'patch'` through
 * `useSetFetcher()` (which targets the LAYOUT's action; this route has none),
 * and the revalidation that follows brings the saved setup, the checks and
 * the header's "changes since run n" back. Each card and each question row
 * has its own fetcher, so a save in one never cancels a save in another, and
 * a refused save shows its sentence under the card or row it came from.
 * "Check again" re-reads the page's data (the checks are the loader's).
 *
 * A link to `#q-…`, `#opt-…`, `#pin-…`, `#nr` or `#shape` (Can't solve's
 * "Change in …") scrolls to that row and marks it `data-highlight="true"`
 * (a ring, no text) until the hash changes.
 *
 * While teams are being made, or after a create FAILED, the page opens on
 * the create's progress card (team by team, with Retry for owners once it
 * failed), so a failed create is found where the set is. A failed create that
 * made no team (the set is free again) leads until a run is solved after it;
 * from then on its card is on its own run's page (`createLeadsSet`). Once
 * teams were created (status created or partial) it opens on the Created
 * summary and the teams. Every control below is read-only while the set is
 * locked, from the moment a create is claimed.
 */

export const loader = (args: TeamsRouteArgs) => loadSetupPage(args);

/** `no-store` on every response of a set page (see teamsHeaders). */
export const headers = teamsHeaders;

// ─── Saving ─────────────────────────────────────────────────────────────────

interface Patcher {
  onPatch: (patch: TeamSetConfigPatchInput) => void;
  /** The refusal of the last save; a new object per answer, null after a save that worked. */
  error: CreateFlowError | null;
}

/** An action's refusal as the error note shows it; null when `intent` isn't the one asked about. */
function refusalOf(data: SetActionData | undefined, intent: SetActionData['intent']) {
  if (!data || data.intent !== intent || !data.error) return null;
  const refusal: CreateFlowError = data.errorItems?.length
    ? { message: data.error, items: data.errorItems }
    : { message: data.error };
  return refusal;
}

/** A fetcher of its own for one card or row, posting `intent: 'patch'`. */
function usePatcher(): Patcher {
  const { post, data } = useSetFetcher();
  const error = useMemo(() => refusalOf(data, 'patch'), [data]);
  const onPatch = useCallback(
    (patch: TeamSetConfigPatchInput) => {
      void post('patch', { patch });
    },
    [post]
  );
  return { onPatch, error };
}

/** Renders a card with its own patcher, and the refusal of its last save under it. */
function Saving({ children }: { children: (onPatch: Patcher['onPatch']) => ReactNode }) {
  const { onPatch, error } = usePatcher();
  return (
    <div className="space-y-2">
      {children(onPatch)}
      {error ? <ActionErrorNote error={error} /> : null}
    </div>
  );
}

// ─── Hash deep links ────────────────────────────────────────────────────────

/**
 * Scroll to the element the URL's hash names and mark it
 * `data-highlight="true"` (every Setup row and card styles that as a ring),
 * clearing it when the hash changes. An effect, not CSS `:target`, which does
 * not follow client-side navigation.
 */
function useHashHighlight() {
  const { hash } = useLocation();
  useEffect(() => {
    let id = hash.replace(/^#/, '');
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape: look the raw text up.
    }
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.setAttribute('data-highlight', 'true');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    return () => target.removeAttribute('data-highlight');
  }, [hash]);
}

// ─── Question rows ──────────────────────────────────────────────────────────

/** Checks the identity block shows: its rule's single-answer and teams-of-two lines. */
const IDENTITY_CHECK_CODES: ReadonlySet<string> = new Set([
  'identity_single_answer',
  'identity_rule_pairs',
]);

function identityChecksFor(checks: readonly CheckLine[], fieldId: string): CheckLine[] {
  return checks.filter(
    check =>
      IDENTITY_CHECK_CODES.has(check.code) &&
      (check.srcs ?? []).some(src => src.startsWith(`${fieldId}:`))
  );
}

function SavingQuestionRow(props: Omit<QuestionRowProps, 'onPatch' | 'error'>) {
  const { onPatch, error } = usePatcher();
  return <QuestionRow {...props} onPatch={onPatch} error={error} />;
}

// ─── Created landing ────────────────────────────────────────────────────────

function isFinished(create: CreateProgressView | null): create is CreateProgressView {
  return create?.status === 'DONE' || create?.status === 'PARTIAL';
}

/** The Created summary, the teams, and "Start a new set from this setup" (a name dialog). */
function CreatedLanding({
  create,
  data,
  viewerId,
}: {
  create: CreateProgressView;
  data: SetupPageData;
  viewerId: string;
}) {
  const { post, busy, data: answer } = useSetFetcher();
  const [naming, setNaming] = useState(false);
  const refusal = refusalOf(answer, 'new-set-from-setup');
  const onCancel = useCallback(() => setNaming(false), []);

  return (
    <div data-testid="setup-created" className="mb-6">
      <CreatedSummary
        create={create}
        viewerId={viewerId}
        links={data.createdLinks ?? { teamsUrl: null, assignmentUrl: null }}
        onStartNewSet={() => setNaming(true)}
        busy={busy}
      />
      <CreatedTeamsList teams={createdTeamCards(data.createdTeams, create)} />
      <NewSetDialog
        open={naming}
        defaultName=""
        title={TEAMS_LABELS.startNewSet}
        busy={busy}
        error={refusal}
        onSubmit={name => {
          void post('new-set-from-setup', name ? { name } : {});
        }}
        onCancel={onCancel}
      />
    </div>
  );
}

// ─── A create under way, or failed ──────────────────────────────────────────

/**
 * The create's card while it runs or after it FAILED: the loaded create with
 * the status poll's latest states over it between reloads (the layout's poll,
 * through the Outlet), and Retry, which posts `retry-create` (owners only; the
 * card says so to others).
 */
function CreateProgressLanding({
  create,
  viewerId,
  isOwner,
}: {
  create: CreateProgressView;
  viewerId: string;
  isOwner: boolean;
}) {
  const retry = useSetFetcher();
  const live = useSetLiveStatus();
  const shown = liveCreate(create, live?.create ?? null);
  return (
    <div data-testid="setup-create-progress" className="mb-6">
      <CreatingProgress
        create={shown}
        viewerId={viewerId}
        isOwner={isOwner}
        busy={retry.busy}
        error={refusalOf(retry.data, 'retry-create')}
        onRetry={() => {
          void retry.post('retry-create');
        }}
      />
    </div>
  );
}

// ─── The page ───────────────────────────────────────────────────────────────

export default function TeamSetSetup() {
  const data = useLoaderData() as SetupPageData;
  const { setup } = data;
  const layout = useTeamSetLayoutData();
  const revalidator = useRevalidator();
  useHashHighlight();
  // The fill page's marker: "true" once the page is live (clicks before it reach no handler).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const viewerId = layout?.viewer.userId ?? '';
  const locked = setup.set.locked;
  const config = setup.set.config;
  const grouped = setup.grouping.mode === 'by_option';
  // The set's create, while it leads the set (a failed one stops leading once
  // a run is solved after it).
  const loadedCreate = layout?.create ?? null;
  const create =
    layout &&
    createLeadsSet(loadedCreate, {
      locked: layout.set.locked,
      latestSolvedAt: layout.latestSolvedAt,
    })
      ? loadedCreate
      : null;
  const created = setup.set.status === 'created' || setup.set.status === 'partial';
  const notesHref = layout ? `/${layout.classroom.slug}/forms/${layout.form.slug}/responses` : null;
  const targets = useMemo(() => priorityTargets(setup.questions), [setup.questions]);

  const renderRow = (question: SetupQuestion) => (
    <SavingQuestionRow
      question={question}
      grouping={grouped && setup.grouping.field_id === question.field_id}
      priorityTargets={targets}
      checks={identityChecksFor(setup.checks, question.field_id)}
      notesHref={notesHref}
      locked={locked}
    />
  );

  return (
    <div data-testid="setup-page" data-hydrated={hydrated ? 'true' : 'false'}>
      {created && isFinished(create) ? (
        <CreatedLanding create={create} data={data} viewerId={viewerId} />
      ) : create && (create.status === 'RUNNING' || create.status === 'FAILED') ? (
        <CreateProgressLanding
          create={create}
          viewerId={viewerId}
          isOwner={layout?.viewer.isOwner ?? false}
        />
      ) : null}

      <ReadinessStrip readiness={setup.readiness} />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <QuestionsCard questions={setup.questions} renderRow={renderRow} />

        <div className="space-y-5">
          <Saving>
            {onPatch => (
              <TeamShapeCard
                config={config}
                shape={setup.shape}
                questions={setup.questions}
                options={setup.options}
                locked={locked}
                onPatch={onPatch}
                pairsNote={PAIRS_IDENTITY_NOTE}
              />
            )}
          </Saving>
          <Saving>
            {onPatch => (
              <NonRespondentsCard
                nonRespondents={setup.non_respondents}
                roster={setup.readiness.roster}
                locked={locked}
                onPatch={onPatch}
                modeNotes={nonRespondentModeNotes(grouped)}
              />
            )}
          </Saving>
          <Saving>
            {onPatch => (
              <PinsCard
                pins={setup.pins}
                viewerId={viewerId}
                roster={setup.roster}
                options={setup.options}
                locked={locked}
                onPatch={onPatch}
              />
            )}
          </Saving>
          <ChecksList
            checks={setup.checks}
            onCheckAgain={() => {
              void revalidator.revalidate();
            }}
            busy={revalidator.state === 'loading'}
          />
        </div>
      </div>

      {grouped ? (
        <div className="mt-5">
          <Saving>
            {onPatch => (
              <ProjectsTable
                options={setup.options}
                teamSize={{ min: config.team_size.min, max: config.team_size.max }}
                roster={setup.roster}
                viewerId={viewerId}
                locked={locked}
                onPatch={onPatch}
                footnote={PROJECTS_FOOTNOTE}
              />
            )}
          </Saving>
        </div>
      ) : null}
    </div>
  );
}
