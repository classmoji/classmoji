/**
 * Extension hours against a REAL Postgres: the staff late count, the at-risk
 * count, and the re-read of a push-mode submission after a purchase.
 *
 * Hours are bought through token.purchaseExtensionHours, so the rows the
 * readers see are the ones the purchase path writes (a PURCHASE row with
 * positive hours, a REFUND with negative ones), and the selects run through
 * the real Prisma client rather than a stub.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classroom → repos →
 * submissions → token transactions) and the students. Nothing is truncated
 * and no pre-existing row is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * token.ledgerOrder.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as tokenService from '../token.service.ts';
import * as gitRepoAssignmentService from '../gitRepoAssignment.service.ts';
import { cohortOverview } from '../dashboard.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const HOUR = 3_600_000;

describe.skipIf(!RUN)('extension hours and lateness (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  const userIds: string[] = [];
  let classroomCount = 0;

  /** A fresh classroom with one repository container and one module. */
  const makeClassroom = async () => {
    classroomCount += 1;
    const tag = `${suite}-${classroomCount}`;
    const classroom = await prisma.classroom.create({
      data: {
        slug: `exttest-${tag}`,
        git_org_id: orgId,
        name: `Extension Test ${tag}`,
        content_namespace: `exttest-${tag}`,
        content_repo: `content-exttest-${tag}`,
      },
    });
    const mod = await prisma.module.create({
      data: { classroom_id: classroom.id, title: `Module ${tag}`, is_published: true },
    });
    const repository = await prisma.repository.create({
      data: {
        classroom_id: classroom.id,
        title: `lab-${tag}`,
        template: 'org/lab',
        type: 'INDIVIDUAL',
      },
    });
    return { classroom, moduleId: mod.id, repositoryId: repository.id };
  };

  const makeStudent = async (classroomId: string) => {
    const user = await prisma.user.create({
      data: { email: `ext-${randomUUID().slice(0, 8)}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    await prisma.classroomMembership.create({
      data: { classroom_id: classroomId, user_id: user.id, role: 'STUDENT' },
    });
    // Enough tokens for every purchase below.
    await tokenService.assignToStudent({ classroomId, studentId: user.id, amount: 1000 });
    return user.id;
  };

  const makeAssignment = (
    moduleId: string,
    repositoryId: string,
    deadline: Date,
    submissionMode: 'REPO' | 'ISSUE' = 'REPO'
  ) =>
    prisma.assignment.create({
      data: {
        module_id: moduleId,
        type: 'REPO',
        repository_id: repositoryId,
        title: `Lab ${randomUUID().slice(0, 6)}`,
        is_published: true,
        submission_mode: submissionMode,
        student_deadline: deadline,
        tokens_per_hour: 1,
      },
    });

  const makeRepo = (
    classroomId: string,
    repositoryId: string,
    studentId: string,
    lastPushAt: Date | null = null
  ) =>
    prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `exttest-${randomUUID()}`,
        name: `lab-${randomUUID().slice(0, 6)}`,
        classroom_id: classroomId,
        repository_id: repositoryId,
        student_id: studentId,
        last_push_at: lastPushAt,
      },
    });

  const makeSubmission = (gitRepoId: string, assignmentId: string, closedAt: Date | null) =>
    prisma.gitRepoAssignment.create({
      data: {
        provider: 'GITHUB',
        git_repo_id: gitRepoId,
        assignment_id: assignmentId,
        status: closedAt ? 'CLOSED' : 'OPEN',
        closed_at: closedAt,
      },
    });

  const buy = (
    classroomId: string,
    studentId: string,
    gitRepoAssignmentId: string,
    hours: number
  ) => tokenService.purchaseExtensionHours({ classroomId, studentId, gitRepoAssignmentId, hours });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `exttest-${suite}`,
        login: `exttest-org-${suite}`,
      },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  });

  it('counts a submission covered by bought hours as on time, and a refund takes it back', async () => {
    const { classroom, moduleId, repositoryId } = await makeClassroom();
    const deadline = new Date(Date.now() - 3 * 24 * HOUR);
    const assignment = await makeAssignment(moduleId, repositoryId, deadline);
    const alice = await makeStudent(classroom.id);
    const bob = await makeStudent(classroom.id);
    const fiveHoursLate = new Date(deadline.getTime() + 5 * HOUR);
    const aliceRepo = await makeRepo(classroom.id, repositoryId, alice);
    const bobRepo = await makeRepo(classroom.id, repositoryId, bob);
    const aliceSub = await makeSubmission(aliceRepo.id, assignment.id, fiveHoursLate);
    await makeSubmission(bobRepo.id, assignment.id, fiveHoursLate);

    expect(await gitRepoAssignmentService.getLateCount(classroom.slug)).toEqual({
      total: 2,
      late: 2,
    });

    const purchase = await buy(classroom.id, alice, aliceSub.id, 5);
    expect(await gitRepoAssignmentService.getLateCount(classroom.slug)).toEqual({
      total: 2,
      late: 1,
    });
    expect(await gitRepoAssignmentService.getLatePercentage(classroom.slug)).toBe(50);

    await tokenService.cancelPurchase(purchase.id);
    expect(await gitRepoAssignmentService.getLateCount(classroom.slug)).toEqual({
      total: 2,
      late: 2,
    });
  });

  it('leaves a student out of the at-risk count while bought hours cover the work', async () => {
    const { classroom, moduleId, repositoryId } = await makeClassroom();
    const first = await makeAssignment(
      moduleId,
      repositoryId,
      new Date(Date.now() - 3 * 24 * HOUR)
    );
    const second = await makeAssignment(
      moduleId,
      repositoryId,
      new Date(Date.now() - 2 * 24 * HOUR)
    );
    const alice = await makeStudent(classroom.id);
    const bob = await makeStudent(classroom.id);
    const aliceRepo = await makeRepo(classroom.id, repositoryId, alice);
    const bobRepo = await makeRepo(classroom.id, repositoryId, bob);
    await makeSubmission(aliceRepo.id, first.id, null);
    const aliceSecond = await makeSubmission(aliceRepo.id, second.id, null);
    await makeSubmission(bobRepo.id, first.id, null);
    await makeSubmission(bobRepo.id, second.id, null);

    const before = await cohortOverview(classroom.id);
    expect(before.atRiskCount).toBe(2);

    // 72 hours on a deadline two days ago: due tomorrow.
    await buy(classroom.id, alice, aliceSecond.id, 72);
    const after = await cohortOverview(classroom.id);
    expect(after.atRiskCount).toBe(1);
    expect(after.atRiskStudents.map(s => s.userId)).toEqual([bob]);
    expect(after.atRiskSeries[after.atRiskSeries.length - 1]).toBe(1);
  });

  it('stamps a push the bought hours now cover, and only that', async () => {
    const { classroom, moduleId, repositoryId } = await makeClassroom();
    const deadline = new Date(Date.now() - 24 * HOUR);
    const assignment = await makeAssignment(moduleId, repositoryId, deadline);
    const alice = await makeStudent(classroom.id);
    const onTime = new Date(deadline.getTime() - HOUR);
    const latePush = new Date(deadline.getTime() + 2 * HOUR);
    const repo = await makeRepo(classroom.id, repositoryId, alice, latePush);
    const sub = await makeSubmission(repo.id, assignment.id, onTime);

    // One hour does not reach the push.
    await buy(classroom.id, alice, sub.id, 1);
    let row = await prisma.gitRepoAssignment.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.closed_at).toEqual(onTime);

    // Two hours in total do.
    await buy(classroom.id, alice, sub.id, 1);
    row = await prisma.gitRepoAssignment.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.closed_at).toEqual(latePush);
    expect(row.status).toBe('CLOSED');
  });

  it('leaves a graded submission alone when bought hours would cover a later push', async () => {
    const { classroom, moduleId, repositoryId } = await makeClassroom();
    const deadline = new Date(Date.now() - 24 * HOUR);
    const assignment = await makeAssignment(moduleId, repositoryId, deadline);
    const alice = await makeStudent(classroom.id);
    const onTime = new Date(deadline.getTime() - HOUR);
    const latePush = new Date(deadline.getTime() + 2 * HOUR);
    const repo = await makeRepo(classroom.id, repositoryId, alice, latePush);
    const sub = await makeSubmission(repo.id, assignment.id, onTime);
    await prisma.assignmentGrade.create({
      data: { git_repo_assignment_id: sub.id, emoji: 'score-90' },
    });

    await buy(classroom.id, alice, sub.id, 3);

    const row = await prisma.gitRepoAssignment.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.closed_at).toEqual(onTime);
  });

  it('never stamps an issue-mode submission from a push after a purchase', async () => {
    const { classroom, moduleId, repositoryId } = await makeClassroom();
    const deadline = new Date(Date.now() - 24 * HOUR);
    const assignment = await makeAssignment(moduleId, repositoryId, deadline, 'ISSUE');
    const alice = await makeStudent(classroom.id);
    const latePush = new Date(deadline.getTime() + 2 * HOUR);
    const repo = await makeRepo(classroom.id, repositoryId, alice, latePush);
    const sub = await makeSubmission(repo.id, assignment.id, null);

    await buy(classroom.id, alice, sub.id, 3);

    const row = await prisma.gitRepoAssignment.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.closed_at).toBeNull();
    expect(row.status).toBe('OPEN');
  });

  it('recordPush writes only forward in time and never past a grade', async () => {
    const { classroom, moduleId, repositoryId } = await makeClassroom();
    const deadline = new Date(Date.now() + 24 * HOUR);
    const assignment = await makeAssignment(moduleId, repositoryId, deadline);
    const alice = await makeStudent(classroom.id);
    const repo = await makeRepo(classroom.id, repositoryId, alice);
    const sub = await makeSubmission(repo.id, assignment.id, null);
    const earlier = new Date(Date.now() - 2 * HOUR);
    const later = new Date(Date.now() - HOUR);

    expect(await gitRepoAssignmentService.recordPush(repo.id, later)).toEqual([{ id: sub.id }]);
    // An older push delivered afterwards changes nothing.
    expect(await gitRepoAssignmentService.recordPush(repo.id, earlier)).toEqual([]);
    let row = await prisma.gitRepoAssignment.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.closed_at).toEqual(later);

    // Once graded, a newer push changes nothing either.
    await prisma.assignmentGrade.create({
      data: { git_repo_assignment_id: sub.id, emoji: 'score-80' },
    });
    expect(await gitRepoAssignmentService.recordPush(repo.id, new Date())).toEqual([]);
    row = await prisma.gitRepoAssignment.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.closed_at).toEqual(later);
  });
});
