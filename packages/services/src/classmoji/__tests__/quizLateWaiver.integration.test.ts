/**
 * Quiz late waivers against a REAL Postgres.
 *
 * Pinned here:
 *   - set/clear are idempotent (`changed` from the database's own count);
 *   - scoping: an assignment of classroom Y is not found from classroom X,
 *     a REPO assignment is refused, a non-member, a pending student and an
 *     assistant are refused; every read answers for its own classroom only;
 *   - student A's waiver never applies to student B;
 *   - loadQuizGradeItems: a waived late attempt counts unpenalised, a waived
 *     student with no attempt is not a counted 0 (D1); clearing restores both;
 *   - the waiver row goes with its assignment (cascade).
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organization (cascades classrooms → modules,
 * quizzes, assignments, attempts, waivers) and then the users. Skipped unless
 * DATABASE_URL names a LOCAL, non-shared database, as
 * quizGradeItems.integration.test.ts is.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import { loadQuizGradeItems } from '../quizGradeItems.service.ts';
import {
  setQuizLateWaiver,
  waivedAssignmentIdsForStudent,
  waivedByStudent,
  waivedStudentIdsForAssignment,
} from '../quizLateWaiver.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const H = 60 * 60 * 1000;

describe.skipIf(!RUN)('quizLateWaiver (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const now = new Date();
  const deadline = new Date(now.getTime() - 200 * H);
  const userIds: string[] = [];
  let orgId: string;
  let classX: string;
  let classY: string;
  let teacher: string;
  let late: string; // STUDENT in X, 🔥 attempt 108 h late
  let absent: string; // STUDENT in X, never attempts
  let other: string; // STUDENT in X, 108 h late, no waiver
  let pending: string; // STUDENT in X, invite not accepted
  let assistant: string; // ASSISTANT in X
  let outsider: string; // STUDENT in Y only
  let quizX: string;
  let quizXQuiz: string;
  let repoX: string;
  let quizY: string;

  const makeUser = async (tag: string) => {
    const user = await prisma.user.create({
      data: { email: `qlw-${tag}-${suite}@example.test`, name: `QLW ${tag} ${suite}` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (tag: string) =>
    (
      await prisma.classroom.create({
        data: {
          slug: `qlw-${tag}-${suite}`,
          git_org_id: orgId,
          name: `QLW ${tag} ${suite}`,
          content_namespace: `qlw-${tag}-${suite}`,
          content_repo: `content-qlw-${tag}-${suite}`,
        },
        select: { id: true },
      })
    ).id;

  const makeQuizAssignment = async (classroomId: string, title: string) => {
    const module = await prisma.module.create({
      data: { classroom_id: classroomId, title: `M ${title} ${suite}` },
      select: { id: true },
    });
    const quiz = await prisma.quiz.create({
      data: {
        classroom_id: classroomId,
        name: `${title} ${suite}`,
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
        title: `${title} ${suite}`,
        weight: 10,
        is_published: true,
        student_deadline: deadline,
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

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qlw-${suite}`, login: `qlw-org-${suite}` },
    });
    orgId = org.id;
    classX = await makeClassroom('x');
    classY = await makeClassroom('y');
    await prisma.classroomSettings.create({
      data: { classroom_id: classX, late_penalty_points_per_hour: 0.5 },
    });

    teacher = await makeUser('teacher');
    late = await makeUser('late');
    absent = await makeUser('absent');
    other = await makeUser('other');
    pending = await makeUser('pending');
    assistant = await makeUser('assistant');
    outsider = await makeUser('outsider');
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classX, user_id: teacher, role: 'TEACHER', has_accepted_invite: true },
        { classroom_id: classX, user_id: late, role: 'STUDENT', has_accepted_invite: true },
        { classroom_id: classX, user_id: absent, role: 'STUDENT', has_accepted_invite: true },
        { classroom_id: classX, user_id: other, role: 'STUDENT', has_accepted_invite: true },
        { classroom_id: classX, user_id: pending, role: 'STUDENT', has_accepted_invite: false },
        {
          classroom_id: classX,
          user_id: assistant,
          role: 'ASSISTANT',
          has_accepted_invite: true,
        },
        { classroom_id: classY, user_id: outsider, role: 'STUDENT', has_accepted_invite: true },
        // `late` is a student in Y too: a waiver in X must not reach Y.
        { classroom_id: classY, user_id: late, role: 'STUDENT', has_accepted_invite: true },
      ],
    });

    let moduleX: string;
    ({
      assignmentId: quizX,
      quizId: quizXQuiz,
      moduleId: moduleX,
    } = await makeQuizAssignment(classX, 'Quiz X'));
    ({ assignmentId: quizY } = await makeQuizAssignment(classY, 'Quiz Y'));
    const repository = await prisma.repository.create({
      data: { classroom_id: classX, title: `Repo ${suite}`, template: 'tpl', type: 'INDIVIDUAL' },
      select: { id: true },
    });
    repoX = (
      await prisma.assignment.create({
        data: {
          module_id: moduleX,
          type: 'REPO',
          repository_id: repository.id,
          title: `Repo X ${suite}`,
          is_published: true,
          student_deadline: deadline,
        },
        select: { id: true },
      })
    ).id;

    // 100% ("🔥"), 108 h after the deadline: 108 × 0.5 = 54 points off.
    await completedAttempt(quizXQuiz, late, new Date(deadline.getTime() + 108.5 * H), 100);
    await completedAttempt(quizXQuiz, other, new Date(deadline.getTime() + 108.5 * H), 100);
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  const itemOf = async (studentId: string) =>
    (await loadQuizGradeItems({ classroomId: classX, quizzesVisible: true, now }))
      .get(studentId)
      ?.find(item => item.assignment_id === quizX) ?? null;

  it('before any waiver: the late attempt is penalised and the absent student counts 0', async () => {
    expect(await itemOf(late)).toMatchObject({ grade: 46, raw_grade: 100, late_hours: 108 });
    expect(await itemOf(absent)).toMatchObject({ grade: 0, counts_as_zero: true });
  });

  it('a waiver makes the late attempt count unpenalised, for that student only', async () => {
    const set = await setQuizLateWaiver({
      classroomId: classX,
      assignmentId: quizX,
      studentId: late,
      waived: true,
      actorId: teacher,
    });
    expect(set).toEqual({ changed: true, waived: true, quizId: quizXQuiz });

    const waivedItem = await itemOf(late);
    expect(waivedItem).toMatchObject({ grade: 100, late_hours: 0, late_waived: true });
    // Student B (no waiver) is untouched.
    const otherItem = await itemOf(other);
    expect(otherItem).toMatchObject({ grade: 46, late_hours: 108 });
    expect(otherItem?.late_waived).toBeUndefined();

    const row = await prisma.quizLateWaiver.findFirstOrThrow({
      where: { assignment_id: quizX, student_id: late },
    });
    expect(row).toMatchObject({ classroom_id: classX, created_by_id: teacher });
  });

  it('setting again changes nothing', async () => {
    const again = await setQuizLateWaiver({
      classroomId: classX,
      assignmentId: quizX,
      studentId: late,
      waived: true,
      actorId: teacher,
    });
    expect(again.changed).toBe(false);
    expect(await prisma.quizLateWaiver.count({ where: { assignment_id: quizX } })).toBe(1);
  });

  it('reads answer for their own classroom only', async () => {
    expect([
      ...(await waivedAssignmentIdsForStudent({ classroomId: classX, studentId: late })),
    ]).toEqual([quizX]);
    // The same student in classroom Y has no waiver there.
    expect(
      (await waivedAssignmentIdsForStudent({ classroomId: classY, studentId: late })).size
    ).toBe(0);
    expect([
      ...(await waivedStudentIdsForAssignment({ classroomId: classX, assignmentId: quizX })),
    ]).toEqual([late]);
    expect(
      (await waivedStudentIdsForAssignment({ classroomId: classY, assignmentId: quizX })).size
    ).toBe(0);
    const map = await waivedByStudent({
      classroomId: classX,
      studentIds: [late, other],
      assignmentIds: [quizX],
    });
    expect([...map.keys()]).toEqual([late]);
    expect(
      (
        await waivedByStudent({
          classroomId: classY,
          studentIds: [late, other],
          assignmentIds: [quizX],
        })
      ).size
    ).toBe(0);
  });

  it('a pre-emptive waiver suspends the missing-work zero until cleared (D1)', async () => {
    await setQuizLateWaiver({
      classroomId: classX,
      assignmentId: quizX,
      studentId: absent,
      waived: true,
      actorId: teacher,
    });
    expect(await itemOf(absent)).toBeNull();

    const cleared = await setQuizLateWaiver({
      classroomId: classX,
      assignmentId: quizX,
      studentId: absent,
      waived: false,
      actorId: teacher,
    });
    expect(cleared).toEqual({ changed: true, waived: false, quizId: quizXQuiz });
    expect(await itemOf(absent)).toMatchObject({ grade: 0, counts_as_zero: true });
  });

  it('clearing restores the penalty; clearing twice changes nothing', async () => {
    const cleared = await setQuizLateWaiver({
      classroomId: classX,
      assignmentId: quizX,
      studentId: late,
      waived: false,
      actorId: teacher,
    });
    expect(cleared.changed).toBe(true);
    expect(await itemOf(late)).toMatchObject({ grade: 46, late_hours: 108 });
    const again = await setQuizLateWaiver({
      classroomId: classX,
      assignmentId: quizX,
      studentId: late,
      waived: false,
      actorId: teacher,
    });
    expect(again.changed).toBe(false);
  });

  it('refuses another classroom’s assignment, a repo assignment, and anyone not an accepted student', async () => {
    const base = { classroomId: classX, waived: true, actorId: teacher };
    await expect(
      setQuizLateWaiver({ ...base, assignmentId: quizY, studentId: late })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      setQuizLateWaiver({ ...base, assignmentId: randomUUID(), studentId: late })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      setQuizLateWaiver({ ...base, assignmentId: repoX, studentId: late })
    ).rejects.toMatchObject({ code: 'not_quiz' });
    for (const studentId of [outsider, pending, assistant, teacher]) {
      await expect(
        setQuizLateWaiver({ ...base, assignmentId: quizX, studentId })
      ).rejects.toMatchObject({ code: 'not_student' });
    }
    // Y's own assignment, from Y, for Y's student, is fine — and stays in Y.
    await setQuizLateWaiver({
      classroomId: classY,
      assignmentId: quizY,
      studentId: outsider,
      waived: true,
      actorId: null,
    });
    expect(
      await prisma.quizLateWaiver.count({ where: { classroom_id: classX, student_id: outsider } })
    ).toBe(0);
  });

  it('a waiver can be cleared after its student left the roster, and only in its classroom', async () => {
    const { assignmentId } = await makeQuizAssignment(classX, 'Leaver');
    const leaver = await prisma.user.create({
      data: { email: `qlw-leaver-${randomUUID().slice(0, 8)}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(leaver.id);
    const membership = await prisma.classroomMembership.create({
      data: {
        classroom_id: classX,
        user_id: leaver.id,
        role: 'STUDENT',
        has_accepted_invite: true,
      },
      select: { id: true },
    });
    const base = { assignmentId, studentId: leaver.id, actorId: teacher };
    await setQuizLateWaiver({ ...base, classroomId: classX, waived: true });
    await prisma.classroomMembership.delete({ where: { id: membership.id } });

    // Setting again now refuses; another classroom cannot clear it.
    await expect(
      setQuizLateWaiver({ ...base, classroomId: classX, waived: true })
    ).rejects.toMatchObject({ code: 'not_student' });
    await expect(
      setQuizLateWaiver({ ...base, classroomId: classY, waived: false })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await prisma.quizLateWaiver.count({ where: { assignment_id: assignmentId } })).toBe(1);

    const cleared = await setQuizLateWaiver({ ...base, classroomId: classX, waived: false });
    expect(cleared.changed).toBe(true);
    expect(await prisma.quizLateWaiver.count({ where: { assignment_id: assignmentId } })).toBe(0);
  });

  it('refuses a waiver on the actor themselves', async () => {
    await expect(
      setQuizLateWaiver({
        classroomId: classX,
        assignmentId: quizX,
        studentId: other,
        waived: true,
        actorId: other,
      })
    ).rejects.toMatchObject({ code: 'self' });
  });

  it('the waiver goes with its assignment', async () => {
    const { assignmentId, quizId } = await makeQuizAssignment(classX, 'Gone');
    await setQuizLateWaiver({
      classroomId: classX,
      assignmentId,
      studentId: other,
      waived: true,
      actorId: teacher,
    });
    await prisma.assignment.delete({ where: { id: assignmentId } });
    await prisma.quiz.delete({ where: { id: quizId } });
    expect(await prisma.quizLateWaiver.count({ where: { assignment_id: assignmentId } })).toBe(0);
  });
});
