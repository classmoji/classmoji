/**
 * quizGrading.service + quizChat.service against a REAL Postgres.
 *
 * What a fake Prisma would agree with whatever the service did, and so is run
 * for real here: the attempt row lock (`SELECT … FOR UPDATE`), the journal's
 * `(attempt_id, operation_id)` and `(attempt_id, seq)` unique indexes, the
 * `(conversation_id, ui_message_id)` upsert key, JSON path filters on the
 * journal payload, and two tool calls for the same question racing.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classroom → quiz →
 * attempts → journal) and the users. Nothing is truncated.
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
const { createNew, updateAttemptDurations } = await import('../quizAttempt.service.ts');
const { BUTTON_TEXT, CONTRACT_VERSION, deriveResult } = await import('@classmoji/utils/quiz-agent');

type Answer = {
  level: 'correct' | 'mostly_right' | 'partly_right' | 'minimal' | 'no_attempt';
  hints_before: number;
};

/** The refusal or grading error `code` a rejected promise carries, or undefined. */
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const kindOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { kind?: string }).kind;
  }
  return undefined;
};

describe.skipIf(!RUN)('quiz chat + grading services (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let orgId: string;
  let classroomId: string;
  let ownerId: string;
  let studentId: string;
  let quizId: string;
  const userIds: string[] = [];

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        email: `qchat-${suite}-${label}@example.test`,
        name: `Quiz Chat ${label}`,
      },
    });
    userIds.push(user.id);
    return user.id;
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qchat-${suite}`, login: `qchat-org-${suite}` },
    });
    orgId = org.id;
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qchat-${suite}`,
        git_org_id: orgId,
        name: `Quiz Chat ${suite}`,
        content_namespace: `qchat-${suite}`,
        content_repo: `content-qchat-${suite}`,
      },
    });
    classroomId = classroom.id;
    await prisma.classroomSettings.create({ data: { classroom_id: classroomId } });

    ownerId = await makeUser('owner');
    studentId = await makeUser('student');
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classroomId, user_id: ownerId, role: 'OWNER', has_accepted_invite: true },
        {
          classroom_id: classroomId,
          user_id: studentId,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
      ],
    });
    // quizzesVisible: the classroom's owner holds an active Pro subscription.
    await prisma.subscription.create({ data: { user_id: ownerId, tier: 'PRO' } });
    // A classroom mapping that differs from the defaults, so the emoji is
    // provably the classroom's.
    await prisma.emojiMapping.createMany({
      data: [
        { classroom_id: classroomId, emoji: 'star', grade: 100 },
        { classroom_id: classroomId, emoji: 'rocket', grade: 80 },
        { classroom_id: classroomId, emoji: 'seedling', grade: 40 },
        { classroom_id: classroomId, emoji: 'zzz', grade: 0 },
      ],
    });

    const quiz = await prisma.quiz.create({
      data: {
        classroom_id: classroomId,
        name: `Quiz ${suite}`,
        rubric_prompt: 'grade it',
        question_count: 3,
        status: 'PUBLISHED',
        max_attempts: 0,
      },
    });
    quizId = quiz.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  const newAttempt = async (
    overrides: {
      agent_runtime?: string;
      session_expires_at?: Date;
      agent_config?: object;
      user_id?: string;
    } = {}
  ) => {
    const attempt = await prisma.quizAttempt.create({
      data: {
        quiz_id: quizId,
        user_id: overrides.user_id ?? studentId,
        agent_runtime: overrides.agent_runtime ?? 'trigger_chat',
        contract_version: CONTRACT_VERSION,
        session_expires_at:
          overrides.session_expires_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
        ...(overrides.agent_config ? { agent_config: overrides.agent_config } : {}),
      },
    });
    return attempt.id;
  };

  const runId = 'run_test';
  const msgId = () => `m${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  /** What a tool call in an admitted turn carries, minus the tool call id. */
  type Turn = { attemptId: string; fence: string; inputMessageId: string | null; runId: string };

  /** Admit a student message; returns what a tool call in that turn carries. */
  const say = async (attemptId: string, text: string, id = msgId()) => {
    const admitted = await chat.admitStudentMessage({ attemptId, message: { id, text }, runId });
    return { attemptId, fence: admitted.fence, inputMessageId: admitted.inputMessageId, runId };
  };

  const begin = async (attemptId: string): Promise<Turn> => {
    const { fence } = await chat.admitAction({ attemptId, runId });
    return { attemptId, fence, inputMessageId: null, runId };
  };

  const call = (turn: Turn, toolCallId = `toolu_${randomUUID()}`) => ({ ...turn, toolCallId });

  const question = (n: number, text = `Question ${n}?`) => ({
    preamble: 'Next up.',
    question_number: n,
    total_questions: 3,
    question_text: text,
  });

  const result = (n: number, answers: Answer[], brief_feedback = 'Noted.') => ({
    question_num: n,
    answers,
    brief_feedback,
  });

  const events = (attemptId: string, type?: string) =>
    prisma.quizAttemptEvent.findMany({
      where: { attempt_id: attemptId, ...(type ? { type } : {}) },
      orderBy: { seq: 'asc' },
    });

  const attemptRow = (attemptId: string) =>
    prisma.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  /** Present, answer and finalize question n in fresh turns. */
  const completeQuestion = async (attemptId: string, turn: Turn, n: number, answers: Answer[]) => {
    await grading.presentQuestion(call(turn), question(n));
    const answerTurn = await say(attemptId, `answer ${n}`);
    await grading.finalizeQuestion(call(answerTurn), result(n, answers));
    return answerTurn;
  };

  // ─── createNew ────────────────────────────────────────────────────────────

  it('createNew stamps the runtime, contract version and a 30-day deadline only for trigger_chat', async () => {
    const membership = { classroom_id: classroomId, role: 'OWNER', user_id: ownerId };
    const before = Date.now();
    const chatResult = await createNew(quizId, ownerId, membership, {
      agentRuntime: 'trigger_chat',
    });
    const legacyResult = await createNew(quizId, ownerId, membership);

    const stamped = await attemptRow(chatResult.attemptId!);
    expect(stamped.agent_runtime).toBe('trigger_chat');
    expect(stamped.contract_version).toBe(CONTRACT_VERSION);
    const ttl = stamped.session_expires_at!.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 5_000);

    const legacy = await attemptRow(legacyResult.attemptId!);
    expect(legacy.agent_runtime).toBe('ai_agent');
    expect(legacy.contract_version).toBeNull();
    expect(legacy.session_expires_at).toBeNull();
  });

  // ─── durations on a completed attempt ─────────────────────────────────────

  it('raises the durations of a completed chat attempt, never lowers them, and leaves a completed legacy one alone', async () => {
    const completedAt = new Date();
    const chatAttempt = await newAttempt();
    const legacyAttempt = await newAttempt({ agent_runtime: 'ai_agent' });
    for (const id of [chatAttempt, legacyAttempt]) {
      await prisma.quizAttempt.update({
        where: { id },
        data: {
          completed_at: completedAt,
          total_duration_ms: 60_000,
          unfocused_duration_ms: 5_000,
          partial_credit_percentage: 50,
        },
      });
    }

    const raised = await updateAttemptDurations(chatAttempt, {
      totalDurationMs: 75_000,
      unfocusedDurationMs: 6_000,
    });
    expect(raised).toMatchObject({ total_duration_ms: 75_000, unfocused_duration_ms: 6_000 });
    await updateAttemptDurations(chatAttempt, { totalDurationMs: 1_000, unfocusedDurationMs: 0 });
    const chatRow = await attemptRow(chatAttempt);
    expect(chatRow.total_duration_ms).toBe(75_000);
    expect(chatRow.unfocused_duration_ms).toBe(6_000);
    // Nothing but the durations changes.
    expect(chatRow.completed_at).toEqual(completedAt);
    expect(chatRow.partial_credit_percentage).toBe(50);

    const skipped = await updateAttemptDurations(legacyAttempt, {
      totalDurationMs: 75_000,
      unfocusedDurationMs: 6_000,
    });
    expect(skipped).toMatchObject({ skipped: true, reason: 'completed' });
    expect((await attemptRow(legacyAttempt)).total_duration_ms).toBe(60_000);
  });

  it('takes durations for a completed chat attempt only within ten minutes of its completion', async () => {
    const attemptId = await newAttempt();
    await prisma.quizAttempt.update({
      where: { id: attemptId },
      data: {
        completed_at: new Date(Date.now() - 11 * 60 * 1000),
        total_duration_ms: 60_000,
        unfocused_duration_ms: 5_000,
      },
    });

    const late = await updateAttemptDurations(attemptId, {
      totalDurationMs: 75_000,
      unfocusedDurationMs: 6_000,
    });
    expect(late).toMatchObject({ skipped: true, reason: 'completed' });
    const row = await attemptRow(attemptId);
    expect(row.total_duration_ms).toBe(60_000);
    expect(row.unfocused_duration_ms).toBe(5_000);

    await prisma.quizAttempt.update({
      where: { id: attemptId },
      data: { completed_at: new Date(Date.now() - 9 * 60 * 1000) },
    });
    const inTime = await updateAttemptDurations(attemptId, {
      totalDurationMs: 75_000,
      unfocusedDurationMs: 6_000,
    });
    expect(inTime).toMatchObject({ total_duration_ms: 75_000, unfocused_duration_ms: 6_000 });
  });

  // ─── presentQuestion ──────────────────────────────────────────────────────

  it('presents questions in order, returns the original on a re-run, and replays by tool call id', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);

    // Not question 2 first.
    expect(await codeOf(grading.presentQuestion(call(turn), question(2)))).toBe('out_of_order');

    const first = call(turn);
    const accepted = await grading.presentQuestion(first, { ...question(1), total_questions: 9 });
    // total_questions is the attempt's count, whatever the model sent.
    expect(accepted).toMatchObject({ question_number: 1, total_questions: 3 });
    expect(accepted.card.total_questions).toBe(3);

    // A re-run with new wording gets the ORIGINAL stored question.
    const rerun = await grading.presentQuestion(call(turn), question(1, 'Reworded?'));
    expect(rerun.card.question_text).toBe('Question 1?');

    // Exact re-delivery of the same call returns the stored output.
    expect(await grading.presentQuestion(first, question(1, 'Other?'))).toEqual(accepted);

    // Question 2 waits for question 1's result.
    expect(await codeOf(grading.presentQuestion(call(turn), question(2)))).toBe('out_of_order');

    expect(await events(attemptId, 'question_presented')).toHaveLength(1);
    expect((await attemptRow(attemptId)).questions_asked).toBe(1);
  });

  it('refuses a write under a superseded fence and writes nothing', async () => {
    const attemptId = await newAttempt();
    const old = await begin(attemptId);
    await say(attemptId, 'hello'); // a newer turn takes the attempt
    expect(await codeOf(grading.presentQuestion(call(old), question(1)))).toBe('stale_turn');
    expect(await events(attemptId, 'question_presented')).toHaveLength(0);
    expect((await attemptRow(attemptId)).questions_asked).toBe(0);
  });

  it('refuses writes to an attempt on the legacy runtime', async () => {
    const attemptId = await newAttempt({ agent_runtime: 'ai_agent' });
    await prisma.quizAttempt.update({ where: { id: attemptId }, data: { turn_fence: 'f' } });
    const f = { attemptId, fence: 'f', inputMessageId: null, runId, toolCallId: 'toolu_x' };
    expect(await codeOf(grading.presentQuestion(f, question(1)))).toBe('wrong_runtime');
  });

  // ─── finalizeQuestion ─────────────────────────────────────────────────────

  it('derives credit and the classroom emoji, and writes the legacy keys', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));

    // Not before it is presented.
    const answerTurn = await say(attemptId, 'my answer');
    expect(await codeOf(grading.finalizeQuestion(call(answerTurn), result(2, [])))).toBe(
      'out_of_order'
    );

    const output = await grading.finalizeQuestion(
      call(answerTurn),
      result(1, [{ level: 'correct', hints_before: 1 }], 'Right, after a hint.')
    );
    // correct after one hint = 85 → closest classroom emoji is 'rocket' (80).
    expect(output).toEqual({
      question_num: 1,
      emoji: 'rocket',
      brief_feedback: 'Right, after a hint.',
    });

    const stored = (await attemptRow(attemptId)).question_results_json as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      question_num: 1,
      attempts: 1,
      tries: 1,
      eventually_correct: true,
      first_attempt_correct: false, // a hint came before the first answer
      credit_earned: 85,
      emoji: 'rocket',
      brief_feedback: 'Right, after a hint.',
    });
    expect(typeof stored[0].recorded_at).toBe('string');
    expect(stored[0].revised).toBeUndefined();

    const [journal] = await events(attemptId, 'result_finalized');
    expect(journal.payload).toMatchObject({
      question_num: 1,
      answers: [{ level: 'correct', hints_before: 1 }],
      credit_earned: 85,
    });
    expect(journal.input_message_id).toBe(answerTurn.inputMessageId);
  });

  it('refuses answers whose hint counts decrease', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    const answerTurn = await say(attemptId, 'x');
    expect(
      await codeOf(
        grading.finalizeQuestion(
          call(answerTurn),
          result(1, [
            { level: 'minimal', hints_before: 2 },
            { level: 'correct', hints_before: 1 },
          ])
        )
      )
    ).toBe('invalid_input');
  });

  it('keeps the stored result within one turn, allows one revision in a later turn, then refuses', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    const turnA = await say(attemptId, 'answer');
    const first = await grading.finalizeQuestion(
      call(turnA),
      result(1, [{ level: 'partly_right', hints_before: 0 }])
    );
    expect(first.emoji).toBe('seedling');

    // Same admitted turn (e.g. a re-run): the stored result, unchanged.
    const again = await grading.finalizeQuestion(
      call(turnA),
      result(1, [{ level: 'correct', hints_before: 0 }])
    );
    expect(again).toEqual(first);

    // A redelivery of turn A's message is still turn A.
    const redelivered = await chat.admitStudentMessage({
      attemptId,
      message: { id: turnA.inputMessageId, text: 'answer' },
      runId,
    });
    expect(redelivered.status).toBe('redelivered');
    const turnARerun = { ...turnA, fence: redelivered.fence };
    expect(
      await grading.finalizeQuestion(
        call(turnARerun),
        result(1, [{ level: 'correct', hints_before: 0 }])
      )
    ).toEqual(first);

    // Later turn, same answers: nothing to revise.
    const turnB = await say(attemptId, 'I think my answer was complete');
    expect(
      await grading.finalizeQuestion(
        call(turnB),
        result(1, [{ level: 'partly_right', hints_before: 0 }])
      )
    ).toEqual(first);

    // Later turn, different answers: the one revision.
    const revised = await grading.finalizeQuestion(
      call(turnB),
      result(1, [{ level: 'mostly_right', hints_before: 0 }], 'Revised on review.')
    );
    expect(revised).toEqual({
      question_num: 1,
      emoji: 'rocket',
      brief_feedback: 'Revised on review.',
      revised: true,
    });
    const stored = (await attemptRow(attemptId)).question_results_json as Record<string, unknown>[];
    expect(stored[0]).toMatchObject({ credit_earned: 70, revised: true, emoji: 'rocket' });
    const [revision] = await events(attemptId, 'result_revised');
    expect(revision.payload).toMatchObject({
      credit_earned: 70,
      previous: { credit_earned: 40, emoji: 'seedling' },
    });

    // A third change in yet another turn is refused.
    const turnC = await say(attemptId, 'and again');
    expect(
      await codeOf(
        grading.finalizeQuestion(call(turnC), result(1, [{ level: 'correct', hints_before: 0 }]))
      )
    ).toBe('revision_refused');
    expect(await events(attemptId, 'result_revised')).toHaveLength(1);
  });

  it('refuses a revision in a Next turn, and allows it once the student answers again', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    const answer = await say(attemptId, 'answer');
    const nextTurn = await say(attemptId, BUTTON_TEXT.next);
    // The first record in the Next turn is not a revision.
    const first = await grading.finalizeQuestion(
      call(nextTurn),
      result(1, [{ level: 'minimal', hints_before: 0 }])
    );
    expect(first.revised).toBeUndefined();
    expect(answer.inputMessageId).not.toBe(nextTurn.inputMessageId);

    // A later Next turn cannot change it.
    const secondNext = await say(attemptId, BUTTON_TEXT.next);
    expect(
      await codeOf(
        grading.finalizeQuestion(
          call(secondNext),
          result(1, [{ level: 'correct', hints_before: 0 }])
        )
      )
    ).toBe('revision_refused');
    expect(await events(attemptId, 'result_revised')).toHaveLength(0);
    // The same answers in a Next turn are still the stored result, not a revision.
    expect(
      await grading.finalizeQuestion(
        call(secondNext),
        result(1, [{ level: 'minimal', hints_before: 0 }])
      )
    ).toEqual(first);

    // A turn where the student says something real may revise it, once.
    const real = await say(attemptId, 'I meant the flex container, not the item');
    const revised = await grading.finalizeQuestion(
      call(real),
      result(1, [{ level: 'mostly_right', hints_before: 0 }])
    );
    expect(revised.revised).toBe(true);
    expect(await events(attemptId, 'result_revised')).toHaveLength(1);
  });

  it('serializes two racing records for the same question into one result', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    const answerTurn = await say(attemptId, 'answer');
    const [a, b] = await Promise.all([
      grading.finalizeQuestion(
        call(answerTurn),
        result(1, [{ level: 'correct', hints_before: 0 }])
      ),
      grading.finalizeQuestion(
        call(answerTurn),
        result(1, [{ level: 'minimal', hints_before: 0 }])
      ),
    ]);
    expect(a).toEqual(b);
    expect(await events(attemptId, 'result_finalized')).toHaveLength(1);
    const seqs = (await events(attemptId)).map(e => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  // ─── completeWithEvaluation ───────────────────────────────────────────────

  const feedback = {
    final_acknowledgment: 'Nice work.',
    quiz_complete: true as const,
    evaluation: 'GOOD',
    numeric_score: 3,
    feedback_summary: 'Solid.',
    feedback_strengths: ['markup'],
    feedback_improvements: ['selectors'],
    feedback_recommendation: 'Practice selectors.',
    feedback_effort_note: 'Kept going.',
  };

  it('completes only with every question recorded, from the stored scores, once', async () => {
    const attemptId = await newAttempt();
    let turn: Turn = await begin(attemptId);
    turn = await completeQuestion(attemptId, turn, 1, [{ level: 'correct', hints_before: 0 }]); // 100
    turn = await completeQuestion(attemptId, turn, 2, [
      { level: 'minimal', hints_before: 0 },
      { level: 'correct', hints_before: 1 },
    ]); // max(20, 85) = 85

    // Question 3 not recorded yet.
    expect(
      await codeOf(grading.completeWithEvaluation(call(turn), { source: 'model', feedback }))
    ).toBe('incomplete');
    expect((await attemptRow(attemptId)).completed_at).toBeNull();

    turn = await completeQuestion(attemptId, turn, 3, []); // skipped: 0

    const evalCall = call(turn);
    const record = await grading.completeWithEvaluation(evalCall, { source: 'model', feedback });
    expect(record).toMatchObject({
      v: 2,
      source: 'model',
      partial_credit_percentage: 61.7, // (100 + 85 + 0) / 3
      first_attempt_percentage: 33.3, // only question 1
    });
    expect(record.feedback).toBeDefined();
    expect((record.feedback as Record<string, unknown>).quiz_complete).toBeUndefined();
    expect(record.question_results.map(r => r.credit_earned)).toEqual([100, 85, 0]);
    expect(record.question_results.map(r => r.tries)).toEqual([1, 2, 0]);
    expect(record.question_results.map(r => (r as Record<string, unknown>).recorded_at)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const row = await attemptRow(attemptId);
    expect(row.completed_at).not.toBeNull();
    expect(row.session_status).toBe('completed');
    expect(row.partial_credit_percentage).toBe(61.7);
    expect(row.first_attempt_percentage).toBe(33.3);
    expect(row.evaluation_json).toEqual(record);

    // Stored credit equals deriveResult over the journal's answers, for every question.
    for (const e of await events(attemptId, 'result_finalized')) {
      const p = e.payload as { answers: Answer[]; credit_earned: number };
      expect(p.credit_earned).toBe(deriveResult(p.answers).credit_earned);
    }

    // Already complete: the stored evaluation, not a second one.
    expect(await grading.completeWithEvaluation(call(turn), { source: 'server' })).toEqual(record);
    expect(await grading.completeWithEvaluation(evalCall, { source: 'model', feedback })).toEqual(
      record
    );
    expect(await events(attemptId, 'evaluation_completed')).toHaveLength(1);

    // Nothing more is recorded after completion.
    expect(
      await codeOf(
        grading.finalizeQuestion(call(turn), result(3, [{ level: 'correct', hints_before: 0 }]))
      )
    ).toBe('attempt_complete');

    // And no more turns are admitted.
    expect(await codeOf(say(attemptId, 'more'))).toBe('attempt_completed');
  });

  it('server completion records the scores with no feedback text', async () => {
    const attemptId = await newAttempt();
    let turn: Turn = await begin(attemptId);
    for (const n of [1, 2, 3]) {
      turn = await completeQuestion(attemptId, turn, n, [
        { level: 'mostly_right', hints_before: 0 },
      ]);
    }
    const { toolCallId: _unused, ...fenced } = call(turn);
    const record = await grading.completeWithEvaluation(fenced, { source: 'server' });
    expect(record.source).toBe('server');
    expect(record.feedback).toBeUndefined();
    expect(record.partial_credit_percentage).toBe(70);
    expect(record.first_attempt_percentage).toBe(0);
    const [journal] = await events(attemptId, 'evaluation_completed');
    expect(journal.operation_id).toBe(grading.SERVER_COMPLETION_OPERATION_ID);
    expect(journal.payload).toMatchObject({ source: 'server' });
  });

  // ─── explorations and progress ────────────────────────────────────────────

  it('journals explorations once per tool call and lists them', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const first = call(turn);
    await grading.recordExploration(first, {
      filesRead: ['index.html', 'style.css'],
      excerpts: 'A',
    });
    await grading.recordExploration(first, {
      filesRead: ['index.html', 'style.css'],
      excerpts: 'A',
    });
    await grading.recordExploration(call(turn), {
      filesRead: ['style.css', 'app.js'],
      excerpts: 'B',
    });
    expect(await grading.listExplorations(attemptId)).toEqual({
      filesRead: ['index.html', 'style.css', 'app.js'],
      excerpts: ['A', 'B'],
    });
  });

  it('reports progress from the database', async () => {
    const attemptId = await newAttempt();
    let turn: Turn = await begin(attemptId);
    turn = await completeQuestion(attemptId, turn, 1, [{ level: 'correct', hints_before: 0 }]);
    await grading.presentQuestion(call(turn), question(2));
    await say(attemptId, BUTTON_TEXT.try_again);
    expect(await grading.getProgress(attemptId)).toEqual({
      questionCount: 3,
      presented: 2,
      finalized: [1],
      completed: false,
      hasEvaluation: false,
      lastAction: 'try_again',
    });
  });

  // ─── admission ────────────────────────────────────────────────────────────

  it('admits a message with a hidden status part, journals it and pins the question count', async () => {
    const attemptId = await newAttempt();
    const before = await attemptRow(attemptId);
    const id = msgId();
    const admitted = await chat.admitStudentMessage({
      attemptId,
      message: { id, text: 'hi' },
      runId,
    });
    expect(admitted).toMatchObject({ status: 'admitted', inputMessageId: id });
    expect(admitted.action).toBeUndefined();

    const row = await attemptRow(attemptId);
    expect(row.turn_fence).toBe(admitted.fence);
    expect(row.turn_fence).not.toBe(before.turn_fence);
    expect(row.agent_config).toMatchObject({ questionCount: 3 });

    const messages = await chat.loadCanonicalMessages(attemptId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id, role: 'user', metadata: { hiddenPartIndexes: [1] } });
    expect(messages[0].parts).toHaveLength(2);
    expect(messages[0].parts[0]).toEqual({ type: 'text', text: 'hi' });

    const [journal] = await events(attemptId, 'input_admitted');
    expect(journal).toMatchObject({
      operation_id: id,
      input_message_id: id,
      turn_fence: admitted.fence,
    });
    expect(JSON.stringify(journal.payload)).not.toContain('hi');
  });

  it('tags the button texts with their action', async () => {
    const attemptId = await newAttempt();
    const tryAgain = await chat.admitStudentMessage({
      attemptId,
      message: { id: msgId(), text: BUTTON_TEXT.try_again },
      runId,
    });
    expect(tryAgain.action).toBe('try_again');
    const next = await chat.admitStudentMessage({
      attemptId,
      message: { id: msgId(), text: BUTTON_TEXT.next },
      runId,
    });
    expect(next.action).toBe('next');
    const messages = await chat.loadCanonicalMessages(attemptId);
    expect(messages.map(m => (m.metadata as { action?: string }).action)).toEqual([
      'try_again',
      'next',
    ]);
  });

  it('treats the same id and text as a re-delivery, and refuses the same id with other text', async () => {
    const attemptId = await newAttempt();
    const id = msgId();
    const first = await chat.admitStudentMessage({
      attemptId,
      message: { id, text: 'same' },
      runId,
    });
    const again = await chat.admitStudentMessage({
      attemptId,
      message: { id, text: 'same' },
      runId,
    });
    expect(again.status).toBe('redelivered');
    expect(again.fence).not.toBe(first.fence);
    expect((await attemptRow(attemptId)).turn_fence).toBe(again.fence);
    expect(await chat.loadCanonicalMessages(attemptId)).toHaveLength(1);
    expect(await events(attemptId, 'input_admitted')).toHaveLength(1);

    const changed = chat.admitStudentMessage({ attemptId, message: { id, text: 'other' }, runId });
    expect(await codeOf(changed)).toBe('message_conflict');
    expect((await attemptRow(attemptId)).turn_fence).toBe(again.fence);
  });

  it('re-delivers only the latest admitted message; an older id is a conflict', async () => {
    const attemptId = await newAttempt();
    const m1 = msgId();
    const m2 = msgId();
    await chat.admitStudentMessage({ attemptId, message: { id: m1, text: 'one' }, runId });
    const second = await chat.admitStudentMessage({
      attemptId,
      message: { id: m2, text: 'two' },
      runId,
    });

    const older = chat.admitStudentMessage({ attemptId, message: { id: m1, text: 'one' }, runId });
    expect(await codeOf(older)).toBe('message_conflict');
    expect(
      await kindOf(chat.admitStudentMessage({ attemptId, message: { id: m1, text: 'one' }, runId }))
    ).toBe('temporary');
    // The refused re-delivery took no turn: the fence is still the second message's.
    expect((await attemptRow(attemptId)).turn_fence).toBe(second.fence);

    const latest = await chat.admitStudentMessage({
      attemptId,
      message: { id: m2, text: 'two' },
      runId,
    });
    expect(latest.status).toBe('redelivered');
    expect(await events(attemptId, 'input_admitted')).toHaveLength(2);
  });

  it('refuses malformed messages', async () => {
    const attemptId = await newAttempt();
    const bad = [
      { id: 'has:colon', text: 'x' },
      { id: '', text: 'x' },
      { id: msgId(), text: '   ' },
      { id: msgId(), text: 'x'.repeat(chat.MAX_STUDENT_MESSAGE_CHARS + 1) },
    ];
    for (const message of bad) {
      const p = chat.admitStudentMessage({ attemptId, message, runId });
      expect(await codeOf(p)).toBe('invalid_message');
    }
    expect(await events(attemptId)).toHaveLength(0);
  });

  it('refuses turns past the cap of question_count × 16', async () => {
    expect(chat.TURNS_PER_QUESTION).toBe(16);
    const attemptId = await newAttempt({ agent_config: { questionCount: 1 } });
    for (let i = 0; i < chat.TURNS_PER_QUESTION; i++) await say(attemptId, `m${i}`);
    const over = chat.admitStudentMessage({
      attemptId,
      message: { id: msgId(), text: 'one more' },
      runId,
    });
    await expect(over).rejects.toMatchObject({ code: 'turn_limit', kind: 'permanent' });
    // Nothing recorded, so nothing to complete.
    expect((await attemptRow(attemptId)).completed_at).toBeNull();
  });

  it('does not count the Try again and Next messages toward the cap', async () => {
    const attemptId = await newAttempt({ agent_config: { questionCount: 1 } });
    for (let i = 0; i < chat.TURNS_PER_QUESTION - 1; i++) await say(attemptId, `m${i}`);
    for (let i = 0; i < 6; i++) {
      await say(attemptId, i % 2 === 0 ? BUTTON_TEXT.try_again : BUTTON_TEXT.next);
    }
    // The cap's last counted turn is still open.
    expect((await say(attemptId, 'last answer')).fence).toBeTruthy();
    await expect(say(attemptId, 'one more')).rejects.toMatchObject({
      code: 'turn_limit',
      kind: 'permanent',
    });
  });

  it('completes an attempt from its recorded grades when the cap is reached', async () => {
    const attemptId = await newAttempt({ agent_config: { questionCount: 1 } });
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    const answer = await say(attemptId, 'answer');
    await grading.finalizeQuestion(
      call(answer),
      result(1, [{ level: 'mostly_right', hints_before: 0 }])
    );
    // begin + the answer already count: fill up to the cap.
    for (let i = 2; i < chat.TURNS_PER_QUESTION; i++) await say(attemptId, `m${i}`);

    const refusedId = msgId();
    const over = chat.admitStudentMessage({
      attemptId,
      message: { id: refusedId, text: 'one more' },
      runId,
    });
    await expect(over).rejects.toMatchObject({ code: 'turn_limit', kind: 'permanent' });

    const row = await attemptRow(attemptId);
    expect(row.completed_at).not.toBeNull();
    expect(row.session_status).toBe('completed');
    expect(row.partial_credit_percentage).toBe(70);
    expect(row.evaluation_json).toMatchObject({ v: 2, source: 'server' });
    const [journal] = await events(attemptId, 'evaluation_completed');
    expect(journal.operation_id).toBe(grading.SERVER_COMPLETION_OPERATION_ID);
    expect(journal.run_id).toBe(runId);
    // The refused message was not stored.
    const stored = await chat.loadCanonicalMessages(attemptId);
    expect(stored.some(m => m.id === refusedId)).toBe(false);
    // The attempt now refuses as completed.
    expect(await codeOf(say(attemptId, 'more'))).toBe('attempt_completed');
  });

  it('refuses every turn past the ceiling of question_count × 32, begin and buttons included', async () => {
    expect(chat.TURN_CEILING_PER_QUESTION).toBe(32);
    const attemptId = await newAttempt({ agent_config: { questionCount: 1 } });
    await begin(attemptId);
    for (let i = 1; i < chat.TURN_CEILING_PER_QUESTION; i++) {
      await say(attemptId, i % 2 === 0 ? BUTTON_TEXT.next : BUTTON_TEXT.try_again);
    }
    // One counted turn (begin) of 16, and every turn of the 32.
    expect(await events(attemptId, 'input_admitted')).toHaveLength(32);

    await expect(say(attemptId, BUTTON_TEXT.try_again)).rejects.toMatchObject({
      code: 'turn_limit',
      kind: 'permanent',
    });
    await expect(say(attemptId, 'an answer')).rejects.toMatchObject({
      code: 'turn_limit',
      kind: 'permanent',
    });
    await expect(begin(attemptId)).rejects.toMatchObject({
      code: 'turn_limit',
      kind: 'permanent',
    });
    expect(await events(attemptId, 'input_admitted')).toHaveLength(32);
    // Nothing recorded, so nothing to complete.
    expect((await attemptRow(attemptId)).completed_at).toBeNull();
  }, 30_000);

  it('completes an attempt from its recorded grades when the ceiling is reached', async () => {
    const attemptId = await newAttempt({ agent_config: { questionCount: 1 } });
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    const answer = await say(attemptId, 'answer');
    await grading.finalizeQuestion(
      call(answer),
      result(1, [{ level: 'mostly_right', hints_before: 0 }])
    );
    // begin + the answer already count: fill up to the ceiling with buttons.
    for (let i = 2; i < chat.TURN_CEILING_PER_QUESTION; i++) {
      await say(attemptId, i % 2 === 0 ? BUTTON_TEXT.next : BUTTON_TEXT.try_again);
    }

    await expect(say(attemptId, BUTTON_TEXT.try_again)).rejects.toMatchObject({
      code: 'turn_limit',
      kind: 'permanent',
    });

    const row = await attemptRow(attemptId);
    expect(row.completed_at).not.toBeNull();
    expect(row.session_status).toBe('completed');
    expect(row.partial_credit_percentage).toBe(70);
    expect(row.evaluation_json).toMatchObject({ v: 2, source: 'server' });
    const [journal] = await events(attemptId, 'evaluation_completed');
    expect(journal.operation_id).toBe(grading.SERVER_COMPLETION_OPERATION_ID);
    expect(await codeOf(say(attemptId, 'more'))).toBe('attempt_completed');
  }, 30_000);

  it('refuses an expired attempt, a completed one and a legacy one permanently', async () => {
    const expired = await newAttempt({ session_expires_at: new Date(Date.now() - 1000) });
    await expect(say(expired, 'hi')).rejects.toMatchObject({
      code: 'attempt_expired',
      kind: 'permanent',
    });

    const legacy = await newAttempt({ agent_runtime: 'ai_agent' });
    await expect(say(legacy, 'hi')).rejects.toMatchObject({
      code: 'wrong_runtime',
      kind: 'permanent',
    });

    const done = await newAttempt();
    await prisma.quizAttempt.update({ where: { id: done }, data: { completed_at: new Date() } });
    await expect(begin(done)).rejects.toMatchObject({
      code: 'attempt_completed',
      kind: 'permanent',
    });

    await expect(say(randomUUID(), 'hi')).rejects.toMatchObject({ code: 'attempt_not_found' });
  });

  it('refuses a student no longer in the classroom', async () => {
    const leaver = await makeUser('leaver');
    await prisma.classroomMembership.create({
      data: {
        classroom_id: classroomId,
        user_id: leaver,
        role: 'STUDENT',
        has_accepted_invite: true,
      },
    });
    const attemptId = await newAttempt({ user_id: leaver });
    await say(attemptId, 'first');
    await prisma.classroomMembership.deleteMany({
      where: { classroom_id: classroomId, user_id: leaver },
    });
    await expect(say(attemptId, 'second')).rejects.toMatchObject({
      code: 'not_a_member',
      kind: 'permanent',
    });
  });

  it('refuses temporarily while quizzes are switched off, and admits again after', async () => {
    const attemptId = await newAttempt();
    await prisma.classroomSettings.update({
      where: { classroom_id: classroomId },
      data: { quizzes_enabled: false },
    });
    try {
      expect(await kindOf(say(attemptId, 'hi'))).toBe('temporary');
      expect(await codeOf(say(attemptId, 'hi'))).toBe('quizzes_unavailable');
    } finally {
      await prisma.classroomSettings.update({
        where: { classroom_id: classroomId },
        data: { quizzes_enabled: true },
      });
    }
    expect((await say(attemptId, 'hi')).fence).toBeTruthy();
  });

  it('refuses begin once a question has been presented', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    await expect(begin(attemptId)).rejects.toMatchObject({
      code: 'already_started',
      kind: 'temporary',
    });
  });

  it('journals a refused turn with its code only', async () => {
    const attemptId = await newAttempt();
    await chat.recordTurnRefused(attemptId, 'turn_limit', runId);
    const [row] = await events(attemptId, 'turn_refused');
    expect(row.payload).toEqual({ code: 'turn_limit' });
    await chat.recordTurnRefused(randomUUID(), 'x', runId); // unknown attempt: no-op
  });

  // ─── messages ─────────────────────────────────────────────────────────────

  it('stores the hidden opening once and keeps it out of the viewer transcript', async () => {
    const attemptId = await newAttempt();
    await begin(attemptId);
    const opening = await chat.storeHiddenOpening(attemptId);
    expect(opening).toMatchObject({
      id: chat.OPENING_MESSAGE_ID,
      role: 'user',
      metadata: { hidden: true },
    });
    expect(opening.parts[0]).toEqual({ type: 'text', text: chat.OPENING_TEXT });
    expect(await chat.storeHiddenOpening(attemptId)).toEqual(opening);

    await chat.persistAssistantMessage(
      attemptId,
      {
        id: 'asst-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Welcome.' }],
      } as never,
      { final: true }
    );
    const student = await say(attemptId, 'ready');

    const canonical = await chat.loadCanonicalMessages(attemptId);
    expect(canonical.map(m => m.id)).toEqual([
      chat.OPENING_MESSAGE_ID,
      'asst-1',
      student.inputMessageId,
    ]);

    const viewer = await chat.loadTranscriptForViewer(attemptId);
    expect(viewer.map(m => m.id)).toEqual(['asst-1', student.inputMessageId]);
    // The per-turn status part is internal.
    const studentRow = viewer.find(m => m.id === student.inputMessageId)!;
    expect(studentRow.parts).toEqual([{ type: 'text', text: 'ready' }]);
  });

  it('upserts assistant messages; a partial never replaces a final one and is not canonical', async () => {
    const attemptId = await newAttempt();
    await begin(attemptId);
    const message = (text: string) =>
      ({ id: 'asst-x', role: 'assistant', parts: [{ type: 'text', text }] }) as never;

    await chat.persistAssistantMessage(attemptId, message('partial'), { final: false });
    expect(await chat.loadCanonicalMessages(attemptId)).toHaveLength(0);

    await chat.persistAssistantMessage(attemptId, message('done'), { final: true });
    await chat.persistAssistantMessage(attemptId, message('stale partial'), { final: false });
    const [stored] = await chat.loadCanonicalMessages(attemptId);
    expect(stored.parts).toEqual([{ type: 'text', text: 'done' }]);

    // A user message id cannot be taken over by an assistant message.
    const student = await say(attemptId, 'mine');
    await expect(
      chat.persistAssistantMessage(
        attemptId,
        { id: student.inputMessageId, role: 'assistant', parts: [] } as never,
        { final: true }
      )
    ).rejects.toThrow();
  });

  it('keeps runtime state under context.runtime without touching other keys', async () => {
    const attemptId = await newAttempt();
    expect(await chat.readRuntimeState(attemptId)).toBeNull();
    await say(attemptId, 'hi'); // creates the conversation
    const conv = await prisma.aIConversation.findFirstOrThrow({
      where: { quiz_attempt: { id: attemptId } },
    });
    await prisma.aIConversation.update({ where: { id: conv.id }, data: { context: { keep: 1 } } });

    await chat.writeRuntimeState(attemptId, { cursors: { lastInEventId: 'a' }, state: { s: 1 } });
    await chat.writeRuntimeState(attemptId, { cursors: { lastInEventId: 'b' }, state: { s: 2 } });
    expect(await chat.readRuntimeState(attemptId)).toEqual({
      cursors: { lastInEventId: 'b' },
      state: { s: 2 },
    });
    const after = await prisma.aIConversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(after.context).toMatchObject({ keep: 1 });
  });
});
