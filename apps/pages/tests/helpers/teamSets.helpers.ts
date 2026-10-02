import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { UNSAFE_decodeViaTurboStream as decodeViaTurboStream } from 'react-router';
// Types only — erased at runtime. The services package constructs its
// PrismaClient at import, so every VALUE comes from `servicesModule()`, after
// `getTestPrisma` has resolved DATABASE_URL (see getTestServices).
import type {
  CreateState,
  SolverOutput,
  TeamSetConfigPatchInput,
  TeamSetRunRow,
} from '@classmoji/services';

import { getPagesBaseURL } from './env.helpers';
import { getTestPrisma } from './prisma.helpers';

/**
 * Team sets E2E fixtures: a classroom of its own with a project-bidding form,
 * a roster that answered it (and two who didn't), team sets, runs in every
 * status and create states — all written through the service's own paths.
 *
 * ── Why a classroom of its own ─────────────────────────────────────────────
 * A run's staleness snapshot is the form's revision, every roster response and
 * the roster itself. In the shared seeded classroom any other suite that adds
 * a student or submits a form would make every seeded run stale mid-test. So
 * each spec gets a classroom, a GitHub organization row and users of its own,
 * named from a deterministic `key` (one per spec file): parallel specs never
 * touch each other's rows, and a run interrupted halfway is swept by the next
 * `createTeamsFixture` with the same key. Deleting the organization cascades
 * to the classroom and from there to the form, its responses, the team sets,
 * their runs, and every audit row the server wrote while the spec ran.
 *
 * The organization has NO GitHub installation by default, so an owner's
 * `preview-create` answers `github_unavailable` at once and nothing here can
 * reach GitHub. Pass `githubInstallationId` to point it at a real one.
 *
 * ── How runs are seeded ────────────────────────────────────────────────────
 * Exactly as `startRun` inserts one — the set's config with the
 * non_respondents mode the compile used, `compileProblem` over
 * `loadInputs()`, `loadInputs().snapshot` as the staleness inputs, the check
 * warnings in `diagnostics` — except that it is written RUNNING and never
 * handed to Trigger. A solved or infeasible run is then finished by the real
 * local engine (`packages/tasks/python`, one worker, a fixed seed, so repeat
 * runs give the same teams) and recorded by `completeRun`, which rescores the
 * answer and computes the metrics as it does for a live solve. A seeded
 * SOLVED run is therefore not stale until a response or the roster changes
 * (`editResponseAfterRuns`).
 *
 * Expiry is lazy and real: a RUNNING run is expired as `lost` ten minutes
 * after it started, a QUEUED one as `queue_expired` fifteen minutes after it
 * was created, a RUNNING create thirty-five minutes after its heartbeat.
 *
 * ── Identity answers ───────────────────────────────────────────────────────
 * The form carries the Gender preset's two identity questions. The
 * self-description answers (`fixture.identity.texts`) are unique strings that
 * no staff page may ever serve; the multiselect's option labels
 * (`fixture.identity.labels`) legitimately appear on Setup as class counts,
 * and nowhere next to a person.
 *
 * Names are invented and product-general (no course names).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../../..');
const ENGINE_PYTHON = path.join(REPO_ROOT, 'packages/tasks/python/.venv/bin/python');
const ENGINE_SCRIPT = path.join(REPO_ROOT, 'packages/tasks/python/team_set_solver.py');

const execFileAsync = promisify(execFile);

// ─── Public shapes ──────────────────────────────────────────────────────────

/** Who signs in: the classroom's owner, a teacher, an assistant, or a student who answered. */
export type TeamsRole = 'owner' | 'teacher' | 'assistant' | 'student';

export interface TeamsPerson {
  /** Fixture-local key: 'owner', 'teacher', 'assistant', 's01' … 's12'. */
  key: string;
  id: string;
  name: string;
  login: string;
}

export interface TeamsStudent extends TeamsPerson {
  /** false for the two roster students who never answered (s11, s12). */
  responded: boolean;
}

/** The project options, in form order. */
export const TEAMS_PROJECTS = [
  'Project Aster',
  'Project Birch',
  'Project Cedar',
  'Project Dune',
] as const;
export type TeamsProject = (typeof TEAMS_PROJECTS)[number];

/** The identity multiselect's options (the Gender preset's). */
export const TEAMS_IDENTITY_LABELS = [
  'Woman',
  'Man',
  'Non-binary',
  'Prefer to self-describe',
  'Prefer not to say',
] as const;

/** The priority dropdown's options (the Project bidding preset's). */
export const TEAMS_PRIORITY_LABELS = ['The project', 'The people', 'Both equally'] as const;

/** Route ids for single-fetch `.data?_routes=` requests (see `teamsDataUrl`). */
export const TEAMS_ROUTE_IDS = {
  list: 'forms/admin/teams/list',
  layout: 'team-set',
  setup: 'forms/admin/teams/setup',
  run: 'forms/admin/teams/run',
  compare: 'forms/admin/teams/compare',
} as const;

/** One set's URLs (paths, relative to the pages base URL). */
export interface TeamsSetPaths {
  /** The set layout + Setup (index). */
  set: string;
  /** The set layout's action (every set intent posts here, single fetch). */
  action: string;
  /** The status resource route (JSON). */
  status: string;
  run: (n: number) => string;
  compare: (n: number, m: number) => string;
}

