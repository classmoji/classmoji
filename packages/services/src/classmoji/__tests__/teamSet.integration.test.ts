/**
 * teamSet.service against a REAL Postgres.
 *
 * What this file covers cannot be mocked honestly: run numbering under the
 * set's row lock, the create claim's `updateMany … WHERE created_run_id IS
 * NULL` race, staleness read back from real response rows, and the JSON the
 * service writes being the JSON it reads. Two things ARE mocked, because they
 * leave the building: the Trigger.dev client (no job is ever queued) and the
 * team-admin provider calls (no GitHub team is ever created).
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom → forms →
 * team sets → runs, tags, memberships). Nothing is truncated and no
 * pre-existing row is touched. All names are invented.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database — the same
 * gate as forms.integration.test.ts. Run it as
 *   DATABASE_URL=postgresql://…/classmoji_<feature> npm run test --prefix packages/services
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const {
  triggerMock,
  createTeamMock,
  addTeamMembersMock,
  deleteTeamMock,
  getOrganizationMock,
  getTeamMock,
} = vi.hoisted(() => ({
  triggerMock: vi.fn(),
  createTeamMock: vi.fn(),
  addTeamMembersMock: vi.fn(),
  deleteTeamMock: vi.fn(),
  getOrganizationMock: vi.fn(),
  getTeamMock: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...args: unknown[]) => triggerMock(...args) },
}));

vi.mock('../teamAdmin.service.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../teamAdmin.service.ts')>()),
  createTeam: (...args: unknown[]) => createTeamMock(...args),
  addTeamMembers: (...args: unknown[]) => addTeamMembersMock(...args),
  deleteTeam: (...args: unknown[]) => deleteTeamMock(...args),
}));

// The create's GitHub pre-flight: the org read and the per-name team probe,
// through the provider's probe client. `getTeamMock` keeps octokit's shape —
// resolve = the team exists, a 404 = free, anything else thrown — and the
// probe adapter below turns that into probeTeam's boolean the way the real
// provider does. Nothing else of the provider is reachable from the service.
const { probeSignals } = vi.hoisted(() => ({ probeSignals: [] as AbortSignal[] }));
vi.mock('../../git/index.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../git/index.ts')>()),
  getGitHubProvider: () => ({
    probeOrganization: async (org: string) => {
      await getOrganizationMock(org);
    },
    probeTeam: async (org: string, slug: string, options: { signal?: AbortSignal } = {}) => {
      const { signal } = options;
      if (signal) probeSignals.push(signal);
      // Like fetch: an abort ends the request, whatever the server is doing.
      const aborted = new Promise<never>((_, reject) =>
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      );
      try {
        await Promise.race([getTeamMock(org, slug), aborted]);
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 404) return false;
        throw error;
      }
    },
  }),
}));

/** An octokit-shaped 404: "no such team" to the pre-flight. */
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

import getPrisma from '@classmoji/database';
import { Prisma } from '@prisma/client';
import * as formService from '../form.service.ts';
import * as responseService from '../formResponse.service.ts';
import * as teamSetService from '../teamSet.service.ts';
import { TeamServiceError } from '../teamAdmin.service.ts';
import { scoreAssignment } from '../teamSetScore.ts';
import type { CreateState, SolverOutput, TeamSetRunRow } from '../teamSet.service.ts';
import type { TeamSetConfig } from '../teamSetConfig.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

// ─── teamNamesFor (pure; runs without a database) ──────────────────────────

describe('teamNamesFor', () => {
  const config = { team_name_template: '{set}-{n}', options: {} } as unknown as TeamSetConfig;
  const free = (n: number) => Array.from({ length: n }, () => ({ option_id: null }));

  it('suffixes a name that is taken, and keeps counting past taken suffixes', () => {
    expect(
      teamSetService.teamNamesFor('pairs', config, free(2), new Map(), [
        'pairs-01',
        'pairs-01-2',
        'PAIRS-02',
      ])
    ).toEqual(['pairs-01-3', 'pairs-02-2']);
  });

  it('never lands on a reserved classroom-team slug', () => {
    const byOption = { team_name_template: '{option}', options: {} } as unknown as TeamSetConfig;
    const names = teamSetService.teamNamesFor(
      'x',
      byOption,
      [{ option_id: 'o1' }],
      new Map([['o1', 'Group of students']])
    );
    expect(names).toEqual(['group-of-students-2']);
  });

  it('suffixes AFTER truncating, so a suffixed name stays within 100 chars and unique', () => {
    const long = {
      team_name_template: `${'a'.repeat(120)}`,
      options: {},
    } as unknown as TeamSetConfig;
    const names = teamSetService.teamNamesFor('s', long, free(3), new Map());
    expect(names.map(n => n.length).every(len => len <= 100)).toBe(true);
    expect(new Set(names).size).toBe(3);
    expect(names[1]!.endsWith('-2')).toBe(true);
    expect(names[2]!.endsWith('-3')).toBe(true);
  });
});

