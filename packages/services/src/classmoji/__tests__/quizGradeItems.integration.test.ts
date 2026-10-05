/**
 * Quiz grade items for a classroom, against a REAL Postgres.
 *
 * Pinned here:
 *   - an item per open QUIZ assignment per STUDENT, penalised by the hours
 *     late past the deadline plus the net hours bought (refunds subtract);
 *   - a rostered student with no completed attempt counts 0 once the
 *     deadline has passed; a future deadline, a draft or a not-yet-open quiz
 *     makes no item;
 *   - staff attempts and non-members' attempts never make an item;
 *   - isolation: the same student's attempts and purchases in ANOTHER
 *     classroom, and a purchase row filed under another classroom against
 *     this classroom's assignment, never reach this classroom's items;
 *   - `userIds` narrows to those students; quizzes hidden → no items;
 *   - the token_transactions CHECK (at most one target) and SET NULL on
 *     assignment delete (the row and the balance survive).
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organization (cascades classrooms → modules,
 * quizzes, assignments, attempts, token transactions) and then the users.
 * Nothing is truncated and no pre-existing row is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * token.ledgerOrder.integration.test.ts does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import { loadQuizGradeItems } from '../quizGradeItems.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const H = 60 * 60 * 1000;

describe.skipIf(!RUN)('loadQuizGradeItems (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const now = new Date();
  const deadline = new Date(now.getTime() - 10 * H);
  const userIds: string[] = [];
  let orgId: string;
  let classA: string;
  let classB: string;

  // Users
  let both: string; // STUDENT in A and in B
  let zero: string; // STUDENT in A, never attempts
  let staff: string; // ASSISTANT in A, attempts anyway
  let outsider: string; // STUDENT in B only, attempts A's quiz

  // Assignments in A
  let dueA: string; // deadline passed, published, open
  let futureA: string; // deadline ahead
  let draftA: string; // unpublished
  let notOpenA: string; // release_at ahead, deadline passed
  let dueB: string; // classroom B
  let dueAQuiz: string;
  let draftAQuiz: string;
  let dueBQuiz: string;

  const makeUser = async (tag: string) => {
    const user = await prisma.user.create({
      data: { email: `qgi-${tag}-${suite}@example.test`, name: `QGI ${tag} ${suite}` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (tag: string) =>
    (
      await prisma.classroom.create({
        data: {
          slug: `qgi-${tag}-${suite}`,
          git_org_id: orgId,
          name: `QGI ${tag} ${suite}`,
          content_namespace: `qgi-${tag}-${suite}`,
          content_repo: `content-qgi-${tag}-${suite}`,
        },
        select: { id: true },
      })
    ).id;

  const makeQuizAssignment = async (
    classroomId: string,
    data: {
      title: string;
      is_published?: boolean;
      student_deadline?: Date | null;
      release_at?: Date | null;
      weight?: number;
    }
  ) => {
    const module = await prisma.module.create({
      data: { classroom_id: classroomId, title: `M ${data.title} ${suite}` },
      select: { id: true },
    });
    const quiz = await prisma.quiz.create({
      data: {
        classroom_id: classroomId,
        name: `${data.title} ${suite}`,
        rubric_prompt: 'r',
        grading_strategy: 'HIGHEST',
      },
      select: { id: true },
    });
    const assignment = await prisma.assignment.create({
      data: {
        module_id: module.id,
        type: 'QUIZ',
        quiz_id: quiz.id,
        title: `${data.title} ${suite}`,
        weight: data.weight ?? 10,
        is_published: data.is_published ?? true,
        student_deadline: data.student_deadline === undefined ? deadline : data.student_deadline,
        release_at: data.release_at ?? null,
      },
      select: { id: true },
    });
    return { assignmentId: assignment.id, quizId: quiz.id, moduleId: module.id };
  };

  const completedAttempt = (quizId: string, userId: string, completedAt: Date, pct: number) =>
    prisma.quizAttempt.create({
      data: {
        quiz_id: quizId,
        user_id: userId,
        started_at: new Date(completedAt.getTime() - H),
        completed_at: completedAt,
        partial_credit_percentage: pct,
      },
    });

  const ledgerRow = (
    classroomId: string,
    studentId: string,
    assignmentId: string | null,
    hours: number,
    type: 'PURCHASE' | 'REFUND'
  ) =>
    prisma.tokenTransaction.create({
      data: {
        classroom_id: classroomId,
        student_id: studentId,
        assignment_id: assignmentId,
        amount: type === 'PURCHASE' ? -hours : Math.abs(hours),
        hours_purchased: hours,
        type,
        balance_after: 100,
        description: `qgi ${suite}`,
      },
    });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qgi-${suite}`, login: `qgi-org-${suite}` },
    });
    orgId = org.id;
    classA = await makeClassroom('a');
    classB = await makeClassroom('b');
    await prisma.classroomSettings.create({
      data: { classroom_id: classA, late_penalty_points_per_hour: 2 },
    });
    await prisma.classroomSettings.create({
      data: { classroom_id: classB, late_penalty_points_per_hour: 50 },
    });

    both = await makeUser('both');
    zero = await makeUser('zero');
    staff = await makeUser('staff');
    outsider = await makeUser('outsider');
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classA, user_id: both, role: 'STUDENT' },
        { classroom_id: classB, user_id: both, role: 'STUDENT' },
        { classroom_id: classA, user_id: zero, role: 'STUDENT' },
        { classroom_id: classA, user_id: staff, role: 'ASSISTANT' },
        { classroom_id: classB, user_id: outsider, role: 'STUDENT' },
      ],
    });

    ({ assignmentId: dueA, quizId: dueAQuiz } = await makeQuizAssignment(classA, {
      title: 'Due',
    }));
    ({ assignmentId: futureA } = await makeQuizAssignment(classA, {
      title: 'Future',
      student_deadline: new Date(now.getTime() + 24 * H),
    }));
    ({ assignmentId: draftA, quizId: draftAQuiz } = await makeQuizAssignment(classA, {
      title: 'Draft',
      is_published: false,
    }));
    ({ assignmentId: notOpenA } = await makeQuizAssignment(classA, {
      title: 'Not open',
      release_at: new Date(now.getTime() + 24 * H),
    }));
    ({ assignmentId: dueB, quizId: dueBQuiz } = await makeQuizAssignment(classB, {
      title: 'B',
    }));

    // `both`: 90% on A's quiz, 4.5 h after the deadline.
    await completedAttempt(dueAQuiz, both, new Date(deadline.getTime() + 4.5 * H), 90);
    // Net 2 h bought on it in A: +3, refund −3, +2.
    await ledgerRow(classA, both, dueA, 3, 'PURCHASE');
    await ledgerRow(classA, both, dueA, -3, 'REFUND');
    await ledgerRow(classA, both, dueA, 2, 'PURCHASE');
    // A row filed under classroom B naming A's assignment: not A's ledger.
    await ledgerRow(classB, both, dueA, 40, 'PURCHASE');
    // `both` in B: a perfect score and hours there.
    await completedAttempt(dueBQuiz, both, new Date(deadline.getTime() + 1 * H), 100);
    await ledgerRow(classB, both, dueB, 30, 'PURCHASE');
    // A draft quiz's attempt is no grade.
    await completedAttempt(draftAQuiz, both, new Date(deadline.getTime() - H), 10);

    // Staff and a non-member attempt A's quiz.
    await completedAttempt(dueAQuiz, staff, new Date(deadline.getTime() - H), 50);
    await completedAttempt(dueAQuiz, outsider, new Date(deadline.getTime() - H), 50);
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  it('builds penalised items for the roster, with zeros, and nothing for staff or outsiders', async () => {
    const items = await loadQuizGradeItems({ classroomId: classA, quizzesVisible: true, now });

    expect([...items.keys()].sort()).toEqual([both, zero].sort());

    // 4.5 h late − 2 h bought = 2 h → 90 − 2 × 2 = 86.
    expect(items.get(both)).toEqual([
      expect.objectContaining({
        assignment_id: dueA,
        weight: 10,
        is_extra_credit: false,
        grade: 86,
        raw_grade: 90,
        counts_as_zero: false,
        late_hours: 2,
      }),
    ]);
    expect(items.get(zero)).toEqual([
      expect.objectContaining({ assignment_id: dueA, counts_as_zero: true, grade: 0 }),
    ]);

    const assignmentIds = [...items.values()].flat().map(i => i.assignment_id);
    for (const hidden of [futureA, draftA, notOpenA, dueB]) {
      expect(assignmentIds).not.toContain(hidden);
    }
  });

  it("never reads another classroom's attempts or purchases", async () => {
    const itemsB = await loadQuizGradeItems({ classroomId: classB, quizzesVisible: true, now });
    // In B: 1 h late, 30 h bought there → on time; B's own penalty.
    expect(itemsB.get(both)).toEqual([
      expect.objectContaining({ assignment_id: dueB, grade: 100, late_hours: 0 }),
    ]);
    // The outsider is a B student with no attempt on B's quiz: a zero in B,
    // and their attempt on A's quiz is nowhere.
    expect(itemsB.get(outsider)).toEqual([
      expect.objectContaining({ assignment_id: dueB, counts_as_zero: true }),
    ]);
    expect([...itemsB.values()].flat().map(i => i.assignment_id)).toEqual([dueB, dueB]);
  });

  it('narrows to userIds, still STUDENT members only', async () => {
    const items = await loadQuizGradeItems({
      classroomId: classA,
      quizzesVisible: true,
      userIds: [zero, staff, outsider],
      now,
    });
    expect([...items.keys()]).toEqual([zero]);
    expect(
      (await loadQuizGradeItems({ classroomId: classA, quizzesVisible: true, userIds: [], now }))
        .size
    ).toBe(0);
  });

  it('answers nothing where quizzes are hidden', async () => {
    const items = await loadQuizGradeItems({ classroomId: classA, quizzesVisible: false, now });
    expect(items.size).toBe(0);
  });

  it('refuses a ledger row with two targets', async () => {
    const error = await prisma.$executeRaw`
      INSERT INTO "token_transactions"
        ("id", "classroom_id", "student_id", "git_repo_assignment_id", "assignment_id",
         "amount", "type", "balance_after", "description")
      VALUES (${randomUUID()}, ${classA}, ${zero}, ${randomUUID()}, ${dueA},
              -1, 'PURCHASE', 0, ${`qgi ${suite}`})
    `.then(
      () => null,
      (e: unknown) => e
    );
    expect(String((error as Error | null)?.message ?? '')).toContain(
      'token_transactions_one_target'
    );
  });

  it('keeps the ledger row and the balance when the assignment is deleted', async () => {
    const { assignmentId } = await makeQuizAssignment(classA, { title: 'Doomed' });
    const row = await ledgerRow(classA, zero, assignmentId, 1, 'PURCHASE');

    await prisma.assignment.delete({ where: { id: assignmentId } });

    const after = await prisma.tokenTransaction.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.assignment_id).toBeNull();
    expect(after.balance_after).toBe(row.balance_after);
    expect(after.hours_purchased).toBe(1);
  });
});
