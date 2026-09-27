import { createHash } from 'node:crypto';
import { data, redirect } from 'react-router';
import { isTeamSetError } from '@classmoji/services';
import type {
  CreatePreview,
  CreateProgressView,
  NamedCheckIssue,
  RunComparisonView,
  RunView,
  RunViewMember,
  RunViewTeam,
  SetupView as ServiceSetupView,
  TeamSetConfigPatchInput,
  TeamSetRowView,
  TeamSetRunListItem,
  TeamSetSummary,
} from '@classmoji/services';
import { normalizeTeamSetName, numberedTeamSetName } from '@classmoji/services/team-set-config';
import type {
  ClosedProvenanceView,
  CoreItem as ServiceCoreItem,
  OptionRef,
  OptionStatus,
  PersonRef,
  PinView,
  PlacementFacts,
  RunMover,
  RunSeat,
  SetupChange,
} from '@classmoji/services/team-set-explain';

import {
  teamsErrorFrom,
  teamsErrorView,
  type TeamsErrorView,
} from '~/components/forms/teams/teamsErrors.ts';
import { teamSetPaths, runPath } from '~/components/forms/teams/teamsView.ts';
import {
  SET_INTENTS,
  type ActiveRunStatus,
  type CheckLine,
  type ComparePageData,
  type CoreItem,
  type CreateAvailability,
  type CreatedLinks,
  type CreatePollView,
  type CreatePreviewView,
  type PinTargetOption,
  type ResultMember,
  type ResultTeam,
  type RunListItemView,
  type RunIssueLine,
  type RunPageData,
  type RunRef,
  type RunViewModel,
  type SetActionData,
  type SetIntent,
  type SetIntentPayloads,
  type SetStatusPayload,
  type SetupPageData,
  type SetupView,
  type TeamSetLayoutData,
  type TeamSetListData,
  type TeamSetListRow,
  type TeamSetPaths,
  type TeamsFormFacts,
} from '~/components/forms/teams/types.ts';
import { webappUrl } from '~/site/env.server.ts';
import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import {
  assertFormAdmin,
  formMutationBlocked,
  type FormAdminContext,
} from '~/utils/formAuth.server.ts';

import { formsListUrl } from '../adminLinks.server.ts';
import { NO_STORE } from '../responsesData.server.ts';

/**
 * The Teams pages' server half: the gates, the loaders, the set layout's one
 * action, and the DTOs they hand the page.
 *
 * ── Who may do what ────────────────────────────────────────────────────────
 * `teamSet.service` carries no authorization by documented design (as
 * `formResponse.service` doesn't); this module is the wall in front of it.
 * Every loader and the action start with `assertFormAdmin` (OWNER or TEACHER,
 * Pro; denials logged by the platform guard). Creating teams — the preview,
 * the create, the retry — is OWNER only, as `form_teams_create` is over MCP:
 * it makes real GitHub teams in the classroom's organization. A teacher sets
 * up, runs, discards and copies sets. Assistants and students have no Teams
 * page at all.
 *
 * The set is always resolved through the form found by (classroom, slug) —
 * the pair the URL was authorized against — and the service is handed the
 * AUTHORIZED classroom id, which it scopes every query by. A set or run from
 * another classroom is not found, never refused differently.
 *
 * ── Refusals reach a fetcher as data ───────────────────────────────────────
 * Every set mutation is a fetcher post (`useSetFetcher`). A THROWN Response
 * from a fetcher's action escalates to the ErrorBoundary and unmounts the page
 * mid-edit, so the action RETURNS every refusal as `SetActionData` with the
 * sentence from `teamsErrors.ts`: a 403 for "not yours to do" (owner-only
 * intents, a locked classroom, a caller who isn't staff), a 400 for a body
 * that doesn't parse, and a 200 for the service's own refusals — a 2xx lets
 * React Router revalidate, so a page that was behind (a run started over MCP,
 * a create claimed in another tab) catches up in the same step. Only a
 * missing session is thrown (the login redirect). `TeamSetError.message` is
 * written for agents and never reaches the page.
 *
 * ── What leaves the server ─────────────────────────────────────────────────
 * Loader data is serialized whole, extra keys included, so every shape that
 * carries people is rebuilt key by key from the service's (the MCP tools'
 * rule): runs and their members, placements (the why facts), Can't-solve
 * items, pins (Setup's, and the one inside every pin change), who moved
 * between two runs, the pitchers and "pinned here" people, the roster. No
 * solver internals, no preview member lists, no identity answer, and no
 * login but one: see the create progress below.
 *
 * A few service shapes go out as the service built them, typed exactly:
 *   - with no person and no answer in them: team `signals` (counts and class
 *     averages), a question's `rules`, `must_labels`, `counts` and
 *     `type_facts`, the run `metrics`, the compare metric rows, and a
 *     change's `before`/`after` (config values Setup shows anyway);
 *   - the set's `config`, which Setup edits: pins and save stamps in it are
 *     user ids, never names;
 *   - the create progress (`CreateProgressView`, in the layout's data): team
 *     names, who claimed it, and each member a create couldn't add, with the
 *     GitHub login the Creating card shows beside the name.
 *
 * The status route (the poll) sends none of that: counts and states only
 * (`toCreatePollView`), so every name a page shows came with a page load.
 *
 * Every page response is `no-store`. Views that name students — a run's
 * teams, why facts, Can't-solve people, pin changes; Setup; Compare; the
 * layout's changes chip when it names pin people, and its create when it
 * names members who weren't added; a run refused by checks that name
 * people — write a VIEW audit row.
 */

/** Audit resource type, shared with the MCP team-set tools. */
export const TEAM_SETS_RESOURCE = 'TEAM_SETS';

export { NO_STORE };

/** What React Router hands a loader or an action here. */
export interface TeamsRouteArgs {
  params: Record<string, string | undefined>;
  request: Request;
}

/**
 * `headers` for every Teams page route: always `no-store`. Not just the
 * loader's own headers re-emitted (the responses page's idiom): React Router
 * takes the DEEPEST matched route's `headers`, and a revalidation that runs
 * only the layout's loader (or a leaf whose loader didn't run) would otherwise
 * answer without it.
 */
export const teamsHeaders = ({ loaderHeaders }: { loaderHeaders: Headers }): Headers => {
  const headers = new Headers(loaderHeaders);
  headers.set('Cache-Control', NO_STORE['Cache-Control']);
  return headers;
};

// ─── Intents ────────────────────────────────────────────────────────────────

/** Intents only a classroom OWNER may post: they make (or preview making) GitHub teams. */
export const OWNER_INTENTS: ReadonlySet<SetIntent> = new Set<SetIntent>([
  'preview-create',
  'create',
  'retry-create',
]);

/**
 * Intents that write. They also pass the classroom-status gate
 * (`formMutationBlocked`: a LOCKED or UNPUBLISHED classroom is read-only for
 * everyone but its owner). The two reads — a create preview and the identity
 * "Show which" — don't.
 */
export const WRITE_INTENTS: ReadonlySet<SetIntent> = new Set<SetIntent>([
  'patch',
  'run',
  'discard',
  'create',
  'retry-create',
  'new-set-from-setup',
]);

/** A refusal as the action answers it: the sentence, its code, and the list it names. */
export function refusalData(intent: SetIntent, view: TeamsErrorView): SetActionData {
  return {
    intent,
    error: view.message,
    errorCode: view.code,
    ...(view.items.length > 0 ? { errorItems: view.items } : {}),
  };
}

/**
 * Whether `role` may post `intent`: null when it may, else the refusal to
 * return (never throw). OWNER may post everything; TEACHER everything but the
 * create family; any other role — or none — nothing.
 */
export function intentRefusal(
  intent: SetIntent,
  role: string | null | undefined
): SetActionData | null {
  if (role === 'OWNER') return null;
  if (OWNER_INTENTS.has(intent)) return refusalData(intent, teamsErrorView('owner_only'));
  if (role === 'TEACHER') return null;
  return refusalData(intent, teamsErrorView('unknown'));
}