/** The TeamSetError code a rejected promise carries, or undefined. */
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe.skipIf(!RUN)('teamSet.service (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const STUDENTS = 8;

  let orgId: string;
  let classroomId: string;
  let ownerId: string;
  const studentIds: string[] = [];
  const logins = new Map<string, string>();

  let formId: string;
  let revisionId: string;
  let rankFieldId: string;
  let withFieldId: string;
  let noteFieldId: string;
  let optionIds: string[];
  let setId: string;
  let setName: string;

  const makeUser = async (label: string) => {
    const login = `tstest-${suite}-${label}`;
    const user = await prisma.user.create({
      data: { login, email: `${login}@example.test`, name: `Team Test ${label}` },
    });
    logins.set(user.id, login);
    return user.id;
  };

  const enroll = (userId: string, role: 'STUDENT' | 'OWNER' = 'STUDENT') =>
    prisma.classroomMembership.create({
      data: { classroom_id: classroomId, user_id: userId, role, has_accepted_invite: true },
    });

  const submit = (userId: string, answers: Record<string, unknown>) =>
    responseService.submitClassroom({
      formId,
      userId,
      email: `${logins.get(userId)}@example.test`,
      name: `Team Test ${userId.slice(0, 4)}`,
      answers,
      revisionId,
    });

  /** A run of the shared set, turned SOLVED by a round-robin assignment the scorer accepts. */
  const solvedRun = async (teamSetId = setId): Promise<TeamSetRunRow> => {
    const { run } = await teamSetService.startRun({
      classroomId,
      teamSetId,
      userId: ownerId,
      seed: 7,
    });
    expect(run).not.toBeNull();
    const slots = run!.problem.slots.length;
    const teams = Array.from({ length: slots }, (_, slot) => ({
      slot,
      members: run!.problem.people.map((_, p) => p).filter(p => p % slots === slot),
    })).filter(t => t.members.length > 0);
    const scored = scoreAssignment(run!.problem, teams);
    expect(scored.violations).toEqual([]);
    return teamSetService.completeRun(run!.id, {
      status: 'OPTIMAL',
      teams,
      objective: scored.objective,
      bound: scored.objective,
      wall_s: 0.1,
      core: [],
    });
  };

  /** A set's create_state as stored. */
  const stateOf = async (teamSetId: string): Promise<CreateState> =>
    (await prisma.teamSet.findUniqueOrThrow({ where: { id: teamSetId } }))
      .create_state as unknown as CreateState;

  /** Another set on the shared form, sized for the eight students. */
  const newSet = (label: string) =>
    teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      name: `${label} ${suite}`,
      patch: { team_size: { min: 2, max: 3 } },
    });

  /** createTeam as teamAdmin leaves it locally: a real Team row, on its tags. */
  const realCreateTeam = async ({ name, tagIds }: { name: string; tagIds: string[] }) => {
    const team = await prisma.team.create({
      data: { classroom_id: classroomId, name, slug: name.toLowerCase(), is_visible: true },
    });
    for (const tagId of tagIds) {
      await prisma.teamTag.create({ data: { tag_id: tagId, team_id: team.id } });
    }
    return {
      team: { id: team.id, name: team.name, slug: team.slug, isVisible: true },
      tagsAdded: tagIds,
      tagsFailed: [],
    };
  };
  const allAdded = async ({ logins: requested }: { logins: string[] }) => ({
    succeeded: requested.map(login => ({ login })),
    failed: [],
  });

  type ApplyCall = [string, { teamSetId: string; attemptId: string }, { idempotencyKey: string }];
  const applyCalls = () =>
    triggerMock.mock.calls.filter(([id]) => id === 'team-set-apply') as ApplyCall[];

  beforeAll(async () => {
    process.env.TRIGGER_SECRET_KEY = 'tr_test_team_sets';

    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `tstest-${suite}`,
        login: `tstest-org-${suite}`,
        github_installation_id: '1',
      },
    });
    orgId = org.id;
    const classroom = await prisma.classroom.create({
      data: {
        slug: `tstest-${suite}`,
        git_org_id: orgId,
        name: `Team Sets Test ${suite}`,
        content_namespace: `tstest-${suite}`,
        content_repo: `content-tstest-${suite}`,
      },
    });
    classroomId = classroom.id;

    ownerId = await makeUser('owner');
    await enroll(ownerId, 'OWNER');
    for (let i = 0; i < STUDENTS; i++) {
      const id = await makeUser(`s${i}`);
      studentIds.push(id);
      await enroll(id);
    }

    // Enrolled BEFORE publish: publish freezes the roster into the roster_select.
    const form = await formService.create({
      classroomId,
      title: `Project pitch ${suite}`,
      access: 'CLASSROOM',
      createdBy: ownerId,
      fields: [
        {
          type: 'ranked_choice',
          label: 'Rank the projects',
          options: ['Alpha', 'Beta', 'Gamma'],
          ranks: 2,
        },
        {
          type: 'roster_select',
          label: 'Who would you like to work with?',
          optionSource: 'roster',
          multiple: true,
        },
        { type: 'long_text', label: 'Anything the staff should know?' },
      ],
    });
    await formService.update(form.id, { allow_multiple: true });
    const { revision } = await formService.publish(form.id);
    formId = form.id;
    revisionId = revision.id;
    const fields = formService.fieldsOf(revision.fields);
    rankFieldId = fields[0]!.id;
    withFieldId = fields[1]!.id;
    noteFieldId = fields[2]!.id;
    optionIds = (fields[0]!.options as { id: string }[]).map(o => o.id);

    // Six of eight students respond; s6 and s7 do not. The OWNER also
    // test-fills the form and must not end up in anybody's team.
    for (let i = 0; i < 6; i++) {
      await submit(studentIds[i]!, {
        [rankFieldId]: [optionIds[i % 3], optionIds[(i + 1) % 3]],
        [withFieldId]: [studentIds[(i + 1) % 6]],
        [noteFieldId]: `Note from student ${i}`,
      });
    }
    await submit(ownerId, { [rankFieldId]: [optionIds[0]] });
  });

  afterAll(async () => {
    delete process.env.TRIGGER_SECRET_KEY;
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { login: { startsWith: `tstest-${suite}-` } } })
      .catch(() => {});
  });

  beforeEach(() => {
    process.env.TRIGGER_SECRET_KEY = 'tr_test_team_sets';
    triggerMock.mockReset();
    triggerMock.mockImplementation(async () => ({ id: `run_${randomUUID().slice(0, 8)}` }));
    createTeamMock.mockReset();
    addTeamMembersMock.mockReset();
    deleteTeamMock.mockReset();
    // GitHub reachable, every planned name free.
    getOrganizationMock.mockReset();
    getOrganizationMock.mockResolvedValue({ login: 'org' });
    getTeamMock.mockReset();
    getTeamMock.mockRejectedValue(notFound());
  });

  // ── Config ───────────────────────────────────────────────────────────────

  it('creates the set from the suggestion, then patches it in place', async () => {
    const created = await teamSetService.saveConfig({ classroomId, formId, userId: ownerId });
    setId = created.id;
    setName = created.name;
    expect(created.name).toBe(`project-pitch-${suite}-teams`);
    expect(created.config.grouping).toMatchObject({ mode: 'by_option', field_id: rankFieldId });
    const jobs = created.config.rules.map(r => r.job).sort();
    expect(jobs).toEqual(['note', 'rank', 'together']);

    const patched = await teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      patch: { team_size: { min: 2, max: 3 } },
    });
    expect(patched.id).toBe(setId);
    expect(patched.config.team_size).toMatchObject({ min: 2, max: 3 });
    expect(patched.config.rules).toHaveLength(3);

    const listed = await teamSetService.listForForm({ classroomId, formId });
    expect(listed.map(s => s.id)).toEqual([setId]);
    expect((await teamSetService.getSet({ classroomId, formId }))?.id).toBe(setId);
    expect((await teamSetService.getSet({ classroomId, formId, setRef: setName }))?.id).toBe(setId);
  });

  it('refuses an invalid patch without touching the stored config', async () => {
    expect(
      await codeOf(
        teamSetService.saveConfig({
          classroomId,
          formId,
          userId: ownerId,
          patch: { team_size: { min: 4, max: 2 } },
        })
      )
    ).toBe('invalid_config');
    const set = await teamSetService.getSet({ classroomId, formId });
    expect(set?.config.team_size).toMatchObject({ min: 2, max: 3 });
  });

  it('scopes every lookup to the classroom and refuses PUBLIC forms', async () => {
    expect(await codeOf(teamSetService.listForForm({ classroomId: randomUUID(), formId }))).toBe(
      'not_found'
    );
    expect(
      await codeOf(teamSetService.checkSet({ classroomId: randomUUID(), teamSetId: setId }))
    ).toBe('not_found');

    const publicForm = await formService.create({
      classroomId,
      title: `Public ${suite}`,
      createdBy: ownerId,
      fields: [{ type: 'short_text', label: 'Name' }],
    });
    expect(
      await codeOf(
        teamSetService.saveConfig({ classroomId, formId: publicForm.id, userId: ownerId })
      )
    ).toBe('form_not_classroom');
  });

  it('keeps non-roster respondents out of the population', async () => {
    const inputs = await teamSetService.loadInputs({ classroomId, formId });
    expect(inputs.roster.map(r => r.user_id).sort()).toEqual([...studentIds].sort());
    expect(inputs.responses.map(r => r.user_id)).not.toContain(ownerId);
    expect(inputs.responses).toHaveLength(6);
    expect(inputs.snapshot.revision_id).toBe(revisionId);
  });

  // ── Runs ─────────────────────────────────────────────────────────────────

  it('refuses to start a run that fails checks, and inserts nothing', async () => {
    await teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      patch: { team_size: { min: 1, max: 2 } }, // 3 teams × 2 < 8 people
    });
    const before = await prisma.teamSetRun.count({ where: { team_set_id: setId } });
    const { run, issues } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    expect(run).toBeNull();
    expect(issues.some(issue => issue.level === 'error')).toBe(true);
    expect(await prisma.teamSetRun.count({ where: { team_set_id: setId } })).toBe(before);
    expect(triggerMock).not.toHaveBeenCalled();

    await teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      patch: { team_size: { min: 2, max: 3 } },
    });
  });

  it('numbers runs 1..n, even when two start at once, and queues each solve', async () => {
    const first = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
      seed: 1,
    });
    const [a, b] = await Promise.all([
      teamSetService.startRun({ classroomId, teamSetId: setId, userId: ownerId, seed: 2 }),
      teamSetService.startRun({ classroomId, teamSetId: setId, userId: ownerId, seed: 3 }),
    ]);
    expect(first.run?.number).toBe(1);
    expect([a.run?.number, b.run?.number].sort()).toEqual([2, 3]);
    expect(first.run?.status).toBe('QUEUED');
    expect(first.run?.trigger_run_id).toMatch(/^run_/);
    expect(first.run?.engine).toBe(teamSetService.TEAM_SET_ENGINE);
    // One solve per run, whatever retries the client or network adds; the
    // queue drops it at the QUEUED expiry (15 min) rather than start it late.
    expect(triggerMock).toHaveBeenCalledWith(
      'team-set-solve',
      { runId: first.run!.id },
      { idempotencyKey: `team-set-solve:${first.run!.id}`, ttl: 900 }
    );

    const byNumber = await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: 1 });
    expect(byNumber.id).toBe(first.run!.id);
    const byString = await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: '1' });
    expect(byString.id).toBe(first.run!.id);
    // A number no INT4 run can have is not_found, not a database overflow.
    for (const runRef of [0, 2 ** 31, '99999999999', -1]) {
      expect(
        await codeOf(teamSetService.getRun({ classroomId, teamSetId: setId, runRef })),
        String(runRef)
      ).toBe('not_found');
    }
    // The problem is ids and integers only: no names, no answer text.
    expect(JSON.stringify(byNumber.problem)).not.toContain('Note from');
    expect(JSON.stringify(byNumber.problem)).not.toContain('Team Test');
  });

  it('marks a run FAILED trigger_unavailable when Trigger is missing or refuses', async () => {
    delete process.env.TRIGGER_SECRET_KEY;
    const missing = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    expect(missing.run).toMatchObject({ status: 'FAILED', error: 'trigger_unavailable' });
    expect(triggerMock).not.toHaveBeenCalled();

    process.env.TRIGGER_SECRET_KEY = 'tr_test_team_sets';
    triggerMock.mockRejectedValueOnce(new Error('network down'));
    const refused = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    expect(refused.run).toMatchObject({ status: 'FAILED', error: 'trigger_unavailable' });
  });

  it('completes a run as SOLVED when the scorer agrees with the engine', async () => {
    const run = await solvedRun();
    expect(run.status).toBe('SOLVED');
    expect(run.result?.teams.length).toBeGreaterThan(0);
    const everyone = run.result!.teams.flatMap(t => t.member_user_ids).sort();
    expect(everyone).toEqual([...studentIds].sort());
    expect(run.result!.teams.every(t => optionIds.includes(t.option_id!))).toBe(true);
    expect(run.metrics?.people).toBe(STUDENTS);
    expect(run.finished_at).not.toBeNull();

    // A duplicate delivery after the run finished changes nothing.
    const again = await teamSetService.completeRun(run.id, {
      status: 'INFEASIBLE',
      teams: [],
      objective: null,
      bound: null,
      wall_s: 0,
      core: [],
    });
    expect(again.status).toBe('SOLVED');
  });

  it('fails a run whose objective the scorer does not reproduce', async () => {
    const { run } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    await teamSetService.markRunning(run!.id, 'run_trigger_1');
    const slots = run!.problem.slots.length;
    const teams = Array.from({ length: slots }, (_, slot) => ({
      slot,
      members: run!.problem.people.map((_, p) => p).filter(p => p % slots === slot),
    }));
    const { objective } = scoreAssignment(run!.problem, teams);
    const done = await teamSetService.completeRun(run!.id, {
      status: 'FEASIBLE',
      teams,
      objective: objective + 1,
      bound: null,
      wall_s: 1,
      core: [],
    });
    expect(done).toMatchObject({ status: 'FAILED', error: 'score_mismatch' });
    expect(done.trigger_run_id).toBe('run_trigger_1');
    expect(done.diagnostics?.mismatch).toMatchObject({
      engine_objective: objective + 1,
      scored_objective: objective,
    });
  });

  it('records INFEASIBLE with a labelled core, and maps the other engine outcomes', async () => {
    const infeasible = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    const src = `${withFieldId}:together`;
    const done = await teamSetService.completeRun(infeasible.run!.id, {
      status: 'INFEASIBLE',
      teams: [],
      objective: null,
      bound: null,
      wall_s: 2,
      core: [src, src],
    });
    expect(done.status).toBe('INFEASIBLE');
    expect(done.diagnostics?.core).toEqual([
      { src, label: expect.stringContaining('Who would you like to work with?') },
    ]);
    // The listed rules collide WITH the structural limits, and it says so.
    expect(done.diagnostics?.summary).toMatch(/cannot all be met together within the team-size/);
    // An engine that does not report its version leaves the queued one.
    expect(done.engine).toBe(teamSetService.TEAM_SET_ENGINE);

    const outcomes: [SolverOutput['status'], string][] = [
      ['UNKNOWN', 'no_solution_in_time'],
      ['MODEL_INVALID', 'model_invalid'],
    ];
    for (const [status, error] of outcomes) {
      const { run } = await teamSetService.startRun({
        classroomId,
        teamSetId: setId,
        userId: ownerId,
      });
      const failed = await teamSetService.completeRun(run!.id, {
        status,
        teams: [],
        objective: null,
        bound: null,
        wall_s: 30,
        core: [],
      });
      expect(failed).toMatchObject({ status: 'FAILED', error });
    }

    const { run } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    await teamSetService.failRun(run!.id, 'Error: something with a stack trace');
    const failed = await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: run!.id });
    expect(failed).toMatchObject({ status: 'FAILED', error: 'engine_error' });

    // The cancel hook's code is part of the vocabulary.
    const { run: canceled } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    await teamSetService.failRun(canceled!.id, 'canceled');
    expect(
      await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: canceled!.id })
    ).toMatchObject({ status: 'FAILED', error: 'canceled' });
  });

  it('labels option srcs by their label, and says what an empty or timed-out core means', async () => {
    const { run } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    // Mark option 0 closed in the stored problem: the label depends on it.
    const problem = { ...run!.problem };
    problem.options = problem.options.map((o, i) => (i === 0 ? { ...o, open: 'closed' } : o));
    await prisma.teamSetRun.update({
      where: { id: run!.id },
      data: { problem: problem as unknown as object },
    });
    expect(await teamSetService.markRunning(run!.id, 'run_x')).toBe(true);
    // Only QUEUED → RUNNING: a second delivery does not re-mark it.
    expect(await teamSetService.markRunning(run!.id, 'run_y')).toBe(false);

    const done = await teamSetService.completeRun(run!.id, {
      status: 'INFEASIBLE',
      teams: [],
      objective: null,
      bound: null,
      wall_s: 3,
      core: [`option:${optionIds[0]}`, `${randomUUID()}:apart`, 'something_new'],
      core_status: 'timeout',
      engine: 'cpsat@9.99.1',
      stats: { people: 8, slots: 3, pairs: 12, build_s: 0.01 },
    });
    expect(done.diagnostics?.core?.map(c => c.label)).toEqual([
      "Topic 'Alpha' is closed",
      'A rule (apart) on a question that is no longer on the form',
      'Another setting of this team set',
    ]);
    expect(done.diagnostics?.core_status).toBe('timeout');
    expect(done.diagnostics?.summary).toMatch(/ran out of time/);
    expect(done.diagnostics?.summary).not.toMatch(/No rule or pin is to blame/);
    expect(done.engine).toBe('cpsat@9.99.1');
    expect(done.solver).toMatchObject({
      core_status: 'timeout',
      stats: { people: 8, slots: 3, pairs: 12 },
    });
    expect(done.trigger_run_id).toBe('run_x');

    const { run: structural } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    const empty = await teamSetService.completeRun(structural!.id, {
      status: 'INFEASIBLE',
      teams: [],
      objective: null,
      bound: null,
      wall_s: 1,
      core: [],
      core_status: 'complete',
      // Not a version string: ignored, the queued value stays.
      engine: 'rm -rf / ; echo',
    });
    expect(empty.diagnostics?.summary).toMatch(/No rule or pin is to blame/);
    expect(empty.engine).toBe(teamSetService.TEAM_SET_ENGINE);

    const view = await teamSetService.describeRun({
      classroomId,
      run: empty,
      includePeople: false,
    });
    expect(view.summary).toMatch(/No rule or pin is to blame/);
  });

  it('listRuns returns light rows newest first, clamped and classroom-scoped', async () => {
    const solved = await solvedRun();
    const total = await prisma.teamSetRun.count({ where: { team_set_id: setId } });
    expect(total).toBeGreaterThan(10);

    const runs = await teamSetService.listRuns({ classroomId, teamSetId: setId });
    expect(runs).toHaveLength(10);
    expect(runs[0]).toEqual({
      id: solved.id,
      number: solved.number,
      status: 'SOLVED',
      created_at: solved.created_at,
      finished_at: solved.finished_at,
      error: null,
      metrics: solved.metrics,
    });
    const numbers = runs.map(r => r.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(Object.keys(runs[0]!)).not.toContain('problem');

    const two = await teamSetService.listRuns({ classroomId, teamSetId: setId, limit: 2 });
    expect(two.map(r => r.number)).toEqual([solved.number, solved.number - 1]);
    const all = await teamSetService.listRuns({ classroomId, teamSetId: setId, limit: 500 });
    expect(all).toHaveLength(Math.min(total, 50));
    expect(await teamSetService.listRuns({ classroomId, teamSetId: setId, limit: 0 })).toHaveLength(
      1
    );
    expect(runs.some(r => r.status === 'FAILED' && r.error !== null)).toBe(true);

    // Staleness on request, for SOLVED runs only, from one read of the form.
    const withStale = await teamSetService.listRuns({
      classroomId,
      teamSetId: setId,
      limit: 5,
      withStaleness: true,
    });
    expect(withStale[0]).toMatchObject({ id: solved.id, status: 'SOLVED', stale: false });
    expect(withStale.filter(r => r.status !== 'SOLVED').every(r => r.stale === null)).toBe(true);

    expect(
      await codeOf(teamSetService.listRuns({ classroomId: randomUUID(), teamSetId: setId }))
    ).toBe('not_found');
  });

  it('waitForRun returns a terminal run at once and a pending one at the timeout', async () => {
    const solved = await solvedRun();
    const waited = await teamSetService.waitForRun({
      classroomId,
      runId: solved.id,
      timeoutMs: 5000,
    });
    expect(waited.status).toBe('SOLVED');

    const { run } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    const started = Date.now();
    const pending = await teamSetService.waitForRun({
      classroomId,
      runId: run!.id,
      timeoutMs: 200,
      pollMs: 50,
    });
    expect(pending.status).toBe('QUEUED');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(
      await codeOf(
        teamSetService.waitForRun({ classroomId: randomUUID(), runId: run!.id, timeoutMs: 0 })
      )
    ).toBe('not_found');
  });

  // ── Describe ─────────────────────────────────────────────────────────────

  it('describes a run with names, placements and notes — and no emails', async () => {
    const run = await solvedRun();
    const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
    expect(view).toMatchObject({ number: run.number, status: 'SOLVED', stale: false });
    expect(view.teams[0]!.name).toBe(`${setName}-01`);
    expect(view.teams[0]!.option?.label).toMatch(/Alpha|Beta|Gamma/);

    const members = view.teams.flatMap(t => t.members);
    expect(members).toHaveLength(STUDENTS);
    const s0 = members.find(m => m.user_id === studentIds[0])!;
    expect(s0.login).toBe(logins.get(studentIds[0]!));
    expect(s0.name).toBe('Team Test s0');
    expect(s0.placement).not.toBeNull();
    expect(s0.requests_total).toBe(1);
    expect(s0.notes).toEqual([
      { field_label: 'Anything the staff should know?', text: 'Note from student 0' },
    ]);
    const s7 = members.find(m => m.user_id === studentIds[7])!;
    expect(s7.notes).toBeUndefined();

    expect(JSON.stringify(view)).not.toContain('example.test');

    // Who has not responded is named in a view that shows people…
    const noResponse = view.issues.find(issue => issue.code === 'no_response');
    expect(noResponse?.user_ids?.sort()).toEqual([studentIds[6], studentIds[7]].sort());
    expect(noResponse?.names?.sort()).toEqual(['Team Test s6', 'Team Test s7']);
    // …and never stored: the run's own diagnostics carry ids only.
    expect(JSON.stringify(run.diagnostics)).not.toContain('Team Test');

    const bare = await teamSetService.describeRun({ classroomId, run, includePeople: false });
    expect(bare.teams.every(t => t.members.length === 0 && t.size > 0)).toBe(true);
    expect(bare.issues.find(issue => issue.code === 'no_response')?.names).toBeUndefined();
  });

  // ── Staleness ────────────────────────────────────────────────────────────

  it('is not made stale by staff triage on a response', async () => {
    const run = await solvedRun();
    const row = await prisma.formResponse.findFirstOrThrow({
      where: { form_id: formId, user_id: studentIds[0] },
    });
    await responseService.updateStaff({ responseId: row.id, staff_note: 'checked' });
    expect(await teamSetService.staleness({ classroomId, run })).toEqual({
      stale: false,
      reasons: [],
    });
  });

  it('goes stale when a response is edited', async () => {
    const run = await solvedRun();
    await submit(studentIds[1]!, {
      [rankFieldId]: [optionIds[2], optionIds[0]],
      [withFieldId]: [studentIds[3]],
      [noteFieldId]: 'Changed my mind',
    });
    const result = await teamSetService.staleness({ classroomId, run });
    expect(result.stale).toBe(true);
    expect(result.reasons).toEqual(['1 response was edited.']);
  });

  it('goes stale when a new response comes in', async () => {
    const run = await solvedRun();
    await submit(studentIds[6]!, { [rankFieldId]: [optionIds[1]] });
    const result = await teamSetService.staleness({ classroomId, run });
    expect(result).toEqual({ stale: true, reasons: ['1 new response came in.'] });
  });

  it('goes stale when the roster changes (non_respondents include)', async () => {
    const run = await solvedRun();
    const newcomer = await makeUser('late');
    await enroll(newcomer);
    const result = await teamSetService.staleness({ classroomId, run });
    expect(result).toEqual({ stale: true, reasons: ['The roster changed (1 joined, 0 left).'] });
    await prisma.classroomMembership.deleteMany({
      where: { classroom_id: classroomId, user_id: newcomer },
    });
  });

  // ── Create ───────────────────────────────────────────────────────────────

  it('previewCreate refuses unsolved, stale, github_teams-off and tag-conflict runs', async () => {
    const { run: queued } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: queued!.number })
      )
    ).toBe('run_not_solved');

    const stale = await solvedRun();
    await submit(studentIds[7]!, { [rankFieldId]: [optionIds[2]] });
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: stale.number })
      )
    ).toBe('run_stale');

    await teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      patch: { github_teams: false },
    });
    const offRun = await solvedRun();
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: offRun.number })
      )
    ).toBe('github_teams_off_unsupported');
    await teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      patch: { github_teams: true },
    });

    const fresh = await solvedRun();
    const tag = await prisma.tag.create({ data: { classroom_id: classroomId, name: setName } });
    const team = await prisma.team.create({
      data: { classroom_id: classroomId, name: `other-${suite}`, slug: `other-${suite}` },
    });
    await prisma.teamTag.create({ data: { tag_id: tag.id, team_id: team.id } });
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: fresh.number })
      )
    ).toBe('tag_conflict');
    await prisma.teamTag.deleteMany({ where: { tag_id: tag.id } });

    // GitHub pre-flight: a dead installation is refused before anyone approves.
    getOrganizationMock.mockRejectedValueOnce(notFound());
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: fresh.number })
      )
    ).toBe('github_unavailable');
    // A probe that fails for any reason but 404 is not "name free".
    getTeamMock.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 403 }));
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: fresh.number })
      )
    ).toBe('github_unavailable');
    // A planned name that is already a team in the org is refused, by name.
    getTeamMock.mockImplementation(async (_org: string, slug: string) => {
      if (slug === `${setName}-02`) return { slug };
      throw notFound();
    });
    const collision = (await teamSetService
      .previewCreate({ classroomId, teamSetId: setId, runRef: fresh.number })
      .catch(e => e)) as { code: string; details: unknown };
    expect(collision.code).toBe('name_collision');
    expect(collision.details).toEqual({ names: [`${setName}-02`] });
    getTeamMock.mockReset();
    getTeamMock.mockRejectedValue(notFound());

    // A name already used in the classroom is suffixed, not refused.
    const clash = await prisma.team.create({
      data: { classroom_id: classroomId, name: `${setName}-01`, slug: `${setName}-01` },
    });
    const suffixed = await teamSetService.previewCreate({
      classroomId,
      teamSetId: setId,
      runRef: fresh.number,
    });
    expect(suffixed.teams[0]!.name).toBe(`${setName}-01-2`);
    await prisma.team.delete({ where: { id: clash.id } });

    const preview = await teamSetService.previewCreate({
      classroomId,
      teamSetId: setId,
      runRef: fresh.number,
    });
    expect(preview).toMatchObject({
      run_number: fresh.number,
      tag: { name: setName, exists: true },
      github_teams: true,
      warnings: [],
    });
    expect(preview.teams.map(t => t.name)).toEqual(
      fresh.result!.teams.map((_, i) => `${setName}-${String(i + 1).padStart(2, '0')}`)
    );
    expect(preview.teams.flatMap(t => t.members.map(m => m.login)).sort()).toEqual(
      studentIds.map(id => logins.get(id)).sort()
    );
  });

  it('releases the claim when the create cannot be queued', async () => {
    const run = await solvedRun();
    triggerMock.mockRejectedValueOnce(new Error('network down'));
    expect(
      await codeOf(
        teamSetService.claimCreate({
          classroomId,
          teamSetId: setId,
          runId: run.id,
          userId: ownerId,
        })
      )
    ).toBe('trigger_unavailable');
    const set = await prisma.teamSet.findUniqueOrThrow({ where: { id: setId } });
    expect(set.created_run_id).toBeNull();
    expect(set.create_state).toBeNull();
  });

  it('claims a create exactly once when two confirms race', async () => {
    const run = await solvedRun();
    const results = await Promise.allSettled([
      teamSetService.claimCreate({ classroomId, teamSetId: setId, runId: run.id, userId: ownerId }),
      teamSetService.claimCreate({ classroomId, teamSetId: setId, runId: run.id, userId: ownerId }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('create_in_progress');

    const set = await prisma.teamSet.findUniqueOrThrow({ where: { id: setId } });
    const claimed = set.create_state as unknown as CreateState;
    expect(claimed.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    // The task carries the attempt, and its key is the attempt's own.
    expect(triggerMock.mock.calls.filter(([id]) => id === 'team-set-apply')).toEqual([
      [
        'team-set-apply',
        { teamSetId: setId, attemptId: claimed.attempt_id },
        { idempotencyKey: `team-set-apply:${setId}:${claimed.attempt_id}` },
      ],
    ]);
    expect(set.created_run_id).toBe(run.id);
    expect(set.create_state).toMatchObject({
      status: 'RUNNING',
      done: 0,
      claimed_by: ownerId,
      attempt: 1,
      task_started_at: null,
      heartbeat_at: claimed.started_at,
      names: run.result!.teams.map((_, i) => `${setName}-${String(i + 1).padStart(2, '0')}`),
    });
    expect(
      await codeOf(teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: run.id }))
    ).toBe('create_in_progress');
  });

  it('applies the claimed create, records per-team failures, and never deletes', async () => {
    const set = await prisma.teamSet.findUniqueOrThrow({ where: { id: setId } });
    const run = await teamSetService.getRun({
      classroomId,
      teamSetId: setId,
      runRef: set.created_run_id!,
    });
    const teamCount = run.result!.teams.length;
    expect(teamCount).toBeGreaterThanOrEqual(3);
    const failingLogin = logins.get(run.result!.teams[0]!.member_user_ids[0]!)!;

    let n = 0;
    createTeamMock.mockImplementation(
      async ({ name, tagIds }: { name: string; tagIds: string[] }) => {
        n += 1;
        if (n === 2) throw new TeamServiceError('name_collision', 'raw provider text');
        expect(tagIds).toHaveLength(1);
        return {
          team: { id: randomUUID(), name, slug: name, isVisible: true },
          tagsAdded: tagIds,
          tagsFailed: [],
        };
      }
    );
    addTeamMembersMock.mockImplementation(async ({ logins: requested }: { logins: string[] }) => ({
      succeeded: requested.filter(l => l !== failingLogin).map(login => ({ login })),
      failed: requested.includes(failingLogin)
        ? [{ login: failingLogin, error: 'provider_error' }]
        : [],
    }));

    const progress: number[] = [];
    const claimed = set.create_state as unknown as CreateState;
    const state = await teamSetService.applyCreate({
      teamSetId: setId,
      attemptId: claimed.attempt_id!,
      onProgress: s => progress.push(s.done),
    });
    // The task stamped its start, and its writes kept the heartbeat fresh.
    expect(state.task_started_at).toEqual(expect.any(String));
    expect(Date.parse(state.heartbeat_at!)).toBeGreaterThanOrEqual(Date.parse(claimed.started_at));

    expect(state.status).toBe('FAILED');
    expect(state.done).toBe(teamCount);
    expect(state.teams).toHaveLength(teamCount - 1);
    expect(state.counts).toMatchObject({
      teams_created: teamCount - 1,
      teams_failed: 1,
      members_failed: 1,
    });
    expect(state.failed).toEqual([
      {
        team: `${setName}-01`,
        reason: 'members_failed',
        members: [
          {
            user_id: run.result!.teams[0]!.member_user_ids[0],
            login: failingLogin,
            reason: 'provider_error',
          },
        ],
      },
      { team: `${setName}-02`, reason: 'name_collision' },
    ]);
    expect(JSON.stringify(state)).not.toContain('raw provider text');
    expect(progress.at(-1)).toBe(teamCount);
    expect(createTeamMock).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId, isVisible: true })
    );
    expect(deleteTeamMock).not.toHaveBeenCalled();

    const after = await prisma.teamSet.findUniqueOrThrow({ where: { id: setId } });
    const tag = await prisma.tag.findUniqueOrThrow({
      where: { classroom_id_name: { classroom_id: classroomId, name: setName } },
    });
    expect(after.tag_id).toBe(tag.id);
    expect(after.create_state).toMatchObject({ status: 'FAILED', done: teamCount });

    // Re-entry is a no-op once the create has finished.
    createTeamMock.mockClear();
    const again = await teamSetService.applyCreate({
      teamSetId: setId,
      attemptId: claimed.attempt_id!,
    });
    expect(again.status).toBe('FAILED');
    expect(createTeamMock).not.toHaveBeenCalled();

    // FAILED with teams made: the SAME run can be previewed again as a retry,
    // and GitHub is asked only about the team still to make…
    getTeamMock.mockClear();
    const retry = await teamSetService.previewCreate({
      classroomId,
      teamSetId: setId,
      runRef: run.id,
    });
    expect(retry.retry).toEqual({ attempt: 2, teams_already_created: teamCount - 1 });
    expect(retry.teams.map(t => t.name)).toEqual(
      (after.create_state as unknown as CreateState).names
    );
    expect(getTeamMock.mock.calls.map(([, slug]) => slug)).toEqual([`${setName}-02`]);
    // …but no other run can be, while teams from this one exist.
    const other = await solvedRun();
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: other.id })
      )
    ).toBe('already_created');
  });

  it('retries a FAILED create of the same run, skipping the teams that exist', async () => {
    const set = await prisma.teamSet.findUniqueOrThrow({ where: { id: setId } });
    const runId = set.created_run_id!;
    const before = set.create_state as unknown as CreateState;
    const run = await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: runId });

    await teamSetService.claimCreate({ classroomId, teamSetId: setId, runId, userId: ownerId });
    const claimed = (await prisma.teamSet.findUniqueOrThrow({ where: { id: setId } }))
      .create_state as unknown as CreateState;
    expect(claimed.attempt_id).not.toBe(before.attempt_id);
    expect(triggerMock).toHaveBeenCalledWith(
      'team-set-apply',
      { teamSetId: setId, attemptId: claimed.attempt_id },
      { idempotencyKey: `team-set-apply:${setId}:${claimed.attempt_id}` }
    );
    expect(claimed).toMatchObject({
      status: 'RUNNING',
      attempt: 2,
      done: before.teams.length,
      names: before.names,
    });
    expect(claimed.teams).toEqual(before.teams);
    // The created team's member failure stays; the failed team's entry goes (it is retried).
    expect(claimed.failed).toEqual([before.failed[0]]);

    // Retry: only team 02 is made. Of its members, GitHub does not know one
    // login, and another stopped naming a Classmoji user meanwhile.
    const team2 = run.result!.teams[1]!.member_user_ids.map(id => logins.get(id)!);
    createTeamMock.mockImplementation(
      async ({ name, tagIds }: { name: string; tagIds: string[] }) => ({
        team: { id: randomUUID(), name, slug: name, isVisible: true },
        tagsAdded: tagIds,
        tagsFailed: [],
      })
    );
    addTeamMembersMock.mockImplementation(async ({ logins: requested }: { logins: string[] }) => {
      await prisma.user.update({
        where: { login: requested[1]! },
        data: { login: `${requested[1]}-renamed` },
      });
      return {
        succeeded: requested.slice(2).map(login => ({ login })),
        failed: [
          { login: requested[0]!, error: 'not_found' },
          { login: requested[1]!, error: 'not_found' },
        ],
      };
    });

    const state = await teamSetService.applyCreate({
      teamSetId: setId,
      attemptId: claimed.attempt_id!,
    });
    expect(createTeamMock).toHaveBeenCalledTimes(1);
    expect(createTeamMock).toHaveBeenCalledWith(expect.objectContaining({ name: `${setName}-02` }));
    // Every team exists now; only member adds are missing → PARTIAL, not FAILED.
    expect(state.status).toBe('PARTIAL');
    expect(state.teams.map(t => t.n).sort()).toEqual(run.result!.teams.map((_, i) => i + 1));
    expect(state.failed.at(-1)).toEqual({
      team: `${setName}-02`,
      reason: 'members_failed',
      members: [
        { user_id: expect.any(String), login: team2[0], reason: 'github_user_not_found' },
        { user_id: expect.any(String), login: team2[1], reason: 'no_local_user' },
      ],
    });
    expect(state.counts).toMatchObject({
      teams_created: run.result!.teams.length,
      teams_failed: 0,
      members_failed: 3,
    });
    await prisma.user.update({
      where: { login: `${team2[1]}-renamed` },
      data: { login: team2[1]! },
    });

    // PARTIAL is final: the rest is by hand on the Teams screen.
    expect(
      await codeOf(teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: runId }))
    ).toBe('already_created');
    expect(
      await codeOf(
        teamSetService.claimCreate({ classroomId, teamSetId: setId, runId, userId: ownerId })
      )
    ).toBe('already_created');
    expect(deleteTeamMock).not.toHaveBeenCalled();
  });

  // ── Lazy expiry, retry across runs, stopping ─────────────────────────────

  it('expires a lost create, then lets a FAILED create with no teams move to another run', async () => {
    const second = await teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      name: `second ${suite}`,
      patch: { team_size: { min: 2, max: 3 } },
    });
    expect(second.notes).toEqual([]);
    const runA = await solvedRun(second.id);
    const runB = await solvedRun(second.id);

    const longAgo = new Date(Date.now() - 40 * 60_000).toISOString();
    const lostState: CreateState = {
      status: 'RUNNING',
      run_id: runA.id,
      run_number: runA.number,
      total: runA.result!.teams.length,
      done: 0,
      failed: [],
      teams: [],
      names: [],
      attempt: 1,
      attempt_id: randomUUID(),
      claimed_by: ownerId,
      started_at: longAgo,
      finished_at: null,
    };
    await prisma.teamSet.update({
      where: { id: second.id },
      data: { created_run_id: runA.id, create_state: lostState as unknown as object },
    });

    // Read → FAILED 'lost', persisted.
    const read = await teamSetService.getSet({ classroomId, formId, setRef: second.id });
    expect(read?.create_state).toMatchObject({
      status: 'FAILED',
      failed: [{ team: '*', reason: 'lost' }],
    });
    const stored = (await prisma.teamSet.findUniqueOrThrow({ where: { id: second.id } }))
      .create_state as unknown as CreateState;
    expect(stored.status).toBe('FAILED');

    // No team was made, so ANOTHER run may be claimed.
    await teamSetService.previewCreate({ classroomId, teamSetId: second.id, runRef: runB.id });
    await teamSetService.claimCreate({
      classroomId,
      teamSetId: second.id,
      runId: runB.id,
      userId: ownerId,
    });
    const moved = await prisma.teamSet.findUniqueOrThrow({ where: { id: second.id } });
    expect(moved.created_run_id).toBe(runB.id);
    expect(moved.create_state).toMatchObject({ status: 'RUNNING', attempt: 2, run_id: runB.id });
    const movedAttempt = (moved.create_state as unknown as CreateState).attempt_id!;
    expect(triggerMock).toHaveBeenCalledWith(
      'team-set-apply',
      { teamSetId: second.id, attemptId: movedAttempt },
      { idempotencyKey: `team-set-apply:${second.id}:${movedAttempt}` }
    );

    // The cancel hook stops it; a late progress write cannot revive it.
    const stop = () =>
      teamSetService.stopCreate({
        teamSetId: second.id,
        attemptId: movedAttempt,
        reason: 'canceled',
      });
    expect(await stop()).toBe(true);
    expect(await stop()).toBe(false);
    const canceled = (await prisma.teamSet.findUniqueOrThrow({ where: { id: second.id } }))
      .create_state as unknown as CreateState;
    expect(canceled).toMatchObject({
      status: 'FAILED',
      failed: [{ team: '*', reason: 'canceled' }],
    });
    // applyCreate on a stopped create changes nothing and makes nothing.
    const again = await teamSetService.applyCreate({
      teamSetId: second.id,
      attemptId: movedAttempt,
    });
    expect(again.status).toBe('FAILED');
    expect(createTeamMock).not.toHaveBeenCalled();

    // A retry whose task cannot be queued goes back to the FAILED state it retried.
    triggerMock.mockRejectedValueOnce(new Error('network down'));
    expect(
      await codeOf(
        teamSetService.claimCreate({
          classroomId,
          teamSetId: second.id,
          runId: runA.id,
          userId: ownerId,
        })
      )
    ).toBe('trigger_unavailable');
    const restored = await prisma.teamSet.findUniqueOrThrow({ where: { id: second.id } });
    expect(restored.created_run_id).toBe(runB.id);
    expect(restored.create_state).toEqual(canceled);
  });

  it('stops making teams once the create is stopped underneath it', async () => {
    const third = await teamSetService.saveConfig({
      classroomId,
      formId,
      userId: ownerId,
      name: `third ${suite}`,
      patch: { team_size: { min: 2, max: 3 } },
    });
    const run = await solvedRun(third.id);
    await teamSetService.claimCreate({
      classroomId,
      teamSetId: third.id,
      runId: run.id,
      userId: ownerId,
    });
    const attemptId = (await stateOf(third.id)).attempt_id!;
    // The first team is made; then a cancel lands before its progress is written.
    createTeamMock.mockImplementation(
      async ({ name, tagIds }: { name: string; tagIds: string[] }) => {
        await teamSetService.stopCreate({ teamSetId: third.id, attemptId, reason: 'canceled' });
        return {
          team: { id: randomUUID(), name, slug: name, isVisible: true },
          tagsAdded: tagIds,
          tagsFailed: [],
        };
      }
    );
    // …and one of its members could not be added.
    const missing = logins.get(run.result!.teams[0]!.member_user_ids[0]!)!;
    addTeamMembersMock.mockImplementation(async ({ logins: requested }: { logins: string[] }) => ({
      succeeded: requested.filter(l => l !== missing).map(login => ({ login })),
      failed: [{ login: missing, error: 'provider_error' }],
    }));

    const state = await teamSetService.applyCreate({ teamSetId: third.id, attemptId });
    expect(createTeamMock).toHaveBeenCalledTimes(1);
    // Still FAILED/canceled — not flipped back to RUNNING — and the team that
    // was made is recorded, so a retry skips it, with the member it could not
    // add, so the retry still reports that person.
    expect(state).toMatchObject({ status: 'FAILED' });
    expect(state.failed).toEqual([
      { team: '*', reason: 'canceled' },
      {
        team: state.teams[0]!.name,
        reason: 'members_failed',
        members: [
          {
            user_id: run.result!.teams[0]!.member_user_ids[0],
            login: missing,
            reason: 'provider_error',
          },
        ],
      },
    ]);
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0]!.n).toBe(1);
    expect(state.counts).toMatchObject({ members_failed: 1 });
    expect(await stateOf(third.id)).toEqual(state);
  });

  it('expires runs that outlived any task, on read and while waiting', async () => {
    const back = (minutes: number) => new Date(Date.now() - minutes * 60_000);

    const { run: queued } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    await prisma.teamSetRun.update({ where: { id: queued!.id }, data: { created_at: back(16) } });
    // Never started: its own code, not 'lost'.
    expect(
      await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: queued!.id })
    ).toMatchObject({ status: 'FAILED', error: 'queue_expired' });

    const { run: running } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    await teamSetService.markRunning(running!.id, null);
    await prisma.teamSetRun.update({ where: { id: running!.id }, data: { started_at: back(11) } });
    const waited = await teamSetService.waitForRun({
      classroomId,
      runId: running!.id,
      timeoutMs: 2000,
      pollMs: 50,
    });
    expect(waited).toMatchObject({ status: 'FAILED', error: 'lost' });

    // Queued long ago but picked up just now: alive.
    const { run: late } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    await teamSetService.markRunning(late!.id, null);
    await prisma.teamSetRun.update({ where: { id: late!.id }, data: { created_at: back(20) } });
    expect(
      await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: late!.id })
    ).toMatchObject({ status: 'RUNNING' });

    // The list and the form's set list expire in bulk.
    const { run: listed } = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
    });
    await prisma.teamSetRun.update({ where: { id: listed!.id }, data: { created_at: back(30) } });
    const summaries = await teamSetService.listForForm({ classroomId, formId });
    expect(summaries.find(s => s.id === setId)?.latest_run).toMatchObject({
      number: listed!.number,
      status: 'FAILED',
    });
    expect(
      await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: listed!.id })
    ).toMatchObject({ error: 'queue_expired' });
    await teamSetService.failRun(late!.id, 'canceled');
  });

  // ── checkPatch ───────────────────────────────────────────────────────────

  it('checkPatch reports issues for a patch without saving anything', async () => {
    const snapshot = async () => ({
      sets: await prisma.teamSet.count({ where: { form_id: formId } }),
      runs: await prisma.teamSetRun.count({ where: { team_set: { form_id: formId } } }),
      config: (await prisma.teamSet.findUniqueOrThrow({ where: { id: setId } })).config,
    });
    const before = await snapshot();

    const checked = await teamSetService.checkPatch({
      classroomId,
      formId,
      setRef: setId,
      patch: { team_size: { min: 1, max: 2 } },
    });
    expect(checked.set).toEqual({ id: setId, name: setName });
    expect(checked.config.team_size).toMatchObject({ min: 1, max: 2 });
    expect(checked.issues.some(issue => issue.level === 'error' && issue.code === 'capacity')).toBe(
      true
    );

    // A second, not-yet-existing set is checked from the suggestion.
    const fresh = await teamSetService.checkPatch({
      classroomId,
      formId,
      newSet: true,
      patch: { team_size: { min: 2, max: 3 } },
    });
    expect(fresh.set).toBeNull();
    expect(fresh.config.rules.map(r => r.job).sort()).toEqual(['note', 'rank', 'together']);

    // A patch that does not parse is refused like saveConfig refuses it.
    expect(
      await codeOf(
        teamSetService.checkPatch({ classroomId, formId, setRef: setId, patch: { fairness: 500 } })
      )
    ).toBe('invalid_config');

    expect(await snapshot()).toEqual(before);
  });

  // ── Create robustness: attempts, heartbeats, retries ─────────────────────

  it('ties a create to its attempt: a released attempt’s task does nothing; a reclaim gets a fresh key', async () => {
    const set = await newSet('attempt');
    const run = await solvedRun(set.id);
    const claim = () =>
      teamSetService.claimCreate({
        classroomId,
        teamSetId: set.id,
        runId: run.id,
        userId: ownerId,
      });

    triggerMock.mockRejectedValueOnce(new Error('network down'));
    expect(await codeOf(claim())).toBe('trigger_unavailable');
    const [, released, releasedOptions] = applyCalls().at(-1)!;

    await claim();
    const current = await stateOf(set.id);
    const [, payload, options] = applyCalls().at(-1)!;
    expect(payload).toEqual({ teamSetId: set.id, attemptId: current.attempt_id });
    expect(options).toEqual({ idempotencyKey: `team-set-apply:${set.id}:${current.attempt_id}` });
    // The released claim never happened (still attempt 1), but its identity
    // and key are spent: the reclaim is a new task, not the old one handed back.
    expect(current.attempt).toBe(1);
    expect(released.attemptId).not.toBe(current.attempt_id);
    expect(releasedOptions.idempotencyKey).not.toBe(options.idempotencyKey);

    // The released attempt's task, delivered after all, touches nothing.
    expect(
      await teamSetService.applyCreate({ teamSetId: set.id, attemptId: released.attemptId })
    ).toEqual(current);
    expect(
      await teamSetService.stopCreate({
        teamSetId: set.id,
        attemptId: released.attemptId,
        reason: 'canceled',
      })
    ).toBe(false);
    expect(await stateOf(set.id)).toEqual(current);
    expect(createTeamMock).not.toHaveBeenCalled();

    // The current attempt's task stamps its start before it makes a team.
    const seen: CreateState[] = [];
    createTeamMock.mockImplementation(async (args: { name: string; tagIds: string[] }) => {
      if (seen.length === 0) seen.push(await stateOf(set.id));
      return realCreateTeam(args);
    });
    addTeamMembersMock.mockImplementation(allAdded);
    const done = await teamSetService.applyCreate({
      teamSetId: set.id,
      attemptId: current.attempt_id!,
    });
    expect(done.status).toBe('DONE');
    expect(seen[0]!.task_started_at).toEqual(expect.any(String));
    expect(Date.parse(seen[0]!.heartbeat_at!)).toBeGreaterThanOrEqual(
      Date.parse(current.started_at)
    );
  });

  it('expires a create 35 minutes after its last sign of life, not after its claim', async () => {
    const set = await newSet('heartbeat');
    const run = await solvedRun(set.id);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const put = (times: Partial<CreateState>) =>
      prisma.teamSet.update({
        where: { id: set.id },
        data: {
          created_run_id: run.id,
          create_state: {
            status: 'RUNNING',
            run_id: run.id,
            run_number: run.number,
            total: run.result!.teams.length,
            done: 0,
            failed: [],
            teams: [],
            names: [],
            attempt: 1,
            attempt_id: randomUUID(),
            claimed_by: ownerId,
            started_at: ago(0),
            finished_at: null,
            ...times,
          } as unknown as object,
        },
      });
    const status = async () =>
      (await teamSetService.getSet({ classroomId, formId, setRef: set.id }))!.create_state!.status;

    // Claimed 50 minutes ago, but the task sat in the queue and started 10 minutes ago.
    await put({ started_at: ago(50), heartbeat_at: ago(50), task_started_at: ago(10) });
    expect(await status()).toBe('RUNNING');
    // Started an hour ago; its last progress write was 30 minutes ago.
    await put({ started_at: ago(70), task_started_at: ago(60), heartbeat_at: ago(30) });
    expect(await status()).toBe('RUNNING');
    // 36 minutes without a sign of life.
    await put({ started_at: ago(70), task_started_at: ago(60), heartbeat_at: ago(36) });
    expect(await status()).toBe('FAILED');
    expect(await stateOf(set.id)).toMatchObject({ failed: [{ team: '*', reason: 'lost' }] });
    // Claimed 36 minutes ago and never started.
    await put({ started_at: ago(36), heartbeat_at: ago(36), task_started_at: null });
    expect(await status()).toBe('FAILED');
  });

  it('throws when the final write fails, and a same-run retry adopts the team it never recorded', async () => {
    const set = await newSet('adopt');
    const run = await solvedRun(set.id);
    const total = run.result!.teams.length;
    await teamSetService.claimCreate({
      classroomId,
      teamSetId: set.id,
      runId: run.id,
      userId: ownerId,
    });
    const claimed = await stateOf(set.id);
    createTeamMock.mockImplementation(realCreateTeam);
    addTeamMembersMock.mockImplementation(allAdded);

    // The database goes away as the last team is made: that team's progress
    // write (best effort, swallowed) and every try of the final write fail.
    const delegate = prisma.teamSet;
    const original = delegate.updateMany;
    let refused = 0;
    delegate.updateMany = (async (args: { data?: { create_state?: { teams?: unknown[] } } }) => {
      if ((args.data?.create_state?.teams?.length ?? 0) >= total) {
        refused += 1;
        throw new Prisma.PrismaClientKnownRequestError('connection lost', {
          code: 'P1017',
          clientVersion: 'test',
        });
      }
      return original.call(delegate, args as never);
    }) as unknown as typeof delegate.updateMany;
    let thrown: unknown;
    try {
      await teamSetService.applyCreate({ teamSetId: set.id, attemptId: claimed.attempt_id! });
    } catch (error) {
      thrown = error;
    } finally {
      delegate.updateMany = original;
    }
    expect(thrown).toMatchObject({ name: 'CreateStateWriteError', code: 'state_write_failed' });
    expect(refused).toBe(1 + 3);
    expect(createTeamMock).toHaveBeenCalledTimes(total);

    // What the task's catch does next. The last team exists, unrecorded.
    expect(
      await teamSetService.stopCreate({
        teamSetId: set.id,
        attemptId: claimed.attempt_id!,
        reason: 'internal_error',
      })
    ).toBe(true);
    const stopped = await stateOf(set.id);
    expect(stopped.status).toBe('FAILED');
    expect(stopped.teams).toHaveLength(total - 1);

    // A tagged team under no planned name is still someone else's.
    const tag = await prisma.tag.findUniqueOrThrow({
      where: { classroom_id_name: { classroom_id: classroomId, name: set.name } },
    });
    const stranger = await prisma.team.create({
      data: { classroom_id: classroomId, name: `stranger-${suite}`, slug: `stranger-${suite}` },
    });
    await prisma.teamTag.create({ data: { tag_id: tag.id, team_id: stranger.id } });
    expect(
      await codeOf(teamSetService.previewCreate({ classroomId, teamSetId: set.id, runRef: run.id }))
    ).toBe('tag_conflict');
    await prisma.teamTag.deleteMany({ where: { team_id: stranger.id } });

    // The unrecorded team holds the last planned name: adopted. Nothing is
    // left to make, so nothing is asked of GitHub.
    getTeamMock.mockClear();
    const preview = await teamSetService.previewCreate({
      classroomId,
      teamSetId: set.id,
      runRef: run.id,
    });
    expect(preview.retry).toEqual({ attempt: 2, teams_already_created: total });
    expect(preview.teams.map(t => t.name)).toEqual(claimed.names);
    expect(getTeamMock).not.toHaveBeenCalled();

    await teamSetService.claimCreate({
      classroomId,
      teamSetId: set.id,
      runId: run.id,
      userId: ownerId,
    });
    const retry = await stateOf(set.id);
    const last = await prisma.team.findFirstOrThrow({
      where: { classroom_id: classroomId, slug: claimed.names![total - 1]!.toLowerCase() },
    });
    expect(retry.teams.at(-1)).toEqual({
      team_id: last.id,
      name: last.name,
      n: total,
      adopted: true,
    });
    expect(retry.done).toBe(total);

    // The retry makes no team; it adds the adopted team's members again
    // (idempotent), drops the flag, and finishes.
    createTeamMock.mockClear();
    addTeamMembersMock.mockClear();
    const final = await teamSetService.applyCreate({
      teamSetId: set.id,
      attemptId: retry.attempt_id!,
    });
    expect(createTeamMock).not.toHaveBeenCalled();
    expect(addTeamMembersMock).toHaveBeenCalledTimes(1);
    expect(addTeamMembersMock).toHaveBeenCalledWith(expect.objectContaining({ slugOrId: last.id }));
    expect(final.status).toBe('DONE');
    expect(final.teams).toHaveLength(total);
    expect(final.teams.some(t => t.adopted)).toBe(false);
  });

  it('lets a same-run retry through ordinary staleness, but not past a member who left', async () => {
    const set = await newSet('stale retry');
    const run = await solvedRun(set.id);
    await teamSetService.claimCreate({
      classroomId,
      teamSetId: set.id,
      runId: run.id,
      userId: ownerId,
    });
    const claimed = await stateOf(set.id);
    // Team 1 is made; the others fail.
    let made = 0;
    createTeamMock.mockImplementation(async (args: { name: string; tagIds: string[] }) => {
      made += 1;
      if (made > 1) throw new TeamServiceError('name_collision', 'raw');
      return realCreateTeam(args);
    });
    addTeamMembersMock.mockImplementation(allAdded);
    const failed = await teamSetService.applyCreate({
      teamSetId: set.id,
      attemptId: claimed.attempt_id!,
    });
    expect(failed.status).toBe('FAILED');

    const preview = () =>
      teamSetService.previewCreate({ classroomId, teamSetId: set.id, runRef: run.id });
    const [editor, leaver] = run.result!.teams[1]!.member_user_ids;
    const leaverOfMade = run.result!.teams[0]!.member_user_ids[0]!;
    try {
      // An answer changes: the run is stale, which would refuse a new create…
      await submit(editor!, { [rankFieldId]: [optionIds[1], optionIds[2]] });
      expect((await teamSetService.staleness({ classroomId, run })).stale).toBe(true);
      // …but a retry finishes a grouping that is already partly real.
      const allowed = await preview();
      expect(allowed.retry).toEqual({ attempt: 2, teams_already_created: 1 });
      expect(
        allowed.warnings.some(w =>
          w.startsWith(`Answers or the roster changed since run ${run.number}`)
        )
      ).toBe(true);

      // A member of a team already made leaving does not block it either…
      await prisma.classroomMembership.deleteMany({
        where: { classroom_id: classroomId, user_id: leaverOfMade },
      });
      await preview();
      // …a member of a team still to make does.
      await prisma.classroomMembership.deleteMany({
        where: { classroom_id: classroomId, user_id: leaver! },
      });
      const blocked = (await preview().catch(e => e)) as { code: string; details: unknown };
      expect(blocked.code).toBe('run_stale');
      expect(blocked.details).toEqual({
        reasons: ['1 person on teams not yet created has left the class.'],
        retry_blocked: true,
      });
      expect(
        await codeOf(
          teamSetService.claimCreate({
            classroomId,
            teamSetId: set.id,
            runId: run.id,
            userId: ownerId,
          })
        )
      ).toBe('run_stale');
    } finally {
      for (const userId of [leaverOfMade, leaver!]) {
        const enrolled = await prisma.classroomMembership.count({
          where: { classroom_id: classroomId, user_id: userId },
        });
        if (enrolled === 0) await enroll(userId);
      }
    }
  });

  it('suffixes a name GitHub holds on a retry, but refuses it on a first create', async () => {
    const set = await newSet('gh names');
    const run = await solvedRun(set.id);
    const planned = run.result!.teams.map(
      (_, i) => `${set.name}-${String(i + 1).padStart(2, '0')}`
    );
    const onGithub = (taken: string[]) =>
      getTeamMock.mockImplementation(async (_org: string, slug: string) => {
        if (taken.includes(slug)) return { slug };
        throw notFound();
      });

    // First create: the owner has approved nothing yet — refused, by name.
    onGithub([planned[1]!]);
    const first = (await teamSetService
      .previewCreate({ classroomId, teamSetId: set.id, runRef: run.id })
      .catch(e => e)) as { code: string; details: unknown };
    expect(first.code).toBe('name_collision');
    expect(first.details).toEqual({ names: [planned[1]] });

    // It goes ahead (the name was freed); team 2 then fails at GitHub.
    onGithub([]);
    await teamSetService.claimCreate({
      classroomId,
      teamSetId: set.id,
      runId: run.id,
      userId: ownerId,
    });
    const claimed = await stateOf(set.id);
    createTeamMock.mockImplementation(async (args: { name: string; tagIds: string[] }) => {
      if (args.name === planned[1]) throw new TeamServiceError('name_collision', 'raw');
      return realCreateTeam(args);
    });
    addTeamMembersMock.mockImplementation(allAdded);
    await teamSetService.applyCreate({ teamSetId: set.id, attemptId: claimed.attempt_id! });

    // The retry: GitHub holds the planned name AND its first suffix. It moves
    // to the first free one, and only the moved name is asked about.
    onGithub([planned[1]!, `${planned[1]}-2`]);
    getTeamMock.mockClear();
    const preview = await teamSetService.previewCreate({
      classroomId,
      teamSetId: set.id,
      runRef: run.id,
    });
    const expected = planned.map((name, i) => (i === 1 ? `${name}-3` : name));
    expect(preview.teams.map(t => t.name)).toEqual(expected);
    expect(getTeamMock.mock.calls.map(([, slug]) => slug)).toEqual([
      planned[1],
      `${planned[1]}-2`,
      `${planned[1]}-3`,
    ]);
    // The claim stores exactly the names the preview showed.
    await teamSetService.claimCreate({
      classroomId,
      teamSetId: set.id,
      runId: run.id,
      userId: ownerId,
    });
    expect((await stateOf(set.id)).names).toEqual(expected);
  });

  it('bounds the GitHub pre-flight: out of time, or the first answer that is not a 404', async () => {
    const set = await newSet('budget');
    const run = await solvedRun(set.id);
    const preview = () =>
      teamSetService
        .previewCreate({ classroomId, teamSetId: set.id, runRef: run.id })
        .catch(e => e) as Promise<{ code: string; details?: unknown }>;

    teamSetService.__setPreflightBudgetForTests(300);
    try {
      // GitHub never answers a probe…
      getTeamMock.mockImplementation(() => new Promise(() => {}));
      let started = Date.now();
      const slow = await preview();
      expect(slow).toMatchObject({ code: 'github_unavailable', details: { reason: 'timeout' } });
      expect(Date.now() - started).toBeLessThan(3_000);
      // …or the organization read (with its token mint) never returns.
      getOrganizationMock.mockImplementationOnce(() => new Promise(() => {}));
      started = Date.now();
      expect(await preview()).toMatchObject({ details: { reason: 'timeout' } });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      teamSetService.__setPreflightBudgetForTests();
    }

    // A 502 ends it at once — no retry, no wait for the probes still in
    // flight, which are aborted.
    probeSignals.length = 0;
    let calls = 0;
    getTeamMock.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(Object.assign(new Error('bad gateway'), { status: 502 }))
        : new Promise(() => {});
    });
    const started = Date.now();
    const down = await preview();
    expect(down.code).toBe('github_unavailable');
    expect(down.details).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(calls).toBeLessThanOrEqual(run.result!.teams.length);
    expect(probeSignals.length).toBeGreaterThan(0);
    expect(probeSignals.every(signal => signal.aborted)).toBe(true);
  });

  it('tells a classroom whose organization is not on GitHub that creating teams is GitHub only', async () => {
    const set = await newSet('gitlab');
    const run = await solvedRun(set.id);
    await prisma.gitOrganization.update({ where: { id: orgId }, data: { provider: 'GITLAB' } });
    try {
      expect(
        await codeOf(
          teamSetService.previewCreate({ classroomId, teamSetId: set.id, runRef: run.id })
        )
      ).toBe('provider_unsupported');
      expect(
        await codeOf(
          teamSetService.claimCreate({
            classroomId,
            teamSetId: set.id,
            runId: run.id,
            userId: ownerId,
          })
        )
      ).toBe('provider_unsupported');
    } finally {
      await prisma.gitOrganization.update({ where: { id: orgId }, data: { provider: 'GITHUB' } });
    }
    expect(getOrganizationMock).not.toHaveBeenCalled();
  });
});
