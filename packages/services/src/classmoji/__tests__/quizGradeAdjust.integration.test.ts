/**
 * Quiz grade adjustments and quiz regrade requests, against a REAL Postgres.
 *
 * Pinned here:
 *   - scope: the attempt's own quiz decides the classroom; staff of classroom
 *     Y cannot adjust or resolve in classroom X; a student cannot adjust; an
 *     assistant can; a student cannot request on another student's attempt;
 *   - the emoji must be on the classroom's scale (emoji scale, numeric
 *     `score-N` scale, empty scale refused);
 *   - totals read the effective score: an adjusted attempt can become the
 *     counting one (D3) and the late penalty applies after the adjustment (D2);
 *   - comment-only saves, revert (the comment stays), audit rows;
 *   - quiz requests: own completed attempt only, dedupe on IN_REVIEW, ask
 *     again after a resolution (D7), approve = adjust, deny = keep, reply
 *     required, and a quiz approve never touches repo grades or the repo
 *     request in the same classroom;
 *   - the CHECK: exactly one target per request, and the partial unique
 *     index: one open request per attempt;
 *   - staff never grade their own attempt (a user holding a student and a
 *     staff role in one classroom); a pending staff invite is no access; a
 *     removed student's attempt is not adjusted or regraded;
 *   - comment authorship apart from adjustment authorship; the resolution's
 *     emoji snapshot; repo resolutions audited;
 *   - a classroom that does not show quizzes refuses every quiz action and
 *     lists no quiz request (`findManyForDisplay`).
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classrooms → quizzes,
 * attempts, requests, audit rows) and then the users. Nothing is truncated.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * token.ledgerOrder.integration.test.ts does.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// Whether quizzes show in the classroom (`entitlement.quizzesVisibleOrThrow`):
// on, unless a test turns it off. The real one needs Pro and the AI agent env.
const entitlement = vi.hoisted(() => ({ visible: true }));
vi.mock('../entitlement.service.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../entitlement.service.ts')>();
  return { ...actual, quizzesVisibleOrThrow: async () => entitlement.visible };
});

const notifications = vi.hoisted(() => ({
  calls: [] as Array<{
    recipientUserIds: string[];
    type?: string;
    metadata?: Record<string, unknown>;
  }>,
}));

// In-app notifications are recorded, not written (their emails would reach
// Trigger.dev).
vi.mock('../notification.service.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../notification.service.ts')>();
  return {
    ...actual,
    createNotifications: async (input: { recipientUserIds: string[] }) => {
      notifications.calls.push(input);
      return { count: input.recipientUserIds.length };
    },
  };
});

const { default: getPrisma } = await import('@classmoji/database');
const quizAttempt = await import('../quizAttempt.service.ts');
const regradeRequest = await import('../regradeRequest.service.ts');
const { loadQuizGradeItems } = await import('../quizGradeItems.service.ts');
const { QuizGradeError, QUIZZES_UNAVAILABLE_MESSAGE } =
  await import('../quizGradeAdjust.service.ts');
const { DEFAULT_EMOJI_MAPPINGS, SCORE_EMOJI_MAPPINGS } = await import('@classmoji/utils');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const H = 60 * 60 * 1000;
const TOOL = 'test_surface';

const refusalMessage = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QuizGradeError) return error.message;
    throw error;
  }
  return 'no error';
};

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QuizGradeError) return error.code;
    throw error;
  }
  return 'no error';
};

describe.skipIf(!RUN)('quiz grade adjustments and quiz regrade requests (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const now = new Date();
  const deadline = new Date(now.getTime() - 48 * H);
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  // Classroom X (emoji scale, 5/h late penalty), Y (emoji scale), N (numeric
  // scale), E (no scale).
  let classX: string;
  let classY: string;
  let classN: string;
  let classE: string;

  let owner: string; // OWNER of X
  let assistant: string; // ASSISTANT of X
  let staffY: string; // TEACHER of Y
  let studentA: string; // STUDENT of X (and N, E)
  let studentB: string; // STUDENT of X
  let dual: string; // STUDENT and ASSISTANT of X
  let studentY: string; // STUDENT of Y
  let pendingStaff: string; // TEACHER of X, invite not accepted
  let removed: string; // was a STUDENT of X, membership gone

  const makeUser = async (tag: string) => {
    const user = await prisma.user.create({
      data: { email: `qga-${tag}-${suite}@example.test`, name: `QGA ${tag} ${suite}` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (tag: string, scale: Array<{ emoji: string; grade: number }>) => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qga-${tag}-${suite}`,
        git_org_id: orgId,
        name: `QGA ${tag} ${suite}`,
        content_namespace: `qga-${tag}-${suite}`,
        content_repo: `content-qga-${tag}-${suite}`,
      },
      select: { id: true },
    });
    if (scale.length > 0) {
      await prisma.emojiMapping.createMany({
        data: scale.map(m => ({ classroom_id: classroom.id, emoji: m.emoji, grade: m.grade })),
      });
    }
    return classroom.id;
  };

  const member = (
    classroomId: string,
    userId: string,
    role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT',
    accepted = true
  ) =>
    prisma.classroomMembership.create({
      data: { classroom_id: classroomId, user_id: userId, role, has_accepted_invite: accepted },
    });

  const makeQuiz = async (classroomId: string) => {
    const n = ++serial;
    const module = await prisma.module.create({
      data: { classroom_id: classroomId, title: `M ${n} ${suite}` },
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
    const assignment = await prisma.assignment.create({
      data: {
        module_id: module.id,
        type: 'QUIZ',
        quiz_id: quiz.id,
        title: `Quiz ${n} ${suite}`,
        weight: 10,
        is_published: true,
        student_deadline: deadline,
      },
      select: { id: true },
    });
    return { quizId: quiz.id, assignmentId: assignment.id, moduleId: module.id };
  };

  const makeAttempt = (
    quizId: string,
    userId: string,
    pct: number | null,
    completedAt: Date | null = new Date(deadline.getTime() - H)
  ) =>
    prisma.quizAttempt.create({
      data: {
        quiz_id: quizId,
        user_id: userId,
        started_at: new Date((completedAt ?? now).getTime() - H),
        completed_at: completedAt,
        partial_credit_percentage: pct,
      },
      select: { id: true },
    });

  const itemFor = async (classroomId: string, userId: string, assignmentId: string) =>
    (await loadQuizGradeItems({ classroomId, quizzesVisible: true, now }))
      .get(userId)
      ?.find(item => item.assignment_id === assignmentId);

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qga-${suite}`, login: `qga-org-${suite}` },
    });
    orgId = org.id;
    classX = await makeClassroom('x', DEFAULT_EMOJI_MAPPINGS);
    classY = await makeClassroom('y', DEFAULT_EMOJI_MAPPINGS);
    classN = await makeClassroom('n', SCORE_EMOJI_MAPPINGS);
    classE = await makeClassroom('e', []);
    await prisma.classroomSettings.create({
      data: { classroom_id: classX, late_penalty_points_per_hour: 5 },
    });

    owner = await makeUser('owner');
    assistant = await makeUser('assistant');
    staffY = await makeUser('staff-y');
    studentA = await makeUser('student-a');
    studentB = await makeUser('student-b');

    await member(classX, owner, 'OWNER');
    await member(classX, assistant, 'ASSISTANT');
    await member(classY, staffY, 'TEACHER');
    await member(classX, studentA, 'STUDENT');
    await member(classX, studentB, 'STUDENT');
    await member(classN, owner, 'OWNER');
    await member(classN, studentA, 'STUDENT');
    await member(classE, owner, 'OWNER');
    await member(classE, studentA, 'STUDENT');

    dual = await makeUser('dual');
    studentY = await makeUser('student-y');
    pendingStaff = await makeUser('pending');
    removed = await makeUser('removed');
    await member(classX, dual, 'STUDENT');
    await member(classX, dual, 'ASSISTANT');
    await member(classY, studentY, 'STUDENT');
    await member(classX, pendingStaff, 'TEACHER', false);
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  describe('adjust / revert', () => {
    it('an assistant adjusts; the effective score counts and is audited', async () => {
      const { quizId, assignmentId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 62);

      const result = await quizAttempt.adjust({
        attemptId: id,
        emoji: '+1',
        comment: '  Q3 has full credit.  ',
        actorUserId: assistant,
        tool: TOOL,
      });
      expect(result).toMatchObject({
        changed: true,
        classroomId: classX,
        attempt: {
          adjusted_emoji: '+1',
          instructor_comment: 'Q3 has full credit.',
          adjusted_by_id: assistant,
          comment_by_id: assistant,
          partial_credit_percentage: 62,
        },
        grade: { adjusted: true, effective: { emoji: '+1', percentage: 90 } },
      });
      expect(result.grade.original.emoji).toBe('-1');

      // The AI score is untouched.
      const row = await prisma.quizAttempt.findUniqueOrThrow({ where: { id } });
      expect(row.partial_credit_percentage).toBe(62);

      expect(await itemFor(classX, studentA, assignmentId)).toMatchObject({
        grade: 90,
        counting_attempt_id: id,
        counting_adjusted: true,
      });

      const audits = await prisma.auditLog.findMany({
        where: { classroom_id: classX, resource_type: 'QUIZ_ATTEMPT', resource_id: id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ user_id: assistant, role: 'ASSISTANT', action: 'UPDATE' });
      expect(audits[0].data).toMatchObject({
        tool: TOOL,
        event: 'quiz_attempt_adjust',
        old_emoji: null,
        new_emoji: '+1',
        old_percentage: 62,
        new_percentage: 90,
        comment_set: true,
      });

      // The same adjustment again writes and audits nothing.
      const again = await quizAttempt.adjust({
        attemptId: id,
        emoji: '+1',
        comment: 'Q3 has full credit.',
        actorUserId: assistant,
        tool: TOOL,
      });
      expect(again.changed).toBe(false);
    });

    it('a student may not adjust, not even their own attempt', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 50);
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: studentA, tool: TOOL })
        )
      ).toBe('forbidden');
      expect(
        await refusal(quizAttempt.revert({ attemptId: id, actorUserId: studentB, tool: TOOL }))
      ).toBe('forbidden');
    });

    it('staff of classroom Y cannot adjust or revert an attempt in classroom X', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 50);
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: staffY, tool: TOOL })
        )
      ).toBe('not_found');
      expect(
        await refusal(quizAttempt.revert({ attemptId: id, actorUserId: staffY, tool: TOOL }))
      ).toBe('not_found');
      const row = await prisma.quizAttempt.findUniqueOrThrow({ where: { id } });
      expect(row.adjusted_emoji).toBeNull();
    });

    it("refuses an emoji not on the classroom's scale, and any emoji on an empty scale", async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 50);
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'heart', actorUserId: owner, tool: TOOL })
        )
      ).toBe('invalid_emoji');
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'score-90', actorUserId: owner, tool: TOOL })
        )
      ).toBe('invalid_emoji');

      // A classroom with no scale (E10): the adjustment gives it the
      // new-classroom scale as real rows, in its own transaction, and the
      // emoji must be on that one. A refused emoji rolls the seed back with it.
      const e = await makeQuiz(classE);
      const onEmpty = await makeAttempt(e.quizId, studentA, 50);
      expect(
        await refusal(
          quizAttempt.adjust({
            attemptId: onEmpty.id,
            emoji: 'rocket',
            actorUserId: owner,
            tool: TOOL,
          })
        )
      ).toBe('invalid_emoji');
      expect(await prisma.emojiMapping.count({ where: { classroom_id: classE } })).toBe(0);
      const seeded = await quizAttempt.adjust({
        attemptId: onEmpty.id,
        emoji: 'score-70',
        actorUserId: owner,
        tool: TOOL,
      });
      expect(await prisma.emojiMapping.count({ where: { classroom_id: classE } })).toBe(
        SCORE_EMOJI_MAPPINGS.length
      );
      expect(seeded.grade.original.emoji).toBe('score-50');
      expect(seeded.grade.effective).toMatchObject({ emoji: 'score-70', percentage: 70 });
      expect(await itemFor(classE, studentA, e.assignmentId)).toMatchObject({ grade: 70 });
    });

    it('seeds no scale for an actor who is refused (E10: only after authorization)', async () => {
      const bare = await makeClassroom('e2', []);
      await member(bare, studentA, 'STUDENT');
      const { quizId } = await makeQuiz(bare);
      const { id } = await makeAttempt(quizId, studentA, 50);
      // staffY teaches classroom Y only; studentA cannot grade.
      for (const actor of [staffY, studentA]) {
        expect(
          await refusal(
            quizAttempt.adjust({ attemptId: id, emoji: 'score-70', actorUserId: actor, tool: TOOL })
          )
        ).not.toBe('no error');
      }
      expect(await prisma.emojiMapping.count({ where: { classroom_id: bare } })).toBe(0);
    });

    it('numeric scale: a score-N badge is the adjustment and the total reads its number', async () => {
      const { quizId, assignmentId } = await makeQuiz(classN);
      const { id } = await makeAttempt(quizId, studentA, 41);
      const result = await quizAttempt.adjust({
        attemptId: id,
        emoji: 'score-70',
        actorUserId: owner,
        tool: TOOL,
      });
      expect(result.grade.original.emoji).toBe('score-40');
      expect(result.grade.effective).toMatchObject({ emoji: 'score-70', percentage: 70 });
      expect(await itemFor(classN, studentA, assignmentId)).toMatchObject({ grade: 70 });
      // A badge value not on the scale is refused, like any other emoji.
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'score-75', actorUserId: owner, tool: TOOL })
        )
      ).toBe('invalid_emoji');
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: owner, tool: TOOL })
        )
      ).toBe('invalid_emoji');
    });

    it('the late penalty applies after the adjustment (D2)', async () => {
      const { quizId, assignmentId } = await makeQuiz(classX);
      // 2 h late at 5 points per hour.
      const { id } = await makeAttempt(
        quizId,
        studentA,
        40,
        new Date(deadline.getTime() + 2 * H + 60_000)
      );
      await quizAttempt.adjust({ attemptId: id, emoji: '+1', actorUserId: owner, tool: TOOL });
      expect(await itemFor(classX, studentA, assignmentId)).toMatchObject({
        grade: 80,
        raw_grade: 90,
        counting_raw_percentage: 90,
        late_hours: 2,
      });
    });

    it('the counting attempt follows the effective score (D3)', async () => {
      const { quizId, assignmentId } = await makeQuiz(classX);
      const first = await makeAttempt(quizId, studentB, 75, new Date(deadline.getTime() - 3 * H));
      const second = await makeAttempt(quizId, studentB, 60, new Date(deadline.getTime() - 2 * H));
      expect(await itemFor(classX, studentB, assignmentId)).toMatchObject({
        counting_attempt_id: first.id,
        grade: 75,
      });
      await quizAttempt.adjust({
        attemptId: second.id,
        emoji: 'rocket',
        actorUserId: owner,
        tool: TOOL,
      });
      expect(await itemFor(classX, studentB, assignmentId)).toMatchObject({
        counting_attempt_id: second.id,
        grade: 100,
      });
    });

    it('comment-only save leaves the score; revert clears the score and keeps the comment', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 55);

      const commented = await quizAttempt.adjust({
        attemptId: id,
        comment: 'See Q2.',
        actorUserId: owner,
        tool: TOOL,
      });
      // A comment-only save is the comment's authorship, not an adjustment.
      expect(commented.attempt).toMatchObject({
        adjusted_emoji: null,
        instructor_comment: 'See Q2.',
        adjusted_by_id: null,
        adjusted_at: null,
        comment_by_id: owner,
      });
      expect(commented.attempt.comment_at).toBeInstanceOf(Date);
      expect(commented.grade.adjusted).toBe(false);

      // A score change by someone else leaves the comment's author alone.
      const scored = await quizAttempt.adjust({
        attemptId: id,
        emoji: 'eyes',
        actorUserId: assistant,
        tool: TOOL,
      });
      expect(scored.attempt).toMatchObject({
        adjusted_emoji: 'eyes',
        adjusted_by_id: assistant,
        comment_by_id: owner,
      });
      expect(scored.attempt.comment_at?.getTime()).toBe(commented.attempt.comment_at?.getTime());

      const reverted = await quizAttempt.revert({
        attemptId: id,
        actorUserId: assistant,
        tool: TOOL,
      });
      expect(reverted.changed).toBe(true);
      // Revert clears the adjustment and its author; the comment and its author stay.
      expect(reverted.attempt).toMatchObject({
        adjusted_emoji: null,
        adjusted_by_id: null,
        adjusted_at: null,
        instructor_comment: 'See Q2.',
        comment_by_id: owner,
      });
      expect(reverted.grade.effective.percentage).toBe(55);

      const audit = (
        await prisma.auditLog.findMany({ where: { resource_id: id, user_id: assistant } })
      ).find(row => (row.data as { event?: string })?.event === 'quiz_attempt_adjust_revert');
      expect(audit?.data).toMatchObject({
        tool: TOOL,
        event: 'quiz_attempt_adjust_revert',
        old_emoji: 'eyes',
        new_emoji: null,
      });

      // Reverting again changes nothing.
      expect(
        (await quizAttempt.revert({ attemptId: id, actorUserId: owner, tool: TOOL })).changed
      ).toBe(false);
    });

    it('refuses a running attempt and a staff preview attempt', async () => {
      const { quizId } = await makeQuiz(classX);
      const running = await makeAttempt(quizId, studentA, null, null);
      expect(
        await refusal(
          quizAttempt.adjust({
            attemptId: running.id,
            emoji: 'rocket',
            actorUserId: owner,
            tool: TOOL,
          })
        )
      ).toBe('not_completed');
      const preview = await makeAttempt(quizId, assistant, 80);
      expect(
        await refusal(
          quizAttempt.adjust({
            attemptId: preview.id,
            emoji: 'rocket',
            actorUserId: owner,
            tool: TOOL,
          })
        )
      ).toBe('not_student_attempt');
    });
  });

  describe('quiz regrade requests', () => {
    it('student A cannot request on student B’s attempt', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentB, 50);
      expect(
        await refusal(
          regradeRequest.createForQuizAttempt({
            attemptId: id,
            comment: 'mine?',
            actorUserId: studentA,
            tool: TOOL,
          })
        )
      ).toBe('not_found');
      // Nor can staff open one on a student's behalf.
      expect(
        await refusal(
          regradeRequest.createForQuizAttempt({
            attemptId: id,
            comment: 'x',
            actorUserId: owner,
            tool: TOOL,
          })
        )
      ).toBe('not_found');
      expect(await prisma.regradeRequest.count({ where: { quiz_attempt_id: id } })).toBe(0);
    });

    it('creates on a completed own attempt, dedupes while open, and allows asking again after (D7)', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 72);
      notifications.calls.length = 0;

      const first = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: ' Q2 was right. ',
        actorUserId: studentA,
        tool: TOOL,
      });
      expect(first).toMatchObject({
        created: true,
        classroomId: classX,
        request: {
          quiz_attempt_id: id,
          git_repo_assignment_id: null,
          student_id: studentA,
          student_comment: 'Q2 was right.',
          previous_grade: ['eyes'],
          status: 'IN_REVIEW',
        },
      });
      // OWNER/TEACHER of the classroom get the in-app notification, once,
      // naming the quiz and the attempt for its email.
      expect(notifications.calls).toHaveLength(1);
      expect(notifications.calls.at(-1)?.recipientUserIds).toEqual([owner]);
      const attemptRow = await prisma.quizAttempt.findUniqueOrThrow({
        where: { id },
        select: { attempt_number: true, quiz: { select: { name: true } } },
      });
      expect(first.attemptNumber).toBe(attemptRow.attempt_number);
      expect(notifications.calls.at(-1)).toMatchObject({
        type: 'TA_REGRADE_ASSIGNED',
        metadata: {
          target: 'quiz',
          quiz_name: attemptRow.quiz.name,
          attempt_number: attemptRow.attempt_number,
        },
      });

      const dup = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'again',
        actorUserId: studentA,
        tool: TOOL,
      });
      expect(dup.created).toBe(false);
      expect(dup.request.id).toBe(first.request.id);
      // A duplicate ask notifies no one.
      expect(notifications.calls).toHaveLength(1);
      expect((await regradeRequest.findOpenByQuizAttemptId(id))?.id).toBe(first.request.id);

      const created = await prisma.auditLog.findMany({
        where: {
          resource_type: 'REGRADE_REQUEST',
          resource_id: first.request.id,
          action: 'CREATE',
        },
      });
      expect(created).toHaveLength(1);
      expect(created[0].data).toMatchObject({
        tool: TOOL,
        event: 'regrade_create',
        quiz_attempt_id: id,
      });

      await regradeRequest.resolveQuiz({
        requestId: first.request.id,
        resolution: 'DENIED',
        comment: 'The rubric needs the base case.',
        actorUserId: owner,
        tool: TOOL,
      });
      const second = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'Please look again.',
        actorUserId: studentA,
        tool: TOOL,
      });
      expect(second.created).toBe(true);
      expect(second.request.id).not.toBe(first.request.id);
    });

    it('refuses a running attempt', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, null, null);
      expect(
        await refusal(
          regradeRequest.createForQuizAttempt({
            attemptId: id,
            comment: 'x',
            actorUserId: studentA,
            tool: TOOL,
          })
        )
      ).toBe('not_completed');
    });

    it('approve adjusts with the chosen emoji; deny keeps; a reply is required', async () => {
      const { quizId, assignmentId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentB, 58);
      const { request } = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'Q1',
        actorUserId: studentB,
        tool: TOOL,
      });

      expect(
        await refusal(
          regradeRequest.resolveQuiz({
            requestId: request.id,
            resolution: 'APPROVED',
            emoji: 'eyes',
            comment: '   ',
            actorUserId: owner,
            tool: TOOL,
          })
        )
      ).toBe('invalid_input');
      expect(
        await refusal(
          regradeRequest.resolveQuiz({
            requestId: request.id,
            resolution: 'APPROVED',
            comment: 'ok',
            actorUserId: owner,
            tool: TOOL,
          })
        )
      ).toBe('invalid_emoji');
      // Staff of another classroom cannot resolve it.
      expect(
        await refusal(
          regradeRequest.resolveQuiz({
            requestId: request.id,
            resolution: 'APPROVED',
            emoji: 'rocket',
            comment: 'ok',
            actorUserId: staffY,
            tool: TOOL,
          })
        )
      ).toBe('not_found');
      // Nor the student.
      expect(
        await refusal(
          regradeRequest.resolveQuiz({
            requestId: request.id,
            resolution: 'APPROVED',
            emoji: 'rocket',
            comment: 'ok',
            actorUserId: studentB,
            tool: TOOL,
          })
        )
      ).toBe('forbidden');

      const approved = await regradeRequest.resolveQuiz({
        requestId: request.id,
        resolution: 'APPROVED',
        emoji: 'eyes',
        comment: 'Q1 was right; adjusted.',
        actorUserId: assistant,
        tool: TOOL,
      });
      expect(approved).toMatchObject({
        alreadyResolved: false,
        request: {
          status: 'APPROVED',
          grader_comment: 'Q1 was right; adjusted.',
          // Who resolved it, on the request itself.
          resolved_by_id: assistant,
        },
        attempt: { adjusted_emoji: 'eyes', adjusted_by_id: assistant },
        grade: { effective: { emoji: 'eyes', percentage: 80 } },
      });
      // The resolution's grade is snapshotted on the request.
      expect(approved.request.resolved_emoji).toBe('eyes');
      expect(await itemFor(classX, studentB, assignmentId)).toMatchObject({ grade: 80 });

      const resolveAudit = await prisma.auditLog.findFirst({
        where: { resource_type: 'REGRADE_REQUEST', resource_id: request.id, action: 'UPDATE' },
      });
      expect(resolveAudit?.data).toMatchObject({
        tool: TOOL,
        event: 'regrade_resolve',
        resolution: 'adjust',
      });
      const adjustAudit = await prisma.auditLog.findFirst({
        where: { resource_type: 'QUIZ_ATTEMPT', resource_id: id },
      });
      expect(adjustAudit?.data).toMatchObject({
        event: 'quiz_attempt_adjust',
        via_regrade_request_id: request.id,
      });

      // Resolving again is a no-op that reports the recorded resolution,
      // before the reply or the emoji are looked at (a retry).
      const again = await regradeRequest.resolveQuiz({
        requestId: request.id,
        resolution: 'DENIED',
        comment: 'changed my mind',
        actorUserId: owner,
        tool: TOOL,
      });
      expect(
        await regradeRequest.resolveQuiz({
          requestId: request.id,
          resolution: 'APPROVED',
          comment: '',
          actorUserId: owner,
          tool: TOOL,
        })
      ).toMatchObject({ alreadyResolved: true });
      expect(approved.request.resolved_at).toBeInstanceOf(Date);
      const [listedApproved] = await regradeRequest.findMany({ id: request.id });
      expect(listedApproved.resolved_by).toMatchObject({ id: assistant });

      expect(again).toMatchObject({
        alreadyResolved: true,
        request: { status: 'APPROVED', resolved_by_id: assistant },
      });
      expect(again.request.resolved_at?.getTime()).toBe(approved.request.resolved_at?.getTime());

      // Deny keeps the score.
      const next = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'more',
        actorUserId: studentB,
        tool: TOOL,
      });
      expect(next.request.previous_grade).toEqual(['eyes']);
      const denied = await regradeRequest.resolveQuiz({
        requestId: next.request.id,
        resolution: 'DENIED',
        comment: 'Stays.',
        actorUserId: owner,
        tool: TOOL,
      });
      expect(next.request).toMatchObject({ resolved_by_id: null, resolved_at: null });
      expect(denied).toMatchObject({
        request: {
          status: 'DENIED',
          grader_comment: 'Stays.',
          resolved_by_id: owner,
          // Keep: the effective emoji the attempt kept.
          resolved_emoji: 'eyes',
        },
        attempt: { adjusted_emoji: 'eyes' },
      });
      const denyAudit = await prisma.auditLog.findFirst({
        where: { resource_type: 'REGRADE_REQUEST', resource_id: next.request.id, action: 'UPDATE' },
      });
      expect(denyAudit?.data).toMatchObject({ event: 'regrade_resolve', resolution: 'keep' });
    });

    it('a quiz approve never touches repo grades or a repo request', async () => {
      // A repo submission for student A in classroom X with a grade and an
      // open repo regrade request.
      const n = ++serial;
      const repository = await prisma.repository.create({
        data: {
          classroom_id: classX,
          title: `lab-${n}-${suite}`,
          template: 'org/t',
          type: 'INDIVIDUAL',
        },
        select: { id: true },
      });
      const mod = await prisma.module.create({
        data: { classroom_id: classX, title: `Repo M ${n} ${suite}` },
        select: { id: true },
      });
      const repoAssignment = await prisma.assignment.create({
        data: { module_id: mod.id, type: 'REPO', repository_id: repository.id, title: `Lab ${n}` },
        select: { id: true },
      });
      const gitRepo = await prisma.gitRepo.create({
        data: {
          provider: 'GITHUB',
          provider_id: `qga-${n}-${suite}`,
          name: `lab-${n}-${suite}`,
          classroom_id: classX,
          repository_id: repository.id,
          student_id: studentA,
        },
        select: { id: true },
      });
      const submission = await prisma.gitRepoAssignment.create({
        data: { provider: 'GITHUB', git_repo_id: gitRepo.id, assignment_id: repoAssignment.id },
        select: { id: true },
      });
      await prisma.assignmentGrade.create({
        data: { git_repo_assignment_id: submission.id, grader_id: owner, emoji: '-1' },
      });
      const repoRequest = await prisma.regradeRequest.create({
        data: {
          classroom_id: classX,
          git_repo_assignment_id: submission.id,
          student_id: studentA,
          previous_grade: ['-1'],
        },
      });

      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 30);
      const { request } = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'quiz',
        actorUserId: studentA,
        tool: TOOL,
      });
      await regradeRequest.resolveQuiz({
        requestId: request.id,
        resolution: 'APPROVED',
        emoji: 'rocket',
        comment: 'Adjusted.',
        actorUserId: owner,
        tool: TOOL,
      });

      const grades = await prisma.assignmentGrade.findMany({
        where: { git_repo_assignment_id: submission.id },
      });
      expect(grades.map(g => g.emoji)).toEqual(['-1']);
      const repoAfter = await prisma.regradeRequest.findUniqueOrThrow({
        where: { id: repoRequest.id },
      });
      expect(repoAfter.status).toBe('IN_REVIEW');
      expect((await regradeRequest.findOpenByAssignmentId(submission.id))?.id).toBe(repoRequest.id);

      // A repo request is refused by the quiz resolve path.
      expect(
        await refusal(
          regradeRequest.resolveQuiz({
            requestId: repoRequest.id,
            resolution: 'APPROVED',
            emoji: 'rocket',
            comment: 'x',
            actorUserId: owner,
            tool: TOOL,
          })
        )
      ).toBe('not_quiz_request');

      // The repo resolve path refuses a quiz request, and records who
      // resolved a repo request and when.
      await expect(
        regradeRequest.resolveRepo({ id: request.id, status: 'APPROVED', resolvedById: owner })
      ).rejects.toThrow(/resolveQuiz/);
      expect(
        (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: request.id } }))
          .resolved_by_id
      ).toBe(owner);
      const before = Date.now();
      const repoResolved = await regradeRequest.resolveRepo({
        id: repoRequest.id,
        status: 'DENIED',
        graderComment: '  The deadline was firm.  ',
        resolvedById: assistant,
        tool: 'repo_surface',
      });
      // Audited with the caller's surface, as the resolver's role.
      const repoAudit = await prisma.auditLog.findFirst({
        where: {
          resource_type: 'REGRADE_REQUEST',
          resource_id: repoRequest.id,
          action: 'UPDATE',
        },
      });
      expect(repoAudit).toMatchObject({ user_id: assistant, role: 'ASSISTANT' });
      expect(repoAudit?.data).toMatchObject({
        tool: 'repo_surface',
        event: 'regrade_resolve',
        target: 'repo',
        status: 'DENIED',
      });
      expect(repoResolved).toMatchObject({
        status: 'DENIED',
        grader_comment: 'The deadline was firm.',
        resolved_by_id: assistant,
      });
      expect(repoResolved.resolved_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      // Repo grades are the caller's (grade_add), untouched here.
      expect(
        (
          await prisma.assignmentGrade.findMany({
            where: { git_repo_assignment_id: submission.id },
          })
        ).map(g => g.emoji)
      ).toEqual(['-1']);

      // findMany carries both kinds, with the right relation set.
      const listed = await regradeRequest.findMany({ id: { in: [repoRequest.id, request.id] } });
      const quizRow = listed.find(r => r.id === request.id);
      const repoRow = listed.find(r => r.id === repoRequest.id);
      expect(quizRow?.git_repo_assignment).toBeNull();
      expect(quizRow?.quiz_attempt).toMatchObject({
        id,
        adjusted_emoji: 'rocket',
        quiz: { id: quizId },
      });
      expect(repoRow?.quiz_attempt).toBeNull();
      expect(repoRow?.resolved_by).toMatchObject({ id: assistant });
      expect(repoRow?.git_repo_assignment?.id).toBe(submission.id);

      // The CHECK: exactly one target.
      await expect(
        prisma.regradeRequest.create({
          data: {
            classroom_id: classX,
            student_id: studentA,
            git_repo_assignment_id: submission.id,
            quiz_attempt_id: id,
          },
        })
      ).rejects.toThrow();
      await expect(
        prisma.regradeRequest.create({ data: { classroom_id: classX, student_id: studentA } })
      ).rejects.toThrow();
    });
  });

  describe('who may act', () => {
    it('staff never adjust, revert or resolve their own attempt', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, dual, 50);
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: dual, tool: TOOL })
        )
      ).toBe('forbidden');
      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, comment: 'me', actorUserId: dual, tool: TOOL })
        )
      ).toBe('forbidden');
      expect(
        await refusal(quizAttempt.revert({ attemptId: id, actorUserId: dual, tool: TOOL }))
      ).toBe('forbidden');

      // As a student they may still ask; someone else resolves it.
      const { request } = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'please',
        actorUserId: dual,
        tool: TOOL,
      });
      expect(
        await refusal(
          regradeRequest.resolveQuiz({
            requestId: request.id,
            resolution: 'APPROVED',
            emoji: 'rocket',
            comment: 'ok',
            actorUserId: dual,
            tool: TOOL,
          })
        )
      ).toBe('forbidden');
      const row = await prisma.quizAttempt.findUniqueOrThrow({ where: { id } });
      expect(row.adjusted_emoji).toBeNull();
      expect(
        (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: request.id } })).status
      ).toBe('IN_REVIEW');

      // Another assistant may.
      const resolved = await regradeRequest.resolveQuiz({
        requestId: request.id,
        resolution: 'APPROVED',
        emoji: 'rocket',
        comment: 'ok',
        actorUserId: assistant,
        tool: TOOL,
      });
      expect(resolved.request.status).toBe('APPROVED');
    });

    it('a student of classroom Y cannot request on an attempt in classroom X', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 50);
      expect(
        await refusal(
          regradeRequest.createForQuizAttempt({
            attemptId: id,
            comment: 'mine?',
            actorUserId: studentY,
            tool: TOOL,
          })
        )
      ).toBe('not_found');
      expect(await prisma.regradeRequest.count({ where: { quiz_attempt_id: id } })).toBe(0);
    });

    it('staff with a pending invite cannot adjust or resolve', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 50);
      expect(
        await refusal(
          quizAttempt.adjust({
            attemptId: id,
            emoji: 'rocket',
            actorUserId: pendingStaff,
            tool: TOOL,
          })
        )
      ).toBe('not_found');
      expect(
        await refusal(quizAttempt.revert({ attemptId: id, actorUserId: pendingStaff, tool: TOOL }))
      ).toBe('not_found');
      const { request } = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'x',
        actorUserId: studentA,
        tool: TOOL,
      });
      expect(
        await refusal(
          regradeRequest.resolveQuiz({
            requestId: request.id,
            resolution: 'DENIED',
            comment: 'no',
            actorUserId: pendingStaff,
            tool: TOOL,
          })
        )
      ).toBe('not_found');
    });

    it("a removed student's attempt is neither adjusted nor regraded", async () => {
      const { quizId } = await makeQuiz(classX);
      const membership = await member(classX, removed, 'STUDENT');
      const { id } = await makeAttempt(quizId, removed, 50);
      await prisma.classroomMembership.delete({ where: { id: membership.id } });

      expect(
        await refusal(
          quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: owner, tool: TOOL })
        )
      ).toBe('not_student_attempt');
      expect(
        await refusal(
          regradeRequest.createForQuizAttempt({
            attemptId: id,
            comment: 'x',
            actorUserId: removed,
            tool: TOOL,
          })
        )
      ).toBe('not_found');
    });

    it('a student asking on an unfinished attempt reads "regraded", not "adjusted"', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, null, null);
      expect(
        await refusalMessage(
          regradeRequest.createForQuizAttempt({
            attemptId: id,
            comment: 'x',
            actorUserId: studentA,
            tool: TOOL,
          })
        )
      ).toBe('Only a completed quiz attempt can be regraded');
      expect(
        await refusalMessage(
          quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: owner, tool: TOOL })
        )
      ).toBe('Only a completed quiz attempt can be adjusted');
    });

    it('the partial unique index allows one open request per attempt', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentB, 50);
      const open = { classroom_id: classX, student_id: studentB, quiz_attempt_id: id };
      await prisma.regradeRequest.create({ data: open });
      await expect(prisma.regradeRequest.create({ data: open })).rejects.toMatchObject({
        code: 'P2002',
      });
      // A resolved one beside the open one is fine.
      await prisma.regradeRequest.create({ data: { ...open, status: 'DENIED' } });
      expect(await prisma.regradeRequest.count({ where: { quiz_attempt_id: id } })).toBe(2);
    });
  });

  describe('open quiz request lateness', () => {
    it("measures the attempt against its assignment's due date and the classroom penalty", async () => {
      const { quizId } = await makeQuiz(classX);
      // 3 h late at 5/h: 80 → 65, nearest emoji 👎 (60).
      const { id } = await makeAttempt(
        quizId,
        studentB,
        80,
        new Date(deadline.getTime() + 3 * H + 60_000)
      );
      const { request } = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'late',
        actorUserId: studentB,
        tool: TOOL,
      });
      const rows = await regradeRequest.findMany({ id: request.id });
      const lateness = await regradeRequest.openQuizRequestLateness(
        classX,
        rows,
        Object.fromEntries(DEFAULT_EMOJI_MAPPINGS.map(m => [m.emoji, m.grade]))
      );
      expect(lateness.get(request.id)).toEqual({ lateHours: 3, countedEmoji: '-1' });
    });
  });

  describe('a classroom that does not show quizzes', () => {
    it('refuses every quiz action and lists no quiz request', async () => {
      const { quizId } = await makeQuiz(classX);
      const { id } = await makeAttempt(quizId, studentA, 50);
      const { request } = await regradeRequest.createForQuizAttempt({
        attemptId: id,
        comment: 'x',
        actorUserId: studentA,
        tool: TOOL,
      });
      entitlement.visible = false;
      try {
        for (const attempt of [
          () =>
            quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: owner, tool: TOOL }),
          () => quizAttempt.revert({ attemptId: id, actorUserId: owner, tool: TOOL }),
          () =>
            regradeRequest.createForQuizAttempt({
              attemptId: id,
              comment: 'again',
              actorUserId: studentA,
              tool: TOOL,
            }),
          () =>
            regradeRequest.resolveQuiz({
              requestId: request.id,
              resolution: 'DENIED',
              comment: 'no',
              actorUserId: owner,
              tool: TOOL,
            }),
        ]) {
          expect(await refusalMessage(attempt())).toBe(QUIZZES_UNAVAILABLE_MESSAGE);
        }
        // A non-member still learns nothing.
        expect(
          await refusal(
            quizAttempt.adjust({ attemptId: id, emoji: 'rocket', actorUserId: staffY, tool: TOOL })
          )
        ).toBe('not_found');

        const shown = await regradeRequest.findManyForDisplay(classX, { student_id: studentA });
        expect(shown.some(r => r.quiz_attempt_id)).toBe(false);
      } finally {
        entitlement.visible = true;
      }
      const shown = await regradeRequest.findManyForDisplay(classX, { student_id: studentA });
      expect(shown.some(r => r.id === request.id)).toBe(true);
      // Scoped to the classroom given, whatever the query says.
      expect(await regradeRequest.findManyForDisplay(classY, { id: request.id })).toHaveLength(0);
    });
  });
});
