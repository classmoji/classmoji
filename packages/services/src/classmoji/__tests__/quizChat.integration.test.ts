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

  it("stores a quoted card's source and returns it on a re-run and a re-delivery", async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const source = { path: 'css/style.css', lines: '11-15', changed: true };
    const quoted = {
      ...question(1),
      code_snippet: '.features {\n  display: grid;\n}',
      source,
      // A quote never reaches the store; the tool resolves it first.
      code_quote: { path: 'css/style.css', ranges: [[11, 15]], anchor: '.features {' },
    };

    const first = call(turn);
    const accepted = await grading.presentQuestion(first, quoted as never);
    expect(accepted.card.source).toEqual(source);
    expect(accepted.card).not.toHaveProperty('code_quote');

    const rerun = await grading.presentQuestion(call(turn), question(1, 'Reworded?'));
    expect(rerun.card.source).toEqual(source);
    expect(await grading.presentQuestion(first, question(1))).toEqual(accepted);
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

    // The same answers again in the same turn (a retried call): the stored result.
    expect(
      await grading.finalizeQuestion(
        call(turnA),
        result(1, [{ level: 'partly_right', hints_before: 0 }])
      )
    ).toEqual(first);

    // Different answers in the same run of the same turn: refused, and the
    // stored result stands.
    const second = grading.finalizeQuestion(
      call(turnA),
      result(1, [{ level: 'correct', hints_before: 0 }])
    );
    await expect(second).rejects.toThrow(
      'Question 1 already has a result from this turn, and it stands. Do not record it again in this turn.'
    );
    expect(
      await codeOf(
        grading.finalizeQuestion(call(turnA), result(1, [{ level: 'correct', hints_before: 0 }]))
      )
    ).toBe('already_recorded');
    expect(await events(attemptId, 'result_finalized')).toHaveLength(1);
    expect(await events(attemptId, 'result_revised')).toHaveLength(0);
    const kept = (await attemptRow(attemptId)).question_results_json as Record<string, unknown>[];
    expect(kept[0]).toMatchObject({ credit_earned: 40, emoji: 'seedling' });

    // A redelivery of turn A's message is still turn A: a re-run under a new
    // fence gets the stored result, whatever it rates.
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
    // Different answers: one is recorded, the other refused, never both.
    const settled = await Promise.allSettled([
      grading.finalizeQuestion(
        call(answerTurn),
        result(1, [{ level: 'correct', hints_before: 0 }])
      ),
      grading.finalizeQuestion(
        call(answerTurn),
        result(1, [{ level: 'minimal', hints_before: 0 }])
      ),
    ]);
    expect(settled.filter(s => s.status === 'fulfilled')).toHaveLength(1);
    const refused = settled.filter(s => s.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(((refused[0] as PromiseRejectedResult).reason as { code?: string }).code).toBe(
      'already_recorded'
    );
    expect(await events(attemptId, 'result_finalized')).toHaveLength(1);
    const seqs = (await events(attemptId)).map(e => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('serializes two racing identical records for the same question into one result', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    const answerTurn = await say(attemptId, 'answer');
    const same = [{ level: 'correct' as const, hints_before: 0 }];
    const [a, b] = await Promise.all([
      grading.finalizeQuestion(call(answerTurn), result(1, same)),
      grading.finalizeQuestion(call(answerTurn), result(1, same)),
    ]);
    expect(a).toEqual(b);
    expect(await events(attemptId, 'result_finalized')).toHaveLength(1);
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
    // The model's closing words are kept, shown above the results.
    expect(record.feedback?.final_acknowledgment).toBe('Nice work.');
    // The band follows the score (61.7: NEEDS WORK), not the model's GOOD / 3.
    expect(record).toMatchObject({ evaluation: 'NEEDS WORK', numeric_score: 2 });
    expect(record.feedback).toMatchObject({ evaluation: 'NEEDS WORK', numeric_score: 2 });
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
    // No feedback text, so no closing acknowledgment either.
    expect(record.feedback).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('final_acknowledgment');
    expect(record.partial_credit_percentage).toBe(70);
    // The server's band from the score: 70 is GOOD.
    expect(record).toMatchObject({ evaluation: 'GOOD', numeric_score: 3 });
    expect(record.first_attempt_percentage).toBe(0);
    const [journal] = await events(attemptId, 'evaluation_completed');
    expect(journal.operation_id).toBe(grading.SERVER_COMPLETION_OPERATION_ID);
    expect(journal.payload).toMatchObject({ source: 'server' });
  });

  // ─── ending early ─────────────────────────────────────────────────────────

  const INCOMPLETE_2_3 =
    'Questions 2, 3 have no result. Record each one you presented once the student has moved on ' +
    'from it; present any not yet presented. Then submit again. (If the student confirmed ending ' +
    'early, submit with ended_early instead.)';

  /** The journal's results the server recorded as skipped for an early end. */
  const skippedByEndEvents = async (attemptId: string) =>
    (await events(attemptId, 'result_finalized')).filter(
      e => (e.payload as { skipped_by_end?: unknown }).skipped_by_end === true
    );

  it("ends early on the student's confirmation: the open question keeps its result, the rest count as skipped over every question", async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const q1 = await completeQuestion(attemptId, turn, 1, [{ level: 'correct', hints_before: 0 }]);
    await grading.presentQuestion(call(q1), question(2));
    await say(attemptId, 'answer 2');
    await say(attemptId, 'can we stop the quiz here?');
    const confirm = await say(attemptId, 'yes, end it');

    // The open question is recorded from the answer the student gave.
    await grading.finalizeQuestion(
      call(confirm),
      result(2, [{ level: 'partly_right', hints_before: 0 }], 'Moved on')
    );
    const evalCall = call(confirm);
    const record = await grading.completeWithEvaluation(evalCall, {
      source: 'model',
      feedback: { ...feedback, ended_early: true },
    });

    // (100 + 40 + 0) / 3: scored over every question, not only the answered ones.
    expect(record).toMatchObject({
      partial_credit_percentage: 46.7,
      first_attempt_percentage: 33.3,
      evaluation: 'UNSATISFACTORY',
      numeric_score: 1,
    });
    expect(record.question_results).toEqual([
      expect.objectContaining({ question_num: 1, credit_earned: 100, tries: 1 }),
      expect.objectContaining({ question_num: 2, credit_earned: 40, brief_feedback: 'Moved on' }),
      {
        question_num: 3,
        attempts: 0,
        tries: 0,
        eventually_correct: false,
        first_attempt_correct: false,
        credit_earned: 0,
        emoji: 'zzz', // the classroom's emoji for 0
        brief_feedback: '',
        skipped_by_end: true,
      },
    ]);
    expect(record.question_results[0]).not.toHaveProperty('skipped_by_end');
    expect(record.question_results[1]).not.toHaveProperty('skipped_by_end');
    expect(record.feedback).not.toHaveProperty('ended_early');
    expect(record.feedback?.final_acknowledgment).toBe('Nice work.');

    const row = await attemptRow(attemptId);
    expect(row.completed_at).not.toBeNull();
    expect(row.partial_credit_percentage).toBe(46.7);
    expect(row.evaluation_json).toEqual(record);
    const stored = row.question_results_json as Record<string, unknown>[];
    expect(stored.map(r => r.question_num)).toEqual([1, 2, 3]);
    expect(stored[2]).toMatchObject({ skipped_by_end: true, credit_earned: 0, tries: 0 });
    expect(typeof stored[2].recorded_at).toBe('string');

    const [skipped] = await skippedByEndEvents(attemptId);
    expect(skipped.operation_id).toBe(`${evalCall.toolCallId}:skipped_by_end:3`);
    expect(skipped.input_message_id).toBe(confirm.inputMessageId);
    expect(skipped.payload).toMatchObject({
      question_num: 3,
      answers: [],
      credit_earned: 0,
      emoji: 'zzz',
      skipped_by_end: true,
    });
    expect(await skippedByEndEvents(attemptId)).toHaveLength(1);
    const [completed] = await events(attemptId, 'evaluation_completed');
    expect(completed.payload).toMatchObject({ ended_early: true, skipped_by_end: [3] });
  });

  it('records a card of the same turn and unpresented questions as skipped once, however often the end is submitted', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const q1 = await completeQuestion(attemptId, turn, 1, [{ level: 'correct', hints_before: 0 }]);
    const confirm = await say(attemptId, 'yes, I want to end the quiz now');
    // Question 2 went out in this same turn, so it has no answer; question 3
    // was never presented.
    await grading.presentQuestion(call(confirm), question(2));
    expect(q1.inputMessageId).not.toBe(confirm.inputMessageId);
    const ended = { source: 'model' as const, feedback: { ...feedback, ended_early: true } };

    // Two runs racing, each with its own call id: one fill, one completion.
    const [a, b] = await Promise.all([
      grading.completeWithEvaluation(call(confirm), ended),
      grading.completeWithEvaluation(call(confirm), ended),
    ]);
    expect(a).toEqual(b);
    expect(a.partial_credit_percentage).toBe(33.3); // 100 / 3
    expect(
      a.question_results.map(r => [r.question_num, r.credit_earned, r.skipped_by_end])
    ).toEqual([
      [1, 100, undefined],
      [2, 0, true],
      [3, 0, true],
    ]);

    // A re-delivered call and a server completion return the stored record.
    const [first] = await events(attemptId, 'evaluation_completed');
    const retry = { ...confirm, toolCallId: first.operation_id };
    expect(await grading.completeWithEvaluation(retry, ended)).toEqual(a);
    expect(await grading.completeWithEvaluation(call(confirm), ended)).toEqual(a);
    expect(await grading.completeWithEvaluation(call(confirm), { source: 'server' })).toEqual(a);

    expect(await events(attemptId, 'evaluation_completed')).toHaveLength(1);
    expect(
      (await skippedByEndEvents(attemptId)).map(
        e => (e.payload as { question_num: number }).question_num
      )
    ).toEqual([2, 3]);
    expect((await attemptRow(attemptId)).question_results_json).toHaveLength(3);
  });

  it('refuses an early end in a Next or Try again turn, or with no student message, writing nothing', async () => {
    const attemptId = await newAttempt();
    const opening = await begin(attemptId);
    const ended = { source: 'model' as const, feedback: { ...feedback, ended_early: true } };

    const refusal = async (turn: Turn) => {
      try {
        await grading.completeWithEvaluation(call(turn), ended);
      } catch (error) {
        return error as { code?: string; message: string };
      }
      throw new Error('expected a refusal');
    };
    const expectNothingWritten = async () => {
      const row = await attemptRow(attemptId);
      expect(row.completed_at).toBeNull();
      expect(row.evaluation_json).toBeNull();
      expect(await skippedByEndEvents(attemptId)).toHaveLength(0);
      expect(await events(attemptId, 'evaluation_completed')).toHaveLength(0);
    };

    // The begin action: no student message at all.
    const begun = await refusal(opening);
    expect(begun.code).toBe('end_not_confirmed');
    expect(begun.message).toContain('this turn has no student message');
    await expectNothingWritten();

    const q1 = await completeQuestion(attemptId, opening, 1, [
      { level: 'correct', hints_before: 0 },
    ]);
    await grading.presentQuestion(call(q1), question(2));

    for (const text of [BUTTON_TEXT.next, BUTTON_TEXT.try_again]) {
      const clicked = await refusal(await say(attemptId, text));
      expect(clicked.code).toBe('end_not_confirmed');
      expect(clicked.message).toBe(
        "An early end needs the student's own message confirming it, and this turn began with a " +
          'button click. Leave ended_early out and carry on with the quiz.'
      );
      await expectNothingWritten();
      expect((await attemptRow(attemptId)).question_results_json).toHaveLength(1);
    }

    // The student's own message confirms it, once the open question has its result.
    const confirm = await say(attemptId, 'yes, end the quiz');
    await grading.finalizeQuestion(call(confirm), result(2, []));
    const record = await grading.completeWithEvaluation(call(confirm), ended);
    expect(record.question_results).toHaveLength(3);
  });

  const OPEN_2_UNRECORDED =
    'Record question 2 first (answers [] if the student gave none; student_asked_to_move_on: true), then submit again with ended_early.';

  it('refuses an early end while the open question has no result, writing nothing, then keeps its recorded result', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const q1 = await completeQuestion(attemptId, turn, 1, [{ level: 'correct', hints_before: 0 }]);
    // Question 2 went out in an earlier turn and the student answered it.
    await grading.presentQuestion(call(q1), question(2));
    await say(attemptId, 'answer 2');
    const confirm = await say(attemptId, 'yes, end the quiz');
    const ended = { source: 'model' as const, feedback: { ...feedback, ended_early: true } };

    const promise = grading.completeWithEvaluation(call(confirm), ended);
    await expect(promise).rejects.toMatchObject({
      code: 'open_question_unrecorded',
      message: OPEN_2_UNRECORDED,
    });
    const row = await attemptRow(attemptId);
    expect(row.completed_at).toBeNull();
    expect(row.evaluation_json).toBeNull();
    expect(row.question_results_json).toHaveLength(1);
    expect(await skippedByEndEvents(attemptId)).toHaveLength(0);
    expect(await events(attemptId, 'evaluation_completed')).toHaveLength(0);

    // Recorded from the student's answer, it stands; only question 3 is filled.
    await grading.finalizeQuestion(
      call(confirm),
      result(2, [{ level: 'mostly_right', hints_before: 0 }])
    );
    const record = await grading.completeWithEvaluation(call(confirm), ended);
    expect(
      record.question_results.map(r => [r.question_num, r.credit_earned, r.skipped_by_end])
    ).toEqual([
      [1, 100, undefined],
      [2, 70, undefined],
      [3, 0, true],
    ]);
    expect(record.partial_credit_percentage).toBe(56.7); // (100 + 70 + 0) / 3
    expect(
      (await skippedByEndEvents(attemptId)).map(
        e => (e.payload as { question_num: number }).question_num
      )
    ).toEqual([3]);
    const [completed] = await events(attemptId, 'evaluation_completed');
    expect(completed.payload).toMatchObject({ ended_early: true, skipped_by_end: [3] });
  });

  it('fills the open question when its card went out in the same turn as the confirmation', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const q1 = await completeQuestion(attemptId, turn, 1, [{ level: 'correct', hints_before: 0 }]);
    const ended = { source: 'model' as const, feedback: { ...feedback, ended_early: true } };

    // Question 2's card from an earlier turn: refused in a later confirmation.
    await grading.presentQuestion(call(q1), question(2));
    const early = await say(attemptId, 'stop the quiz please');
    expect(await codeOf(grading.completeWithEvaluation(call(early), ended))).toBe(
      'open_question_unrecorded'
    );
    await grading.finalizeQuestion(call(early), result(2, []));

    // Question 3's card goes out in the turn that confirms: filled as skipped.
    const confirm = await say(attemptId, 'yes, end it');
    await grading.presentQuestion(call(confirm), question(3));
    const record = await grading.completeWithEvaluation(call(confirm), ended);
    expect(
      record.question_results.map(r => [r.question_num, r.credit_earned, r.skipped_by_end])
    ).toEqual([
      [1, 100, undefined],
      [2, 0, undefined],
      [3, 0, true],
    ]);
    const [skipped] = await skippedByEndEvents(attemptId);
    expect(skipped.input_message_id).toBe(confirm.inputMessageId);
    expect(skipped.payload).toMatchObject({ question_num: 3, skipped_by_end: true });
  });

  it('keeps the incomplete refusal without ended_early, and takes ended_early with nothing to fill as a plain completion', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const q1 = await completeQuestion(attemptId, turn, 1, [{ level: 'correct', hints_before: 0 }]);
    const typed = await say(attemptId, "that's all from me");
    for (const f of [feedback, { ...feedback, ended_early: false }]) {
      const promise = grading.completeWithEvaluation(call(typed), { source: 'model', feedback: f });
      await expect(promise).rejects.toMatchObject({ code: 'incomplete', message: INCOMPLETE_2_3 });
    }
    expect(await skippedByEndEvents(attemptId)).toHaveLength(0);
    expect((await attemptRow(attemptId)).completed_at).toBeNull();

    expect(q1.inputMessageId).not.toBe(typed.inputMessageId);
    let last: Turn = typed;
    for (const n of [2, 3]) {
      last = await completeQuestion(attemptId, last, n, [{ level: 'correct', hints_before: 0 }]);
    }
    // Every question has its result: the flag changes nothing, in any turn.
    const nextTurn = await say(attemptId, BUTTON_TEXT.next);
    const record = await grading.completeWithEvaluation(call(nextTurn), {
      source: 'model',
      feedback: { ...feedback, ended_early: true },
    });
    expect(record.partial_credit_percentage).toBe(100);
    expect(record.question_results.some(r => r.skipped_by_end)).toBe(false);
    expect(await skippedByEndEvents(attemptId)).toHaveLength(0);
    const [completed] = await events(attemptId, 'evaluation_completed');
    expect(completed.payload).not.toHaveProperty('ended_early');
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
      score: { earned: 100, possible: 100 },
      completed: false,
      hasEvaluation: false,
      lastAction: 'try_again',
    });
  });

  it("puts the score so far in the hidden status of the student's next message", async () => {
    const attemptId = await newAttempt();
    let turn: Turn = await begin(attemptId);
    turn = await completeQuestion(attemptId, turn, 1, [
      { level: 'partly_right', hints_before: 0 },
      { level: 'correct', hints_before: 1 },
    ]); // 85
    await grading.presentQuestion(call(turn), question(2));
    const id = msgId();
    await chat.admitStudentMessage({ attemptId, message: { id, text: 'how am I doing?' }, runId });
    const admitted = (await chat.loadCanonicalMessages(attemptId)).find(m => m.id === id);
    const status = admitted?.parts[1] as { type: string; text: string } | undefined;
    expect(status?.text).toContain(
      'Score so far: 85 of 100 points, from the 1 question with a recorded result (100 points each). Questions remaining: 2.'
    );
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

  it('tags a typed button text in any case, with spaces around it', async () => {
    const attemptId = await newAttempt();
    const typed = [
      ' Next ',
      'NEXT',
      `  ${BUTTON_TEXT.try_again.toUpperCase()}\n`,
      "I'd Like To Try Answering This Question Again",
      'next question please',
      'Next.',
    ];
    const actions: Array<string | undefined> = [];
    for (const text of typed) {
      const admitted = await chat.admitStudentMessage({
        attemptId,
        message: { id: msgId(), text },
        runId,
      });
      actions.push(admitted.action);
    }
    expect(actions).toEqual(['next', 'next', 'try_again', 'try_again', undefined, undefined]);
    const messages = await chat.loadCanonicalMessages(attemptId);
    expect(messages.map(m => (m.metadata as { action?: string }).action)).toEqual(actions);
    // The student's own text is kept as typed.
    expect(messages.map(m => (m.parts[0] as { text: string }).text)).toEqual(typed);
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

  it('sets no limit on the messages of an attempt, as the previous runtime did', async () => {
    const attemptId = await newAttempt({ agent_config: { questionCount: 1 } });
    await begin(attemptId);
    // Well past 16 messages and 32 turns for a one-question attempt.
    for (let i = 0; i < 20; i++) await say(attemptId, `m${i}`);
    for (let i = 0; i < 16; i++) {
      await say(attemptId, i % 2 === 0 ? BUTTON_TEXT.try_again : BUTTON_TEXT.next);
    }
    expect((await say(attemptId, 'one more')).fence).toBeTruthy();
    expect(await events(attemptId, 'input_admitted')).toHaveLength(38);
    expect((await attemptRow(attemptId)).completed_at).toBeNull();
    expect(chat).not.toHaveProperty('TURNS_PER_QUESTION');
    expect(chat).not.toHaveProperty('TURN_CEILING_PER_QUESTION');
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
    await chat.recordTurnRefused(attemptId, 'attempt_expired', runId);
    const [row] = await events(attemptId, 'turn_refused');
    expect(row.payload).toEqual({ code: 'attempt_expired' });
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