export interface TeamsFixture {
  key: string;
  classroom: { id: string; slug: string; name: string };
  gitOrgId: string;
  staff: { owner: TeamsPerson; teacher: TeamsPerson; assistant: TeamsPerson };
  /** The whole roster, s01 … s12; s11 and s12 didn't answer. */
  students: TeamsStudent[];
  /** The 'student' role: s01, who answered. */
  student: TeamsStudent;
  form: { id: string; slug: string; title: string; revisionId: string };
  /** Field ids of the form's questions. */
  fields: {
    pitched: string;
    ranked: string;
    together: string;
    apart: string;
    priority: string;
    notes: string;
    identity: string;
    selfDescription: string;
  };
  /** Option ids by label. */
  options: {
    projects: Record<TeamsProject, string>;
    identity: Record<(typeof TEAMS_IDENTITY_LABELS)[number], string>;
    priority: Record<(typeof TEAMS_PRIORITY_LABELS)[number], string>;
  };
  identity: {
    /** The identity multiselect's option labels (Setup shows these as class counts only). */
    labels: readonly string[];
    /** Every self-description answer: must never appear in a served page or payload. */
    texts: string[];
  };
  paths: {
    /** The form's team sets list. */
    list: string;
    /** The list's action (`new-set`, single fetch). */
    listAction: string;
    set: (name: string) => TeamsSetPaths;
  };
  /** Session tokens minted for this fixture; `cleanupTeamsFixture` deletes them. */
  sessionTokens: string[];
}

export interface SeededSet {
  id: string;
  name: string;
  paths: TeamsSetPaths;
}

export interface SeededRun {
  id: string;
  number: number;
  status: TeamSetRunRow['status'];
}

// ─── Roster and answers ─────────────────────────────────────────────────────

interface StudentSeed {
  key: string;
  name: string;
  /** Absent = didn't answer. First, second, third choice. */
  ranks?: [TeamsProject, TeamsProject, TeamsProject];
  identity?: (typeof TEAMS_IDENTITY_LABELS)[number][];
  selfDescription?: boolean;
  priority?: (typeof TEAMS_PRIORITY_LABELS)[number];
  pitched?: TeamsProject;
  together?: string[];
  apart?: string[];
  note?: string;
}

/**
 * Ten answers, two non-respondents. Four first picks of Aster, three of Birch,
 * two of Cedar, one of Dune; one mutual together request (s01 ↔ s02), two
 * one-way ones, one apart request; two pitchers; one single-answer identity
 * group (the identity_single_answer warning); two notes.
 */
const ROSTER: StudentSeed[] = [
  {
    key: 's01',
    name: 'Avery Quill',
    ranks: ['Project Aster', 'Project Birch', 'Project Cedar'],
    identity: ['Woman'],
    priority: 'The project',
    pitched: 'Project Aster',
    together: ['s02'],
    note: 'Free most evenings.',
  },
  {
    key: 's02',
    name: 'Blake Rowan',
    ranks: ['Project Aster', 'Project Cedar', 'Project Birch'],
    identity: ['Man'],
    priority: 'The people',
    together: ['s01'],
  },
  {
    key: 's03',
    name: 'Casey Thorne',
    ranks: ['Project Aster', 'Project Birch', 'Project Dune'],
    identity: ['Woman'],
    priority: 'Both equally',
    apart: ['s10'],
  },
  {
    key: 's04',
    name: 'Devon Marsh',
    ranks: ['Project Birch', 'Project Aster', 'Project Cedar'],
    identity: ['Man'],
    together: ['s05'],
  },
  {
    key: 's05',
    name: 'Emery Vale',
    ranks: ['Project Birch', 'Project Cedar', 'Project Aster'],
    identity: ['Non-binary'],
    selfDescription: true,
  },
  {
    key: 's06',
    name: 'Finley Crane',
    ranks: ['Project Cedar', 'Project Dune', 'Project Aster'],
    identity: ['Woman'],
    priority: 'The project',
    pitched: 'Project Cedar',
  },
  {
    key: 's07',
    name: 'Gray Holloway',
    ranks: ['Project Cedar', 'Project Aster', 'Project Birch'],
    identity: ['Man'],
    together: ['s03'],
  },
  {
    key: 's08',
    name: 'Harper Lind',
    ranks: ['Project Dune', 'Project Cedar', 'Project Birch'],
    identity: ['Prefer not to say'],
    note: 'A team that can meet online suits me.',
  },
  {
    key: 's09',
    name: 'Indigo Park',
    ranks: ['Project Aster', 'Project Dune', 'Project Birch'],
    identity: ['Woman', 'Prefer to self-describe'],
    selfDescription: true,
    priority: 'The people',
  },
  {
    key: 's10',
    name: 'Jules Arden',
    ranks: ['Project Birch', 'Project Dune', 'Project Cedar'],
    identity: ['Man'],
  },
  { key: 's11', name: 'Kai Bellamy' },
  { key: 's12', name: 'Lane Mercer' },
];

const STAFF: Record<'owner' | 'teacher' | 'assistant', { name: string; role: string }> = {
  owner: { name: 'Morgan Oakes', role: 'OWNER' },
  teacher: { name: 'Riley Stone', role: 'TEACHER' },
  assistant: { name: 'Sage Whitfield', role: 'ASSISTANT' },
};