/** The intent a body names, or null when it names none this action takes. */
export function intentOf(body: unknown): SetIntent | null {
  const intent = isRecord(body) ? body.intent : undefined;
  return typeof intent === 'string' && (SET_INTENTS as readonly string[]).includes(intent)
    ? (intent as SetIntent)
    : null;
}

/** The largest run number the INT4 column holds. */
const MAX_RUN_NUMBER = 2_147_483_647;

/**
 * A run number from a URL segment or a JSON body: a positive integer (a
 * digit string is accepted too), else null.
 */
export function runNumberOf(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_RUN_NUMBER ? n : null;
}

/** The longest set name the dialog may send; the service slugs and caps it at 40. */
const MAX_NAME_INPUT = 200;

export type IntentPayloadResult<I extends SetIntent> =
  | { ok: true; payload: SetIntentPayloads[I] }
  | { ok: false; view: TeamsErrorView };

/**
 * An intent's payload from the posted body, checked. Pure. A run number that
 * isn't one reads as `not_found` (it names no run); a patch that isn't an
 * object, or a name that isn't text, as `invalid_config`; a typed name with no
 * letter or digit (nothing left once it is made a set name) as
 * `set_name_empty`. `create` refuses
 * `githubTeams: false` here: classroom-only teams are not offered this
 * release, the dialog's checkbox is locked on, and the service refuses it too;
 * a `patch` that sets `github_teams: false` is refused with the same code.
 */
export function setIntentPayload<I extends SetIntent>(
  intent: I,
  body: unknown
): IntentPayloadResult<I> {
  const raw = isRecord(body) ? body : {};
  const ok = (payload: unknown): IntentPayloadResult<I> => ({
    ok: true,
    payload: payload as SetIntentPayloads[I],
  });
  const refuse = (code: string): IntentPayloadResult<I> => ({
    ok: false,
    view: teamsErrorView(code),
  });

  switch (intent) {
    case 'patch':
      if (!isRecord(raw.patch)) return refuse('invalid_config');
      // Classroom-only teams aren't made this release (the MCP patch refuses
      // it too): a set saved with them could never be created.
      if (raw.patch.github_teams === false) return refuse('github_teams_off_unsupported');
      return ok({ patch: raw.patch });
    case 'run':
    case 'retry-create':
      return ok({});
    case 'discard': {
      if (raw.runNumber === undefined || raw.runNumber === null) return ok({});
      const runNumber = runNumberOf(raw.runNumber);
      return runNumber === null ? refuse('not_found') : ok({ runNumber });
    }
    case 'preview-create':
    case 'reveal-identity': {
      const runNumber = runNumberOf(raw.runNumber);
      return runNumber === null ? refuse('not_found') : ok({ runNumber });
    }
    case 'create': {
      const runNumber = runNumberOf(raw.runNumber);
      if (runNumber === null) return refuse('not_found');
      if (raw.githubTeams !== true) return refuse('github_teams_off_unsupported');
      return ok({ runNumber, githubTeams: true });
    }
    case 'new-set-from-setup': {
      if (raw.name === undefined || raw.name === null) return ok({});
      if (typeof raw.name !== 'string' || raw.name.length > MAX_NAME_INPUT) {
        return refuse('invalid_config');
      }
      const name = raw.name.trim();
      if (name === '') return ok({});
      return normalizedSetName(name) === '' ? refuse('set_name_empty') : ok({ name });
    }
    default:
      return refuse('unknown');
  }
}

// ─── Gates and context ──────────────────────────────────────────────────────

/** The form as the Teams pages need it, beside the platform gate's answer. */
export interface TeamsFormContext extends FormAdminContext {
  form: {
    id: string;
    slug: string;
    title: string;
    access: 'PUBLIC' | 'CLASSROOM';
    /** Has a published revision: a set can be built from it. */
    published: boolean;
    closesAtIso: string | null;
  };
  isOwner: boolean;
}

/** A set page's context: the form, the set (status and lock included) and its URLs. */
export interface TeamSetPageContext extends TeamsFormContext {
  set: TeamSetRowView;
  paths: TeamSetPaths;
}

const notFound = () => new Response('Not found', { status: 404 });

/**
 * Run a service read, turning "that isn't here" into a 404 so a service
 * error never reaches the root ErrorBoundary as a crash. `form_not_classroom`
 * is a 404 too: a PUBLIC form has no team sets.
 */
export async function orNotFound<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      isTeamSetError(error) &&
      (error.code === 'not_found' || error.code === 'form_not_classroom')
    ) {
      throw notFound();
    }
    throw error;
  }
}

type FormRow = NonNullable<Awaited<ReturnType<typeof ClassmojiService.form.findBySlug>>>;

function formContextOf(access: FormAdminContext, form: FormRow): TeamsFormContext {
  return {
    ...access,
    form: {
      id: form.id,
      slug: form.slug,
      title: form.title,
      access: form.access === 'CLASSROOM' ? 'CLASSROOM' : 'PUBLIC',
      published: Boolean(form.current_revision_id),
      closesAtIso: form.closes_at ? form.closes_at.toISOString() : null,
    },
    isOwner: access.membership.role === 'OWNER',
  };
}

/** The form named by the URL, inside the classroom the caller was authorized for; 404 when there is none. */
async function formFor(access: FormAdminContext, formSlug: string | undefined) {
  const form = formSlug
    ? await ClassmojiService.form.findBySlug(access.classroom.id, formSlug)
    : null;
  return form ? formContextOf(access, form) : null;
}

/** The set named by the URL on a CLASSROOM form; null when there is none. */
async function setFor(
  context: TeamsFormContext,
  setSlug: string | undefined
): Promise<TeamSetPageContext | null> {
  if (!setSlug || context.form.access !== 'CLASSROOM') return null;
  let set: TeamSetRowView | null;
  try {
    set = await ClassmojiService.teamSet.getSet({
      classroomId: context.classroom.id,
      formId: context.form.id,
      setRef: setSlug,
    });
  } catch (error) {
    if (
      isTeamSetError(error) &&
      (error.code === 'not_found' || error.code === 'form_not_classroom')
    ) {
      return null;
    }
    throw error;
  }
  if (!set) return null;
  return {
    ...context,
    set,
    paths: teamSetPaths({
      classroomSlug: context.classroom.slug,
      formSlug: context.form.slug,
      setName: set.name,
    }),
  };
}

/**
 * The gate for the sets list: OWNER or TEACHER, Pro, and a form by that slug
 * in this classroom (404 otherwise). The form may be PUBLIC or unpublished —
 * the list says so instead of the table.
 *
 * @throws Response 302 (no session), 403, 404 — loaders let them propagate.
 */
export async function requireTeamsForm(
  { params, request }: TeamsRouteArgs,
  action = 'view_team_sets'
): Promise<TeamsFormContext> {
  const access = await assertFormAdmin(params.classroomSlug ?? '', request, { action });
  const context = await formFor(access, params.formSlug);
  if (!context) throw notFound();
  return context;
}

/**
 * The gate for every set page and the status route: `requireTeamsForm`, then
 * the set `:setSlug` names (id or name) on a CLASSROOM form. A PUBLIC form, a
 * missing set, or a set of another form is a 404.
 *
 * @throws Response 302 (no session), 403, 404.
 */
export async function requireTeamSet(
  args: TeamsRouteArgs,
  action = 'view_team_set'
): Promise<TeamSetPageContext> {
  const context = await requireTeamsForm(args, action);
  const page = await setFor(context, args.params.setSlug);
  if (!page) throw notFound();
  return page;
}

// ─── Audit ──────────────────────────────────────────────────────────────────

/**
 * One audit row on this surface. `data.tool` names the act (the audit
 * service's five-second dedup keys on it, and on `value` when there is one).
 */
export async function auditTeamSets(
  context: TeamsFormContext,
  entry: {
    action: 'VIEW' | 'CREATE' | 'UPDATE' | 'ACCESS_DENIED';
    tool: string;
    resourceId: string;
    data?: Record<string, unknown>;
  }
) {
  return ClassmojiService.audit.create({
    user_id: context.userId,
    classroom_id: context.classroom.id,
    role: context.membership.role,
    resource_type: TEAM_SETS_RESOURCE,
    resource_id: entry.resourceId,
    action: entry.action,
    data: {
      tool: entry.tool,
      form_id: context.form.id,
      form_slug: context.form.slug,
      ...(entry.data ?? {}),
    },
  });
}

