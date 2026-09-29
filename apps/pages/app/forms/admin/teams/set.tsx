import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, NavLink, Outlet, useLoaderData, useLocation, useNavigate } from 'react-router';
import dayjs from 'dayjs';

import { BackToClassroom } from '~/components/forms/BackToClassroom.tsx';
import { FormAdminTabs } from '~/components/forms/FormAdminTabs.tsx';
import {
  SETUP_ROW_IDS,
  SET_STATUS_TONES,
  TEAMS_LABELS,
  changesSinceRunText,
  createLeadsSet,
  creatingBannerText,
  isCreateRunning,
  isRunActive,
  layoutPollActive,
  listJoin,
  runPath,
  setStatusChipText,
  shownSetStatus,
} from '~/components/forms/teams/teamsView.ts';
import type {
  CreateProgressView,
  SetActionData,
  TeamSetLayoutData,
  TeamSetOutletContext,
  TeamSetPaths,
} from '~/components/forms/teams/types.ts';
import { useSetFetcher } from '~/components/forms/teams/useSetFetcher.ts';
import { useSetStatusPoll } from '~/components/forms/teams/useSetStatusPoll.ts';
import { useViewportClamp } from '~/components/forms/teams/useViewportClamp.ts';

import {
  loadTeamSetLayout,
  setAction,
  teamsHeaders,
  type TeamsRouteArgs,
} from './teamsData.server.ts';

/**
 * One team set: the layout every set page renders inside (route id
 * 'team-set'), and the ONE action every set mutation posts to.
 *
 * The header: breadcrumb (Forms / {form} / Teams / {set}) with the set's
 * status chip, the Edit · Responses · Teams switcher, the Setup · Runs tabs,
 * the "changes since run n" chip and Run / Run again. While teams are being
 * made, the Creating banner shows on every set page, rendered from the status
 * poll between reloads; when that create finishes (Created or Created in
 * part) while a run or compare page is open, the page moves to the set's
 * landing, where the Created summary is. Pages below read this loader's data through
 * `useTeamSetLayoutData()`, the poll's latest answer through
 * `useSetLiveStatus()` (the Outlet's context, so a page never runs a second
 * poll), and post through `useSetFetcher()`.
 *
 * The layout is not a gate: its loader runs in parallel with the page's, so
 * every page's loader gates itself (`requireTeamSet`), and so does every
 * intent of the action (teamsData.server.ts).
 */

export const loader = (args: TeamsRouteArgs) => loadTeamSetLayout(args);

export const action = (args: TeamsRouteArgs) => setAction(args);

/** `no-store` on every response of a set page (see teamsHeaders). */
export const headers = teamsHeaders;

/** The chip format for a created set's date ("Created 12 Sep"). */
const CREATED_ON_FORMAT = 'D MMM';

