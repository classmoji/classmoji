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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import type { TeamSetProblem } from '../teamSetProblem.ts';
import { prng } from './helpers/teamSetFixtures.ts';

/**
 * The real engine, from packages/tasks' Python venv (see its README). Tests
 * that need a real solve are skipped where it is missing.
 */
const ENGINE_PYTHON = fileURLToPath(
  new URL('../../../../tasks/python/.venv/bin/python', import.meta.url)
);
const ENGINE_SCRIPT = fileURLToPath(
  new URL('../../../../tasks/python/team_set_solver.py', import.meta.url)
);
const HAS_ENGINE = existsSync(ENGINE_PYTHON) && existsSync(ENGINE_SCRIPT);

/** Solve a problem with the engine and return its result line, as the solve task hands it on. */
function solveWithEngine(problem: TeamSetProblem): SolverOutput {
  const dir = mkdtempSync(join(tmpdir(), 'team-set-'));
  const file = join(dir, 'problem.json');
  writeFileSync(file, JSON.stringify(problem));
  try {
    const stdout = execFileSync(ENGINE_PYTHON, [ENGINE_SCRIPT, file, '--workers', '2'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    const lines = stdout
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type: string } & SolverOutput);
    const result = lines.reverse().find(line => line.type === 'result');
    if (!result) throw new Error('the engine printed no result line');
    const { type: _type, ...output } = result;
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  /** The unique key of a Github account by username. */
  const githubUsername = (username: string) => ({
    provider_id_gitlab_instance_id_username: {
      provider_id: 'github',
      gitlab_instance_id: '',
      username,
    },
  });

  const makeUser = async (label: string) => {
    const login = `tstest-${suite}-${label}`;
    const user = await prisma.user.create({
      data: {
        email: `${login}@example.test`,
        name: `Team Test ${label}`,
        accounts: { create: { provider_id: 'github', account_id: login, username: login } },
      },
    });
    logins.set(user.id, login);
    return user.id;
  };

  const enroll = (userId: string, role: 'STUDENT' | 'OWNER' | 'TEACHER' = 'STUDENT') =>
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

  /**
   * A run of the shared set, turned SOLVED by a round-robin assignment the
   * scorer accepts. People are ordered by user id, which is random per test
   * run, so the round robin goes over seeded orders until one keeps every pin
   * (an apart pin can put two people a multiple of the slot count apart).
   */
  const solvedRun = async (teamSetId = setId): Promise<TeamSetRunRow> => {
    const { run } = await teamSetService.startRun({
      classroomId,
      teamSetId,
      userId: ownerId,
      seed: 7,
    });
    expect(run).not.toBeNull();
    const slots = run!.problem.slots.length;
    const random = prng(7);
    const roundRobin = (order: number[]) =>
      Array.from({ length: slots }, (_, slot) => ({
        slot,
        members: order.filter((_, i) => i % slots === slot).sort((a, b) => a - b),
      })).filter(t => t.members.length > 0);
    let order = run!.problem.people.map((_, p) => p);
    let teams = roundRobin(order);
    for (
      let tries = 0;
      tries < 50 && scoreAssignment(run!.problem, teams).violations.length;
      tries++
    ) {
      order = order
        .map(p => ({ p, key: random() }))
        .sort((a, b) => a.key - b.key)
        .map(entry => entry.p);
      teams = roundRobin(order);
    }
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

  /**
   * The names a create gives a run's teams: the suggestion's template is
   * `{set}-{option}`, and each option runs one team here.
   */
  const optionSlugs = () => new Map(optionIds.map((id, i) => [id, ['alpha', 'beta', 'gamma'][i]!]));
  const plannedNames = (name: string, run: TeamSetRunRow): string[] =>
    run.result!.teams.map(team => `${name}-${optionSlugs().get(team.option_id!)}`);

  /** Finish every run of a set still QUEUED or RUNNING, so the next start isn't `run_in_progress`. */
  const settleRuns = async (teamSetId = setId) => {
    const open = await prisma.teamSetRun.findMany({
      where: { team_set_id: teamSetId, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    for (const { id } of open) await teamSetService.failRun(id, 'canceled');
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
      .deleteMany({
        where: {
          accounts: {
            some: { provider_id: 'github', username: { startsWith: `tstest-${suite}-` } },
          },
        },
      })
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
      // 3 teams × (1 + 1) < 8 people, even with every team one person over its size.
      patch: { team_size: { min: 1, max: 1 } },
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

  it('numbers runs 1..n, one unfinished run at a time, and queues each solve', async () => {
    const first = await teamSetService.startRun({
      classroomId,
      teamSetId: setId,
      userId: ownerId,
      seed: 1,
    });
    expect(first.run?.number).toBe(1);
    expect(first.run?.status).toBe('QUEUED');
    // Run 1 is still QUEUED: another start is refused, naming it.
    const busy = (await teamSetService
      .startRun({ classroomId, teamSetId: setId, userId: ownerId })
      .catch(e => e)) as { code: string; details: unknown };
    expect(busy.code).toBe('run_in_progress');
    expect(busy.details).toEqual({ run_number: 1 });
    // The snapshot says how people who didn't answer were placed, resolved.
    expect(first.run?.config.non_respondents).toBe('include');

    const firstTrigger = triggerMock.mock.calls[0];
    await settleRuns();
    // Two starts at once: the row lock lets one through; the other finds it running.
    const raced = await Promise.allSettled([
      teamSetService.startRun({ classroomId, teamSetId: setId, userId: ownerId, seed: 2 }),
      teamSetService.startRun({ classroomId, teamSetId: setId, userId: ownerId, seed: 3 }),
    ]);
    const won = raced.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof teamSetService.startRun>>
    >[];
    expect(won).toHaveLength(1);
    expect(won[0]!.value.run?.number).toBe(2);
    const lost = raced.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('run_in_progress');
    await settleRuns();
    expect(firstTrigger).toBeDefined();
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
      { src, label: 'Who would you like to work with? (together, prefer)' },
    ]);
    // The listed rules collide WITH the structural limits, and it says so (facts, no advice).
    expect(done.diagnostics?.summary).toBe(
      "The settings listed can't all be met together within the team-size, teams-per-option and team-count limits."
    );
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
      "'Alpha' is closed",
      'A apart rule on a question no longer on the form',
      'Another setting of this team set',
    ]);
    expect(done.diagnostics?.core_status).toBe('timeout');
    expect(done.diagnostics?.summary).toMatch(
      /Some settings listed may not be part of the conflict/
    );
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
    const LIMITS_ALONE =
      "The team-size, teams-per-option and team-count limits alone can't place everyone.";
    expect(empty.diagnostics?.summary).toBe(LIMITS_ALONE);
    expect(empty.engine).toBe(teamSetService.TEAM_SET_ENGINE);

    const view = await teamSetService.describeRun({
      classroomId,
      run: empty,
      includePeople: false,
    });
    expect(view.summary).toBe(LIMITS_ALONE);
    // A run stored with an older (advice) sentence reads as facts: the
    // sentence is computed on read.
    await prisma.teamSetRun.update({
      where: { id: empty.id },
      data: {
        diagnostics: { ...(empty.diagnostics as object), summary: 'Change those limits.' },
      },
    });
    const reread = await teamSetService.getRun({ classroomId, teamSetId: setId, runRef: empty.id });
    expect(
      (await teamSetService.describeRun({ classroomId, run: reread, includePeople: false })).summary
    ).toBe(LIMITS_ALONE);
    // Can't solve's runline: this run's setup against the run before it.
    expect(view.changes_from_previous).toEqual({ since_run: empty.number - 1, items: [] });
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
      created_at: solved.created_at.toISOString(),
      finished_at: solved.finished_at!.toISOString(),
      error: null,
      solver_status: 'OPTIMAL',
      gap_pct: 0,
      first_choice: solved.metrics!.first_choice,
      responded: solved.metrics!.responded,
      created_by: { user_id: ownerId, name: 'Team Test owner' },
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
    await settleRuns();
  });

  // ── Describe ─────────────────────────────────────────────────────────────

  it('describes a run with names, placements and notes — and no emails', async () => {
    const run = await solvedRun();
    const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
    expect(view).toMatchObject({ number: run.number, status: 'SOLVED', stale: false });
    expect(view.teams.map(t => t.name)).toEqual(plannedNames(setName, run));
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
    await settleRuns();

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
    const freshNames = plannedNames(setName, fresh);
    getTeamMock.mockImplementation(async (_org: string, slug: string) => {
      if (slug === freshNames[1]) return { slug };
      throw notFound();
    });
    const collision = (await teamSetService
      .previewCreate({ classroomId, teamSetId: setId, runRef: fresh.number })
      .catch(e => e)) as { code: string; details: unknown };
    expect(collision.code).toBe('name_collision');
    expect(collision.details).toEqual({ names: [freshNames[1]] });
    getTeamMock.mockReset();
    getTeamMock.mockRejectedValue(notFound());

    // A name already used in the classroom is suffixed, not refused.
    const clash = await prisma.team.create({
      data: { classroom_id: classroomId, name: freshNames[0]!, slug: freshNames[0]! },
    });
    const suffixed = await teamSetService.previewCreate({
      classroomId,
      teamSetId: setId,
      runRef: fresh.number,
    });
    expect(suffixed.teams[0]!.name).toBe(`${freshNames[0]}-2`);
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
      name_template: '{set}-{option}',
      students: STUDENTS,
      warnings: [],
    });
    expect(preview.teams.map(t => t.name)).toEqual(freshNames);
    expect(preview.teams.map(t => t.size)).toEqual(
      fresh.result!.teams.map(t => t.member_user_ids.length)
    );
    // The Create dialog's checkbox: only GitHub teams are made.
    expect(
      await codeOf(
        teamSetService.previewCreate({
          classroomId,
          teamSetId: setId,
          runRef: fresh.number,
          githubTeams: false,
        })
      )
    ).toBe('github_teams_off_unsupported');
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
      names: plannedNames(setName, run),
      sizes: run.result!.teams.map(t => t.member_user_ids.length),
    });
    expect(
      await codeOf(teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: run.id }))
    ).toBe('create_in_progress');
    // Claimed, nothing made yet: the first team is being made, the rest wait.
    const progress = await teamSetService.getCreateProgress({ classroomId, teamSetId: setId });
    expect(progress).toMatchObject({ status: 'RUNNING', done: 0, members_total: STUDENTS });
    expect(progress!.teams.map(team => team.state)).toEqual(
      run.result!.teams.map((_, i) => (i === 0 ? 'live' : 'queued'))
    );
    // A claimed set is locked while its teams are made.
    expect(await teamSetService.getSet({ classroomId, formId, setRef: setId })).toMatchObject({
      status: 'creating',
      locked: true,
    });
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
    const names = plannedNames(setName, run);
    expect(state.failed).toEqual([
      {
        team: names[0],
        reason: 'members_failed',
        members: [
          {
            user_id: run.result!.teams[0]!.member_user_ids[0],
            login: failingLogin,
            reason: 'provider_error',
          },
        ],
      },
      { team: names[1], reason: 'name_collision' },
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
    const view = await teamSetService.getCreateProgress({ classroomId, teamSetId: setId });
    expect(view!.teams[1]).toMatchObject({
      n: 2,
      name: names[1],
      state: 'failed',
      failure: 'name_collision',
      members_added: 0,
    });
    expect(view!.teams[0]).toMatchObject({
      state: 'done',
      github_team: true,
      members_added: run.result!.teams[0]!.member_user_ids.length - 1,
    });

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
    expect(getTeamMock.mock.calls.map(([, slug]) => slug)).toEqual([names[1]]);
    // …but no other run can be, while teams from this one exist.
    const other = await prisma.teamSetRun.findFirstOrThrow({
      where: { team_set_id: setId, status: 'SOLVED', id: { not: run.id } },
      select: { id: true },
    });
    expect(
      await codeOf(
        teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: other.id })
      )
    ).toBe('already_created');
    // And the set is locked: no save, no run, no Discard.
    expect(
      await codeOf(
        teamSetService.saveConfig({ classroomId, formId, userId: ownerId, patch: { fairness: 40 } })
      )
    ).toBe('set_locked');
    expect(
      await codeOf(teamSetService.startRun({ classroomId, teamSetId: setId, userId: ownerId }))
    ).toBe('set_locked');
    expect(
      await codeOf(
        teamSetService.revertToRun({
          classroomId,
          teamSetId: setId,
          runRef: other.id,
          userId: ownerId,
        })
      )
    ).toBe('set_locked');
    const failedSet = await teamSetService.getSet({ classroomId, formId, setRef: setId });
    expect(failedSet).toMatchObject({ status: 'create_failed', locked: true });
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
      await prisma.account.update({
        where: githubUsername(requested[1]!),
        data: { username: `${requested[1]}-renamed` },
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
    expect(createTeamMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: plannedNames(setName, run)[1] })
    );
    // Every team exists now; only member adds are missing → PARTIAL, not FAILED.
    expect(state.status).toBe('PARTIAL');
    expect(state.teams.map(t => t.n).sort()).toEqual(run.result!.teams.map((_, i) => i + 1));
    expect(state.failed.at(-1)).toEqual({
      team: plannedNames(setName, run)[1],
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
    await prisma.account.update({
      where: githubUsername(`${team2[1]}-renamed`),
      data: { username: team2[1]! },
    });

    // PARTIAL is final: the set is locked, and the rest is by hand on the Teams screen.
    expect(
      await codeOf(teamSetService.previewCreate({ classroomId, teamSetId: setId, runRef: runId }))
    ).toBe('set_locked');
    expect(
      await codeOf(
        teamSetService.claimCreate({ classroomId, teamSetId: setId, runId, userId: ownerId })
      )
    ).toBe('set_locked');
    expect(deleteTeamMock).not.toHaveBeenCalled();

    // Where it stands, for the list, the layout and the poll.
    const row = (await teamSetService.listForForm({ classroomId, formId })).find(
      entry => entry.id === setId
    )!;
    expect(row).toMatchObject({
      status: 'partial',
      created: { run_number: run.number, teams_created: run.result!.teams.length },
    });
    expect(await teamSetService.getSet({ classroomId, formId, setRef: setId })).toMatchObject({
      status: 'partial',
      locked: true,
    });
    const poll = await teamSetService.pollStatus({ classroomId, teamSetId: setId });
    expect(poll.create).toMatchObject({
      status: 'PARTIAL',
      run_number: run.number,
      attempt: 2,
      total: run.result!.teams.length,
      members_total: STUDENTS,
      claimed_by: { user_id: ownerId, name: 'Team Test owner' },
      tag: { name: setName },
      renamed: [],
    });
    expect(poll.create!.teams.map(t => t.state)).toEqual(run.result!.teams.map(() => 'done'));
    expect(poll.create!.teams[1]).toMatchObject({
      name: plannedNames(setName, run)[1],
      size: run.result!.teams[1]!.member_user_ids.length,
      // Of its members, two could not be added (GitHub unknown, no Classmoji user).
      members_added: run.result!.teams[1]!.member_user_ids.length - 2,
      github_team: true,
    });
    const failedMember = poll.create!.failures.at(-1)!.members![0]!;
    expect(failedMember.name).toMatch(/^Team Test s/);
    expect(poll.signature).toMatch(/^[0-9a-f]{16}$/);
    expect((await teamSetService.pollStatus({ classroomId, teamSetId: setId })).signature).toBe(
      poll.signature
    );
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
    // The shared set is created (locked); this one is not.
    const { id: setId } = await newSet('expiry');

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
    // Alive, so it blocks another start.
    expect(
      await codeOf(teamSetService.startRun({ classroomId, teamSetId: setId, userId: ownerId }))
    ).toBe('run_in_progress');
    await teamSetService.failRun(late!.id, 'canceled');

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
      // 3 teams × (1 + 1) < 8 people, even with every team one person over its size.
      patch: { team_size: { min: 1, max: 1 } },
    });
    expect(checked.set).toEqual({ id: setId, name: setName });
    expect(checked.config.team_size).toMatchObject({ min: 1, max: 1 });
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
      expect(allowed.warnings).toContain(`Changed since run ${run.number}: 1 response was edited.`);

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
    const planned = plannedNames(set.name, run);
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
    // The claim stores exactly the names the preview showed, and says which it renamed.
    await teamSetService.claimCreate({
      classroomId,
      teamSetId: set.id,
      runId: run.id,
      userId: ownerId,
    });
    expect((await stateOf(set.id)).names).toEqual(expected);
    const renamed = [{ n: 2, from: planned[1], to: `${planned[1]}-3` }];
    expect((await stateOf(set.id)).renamed).toEqual(renamed);
    expect(
      (await teamSetService.getCreateProgress({ classroomId, teamSetId: set.id }))!.renamed
    ).toEqual(renamed);
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

  it('lets a classroom on Gitlab preview and claim a create, with no Github pre-flight', async () => {
    const set = await newSet('gitlab');
    const run = await solvedRun(set.id);
    await prisma.gitOrganization.update({ where: { id: orgId }, data: { provider: 'GITLAB' } });
    try {
      // Gitlab teams are subgroups: no up-front name probe, each create
      // refuses a taken name on its own.
      const preview = await teamSetService.previewCreate({
        classroomId,
        teamSetId: set.id,
        runRef: run.id,
      });
      expect(preview.teams.length).toBe(run.result!.teams.length);
      expect(
        await codeOf(
          teamSetService.claimCreate({
            classroomId,
            teamSetId: set.id,
            runId: run.id,
            userId: ownerId,
          })
        )
      ).toBeUndefined();
    } finally {
      await prisma.gitOrganization.update({ where: { id: orgId }, data: { provider: 'GITHUB' } });
    }
    expect(getOrganizationMock).not.toHaveBeenCalled();
    expect(getTeamMock).not.toHaveBeenCalled();
  });

  // ── Release 2: Setup, stamps, changes, compare, why, identity, two stages ──
  //
  // A second form, so its respondents stay as set here: six of the eight
  // students answer, s6 and s7 don't. It asks an IDENTITY question (answers
  // Oak / Pine / Birch; Pine twice, Birch once), which must never show up next
  // to a person. Runs are solved by the REAL local engine (packages/tasks'
  // Python venv), so a two-stage group run goes through it end to end; the
  // block is skipped where the venv is missing.

  // Real solves: a first solve pays the engine's start-up, and a loaded
  // machine stretches every solve, so these tests get more than the default.
  describe.skipIf(!HAS_ENGINE)(
    'setup, runs and identity on a second form',
    { timeout: 60_000 },
    () => {
      let form2Id: string;
      let rev2Id: string;
      let rank2: string;
      let note2: string;
      let who2: string;
      let options2: string[];
      let teacherId: string;
      let oakId: string;
      let setB: string;
      let setBName: string;
      /** Identity answers by student index (s0…s5), as option labels. */
      const IDENTITY = ['Oak', 'Pine', 'Oak', 'Birch', 'Oak', 'Pine'];
      const QUESTION = 'Which of these describe you?';

      /** Start a run of a set, solve its problem with the engine, record the answer. */
      const engineRun = async (teamSetId: string, seed = 11) => {
        const { run, issues } = await teamSetService.startRun({
          classroomId,
          teamSetId,
          userId: ownerId,
          seed,
        });
        expect(run, JSON.stringify(issues)).not.toBeNull();
        return teamSetService.completeRun(run!.id, solveWithEngine(run!.problem));
      };

      beforeAll(async () => {
        teacherId = await makeUser('teacher');
        // A member of the classroom: views name only its members.
        await enroll(teacherId, 'TEACHER');
        const A = randomUUID();
        const B = randomUUID();
        const G = randomUUID();
        const projects = [
          { id: A, label: 'Alpha' },
          { id: B, label: 'Beta' },
          { id: G, label: 'Gamma' },
        ];
        const form = await formService.create({
          classroomId,
          title: `Project bidding ${suite}`,
          access: 'CLASSROOM',
          createdBy: ownerId,
          fields: [
            { type: 'ranked_choice', label: 'Rank the projects', options: projects, ranks: 2 },
            {
              type: 'roster_select',
              label: 'Who would you like to work with?',
              optionSource: 'roster',
              multiple: true,
            },
            { type: 'long_text', label: 'Anything the staff should know?' },
            { type: 'dropdown', label: 'Did you pitch one of these projects?', options: projects },
            {
              type: 'multiselect',
              label: QUESTION,
              options: ['Oak', 'Pine', 'Birch'],
              identity_question: true,
              help: 'Only staff see this.',
            },
          ],
        });
        await formService.update(form.id, { allow_multiple: true });
        const { revision } = await formService.publish(form.id);
        form2Id = form.id;
        rev2Id = revision.id;
        const fields = formService.fieldsOf(revision.fields);
        rank2 = fields[0]!.id;
        note2 = fields[2]!.id;
        who2 = fields[4]!.id;
        options2 = [A, B, G];
        const identityIds = new Map(
          (fields[4]!.options as { id: string; label: string }[]).map(o => [o.label, o.id])
        );
        oakId = identityIds.get('Oak')!;
        for (let i = 0; i < 6; i++) {
          const userId = studentIds[i]!;
          await responseService.submitClassroom({
            formId: form2Id,
            userId,
            email: `${logins.get(userId)}@example.test`,
            name: `Team Test ${userId.slice(0, 4)}`,
            revisionId: rev2Id,
            answers: {
              [rank2]: [options2[i % 3], options2[(i + 1) % 3]],
              [fields[1]!.id]: [studentIds[(i + 1) % 6]],
              [note2]: `Private note ${i}`,
              // s0 pitched Alpha, s3 pitched Beta.
              ...(i === 0 ? { [fields[3]!.id]: A } : i === 3 ? { [fields[3]!.id]: B } : {}),
              [who2]: [identityIds.get(IDENTITY[i]!)],
            },
          });
        }
      });

      it('getSetup: readiness, questions with Must labels and class counts, options, pins, checks', async () => {
        const saved = await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          userId: ownerId,
          name: `bidding ${suite}`,
          patch: {
            grouping: { mode: 'by_option', field_id: rank2, teams_per_option: 2 },
            team_size: { min: 2, max: 3 },
            time_limit_s: 10,
            pins: {
              add: [
                {
                  kind: 'on_option',
                  user_id: studentIds[1]!,
                  option_id: options2[2]!,
                  reason: 'Has a badge',
                },
              ],
            },
            options: { [options2[1]!]: { size: { max: 4 }, note: 'Needs a laptop' } },
          },
        });
        setB = saved.id;
        setBName = saved.name;
        expect(saved).toMatchObject({ status: 'setting_up', locked: false });
        // The suggestion: rank, together, note, owner, and no-one-alone on the
        // identity question with the majority answer (Oak, 3 of 6) left out.
        const identityRule = saved.config.rules.find(rule => rule.field_id === who2)!;
        expect(identityRule).toMatchObject({
          job: 'no_one_alone',
          strength: 'prefer',
          params: { wildcard_option_ids: [oakId] },
        });
        expect(saved.config.team_name_template).toBe('{set}-{option}');

        const setup = await teamSetService.getSetup({ classroomId, formId: form2Id, setRef: setB });
        expect(setup.set).toMatchObject({
          id: setB,
          name: setBName,
          status: 'setting_up',
          locked: false,
        });
        expect(setup.readiness).toEqual({
          roster: STUDENTS,
          answered: 6,
          not_answered: 2,
          closes_at: null,
          closed: false,
        });
        expect(setup.grouping).toEqual({ mode: 'by_option', field_id: rank2 });
        // The checks' arithmetic: Beta's own size (2–4) lets the 8 fit two teams.
        expect(setup.shape).toEqual({ people: STUDENTS, team_count_range: { min: 2, max: 4 } });
        expect(setup.non_respondents).toEqual({ mode: null, resolved: 'include', count: 2 });

        const byId = new Map(setup.questions.map(q => [q.field_id, q]));
        expect(byId.get(rank2)).toMatchObject({
          type: 'ranked_choice',
          type_facts: { options: 3, ranks: 2, required: false },
          identity: false,
          counts: { answered: 6, skipped: 0 },
          must_labels: { rank: 'Everyone gets one of the options they ranked' },
        });
        expect(setup.questions[1]).toMatchObject({
          counts: { requests: 6, mutual: 0 },
          must_labels: { together: 'Mutual requests always together' },
        });
        expect(setup.questions[3]).toMatchObject({ counts: { pitchers: 2 } });
        const identity = byId.get(who2)!;
        expect(identity).toMatchObject({
          identity: true,
          help_text: 'Only staff see this.',
          jobs_allowed: ['no_one_alone'],
          must_labels: {},
          answer_counts: [
            { label: 'Oak', count: 3 },
            { label: 'Pine', count: 2 },
            { label: 'Birch', count: 1 },
          ],
        });

        const [alpha, beta, gamma] = setup.options;
        expect(alpha).toMatchObject({
          label: 'Alpha',
          wanted: { first: 2, top3: 4 },
          runs: 'auto',
          size: null,
          pitchers: [{ user_id: studentIds[0], name: 'Team Test s0', on_roster: true }],
        });
        expect(beta).toMatchObject({ size: { min: null, max: 4 }, note: 'Needs a laptop' });
        expect(gamma!.pinned_here).toEqual([
          { pin_id: 'p1', user_id: studentIds[1], name: 'Team Test s1' },
        ]);
        expect(setup.pins).toEqual([
          {
            id: 'p1',
            kind: 'on_option',
            people: [{ user_id: studentIds[1], name: 'Team Test s1' }],
            option: { id: options2[2], label: 'Gamma' },
            reason: 'Has a badge',
            added_by: { user_id: ownerId, name: 'Team Test owner' },
            added_via: 'page',
            added_at: expect.any(String),
          },
        ]);
        expect(setup.roster).toHaveLength(STUDENTS);
        expect(setup.checks.some(check => check.level === 'ok')).toBe(true);
        expect(setup.checks.some(check => check.level === 'error')).toBe(false);
        expect(setup.changes).toEqual({ since_run: null, items: [] });
        // Class counts, never who: no answer text and no identity answer by person.
        expect(JSON.stringify(setup)).not.toContain('Private note');

        // checkPatch lists passed checks only on request.
        const plain = await teamSetService.checkPatch({
          classroomId,
          formId: form2Id,
          setRef: setB,
        });
        expect(plain.issues.some(issue => issue.level === 'ok')).toBe(false);
        const withPassed = await teamSetService.checkPatch({
          classroomId,
          formId: form2Id,
          setRef: setB,
          includePassed: true,
        });
        expect(withPassed.issues.some(issue => issue.level === 'ok')).toBe(true);
      });

      it('stamps who closed an option and from where; Setup and the poll read them back', async () => {
        const closed = await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          setRef: setB,
          userId: teacherId,
          via: 'mcp',
          patch: { options: { [options2[0]!]: { open: 'closed' } } },
        });
        expect(closed.config.options[options2[0]!]).toMatchObject({
          open: 'closed',
          closed_by: teacherId,
          closed_via: 'mcp',
          closed_at: expect.any(String),
        });
        // Another save leaves the owner's pin stamp alone.
        expect(closed.config.pins[0]).toMatchObject({ added_by: ownerId, added_via: 'page' });
        // A patch cannot write a stamp.
        expect(
          await codeOf(
            teamSetService.saveConfig({
              classroomId,
              formId: form2Id,
              setRef: setB,
              userId: ownerId,
              patch: { options: { [options2[0]!]: { closed_by: ownerId } } } as never,
            })
          )
        ).toBe('invalid_config');

        const before = await teamSetService.pollStatus({ classroomId, teamSetId: setB });
        expect(before).toMatchObject({ latest_run: null, create: null });
        const run = await engineRun(setB);
        expect(run.status).toBe('SOLVED');
        const after = await teamSetService.pollStatus({ classroomId, teamSetId: setB });
        expect(after.latest_run).toEqual({ number: run.number, status: 'SOLVED' });
        expect(after.signature).not.toBe(before.signature);

        const setup = await teamSetService.getSetup({ classroomId, formId: form2Id, setRef: setB });
        expect(setup.options[0]!.closed).toEqual({
          since_run: run.number,
          by: { user_id: teacherId, name: 'Team Test teacher' },
          via: 'mcp',
        });
        expect(setup.changes).toEqual({ since_run: run.number, items: [] });

        // Reopening drops the stamps.
        const reopened = await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          setRef: setB,
          userId: ownerId,
          patch: { options: { [options2[0]!]: { open: null } } },
        });
        expect(reopened.config.options[options2[0]!]?.closed_by).toBeUndefined();
        expect(
          (await teamSetService.changesSinceRun({ classroomId, teamSetId: setB })).changes.map(
            change => change.text
          )
        ).toEqual(["'Alpha': Closed → Solver decides"]);
      });

      it('lists the changes since a run, and Discard puts the run’s setup back', async () => {
        const run = await engineRun(setB, 12);
        await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          setRef: setB,
          userId: ownerId,
          patch: {
            team_size: { min: 2, max: 4 },
            pins: { add: [{ kind: 'apart', user_ids: [studentIds[0]!, studentIds[2]!] }] },
          },
        });
        const since = await teamSetService.changesSinceRun({ classroomId, teamSetId: setB });
        expect(since.run_number).toBe(run.number);
        expect(since.changes.map(change => change.text)).toEqual([
          'Team size: 2–3 → 2–4',
          'Pin added: apart — Team Test s0, Team Test s2',
        ]);
        const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
        expect(view.changes_since_run.map(change => change.text)).toEqual(
          since.changes.map(change => change.text)
        );
        // Without people, the pin counts instead of naming.
        const bare = await teamSetService.describeRun({ classroomId, run, includePeople: false });
        expect(bare.changes_since_run[1]!.text).toBe('Pin added: apart — two students');

        const reverted = await teamSetService.revertToRun({
          classroomId,
          teamSetId: setB,
          runRef: run.number,
          userId: teacherId,
        });
        expect(reverted.config.team_size).toMatchObject({ min: 2, max: 3 });
        expect(reverted.config.pins).toEqual(run.config.pins);
        // The snapshot's resolved setting comes back explicit.
        expect(reverted.config.non_respondents).toBe('include');
        expect(await teamSetService.changesSinceRun({ classroomId, teamSetId: setB })).toEqual({
          run_number: run.number,
          changes: [],
        });
      });

      it('describes a solved run: signals, ranks, option status and the identity aggregate', async () => {
        const run = await engineRun(setB, 13);
        const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
        expect(view).toMatchObject({
          status: 'SOLVED',
          created_by: { user_id: ownerId, name: 'Team Test owner' },
          solver: { status: 'OPTIMAL', gap_pct: 0 },
          core: [],
          summary: null,
          changes_from_previous: null,
          non_respondents: { mode: 'include', people: 2 },
        });
        expect(view.progress).toEqual({
          responses: 6,
          people: STUDENTS,
          pins: 1,
          warnings: run.diagnostics?.issues?.filter(i => i.level === 'warning').length ?? 0,
        });
        expect(view.option_status.map(row => row.label)).toEqual(['Alpha', 'Beta', 'Gamma']);
        const s1 = view.teams.flatMap(team => team.members).find(m => m.user_id === studentIds[1])!;
        expect(s1).toMatchObject({ pinned: true, responded: true });
        const gammaTeam = view.teams.find(team =>
          team.members.some(m => m.user_id === studentIds[1])
        )!;
        expect(gammaTeam.option).toEqual({ id: options2[2], label: 'Gamma' });
        expect(gammaTeam.signals.pinned).toBeGreaterThanOrEqual(1);
        const s6 = view.teams.flatMap(team => team.members).find(m => m.user_id === studentIds[6])!;
        expect(s6).toMatchObject({ responded: false, rank: null });

        // The identity rule: on how many teams it held, never which (unless
        // revealed), never whose. Birch has a single student — a group of one
        // the rule can't help (the single-answer warning counts it) — so only
        // Pine can be left alone: keep its two students apart and it is, twice.
        const pine = (userId: string) => IDENTITY[studentIds.indexOf(userId)] === 'Pine';
        const held = view.teams.filter(
          team => run.result!.teams[team.n - 1]!.member_user_ids.filter(pine).length !== 1
        ).length;
        expect(view.identity_rules).toEqual([
          {
            rule_id: `${who2}:no_one_alone`,
            label: QUESTION,
            teams_held: held,
            teams_total: view.teams.length,
          },
        ]);

        const apart = await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          setRef: setB,
          userId: ownerId,
          patch: { pins: { add: [{ kind: 'apart', user_ids: [studentIds[1]!, studentIds[5]!] }] } },
        });
        const split = await engineRun(setB, 17);
        const splitView = await teamSetService.describeRun({
          classroomId,
          run: split,
          includePeople: true,
        });
        const missed = splitView.teams
          .filter(
            team => split.result!.teams[team.n - 1]!.member_user_ids.filter(pine).length === 1
          )
          .map(team => ({ n: team.n, name: team.name }));
        expect(missed).toHaveLength(2);
        expect(splitView.identity_rules[0]).toEqual({
          rule_id: `${who2}:no_one_alone`,
          label: QUESTION,
          teams_held: splitView.teams.length - 2,
          teams_total: splitView.teams.length,
        });
        expect(
          await teamSetService.identityMissedTeams({
            classroomId,
            teamSetId: setB,
            runRef: split.number,
          })
        ).toEqual(missed);
        const revealed = await teamSetService.describeRun({
          classroomId,
          run: split,
          includePeople: true,
          revealIdentity: true,
        });
        expect(revealed.identity_rules[0]!.missed_teams).toEqual(missed);
        await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          setRef: setB,
          userId: ownerId,
          patch: { pins: { remove: [apart.config.pins.at(-1)!.id] } },
        });
        // The single-answer warning is a count, with nobody named.
        const single = view.issues.find(issue => issue.code === 'identity_single_answer');
        expect(single?.user_ids).toBeUndefined();
        expect(single?.names).toBeUndefined();
      });

      it('never puts an identity answer next to a person — even for a question flagged after the run', async () => {
        const run = await teamSetService.getRun({
          classroomId,
          teamSetId: setB,
          runRef: (await teamSetService.listRuns({ classroomId, teamSetId: setB, limit: 1 }))[0]!
            .number,
        });
        const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
        const facts = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: setB,
          runRef: run.number,
        });
        expect(facts).toHaveLength(STUDENTS);
        for (const payload of [view, facts]) {
          const text = JSON.stringify(payload);
          for (const answer of ['"Oak"', '"Pine"', '"Birch"', 'Oak', 'Pine', 'Birch']) {
            expect(text).not.toContain(answer);
          }
        }
        // The note question is not an identity question: its answers show.
        const s0 = facts.find(fact => fact.user_id === studentIds[0])!;
        expect(s0.notes).toEqual([
          { field_label: 'Anything the staff should know?', text: 'Private note 0' },
        ]);
        expect(JSON.stringify(view)).toContain('Private note 0');

        // Flag the note question in the draft: its answers are masked at once,
        // though the run (and the published revision) predate the flag.
        const form = await prisma.form.findUniqueOrThrow({
          where: { id: form2Id },
          select: { draft_fields: true },
        });
        const draft = form.draft_fields as { fields: { id: string }[] } & Record<string, unknown>;
        await prisma.form.update({
          where: { id: form2Id },
          data: {
            draft_fields: {
              ...draft,
              fields: draft.fields.map(field =>
                field.id === note2 ? { ...field, identity_question: true } : field
              ),
            } as object,
          },
        });
        try {
          const masked = await teamSetService.describeRun({
            classroomId,
            run,
            includePeople: true,
          });
          const maskedFacts = await teamSetService.explainPlacements({
            classroomId,
            teamSetId: setB,
            runRef: run.number,
          });
          expect(JSON.stringify(masked)).not.toContain('Private note');
          expect(JSON.stringify(maskedFacts)).not.toContain('Private note');
          expect(maskedFacts.every(fact => fact.notes.length === 0)).toBe(true);
        } finally {
          await prisma.form.update({
            where: { id: form2Id },
            data: { draft_fields: draft as object },
          });
        }
      });

      it('explains a placement with facts only: team, rank, pins, requests, higher picks', async () => {
        const run = await engineRun(setB, 14);
        const [s1] = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: setB,
          runRef: run.number,
          userIds: [studentIds[1]!],
        });
        expect(s1).toMatchObject({
          user_id: studentIds[1],
          name: 'Team Test s1',
          responded: true,
          team: { option: { id: options2[2], label: 'Gamma' } },
          pins: [{ id: 'p1', reason: 'Has a badge', option: { label: 'Gamma' } }],
          requests: [{ user: { user_id: studentIds[2], name: 'Team Test s2' } }],
        });
        // s1 ranked Beta then Gamma: pinned to Gamma, their 2nd pick.
        expect(s1!.rank).toBe(2);
        expect(s1!.higher_picks).toEqual([
          { rank: 1, option: { id: options2[1], label: 'Beta' }, status: expect.any(Object) },
        ]);
        // s0 pitched Alpha.
        const [s0] = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: setB,
          runRef: run.number,
          userIds: [studentIds[0]!],
        });
        expect(s0!.pitched.map(p => p.option.label)).toEqual(['Alpha']);
      });

      it('compares two runs: the setup change, metric rows, and who moved with the pin that moved them', async () => {
        const first = await engineRun(setB, 15);
        const s0Before = first.result!.teams.find(t => t.member_user_ids.includes(studentIds[0]!))!;
        expect(s0Before.option_id).not.toBe(options2[2]);
        await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          setRef: setB,
          userId: ownerId,
          patch: {
            pins: {
              add: [
                {
                  kind: 'on_option',
                  user_id: studentIds[0]!,
                  option_id: options2[2]!,
                  reason: 'Moved on request',
                },
              ],
            },
          },
        });
        const second = await engineRun(setB, 16);
        const cmp = await teamSetService.compareRuns({
          classroomId,
          teamSetId: setB,
          runRef: second.number,
          otherRunRef: first.number,
          includePeople: true,
        });
        expect(cmp).toMatchObject({
          run_number: second.number,
          other_run_number: first.number,
          grouped: true,
          rule_labels: { [`${who2}:no_one_alone`]: QUESTION },
        });
        expect(cmp.changes.map(change => change.text)).toEqual([
          "Pin added: Team Test s0 → 'Gamma'",
        ]);
        expect(cmp.metrics.map(row => row.key)).toEqual(
          expect.arrayContaining([
            'first_choice',
            'top3',
            'requests_kept',
            'options_open',
            'rule_held',
          ])
        );
        const moved = cmp.moved.find(mover => mover.user.user_id === studentIds[0])!;
        expect(moved).toMatchObject({
          user: { name: 'Team Test s0' },
          to: { option: { label: 'Gamma' } },
          pin: { kind: 'on_option', reason: 'Moved on request' },
        });
        expect(cmp.unchanged + cmp.moved.length).toBe(STUDENTS);
        // Without people: nobody named.
        const bare = await teamSetService.compareRuns({
          classroomId,
          teamSetId: setB,
          runRef: second.number,
          otherRunRef: first.number,
          includePeople: false,
        });
        expect(JSON.stringify(bare)).not.toContain('Team Test');
      });

      it('names the students of a per-student Must src only on read, and stores the core without names', async () => {
        const { run } = await teamSetService.startRun({
          classroomId,
          teamSetId: setB,
          userId: ownerId,
        });
        const person = run!.problem.people[0]!;
        const done = await teamSetService.completeRun(run!.id, {
          status: 'INFEASIBLE',
          teams: [],
          objective: null,
          bound: null,
          wall_s: 1,
          core: [`${rank2}:rank@0`, 'pin:p1'],
          core_status: 'complete',
        });
        expect(done.diagnostics?.core).toEqual([
          { src: `${rank2}:rank@0`, label: 'Rank the projects (rank, prefer)' },
          { src: 'pin:p1', label: 'Pin: one student → \'Gamma\' · "Has a badge"' },
        ]);
        expect(JSON.stringify(done.diagnostics)).not.toContain('Team Test');

        const view = await teamSetService.describeRun({
          classroomId,
          run: done,
          includePeople: true,
        });
        expect(view.core[0]).toMatchObject({
          kind: 'rule',
          user_ids: [person],
          people: [{ user_id: person, name: expect.stringMatching(/^Team Test s/) }],
          link: { tab: 'questions', field_id: rank2 },
        });
        expect(view.core[1]).toMatchObject({
          kind: 'pin',
          label: 'Pin: Team Test s1 → \'Gamma\' · "Has a badge"',
          link: { tab: 'pins', pin_id: 'p1' },
        });
        expect(view.summary).toBe(
          "The settings listed can't all be met together within the team-size, teams-per-option and team-count limits."
        );
        expect(view.changes_from_previous).toEqual({ since_run: done.number - 1, items: [] });
        const bare = await teamSetService.describeRun({
          classroomId,
          run: done,
          includePeople: false,
        });
        expect(bare.core[0]!.people).toEqual([{ user_id: person, name: null }]);
      });

      it('solves a group run end to end through the engine, checking each stage', async () => {
        const group = await teamSetService.saveConfig({
          classroomId,
          formId: form2Id,
          userId: ownerId,
          name: `group ${suite}`,
          patch: {
            team_size: { min: 2, max: 3 },
            non_respondents: 'group',
            grouping: { mode: 'by_option', field_id: rank2, teams_per_option: 2 },
            time_limit_s: 10,
          },
        });
        const { run } = await teamSetService.startRun({
          classroomId,
          teamSetId: group.id,
          userId: ownerId,
          seed: 3,
        });
        expect(run!.config.non_respondents).toBe('group');
        expect(run!.problem.group?.members).toHaveLength(2);
        const output = solveWithEngine(run!.problem);
        expect(output.stages).toBeTruthy();
        const done = await teamSetService.completeRun(run!.id, output);
        expect(done.status).toBe('SOLVED');
        expect(done.solver?.stages).toEqual(output.stages);
        expect(done.metrics?.non_respondents).toMatchObject({
          mode: 'group',
          people: 2,
          grouped: 2,
          teams: 1,
        });
        // The two who didn't answer share a team, with nobody else.
        const theirs = done.result!.teams.find(team =>
          team.member_user_ids.includes(studentIds[6]!)
        )!;
        expect([...theirs.member_user_ids].sort()).toEqual([studentIds[6], studentIds[7]].sort());

        const view = await teamSetService.describeRun({
          classroomId,
          run: done,
          includePeople: true,
        });
        expect(view.non_respondents).toEqual({ mode: 'group', people: 2 });
        const [s6] = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: group.id,
          runRef: done.number,
          userIds: [studentIds[6]!],
        });
        expect(s6).toMatchObject({
          responded: false,
          non_respondents_mode: 'group',
          grouped: true,
        });

        // The scorer's parts must equal the engine's stages: off by one in stage
        // 1, or no stages at all on a group problem, is a score_mismatch.
        const offByOne: SolverOutput = {
          ...output,
          stages: {
            ...output.stages!,
            first: { ...output.stages!.first, objective: output.stages!.first.objective! + 1 },
          },
        };
        const { stages: _dropped, ...withoutStages } = output;
        for (const bad of [offByOne, withoutStages]) {
          const { run: again } = await teamSetService.startRun({
            classroomId,
            teamSetId: group.id,
            userId: ownerId,
            seed: 3,
          });
          expect(await teamSetService.completeRun(again!.id, bad)).toMatchObject({
            status: 'FAILED',
            error: 'score_mismatch',
          });
        }
      });

      it('starts a new set from a setup: a copy that is the copier’s, named after the source', async () => {
        const source = await teamSetService.getSet({ classroomId, formId: form2Id, setRef: setB });
        const copy = await teamSetService.newSetFromSetup({
          classroomId,
          formId: form2Id,
          fromSetRef: setB,
          userId: teacherId,
        });
        expect(copy).toMatchObject({ name: `${setBName}-2`, status: 'setting_up', locked: false });
        expect(copy.config.rules).toEqual(source!.config.rules);
        expect(copy.config.options).toEqual(source!.config.options);
        expect(copy.config.pins.map(pin => [pin.id, pin.added_by, pin.added_via])).toEqual(
          source!.config.pins.map(pin => [pin.id, teacherId, 'page'])
        );
        const next = await teamSetService.newSetFromSetup({
          classroomId,
          formId: form2Id,
          fromSetRef: setB,
          userId: teacherId,
        });
        expect(next.name).toBe(`${setBName}-3`);
        expect(
          await codeOf(
            teamSetService.newSetFromSetup({
              classroomId,
              formId: form2Id,
              fromSetRef: setB,
              name: setBName,
              userId: teacherId,
            })
          )
        ).toBe('name_taken');
        // From a set whose teams were created (locked): the copy is a fresh set.
        const fromCreated = await teamSetService.newSetFromSetup({
          classroomId,
          formId,
          fromSetRef: setId,
          name: `again ${suite}`,
          userId: ownerId,
        });
        expect(fromCreated).toMatchObject({ status: 'setting_up', locked: false });
        expect(fromCreated.config.team_size).toMatchObject({ min: 2, max: 3 });
      });

      it('lists sets with their status and latest run', async () => {
        const rows = await teamSetService.listForForm({ classroomId, formId: form2Id });
        const b = rows.find(row => row.id === setB)!;
        expect(b).toMatchObject({
          name: setBName,
          status: 'setting_up',
          created: null,
          latest_run: { status: expect.any(String) },
        });
        expect(typeof b.updated_at).toBe('string');
      });
    }
  );

  // ── Saves under the row lock, member-only names, identity masks on read ──
  //
  // A form of its own (no engine needed): a ranked question and two
  // dropdowns (a color and a size), answered by s0…s5 — Red for s0–s2, Blue
  // for s3–s5. A staff member of the classroom and a user who is not a
  // member of it.

  describe('saves, names and masks on a third form', () => {
    let formC: string;
    let revC: string;
    let storedFieldsC: unknown;
    let rankC: string;
    let colorC: string;
    let sizeC: string;
    let projectsC: string[];
    let largeId: string;
    let staffId: string;
    let outsiderId: string;

    /** The suggestion's rules, all of them, as a patch that drops them. */
    const dropSuggested = async () => {
      const { config } = await teamSetService.suggestForForm({ classroomId, formId: formC });
      return config.rules.map(rule => ({ field_id: rule.field_id, job: rule.job }));
    };

    /** A set on the third form, grouped by the projects (two teams each), no rules. */
    const setOnC = async (label: string, patch: Record<string, unknown> = {}) =>
      teamSetService.saveConfig({
        classroomId,
        formId: formC,
        userId: ownerId,
        name: `${label} ${suite}`,
        patch: {
          grouping: { mode: 'by_option', field_id: rankC, teams_per_option: 2 },
          team_size: { min: 2, max: 3 },
          rules: { remove: await dropSuggested() },
          ...patch,
        },
      });

    /** The stored definition with one question flagged as an identity question. */
    const withFlag = (stored: unknown, fieldId: string) => {
      const clone = JSON.parse(JSON.stringify(stored)) as
        | Record<string, unknown>[]
        | { fields: Record<string, unknown>[] };
      const list = Array.isArray(clone) ? clone : clone.fields;
      for (const field of list) if (field.id === fieldId) field.identity_question = true;
      return clone;
    };

    /** The TeamSetError a rejected promise carries. */
    const errorOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        return error as { code?: string; details?: unknown };
      }
      throw new Error('expected a refusal');
    };

    beforeAll(async () => {
      staffId = await makeUser('staff');
      await enroll(staffId, 'TEACHER');
      outsiderId = await makeUser('outsider');
      const form = await formService.create({
        classroomId,
        title: `Third form ${suite}`,
        access: 'CLASSROOM',
        createdBy: ownerId,
        fields: [
          {
            type: 'ranked_choice',
            label: 'Rank the projects',
            options: ['Alpha', 'Beta'],
            ranks: 2,
          },
          { type: 'dropdown', label: 'Pick a color', options: ['Red', 'Blue'] },
          { type: 'dropdown', label: 'Pick a size', options: ['Small', 'Large'] },
        ],
      });
      await formService.update(form.id, { allow_multiple: true });
      const { revision } = await formService.publish(form.id);
      formC = form.id;
      revC = revision.id;
      storedFieldsC = revision.fields;
      const fields = formService.fieldsOf(revision.fields);
      rankC = fields[0]!.id;
      colorC = fields[1]!.id;
      sizeC = fields[2]!.id;
      projectsC = (fields[0]!.options as { id: string }[]).map(o => o.id);
      const colors = (fields[1]!.options as { id: string }[]).map(o => o.id);
      const sizes = (fields[2]!.options as { id: string }[]).map(o => o.id);
      largeId = sizes[1]!;
      for (let i = 0; i < 6; i++) {
        const userId = studentIds[i]!;
        await responseService.submitClassroom({
          formId: formC,
          userId,
          email: `${logins.get(userId)}@example.test`,
          name: `Team Test ${userId.slice(0, 4)}`,
          revisionId: revC,
          answers: {
            [rankC]: [projectsC[i % 2], projectsC[(i + 1) % 2]],
            [colorC]: colors[i < 3 ? 0 : 1],
            [sizeC]: sizes[i % 2],
          },
        });
      }
    });

    it('applies overlapping saves one after the other, so none of them is lost', async () => {
      const set = await setOnC('overlap');
      const save = (userId: string, patch: Record<string, unknown>) =>
        teamSetService.saveConfig({ classroomId, formId: formC, setRef: set.id, userId, patch });
      await Promise.all([
        save(ownerId, {
          pins: { add: [{ kind: 'apart', user_ids: [studentIds[0]!, studentIds[1]!] }] },
        }),
        save(staffId, {
          pins: { add: [{ kind: 'apart', user_ids: [studentIds[2]!, studentIds[3]!] }] },
        }),
        save(staffId, { options: { [projectsC[0]!]: { open: 'closed' } } }),
        save(ownerId, { fairness: 70 }),
      ]);
      const stored = (await teamSetService.getSet({ classroomId, formId: formC, setRef: set.id }))!;
      // Both pins, with distinct ids: each save read the other's result under the lock.
      expect(stored.config.pins.map(pin => pin.id).sort()).toEqual(['p1', 'p2']);
      expect(
        stored.config.pins.map(pin => (pin.kind === 'apart' ? [...pin.user_ids].sort() : [])).sort()
      ).toEqual(
        [[studentIds[0]!, studentIds[1]!].sort(), [studentIds[2]!, studentIds[3]!].sort()].sort()
      );
      expect(stored.config.options[projectsC[0]!]).toMatchObject({
        open: 'closed',
        closed_by: staffId,
      });
      expect(stored.config.fairness).toBe(70);
    });

    it('refuses a new pin naming someone outside the classroom, with a count and no names', async () => {
      const set = await setOnC('outsider pins');
      const before = (await teamSetService.getSet({ classroomId, formId: formC, setRef: set.id }))!;
      const one = await errorOf(
        teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch: { pins: { add: [{ kind: 'together', user_ids: [studentIds[0]!, outsiderId] }] } },
        })
      );
      expect(one.code).toBe('invalid_config');
      expect(one.details).toEqual({
        problems: ['A person named in a new pin isn’t in this classroom.'],
        paths: ['pins'],
      });
      const two = await errorOf(
        teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch: {
            pins: {
              add: [
                { kind: 'on_option', user_id: outsiderId, option_id: projectsC[0]! },
                { kind: 'on_option', user_id: randomUUID(), option_id: projectsC[1]! },
              ],
            },
          },
        })
      );
      expect((two.details as { problems: string[] }).problems).toEqual([
        '2 people named in new pins aren’t in this classroom.',
      ]);
      // Nothing was written; a check says the same without saving.
      const after = (await teamSetService.getSet({ classroomId, formId: formC, setRef: set.id }))!;
      expect(after.config).toEqual(before.config);
      const checked = await teamSetService.checkPatch({
        classroomId,
        formId: formC,
        setRef: set.id,
        patch: {
          pins: { add: [{ kind: 'on_option', user_id: outsiderId, option_id: projectsC[0]! }] },
        },
      });
      expect(checked.issues).toContainEqual(
        expect.objectContaining({
          level: 'error',
          code: 'invalid_config',
          message: 'A person named in a new pin isn’t in this classroom.',
        })
      );
      // A new set refuses it too.
      expect(
        await codeOf(
          setOnC('outsider new', {
            pins: { add: [{ kind: 'on_option', user_id: outsiderId, option_id: projectsC[0]! }] },
          })
        )
      ).toBe('invalid_config');
    });

    it('names only members of the classroom, and who added each pin', async () => {
      const set = await setOnC('names', {
        pins: { add: [{ kind: 'on_option', user_id: studentIds[0]!, option_id: projectsC[0]! }] },
      });
      // A pin saved before pins were checked, naming a user outside the classroom.
      const stored = (await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } }))
        .config as unknown as TeamSetConfig;
      await prisma.teamSet.update({
        where: { id: set.id },
        data: {
          config: {
            ...stored,
            pins: [
              ...stored.pins,
              {
                id: 'p9',
                kind: 'on_option',
                user_id: outsiderId,
                option_id: projectsC[1]!,
                added_by: staffId,
                added_via: 'page',
                added_at: new Date().toISOString(),
              },
            ],
          } as unknown as Prisma.InputJsonValue,
        },
      });
      const setup = await teamSetService.getSetup({ classroomId, formId: formC, setRef: set.id });
      const outside = setup.pins.find(pin => pin.id === 'p9')!;
      expect(outside.people).toEqual([{ user_id: outsiderId, name: null }]);
      expect(outside.added_by).toEqual({ user_id: staffId, name: 'Team Test staff' });
      expect(setup.pins.find(pin => pin.id === 'p1')!.added_by).toEqual({
        user_id: ownerId,
        name: 'Team Test owner',
      });
      expect(JSON.stringify(setup)).not.toContain('Team Test outsider');
    });

    it('names who added a pin in the run view, the changes since a run and a comparison', async () => {
      const set = await setOnC('added by');
      const first = await solvedRun(set.id);
      await teamSetService.saveConfig({
        classroomId,
        formId: formC,
        setRef: set.id,
        userId: staffId,
        via: 'mcp',
        patch: { pins: { add: [{ kind: 'apart', user_ids: [studentIds[0]!, studentIds[1]!] }] } },
      });
      const staff = { user_id: staffId, name: 'Team Test staff' };

      const since = await teamSetService.changesSinceRun({
        classroomId,
        teamSetId: set.id,
        runRef: first.number,
      });
      const pinChange = since.changes.find(change => change.kind === 'pin');
      expect(pinChange).toMatchObject({
        change: 'added',
        pin: { added_by: staff, added_via: 'mcp' },
      });

      const view = await teamSetService.describeRun({
        classroomId,
        run: first,
        includePeople: true,
      });
      expect(view.changes_since_run.find(change => change.kind === 'pin')).toMatchObject({
        pin: { added_by: staff },
      });

      const second = await solvedRun(set.id);
      const compared = await teamSetService.compareRuns({
        classroomId,
        teamSetId: set.id,
        runRef: second.number,
        otherRunRef: first.number,
        includePeople: true,
      });
      expect(compared.changes.find(change => change.kind === 'pin')).toMatchObject({
        pin: { added_by: staff },
      });
      // Without people, nobody is named.
      const bare = await teamSetService.compareRuns({
        classroomId,
        teamSetId: set.id,
        runRef: second.number,
        otherRunRef: first.number,
        includePeople: false,
      });
      expect(JSON.stringify(bare)).not.toContain('Team Test');
    });

    it('compares only solved runs', async () => {
      const set = await setOnC('compare solved');
      const solved = await solvedRun(set.id);
      delete process.env.TRIGGER_SECRET_KEY;
      const failed = await teamSetService.startRun({
        classroomId,
        teamSetId: set.id,
        userId: ownerId,
      });
      process.env.TRIGGER_SECRET_KEY = 'tr_test_team_sets';
      expect(failed.run).toMatchObject({ status: 'FAILED', error: 'trigger_unavailable' });
      const refused = await errorOf(
        teamSetService.compareRuns({
          classroomId,
          teamSetId: set.id,
          runRef: solved.number,
          otherRunRef: failed.run!.number,
          includePeople: true,
        })
      );
      expect(refused).toMatchObject({
        code: 'run_not_solved',
        details: { run_number: failed.run!.number, status: 'FAILED' },
      });
    });

    it('restores a run’s setup saved under an earlier schema, saying what it left out', async () => {
      const set = await setOnC('legacy', {
        pins: { add: [{ kind: 'apart', user_ids: [studentIds[0]!, studentIds[1]!] }] },
      });
      const run = await solvedRun(set.id);
      // What an earlier schema could have stored: a retired setting, and a pin
      // that no longer parses.
      const legacy = {
        ...run.config,
        team_size: { ...run.config.team_size, allow_one_larger: true },
        pins: [...run.config.pins, { id: 'p8', kind: 'together', user_ids: [studentIds[2]!] }],
      };
      const storeSnapshot = (config: unknown) =>
        prisma.teamSetRun.update({
          where: { id: run.id },
          data: { config: config as Prisma.InputJsonValue },
        });
      await storeSnapshot(legacy);
      await teamSetService.saveConfig({
        classroomId,
        formId: formC,
        setRef: set.id,
        userId: ownerId,
        patch: { fairness: 90 },
      });
      const discard = () =>
        teamSetService.revertToRun({
          classroomId,
          teamSetId: set.id,
          runRef: run.number,
          userId: ownerId,
        });
      const reverted = await discard();
      expect(reverted.config.fairness).toBe(run.config.fairness);
      expect(reverted.config.team_size).toEqual({ min: 2, max: 3 });
      expect(reverted.config.pins.map(pin => pin.id)).toEqual(['p1']);
      // What the restore left out is said, so the setup isn't called the run's as a whole.
      expect(reverted.notes).toEqual([`Left out of run ${run.number}’s setup: 1 pin.`]);

      // A key the schema doesn't know (a newer schema's) refuses the restore:
      // it is never saved back without it.
      await storeSnapshot({ ...run.config, newer_setting: 3 });
      expect(await codeOf(discard())).toBe('invalid_config');
      await storeSnapshot(run.config);
      expect((await discard()).notes).toEqual([]);
    });

    it('reads and saves a stored config without its retired setting, and refuses a key it doesn’t know', async () => {
      const set = await setOnC('stored keys');
      const stored = async () =>
        (await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } })).config as Record<
          string,
          unknown
        >;
      const store = (config: unknown) =>
        prisma.teamSet.update({
          where: { id: set.id },
          data: { config: config as Prisma.InputJsonValue },
        });
      const save = (patch: Record<string, unknown>) =>
        teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch,
        });

      const before = await stored();
      await store({ ...before, team_size: { min: 2, max: 3, allow_one_larger: true } });
      const read = await teamSetService.getSet({ classroomId, formId: formC, setRef: set.id });
      expect(read!.config.team_size).toEqual({ min: 2, max: 3 });
      // The next save writes it back without the retired setting, and a patch
      // that still sends it is saved without it too.
      await save({ fairness: 60 });
      expect((await stored()).team_size).toEqual({ min: 2, max: 3 });
      const sent = await save({ team_size: { min: 2, max: 3, allow_one_larger: true } });
      expect(sent.config.team_size).toEqual({ min: 2, max: 3 });
      expect((await stored()).team_size).toEqual({ min: 2, max: 3 });
      const checked = await teamSetService.checkPatch({
        classroomId,
        formId: formC,
        setRef: set.id,
        patch: { team_size: { min: 2, max: 3, allow_one_larger: true } },
      });
      expect(checked.config.team_size).toEqual({ min: 2, max: 3 });

      // A key no schema here knows: refused on read and on save, and the row
      // is left as it is (never saved back without it).
      const newer = { ...(await stored()), newer_setting: 1 };
      await store(newer);
      expect(
        await codeOf(teamSetService.getSet({ classroomId, formId: formC, setRef: set.id }))
      ).toBe('invalid_config');
      expect(await codeOf(save({ fairness: 40 }))).toBe('invalid_config');
      expect(await stored()).toEqual(newer);
      await store(before);
    });

    it('never gives a removed pin’s id to a new pin, across saves and Discard', async () => {
      const apart = (a: number, b: number) => ({
        pins: { add: [{ kind: 'apart', user_ids: [studentIds[a]!, studentIds[b]!] }] },
      });
      const set = await setOnC('pin ids', apart(0, 1));
      const run = await solvedRun(set.id);
      const save = (patch: Record<string, unknown>) =>
        teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch,
        });
      const ids = (config: TeamSetConfig) => config.pins.map(pin => pin.id);

      expect(ids((await save(apart(2, 3))).config)).toEqual(['p1', 'p2']);
      const removed = await save({ pins: { remove: ['p2'] } });
      expect(ids(removed.config)).toEqual(['p1']);
      expect(removed.config.last_pin_number).toBe(2);
      // A view still showing the old p2 can't remove the new pin by that id.
      expect(ids((await save(apart(4, 5))).config)).toEqual(['p1', 'p3']);

      // Discard to the run (p1 only): numbering keeps going.
      const reverted = await teamSetService.revertToRun({
        classroomId,
        teamSetId: set.id,
        runRef: run.number,
        userId: ownerId,
      });
      expect(ids(reverted.config)).toEqual(['p1']);
      expect(reverted.config.last_pin_number).toBe(3);
      expect(ids((await save(apart(2, 3))).config)).toEqual(['p1', 'p4']);
    });

    it('refuses a save that waited past its limit for the set as set_busy, writing nothing', async () => {
      const set = await setOnC('busy');
      const before = (await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } })).config;
      // What Prisma throws when an interactive transaction runs out of time.
      const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
        Object.assign(new Error('Transaction API error: Transaction already closed'), {
          code: 'P2028',
        })
      );
      try {
        const refused = await errorOf(
          teamSetService.saveConfig({
            classroomId,
            formId: formC,
            setRef: set.id,
            userId: ownerId,
            patch: { fairness: 12 },
          })
        );
        expect(refused.code).toBe('set_busy');
        expect(refused).toMatchObject({
          message: 'Another save or run held this set; this change was not saved.',
        });
      } finally {
        spy.mockRestore();
      }
      expect((await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } })).config).toEqual(
        before
      );
    });

    it('names sets in any script, refuses a name with no letter or digit, and matches names as stored', async () => {
      const source = await setOnC('script source');
      const copy = (name: string) =>
        teamSetService.newSetFromSetup({
          classroomId,
          formId: formC,
          fromSetRef: source.id,
          name,
          userId: ownerId,
        });
      for (const [typed, stored] of [
        [`日本 ${suite}`, `日本-${suite}`],
        [`ü ${suite}`, `ü-${suite}`],
        [`Équipe 3 ${suite}`, `équipe-3-${suite}`],
        [`группа ${suite}`, `группа-${suite}`],
        [`٣ ${suite}`, `٣-${suite}`],
      ] as const) {
        expect((await copy(typed)).name).toBe(stored);
      }
      for (const typed of ['!!!', '🙂🙂', '#%&']) {
        expect(await errorOf(copy(typed))).toMatchObject({
          code: 'invalid_config',
          details: {
            problems: ['A team set name needs at least one letter or digit.'],
            paths: ['name'],
          },
        });
        expect(
          await errorOf(
            teamSetService.saveConfig({ classroomId, formId: formC, userId: ownerId, name: typed })
          )
        ).toMatchObject({ code: 'invalid_config' });
      }
      // Two names that are one set name: the second is taken, and either finds the set.
      expect(await codeOf(copy(`ÉQUIPE   3 ${suite}`))).toBe('name_taken');
      const found = await teamSetService.getSet({
        classroomId,
        formId: formC,
        setRef: `ÉQUIPE 3 ${suite}`,
      });
      expect(found?.name).toBe(`équipe-3-${suite}`);
    });

    it('numbers pins past every run’s on a set saved without pin numbering', async () => {
      const apart = (a: number, b: number) => ({
        pins: { add: [{ kind: 'apart' as const, user_ids: [studentIds[a]!, studentIds[b]!] }] },
      });
      const set = await setOnC('unnumbered pins', apart(0, 1));
      await teamSetService.saveConfig({
        classroomId,
        formId: formC,
        setRef: set.id,
        userId: ownerId,
        patch: apart(2, 3),
      });
      const run = await solvedRun(set.id); // its setup has p1 and p2
      // Stored the way an earlier release left them: no counter anywhere, and
      // p2 since removed from the set.
      const { last_pin_number: _snapshotCounter, ...snapshot } = run.config;
      await prisma.teamSetRun.update({
        where: { id: run.id },
        data: { config: snapshot as unknown as Prisma.InputJsonValue },
      });
      const row = await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } });
      const config = row.config as Record<string, unknown> & { pins: { id: string }[] };
      const { last_pin_number: _dropped, ...rest } = config;
      await prisma.teamSet.update({
        where: { id: set.id },
        data: {
          config: {
            ...rest,
            pins: config.pins.filter(pin => pin.id !== 'p2'),
          } as Prisma.InputJsonValue,
        },
      });
      const saved = await teamSetService.saveConfig({
        classroomId,
        formId: formC,
        setRef: set.id,
        userId: ownerId,
        patch: apart(4, 5),
      });
      expect(saved.config.pins.map(pin => pin.id)).toEqual(['p1', 'p3']);
      expect(saved.config.last_pin_number).toBe(3);
    });

    it('refuses a run whose start ran out of time as set_busy, making no run', async () => {
      const set = await setOnC('busy run');
      const runs = () => prisma.teamSetRun.count({ where: { team_set_id: set.id } });
      const before = await runs();
      const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
        Object.assign(new Error('Transaction API error: Transaction already closed'), {
          code: 'P2028',
        })
      );
      try {
        const refused = await errorOf(
          teamSetService.startRun({ classroomId, teamSetId: set.id, userId: ownerId })
        );
        expect(refused).toMatchObject({
          code: 'set_busy',
          message: 'Another save or run held this set; no run was started.',
          details: { action: 'run' },
        });
      } finally {
        spy.mockRestore();
      }
      expect(await runs()).toBe(before);
    });

    it('marks a run grouped by a question flagged since as stale, and shows no option per team or person', async () => {
      const set = await setOnC('flagged grouping', {
        grouping: { mode: 'by_option', field_id: colorC, teams_per_option: 1 },
        non_respondents: 'exclude',
        team_name_template: '{set}-{option}',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: colorC, job: 'rank', strength: 'prefer' }],
        },
      });
      const run = await solvedRun(set.id);
      const before = await teamSetService.describeRun({ classroomId, run, includePeople: true });
      expect(before.stale).toBe(false);
      expect(before.teams.map(team => team.option?.label).sort()).toEqual(['Blue', 'Red']);
      expect(before.teams.every(team => /-(red|blue)$/.test(team.name))).toBe(true);
      // Everyone in the run answered (non_respondents exclude), and their
      // placement is read from their answer to the grouping question.
      const factsBefore = await teamSetService.explainPlacements({
        classroomId,
        teamSetId: set.id,
        runRef: run.number,
      });
      expect(factsBefore.length).toBeGreaterThan(0);
      for (const fact of factsBefore) {
        expect(fact.responded).toBe(true);
        expect(fact.placement).not.toBeNull();
        expect(fact.placement).not.toBe('no_answer');
      }

      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, colorC) as Prisma.InputJsonValue },
      });
      try {
        const reason = 'A question this run used is now an identity question.';
        const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
        expect(view.stale).toBe(true);
        expect(view.stale_reasons).toEqual([reason]);
        for (const team of view.teams) {
          expect(team.option).toBeNull();
          expect(team.name).not.toMatch(/red|blue/i);
          expect(team.signals.wanted_first).toBeNull();
          expect(team.members.length).toBeGreaterThan(0);
          for (const member of team.members) {
            expect(member.rank).toBeNull();
            expect(member.placement).toBeNull();
          }
        }

        const facts = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: set.id,
          runRef: run.number,
        });
        expect(facts.length).toBeGreaterThan(0);
        for (const fact of facts) {
          expect(fact.team.option).toBeNull();
          expect(fact.team.name).not.toMatch(/red|blue/i);
          expect(fact.rank).toBeNull();
          expect(fact.higher_picks).toEqual([]);
          // Not shown, rather than "no answer" for someone who answered.
          expect(fact.responded).toBe(true);
          expect(fact.placement).toBeNull();
        }
        expect(JSON.stringify(facts)).not.toMatch(/"(Red|Blue)"/);
        expect(JSON.stringify(facts)).not.toContain('no_answer');

        const listed = await teamSetService.listRuns({
          classroomId,
          teamSetId: set.id,
          withStaleness: true,
        });
        expect(listed.find(entry => entry.number === run.number)?.stale).toBe(true);
        // Not creatable: a first create refuses it as out of date.
        const refused = await errorOf(
          teamSetService.previewCreate({ classroomId, teamSetId: set.id, runRef: run.number })
        );
        expect(refused).toMatchObject({ code: 'run_stale', details: { reasons: [reason] } });
      } finally {
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
      }
      expect((await teamSetService.staleness({ classroomId, run })).stale).toBe(false);
    });

    /** A run of the set whose teams are `from`'s, each on the next team's slot. */
    const rotatedRun = async (teamSetId: string, from: TeamSetRunRow) => {
      const { run } = await teamSetService.startRun({
        classroomId,
        teamSetId,
        userId: ownerId,
        seed: 7,
      });
      const index = new Map(run!.problem.people.map((id, p) => [id, p]));
      const stored = from.result!.teams;
      const teams = stored.map((team, i) => ({
        slot: stored[(i + 1) % stored.length]!.slot,
        members: team.member_user_ids.map(id => index.get(id)!).sort((a, b) => a - b),
      }));
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

    it('lists a flagged grouping’s teams by their members, with nothing per option, and names the teams a retry still makes without it, in the failed create too', async () => {
      const set = await setOnC('masked order', {
        grouping: { mode: 'by_option', field_id: colorC, teams_per_option: 1 },
        non_respondents: 'exclude',
        team_name_template: '{set}-{option}',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: colorC, job: 'rank', strength: 'prefer' }],
        },
      });
      const first = await solvedRun(set.id);
      // The same two teams, each on the other color.
      const second = await rotatedRun(set.id, first);
      const compare = () =>
        teamSetService.compareRuns({
          classroomId,
          teamSetId: set.id,
          runRef: second.number,
          otherRunRef: first.number,
          includePeople: true,
        });
      const byOption = await compare();
      expect(byOption.grouped).toBe(true);
      expect(byOption.moved).toHaveLength(6);
      const before = await teamSetService.describeRun({
        classroomId,
        run: first,
        includePeople: true,
      });
      expect(before.option_status.length).toBeGreaterThan(0);
      const colorNames = before.teams.map(team => team.name);
      expect(colorNames.every(name => /-(red|blue)$/.test(name))).toBe(true);

      // A create of the first run failed after making its first team; the
      // second failed on its planned name, which an earlier attempt renamed.
      const madeName = colorNames[0]!;
      const plannedName = colorNames[1]!;
      const now = new Date().toISOString();
      const failed: CreateState = {
        status: 'FAILED',
        run_id: first.id,
        run_number: first.number,
        total: 2,
        done: 1,
        failed: [{ team: plannedName, reason: 'name_collision' }],
        teams: [{ team_id: randomUUID(), name: madeName, n: 1, members_added: 3 }],
        names: colorNames,
        sizes: [3, 3],
        renamed: [{ n: 2, from: `${plannedName}-earlier`, to: plannedName }],
        attempt: 1,
        attempt_id: randomUUID(),
        claimed_by: ownerId,
        started_at: now,
        task_started_at: now,
        heartbeat_at: now,
        finished_at: now,
      } as CreateState;
      await prisma.teamSet.update({
        where: { id: set.id },
        data: {
          created_run_id: first.id,
          create_state: failed as unknown as Prisma.InputJsonValue,
        },
      });

      // Before the flag, the failed create reads as stored.
      const progressOf = async () =>
        (await teamSetService.getCreateProgress({ classroomId, teamSetId: set.id }))!;
      const unflagged = await progressOf();
      expect(unflagged.teams.map(team => team.name)).toEqual(colorNames);
      expect(unflagged.failures.map(failure => failure.team)).toEqual([plannedName]);
      expect(unflagged.renamed).toEqual(failed.renamed);

      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, colorC) as Prisma.InputJsonValue },
      });
      try {
        const view = await teamSetService.describeRun({
          classroomId,
          run: first,
          includePeople: true,
        });
        expect(view.option_status).toEqual([]);
        // Listed and numbered by their members, not by option.
        const smallest = view.teams.map(team => team.members.map(m => m.user_id).sort()[0]!);
        expect([...smallest].sort()).toEqual(smallest);
        expect(view.teams.map(team => team.n)).toEqual([1, 2]);
        for (const team of view.teams) {
          expect(team.signals.pitcher_on_team).toBeNull();
          expect(team.signals.seats).toEqual({ used: 3, max: 3 });
        }
        // The team that exists keeps its name; the other is named without its option.
        const made = new Set(first.result!.teams[0]!.member_user_ids);
        const [madeTeam, other] = [
          view.teams.find(team => team.members.every(m => made.has(m.user_id)))!,
          view.teams.find(team => !team.members.some(m => made.has(m.user_id)))!,
        ];
        expect(madeTeam.name).toBe(madeName);
        expect(other.name).toBe(set.name);

        // Until a retry is claimed, the failed create's reads name the team it
        // didn't make as that retry will (and as the run view does), in its
        // failures too, and list no earlier rename of it; the made team keeps
        // its name. Stored, the state is unchanged.
        const shownNames = [madeName, set.name];
        const progress = await progressOf();
        expect(progress.teams.map(team => team.name)).toEqual(shownNames);
        expect(progress.teams.map(team => team.state)).toEqual(['done', 'failed']);
        expect(progress.failures.map(failure => failure.team)).toEqual([set.name]);
        expect(progress.renamed).toEqual([]);
        const polled = (await teamSetService.pollStatus({ classroomId, teamSetId: set.id }))
          .create!;
        expect(polled.teams.map(team => team.name)).toEqual(shownNames);
        const shownSet = (await teamSetService.getSet({
          classroomId,
          formId: formC,
          setRef: set.id,
        }))!;
        expect(shownSet.status).toBe('create_failed');
        expect(shownSet.create_state).toMatchObject({
          status: 'FAILED',
          run_id: first.id,
          names: shownNames,
          failed: [{ team: set.name, reason: 'name_collision' }],
          teams: failed.teams,
        });
        expect(shownSet.create_state).not.toHaveProperty('renamed');
        for (const read of [progress, polled, shownSet.create_state]) {
          expect(JSON.stringify(read)).not.toContain(plannedName);
        }
        const stored = (await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } }))
          .create_state as unknown as CreateState;
        expect(stored.names).toEqual(colorNames);
        expect(stored.failed).toEqual(failed.failed);

        // The retry previews and claims those names, listed by members too.
        const preview = await teamSetService.previewCreate({
          classroomId,
          teamSetId: set.id,
          runRef: first.number,
        });
        expect(preview.retry).toEqual({ attempt: 2, teams_already_created: 1 });
        expect(preview.teams.map(team => team.name)).toEqual(view.teams.map(team => team.name));
        expect(preview.teams.every(team => team.option === null)).toBe(true);
        await teamSetService.claimCreate({
          classroomId,
          teamSetId: set.id,
          runId: first.id,
          userId: ownerId,
        });
        const claimed = (await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } }))
          .create_state as unknown as CreateState;
        // The names the reads showed before the claim.
        expect(claimed.names).toEqual(shownNames);
        expect(claimed).not.toHaveProperty('renamed');

        // Why facts number teams the same way; nothing per option.
        const facts = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: set.id,
          runRef: first.number,
        });
        expect(facts).toHaveLength(6);
        for (const fact of facts) {
          const team = view.teams[fact.team.n - 1]!;
          expect(team.members.map(m => m.user_id)).toContain(fact.user_id);
          expect(fact.team.name).toBe(team.name);
          expect(fact.pitched).toEqual([]);
        }
        // The run before was grouped by the same question: moved is by
        // teammates, and nobody's teammates changed.
        const later = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: set.id,
          runRef: second.number,
        });
        expect(later.every(fact => fact.previous === null)).toBe(true);

        const masked = await compare();
        expect(masked.grouped).toBe(false);
        expect(masked.moved).toEqual([]);
        expect(masked.unchanged).toBe(6);
      } finally {
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
      }
    });

    it('numbers and lists a flagged grouping’s create as the run view does, in every state, and stores it unchanged', async () => {
      const set = await setOnC('masked create order', {
        grouping: { mode: 'by_option', field_id: colorC, teams_per_option: 2 },
        non_respondents: 'exclude',
        team_size: { min: 2, max: 2 },
        team_name_template: '{set}-{option}',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: colorC, job: 'rank', strength: 'prefer' }],
        },
      });
      // Three pairs on slots 0-2, the pair with the smallest user id on slot
      // 2: listed by members, result team 2 comes first, then 0, then 1.
      const { run: started } = await teamSetService.startRun({
        classroomId,
        teamSetId: set.id,
        userId: ownerId,
        seed: 7,
      });
      const byId = started!.problem.people
        .map((id, p) => ({ id, p }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(entry => entry.p);
      const pairOf = (k: number) => [byId[2 * k]!, byId[2 * k + 1]!].sort((a, b) => a - b);
      const assignment = [
        { slot: 0, members: pairOf(1) },
        { slot: 1, members: pairOf(2) },
        { slot: 2, members: pairOf(0) },
      ];
      const scored = scoreAssignment(started!.problem, assignment);
      expect(scored.violations).toEqual([]);
      const run = await teamSetService.completeRun(started!.id, {
        status: 'OPTIMAL',
        teams: assignment,
        objective: scored.objective,
        bound: scored.objective,
        wall_s: 0.1,
        core: [],
      });
      const stored = run.result!.teams;
      expect(stored).toHaveLength(3);
      const shownIndex = stored
        .map((team, i) => ({ i, key: [...team.member_user_ids].sort()[0]! }))
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map(entry => entry.i);
      expect(shownIndex).toEqual([2, 0, 1]);
      const shownN = (i: number) => shownIndex.indexOf(i) + 1;
      const membersOf = (i: number) => [...stored[i]!.member_user_ids].sort();

      // Before the flag the view lists the teams as stored: the names a create plans.
      const planned = (
        await teamSetService.describeRun({ classroomId, run, includePeople: false })
      ).teams.map(team => team.name);
      expect(new Set(planned).size).toBe(3);
      const teamIds: string[] = planned.map(() => randomUUID());
      const now = new Date().toISOString();
      const base = {
        run_id: run.id,
        run_number: run.number,
        total: 3,
        names: planned,
        sizes: [2, 2, 2],
        attempt: 1,
        attempt_id: randomUUID(),
        claimed_by: ownerId,
        started_at: now,
        task_started_at: now,
        heartbeat_at: now,
      };
      const madeTeam = (i: number) => ({
        team_id: teamIds[i]!,
        name: planned[i]!,
        n: i + 1,
        members_added: 2,
      });
      const states: Record<'done' | 'running' | 'failed', CreateState> = {
        done: {
          ...base,
          status: 'DONE',
          done: 3,
          failed: [],
          teams: [0, 1, 2].map(madeTeam),
          renamed: [{ n: 1, from: `${planned[0]}-earlier`, to: planned[0]! }],
          finished_at: now,
        } as CreateState,
        // The apply makes the teams in result order: team 0 is made, team 1 is being made.
        running: {
          ...base,
          status: 'RUNNING',
          done: 1,
          failed: [],
          teams: [madeTeam(0)],
          finished_at: null,
        } as CreateState,
        // Team 0 was made; teams 1 and 2 failed, in that order.
        failed: {
          ...base,
          status: 'FAILED',
          done: 1,
          failed: [
            { team: planned[1]!, reason: 'name_collision' },
            { team: planned[2]!, reason: 'name_collision' },
          ],
          teams: [madeTeam(0)],
          renamed: [{ n: 1, from: `${planned[0]}-earlier`, to: planned[0]! }],
          finished_at: now,
        } as CreateState,
      };
      const write = (state: CreateState) =>
        prisma.teamSet.update({
          where: { id: set.id },
          data: {
            created_run_id: run.id,
            create_state: state as unknown as Prisma.InputJsonValue,
          },
        });

      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, colorC) as Prisma.InputJsonValue },
      });
      try {
        for (const [label, state] of Object.entries(states)) {
          await write(state);
          // The run view with this create (a made team keeps its name there).
          const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
          expect(view.teams.map(team => team.n)).toEqual([1, 2, 3]);
          view.teams.forEach((team, k) => {
            expect(team.members.map(m => m.user_id).sort()).toEqual(membersOf(shownIndex[k]!));
          });
          const viewName = (n: number) => view.teams.find(team => team.n === n)!.name;
          for (const i of state.teams.map(team => team.n! - 1)) {
            expect(viewName(shownN(i)), label).toBe(planned[i]);
          }

          const progress = (await teamSetService.getCreateProgress({
            classroomId,
            teamSetId: set.id,
          }))!;
          const polled = (await teamSetService.pollStatus({ classroomId, teamSetId: set.id }))
            .create!;
          const shownSet = (await teamSetService.getSet({
            classroomId,
            formId: formC,
            setRef: set.id,
          }))!;
          const shownState = shownSet.create_state!;

          // Every read lists and numbers the teams as the view does: team n is
          // the view's team n. The names are the view's, except that a
          // running create makes its teams under the names planned at its claim.
          const expectedNames =
            label === 'running'
              ? shownIndex.map(i => planned[i]!)
              : view.teams.map(team => team.name);
          for (const read of [progress, polled]) {
            expect(
              read.teams.map(team => team.n),
              label
            ).toEqual([1, 2, 3]);
            expect(
              read.teams.map(team => team.name),
              label
            ).toEqual(expectedNames);
          }
          expect(shownState.names, label).toEqual(expectedNames);
          expect(shownState.sizes, label).toEqual([2, 2, 2]);
          // A made team: joined to the view by n, it is the stored team's members.
          const made = state.teams.map(team => team.n! - 1);
          expect(
            shownState.teams.map(team => [team.n, team.team_id]),
            label
          ).toEqual(
            made
              .map(i => [shownN(i), teamIds[i]])
              .sort((a, b) => (a[0] as number) - (b[0] as number))
          );
          for (const team of shownState.teams) {
            const i = teamIds.indexOf(team.team_id);
            expect(team.name, label).toBe(viewName(team.n!));
            expect(membersOf(i), label).toEqual(
              view.teams[team.n! - 1]!.members.map(m => m.user_id).sort()
            );
          }
          const rowStates = progress.teams.map(team => team.state);
          if (label === 'done') {
            expect(rowStates).toEqual(['done', 'done', 'done']);
            expect(progress.renamed).toEqual([{ ...state.renamed![0]!, n: shownN(0) }]);
            expect(shownState.renamed).toEqual(progress.renamed);
          } else if (label === 'running') {
            // Live is the team being made (result team 1), wherever it is listed.
            expect(rowStates).toEqual(['queued', 'done', 'live']);
            expect(progress.teams.find(team => team.state === 'live')!.n).toBe(shownN(1));
          } else {
            expect(rowStates).toEqual(['failed', 'done', 'failed']);
            // Failures follow the listed order, under the names the view gives.
            expect(progress.failures.map(failure => failure.team)).toEqual([
              viewName(shownN(2)),
              viewName(shownN(1)),
            ]);
            expect(shownState.failed.map(failure => failure.team)).toEqual(
              progress.failures.map(failure => failure.team)
            );
            expect(progress.renamed).toEqual([{ ...state.renamed![0]!, n: shownN(0) }]);
          }

          // Stored, the state is unchanged: result order, result positions.
          const kept = (await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } }))
            .create_state as unknown as CreateState;
          expect(kept, label).toEqual(state);
        }
      } finally {
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
        await prisma.teamSet.update({
          where: { id: set.id },
          data: { created_run_id: null, create_state: Prisma.DbNull },
        });
      }
    });

    it('lists a flagged grouping’s runs with no per-option rows for the people who didn’t answer', async () => {
      // s6 and s7 didn't answer this form: grouped, they share the last pair.
      const set = await setOnC('masked list', {
        grouping: { mode: 'by_option', field_id: colorC, teams_per_option: 2 },
        non_respondents: 'group',
        team_size: { min: 2, max: 2 },
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: colorC, job: 'rank', strength: 'prefer' }],
        },
      });
      const { run: started } = await teamSetService.startRun({
        classroomId,
        teamSetId: set.id,
        userId: ownerId,
        seed: 7,
      });
      const problem = started!.problem;
      const group = new Set(problem.group!.members);
      expect(group.size).toBe(2);
      const answered = problem.people.map((_, p) => p).filter(p => !group.has(p));
      const assignment = [
        { slot: 0, members: answered.slice(0, 2) },
        { slot: 1, members: answered.slice(2, 4) },
        { slot: 2, members: answered.slice(4, 6) },
        { slot: 3, members: [...group].sort((a, b) => a - b) },
      ];
      const scored = scoreAssignment(problem, assignment);
      expect(scored.violations).toEqual([]);
      const run = await teamSetService.completeRun(started!.id, {
        status: 'OPTIMAL',
        teams: assignment,
        objective: scored.objective,
        bound: scored.objective,
        wall_s: 0.1,
        core: [],
        stages: {
          first: { status: 'OPTIMAL', objective: scored.parts.first, bound: scored.parts.first },
          second: { status: 'OPTIMAL', objective: scored.parts.second },
        },
      });
      expect(run.status).toBe('SOLVED');
      const listedMetrics = async () =>
        (await teamSetService.listRuns({ classroomId, teamSetId: set.id })).find(
          entry => entry.number === run.number
        )!.metrics!;
      expect((await listedMetrics()).non_respondents!.options).toHaveLength(1);

      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, colorC) as Prisma.InputJsonValue },
      });
      try {
        const metrics = await listedMetrics();
        expect(metrics.non_respondents).toMatchObject({ mode: 'group', people: 2, options: [] });
        const view = await teamSetService.describeRun({ classroomId, run, includePeople: false });
        expect(metrics.non_respondents).toEqual(view.metrics!.non_respondents);
      } finally {
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
      }
      expect((await listedMetrics()).non_respondents!.options).toHaveLength(1);
    });

    it('names the teams of a failed create that made none as a retry will, in what a save returns', async () => {
      const set = await setOnC('masked save', {
        grouping: { mode: 'by_option', field_id: colorC, teams_per_option: 1 },
        non_respondents: 'exclude',
        team_name_template: '{set}-{option}',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: colorC, job: 'rank', strength: 'prefer' }],
        },
      });
      const run = await solvedRun(set.id);
      const planned = (
        await teamSetService.describeRun({ classroomId, run, includePeople: false })
      ).teams.map(team => team.name);
      expect(planned.every(name => /-(red|blue)$/.test(name))).toBe(true);

      // It stopped before making any team: the set isn't locked, so it saves.
      const now = new Date().toISOString();
      const failed = {
        status: 'FAILED',
        run_id: run.id,
        run_number: run.number,
        total: 2,
        done: 0,
        failed: [
          { team: planned[0]!, reason: 'name_collision' },
          { team: '*', reason: 'internal_error' },
        ],
        teams: [],
        names: planned,
        sizes: [3, 3],
        attempt: 1,
        attempt_id: randomUUID(),
        claimed_by: ownerId,
        started_at: now,
        task_started_at: now,
        heartbeat_at: now,
        finished_at: now,
      } as CreateState;
      await prisma.teamSet.update({
        where: { id: set.id },
        data: { created_run_id: run.id, create_state: failed as unknown as Prisma.InputJsonValue },
      });

      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, colorC) as Prisma.InputJsonValue },
      });
      try {
        const viewNames = (
          await teamSetService.describeRun({ classroomId, run, includePeople: false })
        ).teams.map(team => team.name);
        // The grouping question can't be grouped by now: the save moves off it.
        const saved = await teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch: {
            grouping: { mode: 'by_option', field_id: rankC, teams_per_option: 1 },
            rules: { remove: [{ field_id: colorC, job: 'rank' }] },
          },
        });
        expect(saved.locked).toBe(false);
        const names = saved.create_state!.names!;
        expect([...names].sort()).toEqual([...viewNames].sort());
        expect(names.some(name => /red|blue/.test(name))).toBe(false);
        expect(saved.create_state!.failed).toEqual([
          { team: names[0], reason: 'name_collision' },
          { team: '*', reason: 'internal_error' },
        ]);
        const progress = (await teamSetService.getCreateProgress({
          classroomId,
          teamSetId: set.id,
        }))!;
        expect(progress.teams.map(team => team.name)).toEqual(names);
        for (const read of [saved.create_state, progress]) {
          for (const name of planned) expect(JSON.stringify(read)).not.toContain(name);
        }
      } finally {
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
      }
    });

    it('labels where the run before put someone from any question of the form', async () => {
      const set = await setOnC('regrouped', {
        grouping: { mode: 'by_option', field_id: sizeC, teams_per_option: 1 },
        non_respondents: 'exclude',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: sizeC, job: 'rank', strength: 'prefer' }],
        },
      });
      await solvedRun(set.id);
      await teamSetService.saveConfig({
        classroomId,
        formId: formC,
        setRef: set.id,
        userId: ownerId,
        patch: {
          grouping: { mode: 'by_option', field_id: colorC, teams_per_option: 1 },
          rules: {
            remove: [{ field_id: sizeC, job: 'rank' }],
            upsert: [{ field_id: colorC, job: 'rank', strength: 'prefer' }],
          },
        },
      });
      const run = await solvedRun(set.id);
      const facts = await teamSetService.explainPlacements({
        classroomId,
        teamSetId: set.id,
        runRef: run.number,
      });
      const previous = facts.flatMap(fact => (fact.previous ? [fact.previous] : []));
      expect(previous.length).toBeGreaterThan(0);
      for (const seat of previous) {
        expect(['Small', 'Large']).toContain(seat.option?.label);
      }
    });

    it('states no picks for free teams', async () => {
      const set = await setOnC('free picks', {
        grouping: { mode: 'free' },
        non_respondents: 'exclude',
        rules: { remove: await dropSuggested() },
      });
      const first = await solvedRun(set.id);
      const second = await rotatedRun(set.id, first);
      const view = await teamSetService.describeRun({
        classroomId,
        run: first,
        includePeople: true,
      });
      expect(view.metrics).toMatchObject({
        placement: null,
        first_choice: null,
        top2: null,
        top3: null,
        people: 6,
      });
      for (const member of view.teams.flatMap(team => team.members)) {
        expect(member.placement).toBeNull();
      }
      const listed = await teamSetService.listRuns({ classroomId, teamSetId: set.id });
      for (const item of listed) {
        expect(item.first_choice).toBeNull();
        expect(item.metrics?.first_choice).toBeNull();
        expect(item.responded).toBe(6);
      }
      const row = (await teamSetService.listForForm({ classroomId, formId: formC })).find(
        entry => entry.id === set.id
      )!;
      expect(row.latest_run).toMatchObject({ number: second.number, first_choice: null });
      const compared = await teamSetService.compareRuns({
        classroomId,
        teamSetId: set.id,
        runRef: second.number,
        otherRunRef: first.number,
        includePeople: false,
      });
      expect(compared.metrics.map(metric => metric.key)).not.toContain('first_choice');
      expect(compared.metrics.map(metric => metric.key)).not.toContain('top3');
      const facts = await teamSetService.explainPlacements({
        classroomId,
        teamSetId: set.id,
        runRef: first.number,
      });
      expect(facts.every(fact => fact.placement === null)).toBe(true);
    });

    it('shows no placement for someone off their picks once the fallback question is flagged', async () => {
      // A form of its own: one pick of three studios, and a multiselect of
      // areas the studios are filed under. s0–s5 all pick North and choose
      // both areas, so the four not on North are placed by category.
      const form = await formService.create({
        classroomId,
        title: `Fallback form ${suite}`,
        access: 'CLASSROOM',
        createdBy: ownerId,
        fields: [
          {
            type: 'ranked_choice',
            label: 'Rank the studios',
            options: ['North', 'South', 'East'],
            ranks: 1,
          },
          { type: 'multiselect', label: 'Areas', options: ['Web', 'Data'] },
        ],
      });
      const { revision } = await formService.publish(form.id);
      const fields = formService.fieldsOf(revision.fields);
      const rankD = fields[0]!.id;
      const areasD = fields[1]!.id;
      const studios = (fields[0]!.options as { id: string }[]).map(o => o.id);
      const areas = (fields[1]!.options as { id: string }[]).map(o => o.id);
      for (let i = 0; i < 6; i++) {
        const userId = studentIds[i]!;
        await responseService.submitClassroom({
          formId: form.id,
          userId,
          email: `${logins.get(userId)}@example.test`,
          name: `Team Test ${userId.slice(0, 4)}`,
          revisionId: revision.id,
          answers: { [rankD]: [studios[0]], [areasD]: areas },
        });
      }
      const suggested = await teamSetService.suggestForForm({ classroomId, formId: form.id });
      const set = await teamSetService.saveConfig({
        classroomId,
        formId: form.id,
        userId: ownerId,
        name: `fallback mask ${suite}`,
        patch: {
          grouping: { mode: 'by_option', field_id: rankD, teams_per_option: 1 },
          team_size: { min: 2, max: 2 },
          non_respondents: 'exclude',
          options: { [studios[1]!]: { category: 'Web' }, [studios[2]!]: { category: 'Data' } },
          rules: {
            remove: suggested.config.rules.map(rule => ({
              field_id: rule.field_id,
              job: rule.job,
            })),
            upsert: [
              { field_id: rankD, job: 'rank', strength: 'prefer' },
              { field_id: areasD, job: 'fallback', strength: 'prefer' },
            ],
          },
        },
      });
      const run = await solvedRun(set.id);
      const placed = async () => {
        const view = await teamSetService.describeRun({ classroomId, run, includePeople: true });
        const facts = await teamSetService.explainPlacements({
          classroomId,
          teamSetId: set.id,
          runRef: run.number,
        });
        return {
          members: new Map(
            view.teams.flatMap(team => team.members.map(m => [m.user_id, m.placement] as const))
          ),
          facts: new Map(facts.map(fact => [fact.user_id, fact.placement] as const)),
        };
      };
      const before = await placed();
      expect([...before.members.values()].sort()).toEqual([
        '1',
        '1',
        'fallback',
        'fallback',
        'fallback',
        'fallback',
      ]);
      expect(before.facts).toEqual(before.members);

      await prisma.form.update({
        where: { id: form.id },
        data: { draft_fields: withFlag(revision.fields, areasD) as Prisma.InputJsonValue },
      });
      const after = await placed();
      // Without the categories, placed by category would read as missed:
      // those four show no placement; the first picks still do.
      for (const [userId, placement] of before.members) {
        const shown = placement === 'fallback' ? null : placement;
        expect(after.members.get(userId)).toBe(shown);
        expect(after.facts.get(userId)).toBe(shown);
      }
    });

    it('compares how people who didn’t answer are placed as a run would place them now', async () => {
      // Pairs, a rank rule, 6 of the 8 answered: the default is Group (the other
      // 2 make a pair of their own).
      const set = await setOnC('effective mode', {
        team_size: { min: 2, max: 2 },
        non_respondents: 'include',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: rankC, job: 'rank', strength: 'prefer' }],
        },
      });
      const run = await solvedRun(set.id);
      expect(run.config.non_respondents).toBe('include');
      const save = (patch: Record<string, unknown>) =>
        teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch,
        });
      await save({ non_respondents: null });
      expect(await teamSetService.nonRespondentsFor({ classroomId, teamSetId: set.id })).toEqual({
        setting: null,
        resolved: 'group',
      });
      const change = "People who didn't answer: Spread → Group";
      const since = await teamSetService.changesSinceRun({ classroomId, teamSetId: set.id });
      expect(since.changes.map(item => item.text)).toEqual([change]);
      // A caller that has the mode already passes it (no compile here).
      expect(
        (
          await teamSetService.changesSinceRun({
            classroomId,
            teamSetId: set.id,
            nonRespondents: 'include',
          })
        ).changes
      ).toEqual([]);
      const view = await teamSetService.describeRun({ classroomId, run, includePeople: false });
      expect(view.changes_since_run.map(item => item.text)).toEqual([change]);
      const setup = await teamSetService.getSetup({ classroomId, formId: formC, setRef: set.id });
      expect(setup.non_respondents).toMatchObject({ mode: null, resolved: 'group' });
      expect(setup.changes.items.map(item => item.text)).toEqual([change]);
      const checked = await teamSetService.checkPatch({
        classroomId,
        formId: formC,
        setRef: set.id,
      });
      expect(checked.non_respondents).toEqual({ setting: null, resolved: 'group' });

      // With Alpha closed only Beta's two teams can open: grouped, the two who
      // didn't answer would leave the six who answered one team, so the
      // default is Spread, as the run used — no change there.
      await save({ options: { [projectsC[0]!]: { open: 'closed' } } });
      expect(await teamSetService.nonRespondentsFor({ classroomId, teamSetId: set.id })).toEqual({
        setting: null,
        resolved: 'include',
      });
      const later = await teamSetService.changesSinceRun({ classroomId, teamSetId: set.id });
      expect(later.changes.map(item => item.kind)).toEqual(['option']);
    });

    it('traces since when an option is Closed across more runs than one read holds', async () => {
      const set = await setOnC('long history', {
        options: { [projectsC[0]!]: { open: 'closed' } },
      });
      // Runs as closedProvenance reads them: a number and the setup snapshot.
      let number = 0;
      const run = async () => {
        const row = await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } });
        number += 1;
        await prisma.teamSetRun.create({
          data: {
            team_set_id: set.id,
            number,
            status: 'FAILED',
            error: 'canceled',
            config: row.config as Prisma.InputJsonValue,
            problem: {},
            context: {},
            inputs: {},
            seed: 0,
            engine: 'test',
            created_by: ownerId,
          },
        });
        return number;
      };
      // 22 runs with it Closed (more than one page of 20), then one Open…
      for (let i = 0; i < 22; i++) await run();
      const setup = async () =>
        (await teamSetService.getSetup({ classroomId, formId: formC, setRef: set.id })).options[0]!
          .closed;
      expect((await setup())!.since_run).toBe(1);
      const patch = (open: 'closed' | null) =>
        teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch: { options: { [projectsC[0]!]: { open } } },
        });
      await patch(null);
      await run();
      // …then Closed again for the last runs: the streak starts after the Open one.
      await patch('closed');
      const again = await run();
      await run();
      expect((await setup())!.since_run).toBe(again);
    });

    it('counts readiness without reading answers, and words each rule’s Must', async () => {
      expect(await teamSetService.readinessCounts({ classroomId, formId: formC })).toEqual({
        roster: STUDENTS,
        responded: 6,
      });
      const labels = await teamSetService.mustLabels({
        classroomId,
        formId: formC,
        config: {
          rules: [
            { field_id: rankC, job: 'rank', strength: 'prefer', weight: 5, params: {} },
            { field_id: colorC, job: 'no_one_alone', strength: 'prefer', weight: 5, params: {} },
            { field_id: randomUUID(), job: 'rank', strength: 'must', weight: 5, params: {} },
          ],
        },
      });
      expect(labels).toEqual({
        [`${rankC}:rank`]: 'Everyone gets one of the options they ranked',
        [`${colorC}:no_one_alone`]: 'No one is the only person on their team with their answer',
      });
    });

    it('lists a stored setup that no longer fits as label-based issues pointing at what to change', async () => {
      const set = await setOnC('stranded', {
        pins: { add: [{ kind: 'on_option', user_id: studentIds[0]!, option_id: projectsC[0]! }] },
      });
      // Saved before, now free: the option pin is stranded (no save would take it).
      const stored = (await prisma.teamSet.findUniqueOrThrow({ where: { id: set.id } }))
        .config as unknown as TeamSetConfig;
      await prisma.teamSet.update({
        where: { id: set.id },
        data: {
          config: {
            ...stored,
            grouping: { mode: 'free' },
            options: {},
            rules: [],
          } as unknown as Prisma.InputJsonValue,
        },
      });
      const issues = await teamSetService.checkSet({ classroomId, teamSetId: set.id });
      expect(issues).toContainEqual({
        level: 'error',
        code: 'invalid_config',
        message: 'A pin places people on options, but teams are not grouped by a question.',
        srcs: ['pin:p1'],
      });
      for (const issue of issues) expect(issue.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    });

    it('says a GitHub team exists only for teams that exist', async () => {
      const set = await setOnC('progress');
      const run = await solvedRun(set.id);
      const names = [`fw-${suite}-01`, `fw-${suite}-02`, `fw-${suite}-03`];
      const now = new Date().toISOString();
      const state = {
        status: 'RUNNING',
        run_id: run.id,
        run_number: run.number,
        total: 3,
        done: 1,
        failed: [],
        teams: [{ team_id: randomUUID(), name: names[0], n: 1, members_added: 2 }],
        names,
        sizes: [2, 2, 2],
        attempt: 1,
        attempt_id: randomUUID(),
        claimed_by: ownerId,
        started_at: now,
        task_started_at: now,
        heartbeat_at: now,
        finished_at: null,
      };
      await prisma.teamSet.update({
        where: { id: set.id },
        data: { create_state: state as unknown as Prisma.InputJsonValue },
      });
      const running = await teamSetService.getCreateProgress({ classroomId, teamSetId: set.id });
      expect(running!.teams.map(team => [team.state, team.github_team])).toEqual([
        ['done', true],
        ['live', false],
        ['queued', false],
      ]);

      // Two name collisions; a classroom team holds the first name only.
      await prisma.team.create({
        data: { classroom_id: classroomId, name: names[1]!, slug: names[1]!, is_visible: true },
      });
      await prisma.teamSet.update({
        where: { id: set.id },
        data: {
          create_state: {
            ...state,
            status: 'FAILED',
            done: 3,
            failed: [
              { team: names[1], reason: 'name_collision' },
              { team: names[2], reason: 'name_collision' },
            ],
            finished_at: now,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      const failed = await teamSetService.getCreateProgress({ classroomId, teamSetId: set.id });
      expect(failed!.teams.map(team => [team.state, team.github_team])).toEqual([
        ['done', true],
        ['failed', true],
        ['failed', false],
      ]);
    });

    it('labels an option in the changes since a run grouped by another question', async () => {
      const set = await setOnC('regroup', {
        grouping: { mode: 'by_option', field_id: colorC, teams_per_option: 2 },
      });
      const run = await solvedRun(set.id);
      await teamSetService.saveConfig({
        classroomId,
        formId: formC,
        setRef: set.id,
        userId: ownerId,
        patch: {
          grouping: { mode: 'by_option', field_id: sizeC, teams_per_option: 2 },
          pins: { add: [{ kind: 'on_option', user_id: studentIds[0]!, option_id: largeId }] },
        },
      });
      const { changes } = await teamSetService.changesSinceRun({ classroomId, teamSetId: set.id });
      const pin = changes.find(change => change.kind === 'pin')!;
      expect(pin.text).toBe("Pin added: Team Test s0 → 'Large'");
      expect(pin).toMatchObject({ pin: { option: { id: largeId, label: 'Large' } } });
      const view = await teamSetService.describeRun({ classroomId, run, includePeople: false });
      expect(view.changes_since_run.find(change => change.kind === 'pin')!.text).toBe(
        "Pin added: one student → 'Large'"
      );
    });

    it('counts a flag saved only in the draft: no Must, match or mix on that question', async () => {
      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, sizeC) as Prisma.InputJsonValue },
      });
      try {
        const set = await setOnC('draft flag');
        const refuse = async (rule: {
          job: 'match' | 'mix' | 'no_one_alone';
          strength: 'prefer' | 'must';
        }) =>
          errorOf(
            teamSetService.saveConfig({
              classroomId,
              formId: formC,
              setRef: set.id,
              userId: ownerId,
              patch: { rules: { upsert: [{ field_id: sizeC, ...rule }] } },
            })
          );
        expect(await refuse({ job: 'match', strength: 'prefer' })).toMatchObject({
          code: 'invalid_config',
        });
        expect(await refuse({ job: 'mix', strength: 'prefer' })).toMatchObject({
          code: 'invalid_config',
        });
        expect(await refuse({ job: 'no_one_alone', strength: 'must' })).toMatchObject({
          code: 'invalid_config',
        });
        // Only "no one alone" at Off/Prefer.
        const saved = await teamSetService.saveConfig({
          classroomId,
          formId: formC,
          setRef: set.id,
          userId: ownerId,
          patch: {
            rules: { upsert: [{ field_id: sizeC, job: 'no_one_alone', strength: 'prefer' }] },
          },
        });
        expect(saved.config.rules).toContainEqual(
          expect.objectContaining({ field_id: sizeC, job: 'no_one_alone', strength: 'prefer' })
        );
        // The Setup offers what the save allows.
        const setup = await teamSetService.getSetup({ classroomId, formId: formC, setRef: set.id });
        expect(setup.questions.find(q => q.field_id === sizeC)).toMatchObject({
          identity: true,
          jobs_allowed: ['no_one_alone'],
        });

        // A set that already had a Must on the question is refused by its checks.
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
        const must = await setOnC('draft flag must', {
          rules: {
            remove: await dropSuggested(),
            upsert: [{ field_id: sizeC, job: 'match', strength: 'must' }],
          },
        });
        await prisma.form.update({
          where: { id: formC },
          data: { draft_fields: withFlag(storedFieldsC, sizeC) as Prisma.InputJsonValue },
        });
        const checks = await teamSetService.checkSet({ classroomId, teamSetId: must.id });
        expect(checks).toContainEqual(
          expect.objectContaining({
            level: 'error',
            code: 'invalid_config',
            srcs: [`${sizeC}:match`],
          })
        );
        const started = await teamSetService.startRun({
          classroomId,
          teamSetId: must.id,
          userId: ownerId,
        });
        expect(started.run).toBeNull();
      } finally {
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
      }
    });

    it('uses Spread when the default Group can’t seat the people who didn’t answer, and says so', async () => {
      // Pairs, the default mode; s6 and s7 didn't answer and s7 is pinned (so
      // placed with the others): one person is left for Group — no team of one.
      const set = await setOnC('fallback', {
        team_size: { min: 2, max: 2 },
        non_respondents: null,
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: rankC, job: 'rank', strength: 'prefer' }],
        },
        pins: { add: [{ kind: 'on_option', user_id: studentIds[7]!, option_id: projectsC[0]! }] },
      });
      const setup = await teamSetService.getSetup({ classroomId, formId: formC, setRef: set.id });
      expect(setup.non_respondents).toEqual({ mode: null, resolved: 'include', count: 2 });
      expect(setup.checks.filter(issue => issue.level === 'error')).toEqual([]);
      // 8 in pairs: four teams.
      expect(setup.shape).toEqual({ people: 8, team_count_range: { min: 4, max: 4 } });
      const { run } = await teamSetService.startRun({
        classroomId,
        teamSetId: set.id,
        userId: ownerId,
      });
      // The run stores the mode it used, and its problem has no group.
      expect(run!.config.non_respondents).toBe('include');
      expect(run!.problem).not.toHaveProperty('group');
      await settleRuns(set.id);
      // The same default today is no change since that run.
      const { changes } = await teamSetService.changesSinceRun({ classroomId, teamSetId: set.id });
      expect(changes.filter(change => change.kind === 'non_respondents')).toEqual([]);

      // Group chosen: refused with the fact, not Spread.
      await teamSetService.saveConfig({
        classroomId,
        formId: formC,
        setRef: set.id,
        userId: ownerId,
        patch: { non_respondents: 'group' },
      });
      const chosen = await teamSetService.getSetup({ classroomId, formId: formC, setRef: set.id });
      expect(chosen.non_respondents).toEqual({ mode: 'group', resolved: 'group', count: 2 });
      expect(chosen.checks).toContainEqual(
        expect.objectContaining({
          level: 'error',
          code: 'group_too_small',
          message: "1 person didn't answer, fewer than the smallest team allowed (2).",
        })
      );
    });

    it('merges one rule’s students into one Can’t-solve line, and drops them on a masked question', async () => {
      const set = await setOnC('merged core', {
        grouping: { mode: 'free' },
        team_size: { min: 2, max: 2 },
        non_respondents: 'exclude',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: colorC, job: 'no_one_alone', strength: 'must' }],
        },
      });
      const rule = `${colorC}:no_one_alone`;
      const { run } = await teamSetService.startRun({
        classroomId,
        teamSetId: set.id,
        userId: ownerId,
      });
      const unsolved = await teamSetService.completeRun(run!.id, {
        status: 'INFEASIBLE',
        teams: [],
        objective: null,
        bound: null,
        wall_s: 0.1,
        core: [`${rule}@0+1`, 'non_respondents', `${rule}@1+2`],
        core_status: 'complete',
      });
      const view = await teamSetService.describeRun({
        classroomId,
        run: unsolved,
        includePeople: true,
      });
      expect(view.core.map(item => [item.src, item.people?.length ?? 0])).toEqual([
        [rule, 3],
        ['non_respondents', 0],
      ]);
      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, colorC) as Prisma.InputJsonValue },
      });
      try {
        const masked = await teamSetService.describeRun({
          classroomId,
          run: unsolved,
          includePeople: true,
        });
        expect(masked.core[0]).toMatchObject({ src: rule });
        expect(masked.core[0]).not.toHaveProperty('people');
        expect(masked.core[0]).not.toHaveProperty('user_ids');
      } finally {
        await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
      }
    });

    it('never names students on an issue or a Can’t-solve item about a question flagged later', async () => {
      // Pairs, a Must "no one alone" on the color: three students said Red.
      const set = await setOnC('masked', {
        grouping: { mode: 'free' },
        team_size: { min: 2, max: 2 },
        non_respondents: 'exclude',
        rules: {
          remove: await dropSuggested(),
          upsert: [{ field_id: colorC, job: 'no_one_alone', strength: 'must' }],
        },
      });
      const rule = `${colorC}:no_one_alone`;
      const aboutColor = (issue: { srcs?: string[] }) => issue.srcs?.includes(rule) === true;
      const peopleOn = (issues: { srcs?: string[]; user_ids?: string[]; names?: string[] }[]) =>
        issues
          .filter(aboutColor)
          .flatMap(issue => [...(issue.user_ids ?? []), ...(issue.names ?? [])]);

      // Before any flag the check names the three.
      const plain = await teamSetService.checkPatch({ classroomId, formId: formC, setRef: set.id });
      expect(peopleOn(plain.issues)).not.toEqual([]);
      const { run } = await teamSetService.startRun({
        classroomId,
        teamSetId: set.id,
        userId: ownerId,
      });
      expect(peopleOn(run!.diagnostics?.issues ?? [])).not.toEqual([]);
      const unsolved = await teamSetService.completeRun(run!.id, {
        status: 'INFEASIBLE',
        teams: [],
        objective: null,
        bound: null,
        wall_s: 0.1,
        core: [`${rule}@0+1`],
        core_status: 'complete',
      });
      const before = await teamSetService.describeRun({
        classroomId,
        run: unsolved,
        includePeople: true,
      });
      expect(before.core[0]).toMatchObject({ src: `${rule}@0+1` });
      expect(before.core[0]!.people).toHaveLength(2);

      const expectNoPeople = async () => {
        const checked = await teamSetService.checkPatch({
          classroomId,
          formId: formC,
          setRef: set.id,
        });
        expect(peopleOn(checked.issues)).toEqual([]);
        const checks = await teamSetService.checkSet({ classroomId, teamSetId: set.id });
        expect(peopleOn(checks)).toEqual([]);
        const setup = await teamSetService.getSetup({ classroomId, formId: formC, setRef: set.id });
        expect(peopleOn(setup.checks)).toEqual([]);
        for (const includePeople of [true, false]) {
          const view = await teamSetService.describeRun({
            classroomId,
            run: unsolved,
            includePeople,
          });
          expect(peopleOn(view.issues)).toEqual([]);
          expect(view.core[0]).not.toHaveProperty('people');
          expect(view.core[0]).not.toHaveProperty('user_ids');
          // The rule-only label stays.
          expect(view.core[0]!.label).toContain('Pick a color');
        }
      };

      // A flag in the draft only (not published yet).
      await prisma.form.update({
        where: { id: formC },
        data: { draft_fields: withFlag(storedFieldsC, colorC) as Prisma.InputJsonValue },
      });
      await expectNoPeople();
      // An identity question takes no Must: its sentence goes with the flag.
      expect(
        await teamSetService.mustLabels({
          classroomId,
          formId: formC,
          config: {
            rules: [
              { field_id: colorC, job: 'no_one_alone', strength: 'must', weight: 5, params: {} },
            ],
          },
        })
      ).toEqual({});
      const started = await teamSetService.startRun({
        classroomId,
        teamSetId: set.id,
        userId: ownerId,
      });
      expect(peopleOn(started.issues)).toEqual([]);
      await settleRuns(set.id);

      // The flag published after the run was solved.
      await formService.publishNewVersion(
        formC,
        formService.fieldsOf(withFlag(storedFieldsC, colorC))
      );
      await prisma.form.update({ where: { id: formC }, data: { draft_fields: Prisma.DbNull } });
      await expectNoPeople();
    });
  });
});