/**
 * A short, stable fingerprint of what a row is about (a patch, a refusal's
 * check lines), as its audit `value`: two different ones inside the dedup
 * window are two rows, not one.
 */
const fingerprintOf = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(value ?? {}))
    .digest('hex')
    .slice(0, 12);

// ─── DTOs (rebuilt key by key) ──────────────────────────────────────────────

const person = (ref: PersonRef): PersonRef => ({ user_id: ref.user_id, name: ref.name });

const personRef = (ref: PersonRef | null): PersonRef | null => (ref ? person(ref) : null);

const option = (ref: OptionRef): OptionRef => ({ id: ref.id, label: ref.label });

const optionRef = (ref: OptionRef | null): OptionRef | null => (ref ? option(ref) : null);

/**
 * How a run left an option. A view that doesn't show it (a run grouped by a
 * question flagged as an identity question since) may send none; it stays
 * none, and the why lines leave it out (`optionStatusText`).
 */
const optionStatus = (status: OptionStatus | null | undefined): OptionStatus =>
  (status
    ? { status: status.status, placed: status.placed, max: status.max }
    : null) as OptionStatus;

const closedView = (closed: ClosedProvenanceView): ClosedProvenanceView => ({
  since_run: closed.since_run,
  by: personRef(closed.by),
  via: closed.via,
});

/** A pin with its people, options and who added it. */
export function toPinView(pin: PinView): PinView {
  return {
    id: pin.id,
    kind: pin.kind,
    people: pin.people.map(person),
    option: optionRef(pin.option),
    ...(pin.options ? { options: pin.options.map(option) } : {}),
    reason: pin.reason,
    added_by: personRef(pin.added_by),
    added_via: pin.added_via,
    added_at: pin.added_at,
  };
}

/** One setup change; a pin change carries its pin (people included), rebuilt. */
export function toSetupChange(change: SetupChange): SetupChange {
  switch (change.kind) {
    case 'pin':
      return {
        kind: change.kind,
        pin_id: change.pin_id,
        change: change.change,
        pin: toPinView(change.pin),
        text: change.text,
      };
    case 'option':
      return {
        kind: change.kind,
        option_id: change.option_id,
        field: change.field,
        before: change.before,
        after: change.after,
        text: change.text,
      };
    case 'rule':
      return {
        kind: change.kind,
        field_id: change.field_id,
        job: change.job,
        change: change.change,
        before: change.before,
        after: change.after,
        text: change.text,
      };
    default:
      return { kind: change.kind, before: change.before, after: change.after, text: change.text };
  }
}

/**
 * A Can't-solve item: its label, the students a per-student item names (and,
 * for pairs, who is with whom as positions in them), the option as that run
 * had it, and where it links. The ids the service adds beside the names
 * (`user_ids`) stay here: the page names people from `people`.
 */
export function toCoreItem(item: ServiceCoreItem): CoreItem {
  const { link } = item;
  return {
    src: item.src,
    kind: item.kind,
    label: item.label,
    ...(item.people ? { people: item.people.map(person) } : {}),
    ...(item.people && item.pairs
      ? { pairs: item.pairs.map(([a, b]): [number, number] => [a, b]) }
      : {}),
    ...(item.option
      ? {
          option: {
            id: item.option.id,
            label: item.option.label,
            open: item.option.open,
            note: item.option.note,
            ...(item.option.closed ? { closed: closedView(item.option.closed) } : {}),
          },
        }
      : {}),
    link: {
      tab: link.tab,
      ...(link.field_id !== undefined ? { field_id: link.field_id } : {}),
      ...(link.option_id !== undefined ? { option_id: link.option_id } : {}),
      ...(link.pin_id !== undefined ? { pin_id: link.pin_id } : {}),
    },
  };
}

/** One person's why facts (never an identity answer: the service's shape has none). */
export function toPlacementFacts(facts: PlacementFacts): PlacementFacts {
  return {
    user_id: facts.user_id,
    name: facts.name,
    responded: facts.responded,
    ...(facts.non_respondents_mode !== undefined
      ? { non_respondents_mode: facts.non_respondents_mode }
      : {}),
    ...(facts.grouped !== undefined ? { grouped: facts.grouped } : {}),
    team: {
      n: facts.team.n,
      name: facts.team.name,
      option: optionRef(facts.team.option),
      mates: facts.team.mates.map(person),
    },
    placement: facts.placement,
    rank: facts.rank,
    pitched: facts.pitched.map(pitched => ({
      option: option(pitched.option),
      status: optionStatus(pitched.status),
    })),
    pins: facts.pins.map(toPinView),
    previous: facts.previous
      ? {
          run_number: facts.previous.run_number,
          option: optionRef(facts.previous.option),
          team_n: facts.previous.team_n,
        }
      : null,
    higher_picks: facts.higher_picks.map(pick => ({
      rank: pick.rank,
      option: option(pick.option),
      status: optionStatus(pick.status),
    })),
    requests: facts.requests.map(request => ({
      user: person(request.user),
      kept: request.kept,
      on: { team_n: request.on.team_n, option: optionRef(request.on.option) },
    })),
    notes: facts.notes.map(note => ({ field_label: note.field_label, text: note.text })),
    ...(facts.priority
      ? {
          priority: facts.priority.map(fact => ({
            rule_id: fact.rule_id,
            question: fact.question,
            answer: fact.answer,
            favored: fact.favored,
            other: fact.other,
            up: fact.up,
            down: fact.down,
          })),
        }
      : {}),
  };
}

const seat = (where: RunSeat): RunSeat => ({
  option: optionRef(where.option),
  team_n: where.team_n,
  rank: where.rank,
});

/** Someone who moved between two runs, with the pin and requests behind it. */
export function toRunMover(mover: RunMover): RunMover {
  return {
    user: person(mover.user),
    from: seat(mover.from),
    to: seat(mover.to),
    ...(mover.pin
      ? { pin: { pin_id: mover.pin.pin_id, kind: mover.pin.kind, reason: mover.pin.reason } }
      : {}),
    requests: mover.requests.map(request => ({
      kind: request.kind,
      asker: person(request.asker),
      asked: person(request.asked),
    })),
  };
}

/**
 * A check line: the service's issue with the names of the people it is
 * about. Their user ids stay here (the page names people from `names`).
 */
export function toCheckLine(issue: NamedCheckIssue): CheckLine {
  return {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    ...(issue.srcs ? { srcs: [...issue.srcs] } : {}),
    ...(issue.option_ids ? { option_ids: [...issue.option_ids] } : {}),
    ...(issue.names ? { names: [...issue.names] } : {}),
  };
}

/** Whether any check line names someone (such a list is audited when it is sent). */
export function checkLinesNamePeople(lines: readonly Pick<CheckLine, 'names'>[]): boolean {
  return lines.some(line => (line.names?.length ?? 0) > 0);
}

/**
 * A run's check line: its facts, without the people it names. The run page
 * lists no check lines (Setup's Checks card does, from `toCheckLine`), so the
 * names and ids stay on the server.
 */
export function toRunIssueLine(issue: NamedCheckIssue): RunIssueLine {
  return {
    level: issue.level,
    code: issue.code,
    message: issue.message,
    ...(issue.srcs ? { srcs: [...issue.srcs] } : {}),
    ...(issue.option_ids ? { option_ids: [...issue.option_ids] } : {}),
  };
}

/**
 * A sets-list row (the create columns stay on the server). `grouped`: whether
 * the latest run's own setup made its teams from a question (`runsGrouped`).
 */
export function toListRow(row: TeamSetSummary, grouped = false): TeamSetListRow {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    run_count: row.run_count,
    latest_run: row.latest_run
      ? {
          number: row.latest_run.number,
          status: row.latest_run.status,
          solver_status: row.latest_run.solver_status,
          first_choice: row.latest_run.first_choice ?? null,
          responded: row.latest_run.responded ?? null,
          grouped,
        }
      : null,
    created: row.created
      ? {
          run_number: row.created.run_number,
          teams_created: row.created.teams_created,
          finished_at: row.created.finished_at,
        }
      : null,
    create_progress: row.create_state
      ? {
          run_number: row.create_state.run_number,
          done: row.create_state.done,
          total: row.create_state.total,
        }
      : null,
    updated_at: row.updated_at,
  };
}

