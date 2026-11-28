/**
 * The grading services write the audit row of each change they make, against
 * a REAL Postgres: one row with exactly the actor's fields (a web actor, and
 * an MCP one under View as), none when the call changed nothing, none and no
 * throw for `actor: null`, and a saved change that reports `missed` when its
 * row could not be written (here an actor with no user row, which the
 * `audit_logs.user_id` foreign key refuses). Rows are scoped to the
 * submission's classroom and the actor: user A in classroom X and user B in
 * classroom Y never see each other's rows, and a submission of Y named with X's
 * classroom changes nothing and records nothing.
 *
 * Covers HelperService.addGradeToGitRepoAssignment /
 * removeGradeFromGitRepoAssignment / addGraderInClassroom /
 * removeGraderInClassroom / deleteSubmission,
 * gitRepoAssignmentGrader.assignGradersToAssignment,
 * gitRepoAssignment.setLateOverrideForSubmission / setLateOverrideInClassroom
 * and assignment.setGradesReleased.
 *
 * Trigger.dev and the git provider are faked (no run is started, nothing
 * reaches Github). SAFETY: fixtures are namespaced with a fresh uuid and torn
 * down in afterAll (deleting the git organization cascades classrooms,
 * submissions and audit rows). Skipped unless DATABASE_URL names a LOCAL,
 * non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import type { AuditActor } from '../audit.service.ts';
import type {
  AddGraderInClassroomResult,
  RemoveGraderInClassroomResult,
} from '../../helper/index.ts';

const trigger = vi.hoisted(() => ({ batchTrigger: vi.fn(async () => ({ runs: [] })) }));
vi.mock('@trigger.dev/sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@trigger.dev/sdk')>()),
  tasks: { batchTrigger: trigger.batchTrigger, trigger: vi.fn(async () => ({ id: 'run' })) },
}));
vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    addIssueAssignees: vi.fn(),
    removeIssueAssignees: vi.fn(),
    deleteRepository: vi.fn(),
  }),
}));

const { default: HelperService } = await import('../../helper/index.ts');
const gitRepoAssignmentService = await import('../gitRepoAssignment.service.ts');
const graderService = await import('../gitRepoAssignmentGrader.service.ts');
const assignmentService = await import('../assignment.service.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('grading services write their audit rows (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  /** One classroom with a teacher-grader, a student and a module. */
  interface Fixture {
    classroomId: string;
    moduleId: string;
    teacherId: string;
    studentId: string;
  }
  let X: Fixture;
  let Y: Fixture;

  const makeUser = async (label: string, githubLogin?: string) => {
    const user = await prisma.user.create({
      data: {
        email: `gradeaudit-${label}-${suite}@example.test`,
        ...(githubLogin
          ? {
              accounts: {
                create: {
                  provider_id: 'github',
                  account_id: `gh-${label}-${suite}`,
                  username: githubLogin,
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string): Promise<Fixture> => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `gradeaudit-${label}-${suite}`,
        git_org_id: orgId,
        name: `Grade audit ${label} ${suite}`,
        content_namespace: `gradeaudit-${label}-${suite}`,
        content_repo: `content-gradeaudit-${label}-${suite}`,
      },
      select: { id: true },
    });
    const module = await prisma.module.create({
      data: { classroom_id: classroom.id, title: `Module ${label}` },
      select: { id: true },
    });
    const teacherId = await makeUser(`teacher-${label}`, `ta-${label}-${suite}`);
    const studentId = await makeUser(`student-${label}`);
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classroom.id, user_id: teacherId, role: 'TEACHER', is_grader: true },
        { classroom_id: classroom.id, user_id: studentId, role: 'STUDENT' },
      ],
    });
    return { classroomId: classroom.id, moduleId: module.id, teacherId, studentId };
  };

  /** An assignment of a fresh repository, and the student's submission on it (REPO mode). */
  const makeSubmission = async (f: Fixture) => {
    const n = ++serial;
    const repository = await prisma.repository.create({
      data: {
        classroom_id: f.classroomId,
        title: `lab-${n}-${suite}`,
        template: 'org/template',
        type: 'INDIVIDUAL',
      },
      select: { id: true },
    });
    const assignment = await prisma.assignment.create({
      data: {
        module_id: f.moduleId,
        type: 'REPO',
        repository_id: repository.id,
        title: `Lab ${n}`,
        student_deadline: new Date(Date.now() - 48 * 3_600_000),
      },
      select: { id: true },
    });
    const gitRepo = await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `gradeaudit-${n}-${suite}`,
        name: `lab-${n}-${suite}`,
        classroom_id: f.classroomId,
        repository_id: repository.id,
        student_id: f.studentId,
      },
      select: { id: true, name: true },
    });
    const submission = await prisma.gitRepoAssignment.create({
      data: {
        provider: 'GITHUB',
        git_repo_id: gitRepo.id,
        assignment_id: assignment.id,
        closed_at: new Date(Date.now() - 24 * 3_600_000),
      },
      select: { id: true },
    });
    return { submissionId: submission.id, assignmentId: assignment.id, gitRepo };
  };

  const rowsFor = (resourceId: string) =>
    prisma.auditLog.findMany({
      where: { resource_id: resourceId },
      orderBy: { timestamp: 'asc' },
      select: {
        user_id: true,
        classroom_id: true,
        role: true,
        resource_type: true,
        resource_id: true,
        action: true,
        data: true,
      },
    });

  const webActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.teacherId,
    role: 'TEACHER',
    tool,
    impersonatedBy: null,
  });
  const ADMIN = randomUUID();
  const mcpActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.teacherId,
    role: 'TEACHER',
    tool,
    impersonatedBy: ADMIN,
    clientId: 'client-1',
    via: 'mcp',
  });
  /** An actor whose user row does not exist: the foreign key refuses its row. */
  const ghost = (tool: string): AuditActor => ({
    userId: randomUUID(),
    role: 'TEACHER',
    tool,
  });

  const quietly = async <T>(fn: () => Promise<T>) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return { value: await fn(), misses: logged.mock.calls.filter(c => c[0] === 'audit_miss') };
    } finally {
      logged.mockRestore();
    }
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `gradeaudit-${suite}`, login: `ga-${suite}` },
    });
    orgId = org.id;
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });

  // ─── grades ────────────────────────────────────────────────────────────────

  const addGrade = (f: Fixture, submissionId: string, grade: string, actor: AuditActor | null) =>
    HelperService.addGradeToGitRepoAssignment({
      classroom: { id: f.classroomId },
      gitRepoAssignment: { id: submissionId },
      graderId: f.teacherId,
      grade,
      actor,
    });

  describe('addGradeToGitRepoAssignment', () => {
    it('writes one row with exactly the web actor’s fields; a repeat writes none', async () => {
      const { submissionId } = await makeSubmission(X);
      const outcome = await addGrade(X, submissionId, '🟢', webActor(X, 'web:grades.add'));

      expect(outcome.audit).toEqual({ written: 1, missed: 0 });
      expect(await rowsFor(submissionId)).toEqual([
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'GIT_REPO_ASSIGNMENT',
          resource_id: submissionId,
          action: 'CREATE',
          data: { tool: 'web:grades.add', emoji: '🟢', grade_id: outcome.created!.id },
        },
      ]);

      const again = await addGrade(X, submissionId, '🟢', webActor(X, 'web:grades.add'));
      expect(again).toMatchObject({ created: null, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(submissionId)).toHaveLength(1);
    });

    it('an MCP actor under View as: via, client and the admin; a replaced score is named', async () => {
      const { submissionId } = await makeSubmission(X);
      const first = await addGrade(X, submissionId, 'score-70', mcpActor(X, 'grade_add'));
      const second = await addGrade(X, submissionId, 'score-80', mcpActor(X, 'grade_add'));

      const rows = await rowsFor(submissionId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual({
        user_id: X.teacherId,
        classroom_id: X.classroomId,
        role: 'TEACHER',
        resource_type: 'GIT_REPO_ASSIGNMENT',
        resource_id: submissionId,
        action: 'CREATE',
        data: {
          via: 'mcp',
          tool: 'grade_add',
          emoji: 'score-80',
          grade_id: second.created!.id,
          replaced: ['score-70'],
          removed_grade_ids: [first.created!.id],
          client_id: 'client-1',
          impersonated_by: ADMIN,
        },
      });
    });

    it('actor null: the grade is saved and no row is written', async () => {
      const { submissionId } = await makeSubmission(X);
      const outcome = await addGrade(X, submissionId, '🟢', null);
      expect(outcome.created).not.toBeNull();
      expect(outcome.audit).toEqual({ written: 0, missed: 0 });
      expect(await rowsFor(submissionId)).toHaveLength(0);
    });

    it('a row that cannot be written: the grade stands and the call reports the miss', async () => {
      const { submissionId } = await makeSubmission(X);
      const { value: outcome, misses } = await quietly(() =>
        addGrade(X, submissionId, '🟢', ghost('web:grades.add'))
      );
      expect(outcome.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(
        await prisma.assignmentGrade.count({ where: { git_repo_assignment_id: submissionId } })
      ).toBe(1);
      expect(await rowsFor(submissionId)).toHaveLength(0);
    });

    it('user A in classroom X and user B in classroom Y each get their own row only', async () => {
      const inX = await makeSubmission(X);
      const inY = await makeSubmission(Y);
      await addGrade(X, inX.submissionId, '🟢', webActor(X, 'web:grades.add'));
      await addGrade(Y, inY.submissionId, '🔴', webActor(Y, 'web:grades.add'));

      const rowsX = await rowsFor(inX.submissionId);
      const rowsY = await rowsFor(inY.submissionId);
      expect(rowsX.map(r => [r.user_id, r.classroom_id])).toEqual([[X.teacherId, X.classroomId]]);
      expect(rowsY.map(r => [r.user_id, r.classroom_id])).toEqual([[Y.teacherId, Y.classroomId]]);
    });
  });

  describe('removeGradeFromGitRepoAssignment', () => {
    it('writes one DELETE row with the stored grade; an already-removed grade writes none', async () => {
      const { submissionId } = await makeSubmission(X);
      const { created } = await addGrade(X, submissionId, '🟡', null);
      const grade = await prisma.assignmentGrade.findUniqueOrThrow({
        where: { id: created!.id },
        include: { token_transaction: true },
      });
      const remove = (actor: AuditActor | null) =>
        HelperService.removeGradeFromGitRepoAssignment({
          classroom: { id: X.classroomId },
          gitRepoAssignment: { id: submissionId },
          grade,
          actor,
        });

      expect(await remove(mcpActor(X, 'grade_remove'))).toEqual({
        removed: true,
        audit: { written: 1, missed: 0 },
      });
      expect(await rowsFor(submissionId)).toEqual([
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'GIT_REPO_ASSIGNMENT',
          resource_id: submissionId,
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'grade_remove',
            emoji: '🟡',
            grade_id: grade.id,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
      expect(await remove(webActor(X, 'web:grades.remove'))).toEqual({
        removed: false,
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(submissionId)).toHaveLength(1);
    });

    it('actor null removes the grade and writes nothing', async () => {
      const { submissionId } = await makeSubmission(X);
      const { created } = await addGrade(X, submissionId, '🟡', null);
      const grade = await prisma.assignmentGrade.findUniqueOrThrow({
        where: { id: created!.id },
        include: { token_transaction: true },
      });
      const result = await HelperService.removeGradeFromGitRepoAssignment({
        classroom: { id: X.classroomId },
        gitRepoAssignment: { id: submissionId },
        grade,
        actor: null,
      });
      expect(result).toEqual({ removed: true, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(submissionId)).toHaveLength(0);
    });
  });

  // ─── graders ───────────────────────────────────────────────────────────────

  const ORG = { provider: 'GITHUB', login: 'org' };
  const grader = (
    which: 'add' | 'remove',
    classroom: Fixture,
    submissionId: string,
    graderId: string,
    actor: AuditActor | null
  ) => {
    const payload = {
      classroomId: classroom.classroomId,
      gitOrganization: ORG,
      gitRepoAssignmentId: submissionId,
      graderId,
      notify: false,
      actor,
    };
    const result: Promise<AddGraderInClassroomResult | RemoveGraderInClassroomResult> =
      which === 'add'
        ? HelperService.addGraderInClassroom(payload)
        : HelperService.removeGraderInClassroom(payload);
    return result;
  };

  describe('addGraderInClassroom / removeGraderInClassroom', () => {
    it('records an add and a removal once each, with the grader; repeats record nothing', async () => {
      const { submissionId } = await makeSubmission(X);
      const actor = webActor(X, 'web:graders.add');

      const added = await grader('add', X, submissionId, X.teacherId, actor);
      expect(added).toEqual({
        status: 'added',
        graderLogin: `ta-x-${suite}`,
        audit: { written: 1, missed: 0 },
      });
      expect(await grader('add', X, submissionId, X.teacherId, actor)).toEqual({
        status: 'already_assigned',
        graderLogin: `ta-x-${suite}`,
      });

      const removed = await grader(
        'remove',
        X,
        submissionId,
        X.teacherId,
        mcpActor(X, 'grader_unassign')
      );
      expect(removed).toMatchObject({ status: 'removed', audit: { written: 1, missed: 0 } });
      expect(await grader('remove', X, submissionId, X.teacherId, actor)).toEqual({
        status: 'grader_not_assigned',
      });

      const graderData = {
        value: X.teacherId,
        grader_id: X.teacherId,
        grader_login: `ta-x-${suite}`,
      };
      expect(await rowsFor(submissionId)).toEqual([
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
          resource_id: submissionId,
          action: 'CREATE',
          data: { tool: 'web:graders.add', ...graderData },
        },
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
          resource_id: submissionId,
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'grader_unassign',
            ...graderData,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
    });

    it("classroom X's caller naming Y's submission changes and records nothing in either", async () => {
      const inY = await makeSubmission(Y);
      const result = await grader('add', X, inY.submissionId, X.teacherId, webActor(X, 't'));
      expect(result).toEqual({ status: 'submission_not_found' });
      expect(
        await prisma.gitRepoAssignmentGrader.count({
          where: { git_repo_assignment_id: inY.submissionId },
        })
      ).toBe(0);
      expect(await rowsFor(inY.submissionId)).toHaveLength(0);
    });

    it('user B in Y adds a grader: one row for B in Y, none for A or X', async () => {
      const inY = await makeSubmission(Y);
      await grader('add', Y, inY.submissionId, Y.teacherId, webActor(Y, 'web:graders.add'));
      const rows = await rowsFor(inY.submissionId);
      expect(rows.map(r => [r.user_id, r.classroom_id])).toEqual([[Y.teacherId, Y.classroomId]]);
      expect(
        await prisma.auditLog.count({
          where: { classroom_id: X.classroomId, resource_id: inY.submissionId },
        })
      ).toBe(0);
    });

    it('actor null adds the grader and writes nothing; a failed row is reported missed', async () => {
      const a = await makeSubmission(X);
      expect(await grader('add', X, a.submissionId, X.teacherId, null)).toMatchObject({
        status: 'added',
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(a.submissionId)).toHaveLength(0);

      const b = await makeSubmission(X);
      const { value } = await quietly(() =>
        grader('add', X, b.submissionId, X.teacherId, ghost('web:graders.add'))
      );
      expect(value).toMatchObject({ status: 'added', audit: { written: 0, missed: 1 } });
      expect(
        await prisma.gitRepoAssignmentGrader.count({
          where: { git_repo_assignment_id: b.submissionId },
        })
      ).toBe(1);
    });
  });

  describe('assignGradersToAssignment', () => {
    it('records the queued runs once; an assignment with nothing to queue records nothing', async () => {
      const { assignmentId } = await makeSubmission(X);
      const result = await graderService.assignGradersToAssignment({
        classroomId: X.classroomId,
        assignmentId,
        method: 'RANDOM',
        templateAssignmentId: randomUUID(), // ignored by RANDOM, so not recorded
        actor: webActor(X, 'web:graders.assign_bulk'),
      });
      expect(result).toEqual({ numAssignmentsToAddGradersTo: 1, audit: { written: 1, missed: 0 } });
      expect(trigger.batchTrigger).toHaveBeenCalledTimes(1);
      expect(await rowsFor(assignmentId)).toEqual([
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
          resource_id: assignmentId,
          action: 'CREATE',
          data: {
            tool: 'web:graders.assign_bulk',
            assignment_id: assignmentId,
            method: 'RANDOM',
            template_assignment_id: null,
            submissions_assigned: 1,
          },
        },
      ]);

      // Y's assignment, asked for in X: nothing of it is found, nothing queued.
      const inY = await makeSubmission(Y);
      const none = await graderService.assignGradersToAssignment({
        classroomId: X.classroomId,
        assignmentId: inY.assignmentId,
        method: 'RANDOM',
        actor: webActor(X, 'web:graders.assign_bulk'),
      });
      expect(none).toEqual({ numAssignmentsToAddGradersTo: 0, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(inY.assignmentId)).toHaveLength(0);
    });
  });

  // ─── late override ─────────────────────────────────────────────────────────

  describe('late override', () => {
    it('setLateOverrideForSubmission records a change once, with the previous value', async () => {
      const { submissionId } = await makeSubmission(X);
      const set = (value: boolean, actor: AuditActor | null) =>
        gitRepoAssignmentService.setLateOverrideForSubmission({
          classroomId: X.classroomId,
          gitRepoAssignmentId: submissionId,
          isLateOverride: value,
          actor,
        });

      expect(await set(true, webActor(X, 'web:grades.late_override'))).toEqual({
        changed: true,
        audit: { written: 1, missed: 0 },
      });
      expect(await set(true, webActor(X, 'web:grades.late_override'))).toEqual({
        changed: false,
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(submissionId)).toEqual([
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'GIT_REPO_ASSIGNMENT',
          resource_id: submissionId,
          action: 'UPDATE',
          data: {
            tool: 'web:grades.late_override',
            field: 'is_late_override',
            value: true,
            mode: 'single',
            previous: false,
          },
        },
      ]);
      expect(await set(false, null)).toEqual({ changed: true, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(submissionId)).toHaveLength(1);
    });

    it("another classroom's submission is not written and not recorded", async () => {
      const inY = await makeSubmission(Y);
      const result = await gitRepoAssignmentService.setLateOverrideForSubmission({
        classroomId: X.classroomId,
        gitRepoAssignmentId: inY.submissionId,
        isLateOverride: true,
        actor: webActor(X, 'web:grades.late_override'),
      });
      expect(result.changed).toBe(false);
      expect(await rowsFor(inY.submissionId)).toHaveLength(0);
    });

    it('setLateOverrideInClassroom writes one row per changed submission for the MCP actor', async () => {
      const a = await makeSubmission(X);
      const result = await gitRepoAssignmentService.setLateOverrideInClassroom({
        classroomId: X.classroomId,
        selector: { assignmentId: a.assignmentId },
        isLateOverride: true,
        actor: mcpActor(X, 'submission_late_override'),
        mode: 'assignment',
      });
      expect(result).toMatchObject({
        updatedIds: [a.submissionId],
        auditFailedIds: [],
        audit: { written: 1, missed: 0 },
      });
      expect((await rowsFor(a.submissionId))[0].data).toEqual({
        via: 'mcp',
        tool: 'submission_late_override',
        field: 'is_late_override',
        value: true,
        mode: 'assignment',
        assignment_id: a.assignmentId,
        previous: false,
        client_id: 'client-1',
        impersonated_by: ADMIN,
      });

      const { value: failed } = await quietly(() =>
        gitRepoAssignmentService.setLateOverrideInClassroom({
          classroomId: X.classroomId,
          selector: { ids: [a.submissionId] },
          isLateOverride: false,
          actor: ghost('submission_late_override'),
        })
      );
      expect(failed).toMatchObject({
        updatedIds: [a.submissionId],
        auditFailedIds: [a.submissionId],
        audit: { written: 0, missed: 1 },
      });
    });
  });

  // ─── grade release ─────────────────────────────────────────────────────────

  describe('setGradesReleased', () => {
    it('records a flip once, in assignment_update’s shape with the previous value', async () => {
      const { assignmentId } = await makeSubmission(X);
      const release = (released: boolean, actor: AuditActor | null) =>
        assignmentService.setGradesReleased({
          assignmentId,
          classroomId: X.classroomId,
          released,
          actor,
        });

      expect(await release(true, webActor(X, 'web:grades.release'))).toEqual({
        changed: true,
        audit: { written: 1, missed: 0 },
      });
      expect(await release(true, webActor(X, 'web:grades.release'))).toEqual({
        changed: false,
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(assignmentId)).toEqual([
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'ASSIGNMENT',
          resource_id: assignmentId,
          action: 'UPDATE',
          data: {
            tool: 'web:grades.release',
            fields: ['grades_released'],
            values: { grades_released: true },
            value: '{"grades_released":true}',
            previous: { grades_released: false },
          },
        },
      ]);
      expect(await release(false, null)).toEqual({
        changed: true,
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(assignmentId)).toHaveLength(1);
    });
  });

  // ─── submission delete ─────────────────────────────────────────────────────

  describe('deleteSubmission', () => {
    it('deletes the submission and writes one DELETE row', async () => {
      const { submissionId, assignmentId, gitRepo } = await makeSubmission(X);
      const result = await HelperService.deleteSubmission({
        classroomId: X.classroomId,
        submission: { id: submissionId, assignment_id: assignmentId, git_repo: gitRepo },
        actor: webActor(X, 'web:grades.delete_submission'),
      });
      expect(result).toEqual({ audit: { written: 1, missed: 0 } });
      expect(await prisma.gitRepoAssignment.count({ where: { id: submissionId } })).toBe(0);
      expect(await rowsFor(submissionId)).toEqual([
        {
          user_id: X.teacherId,
          classroom_id: X.classroomId,
          role: 'TEACHER',
          resource_type: 'GIT_REPO_ASSIGNMENT',
          resource_id: submissionId,
          action: 'DELETE',
          data: {
            tool: 'web:grades.delete_submission',
            assignment_id: assignmentId,
            git_repo_id: gitRepo.id,
            repository_deleted: false,
          },
        },
      ]);
    });

    it('with the repository: the repository row goes too, and the row says so', async () => {
      const { submissionId, assignmentId, gitRepo } = await makeSubmission(X);
      await HelperService.deleteSubmission({
        classroomId: X.classroomId,
        submission: { id: submissionId, assignment_id: assignmentId, git_repo: gitRepo },
        repository: { gitOrganization: ORG },
        actor: webActor(X, 'web:grades.delete_submission'),
      });
      expect(await prisma.gitRepo.count({ where: { id: gitRepo.id } })).toBe(0);
      expect((await rowsFor(submissionId))[0].data).toMatchObject({ repository_deleted: true });
    });

    it('actor null deletes and writes nothing', async () => {
      const { submissionId, assignmentId, gitRepo } = await makeSubmission(X);
      expect(
        await HelperService.deleteSubmission({
          classroomId: X.classroomId,
          submission: { id: submissionId, assignment_id: assignmentId, git_repo: gitRepo },
          actor: null,
        })
      ).toEqual({ audit: { written: 0, missed: 0 } });
      expect(await rowsFor(submissionId)).toHaveLength(0);
    });
  });

  // ─── every function, every kind of actor ───────────────────────────────────

  /**
   * One change per function, made on a fresh submission and recorded for
   * `actor`: what the call answered about its rows, and the rows written.
   */
  const CHANGES: Array<{
    name: string;
    run: (actor: AuditActor | null) => Promise<{ audit: { written: number; missed: number } }>;
  }> = [
    {
      name: 'removeGradeFromGitRepoAssignment',
      run: async actor => {
        const { submissionId } = await makeSubmission(X);
        const { created } = await addGrade(X, submissionId, '🟠', null);
        const grade = await prisma.assignmentGrade.findUniqueOrThrow({
          where: { id: created!.id },
          include: { token_transaction: true },
        });
        return HelperService.removeGradeFromGitRepoAssignment({
          classroom: { id: X.classroomId },
          gitRepoAssignment: { id: submissionId },
          grade,
          actor,
        });
      },
    },
    {
      name: 'addGraderInClassroom',
      run: async actor => {
        const { submissionId } = await makeSubmission(X);
        const result = await grader('add', X, submissionId, X.teacherId, actor);
        if (!('audit' in result)) throw new Error(`not added: ${result.status}`);
        return result;
      },
    },
    {
      name: 'removeGraderInClassroom',
      run: async actor => {
        const { submissionId } = await makeSubmission(X);
        await grader('add', X, submissionId, X.teacherId, null);
        const result = await grader('remove', X, submissionId, X.teacherId, actor);
        if (!('audit' in result)) throw new Error(`not removed: ${result.status}`);
        return result;
      },
    },
    {
      name: 'assignGradersToAssignment',
      run: async actor => {
        const { assignmentId } = await makeSubmission(X);
        return graderService.assignGradersToAssignment({
          classroomId: X.classroomId,
          assignmentId,
          method: 'RANDOM',
          actor,
        });
      },
    },
    {
      name: 'setLateOverrideForSubmission',
      run: async actor => {
        const { submissionId } = await makeSubmission(X);
        return gitRepoAssignmentService.setLateOverrideForSubmission({
          classroomId: X.classroomId,
          gitRepoAssignmentId: submissionId,
          isLateOverride: true,
          actor,
        });
      },
    },
    {
      name: 'setGradesReleased',
      run: async actor => {
        const { assignmentId } = await makeSubmission(X);
        return assignmentService.setGradesReleased({
          assignmentId,
          classroomId: X.classroomId,
          released: true,
          actor,
        });
      },
    },
    {
      name: 'deleteSubmission',
      run: async actor => {
        const { submissionId, assignmentId, gitRepo } = await makeSubmission(X);
        return HelperService.deleteSubmission({
          classroomId: X.classroomId,
          submission: { id: submissionId, assignment_id: assignmentId, git_repo: gitRepo },
          actor,
        });
      },
    },
  ];

  /**
   * The rows `fn` writes in X: X's rows after it that were not there before
   * (by id, so no clock is compared).
   */
  const rowsWrittenBy = async <T>(fn: () => Promise<T>) => {
    const rowsOfX = () =>
      prisma.auditLog.findMany({
        where: { classroom_id: X.classroomId },
        orderBy: { timestamp: 'asc' },
        select: { id: true, user_id: true, role: true, data: true },
      });
    const before = new Set((await rowsOfX()).map(r => r.id));
    const value = await fn();
    return { value, rows: (await rowsOfX()).filter(r => !before.has(r.id)) };
  };

  describe.each(CHANGES)('$name', ({ run }) => {
    it('a web actor: one row with its user, role and tool, nothing more', async () => {
      const { value, rows } = await rowsWrittenBy(() => run(webActor(X, 'web:test')));
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: X.teacherId, role: 'TEACHER' });
      expect(rows[0].data).toMatchObject({ tool: 'web:test' });
      for (const key of ['via', 'client_id', 'impersonated_by']) {
        expect(rows[0].data).not.toHaveProperty(key);
      }
    });

    it('an MCP actor under View as: via, client and the admin', async () => {
      const { rows } = await rowsWrittenBy(() => run(mcpActor(X, 'mcp_test')));
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toMatchObject({
        tool: 'mcp_test',
        via: 'mcp',
        client_id: 'client-1',
        impersonated_by: ADMIN,
      });
    });

    it('actor null: no row and no throw', async () => {
      const { value, rows } = await rowsWrittenBy(() => run(null));
      expect(value.audit).toEqual({ written: 0, missed: 0 });
      expect(rows).toHaveLength(0);
    });

    it('a row that cannot be written: the change stands, the call reports the miss', async () => {
      const { value, rows } = await rowsWrittenBy(() => quietly(() => run(ghost('web:test'))));
      expect(value.value.audit).toEqual({ written: 0, missed: 1 });
      expect(value.misses).toHaveLength(1);
      expect(rows).toHaveLength(0);
    });
  });
});