/** The form's title (the Project bidding preset's suggested title). */
const FORM_TITLE = 'Project Bidding';

/**
 * Every set the helpers make starts from the service's own suggestion plus
 * this: teams of 3–4 over four projects, one team per project, so twelve
 * people fit three or four teams.
 */
export const TEAMS_DEFAULT_SET_PATCH: TeamSetConfigPatchInput = {
  team_size: { min: 3, max: 4 },
};

// ─── Identifiers derived from the key ───────────────────────────────────────

const slugOf = (key: string) => `zz-e2e-teams-${key}`;
const loginOf = (key: string, person: string) => `${slugOf(key)}-${person}`;
const personKeys = () => ['owner', 'teacher', 'assistant', ...ROSTER.map(s => s.key)];
const selfDescriptionOf = (key: string, student: string) =>
  `${slugOf(key)}-self-description-${student}`;

function setPaths(base: string, name: string): TeamsSetPaths {
  const set = `${base}/${encodeURIComponent(name)}`;
  return {
    set,
    action: `${set}.data`,
    status: `${set}/status`,
    run: n => `${set}/runs/${n}`,
    compare: (n, m) => `${set}/runs/${n}/compare/${m}`,
  };
}

/** A single-fetch data URL for one route's loader: `<path>.data?_routes=<routeId>`. */
export function teamsDataUrl(pathname: string, routeId: string): string {
  return `${pathname}.data?_routes=${encodeURIComponent(routeId)}`;
}

async function servicesModule() {
  await getTestPrisma();
  return import('@classmoji/services');
}

// ─── Fixture ────────────────────────────────────────────────────────────────

/**
 * Remove whatever a fixture with this key left behind (an interrupted run):
 * its organization (cascading to the classroom and everything in it), a
 * classroom that kept its slug, and its users (cascading to their sessions
 * and subscriptions). Safe to call when nothing is there.
 */
export async function removeTeamsFixture(key: string): Promise<void> {
  const prisma = await getTestPrisma();
  const slug = slugOf(key);
  await prisma.gitOrganization.deleteMany({ where: { provider: 'GITHUB', provider_id: slug } });
  await prisma.classroom.deleteMany({ where: { slug } });
  await prisma.user.deleteMany({
    where: {
      accounts: {
        some: {
          provider_id: 'github',
          username: { in: personKeys().map(person => loginOf(key, person)) },
        },
      },
    },
  });
}

/**
 * A classroom with a PUBLISHED CLASSROOM project-bidding form and its answers.
 *
 * Owner (with a Pro subscription, so the forms gate opens), teacher, assistant
 * and twelve roster students s01–s12; s01–s10 answered, s11 and s12 didn't.
 * The form: the pitched-project dropdown (`options_from` the ranked question),
 * ranked projects (3 ranks of 4), who to work with, who not to, what matters
 * more, anything else, and the Gender preset's two identity questions.
 *
 * `key` names every row (use one per spec file, e.g. 'auth', 'run'); a
 * previous fixture with the same key is removed first.
 */