/**
 * A run in the rail (no metrics blob, no row id). `grouped`: whether its own
 * setup made its teams from a question (`runsGrouped`).
 */
export function toRunListItem(item: TeamSetRunListItem, grouped = false): RunListItemView {
  return {
    number: item.number,
    status: item.status,
    error: item.error,
    solver_status: item.solver_status,
    gap_pct: item.gap_pct,
    first_choice: item.first_choice ?? null,
    responded: item.responded ?? null,
    grouped,
    created_by: personRef(item.created_by),
    created_at: item.created_at,
  };
}

/** A member on a team card: never their login, requests or notes (the why panel has those facts). */
function toResultMember(member: RunViewMember): ResultMember {
  return {
    user_id: member.user_id,
    name: member.name,
    placement: member.placement,
    rank: member.rank,
    pinned: member.pinned,
    responded: member.responded,
  };
}

export function toResultTeam(team: RunViewTeam): ResultTeam {
  return {
    n: team.n,
    name: team.name,
    option: team.option ? { id: team.option.id, label: team.option.label } : null,
    size: team.size,
    members: team.members.map(toResultMember),
    signals: team.signals,
  };
}

/**
 * A run as its page shows it. The solver keeps only what the runline says
 * (status, gap, core status); an identity rule only its counts — which teams
 * missed comes back from the `reveal-identity` intent alone; a check line
 * only its facts, never the people it is about. `grouped` comes from the
 * run's own setup (`configGrouped`), never from which numbers are null.
 */
export function toRunViewModel(view: RunView, grouped: boolean): RunViewModel {
  return {
    id: view.id,
    number: view.number,
    status: view.status,
    error: view.error,
    created_at: view.created_at,
    finished_at: view.finished_at,
    created_by: personRef(view.created_by),
    solver: view.solver
      ? {
          status: view.solver.status,
          gap_pct: view.solver.gap_pct,
          ...(view.solver.core_status ? { core_status: view.solver.core_status } : {}),
        }
      : null,
    metrics: view.metrics,
    grouped,
    stale: view.stale,
    stale_reasons: [...view.stale_reasons],
    issues: view.issues.map(toRunIssueLine),
    core: view.core.map(toCoreItem),
    summary: view.summary,
    changes_since_run: view.changes_since_run.map(toSetupChange),
    changes_from_previous: view.changes_from_previous
      ? {
          since_run: view.changes_from_previous.since_run,
          items: view.changes_from_previous.items.map(toSetupChange),
        }
      : null,
    progress: {
      responses: view.progress.responses,
      people: view.progress.people,
      pins: view.progress.pins,
      warnings: view.progress.warnings,
    },
    identity_rules: view.identity_rules.map(rule => ({
      rule_id: rule.rule_id,
      label: rule.label,
      teams_held: rule.teams_held,
      teams_total: rule.teams_total,
    })),
    non_respondents: view.non_respondents
      ? { mode: view.non_respondents.mode, people: view.non_respondents.people }
      : null,
    option_status: (view.option_status ?? []).map(row => ({
      option_id: row.option_id,
      label: row.label,
      status: row.status,
      placed: row.placed,
      max: row.max,
    })),
    teams: view.teams.map(toResultTeam),
  };
}

/** The Create dialog's preview: team names, options and sizes — never the member lists. */
export function toPreviewView(preview: CreatePreview): CreatePreviewView {
  return {
    run_number: preview.run_number,
    tag: { name: preview.tag.name, exists: preview.tag.exists },
    github_teams: preview.github_teams,
    name_template: preview.name_template,
    students: preview.students,
    teams: preview.teams.map(team => ({
      name: team.name,
      option: team.option ? { id: team.option.id, label: team.option.label } : null,
      size: team.size,
    })),
    warnings: [...preview.warnings],
    ...(preview.retry
      ? {
          retry: {
            attempt: preview.retry.attempt,
            teams_already_created: preview.retry.teams_already_created,
          },
        }
      : {}),
  };
}

/**
 * Setup's view. Identity questions carry class counts only (the service's
 * rule). A "pinned here" person carries the pin's typed reason, from the pin.
 */
export function toSetupView(view: ServiceSetupView): SetupView {
  const reasons = new Map(view.pins.map(pin => [pin.id, pin.reason]));
  return {
    set: {
      id: view.set.id,
      name: view.set.name,
      status: view.set.status,
      locked: view.set.locked,
      config: view.set.config,
      updated_at: view.set.updated_at,
    },
    readiness: {
      roster: view.readiness.roster,
      answered: view.readiness.answered,
      not_answered: view.readiness.not_answered,
      closes_at: view.readiness.closes_at,
      closed: view.readiness.closed,
    },
    grouping: { mode: view.grouping.mode, field_id: view.grouping.field_id },
    questions: view.questions.map(question => ({
      field_id: question.field_id,
      label: question.label,
      type: question.type,
      type_facts: question.type_facts,
      identity: question.identity,
      help_text: question.help_text,
      jobs_allowed: [...question.jobs_allowed],
      rules: question.rules,
      must_labels: question.must_labels,
      counts: question.counts,
      ...(question.answer_counts
        ? {
            answer_counts: question.answer_counts.map(answer => ({
              option_id: answer.option_id,
              label: answer.label,
              count: answer.count,
            })),
          }
        : {}),
    })),
    shape: {
      people: view.shape.people,
      team_count_range: view.shape.team_count_range
        ? { min: view.shape.team_count_range.min, max: view.shape.team_count_range.max }
        : null,
    },
    non_respondents: {
      mode: view.non_respondents.mode,
      resolved: view.non_respondents.resolved,
      count: view.non_respondents.count,
    },
    pins: view.pins.map(toPinView),
    options: view.options.map(row => ({
      option_id: row.option_id,
      label: row.label,
      description: row.description,
      wanted: { first: row.wanted.first, top3: row.wanted.top3 },
      runs: row.runs,
      size: row.size ? { min: row.size.min, max: row.size.max } : null,
      note: row.note,
      pitchers: row.pitchers.map(pitcher => ({
        user_id: pitcher.user_id,
        name: pitcher.name,
        on_roster: pitcher.on_roster,
      })),
      pinned_here: row.pinned_here.map(pin => ({
        pin_id: pin.pin_id,
        user_id: pin.user_id,
        name: pin.name,
        reason: reasons.get(pin.pin_id) ?? null,
      })),
      ...(row.closed ? { closed: closedView(row.closed) } : {}),
    })),
    roster: view.roster.map(person),
    checks: view.checks.map(toCheckLine),
    changes: { since_run: view.changes.since_run, items: view.changes.items.map(toSetupChange) },
  };
}

/** Compare's data from `compareRuns`; `grouped` says which runs made their teams from a question. */
export function toComparePageData(
  runs: TeamSetRunListItem[],
  view: RunComparisonView,
  grouped: ReadonlyMap<number, boolean> = new Map()
): ComparePageData {
  return {
    runs: runs.map(item => toRunListItem(item, grouped.get(item.number) ?? false)),
    runNumber: view.run_number,
    otherNumber: view.other_run_number,
    refusal: null,
    comparison: {
      run_number: view.run_number,
      other_run_number: view.other_run_number,
      changes: view.changes.map(toSetupChange),
      metrics: view.metrics,
      moved: view.moved.map(toRunMover),
      unchanged: view.unchanged,
      joined: view.joined,
      left: view.left,
    },
    grouped: view.grouped,
    ruleLabels: { ...view.rule_labels },
  };
}

/**
 * The options the pin block can pin someone to: every option the run had that
 * isn't Closed and is still on the form, marked running when teams were
 * opened on it. [] in free mode.
 */
