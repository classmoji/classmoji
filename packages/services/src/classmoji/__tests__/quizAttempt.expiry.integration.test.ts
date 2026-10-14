/**
 * A chat attempt past its session deadline, closed where it is met
 * (quizGrading `closeExpiredAttempt`, and `quizAttempt.createNew` before its
 * incomplete-attempt check), against a REAL Postgres: the row lock that makes
 * racing closes write once, the journal's unique indexes, and the audit row
 * written in the same transaction.
 *
 * The close is the message-limit completion: the results recorded so far,
 * every other question skipped (the open one included), `ended_by: 'expired'`
 * in the journal, `completed_at` the deadline itself. It never touches an
 * attempt that is open and within its deadline, complete, or on the ai-agent
 * runtime.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organizations (cascades classroom → quiz →
 * attempts → journal, audit rows) and the users. Nothing is truncated.
 *
 * Skipped unless DATABASE_URL names a LOCAL database that is not the shared
 * `classmoji` dev database (the house rule; see forms.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const getPrisma = (await import('@classmoji/database')).default;
const grading = await import('../quizGrading.service.ts');
const chat = await import('../quizChat.service.ts');
const { createNew } = await import('../quizAttempt.service.ts');
const { CONTRACT_VERSION, deriveResult } = await import('@classmoji/utils/quiz-agent');

const HOUR = 60 * 60 * 1000;
const SKIP_CREDIT = deriveResult([]).credit_earned;

describe.skipIf(!RUN)('expired chat attempts (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  const orgIds: string[] = [];
  const userIds: string[] = [];
  let classroomId: string;
  let otherClassroomId: string;
  let ownerId: string;
  let studentA: string;
  let studentB: string;
  /** Unlimited attempts. */
  let quizId: string;
  /** `max_attempts: 2`. */
  let cappedQuizId: string;
  /** A quiz in another classroom that student A also belongs to. */
  let otherQuizId: string;

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `qexp-${suite}-${label}@example.test`, name: `Quiz Expiry ${label}` },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string) => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `qexp-${suite}-${label}`,
        login: `qexp-org-${suite}-${label}`,
      },
    });
    orgIds.push(org.id);
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qexp-${suite}-${label}`,
        git_org_id: org.id,
        name: `Quiz Expiry ${suite} ${label}`,
        content_namespace: `qexp-${suite}-${label}`,
        content_repo: `content-qexp-${suite}-${label}`,
      },
    });
    await prisma.classroomSettings.create({ data: { classroom_id: classroom.id } });
    return classroom.id;
  };

  const makeQuiz = async (classroom: string, max_attempts: number) =>
    (
      await prisma.quiz.create({
        data: {
          classroom_id: classroom,
          name: `Quiz ${suite} ${randomUUID().slice(0, 4)}`,
          rubric_prompt: 'grade it',
          question_count: 3,
          status: 'PUBLISHED',
          max_attempts,
        },
      })
    ).id;

  beforeAll(async () => {
    classroomId = await makeClassroom('x');
    otherClassroomId = await makeClassroom('y');
    ownerId = await makeUser('owner');
    studentA = await makeUser('a');
    studentB = await makeUser('b');
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classroomId, user_id: ownerId, role: 'OWNER', has_accepted_invite: true },
        {
          classroom_id: classroomId,
          user_id: studentA,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
        {
          classroom_id: classroomId,
          user_id: studentB,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
        {
          classroom_id: otherClassroomId,
          user_id: ownerId,
          role: 'OWNER',
          has_accepted_invite: true,
        },
        {
          classroom_id: otherClassroomId,
          user_id: studentA,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
      ],
    });
    // quizzesVisible (turn admission): the classrooms' owner holds Pro.
    await prisma.subscription.create({ data: { user_id: ownerId, tier: 'PRO' } });
    // A classroom mapping that differs from the defaults, so the skip's emoji
    // is provably the classroom's.
    await prisma.emojiMapping.createMany({
      data: [
        { classroom_id: classroomId, emoji: 'star', grade: 100 },
        { classroom_id: classroomId, emoji: 'zzz', grade: 0 },
      ],
    });
    quizId = await makeQuiz(classroomId, 0);
    cappedQuizId = await makeQuiz(classroomId, 2);
    otherQuizId = await makeQuiz(otherClassroomId, 0);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await prisma.gitOrganization.delete({ where: { id } }).catch(() => {});
    }
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  const grantFor = (userId: string, classroom = classroomId) => ({
    actor_user_id: userId,
    effective_user_id: userId,
    classroom_id: classroom,
    role: 'STUDENT',
    web_session_id: 'web-session',
    impersonation: null,
    issued_at: new Date().toISOString(),
  });

  /** An open attempt, within its deadline unless `expiresAt` says otherwise. */
  const newAttempt = async (
    o: {
      quiz?: string;
      user?: string;
      runtime?: 'trigger_chat' | 'ai_agent';
      expiresAt?: Date | null;
      classroom?: string;
    } = {}
  ) => {
    const userId = o.user ?? studentA;
    const runtime = o.runtime ?? 'trigger_chat';
    const attempt = await prisma.quizAttempt.create({
      data: {
        quiz_id: o.quiz ?? quizId,
        user_id: userId,
        agent_runtime: runtime,
        ...(runtime === 'trigger_chat'
          ? {
              contract_version: CONTRACT_VERSION,
              chat_grant: grantFor(userId, o.classroom),
            }
          : {}),
        session_expires_at:
          o.expiresAt === undefined ? new Date(Date.now() + 24 * HOUR) : o.expiresAt,
      },
    });
    return attempt.id;
  };

  const expire = (attemptId: string, at = new Date(Date.now() - HOUR)) =>
    prisma.quizAttempt.update({ where: { id: attemptId }, data: { session_expires_at: at } });

  const runId = 'run_test';
  const msgId = () => `m${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  type Turn = { attemptId: string; fence: string; inputMessageId: string | null; runId: string };
  const call = (turn: Turn) => ({ ...turn, toolCallId: `toolu_${randomUUID()}` });

  const begin = async (attemptId: string): Promise<Turn> => {
    const { fence } = await chat.admitAction({ attemptId, runId });
    return { attemptId, fence, inputMessageId: null, runId };
  };

  /** Admit a student message, past the minimum interval since the previous one. */
  const say = async (attemptId: string, text: string): Promise<Turn> => {
    await prisma.quizAttemptEvent.updateMany({
      where: { attempt_id: attemptId, type: 'input_admitted' },
      data: { created_at: new Date(Date.now() - 10_000) },
    });
    const admitted = await chat.admitStudentMessage({
      attemptId,
      message: { id: msgId(), text },
      runId,
    });
    return { attemptId, fence: admitted.fence, inputMessageId: admitted.inputMessageId, runId };
  };

  const question = (n: number) => ({
    preamble: 'Next up.',
    question_number: n,
    total_questions: 3,
    question_text: `Question ${n}?`,
  });

  /** Question 1 answered correctly and recorded, question 2 presented and open. */
  const halfway = async (attemptId: string) => {
    const opening = await begin(attemptId);
    await grading.presentQuestion(call(opening), question(1));
    const answer = await say(attemptId, 'answer 1');
    await grading.finalizeQuestion(call(answer), {
      question_num: 1,
      answers: [{ level: 'correct', hints_before: 0 }],
      brief_feedback: 'Right.',
    });
    await grading.presentQuestion(call(answer), question(2));
    return answer;
  };

  const attemptRow = (attemptId: string) =>
    prisma.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  const events = (attemptId: string, type?: string) =>
    prisma.quizAttemptEvent.findMany({
      where: { attempt_id: attemptId, ...(type ? { type } : {}) },
      orderBy: { seq: 'asc' },
    });

  const auditRows = (attemptId: string) =>
    prisma.auditLog.findMany({
      where: { resource_type: 'QUIZ_ATTEMPT', resource_id: attemptId },
    });

  const resultsOf = async (attemptId: string) =>
    ((await attemptRow(attemptId)).question_results_json as Record<string, unknown>[]).map(r => [
      r.question_num,
      r.skipped_by_end === true,
      r.credit_earned,
    ]);

  const asStudent = (userId: string, surface: 'own_attempt_view' | 'session' = 'session') => ({
    userId,
    role: 'STUDENT' as const,
    surface,
  });

  const studentMembership = (userId: string, classroom = classroomId) => ({
    classroom_id: classroom,
    role: 'STUDENT',
    user_id: userId,
  });

  // ─── the close ────────────────────────────────────────────────────────────

  it('closes an expired attempt with the results recorded so far, every other question skipped', async () => {
    const attemptId = await newAttempt();
    const lastTurn = await halfway(attemptId);
    const deadline = new Date(Date.now() - 2 * HOUR);
    await expire(attemptId, deadline);

    const record = await grading.closeExpiredAttempt(attemptId, asStudent(studentA));
    expect(record).toMatchObject({ v: 2, source: 'server' });
    expect(record).not.toHaveProperty('feedback');

    const row = await attemptRow(attemptId);
    // Completed at its deadline, not whenever the close ran.
    expect(row.completed_at).toEqual(deadline);
    expect(row.session_status).toBe('completed');
    expect(row.evaluation_json).toEqual(record);
    expect(await resultsOf(attemptId)).toEqual([
      [1, false, 100],
      [2, true, SKIP_CREDIT],
      [3, true, SKIP_CREDIT],
    ]);
    // The score columns are the record's, over every question.
    expect(row.partial_credit_percentage).toBe(record!.partial_credit_percentage);
    expect(row.first_attempt_percentage).toBe(record!.first_attempt_percentage);
    expect(row.partial_credit_percentage).toBeCloseTo((100 + 2 * SKIP_CREDIT) / 3, 1);

    // Journaled like the message-limit completion, with its own reason.
    const [completion] = await events(attemptId, 'evaluation_completed');
    expect(completion.operation_id).toBe(grading.SERVER_COMPLETION_OPERATION_ID);
    expect(completion.run_id).toBeNull();
    expect(completion.payload).toMatchObject({
      source: 'server',
      ended_by: 'expired',
      ended_early: true,
      skipped_by_end: [2, 3],
    });
    const skipped = (await events(attemptId, 'result_finalized')).filter(
      e => (e.payload as { skipped_by_end?: boolean }).skipped_by_end === true
    );
    expect(skipped.map(e => (e.payload as { question_num: number }).question_num)).toEqual([2, 3]);
    expect(skipped.every(e => (e.payload as { emoji: string }).emoji === 'zzz')).toBe(true);
    // Not the message limit: the drawer shows no limit line.
    expect(await chat.messageLimitOf(attemptId)).toEqual({ messagesLeft: 0, endedBy: null });

    // One audit row, naming the surface, the caller and the owner.
    const audits = await auditRows(attemptId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      classroom_id: classroomId,
      user_id: studentA,
      role: 'STUDENT',
      action: 'UPDATE',
    });
    expect(audits[0].data).toMatchObject({
      tool: 'quiz_chat.expired_close',
      surface: 'session',
      quiz_id: quizId,
      owner_user_id: studentA,
      session_expires_at: deadline.toISOString(),
      skipped_by_end: [2, 3],
    });

    // The turn that was open can write nothing more, and a second close is a no-op.
    expect(
      await grading
        .finalizeQuestion(call(lastTurn), {
          question_num: 2,
          answers: [{ level: 'correct', hints_before: 0 }],
          brief_feedback: 'Late.',
        })
        .catch((e: { code?: string }) => e.code)
    ).toBe('attempt_complete');
    expect(await grading.closeExpiredAttempt(attemptId, asStudent(studentA))).toBeNull();
    expect(await events(attemptId, 'evaluation_completed')).toHaveLength(1);
    expect(await auditRows(attemptId)).toHaveLength(1);
  });

  it('closes an expired attempt that never began: every question skipped', async () => {
    const attemptId = await newAttempt({ expiresAt: new Date(Date.now() - HOUR) });
    const record = await grading.closeExpiredAttempt(attemptId, asStudent(studentA));
    expect(record?.question_results.map(r => r.question_num)).toEqual([1, 2, 3]);
    expect(await resultsOf(attemptId)).toEqual([
      [1, true, SKIP_CREDIT],
      [2, true, SKIP_CREDIT],
      [3, true, SKIP_CREDIT],
    ]);
    expect((await attemptRow(attemptId)).completed_at).not.toBeNull();
  });

  it('leaves an attempt within its deadline, a completed one, and an ai-agent one untouched', async () => {
    const open = await newAttempt();
    await halfway(open);
    const legacy = await newAttempt({
      runtime: 'ai_agent',
      expiresAt: new Date(Date.now() - HOUR),
    });
    const completedAt = new Date(Date.now() - 3 * HOUR);
    const done = await newAttempt({ expiresAt: new Date(Date.now() - HOUR) });
    await prisma.quizAttempt.update({
      where: { id: done },
      data: { completed_at: completedAt, partial_credit_percentage: 50 },
    });
    const before = await Promise.all([open, legacy, done].map(attemptRow));
    const eventsBefore = await Promise.all([open, legacy, done].map(id => events(id)));

    for (const id of [open, legacy, done]) {
      expect(await grading.closeExpiredAttempt(id, asStudent(studentA))).toBeNull();
    }
    expect(await grading.closeExpiredAttempt(randomUUID(), asStudent(studentA))).toBeNull();

    expect(await Promise.all([open, legacy, done].map(attemptRow))).toEqual(before);
    expect(await Promise.all([open, legacy, done].map(id => events(id)))).toEqual(eventsBefore);
    for (const id of [open, legacy, done]) expect(await auditRows(id)).toHaveLength(0);
    // The open attempt still takes turns.
    await expect(say(open, 'still here')).resolves.toMatchObject({ fence: expect.any(String) });
    await prisma.quizAttempt.deleteMany({ where: { id: { in: [open, legacy, done] } } });
  });

  it('writes once when closes race', async () => {
    const attemptId = await newAttempt();
    await halfway(attemptId);
    await expire(attemptId);

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        grading.closeExpiredAttempt(attemptId, asStudent(studentA, 'own_attempt_view'))
      )
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await events(attemptId, 'evaluation_completed')).toHaveLength(1);
    expect(
      (await events(attemptId, 'result_finalized')).filter(
        e => (e.payload as { skipped_by_end?: boolean }).skipped_by_end === true
      )
    ).toHaveLength(2);
    expect(await auditRows(attemptId)).toHaveLength(1);
  });

  // ─── createNew ────────────────────────────────────────────────────────────

  it('createNew closes the expired attempt, starts a new one, and still counts it toward max_attempts', async () => {
    const expired = await newAttempt({ quiz: cappedQuizId });
    await halfway(expired);
    await expire(expired);

    const second = await createNew(cappedQuizId, studentA, studentMembership(studentA), {
      agentRuntime: 'trigger_chat',
    });
    expect(second).toMatchObject({ success: true, attemptCount: 2, maxAttempts: 2 });

    const closed = await attemptRow(expired);
    expect(closed.completed_at).not.toBeNull();
    expect(closed.evaluation_json).toMatchObject({ source: 'server' });
    expect(await resultsOf(expired)).toEqual([
      [1, false, 100],
      [2, true, SKIP_CREDIT],
      [3, true, SKIP_CREDIT],
    ]);
    const [audit] = await auditRows(expired);
    expect(audit.data).toMatchObject({ tool: 'quiz_chat.expired_close', surface: 'create_new' });
    expect(audit.user_id).toBe(studentA);

    // The new attempt is open and within its deadline: it is offered to resume.
    expect(
      await createNew(cappedQuizId, studentA, studentMembership(studentA), {
        agentRuntime: 'trigger_chat',
      })
    ).toMatchObject({
      success: false,
      reason: 'incomplete_attempt_exists',
      existingAttemptId: second.attemptId,
    });
    expect((await attemptRow(second.attemptId!)).completed_at).toBeNull();

    // Once it expires too, it is closed, and the cap counts both.
    await expire(second.attemptId!);
    expect(
      await createNew(cappedQuizId, studentA, studentMembership(studentA), {
        agentRuntime: 'trigger_chat',
      })
    ).toMatchObject({ success: false, reason: 'max_attempts_reached', attemptCount: 2 });
    expect((await attemptRow(second.attemptId!)).completed_at).not.toBeNull();
  });

  it('createNew still offers an open ai-agent attempt for resuming, whatever its stamp says', async () => {
    const legacy = await newAttempt({
      runtime: 'ai_agent',
      expiresAt: new Date(Date.now() - HOUR),
    });
    const result = await createNew(quizId, studentB, studentMembership(studentB));
    // Student B's createNew sees only B's attempts; A's legacy one is A's.
    expect(result).toMatchObject({ success: true });
    await prisma.quizAttempt.delete({ where: { id: result.attemptId! } });

    const legacyB = await newAttempt({
      user: studentB,
      runtime: 'ai_agent',
      expiresAt: new Date(Date.now() - HOUR),
    });
    expect(await createNew(quizId, studentB, studentMembership(studentB))).toMatchObject({
      success: false,
      reason: 'incomplete_attempt_exists',
      existingAttemptId: legacyB,
    });
    for (const id of [legacy, legacyB]) {
      expect((await attemptRow(id)).completed_at).toBeNull();
      expect(await auditRows(id)).toHaveLength(0);
    }
    await prisma.quizAttempt.deleteMany({ where: { id: { in: [legacy, legacyB] } } });
  });

  it("createNew closes only the caller's own expired attempts on that quiz", async () => {
    // Student B's expired attempt on the quiz, and student A's on a quiz in
    // another classroom: student A starting this quiz touches neither.
    const bExpired = await newAttempt({ user: studentB, expiresAt: new Date(Date.now() - HOUR) });
    const aElsewhere = await newAttempt({
      quiz: otherQuizId,
      classroom: otherClassroomId,
      expiresAt: new Date(Date.now() - HOUR),
    });

    const started = await createNew(quizId, studentA, studentMembership(studentA), {
      agentRuntime: 'trigger_chat',
    });
    // A may have older attempts here from earlier tests; none is open.
    expect(started).toMatchObject({ success: true });

    for (const id of [bExpired, aElsewhere]) {
      expect((await attemptRow(id)).completed_at).toBeNull();
      expect(await events(id)).toHaveLength(0);
      expect(await auditRows(id)).toHaveLength(0);
    }

    // A membership of another classroom does not reach this quiz at all.
    await expect(
      createNew(quizId, studentA, studentMembership(studentA, otherClassroomId))
    ).rejects.toThrow('Membership does not match quiz classroom');
    expect((await attemptRow(started.attemptId!)).completed_at).toBeNull();
  });
});