export async function createTeamsFixture({
  key,
  githubInstallationId = null,
}: {
  key: string;
  /** The organization's GitHub App installation; null keeps every create path off GitHub. */
  githubInstallationId?: string | null;
}): Promise<TeamsFixture> {
  if (!/^[a-z0-9-]{1,24}$/.test(key)) {
    throw new Error(`fixture key '${key}' must be 1–24 of a-z, 0-9, '-'`);
  }
  await removeTeamsFixture(key);
  const prisma = await getTestPrisma();
  const { ClassmojiService } = await servicesModule();
  const slug = slugOf(key);

  const org = await prisma.gitOrganization.create({
    data: {
      provider: 'GITHUB',
      provider_id: slug,
      login: slug,
      github_installation_id: githubInstallationId,
    },
  });
  const classroomName = `ZZ E2E Teams ${key}`;
  const classroom = await prisma.classroom.create({
    data: {
      slug,
      name: classroomName,
      git_org_id: org.id,
      content_namespace: slug,
      content_repo: `content-${slug}`,
    },
  });

  const makeUser = async (person: string, name: string): Promise<TeamsPerson> => {
    const login = loginOf(key, person);
    const user = await prisma.user.create({
      data: {
        name,
        email: `${login}@example.test`,
        accounts: { create: { provider_id: 'github', account_id: login, username: login } },
      },
    });
    return { key: person, id: user.id, name, login };
  };

  const staff = {
    owner: await makeUser('owner', STAFF.owner.name),
    teacher: await makeUser('teacher', STAFF.teacher.name),
    assistant: await makeUser('assistant', STAFF.assistant.name),
  };
  await prisma.subscription.create({ data: { user_id: staff.owner.id, tier: 'PRO' } });
  for (const role of ['owner', 'teacher', 'assistant'] as const) {
    await prisma.classroomMembership.create({
      data: {
        classroom_id: classroom.id,
        user_id: staff[role].id,
        role: STAFF[role].role as 'OWNER' | 'TEACHER' | 'ASSISTANT',
        has_accepted_invite: true,
      },
    });
  }

  const students: TeamsStudent[] = [];
  for (const seed of ROSTER) {
    const person = await makeUser(seed.key, seed.name);
    await prisma.classroomMembership.create({
      data: {
        classroom_id: classroom.id,
        user_id: person.id,
        role: 'STUDENT',
        has_accepted_invite: true,
      },
    });
    students.push({ ...person, responded: seed.ranks !== undefined });
  }
  const byKey = new Map(students.map(s => [s.key, s]));

  // The form, as the Project bidding + Gender presets build it. Roster
  // questions are materialized from the STUDENT memberships at publish.
  const rankedId = randomUUID();
  const draft = await ClassmojiService.form.create({
    classroomId: classroom.id,
    title: FORM_TITLE,
    access: 'CLASSROOM',
    createdBy: staff.owner.id,
    fields: [
      {
        type: 'dropdown',
        label: 'Did you pitch one of these projects? If so, which one?',
        required: false,
        options_from: rankedId,
      },
      {
        id: rankedId,
        type: 'ranked_choice',
        label: "Rank the projects you'd like to work on",
        required: true,
        options: [...TEAMS_PROJECTS],
        ranks: 3,
      },
      {
        type: 'roster_select',
        label: 'Who would you like to work with?',
        required: false,
        optionSource: 'roster',
        multiple: true,
      },
      {
        type: 'roster_select',
        label: "Anyone you'd rather not work with?",
        required: false,
        optionSource: 'roster',
        multiple: true,
      },
      {
        type: 'dropdown',
        label: 'What matters more to you?',
        required: false,
        options: [...TEAMS_PRIORITY_LABELS],
      },
      { type: 'long_text', label: 'Anything else we should know?', required: false },
      {
        type: 'multiselect',
        label: 'How do you describe your gender?',
        required: false,
        options: TEAMS_IDENTITY_LABELS.map(label =>
          label === 'Prefer not to say' ? { label, exclusive: true } : label
        ),
        identity_question: true,
      },
      {
        type: 'short_text',
        label: "If you'd like, describe it in your own words",
        required: false,
        identity_question: true,
      },
    ],
  });
  const { revision } = await ClassmojiService.form.publish(draft.id);
  const published = ClassmojiService.form.fieldsOf(revision.fields) as unknown as {
    id: string;
    type: string;
    label: string;
    options?: { id: string; label: string }[];
  }[];
  const [pitched, ranked, together, apart, priority, notes, identity, selfDescription] = published;
  if (!selfDescription || ranked?.id !== rankedId) {
    throw new Error('the published form does not have the fields the fixture wrote');
  }
  const optionIds = <L extends string>(
    field: { options?: { id: string; label: string }[] },
    labels: readonly L[]
  ): Record<L, string> => {
    const out = {} as Record<L, string>;
    for (const label of labels) {
      const option = field.options?.find(o => o.label === label);
      if (!option) throw new Error(`option '${label}' missing from the published form`);
      out[label] = option.id;
    }
    return out;
  };
  const options = {
    projects: optionIds(ranked, TEAMS_PROJECTS),
    identity: optionIds(identity!, TEAMS_IDENTITY_LABELS),
    priority: optionIds(priority!, TEAMS_PRIORITY_LABELS),
  };

  const texts: string[] = [];
  for (const seed of ROSTER) {
    if (!seed.ranks) continue;
    const student = byKey.get(seed.key)!;
    const answers: Record<string, unknown> = {
      [ranked.id]: seed.ranks.map(label => options.projects[label]),
    };
    if (seed.pitched) answers[pitched!.id] = options.projects[seed.pitched];
    if (seed.together) answers[together!.id] = seed.together.map(k => byKey.get(k)!.id);
    if (seed.apart) answers[apart!.id] = seed.apart.map(k => byKey.get(k)!.id);
    if (seed.priority) answers[priority!.id] = options.priority[seed.priority];
    if (seed.note) answers[notes!.id] = seed.note;
    if (seed.identity) answers[identity!.id] = seed.identity.map(l => options.identity[l]);
    if (seed.selfDescription) {
      const text = selfDescriptionOf(key, seed.key);
      texts.push(text);
      answers[selfDescription.id] = text;
    }
    await ClassmojiService.formResponse.submitClassroom({
      formId: draft.id,
      userId: student.id,
      email: `${student.login}@example.test`,
      name: student.name,
      answers,
      revisionId: revision.id,
    });
  }

  const form = await prisma.form.findUniqueOrThrow({
    where: { id: draft.id },
    select: { id: true, slug: true, title: true },
  });
  const list = `/${slug}/forms/${form.slug}/teams`;
  return {
    key,
    classroom: { id: classroom.id, slug, name: classroomName },
    gitOrgId: org.id,
    staff,
    students,
    student: byKey.get('s01')!,
    form: { ...form, revisionId: revision.id },
    fields: {
      pitched: pitched!.id,
      ranked: ranked.id,
      together: together!.id,
      apart: apart!.id,
      priority: priority!.id,
      notes: notes!.id,
      identity: identity!.id,
      selfDescription: selfDescription.id,
    },
    options,
    identity: { labels: TEAMS_IDENTITY_LABELS, texts },
    paths: {
      list,
      listAction: `${list}.data`,
      set: name => setPaths(list, name),
    },
    sessionTokens: [],
  };
}