export function pinTargetsOf(run: RunViewModel): RunPageData['pinTargets'] {
  const options: PinTargetOption[] = run.option_status
    .filter(
      (row): row is typeof row & { label: string } =>
        row.label !== null && row.status !== 'closed' && row.status !== 'not_on_form'
    )
    .map(row => ({
      id: row.option_id,
      label: row.label,
      running: row.status === 'running' || row.status === 'full',
    }));
  const people = run.teams
    .flatMap(team => team.members.map(member => ({ user_id: member.user_id, name: member.name })))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return { options, people };
}

/**
 * Whether this viewer can create teams from this run, and what stops it,
 * first reason first: not solved, the set's teams exist, a create is running,
 * a create from ANOTHER run failed after making teams (only that run can be
 * retried), the run is stale. A FAILED create that made no team frees the set
 * (it isn't locked), and the same failed run is the retry path.
 */
export function createAvailability(
  set: Pick<TeamSetRowView, 'status' | 'locked' | 'create_state'>,
  run: Pick<RunViewModel, 'number' | 'status' | 'stale'>,
  isOwner: boolean
): CreateAvailability {
  const failedRun = set.create_state?.run_number ?? null;
  let blockedBy: CreateAvailability['blockedBy'] = null;
  if (run.status !== 'SOLVED') blockedBy = 'not_solved';
  else if (set.status === 'created' || set.status === 'partial') blockedBy = 'created';
  else if (set.status === 'creating') blockedBy = 'creating';
  else if (set.status === 'create_failed' && set.locked && failedRun !== run.number) {
    blockedBy = 'create_failed';
  } else if (run.stale) blockedBy = 'stale';
  return {
    allowed: isOwner,
    blockedBy,
    ...(blockedBy === 'create_failed' ? { failedRun } : {}),
  };
}

// ─── Loaders ────────────────────────────────────────────────────────────────

const classroomOf = (context: TeamsFormContext) => ({
  slug: context.classroom.slug,
  name: context.classroom.name ?? context.classroom.slug,
});

async function formFacts(context: TeamsFormContext): Promise<TeamsFormFacts> {
  const responsesSubmitted = await prisma.formResponse.count({
    where: { form_id: context.form.id, submission_state: 'SUBMITTED' },
  });
  return {
    slug: context.form.slug,
    title: context.form.title,
    access: context.form.access,
    published: context.form.published,
    closesAtIso: context.form.closesAtIso,
    responsesSubmitted,
  };
}

const viewerOf = (context: TeamsFormContext) => ({
  userId: context.userId,
  isOwner: context.isOwner,
});

/** `base`, else `base-2`, `base-3`, … (numberedTeamSetName) — the first name no set on the form has. */
function freeSetName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) {
    const name = numberedTeamSetName(base, k);
    if (!taken.has(name)) return name;
  }
}

/**
 * A set name as the service stores it: the service's own normalizeTeamSetName
 * (NFC, lower case, letters and digits of any script, single hyphens, ≤ 40
 * characters). '' when no letter or digit is left (`set_name_empty`).
 */
export function normalizedSetName(raw: string): string {
  return normalizeTeamSetName(raw);
}

/** Whether a run's own setup (its config snapshot) made its teams from a question. */
export function configGrouped(config: unknown): boolean {
  const grouping = (config as { grouping?: { mode?: unknown } } | null)?.grouping;
  return grouping?.mode === 'by_option';
}

/**
 * Whether each of a set's runs made its teams from a question, by run number,
 * from the runs' own setups. A run of a set with no grouping question has no
 * picks or placements to show, whatever its metrics hold.
 */
async function runsGrouped(
  teamSetId: string,
  numbers: readonly number[]
): Promise<Map<number, boolean>> {
  if (numbers.length === 0) return new Map();
  const rows = await prisma.teamSetRun.findMany({
    where: { team_set_id: teamSetId, number: { in: [...numbers] } },
    select: { number: true, config: true },
  });
  return new Map(rows.map(row => [row.number, configGrouped(row.config)]));
}

/** `runsGrouped` for the latest run of each listed set, by set id. */
async function latestRunsGrouped(
  rows: readonly Pick<TeamSetSummary, 'id' | 'latest_run'>[]
): Promise<Map<string, boolean>> {
  const latest = rows.flatMap(row =>
    row.latest_run ? [{ team_set_id: row.id, number: row.latest_run.number }] : []
  );
  if (latest.length === 0) return new Map();
  const found = await prisma.teamSetRun.findMany({
    where: { OR: latest },
    select: { team_set_id: true, number: true, config: true },
  });
  const byKey = new Map(
    found.map(run => [`${run.team_set_id}:${run.number}`, configGrouped(run.config)])
  );
  return new Map(
    latest.map(run => [run.team_set_id, byKey.get(`${run.team_set_id}:${run.number}`) ?? false])
  );
}

/**
 * The team sets list (`list.tsx`). A PUBLIC form lists nothing (the page
 * says team sets need a classroom form); an unpublished one lists its sets
 * but has no suggestion to start from.
 */
export async function loadTeamSetList(args: TeamsRouteArgs) {
  const context = await requireTeamsForm(args);
  const classroomId = context.classroom.id;
  const formId = context.form.id;

  let sets: TeamSetListRow[] = [];
  let suggestedName = '';
  if (context.form.access === 'CLASSROOM') {
    const rows = await ClassmojiService.teamSet.listForForm({ classroomId, formId });
    const grouped = await latestRunsGrouped(rows);
    sets = rows.map(row => toListRow(row, grouped.get(row.id) ?? false));
    if (context.form.published) {
      try {
        const suggestion = await ClassmojiService.teamSet.suggestForForm({ classroomId, formId });
        suggestedName = freeSetName(
          normalizedSetName(suggestion.name),
          new Set(sets.map(set => set.name))
        );
      } catch (error) {
        if (!isTeamSetError(error)) throw error;
      }
    }
  }

  const payload: TeamSetListData = {
    classroom: classroomOf(context),
    backUrl: formsListUrl(context.membership.role, context.classroom.slug),
    viewer: viewerOf(context),
    form: await formFacts(context),
    sets,
    suggestedName,
  };
  return data(payload, { headers: NO_STORE });
}

/**
 * The set layout's data (`set.tsx`, route id 'team-set'). Light on purpose —
 * it reloads after every autosave: the poll read (latest run, create,
 * signature), a run count, when the last solved run finished (whether a
 * failed create still leads the set: `createLeadsSet`), the changes since the latest run,
 * and the Responses count for the switcher. Audited (VIEW) when the changes or the
 * create name people. `githubTeamsLocked` is the Create
 * dialog's switch: classroom-only teams are cut for this release, so the
 * "Also create GitHub teams" box is shown checked and disabled.
 */
export async function loadTeamSetLayout(args: TeamsRouteArgs) {
  const context = await requireTeamSet(args);
  const classroomId = context.classroom.id;
  const teamSetId = context.set.id;

  const [poll, runCount, latestSolved, changes, form] = await Promise.all([
    ClassmojiService.teamSet.pollStatus({ classroomId, teamSetId }),
    prisma.teamSetRun.count({ where: { team_set_id: teamSetId } }),
    // By finish time, not number: what matters is whether a run was solved
    // after a failed create finished.
    prisma.teamSetRun.findFirst({
      where: { team_set_id: teamSetId, status: 'SOLVED', finished_at: { not: null } },
      orderBy: { finished_at: 'desc' },
      select: { finished_at: true },
    }),
    ClassmojiService.teamSet.changesSinceRun({ classroomId, teamSetId }),
    formFacts(context),
  ]);

  // The changes chip names the people of a pin change, and a create's
  // failures name the members who weren't added.
  const peopleIn = [
    ...(namesPin(changes.changes) ? ['changes'] : []),
    ...(poll.create?.failures.some(failure => (failure.members?.length ?? 0) > 0)
      ? ['create']
      : []),
  ];
  if (peopleIn.length > 0) {
    await auditTeamSets(context, {
      action: 'VIEW',
      tool: 'teams.set.view',
      resourceId: teamSetId,
      data: { team_set_id: teamSetId, people_in: peopleIn },
    });
  }

  const latestRun: RunRef | null = poll.latest_run
    ? { number: poll.latest_run.number, status: poll.latest_run.status }
    : null;
  const activeRun =
    latestRun && (latestRun.status === 'QUEUED' || latestRun.status === 'RUNNING')
      ? { number: latestRun.number, status: latestRun.status as ActiveRunStatus }
      : null;

  const payload: TeamSetLayoutData = {
    classroom: classroomOf(context),
    backUrl: formsListUrl(context.membership.role, context.classroom.slug),
    viewer: viewerOf(context),
    form,
    set: {
      id: context.set.id,
      name: context.set.name,
      status: context.set.status,
      locked: context.set.locked,
    },
    runCount,
    latestRun,
    latestSolvedAt: latestSolved?.finished_at?.toISOString() ?? null,
    activeRun,
    changes: { since_run: changes.run_number, items: changes.changes.map(toSetupChange) },
    create: poll.create,
    statusSignature: poll.signature,
    paths: context.paths,
    githubTeamsLocked: true,
  };
  return data(payload, { headers: NO_STORE });
}

