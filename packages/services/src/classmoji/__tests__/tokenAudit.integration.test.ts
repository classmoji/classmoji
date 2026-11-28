/**
 * The token services, and a repo regrade request, write the audit row of each
 * change they make, against a REAL Postgres: one row with exactly the actor's
 * fields (a web actor, and an MCP one under View as), written after the
 * change and next to the ledger rows and balance the change left (the same as
 * before the row existed); none when the call was refused or found nothing to
 * change; none and no throw for `actor: null`; and a saved change that
 * reports `missed` when its row could not be written (an actor with no user
 * row, which the `audit_logs.user_id` foreign key refuses). Rows are scoped to
 * the classroom the change was made in and to its actor: user A in classroom
 * X and user B in classroom Y never see each other's rows or tokens.
 *
 * Covers token.grantTokens, purchaseExtensionHours,
 * purchaseQuizExtensionHours, cancelPurchase and regradeRequest.create.
 *
 * Whether quizzes are shown (Pro, the quiz runtime configured) is not what
 * this file tests, so that one lookup is faked; everything else is the
 * database. SAFETY: fixtures are namespaced with a fresh uuid and torn down in
 * afterAll (deleting the git organization cascades classrooms, memberships,
 * submissions, ledger rows and audit rows). Skipped unless DATABASE_URL names
 * a LOCAL, non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import type { AuditActor } from '../audit.service.ts';

vi.mock('../entitlement.service.ts', () => ({ quizzesVisibleOrThrow: async () => true }));

const token = await import('../token.service.ts');
const regradeRequest = await import('../regradeRequest.service.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const HOUR_MS = 3_600_000;

describe.skipIf(!RUN)('token services write their audit rows (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  interface Fixture {
    label: string;
    classroomId: string;
    moduleId: string;
    ownerId: string;
  }
  let X: Fixture;
  let Y: Fixture;

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `tokenaudit-${label}-${++serial}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string): Promise<Fixture> => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `tokenaudit-${label}-${suite}`,
        git_org_id: orgId,
        name: `Token audit ${label} ${suite}`,
        content_namespace: `tokenaudit-${label}-${suite}`,
        content_repo: `content-tokenaudit-${label}-${suite}`,
      },
      select: { id: true },
    });
    await prisma.classroomSettings.create({
      data: { classroom_id: classroom.id, default_tokens_per_hour: 2 },
    });
    const module = await prisma.module.create({
      data: { classroom_id: classroom.id, title: `Module ${label}` },
      select: { id: true },
    });
    const ownerId = await makeUser(`owner-${label}`);
    await prisma.classroomMembership.create({
      data: {
        classroom_id: classroom.id,
        user_id: ownerId,
        role: 'OWNER',
        has_accepted_invite: true,
      },
    });
    return { label, classroomId: classroom.id, moduleId: module.id, ownerId };
  };

  const makeStudent = async (f: Fixture) => {
    const userId = await makeUser(`student-${f.label}`);
    await prisma.classroomMembership.create({
      data: {
        classroom_id: f.classroomId,
        user_id: userId,
        role: 'STUDENT',
        has_accepted_invite: true,
      },
    });
    return userId;
  };

  /** A submission of `studentId` in `f` (ISSUE mode), with a deadline. */
  const makeSubmission = async (f: Fixture, studentId: string) => {
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
        student_deadline: new Date(Date.now() + 24 * HOUR_MS),
        tokens_per_hour: 3,
      },
      select: { id: true },
    });
    const gitRepo = await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `tokenaudit-${n}-${suite}`,
        name: `lab-${n}-${suite}`,
        classroom_id: f.classroomId,
        repository_id: repository.id,
        student_id: studentId,
      },
      select: { id: true },
    });
    const submission = await prisma.gitRepoAssignment.create({
      data: { provider: 'GITHUB', git_repo_id: gitRepo.id, assignment_id: assignment.id },
      select: { id: true },
    });
    return submission.id;
  };

  /** A published quiz assignment of `f`, open now, due tomorrow, at the classroom's price. */
  const makeQuiz = async (f: Fixture) => {
    const title = `Quiz ${++serial}`;
    const quiz = await prisma.quiz.create({
      data: { classroom_id: f.classroomId, name: title, rubric_prompt: 'r' },
    });
    return prisma.assignment.create({
      data: {
        module_id: f.moduleId,
        type: 'QUIZ',
        quiz_id: quiz.id,
        title,
        is_published: true,
        student_deadline: new Date(Date.now() + 24 * HOUR_MS),
      },
      select: { id: true },
    });
  };

  const SELECT = {
    user_id: true,
    classroom_id: true,
    role: true,
    resource_type: true,
    resource_id: true,
    action: true,
    data: true,
  } as const;
  const rowsFor = (resourceId: string) =>
    prisma.auditLog.findMany({
      where: { resource_id: resourceId },
      orderBy: { timestamp: 'asc' },
      select: SELECT,
    });
  const rowsIn = (classroomId: string) =>
    prisma.auditLog.findMany({ where: { classroom_id: classroomId }, select: SELECT });
  /** A student's ledger in a classroom, oldest first. */
  const ledger = (f: Fixture, studentId: string) =>
    prisma.tokenTransaction.findMany({
      where: { classroom_id: f.classroomId, student_id: studentId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        type: true,
        amount: true,
        balance_after: true,
        hours_purchased: true,
        is_cancelled: true,
        description: true,
      },
    });

  const webActor = (userId: string, role: AuditActor['role'], tool: string): AuditActor => ({
    userId,
    role,
    tool,
    impersonatedBy: null,
  });
  const ADMIN = randomUUID();
  const mcpActor = (userId: string, role: AuditActor['role'], tool: string): AuditActor => ({
    userId,
    role,
    tool,
    impersonatedBy: ADMIN,
    clientId: 'client-1',
    via: 'mcp',
  });
  /** An actor whose user row does not exist: the foreign key refuses its row. */
  const ghost = (role: AuditActor['role'], tool: string): AuditActor => ({
    userId: randomUUID(),
    role,
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

  /** Seed a balance the way staff do, recording nothing. */
  const seed = (f: Fixture, studentId: string, amount: number) =>
    token.grantTokens({ classroomId: f.classroomId, studentId, amount, actor: null });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `tokenaudit-${suite}`, login: `ta-${suite}` },
    });
    orgId = org.id;
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });

  // ─── grants ────────────────────────────────────────────────────────────────

  describe('token.grantTokens', () => {
    it('writes one row with exactly the web actor’s fields, beside the ledger row it adds', async () => {
      const student = await makeStudent(X);
      await seed(X, student, 4);

      const result = await token.grantTokens({
        classroomId: X.classroomId,
        studentId: student,
        amount: 5,
        description: 'Lab bonus for Ada',
        actor: webActor(X.ownerId, 'OWNER', 'web:tokens.grant'),
      });

      expect(result.audit).toEqual({ written: 1, missed: 0 });
      expect(result.transaction).toMatchObject({
        type: 'GAIN',
        amount: 5,
        balance_after: 9,
        description: 'Lab bonus for Ada',
      });
      expect(await token.getBalance(X.classroomId, student)).toBe(9);
      expect(await ledger(X, student)).toEqual([
        expect.objectContaining({ type: 'GAIN', amount: 4, balance_after: 4, description: '' }),
        expect.objectContaining({ type: 'GAIN', amount: 5, balance_after: 9 }),
      ]);
      // Ids and the amount only: never the description.
      expect(await rowsFor(result.transaction.id)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TOKEN_GRANT',
          resource_id: result.transaction.id,
          action: 'CREATE',
          data: { tool: 'web:tokens.grant', student_id: student, amount: 5 },
        },
      ]);
    });

    it('an MCP actor under View as: the row token_grant wrote, plus the admin', async () => {
      const student = await makeStudent(X);
      const { transaction } = await token.grantTokens({
        classroomId: X.classroomId,
        studentId: student,
        amount: 3,
        actor: mcpActor(X.ownerId, 'OWNER', 'token_grant'),
      });
      expect(await rowsFor(transaction.id)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TOKEN_GRANT',
          resource_id: transaction.id,
          action: 'CREATE',
          data: {
            via: 'mcp',
            tool: 'token_grant',
            student_id: student,
            amount: 3,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
    });

    it('writes no row for actor: null, and grants all the same', async () => {
      const student = await makeStudent(X);
      const result = await token.grantTokens({
        classroomId: X.classroomId,
        studentId: student,
        amount: 2,
        actor: null,
      });
      expect(result.audit).toEqual({ written: 0, missed: 0 });
      expect(await rowsFor(result.transaction.id)).toEqual([]);
      expect(await token.getBalance(X.classroomId, student)).toBe(2);
    });

    it('keeps the grant and reports missed when the row cannot be written', async () => {
      const student = await makeStudent(X);
      const { value, misses } = await quietly(() =>
        token.grantTokens({
          classroomId: X.classroomId,
          studentId: student,
          amount: 7,
          actor: ghost('OWNER', 'token_grant'),
        })
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(await token.getBalance(X.classroomId, student)).toBe(7);
      expect(await rowsFor(value.transaction.id)).toEqual([]);
    });

    it('owner A in X and owner B in Y: each grant lands in its own classroom and log', async () => {
      const a = await makeStudent(X);
      const b = await makeStudent(Y);
      const inX = await token.grantTokens({
        classroomId: X.classroomId,
        studentId: a,
        amount: 1,
        actor: webActor(X.ownerId, 'OWNER', 'web:tokens.grant'),
      });
      const inY = await token.grantTokens({
        classroomId: Y.classroomId,
        studentId: b,
        amount: 2,
        actor: webActor(Y.ownerId, 'OWNER', 'web:tokens.grant'),
      });

      const xRows = await rowsIn(X.classroomId);
      const yRows = await rowsIn(Y.classroomId);
      expect(xRows.map(r => r.resource_id)).toContain(inX.transaction.id);
      expect(xRows.map(r => r.resource_id)).not.toContain(inY.transaction.id);
      expect(yRows.map(r => r.resource_id)).toContain(inY.transaction.id);
      expect(yRows.map(r => r.resource_id)).not.toContain(inX.transaction.id);
      expect(xRows.every(r => r.user_id !== Y.ownerId)).toBe(true);
      expect(yRows.every(r => r.user_id !== X.ownerId)).toBe(true);
      expect(await token.getBalance(Y.classroomId, a)).toBe(0);
      expect(await token.getBalance(X.classroomId, b)).toBe(0);
    });
  });

  // ─── repo purchases ────────────────────────────────────────────────────────

  describe('token.purchaseExtensionHours', () => {
    it('the student as their own actor: one row, the same ledger row and balance as before', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);
      await seed(X, student, 20);

      const result = await token.purchaseExtensionHours({
        classroomId: X.classroomId,
        studentId: student,
        gitRepoAssignmentId: submission,
        hours: 2,
        actor: webActor(student, 'STUDENT', 'web:assignments.purchase_extension'),
      });

      expect(result.audit).toEqual({ written: 1, missed: 0 });
      // 3 tokens an hour (the assignment's price), 2 hours.
      expect(result.transaction).toMatchObject({
        type: 'PURCHASE',
        amount: -6,
        hours_purchased: 2,
        balance_after: 14,
        description: 'Purchase of 2 hour(s).',
      });
      expect(await token.getBalance(X.classroomId, student)).toBe(14);
      expect(await rowsFor(result.transaction.id)).toEqual([
        {
          user_id: student,
          classroom_id: X.classroomId,
          role: 'STUDENT',
          resource_type: 'TOKEN_PURCHASE',
          resource_id: result.transaction.id,
          action: 'CREATE',
          data: {
            tool: 'web:assignments.purchase_extension',
            git_repo_assignment_id: submission,
            hours: 2,
            amount: -6,
          },
        },
      ]);
    });

    it('an MCP student under View as: the row extension_purchase wrote, plus the admin', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);
      await seed(X, student, 20);

      const { transaction } = await token.purchaseExtensionHours({
        classroomId: X.classroomId,
        studentId: student,
        gitRepoAssignmentId: submission,
        hours: 1,
        actor: mcpActor(student, 'STUDENT', 'extension_purchase'),
      });
      expect((await rowsFor(transaction.id))[0].data).toEqual({
        via: 'mcp',
        tool: 'extension_purchase',
        git_repo_assignment_id: submission,
        hours: 1,
        amount: -3,
        client_id: 'client-1',
        impersonated_by: ADMIN,
      });
    });

    it('staff buying for a student: the staff member as actor, and whose tokens were spent', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);
      await seed(X, student, 20);

      const { transaction } = await token.purchaseExtensionHours({
        classroomId: X.classroomId,
        studentId: student,
        gitRepoAssignmentId: submission,
        hours: 1,
        actor: webActor(X.ownerId, 'OWNER', 'web:assignments.purchase_extension'),
      });
      expect(await rowsFor(transaction.id)).toEqual([
        expect.objectContaining({
          user_id: X.ownerId,
          role: 'OWNER',
          data: {
            tool: 'web:assignments.purchase_extension',
            git_repo_assignment_id: submission,
            hours: 1,
            amount: -3,
            student_id: student,
          },
        }),
      ]);
      expect(await token.getBalance(X.classroomId, student)).toBe(17);
    });

    it('writes nothing when the purchase is refused, and spends nothing', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);
      await seed(X, student, 2);
      const before = await rowsIn(X.classroomId);

      await expect(
        token.purchaseExtensionHours({
          classroomId: X.classroomId,
          studentId: student,
          gitRepoAssignmentId: submission,
          hours: 1,
          actor: webActor(student, 'STUDENT', 'web:assignments.purchase_extension'),
        })
      ).rejects.toThrow('Insufficient token balance');
      expect(await token.getBalance(X.classroomId, student)).toBe(2);
      expect(await ledger(X, student)).toHaveLength(1);
      expect(await rowsIn(X.classroomId)).toHaveLength(before.length);
    });

    it("refuses classroom Y's submission named in X, or B's submission bought by A, writing nothing", async () => {
      const a = await makeStudent(X);
      const b = await makeStudent(X);
      const inY = await makeStudent(Y);
      const bSubmission = await makeSubmission(X, b);
      const ySubmission = await makeSubmission(Y, inY);
      await seed(X, a, 50);
      const xBefore = (await rowsIn(X.classroomId)).length;
      const yBefore = (await rowsIn(Y.classroomId)).length;

      for (const gitRepoAssignmentId of [bSubmission, ySubmission]) {
        await expect(
          token.purchaseExtensionHours({
            classroomId: X.classroomId,
            studentId: a,
            gitRepoAssignmentId,
            hours: 1,
            actor: webActor(a, 'STUDENT', 'web:assignments.purchase_extension'),
          })
        ).rejects.toThrow('Repository assignment not found.');
      }
      expect(await token.getBalance(X.classroomId, a)).toBe(50);
      expect((await rowsIn(X.classroomId)).length).toBe(xBefore);
      expect((await rowsIn(Y.classroomId)).length).toBe(yBefore);
    });

    it('writes no row for actor: null; keeps the purchase and reports a missed row', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);
      await seed(X, student, 20);

      const quiet = await token.purchaseExtensionHours({
        classroomId: X.classroomId,
        studentId: student,
        gitRepoAssignmentId: submission,
        hours: 1,
        actor: null,
      });
      expect(quiet.audit).toEqual({ written: 0, missed: 0 });
      expect(await rowsFor(quiet.transaction.id)).toEqual([]);

      const { value, misses } = await quietly(() =>
        token.purchaseExtensionHours({
          classroomId: X.classroomId,
          studentId: student,
          gitRepoAssignmentId: submission,
          hours: 1,
          actor: ghost('STUDENT', 'extension_purchase'),
        })
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(await token.getBalance(X.classroomId, student)).toBe(14);
    });
  });

  // ─── quiz purchases ────────────────────────────────────────────────────────

  describe('token.purchaseQuizExtensionHours', () => {
    it('one row naming the assignment, beside the same ledger row as before', async () => {
      const student = await makeStudent(X);
      const quiz = await makeQuiz(X);
      await seed(X, student, 10);

      const result = await token.purchaseQuizExtensionHours({
        classroomId: X.classroomId,
        studentId: student,
        assignmentId: quiz.id,
        hours: 3,
        actor: mcpActor(student, 'STUDENT', 'extension_purchase'),
      });

      expect(result.audit).toEqual({ written: 1, missed: 0 });
      // The classroom's price: 2 tokens an hour.
      expect(result.transaction).toMatchObject({
        type: 'PURCHASE',
        amount: -6,
        hours_purchased: 3,
        balance_after: 4,
      });
      expect(await token.getBalance(X.classroomId, student)).toBe(4);
      expect(await rowsFor(result.transaction.id)).toEqual([
        {
          user_id: student,
          classroom_id: X.classroomId,
          role: 'STUDENT',
          resource_type: 'TOKEN_PURCHASE',
          resource_id: result.transaction.id,
          action: 'CREATE',
          data: {
            via: 'mcp',
            tool: 'extension_purchase',
            assignment_id: quiz.id,
            hours: 3,
            amount: -6,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
    });

    it("refuses classroom Y's quiz named in X, and a payer who is not a student, writing nothing", async () => {
      const student = await makeStudent(X);
      const yQuiz = await makeQuiz(Y);
      const xQuiz = await makeQuiz(X);
      await seed(X, student, 10);
      const before = (await rowsIn(X.classroomId)).length;

      await expect(
        token.purchaseQuizExtensionHours({
          classroomId: X.classroomId,
          studentId: student,
          assignmentId: yQuiz.id,
          hours: 1,
          actor: webActor(student, 'STUDENT', 'web:assignments.purchase_extension'),
        })
      ).rejects.toThrow('Quiz assignment not found.');
      await expect(
        token.purchaseQuizExtensionHours({
          classroomId: X.classroomId,
          studentId: X.ownerId,
          assignmentId: xQuiz.id,
          hours: 1,
          actor: webActor(X.ownerId, 'OWNER', 'web:assignments.purchase_extension'),
        })
      ).rejects.toThrow('only students buy extension hours');
      expect(await token.getBalance(X.classroomId, student)).toBe(10);
      expect((await rowsIn(X.classroomId)).length).toBe(before);
    });
  });

  // ─── cancels ───────────────────────────────────────────────────────────────

  describe('token.cancelPurchase', () => {
    const buyQuiz = async (f: Fixture, student: string, hours: number) => {
      const quiz = await makeQuiz(f);
      const { transaction } = await token.purchaseQuizExtensionHours({
        classroomId: f.classroomId,
        studentId: student,
        assignmentId: quiz.id,
        hours,
        actor: null,
      });
      return { purchase: transaction, quizId: quiz.id };
    };

    it('one row on the cancelled purchase, beside the same refund and balance as before', async () => {
      const student = await makeStudent(X);
      await seed(X, student, 20);
      const { purchase, quizId } = await buyQuiz(X, student, 4);

      const result = await token.cancelPurchase(purchase.id, {
        actor: webActor(student, 'STUDENT', 'web:tokens.cancel'),
      });

      expect(result.audit).toEqual({ written: 1, missed: 0 });
      expect(result.refund).toMatchObject({
        type: 'REFUND',
        amount: 8,
        hours_purchased: -4,
        balance_after: 20,
        assignment_id: quizId,
      });
      expect(await token.getBalance(X.classroomId, student)).toBe(20);
      expect(await ledger(X, student)).toEqual([
        expect.objectContaining({ type: 'GAIN', balance_after: 20 }),
        expect.objectContaining({ type: 'PURCHASE', balance_after: 12, is_cancelled: true }),
        expect.objectContaining({ type: 'REFUND', amount: 8, balance_after: 20 }),
      ]);
      expect(await rowsFor(purchase.id)).toEqual([
        {
          user_id: student,
          classroom_id: X.classroomId,
          role: 'STUDENT',
          resource_type: 'TOKEN_TRANSACTION',
          resource_id: purchase.id,
          action: 'UPDATE',
          data: {
            tool: 'web:tokens.cancel',
            event: 'purchase_cancelled',
            student_id: student,
            refund_transaction_id: result.refund.id,
            amount: 8,
            hours: -4,
            assignment_id: quizId,
          },
        },
      ]);
    });

    it('a repo purchase cancelled by the owner under View as: the owner, the admin, the submission', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);
      await seed(X, student, 20);
      const { transaction: purchase } = await token.purchaseExtensionHours({
        classroomId: X.classroomId,
        studentId: student,
        gitRepoAssignmentId: submission,
        hours: 2,
        actor: null,
      });

      const { refund } = await token.cancelPurchase(purchase.id, {
        actor: { ...webActor(X.ownerId, 'OWNER', 'web:tokens.cancel'), impersonatedBy: ADMIN },
      });
      expect(await rowsFor(purchase.id)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TOKEN_TRANSACTION',
          resource_id: purchase.id,
          action: 'UPDATE',
          data: {
            tool: 'web:tokens.cancel',
            event: 'purchase_cancelled',
            student_id: student,
            refund_transaction_id: refund.id,
            amount: 6,
            hours: -2,
            git_repo_assignment_id: submission,
            impersonated_by: ADMIN,
          },
        },
      ]);
      expect(await token.getBalance(X.classroomId, student)).toBe(20);
    });

    it('refunds once: a second cancel, or a cancel of a grant, is refused and writes nothing', async () => {
      const student = await makeStudent(X);
      const { transaction: grant } = await seed(X, student, 20);
      const { purchase } = await buyQuiz(X, student, 1);
      await token.cancelPurchase(purchase.id, {
        actor: webActor(student, 'STUDENT', 'web:tokens.cancel'),
      });

      for (const id of [purchase.id, grant.id]) {
        await expect(
          token.cancelPurchase(id, { actor: webActor(X.ownerId, 'OWNER', 'web:tokens.cancel') })
        ).rejects.toThrow('not already cancelled');
      }
      expect(await rowsFor(purchase.id)).toHaveLength(1);
      expect(await rowsFor(grant.id)).toEqual([]);
      expect(await token.getBalance(X.classroomId, student)).toBe(20);
      expect((await ledger(X, student)).filter(r => r.type === 'REFUND')).toHaveLength(1);
    });

    it("cancels in the purchase's own classroom: student B in Y, recorded in Y only", async () => {
      const a = await makeStudent(X);
      const b = await makeStudent(Y);
      await seed(X, a, 10);
      await seed(Y, b, 10);
      const { purchase: inX } = await buyQuiz(X, a, 1);
      const { purchase: inY } = await buyQuiz(Y, b, 1);

      await token.cancelPurchase(inY.id, { actor: webActor(b, 'STUDENT', 'web:tokens.cancel') });

      expect((await rowsIn(Y.classroomId)).map(r => r.resource_id)).toContain(inY.id);
      expect((await rowsIn(X.classroomId)).map(r => r.resource_id)).not.toContain(inY.id);
      expect(await rowsFor(inX.id)).toEqual([]);
      expect(await token.getBalance(X.classroomId, a)).toBe(8);
      expect(await token.getBalance(Y.classroomId, b)).toBe(10);
    });

    it('writes no row for actor: null; keeps the refund and reports a missed row', async () => {
      const student = await makeStudent(X);
      await seed(X, student, 20);
      const { purchase: first } = await buyQuiz(X, student, 1);
      const { purchase: second } = await buyQuiz(X, student, 1);

      const quiet = await token.cancelPurchase(first.id, { actor: null });
      expect(quiet.audit).toEqual({ written: 0, missed: 0 });
      expect(await rowsFor(first.id)).toEqual([]);

      const { value, misses } = await quietly(() =>
        token.cancelPurchase(second.id, { actor: ghost('STUDENT', 'web:tokens.cancel') })
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(value.refund.type).toBe('REFUND');
      expect(await token.getBalance(X.classroomId, student)).toBe(20);
    });
  });

  // ─── repo regrade requests ─────────────────────────────────────────────────

  describe('regradeRequest.create', () => {
    const create = (f: Fixture, student: string, submission: string, actor: AuditActor | null) =>
      regradeRequest.create({
        classroom_id: f.classroomId,
        git_repo_assignment_id: submission,
        student_id: student,
        student_comment: 'Please look at test 3 again',
        previous_grade: ['+1'],
        actor,
      });

    it('one row for the student on the web: the submission, never the comment', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);

      const { request, audit } = await create(
        X,
        student,
        submission,
        webActor(student, 'STUDENT', 'web:regrade_requests.create')
      );

      expect(audit).toEqual({ written: 1, missed: 0 });
      expect(request).toMatchObject({
        status: 'IN_REVIEW',
        classroom_id: X.classroomId,
        git_repo_assignment_id: submission,
        student_id: student,
        previous_grade: ['+1'],
      });
      expect(await rowsFor(request.id)).toEqual([
        {
          user_id: student,
          classroom_id: X.classroomId,
          role: 'STUDENT',
          resource_type: 'REGRADE_REQUEST',
          resource_id: request.id,
          action: 'CREATE',
          data: { tool: 'web:regrade_requests.create', git_repo_assignment_id: submission },
        },
      ]);
    });

    it('an MCP student under View as: the row regrade_create wrote, plus the admin', async () => {
      const student = await makeStudent(Y);
      const submission = await makeSubmission(Y, student);

      const { request } = await create(
        Y,
        student,
        submission,
        mcpActor(student, 'STUDENT', 'regrade_create')
      );
      expect(await rowsFor(request.id)).toEqual([
        {
          user_id: student,
          classroom_id: Y.classroomId,
          role: 'STUDENT',
          resource_type: 'REGRADE_REQUEST',
          resource_id: request.id,
          action: 'CREATE',
          data: {
            via: 'mcp',
            tool: 'regrade_create',
            git_repo_assignment_id: submission,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
      expect((await rowsIn(X.classroomId)).map(r => r.resource_id)).not.toContain(request.id);
    });

    it('writes no row for actor: null; keeps the request and reports a missed row', async () => {
      const student = await makeStudent(X);
      const submission = await makeSubmission(X, student);

      const quiet = await create(X, student, submission, null);
      expect(quiet.audit).toEqual({ written: 0, missed: 0 });
      expect(await rowsFor(quiet.request.id)).toEqual([]);

      const other = await makeSubmission(X, student);
      const { value, misses } = await quietly(() =>
        create(X, student, other, ghost('STUDENT', 'regrade_create'))
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(
        await prisma.regradeRequest.findUnique({ where: { id: value.request.id } })
      ).not.toBeNull();
    });
  });
});