/**
 * Another form in the fixture's classroom, for the list page's fact lines: a
 * PUBLIC form (no team sets) or an unpublished CLASSROOM form. One short-text
 * question; no responses. Removed with the fixture.
 */
export async function createExtraForm(
  fixture: TeamsFixture,
  {
    access,
    published,
    title,
  }: { access: 'PUBLIC' | 'CLASSROOM'; published: boolean; title: string }
): Promise<{ id: string; slug: string; teamsPath: string }> {
  const prisma = await getTestPrisma();
  const { ClassmojiService } = await servicesModule();
  const form = await ClassmojiService.form.create({
    classroomId: fixture.classroom.id,
    title,
    access,
    createdBy: fixture.staff.owner.id,
    fields: [{ type: 'short_text', label: 'Your idea in one line', required: false }],
  });
  if (published) await ClassmojiService.form.publish(form.id);
  const row = await prisma.form.findUniqueOrThrow({
    where: { id: form.id },
    select: { id: true, slug: true },
  });
  return { ...row, teamsPath: `/${fixture.classroom.slug}/forms/${row.slug}/teams` };
}

/**
 * Delete everything the fixture made: the sessions it minted, then the
 * organization (cascading to the classroom, the forms and responses, the team
 * sets and runs, and every audit row the server wrote for the classroom),
 * then its users. Best-effort per step, so one failure doesn't strand the rest.
 */
export async function cleanupTeamsFixture(fixture: TeamsFixture | null | undefined): Promise<void> {
  if (!fixture) return;
  const prisma = await getTestPrisma();
  const steps: (() => Promise<unknown>)[] = [
    () => prisma.session.deleteMany({ where: { token: { in: fixture.sessionTokens } } }),
    () => prisma.gitOrganization.deleteMany({ where: { id: fixture.gitOrgId } }),
    () => prisma.classroom.deleteMany({ where: { id: fixture.classroom.id } }),
    () =>
      prisma.user.deleteMany({
        where: {
          id: {
            in: [
              fixture.staff.owner.id,
              fixture.staff.teacher.id,
              fixture.staff.assistant.id,
              ...fixture.students.map(s => s.id),
            ],
          },
        },
      }),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.warn(`[tests] team sets fixture '${fixture.key}' cleanup step failed`, error);
    }
  }
  fixture.sessionTokens.length = 0;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

const personFor = (fixture: TeamsFixture, role: TeamsRole): TeamsPerson =>
  role === 'student' ? fixture.student : fixture.staff[role];

/**
 * A Better Auth session for one of the fixture's people, as `/test-login`
 * makes one (the `loginAsLogin` idiom). The token is recorded on the fixture
 * and deleted by `cleanupTeamsFixture`.
 */
export async function mintTeamsSession(fixture: TeamsFixture, role: TeamsRole): Promise<string> {
  const prisma = await getTestPrisma();
  const token = randomUUID();
  await prisma.session.create({
    data: {
      token,
      user_id: personFor(fixture, role).id,
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000),
      ip_address: '127.0.0.1',
      user_agent: 'playwright',
    },
  });
  fixture.sessionTokens.push(token);
  return token;
}

/** The request header that carries a session token (for a bare `request` context). */
export const teamsSessionHeader = (token: string): Record<string, string> => ({
  cookie: `classmoji.session_token=${token}`,
});

/**
 * Sign the page's browser context in as `role` (its cookies are replaced), or
 * out with `null`. `page.request` shares the context's cookies.
 */