/**
 * The Created summary's links. Both webapp screens are owner-only (the Teams
 * screen has no /teacher twin), so a teacher gets nulls and no buttons.
 */
export function createdLinksFor(
  context: Pick<TeamsFormContext, 'isOwner' | 'classroom'>
): CreatedLinks {
  if (!context.isOwner) return { teamsUrl: null, assignmentUrl: null };
  const base = `${webappUrl()}/admin/${context.classroom.slug}`;
  return { teamsUrl: `${base}/teams`, assignmentUrl: `${base}/assignments` };
}

/**
 * What the set's landing adds once its teams exist (status created or
 * partial): the Created summary's links, and the created run's teams with
 * their members for CreatedTeamsList. Links null and no teams otherwise.
 */
export async function createdLanding(
  context: TeamSetPageContext
): Promise<{ createdLinks: CreatedLinks | null; createdTeams: ResultTeam[] }> {
  const { set } = context;
  if ((set.status !== 'created' && set.status !== 'partial') || !set.created_run_id) {
    return { createdLinks: null, createdTeams: [] };
  }
  const classroomId = context.classroom.id;
  const run = await ClassmojiService.teamSet.getRun({
    classroomId,
    teamSetId: set.id,
    runRef: set.created_run_id,
  });
  const view = await ClassmojiService.teamSet.describeRun({
    classroomId,
    run,
    includePeople: true,
  });
  return { createdLinks: createdLinksFor(context), createdTeams: view.teams.map(toResultTeam) };
}

/** Setup's data (`setup.tsx`, the layout's index), the created run's teams included. */
export async function loadSetupPage(args: TeamsRouteArgs) {
  const context = await requireTeamSet(args, 'view_team_set_setup');
  const [setup, landing] = await Promise.all([
    orNotFound(() =>
      ClassmojiService.teamSet.getSetup({
        classroomId: context.classroom.id,
        formId: context.form.id,
        setRef: context.set.id,
      })
    ),
    createdLanding(context),
  ]);

  // Pitchers, pins and the roster name students; a created set lists its teams.
  await auditTeamSets(context, {
    action: 'VIEW',
    tool: 'teams.setup.view',
    resourceId: context.set.id,
    data: { team_set_id: context.set.id, created_teams: landing.createdTeams.length > 0 },
  });

  const payload: SetupPageData = {
    setup: toSetupView(setup),
    createdLinks: landing.createdLinks,
    createdTeams: landing.createdTeams,
  };
  return data(payload, { headers: NO_STORE });
}

/** Runs listed in the rail. */
const RUNS_LISTED = 50;

const namesPin = (changes: readonly SetupChange[]) => changes.some(change => change.kind === 'pin');

/**
 * The parts of a run's page that name students (empty: nothing to audit):
 * its teams, the why facts, Can't-solve items, pin changes. Check lines are
 * sent without their people (`toRunIssueLine`), so they name no one.
 */
export function runPeopleShown(
  view: Pick<RunView, 'teams' | 'core' | 'changes_since_run' | 'changes_from_previous'>,
  placements: number
): string[] {
  const parts: string[] = [];
  if (view.teams.some(team => team.members.length > 0)) parts.push('teams');
  if (placements > 0) parts.push('placements');
  if (view.core.some(item => (item.people?.length ?? 0) > 0 || (item.user_ids?.length ?? 0) > 0)) {
    parts.push('core');
  }
  if (
    namesPin(view.changes_since_run) ||
    (view.changes_from_previous !== null && namesPin(view.changes_from_previous.items))
  ) {
    parts.push('changes');
  }
  return parts;
}

/**
 * Run n's page (`run.tsx`): the rail, the run by status, why facts for
 * everyone in a solved run, pin targets, and Create's availability. One
 * shape for every status; preview and reveal are intents, never URL params.
 */
export async function loadRunPage(args: TeamsRouteArgs) {
  const context = await requireTeamSet(args, 'view_team_set_run');
  const runNumber = runNumberOf(args.params.runNumber);
  if (runNumber === null) throw notFound();
  const classroomId = context.classroom.id;
  const teamSetId = context.set.id;

  const [runs, row] = await Promise.all([
    ClassmojiService.teamSet.listRuns({ classroomId, teamSetId, limit: RUNS_LISTED }),
    orNotFound(() =>
      ClassmojiService.teamSet.getRun({ classroomId, teamSetId, runRef: runNumber })
    ),
  ]);
  const [view, placements, grouped] = await Promise.all([
    ClassmojiService.teamSet.describeRun({ classroomId, run: row, includePeople: true }),
    row.status === 'SOLVED'
      ? ClassmojiService.teamSet.explainPlacements({ classroomId, teamSetId, runRef: runNumber })
      : Promise.resolve([]),
    runsGrouped(
      teamSetId,
      runs.map(item => item.number)
    ),
  ]);
  const run = toRunViewModel(view, configGrouped(row.config));

  // Every run view that names students is audited, not only one with teams:
  // Can't solve names the students of per-student items, a pin change names
  // the pinned.
  const peopleIn = runPeopleShown(view, placements.length);
  if (peopleIn.length > 0) {
    await auditTeamSets(context, {
      action: 'VIEW',
      tool: 'teams.run.view',
      resourceId: row.id,
      data: {
        team_set_id: teamSetId,
        run_number: run.number,
        people_in: peopleIn,
        value: run.number,
      },
    });
  }

  const payload: RunPageData = {
    runs: runs.map(item => toRunListItem(item, grouped.get(item.number) ?? false)),
    run,
    placements: placements.map(toPlacementFacts),
    pinTargets: pinTargetsOf(run),
    create: createAvailability(context.set, run, context.isOwner),
    lastSolvedRun: runs.find(item => item.status === 'SOLVED')?.number ?? null,
  };
  return data(payload, { headers: NO_STORE });
}

/**
 * Run n compared with run m (`compare.tsx`). When either run has no teams
 * (`run_not_solved`: not SOLVED), the page gets the rail and that sentence,
 * nothing that names anyone, and no audit row.
 */
export async function loadComparePage(args: TeamsRouteArgs) {
  const context = await requireTeamSet(args, 'view_team_set_compare');
  const runNumber = runNumberOf(args.params.runNumber);
  const otherNumber = runNumberOf(args.params.otherNumber);
  if (runNumber === null || otherNumber === null) throw notFound();
  const classroomId = context.classroom.id;
  const teamSetId = context.set.id;

  const [runs, compared] = await Promise.all([
    ClassmojiService.teamSet.listRuns({ classroomId, teamSetId, limit: RUNS_LISTED }),
    orNotFound(() =>
      ClassmojiService.teamSet.compareRuns({
        classroomId,
        teamSetId,
        runRef: runNumber,
        otherRunRef: otherNumber,
        includePeople: true,
      })
    ).then(
      comparison => ({ comparison, refusal: null }),
      (error: unknown) => {
        if (isTeamSetError(error) && error.code === 'run_not_solved') {
          const view = teamsErrorView(error.code, error.details);
          return { comparison: null, refusal: { code: view.code, message: view.message } };
        }
        throw error;
      }
    ),
  ]);

  const grouped = await runsGrouped(
    teamSetId,
    runs.map(item => item.number)
  );
  if (!compared.comparison) {
    const payload: ComparePageData = {
      runs: runs.map(item => toRunListItem(item, grouped.get(item.number) ?? false)),
      runNumber,
      otherNumber,
      comparison: null,
      refusal: compared.refusal,
      grouped: false,
      ruleLabels: {},
    };
    return data(payload, { headers: NO_STORE });
  }
  const comparison = compared.comparison;

  await auditTeamSets(context, {
    action: 'VIEW',
    tool: 'teams.compare.view',
    resourceId: teamSetId,
    data: {
      team_set_id: teamSetId,
      run_number: runNumber,
      other_run_number: otherNumber,
      value: `${runNumber}:${otherNumber}`,
    },
  });

  return data(toComparePageData(runs, comparison, grouped), { headers: NO_STORE });
}

