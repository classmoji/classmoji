/**
 * Orphaned quiz adjustments (E17), against a REAL Postgres.
 *
 * Pinned here:
 *   - replacing the scale (the settings page's populate) orphans a quiz
 *     adjustment like a repo grade: the finder counts both, merged per emoji;
 *   - while orphaned the AI's grade counts and the grade item is flagged;
 *   - the remap rewrites repo grades, `QuizAttempt.adjusted_emoji`, the quiz
 *     requests' `resolved_emoji` and every request's `previous_grade` entries
 *     (repo and quiz) in the given classroom only (X vs Y), and
 *     refuses a target off the scale or a source still on it, writing nothing;
 *   - the re-seed (`quizScaleForClassroom`) cannot mix its rows into a
 *     concurrent `replaceScale`.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classrooms → quizzes,
 * attempts, requests) and then the users. Nothing is truncated.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * quizGradeAdjust.integration.test.ts does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const { default: getPrisma } = await import('@classmoji/database');
const assignmentGrade = await import('../assignmentGrade.service.ts');
const emojiMapping = await import('../emojiMapping.service.ts');
const { loadQuizGradeItems } = await import('../quizGradeItems.service.ts');
const { DEFAULT_EMOJI_MAPPINGS, SCORE_EMOJI_MAPPINGS } = await import('@classmoji/utils');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const H = 60 * 60 * 1000;

describe.skipIf(!RUN)('orphaned quiz adjustments (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const now = new Date();
  const deadline = new Date(now.getTime() - 48 * H);
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  const makeUser = async (tag: string) => {
    const user = await prisma.user.create({
      data: { email: `orph-${tag}-${suite}@example.test`, name: `ORPH ${tag} ${suite}` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (tag: string) => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `orph-${tag}-${suite}`,
        git_org_id: orgId,
        name: `ORPH ${tag} ${suite}`,
        content_namespace: `orph-${tag}-${suite}`,
        content_repo: `content-orph-${tag}-${suite}`,
      },
      select: { id: true },
    });
    await prisma.emojiMapping.createMany({
      data: DEFAULT_EMOJI_MAPPINGS.map(m => ({ classroom_id: classroom.id, ...m })),
    });
    return classroom.id;
  };

  /**
   * A classroom's fixtures, all on the emoji `+1`: a repo grade, a quiz
   * attempt adjusted to it (AI 64%), a resolved quiz request asking about it
   * and snapshotting it, and an open repo request asking about stacked `+1`s.
   */
  const seedGrades = async (classroomId: string, studentId: string, graderId: string) => {
    const n = ++serial;
    const mod = await prisma.module.create({
      data: { classroom_id: classroomId, title: `M ${n} ${suite}` },
      select: { id: true },
    });
    const repository = await prisma.repository.create({
      data: {
        classroom_id: classroomId,
        title: `lab-${n}-${suite}`,
        template: 'org/t',
        type: 'INDIVIDUAL',
      },
      select: { id: true },
    });
    const repoAssignment = await prisma.assignment.create({
      data: { module_id: mod.id, type: 'REPO', repository_id: repository.id, title: `Lab ${n}` },
      select: { id: true },
    });
    const gitRepo = await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `orph-${n}-${suite}`,
        name: `lab-${n}-${suite}`,
        classroom_id: classroomId,
        repository_id: repository.id,
        student_id: studentId,
      },
      select: { id: true },
    });
    const submission = await prisma.gitRepoAssignment.create({
      data: { provider: 'GITHUB', git_repo_id: gitRepo.id, assignment_id: repoAssignment.id },
      select: { id: true },
    });
    const grade = await prisma.assignmentGrade.create({
      data: { git_repo_assignment_id: submission.id, grader_id: graderId, emoji: '+1' },
      select: { id: true },
    });

    const quiz = await prisma.quiz.create({
      data: {
        classroom_id: classroomId,
        name: `Quiz ${n} ${suite}`,
        rubric_prompt: 'r',
        grading_strategy: 'HIGHEST',
      },
      select: { id: true },
    });
    const quizAssignment = await prisma.assignment.create({
      data: {
        module_id: mod.id,
        type: 'QUIZ',
        quiz_id: quiz.id,
        title: `Quiz ${n} ${suite}`,
        weight: 10,
        is_published: true,
        student_deadline: deadline,
      },
      select: { id: true },
    });
    const adjustedAt = new Date(deadline.getTime() - 2 * H);
    const attempt = await prisma.quizAttempt.create({
      data: {
        quiz_id: quiz.id,
        user_id: studentId,
        started_at: new Date(deadline.getTime() - 3 * H),
        completed_at: new Date(deadline.getTime() - 2 * H),
        partial_credit_percentage: 64,
        adjusted_emoji: '+1',
        adjusted_by_id: graderId,
        adjusted_at: adjustedAt,
      },
      select: { id: true },
    });
    const request = await prisma.regradeRequest.create({
      data: {
        classroom_id: classroomId,
        quiz_attempt_id: attempt.id,
        student_id: studentId,
        previous_grade: ['+1'],
        status: 'APPROVED',
        resolved_by_id: graderId,
        resolved_at: now,
        resolved_emoji: '+1',
      },
      select: { id: true },
    });
    const repoRequest = await prisma.regradeRequest.create({
      data: {
        classroom_id: classroomId,
        git_repo_assignment_id: submission.id,
        student_id: studentId,
        previous_grade: ['+1', 'eyes', '+1'],
      },
      select: { id: true },
    });
    return {
      gradeId: grade.id,
      attemptId: attempt.id,
      requestId: request.id,
      repoRequestId: repoRequest.id,
      quizAssignmentId: quizAssignment.id,
      adjustedAt,
    };
  };

  let classX: string;
  let classY: string;
  let owner: string;
  let studentX: string;
  let studentY: string;
  let x: Awaited<ReturnType<typeof seedGrades>>;
  let y: Awaited<ReturnType<typeof seedGrades>>;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `orph-${suite}`, login: `orph-org-${suite}` },
    });
    orgId = org.id;
    classX = await makeClassroom('x');
    classY = await makeClassroom('y');
    owner = await makeUser('owner');
    studentX = await makeUser('student-x');
    studentY = await makeUser('student-y');
    for (const [classroomId, userId, role] of [
      [classX, owner, 'OWNER'],
      [classY, owner, 'OWNER'],
      [classX, studentX, 'STUDENT'],
      [classY, studentY, 'STUDENT'],
    ] as const) {
      await prisma.classroomMembership.create({
        data: { classroom_id: classroomId, user_id: userId, role, has_accepted_invite: true },
      });
    }
    x = await seedGrades(classX, studentX, owner);
    y = await seedGrades(classY, studentY, owner);
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  const itemFor = async (classroomId: string, userId: string, assignmentId: string) =>
    (await loadQuizGradeItems({ classroomId, quizzesVisible: true, now }))
      .get(userId)
      ?.find(item => item.assignment_id === assignmentId);

  it('nothing is orphaned while the emoji is on the scale; the adjustment counts', async () => {
    expect(await assignmentGrade.findOrphanedGradeEmojis(classX)).toEqual([]);
    expect(await itemFor(classX, studentX, x.quizAssignmentId)).toMatchObject({
      grade: 90,
      counting_adjusted: true,
      counting_orphaned: false,
    });
  });

  it('replacing the scale orphans the quiz adjustment; the AI grade counts and it is flagged', async () => {
    await emojiMapping.replaceScale(classX, SCORE_EMOJI_MAPPINGS);
    await emojiMapping.replaceScale(classY, SCORE_EMOJI_MAPPINGS);
    const scaleX = await emojiMapping.findScaleByClassroomId(classX);
    expect(Object.keys(scaleX).sort()).toEqual(SCORE_EMOJI_MAPPINGS.map(m => m.emoji).sort());

    // One repo grade and one quiz adjustment on `+1`, merged.
    expect(await assignmentGrade.findOrphanedGradeEmojis(classX)).toEqual([
      { emoji: '+1', count: 2, quiz_count: 1 },
    ]);

    // An adjustment on an emoji still on the scale is not counted.
    const quiz = await prisma.quizAttempt.findUniqueOrThrow({
      where: { id: x.attemptId },
      select: { quiz_id: true },
    });
    const onScale = await prisma.quizAttempt.create({
      data: {
        quiz_id: quiz.quiz_id,
        user_id: owner,
        started_at: deadline,
        completed_at: deadline,
        partial_credit_percentage: 10,
        adjusted_emoji: 'score-80',
      },
      select: { id: true },
    });
    expect(await assignmentGrade.findOrphanedGradeEmojis(classX)).toEqual([
      { emoji: '+1', count: 2, quiz_count: 1 },
    ]);
    await prisma.quizAttempt.delete({ where: { id: onScale.id } });

    // While orphaned the AI's 64% counts, and the item says why.
    expect(await itemFor(classX, studentX, x.quizAssignmentId)).toMatchObject({
      grade: 64,
      raw_grade: 64,
      counting_attempt_id: x.attemptId,
      counting_adjusted: false,
      counting_orphaned: true,
    });
  });

  it('refuses a target off the scale or a source still on it, writing nothing', async () => {
    await expect(
      assignmentGrade.remapGradeEmojis(classX, [{ oldEmoji: '+1', newEmoji: 'rocket' }])
    ).rejects.toMatchObject({ name: 'RemapGradeEmojisError' });
    await expect(
      assignmentGrade.remapGradeEmojis(classX, [
        { oldEmoji: '+1', newEmoji: 'score-90' },
        { oldEmoji: 'score-80', newEmoji: 'score-90' },
      ])
    ).rejects.toMatchObject({ name: 'RemapGradeEmojisError' });

    const attempt = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: x.attemptId } });
    expect(attempt.adjusted_emoji).toBe('+1');
    const grade = await prisma.assignmentGrade.findUniqueOrThrow({ where: { id: x.gradeId } });
    expect(grade.emoji).toBe('+1');
  });

  it('remaps repo grades, quiz adjustments and request snapshots in that classroom only', async () => {
    const result = await assignmentGrade.remapGradeEmojis(classX, [
      { oldEmoji: '+1', newEmoji: 'score-90' },
    ]);
    expect(result).toEqual({
      totalRemapped: 2,
      repoGrades: 1,
      quizAdjustments: 1,
      regradeSnapshots: 1,
      regradePreviousGrades: 2,
    });

    // Classroom X: rewritten; who adjusted and when are kept.
    const attemptX = await prisma.quizAttempt.findUniqueOrThrow({ where: { id: x.attemptId } });
    expect(attemptX).toMatchObject({
      adjusted_emoji: 'score-90',
      adjusted_by_id: owner,
      adjusted_at: x.adjustedAt,
      partial_credit_percentage: 64,
    });
    expect(
      (await prisma.assignmentGrade.findUniqueOrThrow({ where: { id: x.gradeId } })).emoji
    ).toBe('score-90');
    expect(
      (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: x.requestId } })).resolved_emoji
    ).toBe('score-90');
    // Every entry of the asked-about grade, the rest kept in place.
    expect(
      (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: x.requestId } }))
        .previous_grade
    ).toEqual(['score-90']);
    expect(
      (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: x.repoRequestId } }))
        .previous_grade
    ).toEqual(['score-90', 'eyes', 'score-90']);
    expect(await assignmentGrade.findOrphanedGradeEmojis(classX)).toEqual([]);
    expect(await itemFor(classX, studentX, x.quizAssignmentId)).toMatchObject({
      grade: 90,
      counting_adjusted: true,
      counting_orphaned: false,
    });

    // Classroom Y: untouched, still orphaned.
    expect(
      (await prisma.quizAttempt.findUniqueOrThrow({ where: { id: y.attemptId } })).adjusted_emoji
    ).toBe('+1');
    expect(
      (await prisma.assignmentGrade.findUniqueOrThrow({ where: { id: y.gradeId } })).emoji
    ).toBe('+1');
    expect(
      (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: y.requestId } })).resolved_emoji
    ).toBe('+1');
    expect(
      (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: y.requestId } }))
        .previous_grade
    ).toEqual(['+1']);
    expect(
      (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: y.repoRequestId } }))
        .previous_grade
    ).toEqual(['+1', 'eyes', '+1']);
    expect(await assignmentGrade.findOrphanedGradeEmojis(classY)).toEqual([
      { emoji: '+1', count: 2, quiz_count: 1 },
    ]);
  });

  it('a classroom with no scale at all: every grade and adjustment is orphaned', async () => {
    const classE = await makeClassroom('e');
    const e = await seedGrades(classE, studentX, owner);
    await prisma.emojiMapping.deleteMany({ where: { classroom_id: classE } });
    expect(await assignmentGrade.findOrphanedGradeEmojis(classE)).toEqual([
      { emoji: '+1', count: 2, quiz_count: 1 },
    ]);
    expect(e.attemptId).toBeTruthy();
  });

  it('a re-seed never mixes into a concurrent replaceScale', async () => {
    const classZ = await makeClassroom('z');
    const want = DEFAULT_EMOJI_MAPPINGS.map(m => m.emoji).sort();
    for (let i = 0; i < 15; i++) {
      await prisma.emojiMapping.deleteMany({ where: { classroom_id: classZ } });
      await Promise.all([
        emojiMapping.replaceScale(classZ, DEFAULT_EMOJI_MAPPINGS),
        emojiMapping.quizScaleForClassroom(classZ),
        emojiMapping.quizScaleForClassroom(classZ),
      ]);
      const rows = await prisma.emojiMapping.findMany({
        where: { classroom_id: classZ },
        select: { emoji: true },
      });
      expect(rows.map(r => r.emoji).sort()).toEqual(want);
    }
  });
});