export async function signInTeams(
  page: Page,
  fixture: TeamsFixture,
  role: TeamsRole | null
): Promise<void> {
  await page.context().clearCookies();
  if (role === null) return;
  const token = await mintTeamsSession(fixture, role);
  await page.context().addCookies([
    {
      name: 'classmoji.session_token',
      value: token,
      url: getPagesBaseURL(),
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

// ─── Single fetch ───────────────────────────────────────────────────────────

/**
 * Decode a single-fetch (`.data`) body — React Router's turbo-stream — into
 * the value the client would see: for a loader request
 * `{ [routeId]: { data } }`, for an action `{ data }` (a redirect is
 * `{ redirect, status, … }` under the React Router redirect symbol's place).
 */
export async function decodeSingleFetch(body: Buffer | string): Promise<unknown> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const decoded = await decodeViaTurboStream(stream, globalThis);
  await decoded.done;
  return decoded.value;
}

export interface TeamsResponse {
  status: number;
  headers: Record<string, string>;
  /** The raw body text (HTML, JSON, or turbo-stream). */
  text: string;
  /** The decoded single-fetch value for a `.data` URL; the parsed JSON for status; else null. */
  value: unknown;
}

async function readResponse(url: string, response: APIResponse): Promise<TeamsResponse> {
  const buffer = await response.body();
  const headers = response.headers();
  const text = buffer.toString('utf8');
  let value: unknown = null;
  const pathname = url.split('?')[0]!;
  if (pathname.endsWith('.data') && response.status() !== 302) {
    try {
      value = await decodeSingleFetch(buffer);
    } catch {
      value = null;
    }
  } else if ((headers['content-type'] ?? '').includes('application/json')) {
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
  }
  return { status: response.status(), headers, text, value };
}

/** GET a Teams URL without following redirects (the login hand-off goes to the webapp). */
export async function getTeams(request: APIRequestContext, url: string): Promise<TeamsResponse> {
  return readResponse(url, await request.get(url, { maxRedirects: 0 }));
}

/**
 * POST a JSON body to a Teams action URL (`paths.set(name).action` or
 * `paths.listAction`), as the page's fetchers do, without following redirects.
 * The action's own answer is `value.data` (`SetActionData` / `ListActionData`).
 */
export async function postTeams(
  request: APIRequestContext,
  url: string,
  body: unknown
): Promise<TeamsResponse> {
  return readResponse(
    url,
    await request.post(url, {
      data: body as Record<string, unknown>,
      headers: { 'content-type': 'application/json' },
      maxRedirects: 0,
    })
  );
}

// ─── Team sets ──────────────────────────────────────────────────────────────

/**
 * A new team set on the fixture's form, saved as the page's "New team set"
 * saves one: the service's suggestion for the form, then
 * TEAMS_DEFAULT_SET_PATCH, then `patch`. Stamped as the owner's, via 'page'.
 */
export async function createTeamSet(
  fixture: TeamsFixture,
  { name, patch }: { name: string; patch?: TeamSetConfigPatchInput }
): Promise<SeededSet> {
  const { ClassmojiService } = await servicesModule();
  const saved = await ClassmojiService.teamSet.saveConfig({
    classroomId: fixture.classroom.id,
    formId: fixture.form.id,
    name,
    patch: { ...TEAMS_DEFAULT_SET_PATCH, ...patch },
    userId: fixture.staff.owner.id,
    via: 'page',
  });
  return { id: saved.id, name: saved.name, paths: fixture.paths.set(saved.name) };
}

/** Save a patch to a set, as an autosave from the page does (by `by`, default the owner). */
export async function patchTeamSet(
  fixture: TeamsFixture,
  set: SeededSet,
  patch: TeamSetConfigPatchInput,
  by: TeamsRole = 'owner'
): Promise<void> {
  const { ClassmojiService } = await servicesModule();
  await ClassmojiService.teamSet.saveConfig({
    classroomId: fixture.classroom.id,
    formId: fixture.form.id,
    setRef: set.id,
    patch,
    userId: personFor(fixture, by).id,
    via: 'page',
  });
}

// ─── Runs ───────────────────────────────────────────────────────────────────

/**
 * Insert a run exactly as `startRun` does, minus Trigger: the set's config as
 * saved now with the non_respondents mode the compile used
 * (`compiled.non_respondents`: a default Group that can't seat the people who
 * didn't answer runs as Spread), the compiled problem and context,
 * `loadInputs().snapshot`, the check warnings. Refused like `startRun` when a
 * check fails at error level.
 */
async function insertRun(
  fixture: TeamsFixture,
  set: SeededSet,
  { status, by, seed }: { status: 'QUEUED' | 'RUNNING'; by: TeamsRole; seed: number }
): Promise<SeededRun> {
  const prisma = await getTestPrisma();
  const S = await servicesModule();
  const row = await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } });
  const config = S.TeamSetConfigSchema.parse(row.config);
  const inputs = await S.ClassmojiService.teamSet.loadInputs({
    classroomId: fixture.classroom.id,
    formId: fixture.form.id,
    config,
  });
  const compiled = S.compileProblem({
    setName: row.name,
    config,
    fields: inputs.fields,
    responses: inputs.responses,
    roster: inputs.roster,
    seed,
  });
  const issues = S.runChecks(compiled.problem, compiled.context, {
    config,
    fields: inputs.fields,
  });
  const errors = issues.filter(issue => issue.level === 'error');
  if (errors.length > 0) {
    throw new Error(
      `set '${set.name}' fails its checks, so no run can start: ${errors.map(e => e.code).join(', ')}`
    );
  }
  const last = await prisma.teamSetRun.aggregate({
    where: { team_set_id: set.id },
    _max: { number: true },
  });
  const now = new Date();
  const run = await prisma.teamSetRun.create({
    data: {
      team_set_id: set.id,
      number: (last._max.number ?? 0) + 1,
      status,
      config: { ...config, non_respondents: compiled.non_respondents } as object,
      problem: compiled.problem as unknown as object,
      context: compiled.context as unknown as object,
      inputs: inputs.snapshot as unknown as object,
      seed,
      engine: S.TEAM_SET_ENGINE,
      ...(issues.length > 0 ? { diagnostics: { issues } as unknown as object } : {}),
      created_by: personFor(fixture, by).id,
      ...(status === 'RUNNING' ? { started_at: now } : {}),
    },
  });
  return { id: run.id, number: run.number, status: run.status };
}