/**
 * A create as the poll sends it: counts and states only. No team name, no
 * person — who claimed it, who wasn't added, their GitHub logins — no tag and
 * no renames: the poll writes no audit row, so every name reaches the page
 * with a page load (the layout's, audited when it names members), and the
 * page lays these states over the rows it loaded (`liveCreate`).
 */
export function toCreatePollView(create: CreateProgressView): CreatePollView {
  return {
    status: create.status,
    run_number: create.run_number,
    attempt: create.attempt,
    total: create.total,
    done: create.done,
    counts: {
      teams_created: create.counts.teams_created,
      teams_failed: create.counts.teams_failed,
      members_added: create.counts.members_added,
      members_failed: create.counts.members_failed,
    },
    members_total: create.members_total,
    finished_at: create.finished_at,
    teams: create.teams.map(team => ({
      n: team.n,
      state: team.state,
      members_added: team.members_added,
      size: team.size,
      github_team: team.github_team,
      ...(team.failure !== undefined ? { failure: team.failure } : {}),
    })),
  };
}

/**
 * The status resource route (`status.ts`): what the set pages poll while a
 * run or a create moves. A plain JSON Response — the poll reads it with a bare
 * `fetch`, not through React Router's single-fetch protocol. The gate is the
 * whole wall here: the root loader doesn't run for a resource route. Names
 * nothing, so it writes no audit row (`toCreatePollView`).
 */
export async function loadSetStatus(args: TeamsRouteArgs): Promise<Response> {
  const context = await requireTeamSet(args, 'poll_team_set');
  const poll = await ClassmojiService.teamSet.pollStatus({
    classroomId: context.classroom.id,
    teamSetId: context.set.id,
  });
  const payload: SetStatusPayload = {
    latest_run: poll.latest_run
      ? { number: poll.latest_run.number, status: poll.latest_run.status }
      : null,
    create: poll.create ? toCreatePollView(poll.create) : null,
    signature: poll.signature,
  };
  return new Response(JSON.stringify(payload), {
    headers: { ...NO_STORE, 'Content-Type': 'application/json' },
  });
}

// ─── The set layout's action ────────────────────────────────────────────────

/**
 * The platform's classroom-status refusal (`{ error: CODE, message }`, 403):
 * its `message` is the sentence, its code the code.
 */
async function blockedFacts(blocked: Response): Promise<{ error: string; errorCode: string }> {
  try {
    const body = (await blocked.json()) as { error?: unknown; message?: unknown };
    if (typeof body.message === 'string' && typeof body.error === 'string') {
      return { error: body.message, errorCode: body.error };
    }
  } catch {
    // Not the JSON the platform sends; fall through to the generic sentence.
  }
  return { error: teamsErrorView('unknown').message, errorCode: 'unknown' };
}

/** Map a caught service refusal to action data; anything else is rethrown. */
function refusedBy(intent: SetIntent, error: unknown): SetActionData {
  const view = teamsErrorFrom(error);
  if (!view) throw error;
  return refusalData(intent, view);
}

/**
 * The ONE action behind every set page (`set.tsx`). Each intent gates itself,
 * in this order: staff (a non-staff caller's 403 is returned, not thrown),
 * owner for the create family (a refusal is audited ACCESS_DENIED), the
 * classroom-status gate for writes, the set, the payload — and only then the
 * service. Success answers `{ intent, ok }` (plus `preview` / `missedTeams`),
 * or redirects: `run` to the new run, `new-set-from-setup` to the new set.
 */
export async function setAction({ params, request }: TeamsRouteArgs) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const intent = intentOf(body);
  if (!intent) {
    const unknown = {
      intent: null,
      error: teamsErrorView('unknown').message,
      errorCode: 'unknown',
    };
    return data(unknown, { status: 400 });
  }

  let access: FormAdminContext;
  try {
    access = await assertFormAdmin(params.classroomSlug ?? '', request, {
      action: `team_set_${intent}`,
    });
  } catch (thrown) {
    if (thrown instanceof Response && thrown.status === 403) {
      // Not staff here (or not Pro): no role reaches the gate below.
      const refusal = intentRefusal(intent, null) ?? refusalData(intent, teamsErrorView('unknown'));
      return data(refusal, { status: 403 });
    }
    throw thrown;
  }

  const refused = intentRefusal(intent, access.membership.role);
  if (refused) {
    try {
      await ClassmojiService.audit.create({
        user_id: access.userId,
        classroom_id: access.classroom.id,
        role: access.membership.role,
        resource_type: TEAM_SETS_RESOURCE,
        resource_id: access.classroom.id,
        action: 'ACCESS_DENIED',
        data: {
          // The tool joins the audit dedup key, so refusals of different
          // intents inside the window each get their own row.
          tool: `teams.set.${intent}`,
          attempted_action: `team_set_${intent}`,
          required_roles: ['OWNER'],
          has_membership: true,
          denial_reasons: ['insufficient_role'],
          form_slug: params.formSlug ?? null,
          team_set: params.setSlug ?? null,
        },
      });
    } catch (error) {
      console.error('[teams] could not write the access-denied audit row', error);
    }
    return data(refused, { status: 403 });
  }

  if (WRITE_INTENTS.has(intent)) {
    const blocked = formMutationBlocked(access.classroom, access.membership.role);
    if (blocked) {
      return data({ intent, ...(await blockedFacts(blocked)) } satisfies SetActionData, {
        status: 403,
      });
    }
  }

  const form = await formFor(access, params.formSlug);
  const context = form ? await setFor(form, params.setSlug) : null;
  if (!context) {
    return data(refusalData(intent, teamsErrorView('not_found')), { status: 404 });
  }

  const parsed = setIntentPayload(intent, body);
  if (!parsed.ok) return data(refusalData(intent, parsed.view), { status: 400 });

  try {
    return await runIntent(context, intent, parsed.payload);
  } catch (error) {
    return data(refusedBy(intent, error));
  }
}

