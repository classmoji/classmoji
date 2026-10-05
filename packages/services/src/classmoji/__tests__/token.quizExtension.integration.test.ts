/**
 * Quiz extension hours against a REAL Postgres: the purchase, its refund, and
 * what the hours do to a student's quiz lateness.
 *
 *   - A purchase before the due date and one after a late completion each
 *     write one PURCHASE row linked to the assignment, priced from the quiz
 *     or the classroom, and move the student's effective due date.
 *   - Refused at a price of 0, with no due date, for a non-student, for
 *     another classroom's quiz, and while quizzes are hidden.
 *   - A refund happens once, carries the link and takes the hours back.
 *   - Deleting the assignment keeps every ledger row (the link goes null) and
 *     the balance.
 *   - A row cannot name a submission and an assignment at once.
 *
 * Whether quizzes are shown (Pro, the AI agent configured) is not what this
 * file tests, so that one lookup is faked; everything else is the database.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classrooms, modules,
 * quizzes, assignments and token transactions) and the users. Nothing is
 * truncated and no pre-existing row is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * token.ledgerOrder.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import { countingQuizScore, effectiveDeadline } from '@classmoji/utils';

const visible = vi.hoisted(() => ({ value: true }));
vi.mock('../entitlement.service.ts', () => ({
  quizzesVisibleOrThrow: async () => visible.value,
}));

const tokenService = await import('../token.service.ts');
const { netQuizExtensionHours } = await import('../quizGradeItems.service.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const HOUR_MS = 3_600_000;

describe.skipIf(!RUN)('quiz extension hours (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  let otherClassroomId: string;
  let moduleId: string;
  const userIds: string[] = [];

  const makeUser = async (role: 'STUDENT' | 'ASSISTANT', inClassroom = classroomId) => {
    const user = await prisma.user.create({
      data: { email: `quizext-${randomUUID().slice(0, 8)}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    await prisma.classroomMembership.create({
      data: { classroom_id: inClassroom, user_id: user.id, role, has_accepted_invite: true },
    });
    return user.id;
  };
  const makeStudent = () => makeUser('STUDENT');

  const makeQuiz = async (
    over: { deadline?: Date | null; tokensPerHour?: number | null; module?: string } = {}
  ) => {
    const moduleRow = over.module ?? moduleId;
    const owner = await prisma.module.findUniqueOrThrow({ where: { id: moduleRow } });
    const title = `Quiz ${randomUUID().slice(0, 6)}`;
    const quiz = await prisma.quiz.create({
      data: { classroom_id: owner.classroom_id, name: title, rubric_prompt: 'r' },
    });
    return prisma.assignment.create({
      data: {
        module_id: moduleRow,
        type: 'QUIZ',
        quiz_id: quiz.id,
        title,
        weight: 10,
        is_published: true,
        student_deadline:
          over.deadline === undefined ? new Date(Date.now() + 24 * HOUR_MS) : over.deadline,
        tokens_per_hour: over.tokensPerHour ?? null,
      },
    });
  };

  const grant = (studentId: string, amount: number) =>
    tokenService.assignToStudent({ classroomId, studentId, amount, type: 'GAIN' });

  const buy = (studentId: string, assignmentId: string, hours: number, inClassroom = classroomId) =>
    tokenService.purchaseQuizExtensionHours({
      classroomId: inClassroom,
      studentId,
      assignmentId,
      hours,
    });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `quizext-${suite}`,
        login: `quizext-org-${suite}`,
      },
    });
    orgId = org.id;
    const makeClassroom = async (tag: string) => {
      const classroom = await prisma.classroom.create({
        data: {
          slug: `quizext-${tag}-${suite}`,
          git_org_id: orgId,
          name: `Quiz Ext ${tag} ${suite}`,
          content_namespace: `quizext-${tag}-${suite}`,
          content_repo: `content-quizext-${tag}-${suite}`,
        },
      });
      await prisma.classroomSettings.create({
        data: { classroom_id: classroom.id, default_tokens_per_hour: 2 },
      });
      return classroom.id;
    };
    classroomId = await makeClassroom('a');
    otherClassroomId = await makeClassroom('b');
    moduleId = (
      await prisma.module.create({ data: { classroom_id: classroomId, title: 'Week 1' } })
    ).id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  });

  beforeEach(() => {
    visible.value = true;
  });

  it("sells hours before the due date at the classroom's price and moves that student's due date", async () => {
    const student = await makeStudent();
    await grant(student, 20);
    const assignment = await makeQuiz();

    const row = await buy(student, assignment.id, 3);

    expect(row).toMatchObject({
      type: 'PURCHASE',
      assignment_id: assignment.id,
      git_repo_assignment_id: null,
      amount: -6,
      hours_purchased: 3,
      balance_after: 14,
      description: `${assignment.title} · +3 h`,
    });
    const hours = await netQuizExtensionHours({ classroomId, studentId: student });
    expect(hours.get(assignment.id)).toBe(3);
    expect(
      effectiveDeadline(assignment.student_deadline, hours.get(assignment.id))!.getTime()
    ).toBe(assignment.student_deadline!.getTime() + 3 * HOUR_MS);
  });

  it("sells hours after a late completion at the quiz's own price, and they clear the lateness", async () => {
    const student = await makeStudent();
    await grant(student, 50);
    const deadline = new Date(Date.now() - 10 * HOUR_MS);
    const assignment = await makeQuiz({ deadline, tokensPerHour: 3 });
    const attempt = await prisma.quizAttempt.create({
      data: {
        quiz_id: assignment.quiz_id!,
        user_id: student,
        started_at: new Date(deadline.getTime() + 4 * HOUR_MS),
        completed_at: new Date(deadline.getTime() + 5 * HOUR_MS + 20 * 60_000),
        partial_credit_percentage: 80,
      },
    });
    const score = (extensionHours: number) =>
      countingQuizScore([attempt], 'HIGHEST', {
        studentDeadline: deadline,
        extensionHours,
        latePenaltyPerHour: 2,
      });
    expect(score(0)).toMatchObject({ late_hours: 5, grade: 70, raw_percentage: 80 });

    const row = await buy(student, assignment.id, 5);
    expect(row).toMatchObject({ amount: -15, balance_after: 35, hours_purchased: 5 });

    const hours = await netQuizExtensionHours({ classroomId, studentId: student });
    expect(score(hours.get(assignment.id) ?? 0)).toMatchObject({ late_hours: 0, grade: 80 });
  });

  it('refuses at a price of 0, with no due date, for a non-student, cross-classroom and while quizzes are hidden', async () => {
    const student = await makeStudent();
    await grant(student, 50);

    const free = await makeQuiz({ tokensPerHour: 0 });
    await expect(buy(student, free.id, 1)).rejects.toThrow('Token cost not configured');

    const undated = await makeQuiz({ deadline: null });
    await expect(buy(student, undated.id, 1)).rejects.toThrow('no deadline');

    const open = await makeQuiz();
    const assistant = await makeUser('ASSISTANT');
    await grant(assistant, 50);
    await expect(buy(assistant, open.id, 1)).rejects.toThrow('only students');

    // The payer's classroom is not the quiz's.
    const outsider = await makeUser('STUDENT', otherClassroomId);
    await expect(buy(outsider, open.id, 1, otherClassroomId)).rejects.toThrow(
      'Quiz assignment not found.'
    );

    visible.value = false;
    await expect(buy(student, open.id, 1)).rejects.toThrow('Quiz assignment not found.');

    expect(await tokenService.getBalance(classroomId, student)).toBe(50);
    const rows = await prisma.tokenTransaction.findMany({
      where: { student_id: { in: [student, assistant, outsider] }, type: 'PURCHASE' },
    });
    expect(rows).toEqual([]);
  });

  it('refunds once, keeping the link, the title and taking the hours back', async () => {
    const student = await makeStudent();
    await grant(student, 20);
    const assignment = await makeQuiz();
    const purchase = await buy(student, assignment.id, 4);

    const refund = await tokenService.cancelPurchase(purchase.id);
    expect(refund).toMatchObject({
      type: 'REFUND',
      amount: 8,
      hours_purchased: -4,
      balance_after: 20,
      assignment_id: assignment.id,
      description: `${assignment.title} · −4 h`,
    });
    await expect(tokenService.cancelPurchase(purchase.id)).rejects.toThrow('not already cancelled');

    expect(await tokenService.getBalance(classroomId, student)).toBe(20);
    const hours = await netQuizExtensionHours({ classroomId, studentId: student });
    expect(hours.get(assignment.id)).toBe(0);
  });

  it('keeps the ledger and the balance when the assignment is deleted', async () => {
    const student = await makeStudent();
    await grant(student, 20);
    const assignment = await makeQuiz();
    const purchase = await buy(student, assignment.id, 2);

    await prisma.assignment.delete({ where: { id: assignment.id } });

    const kept = await prisma.tokenTransaction.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(kept.assignment_id).toBeNull();
    expect(kept.description).toBe(`${assignment.title} · +2 h`);
    expect(await tokenService.getBalance(classroomId, student)).toBe(16);

    // The log still names it, and a refund still reads it.
    const [listed] = await tokenService.findTransactions({ id: purchase.id });
    expect(listed.assignment).toBeNull();
    const refund = await tokenService.cancelPurchase(purchase.id);
    expect(refund.description).toBe(`${assignment.title} · −2 h`);
    expect(await tokenService.getBalance(classroomId, student)).toBe(20);
  });

  it('refuses a row that names both a submission and an assignment', async () => {
    const student = await makeStudent();
    const assignment = await makeQuiz();
    await expect(
      prisma.$executeRaw`
        INSERT INTO token_transactions
          (id, classroom_id, student_id, git_repo_assignment_id, assignment_id, amount, type, balance_after)
        VALUES
          (${randomUUID()}, ${classroomId}, ${student}, ${randomUUID()}, ${assignment.id}, 0, 'GAIN', 0)`
    ).rejects.toThrow(/token_transactions_one_target/);
  });
});