/** The local engine's answer for a stored run's problem (one worker, the problem's seed). */
async function solveLocally(problem: unknown): Promise<SolverOutput> {
  if (!fs.existsSync(ENGINE_PYTHON)) {
    throw new Error(
      `the local team-set engine is not installed (${ENGINE_PYTHON}); see packages/tasks/python/README.md`
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-e2e-'));
  const file = path.join(dir, 'problem.json');
  try {
    fs.writeFileSync(file, JSON.stringify(problem));
    const { stdout } = await execFileAsync(ENGINE_PYTHON, [ENGINE_SCRIPT, file, '--workers', '1'], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 150_000,
    });
    const result = stdout
      .split('\n')
      .map(line => {
        try {
          return JSON.parse(line) as { type?: string } & Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(line => line?.type === 'result')
      .at(-1);
    if (!result) throw new Error('the local engine printed no result line');
    const { type: _type, ...output } = result;
    return output as unknown as SolverOutput;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Solve a QUEUED/RUNNING run with the local engine and record it through `completeRun`. */
async function finishRun(runId: string): Promise<TeamSetRunRow> {
  const prisma = await getTestPrisma();
  const { ClassmojiService } = await servicesModule();
  const row = await prisma.teamSetRun.findUniqueOrThrow({
    where: { id: runId },
    select: { problem: true },
  });
  return ClassmojiService.teamSet.completeRun(runId, await solveLocally(row.problem));
}

/**
 * A SOLVED run of the set's current setup. `patch` is saved to the set first
 * (as Setup's autosave would, by `by`), so the run's config snapshot carries
 * it — e.g. a pin, to make the next run differ for Compare. Throws when the
 * engine doesn't solve it.
 */
export async function seedSolvedRun(
  fixture: TeamsFixture,
  set: SeededSet,
  {
    patch,
    by = 'owner',
    seed = 1,
  }: { patch?: TeamSetConfigPatchInput; by?: TeamsRole; seed?: number } = {}
): Promise<SeededRun> {
  if (patch) await patchTeamSet(fixture, set, patch, by);
  const run = await insertRun(fixture, set, { status: 'RUNNING', by, seed });
  const done = await finishRun(run.id);
  if (done.status !== 'SOLVED') {
    throw new Error(
      `run ${done.number} of '${set.name}' ended ${done.status} (${done.error ?? '-'})`
    );
  }
  return { id: done.id, number: done.number, status: done.status };
}

/**
 * Free teams: no grouping question. The rules that need teams made from a
 * question go with it (the rank and owner rules, and the priority rule that
 * weighs the rank rule), and team names are numbered. A run of such a set has
 * no picks or placements.
 */
export const TEAMS_FREE_PATCH = (fixture: TeamsFixture): TeamSetConfigPatchInput => ({
  grouping: { mode: 'free' },
  rules: {
    remove: [
      { field_id: fixture.fields.ranked, job: 'rank' },
      { field_id: fixture.fields.pitched, job: 'owner' },
      { field_id: fixture.fields.priority, job: 'priority' },
    ],
  },
  team_name_template: '{set}-{n}',
});

/**
 * The patch `seedInfeasibleRun` saves by default: everyone who answered must
 * get their first pick. With the fixture's answers that can't be met (Cedar
 * has two first picks, Dune one, and only two people who didn't answer to
 * fill teams of at least three), and the checks don't see it — only the
 * engine does, so the run has a real core naming the students.
 */
export const TEAMS_INFEASIBLE_PATCH = (fixture: TeamsFixture): TeamSetConfigPatchInput => ({
  rules: {
    upsert: [
      {
        field_id: fixture.fields.ranked,
        job: 'rank',
        strength: 'must',
        params: { must_top: 1 },
      },
    ],
  },
});

/**
 * An INFEASIBLE run with a non-empty core. Saves `patch` (default
 * TEAMS_INFEASIBLE_PATCH) to the set first, so the set's current setup IS
 * the one that can't be solved (no "changes since run" from it). Throws when
 * the engine solves it anyway or finds no core.
 */
export async function seedInfeasibleRun(
  fixture: TeamsFixture,
  set: SeededSet,
  {
    patch = TEAMS_INFEASIBLE_PATCH(fixture),
    by = 'owner',
    seed = 1,
  }: { patch?: TeamSetConfigPatchInput; by?: TeamsRole; seed?: number } = {}
): Promise<SeededRun & { core: string[] }> {
  await patchTeamSet(fixture, set, patch, by);
  const run = await insertRun(fixture, set, { status: 'RUNNING', by, seed });
  const done = await finishRun(run.id);
  const core = (done.diagnostics?.core ?? []).map(item => item.src);
  if (done.status !== 'INFEASIBLE' || core.length === 0) {
    throw new Error(
      `run ${done.number} of '${set.name}' ended ${done.status} with ${core.length} core items; expected INFEASIBLE with a core`
    );
  }
  return { id: done.id, number: done.number, status: done.status, core };
}

/**
 * A run that hasn't finished: RUNNING (started now; the Running steps) or
 * QUEUED. Nothing solves it — finish it with `finishActiveRun`, or leave it
 * (it blocks new runs of the set with `run_in_progress` until it expires).
 */
export async function seedActiveRun(
  fixture: TeamsFixture,
  set: SeededSet,
  {
    status = 'RUNNING',
    by = 'owner',
    seed = 1,
  }: { status?: 'RUNNING' | 'QUEUED'; by?: TeamsRole; seed?: number } = {}
): Promise<SeededRun> {
  return insertRun(fixture, set, { status, by, seed });
}

/**
 * Finish a seeded QUEUED/RUNNING run the way the solve task would: the local
 * engine's answer through `completeRun` (SOLVED or INFEASIBLE, as the setup
 * decides). For "the poll swaps Running for Results without a reload".
 */
export async function finishActiveRun(run: SeededRun): Promise<SeededRun> {
  const done = await finishRun(run.id);
  return { id: done.id, number: done.number, status: done.status };
}

/**
 * Change one answer (s01's note) after the runs were seeded, so every SOLVED
 * run of every set reads stale ("answers changed") and Create is refused.
 */
export async function editResponseAfterRuns(
  fixture: TeamsFixture,
  studentKey = 's01'
): Promise<void> {
  const prisma = await getTestPrisma();
  const student = fixture.students.find(s => s.key === studentKey);
  if (!student?.responded) throw new Error(`${studentKey} has no response to edit`);
  const response = await prisma.formResponse.findFirstOrThrow({
    where: { form_id: fixture.form.id, user_id: student.id },
  });
  const answers = { ...(response.answers as Record<string, unknown>) };
  answers[fixture.fields.notes] = `Edited after the runs (${randomUUID().slice(0, 8)}).`;
  await prisma.formResponse.update({
    where: { id: response.id },
    data: { answers: answers as object },
  });
}

// ─── Create states ──────────────────────────────────────────────────────────

export type TeamsCreateStatus = CreateState['status'];

/**
 * Write the set's create as the apply task leaves it, from a SOLVED run's
 * teams (names from the run's template), without making any team:
 *
 *   RUNNING  `teamsMade` (default 1) teams done, heartbeat now, unfinished.
 *   DONE     every team made with all its members.
 *   PARTIAL  every team made; team 1 is missing one member (members_failed).
 *   FAILED   `teamsMade` (default 1) teams made, the next one failed
 *            (provider_error). With `teamsMade: 0` the set is NOT locked
 *            (another run may be created); with ≥ 1 only this run can be retried.
 *
 * `created_run_id` is set to the run, as the claim does. Team ids are
 * invented (no Team rows exist); the Created screens don't read them.
 */
export async function writeCreateState(
  fixture: TeamsFixture,
  set: SeededSet,
  run: SeededRun,
  {
    status,
    teamsMade = 1,
    attempt = 1,
  }: { status: TeamsCreateStatus; teamsMade?: number; attempt?: number }
): Promise<CreateState> {
  const prisma = await getTestPrisma();
  const S = await servicesModule();
  const row = await prisma.teamSetRun.findUniqueOrThrow({ where: { id: run.id } });
  if (row.status !== 'SOLVED') throw new Error(`run ${row.number} is ${row.status}, not SOLVED`);
  const runConfig = row.config as unknown as Parameters<typeof S.teamNamesFor>[1];
  const teams = (
    row.result as unknown as { teams: { option_id: string | null; member_user_ids: string[] }[] }
  ).teams;
  const labels = new Map(
    Object.entries(fixture.options.projects).map(([label, id]) => [id, label] as [string, string])
  );
  const names = S.teamNamesFor(set.name, runConfig, teams, labels);
  const sizes = teams.map(team => team.member_user_ids.length);
  const total = teams.length;

  const made = status === 'DONE' || status === 'PARTIAL' ? total : Math.min(teamsMade, total);
  const madeTeams: CreateState['teams'] = names.slice(0, made).map((name, i) => ({
    team_id: randomUUID(),
    name,
    n: i + 1,
    members_added: sizes[i]!,
  }));
  const failed: CreateState['failed'] = [];
  if (status === 'PARTIAL' && madeTeams[0]) {
    const missing = teams[0]!.member_user_ids[0]!;
    const login = fixture.students.find(s => s.id === missing)?.login ?? null;
    madeTeams[0].members_added = sizes[0]! - 1;
    failed.push({
      team: names[0]!,
      reason: 'members_failed',
      members: [{ user_id: missing, login, reason: 'github_user_not_found' }],
    });
  }
  if (status === 'FAILED' && made < total) {
    failed.push({ team: names[made]!, reason: 'provider_error' });
  }

  const now = new Date().toISOString();
  const finished = status !== 'RUNNING';
  const membersAdded = madeTeams.reduce((sum, team) => sum + (team.members_added ?? 0), 0);
  const state: CreateState = {
    status,
    run_id: row.id,
    run_number: row.number,
    total,
    done: madeTeams.length,
    failed,
    teams: madeTeams,
    names,
    sizes,
    counts: {
      teams_created: madeTeams.length,
      teams_failed: finished ? total - madeTeams.length : 0,
      members_added: membersAdded,
      members_failed: failed.reduce((n, f) => n + (f.members?.length ?? 0), 0),
    },
    attempt,
    attempt_id: randomUUID(),
    claimed_by: fixture.staff.owner.id,
    started_at: now,
    task_started_at: now,
    heartbeat_at: now,
    finished_at: finished ? now : null,
  };
  await prisma.teamSet.update({
    where: { id: set.id },
    data: { created_run_id: row.id, create_state: state as unknown as object },
  });
  return state;
}

/** Back to setting up: no claimed create, no create state. */
export async function clearCreateState(set: SeededSet): Promise<void> {
  const prisma = await getTestPrisma();
  // SQL NULL, not JSON null: the service reads a missing state as "never claimed".
  await prisma.$executeRaw`UPDATE team_sets SET created_run_id = NULL, create_state = NULL WHERE id = ${set.id}`;
}