export default function TeamSetLayout() {
  const layout = useLoaderData() as TeamSetLayoutData;
  const { classroom, form, set, paths } = layout;

  // The poll runs while a run or a create moves; between reloads the banner
  // and the chip render from its latest answer (counts and states: all they
  // read). The pages lay its row states over the create they loaded.
  const live = useSetStatusPoll(paths.status, layoutPollActive(layout), layout.statusSignature);
  const create = live?.create ?? layout.create;
  const latest = live?.latest_run ?? layout.latestRun;
  const activeRun =
    latest && isRunActive(latest.status)
      ? { number: latest.number, status: latest.status as 'QUEUED' | 'RUNNING' }
      : null;
  useLandOnCreated(create, paths);
  const status = shownSetStatus(set.status, { locked: set.locked, activeRun });

  const finishedAt = create?.finished_at ?? null;
  const [createdOn, setCreatedOn] = useState<string | null>(null);
  useEffect(() => {
    // After mount: the browser's zone is the reader's, the server's isn't.
    const parsed = finishedAt ? dayjs(finishedAt) : null;
    setCreatedOn(parsed?.isValid() ? parsed.format(CREATED_ON_FORMAT) : null);
  }, [finishedAt]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <BackToClassroom href={layout.backUrl} name={classroom.name} />
          <div className="flex flex-wrap items-center gap-3">
            {/* Wraps between crumbs, never inside a word; a long set name is cut
                with an ellipsis and read in full from its title. */}
            <h1 className="flex min-w-0 max-w-full flex-wrap items-center text-base font-semibold text-gray-600 dark:text-gray-400">
              <Link
                to={`/${classroom.slug}/forms`}
                className="hover:text-gray-900 dark:hover:text-white"
              >
                {TEAMS_LABELS.forms}
              </Link>
              <Separator />
              <Link
                to={`/${classroom.slug}/forms/${form.slug}/edit`}
                className="min-w-0 hover:text-gray-900 dark:hover:text-white"
              >
                {form.title}
              </Link>
              <Separator />
              <Link to={paths.list} className="hover:text-gray-900 dark:hover:text-white">
                {TEAMS_LABELS.teams}
              </Link>
              <Separator />
              <span
                data-testid="team-set-name"
                title={set.name}
                className="min-w-0 max-w-full truncate font-mono text-gray-900 dark:text-white"
              >
                {set.name}
              </span>
            </h1>
            <span
              data-testid="team-set-status"
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${SET_STATUS_TONES[status]}`}
            >
              {setStatusChipText(status, {
                runCount: layout.runCount,
                activeRun,
                creating: create ? { done: create.done, total: create.total } : null,
                createRun: create?.run_number ?? null,
                createdOn,
              })}
            </span>
            <FormAdminTabs
              classroomSlug={classroom.slug}
              formSlug={form.slug}
              access={form.access}
              active="teams"
              responses={form.responsesSubmitted}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ChangesChip layout={layout} />
          <RunButton layout={layout} creating={isCreateRunning(create)} />
        </div>
      </div>

      <SetTabs layout={layout} />

      {create && isCreateRunning(create) ? <CreatingBanner create={create} /> : null}

      <Outlet context={{ live } satisfies TeamSetOutletContext} />
    </div>
  );
}

function Separator() {
  return <span className="mx-1.5 text-gray-300 dark:text-gray-600">/</span>;
}

// ─── Landing on Created ─────────────────────────────────────────────────────

/**
 * Once a create this page watched turn RUNNING finishes Created or Created
 * in part, go to the set's landing (the Created summary), unless the page is
 * already it. Opening a page of a set whose teams were made before never
 * moves it; a FAILED create stays where it is (its card has Retry).
 *
 * The layout stays mounted when the URL moves to another set, so what was
 * watched is kept with the set it was seen on: another set's create, however
 * it stands, never moves the page.
 */
function useLandOnCreated(
  create: Pick<CreateProgressView, 'status'> | null,
  paths: Pick<TeamSetPaths, 'set'>
) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  /** The set (its path) whose create this page saw RUNNING; null when none. */
  const sawRunningOn = useRef<string | null>(null);
  const status = create?.status ?? null;

  useEffect(() => {
    if (status === 'RUNNING') {
      sawRunningOn.current = paths.set;
      return;
    }
    const watched = sawRunningOn.current === paths.set;
    sawRunningOn.current = null;
    if (!watched) return;
    if ((status === 'DONE' || status === 'PARTIAL') && pathname.replace(/\/+$/, '') !== paths.set) {
      navigate(paths.set);
    }
  }, [status, pathname, paths.set, navigate]);
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

const TAB_BASE = 'whitespace-nowrap border-b-2 px-3 py-2 text-sm';
const TAB_ON = 'border-gray-900 font-semibold text-gray-900 dark:border-white dark:text-white';
const TAB_OFF =
  'border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white';

/**
 * Setup · Runs n. Runs opens the run the set's teams are (being) made from
 * while that create leads the set (`createLeadsSet`) — so a create that failed
 * is one click away until a run is solved after it — else the latest run; with
 * no run yet it is shown but not a link.
 */
function SetTabs({ layout }: { layout: TeamSetLayoutData }) {
  const { pathname } = useLocation();
  const { paths, latestRun, runCount } = layout;
  const create = createLeadsSet(layout.create, {
    locked: layout.set.locked,
    latestSolvedAt: layout.latestSolvedAt,
  })
    ? layout.create
    : null;
  const runsTarget = create?.run_number ?? latestRun?.number ?? null;
  const onRuns = pathname.startsWith(`${paths.runs}/`);
  const runsLabel = (
    <>
      {TEAMS_LABELS.runs}{' '}
      <span className="font-normal tabular-nums text-gray-400 dark:text-gray-500">{runCount}</span>
    </>
  );

  return (
    <nav
      aria-label={TEAMS_LABELS.teamSetNav}
      className="mb-5 flex items-center gap-1 border-b border-gray-200 dark:border-gray-800"
    >
      <NavLink
        to={paths.set}
        end
        className={({ isActive }) => `${TAB_BASE} ${isActive ? TAB_ON : TAB_OFF}`}
      >
        {TEAMS_LABELS.setup}
      </NavLink>
      {runsTarget !== null ? (
        <Link
          to={runPath(paths, runsTarget)}
          data-testid="team-set-runs-tab"
          aria-current={onRuns ? 'page' : undefined}
          className={`${TAB_BASE} ${onRuns ? TAB_ON : TAB_OFF}`}
        >
          {runsLabel}
        </Link>
      ) : (
        <span
          aria-disabled="true"
          className={`${TAB_BASE} cursor-default border-transparent text-gray-400 dark:text-gray-600`}
        >
          {runsLabel}
        </span>
      )}
    </nav>
  );
}

// ─── Popover ────────────────────────────────────────────────────────────────

/**
 * A button that opens a short panel under it; Escape or a click elsewhere
 * closes it. `open` / `onOpenChange` let the caller open it from outside (the
 * Run button opens its refusal as soon as it arrives). The panel is kept
 * inside the viewport (`useViewportClamp`).
 */
function Popover({
  trigger,
  open,
  onOpenChange,
  align = 'right',
  children,
}: {
  trigger: (props: {
    'aria-expanded': boolean;
    'aria-controls': string;
    onClick: () => void;
    ref: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useViewportClamp(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onOpenChange(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={wrapRef} className="relative">
      {trigger({
        'aria-expanded': open,
        'aria-controls': panelId,
        onClick: () => onOpenChange(!open),
        ref: buttonRef,
      })}
      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        className={`absolute top-full z-30 mt-1.5 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900 ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

// ─── Changes since the latest run ───────────────────────────────────────────

/** "2 changes since run 4", listing them; hidden with no run or no change. */
function ChangesChip({ layout }: { layout: TeamSetLayoutData }) {
  const [open, setOpen] = useState(false);
  const { since_run: sinceRun, items } = layout.changes;
  if (sinceRun === null || items.length === 0) return null;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={props => (
        <button
          {...props}
          type="button"
          data-testid="team-set-changes"
          className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200 dark:hover:bg-blue-900"
        >
          {changesSinceRunText(items.length, sinceRun)}
          <span aria-hidden="true" className="ml-1 opacity-60">
            ▾
          </span>
        </button>
      )}
    >
      <ul className="grid gap-1.5 text-gray-800 dark:text-gray-100">
        {items.map((item, index) => (
          <li key={`${index}-${item.text}`}>{item.text}</li>
        ))}
      </ul>
    </Popover>
  );
}

// ─── Run / Run again ────────────────────────────────────────────────────────

/** A line under a refusal: a sentence, and the people it names (a check's `names`). */
interface RefusalLine {
  text: string;
  names: string[];
}

/**
 * Starts a run of the current setup; on success the action redirects to it.
 * Disabled while a run is moving, while teams are being made, and once the
 * set is locked. A refusal opens under the button: the sentence, the lines it
 * lists (the checks that stop the run, or what the error names), and a link
 * to Setup's checks when checks stopped it.
 */
function RunButton({ layout, creating }: { layout: TeamSetLayoutData; creating: boolean }) {
  const { post, busy, data } = useSetFetcher();
  const [open, setOpen] = useState(false);
  const refusal: SetActionData | null = data?.intent === 'run' && data.error ? data : null;

  // A new refusal opens the panel; clicking Run again closes it.
  useEffect(() => {
    setOpen(refusal !== null);
  }, [refusal]);

  const disabled = busy || creating || layout.set.locked || layout.activeRun !== null;
  const label = layout.runCount > 0 ? TEAMS_LABELS.runAgain : TEAMS_LABELS.run;
  const blocking = refusal?.issues?.filter(line => line.level === 'error') ?? [];
  const items: RefusalLine[] =
    blocking.length > 0
      ? blocking.map(line => ({ text: line.message, names: line.names ?? [] }))
      : (refusal?.errorItems ?? []).map(text => ({ text, names: [] }));

  return (
    <Popover
      open={open && refusal !== null}
      onOpenChange={setOpen}
      trigger={({ onClick: _toggle, ...props }) => (
        <button
          {...props}
          type="button"
          data-testid="team-set-run"
          disabled={disabled}
          onClick={() => {
            setOpen(false);
            post('run');
          }}
          className="rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
        >
          {label}
        </button>
      )}
    >
      {refusal ? (
        <div role="alert" className="grid gap-2">
          <p className="font-medium text-gray-900 dark:text-white">{refusal.error}</p>
          {items.length > 0 ? (
            <ul className="grid list-disc gap-1 pl-5 text-gray-700 dark:text-gray-300">
              {items.map((item, index) => (
                <li key={`${index}-${item.text}`}>
                  {item.text}
                  {item.names.length > 0 ? (
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {listJoin(item.names)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {refusal.errorCode === 'checks_failed' ? (
            <Link
              to={{ pathname: layout.paths.set, hash: `#${SETUP_ROW_IDS.checks}` }}
              onClick={() => setOpen(false)}
              className="text-blue-700 hover:underline dark:text-blue-300"
            >
              {TEAMS_LABELS.checks}
            </Link>
          ) : null}
        </div>
      ) : null}
    </Popover>
  );
}

// ─── Creating banner ────────────────────────────────────────────────────────

/** "Creating 5 teams from run 4 · 2 of 5 teams done · 9 of 24 members added", with a bar. */
function CreatingBanner({
  create,
}: {
  create: Pick<CreateProgressView, 'total' | 'done' | 'run_number' | 'counts' | 'members_total'>;
}) {
  const share = create.total > 0 ? Math.min(1, create.done / create.total) : 0;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="team-set-creating"
      className="mb-5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950"
    >
      <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
        {creatingBannerText(create)}
      </p>
      <div
        aria-hidden="true"
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900"
      >
        <div
          className="h-full rounded-full bg-blue-600 transition-[width] dark:bg-blue-400"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  );
}
