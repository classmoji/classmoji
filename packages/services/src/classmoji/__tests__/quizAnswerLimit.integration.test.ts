/**
 * A quiz's hint cost and answer limit against a REAL Postgres: the pin at the
 * first admission, `quizGrading.offerNextStep` (counting, replay, the limit
 * refusal, a limit of 1, the question after its last answer, a legacy attempt
 * with no limit), scoring with the pinned cost, and the per-question counts
 * stored at finalize and at an early end.
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
const quizService = await import('../quiz.service.ts');
const { BUTTON_TEXT, CONTRACT_VERSION, LEGACY_TRY_AGAIN_TEXT } = await import(
  '@classmoji/utils/quiz-agent'
);

type Answer = {
  level: 'correct' | 'mostly_right' | 'partly_right' | 'minimal' | 'no_attempt';
  hints_before: number;
};

/** The grading error a rejected promise carries, or undefined. */
const refusalOf = async (
  promise: Promise<unknown>
): Promise<{ code?: string; message?: string } | undefined> => {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  return undefined;
};

describe.skipIf(!RUN)('quiz hint cost and answer limit (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let orgId: string;
  let classroomId: string;
  let ownerId: string;
  let studentId: string;
  const userIds: string[] = [];

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `qlimit-${suite}-${label}@example.test`, name: `Quiz Limit ${label}` },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeQuiz = async (data: { hint_cost?: number; max_answers?: number } = {}) =>
    (
      await prisma.quiz.create({
        data: {
          classroom_id: classroomId,
          name: `Quiz ${suite} ${randomUUID().slice(0, 4)}`,
          rubric_prompt: 'grade it',
          question_count: 2,
          status: 'PUBLISHED',
          max_attempts: 0,
          ...data,
        },
      })
    ).id;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qlimit-${suite}`, login: `qlimit-org-${suite}` },
    });
    orgId = org.id;
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qlimit-${suite}`,
        git_org_id: orgId,
        name: `Quiz Limit ${suite}`,
        content_namespace: `qlimit-${suite}`,
        content_repo: `content-qlimit-${suite}`,
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
    await prisma.subscription.create({ data: { user_id: ownerId, tier: 'PRO' } });
    await prisma.emojiMapping.createMany({
      data: [
        { classroom_id: classroomId, emoji: 'star', grade: 100 },
        { classroom_id: classroomId, emoji: 'rocket', grade: 80 },
        { classroom_id: classroomId, emoji: 'seedling', grade: 40 },
        { classroom_id: classroomId, emoji: 'zzz', grade: 0 },
      ],
    });
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  const newAttempt = async (quizId: string, agentConfig?: object) =>
    (
      await prisma.quizAttempt.create({
        data: {
          quiz_id: quizId,
          user_id: studentId,
          agent_runtime: 'trigger_chat',
          contract_version: CONTRACT_VERSION,
          session_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          ...(agentConfig ? { agent_config: agentConfig } : {}),
          chat_grant: {
            actor_user_id: studentId,
            effective_user_id: studentId,
            classroom_id: classroomId,
            role: 'STUDENT',
            web_session_id: 'web-session',
            impersonation: null,
            issued_at: new Date().toISOString(),
          },
        },
      })
    ).id;

  const runId = 'run_test';
  const msgId = () => `m${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  type Turn = { attemptId: string; fence: string; inputMessageId: string | null; runId: string };

  const settle = (attemptId: string) =>
    prisma.quizAttemptEvent.updateMany({
      where: { attempt_id: attemptId, type: 'input_admitted' },
      data: { created_at: new Date(Date.now() - 10_000) },
    });

  const say = async (attemptId: string, text: string, id = msgId()): Promise<Turn> => {
    await settle(attemptId);
    const admitted = await chat.admitStudentMessage({ attemptId, message: { id, text }, runId });
    return { attemptId, fence: admitted.fence, inputMessageId: admitted.inputMessageId, runId };
  };

  const begin = async (attemptId: string): Promise<Turn> => {
    const { fence } = await chat.admitAction({ attemptId, runId });
    return { attemptId, fence, inputMessageId: null, runId };
  };

  const call = (turn: Turn, toolCallId = `toolu_${randomUUID()}`) => ({ ...turn, toolCallId });

  const reply = (attemptId: string, parts: unknown[]) =>
    chat.persistAssistantMessage(
      attemptId,
      { id: `reply-${randomUUID()}`, role: 'assistant', parts } as never,
      { final: true }
    );

  const question = (n: number) => ({
    preamble: 'Next up.',
    question_number: n,
    total_questions: 2,
    question_text: `Question ${n}?`,
  });

  const TRY = ['try_again', 'next'] as const;
  const NEXT = ['next'] as const;

  const offers = (attemptId: string) =>
    prisma.quizAttemptEvent.findMany({
      where: { attempt_id: attemptId, type: 'answer_offered' },
      orderBy: { seq: 'asc' },
    });

  const attemptRow = (attemptId: string) =>
    prisma.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  /** An attempt with question 1 out, admitted under the quiz's rules. */
  const started = async (quizId: string, agentConfig?: object) => {
    const attemptId = await newAttempt(quizId, agentConfig);
    const turn = await begin(attemptId);
    await grading.presentQuestion(call(turn), question(1));
    return attemptId;
  };

  // ─── the pin ──────────────────────────────────────────────────────────────

  it("pins the quiz's hint cost and answer limit at the first admission, and keeps them", async () => {
    const quizId = await makeQuiz({ hint_cost: 30, max_answers: 3 });
    const attemptId = await newAttempt(quizId);
    await begin(attemptId);
    expect((await attemptRow(attemptId)).agent_config).toMatchObject({
      questionCount: 2,
      hintCost: 30,
      maxAnswers: 3,
    });
    await prisma.quiz.update({ where: { id: quizId }, data: { hint_cost: 0, max_answers: 1 } });
    await say(attemptId, 'still pinned');
    expect((await attemptRow(attemptId)).agent_config).toMatchObject({
      hintCost: 30,
      maxAnswers: 3,
    });
  });

  it('never adds the rules to an attempt pinned before they existed', async () => {
    const quizId = await makeQuiz({ hint_cost: 30, max_answers: 2 });
    const attemptId = await newAttempt(quizId, { questionCount: 2, codeSandbox: false });
    await begin(attemptId);
    const config = (await attemptRow(attemptId)).agent_config as Record<string, unknown>;
    expect(config).not.toHaveProperty('hintCost');
    expect(config).not.toHaveProperty('maxAnswers');
  });

  // ─── offerNextStep ────────────────────────────────────────────────────────

  it('counts each offer as an answer to the open question, and replays one by its call id', async () => {
    const quizId = await makeQuiz({ hint_cost: 20, max_answers: 3 });
    const attemptId = await started(quizId);
    const t1 = await say(attemptId, 'my first answer');
    const first = call(t1);
    expect(await grading.offerNextStep(first, { actions: [...TRY] })).toEqual({
      answers_used: 1,
      max_answers: 3,
      hint_cost: 20,
      last_question: false,
    });
    // The same call again (a retried run): the stored output, nothing new.
    expect(await grading.offerNextStep(first, { actions: [...TRY] })).toMatchObject({
      answers_used: 1,
    });
    const rows = await offers(attemptId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ question_num: 1, actions: [...TRY], answer: 1 });
    expect(rows[0].operation_id).toBe(first.toolCallId);

    const t2 = await say(attemptId, 'my second answer');
    expect(await grading.offerNextStep(call(t2), { actions: [...TRY] })).toMatchObject({
      answers_used: 2,
    });
  });

  it('refuses Try again on the last answer, writes nothing, then takes Next alone', async () => {
    const quizId = await makeQuiz({ max_answers: 2 });
    const attemptId = await started(quizId);
    await grading.offerNextStep(call(await say(attemptId, 'a1')), { actions: [...TRY] });

    const last = await say(attemptId, 'a2');
    const refused = await refusalOf(grading.offerNextStep(call(last), { actions: [...TRY] }));
    expect(refused?.code).toBe('answer_limit');
    expect(refused?.message).toContain("last answer for question 1");
    expect(refused?.message).toContain('["next"]');
    expect(refused?.message).not.toMatch(/point|cost|score/i);
    expect(await offers(attemptId)).toHaveLength(1);

    // The model's corrected call in the same turn: the reveal, Next alone.
    expect(await grading.offerNextStep(call(last), { actions: [...NEXT] })).toMatchObject({
      answers_used: 2,
      max_answers: 2,
    });
    expect(await offers(attemptId)).toHaveLength(2);
  });

  it('after the last answer takes only Next, and counts nothing more', async () => {
    const quizId = await makeQuiz({ max_answers: 1 });
    const attemptId = await started(quizId);
    // A limit of 1: Try again is never taken.
    const t1 = await say(attemptId, 'only answer');
    expect(
      (await refusalOf(grading.offerNextStep(call(t1), { actions: [...TRY] })))?.code
    ).toBe('answer_limit');
    expect(await grading.offerNextStep(call(t1), { actions: [...NEXT] })).toMatchObject({
      answers_used: 1,
      max_answers: 1,
    });

    // A later message on the ended question: Next only, no new row.
    const later = await say(attemptId, 'but what about this?');
    expect(
      (await refusalOf(grading.offerNextStep(call(later), { actions: [...TRY] })))?.code
    ).toBe('answer_limit');
    expect(await grading.offerNextStep(call(later), { actions: [...NEXT] })).toEqual({
      answers_used: 1,
      max_answers: 1,
      hint_cost: 15,
      last_question: false,
    });
    expect(await offers(attemptId)).toHaveLength(1);
  });

  it('gives a legacy attempt (pinned before limits) no limit and the old cost', async () => {
    const quizId = await makeQuiz({ hint_cost: 50, max_answers: 1 });
    const attemptId = await started(quizId, { questionCount: 2, codeSandbox: false });
    for (let k = 1; k <= 7; k++) {
      const out = await grading.offerNextStep(call(await say(attemptId, `answer ${k}`)), {
        actions: [...TRY],
      });
      expect(out).toEqual({
        answers_used: k,
        max_answers: null,
        hint_cost: 15,
        last_question: false,
      });
    }
  });

  it('says when the open question is the last one, and refuses with no question open', async () => {
    const quizId = await makeQuiz();
    const attemptId = await newAttempt(quizId);
    const opening = await begin(attemptId);
    expect(
      (await refusalOf(grading.offerNextStep(call(opening), { actions: [...TRY] })))?.code
    ).toBe('out_of_order');
    await grading.presentQuestion(call(opening), question(1));
    const t1 = await say(attemptId, 'a');
    await grading.offerNextStep(call(t1), { actions: [...NEXT] });
    const next = await say(attemptId, BUTTON_TEXT.next);
    await grading.finalizeQuestion(call(next), {
      question_num: 1,
      answers: [{ level: 'correct', hints_before: 0 }],
      brief_feedback: 'Nailed it!',
    });
    // Question 1 has its result; question 2 is not out yet.
    expect(
      (await refusalOf(grading.offerNextStep(call(next), { actions: [...NEXT] })))?.code
    ).toBe('out_of_order');
    await grading.presentQuestion(call(next), question(2));
    const t2 = await say(attemptId, 'b');
    expect(await grading.offerNextStep(call(t2), { actions: [...NEXT] })).toMatchObject({
      answers_used: 1,
      last_question: true,
    });
  });

  it('counts one answer per student message when a turn runs again for it', async () => {
    const quizId = await makeQuiz({ max_answers: 2 });
    const attemptId = await started(quizId);
    const id = msgId();
    const first = await say(attemptId, 'my answer', id);
    expect(await grading.offerNextStep(call(first), { actions: [...TRY] })).toMatchObject({
      answers_used: 1,
    });
    // The run took the offer but saved no reply: the message is redelivered
    // and its turn runs again, with a new fence and a new tool call.
    const again = await chat.admitStudentMessage({
      attemptId,
      message: { id, text: 'my answer' },
      runId,
    });
    expect(again.status).toBe('redelivered');
    const rerun = { attemptId, fence: again.fence, inputMessageId: id, runId };
    expect(await grading.offerNextStep(call(rerun), { actions: [...TRY] })).toMatchObject({
      answers_used: 1,
      max_answers: 2,
    });
    expect(await offers(attemptId)).toHaveLength(1);

    // The next message is the last answer.
    const last = await say(attemptId, 'second answer');
    expect(
      (await refusalOf(grading.offerNextStep(call(last), { actions: [...TRY] })))?.code
    ).toBe('answer_limit');
  });

  it('never counts an offer in a hint turn', async () => {
    const quizId = await makeQuiz();
    const attemptId = await started(quizId);
    await grading.offerNextStep(call(await say(attemptId, 'a')), { actions: [...TRY] });
    const hint = await say(attemptId, BUTTON_TEXT.try_again);
    expect(
      (await refusalOf(grading.offerNextStep(call(hint), { actions: [...TRY] })))?.code
    ).toBe('invalid_input');
    expect(await offers(attemptId)).toHaveLength(1);
  });

  it('refuses a stale turn and a malformed action list', async () => {
    const quizId = await makeQuiz();
    const attemptId = await started(quizId);
    const t1 = await say(attemptId, 'a');
    await say(attemptId, 'b'); // a newer turn takes the fence
    expect((await refusalOf(grading.offerNextStep(call(t1), { actions: [...TRY] })))?.code).toBe(
      'stale_turn'
    );
    const t3 = await say(attemptId, 'c');
    expect(
      (
        await refusalOf(
          grading.offerNextStep(call(t3), { actions: ['next', 'next'] as unknown as ['next'] })
        )
      )?.code
    ).toBe('invalid_input');
  });

  // ─── scoring and counts ───────────────────────────────────────────────────

  it.each([
    [0, 100],
    [15, 85],
    [50, 50],
  ])('scores with the pinned hint cost %i', async (cost, credit) => {
    const quizId = await makeQuiz({ hint_cost: cost });
    const attemptId = await started(quizId);
    const t1 = await say(attemptId, 'wrong');
    await grading.offerNextStep(call(t1), { actions: [...TRY] });
    await reply(attemptId, [{ type: 'text', text: 'Feedback.' }]);
    await say(attemptId, BUTTON_TEXT.try_again);
    await reply(attemptId, [{ type: 'text', text: 'A hint. What do you think?' }]);
    const t2 = await say(attemptId, 'right');
    await grading.offerNextStep(call(t2), { actions: [...NEXT] });
    const next = await say(attemptId, BUTTON_TEXT.next);
    const answers: Answer[] = [
      { level: 'minimal', hints_before: 0 },
      { level: 'correct', hints_before: 1 },
    ];
    await grading.finalizeQuestion(call(next), {
      question_num: 1,
      answers,
      brief_feedback: 'Got there after a hint!',
    });
    const [stored] = (await attemptRow(attemptId)).question_results_json as Record<
      string,
      unknown
    >[];
    expect(stored.credit_earned).toBe(credit);
  });

  it('stores answers given, messages sent and hints used at finalize, and keeps a differing model count', async () => {
    const quizId = await makeQuiz({ max_answers: 5 });
    const attemptId = await started(quizId);
    // An answer (offer 1); a hint shown by the old button text; a side
    // question (a message, no offer); a typed "give me a hint" whose reply
    // failed (no hint shown); an answer (offer 2); Next.
    const a1 = await say(attemptId, 'first try');
    await grading.offerNextStep(call(a1), { actions: [...TRY] });
    await reply(attemptId, [{ type: 'text', text: 'Feedback.' }]);
    await say(attemptId, LEGACY_TRY_AGAIN_TEXT);
    await reply(attemptId, [{ type: 'text', text: 'A hint. What do you think?' }]);
    await say(attemptId, 'what does rem mean?');
    await reply(attemptId, [{ type: 'text', text: 'A unit.' }]);
    await say(attemptId, 'give me a hint!');
    await reply(attemptId, [{ type: 'data-notice', data: { code: 'reply_failed' } }]);
    const a2 = await say(attemptId, 'second try');
    await grading.offerNextStep(call(a2), { actions: [...NEXT] });
    const next = await say(attemptId, BUTTON_TEXT.next);
    // The model reports three answers; the server took two.
    const answers: Answer[] = [
      { level: 'minimal', hints_before: 0 },
      { level: 'minimal', hints_before: 1 },
      { level: 'correct', hints_before: 1 },
    ];
    await grading.finalizeQuestion(call(next), {
      question_num: 1,
      answers,
      brief_feedback: 'Got there after a hint!',
    });

    const [stored] = (await attemptRow(attemptId)).question_results_json as Record<
      string,
      unknown
    >[];
    expect(stored).toMatchObject({ answers_given: 2, messages_sent: 3, hints_used: 1 });
    const [journal] = await prisma.quizAttemptEvent.findMany({
      where: { attempt_id: attemptId, type: 'result_finalized' },
    });
    expect(journal.payload).toMatchObject({
      answers_given: 2,
      messages_sent: 3,
      hints_used: 1,
      reported_answer_count: 3,
    });

    // Staff read them; a student's transcript never carries them.
    const studentView = JSON.stringify(await chat.loadTranscriptForViewer(attemptId, 'student'));
    expect(studentView).not.toContain('answers_given');
    expect(studentView).not.toContain('messages_sent');
  });

  it('counts the open question when the server ends the attempt', async () => {
    const quizId = await makeQuiz();
    const attemptId = await started(quizId);
    const a1 = await say(attemptId, 'an answer');
    await grading.offerNextStep(call(a1), { actions: [...TRY] });
    const ender = await say(attemptId, 'more');
    const record = await grading.completeWithEvaluation(
      { attemptId, fence: ender.fence, inputMessageId: ender.inputMessageId, runId },
      { source: 'server', endedBy: 'turn_limit' }
    );
    expect(record.question_results).toEqual([
      expect.objectContaining({
        question_num: 1,
        skipped_by_end: true,
        answers_given: 1,
        messages_sent: 2,
        hints_used: 0,
      }),
      expect.objectContaining({
        question_num: 2,
        skipped_by_end: true,
        answers_given: 0,
        messages_sent: 0,
        hints_used: 0,
      }),
    ]);
  });

  // ─── the quiz settings ────────────────────────────────────────────────────

  it('saves the settings in range and refuses them out of range, writing nothing', async () => {
    const quizId = await makeQuiz();
    await quizService.update(quizId, { hintCost: 0, maxAnswers: 20 });
    expect(
      await prisma.quiz.findUniqueOrThrow({
        where: { id: quizId },
        select: { hint_cost: true, max_answers: true },
      })
    ).toEqual({ hint_cost: 0, max_answers: 20 });
    for (const bad of [{ hintCost: 51 }, { hintCost: -1 }, { maxAnswers: 0 }, { maxAnswers: 21 }]) {
      const refused = await refusalOf(quizService.update(quizId, { name: 'changed', ...bad }));
      expect(refused).toMatchObject({ name: 'QuizAssignmentError', code: 'invalid_value' });
    }
    const after = await prisma.quiz.findUniqueOrThrow({ where: { id: quizId } });
    expect(after).toMatchObject({ hint_cost: 0, max_answers: 20 });
    expect(after.name).not.toBe('changed');
  });
});