async function runIntent(
  context: TeamSetPageContext,
  intent: SetIntent,
  payload: SetIntentPayloads[SetIntent]
) {
  const service = ClassmojiService.teamSet;
  const classroomId = context.classroom.id;
  const formId = context.form.id;
  const teamSetId = context.set.id;
  const userId = context.userId;

  switch (intent) {
    case 'patch': {
      const { patch } = payload as SetIntentPayloads['patch'];
      await service.saveConfig({
        classroomId,
        formId,
        setRef: teamSetId,
        patch: patch as TeamSetConfigPatchInput,
        userId,
        via: 'page',
      });
      await auditTeamSets(context, {
        action: 'UPDATE',
        tool: 'teams.set.patch',
        resourceId: teamSetId,
        data: {
          team_set_id: teamSetId,
          patched: Object.keys(patch as Record<string, unknown>),
          value: fingerprintOf(patch),
        },
      });
      return data({ intent, ok: true } satisfies SetActionData);
    }

    case 'run': {
      const { run, issues } = await service.startRun({ classroomId, teamSetId, userId });
      if (!run) {
        const lines = issues.map(toCheckLine);
        // The refusal lists the checks that stopped the run with the people
        // each names, as Setup's Checks card does: audited like that card.
        if (checkLinesNamePeople(lines)) {
          await auditTeamSets(context, {
            action: 'VIEW',
            tool: 'teams.set.run_refused',
            resourceId: teamSetId,
            data: {
              team_set_id: teamSetId,
              people_in: ['checks'],
              value: fingerprintOf(lines),
            },
          });
        }
        return data({
          ...refusalData(intent, teamsErrorView('checks_failed')),
          issues: lines,
        } satisfies SetActionData);
      }
      await auditTeamSets(context, {
        action: 'CREATE',
        tool: 'teams.set.run',
        resourceId: run.id,
        data: { team_set_id: teamSetId, run_number: run.number },
      });
      return redirect(runPath(context.paths, run.number));
    }

    case 'discard': {
      const { runNumber } = payload as SetIntentPayloads['discard'];
      const target =
        runNumber ??
        (await service.listRuns({ classroomId, teamSetId, limit: 1 }))[0]?.number ??
        null;
      if (target === null) return data(refusalData(intent, teamsErrorView('not_found')));
      const { notes } = await service.revertToRun({
        classroomId,
        teamSetId,
        runRef: target,
        userId,
        via: 'page',
      });
      await auditTeamSets(context, {
        action: 'UPDATE',
        tool: 'teams.set.discard',
        resourceId: teamSetId,
        data: { team_set_id: teamSetId, run_number: target, value: target },
      });
      // What the run's setup had that the restore left out, as the service words it.
      return data({
        intent,
        ok: true,
        ...(notes.length > 0 ? { notes } : {}),
      } satisfies SetActionData);
    }

    case 'preview-create': {
      const { runNumber } = payload as SetIntentPayloads['preview-create'];
      const preview = await service.previewCreate({
        classroomId,
        teamSetId,
        runRef: runNumber,
        githubTeams: true,
      });
      return data({ intent, ok: true, preview: toPreviewView(preview) } satisfies SetActionData);
    }

    case 'create': {
      const { runNumber } = payload as SetIntentPayloads['create'];
      await service.claimCreate({
        classroomId,
        teamSetId,
        runId: String(runNumber),
        userId,
        githubTeams: true,
      });
      await auditTeamSets(context, {
        action: 'CREATE',
        tool: 'teams.set.create',
        resourceId: teamSetId,
        data: { team_set_id: teamSetId, name: context.set.name, run_number: runNumber },
      });
      return data({ intent, ok: true } satisfies SetActionData);
    }

    case 'retry-create': {
      // Resume the create that failed: the same run, whose made teams are kept.
      const state = context.set.create_state;
      if (!state || state.status !== 'FAILED') {
        const code =
          state?.status === 'RUNNING'
            ? 'create_in_progress'
            : state
              ? 'already_created'
              : 'unknown';
        return data(
          refusalData(
            intent,
            teamsErrorView(
              code,
              state ? { run_number: state.run_number, status: state.status } : {}
            )
          )
        );
      }
      await service.claimCreate({
        classroomId,
        teamSetId,
        runId: state.run_id,
        userId,
        githubTeams: true,
      });
      await auditTeamSets(context, {
        action: 'CREATE',
        tool: 'teams.set.retry_create',
        resourceId: teamSetId,
        data: {
          team_set_id: teamSetId,
          name: context.set.name,
          run_number: state.run_number,
          value: (state.attempt ?? 1) + 1,
        },
      });
      return data({ intent, ok: true } satisfies SetActionData);
    }

    case 'reveal-identity': {
      // "Show which": the teams an identity rule missed on, by number and
      // name — never whose answer. Asked for explicitly, and audited.
      const { runNumber } = payload as SetIntentPayloads['reveal-identity'];
      const missed = await service.identityMissedTeams({
        classroomId,
        teamSetId,
        runRef: runNumber,
      });
      await auditTeamSets(context, {
        action: 'VIEW',
        tool: 'teams.run.identity_missed',
        resourceId: teamSetId,
        data: {
          team_set_id: teamSetId,
          run_number: runNumber,
          teams: missed.length,
          value: runNumber,
        },
      });
      return data({
        intent,
        ok: true,
        missedTeams: missed.map(team => ({ n: team.n, name: team.name })),
      } satisfies SetActionData);
    }

    case 'new-set-from-setup': {
      const { name } = payload as SetIntentPayloads['new-set-from-setup'];
      // A name the form already has is the service's refusal (`name_taken`,
      // with the name), answered through refusedBy like any other.
      const created = await service.newSetFromSetup({
        classroomId,
        formId,
        fromSetRef: teamSetId,
        ...(name !== undefined ? { name } : {}),
        userId,
        via: 'page',
      });
      await auditTeamSets(context, {
        action: 'CREATE',
        tool: 'teams.set.new_from_setup',
        resourceId: created.id,
        data: { team_set_id: created.id, name: created.name, from_team_set_id: teamSetId },
      });
      return redirect(
        teamSetPaths({
          classroomSlug: context.classroom.slug,
          formSlug: context.form.slug,
          setName: created.name,
        }).set
      );
    }
  }
}

// ─── The sets list's action ─────────────────────────────────────────────────

/** What the list's action answers when it does not redirect. */
export interface ListActionData {
  intent: 'new-set' | null;
  error: string;
  errorCode: string;
}

const listRefusal = (
  view: TeamsErrorView,
  intent: 'new-set' | null = 'new-set'
): ListActionData => ({
  intent,
  error: view.message,
  errorCode: view.code,
});

/**
 * The sets list's action (`list.tsx`): `new-set` with an optional `name`
 * (default: the suggestion's, made free). A name another set on the form
 * already has is refused (`name_taken`) rather than opened — saveConfig with
 * an existing name updates that set. Redirects to the new set's Setup.
 */
export async function listAction({ params, request }: TeamsRouteArgs) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (!isRecord(body) || body.intent !== 'new-set') {
    return data(listRefusal(teamsErrorView('unknown'), null), { status: 400 });
  }

  let access: FormAdminContext;
  try {
    access = await assertFormAdmin(params.classroomSlug ?? '', request, { action: 'team_set_new' });
  } catch (thrown) {
    if (thrown instanceof Response && thrown.status === 403) {
      return data(listRefusal(teamsErrorView('unknown')), { status: 403 });
    }
    throw thrown;
  }
  const blocked = formMutationBlocked(access.classroom, access.membership.role);
  if (blocked) {
    return data({ intent: 'new-set', ...(await blockedFacts(blocked)) } satisfies ListActionData, {
      status: 403,
    });
  }

  const context = await formFor(access, params.formSlug);
  if (!context) return data(listRefusal(teamsErrorView('not_found')), { status: 404 });
  if (context.form.access !== 'CLASSROOM') {
    return data(listRefusal(teamsErrorView('form_not_classroom')));
  }

  const typed = body.name;
  if (
    typed !== undefined &&
    typed !== null &&
    (typeof typed !== 'string' || typed.length > MAX_NAME_INPUT)
  ) {
    return data(listRefusal(teamsErrorView('invalid_config')), { status: 400 });
  }

  const classroomId = context.classroom.id;
  const formId = context.form.id;
  try {
    const taken = new Set(
      (await ClassmojiService.teamSet.listForForm({ classroomId, formId })).map(row => row.name)
    );
    let name: string;
    if (typeof typed === 'string' && typed.trim() !== '') {
      name = normalizedSetName(typed);
      if (name === '') return data(listRefusal(teamsErrorView('set_name_empty')));
      if (taken.has(name)) return data(listRefusal(teamsErrorView('name_taken', { name })));
    } else {
      const suggestion = await ClassmojiService.teamSet.suggestForForm({ classroomId, formId });
      name = freeSetName(normalizedSetName(suggestion.name), taken);
    }

    const saved = await ClassmojiService.teamSet.saveConfig({
      classroomId,
      formId,
      name,
      userId: context.userId,
      via: 'page',
    });
    await auditTeamSets(context, {
      action: 'CREATE',
      tool: 'teams.list.new_set',
      resourceId: saved.id,
      data: { team_set_id: saved.id, name: saved.name },
    });
    return redirect(
      teamSetPaths({
        classroomSlug: context.classroom.slug,
        formSlug: context.form.slug,
        setName: saved.name,
      }).set
    );
  } catch (error) {
    const view = teamsErrorFrom(error);
    if (!view) throw error;
    return data(listRefusal(view));
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
