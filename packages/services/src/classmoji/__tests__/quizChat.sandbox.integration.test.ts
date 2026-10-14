/**
 * Code sandbox questions in quizChat.service + quizGrading.service, against a
 * REAL Postgres: the pin, code-submission admission (its order of checks,
 * the stored row and journal, re-delivery by digest), the open-sandbox rule
 * read from the attempt's own rows under the lock, the hint sandbox a Try
 * again turn would carry (`sandboxStateOf`), and what the model reads.
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
import { convertToModelMessages } from 'ai';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const getPrisma = (await import('@classmoji/database')).default;
const grading = await import('../quizGrading.service.ts');
const chat = await import('../quizChat.service.ts');
const { BUTTON_TEXT, CONTRACT_VERSION, renderSubmissionForModel } =
  await import('@classmoji/utils/quiz-agent');

type Answer = {
  level: 'correct' | 'mostly_right' | 'partly_right' | 'minimal' | 'no_attempt';
  hints_before: number;
};

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

/** The starter files of question 1's sandbox. */
const STARTER = {
  '/index.js': "import './styles.css';\nconsole.log('start');\n",
  '/styles.css': 'body { margin: 0; }\n',
};
const SANDBOX = { template: 'vanilla' as const, files: STARTER, active_file: '/index.js' };

describe.skipIf(!RUN)('quiz chat: code sandbox questions (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let orgId: string;
  let classroomId: string;
  let otherClassroomId: string;
  let ownerId: string;
  let studentId: string;
  let otherStudentId: string;
  /** A quiz with the switch on, and one with it off. */
  let sandboxQuizId: string;
  let plainQuizId: string;
  const userIds: string[] = [];

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `qsbx-${suite}-${label}@example.test`, name: `Quiz Sandbox ${label}` },
    });
    userIds.push(user.id);
    return user.id;
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qsbx-${suite}`, login: `qsbx-org-${suite}` },
    });
    orgId = org.id;
    const classroom = (slug: string) =>
      prisma.classroom.create({
        data: {
          slug,
          git_org_id: orgId,
          name: `Quiz Sandbox ${slug}`,
          content_namespace: slug,
          content_repo: `content-${slug}`,
        },
      });
    classroomId = (await classroom(`qsbx-${suite}`)).id;
    otherClassroomId = (await classroom(`qsbx-y-${suite}`)).id;
    await prisma.classroomSettings.create({ data: { classroom_id: classroomId } });

    ownerId = await makeUser('owner');
    studentId = await makeUser('student');
    otherStudentId = await makeUser('student-b');
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classroomId, user_id: ownerId, role: 'OWNER', has_accepted_invite: true },
        {
          classroom_id: classroomId,
          user_id: studentId,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
        {
          classroom_id: classroomId,
          user_id: otherStudentId,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
        // Student A is in classroom Y too: a grant for Y still does not reach X's quiz.
        {
          classroom_id: otherClassroomId,
          user_id: studentId,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
      ],
    });
    await prisma.subscription.create({ data: { user_id: ownerId, tier: 'PRO' } });

    const quiz = (name: string, code_sandbox_enabled: boolean) =>
      prisma.quiz.create({
        data: {
          classroom_id: classroomId,
          name: `${name} ${suite}`,
          rubric_prompt: 'grade it',
          question_count: 3,
          status: 'PUBLISHED',
          max_attempts: 0,
          code_sandbox_enabled,
        },
      });
    sandboxQuizId = (await quiz('Sandbox quiz', true)).id;
    plainQuizId = (await quiz('Plain quiz', false)).id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  const grantFor = (userId: string, over: Record<string, unknown> = {}) => ({
    actor_user_id: userId,
    effective_user_id: userId,
    classroom_id: classroomId,
    role: 'STUDENT',
    web_session_id: 'web-session',
    impersonation: null,
    issued_at: new Date().toISOString(),
    ...over,
  });

  const newAttempt = async (
    o: { quizId?: string; userId?: string; grant?: object; agent_config?: object } = {}
  ) => {
    const userId = o.userId ?? studentId;
    const attempt = await prisma.quizAttempt.create({
      data: {
        quiz_id: o.quizId ?? sandboxQuizId,
        user_id: userId,
        agent_runtime: 'trigger_chat',
        contract_version: CONTRACT_VERSION,
        session_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        chat_grant: o.grant ?? grantFor(userId),
        ...(o.agent_config ? { agent_config: o.agent_config } : {}),
      },
    });
    return attempt.id;
  };

  const runId = 'run_test';
  const msgId = () => `m${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  type Turn = { attemptId: string; fence: string; inputMessageId: string | null; runId: string };

  const settle = (attemptId: string, agoMs = 10_000) =>
    prisma.quizAttemptEvent.updateMany({
      where: { attempt_id: attemptId, type: 'input_admitted' },
      data: { created_at: new Date(Date.now() - agoMs) },
    });

  const admit = async (i: Parameters<typeof chat.admitStudentMessage>[0]) => {
    await settle(i.attemptId);
    return chat.admitStudentMessage(i);
  };

  const say = async (attemptId: string, text: string, id = msgId()): Promise<Turn> => {
    const admitted = await admit({ attemptId, message: { id, text }, runId });
    return { attemptId, fence: admitted.fence, inputMessageId: admitted.inputMessageId, runId };
  };

  /** A code submission as the browser sends it, from question 1's card. */
  const submission = (over: Record<string, unknown> = {}) => ({
    sandbox_id: 'q1-1',
    files: { ...STARTER, '/index.js': "import './styles.css';\nconsole.log('done');\n" },
    console: [{ method: 'log', text: 'done' }],
    errors: [],
    ...over,
  });

  const submit = (attemptId: string, s: unknown, id = msgId()) =>
    admit({ attemptId, message: { id, submission: s }, runId });

  /** Submit and return what a tool call in that turn carries. */
  const submitTurn = async (attemptId: string, s: unknown, id = msgId()): Promise<Turn> => {
    const admitted = await submit(attemptId, s, id);
    return { attemptId, fence: admitted.fence, inputMessageId: admitted.inputMessageId, runId };
  };

  const begin = async (attemptId: string): Promise<Turn> => {
    const { fence } = await chat.admitAction({ attemptId, runId });
    return { attemptId, fence, inputMessageId: null, runId };
  };

  const call = (turn: Turn, toolCallId = `toolu_${randomUUID()}`) => ({ ...turn, toolCallId });

  const replyWith = async (attemptId: string, parts: unknown[], final = true) => {
    const id = `reply-${randomUUID()}`;
    await chat.persistAssistantMessage(attemptId, { id, role: 'assistant', parts } as never, {
      final,
    });
    return id;
  };

  /** A reply that showed the student something: the submission it answers stands. */
  const reply = (attemptId: string, text = 'Close. Look at the loop bound.') =>
    replyWith(attemptId, [{ type: 'text', text }]);

  const noticePart = (code = 'reply_failed') => ({ type: 'data-notice', data: { code } });

  const question = (n: number, sandbox: object | null = SANDBOX) => ({
    preamble: 'Next up.',
    question_number: n,
    total_questions: 3,
    question_text: `Fix question ${n}'s code and submit it.`,
    ...(sandbox ? { sandbox } : {}),
  });

  /**
   * Present question n in `turn` and save the reply that carries its card, as
   * the task's loop does.
   */
  const present = async (
    attemptId: string,
    turn: Turn,
    n: number,
    sandbox: object | null = SANDBOX
  ) => {
    const toolCallId = `toolu_${randomUUID()}`;
    const input = question(n, sandbox);
    const output = await grading.presentQuestion(call(turn, toolCallId), input as never);
    await replyWith(attemptId, [
      { type: 'tool-present_question', toolCallId, state: 'output-available', input, output },
    ]);
    return output;
  };

  /** A begun attempt on the sandbox quiz with question 1's sandbox card out. */
  const withCard = async (o: Parameters<typeof newAttempt>[0] = {}) => {
    const attemptId = await newAttempt(o);
    const turn = await begin(attemptId);
    await present(attemptId, turn, 1);
    return { attemptId, turn };
  };

  /** The hint sandbox a Try again reply carries (`data-sandbox`), as the loop writes it. */
  const hintPart = (data: Record<string, unknown>) => ({
    type: 'data-sandbox',
    id: `sandbox-${data.id as string}`,
    data,
  });

  const events = (attemptId: string, type?: string) =>
    prisma.quizAttemptEvent.findMany({
      where: { attempt_id: attemptId, ...(type ? { type } : {}) },
      orderBy: { seq: 'asc' },
    });

  const rows = (attemptId: string) => chat.loadCanonicalMessages(attemptId);

  const attemptRow = (attemptId: string) =>
    prisma.quizAttempt.findUniqueOrThrow({ where: { id: attemptId } });

  /** Nothing was admitted after `before` journal rows and `messages` rows. */
  const expectNothingWritten = async (
    attemptId: string,
    before: { events: number; messages: number }
  ) => {
    expect(await events(attemptId)).toHaveLength(before.events);
    expect(await rows(attemptId)).toHaveLength(before.messages);
  };

  const countsOf = async (attemptId: string) => ({
    events: (await events(attemptId)).length,
    messages: (await rows(attemptId)).length,
  });

  // ─── the pin ──────────────────────────────────────────────────────────────

  it("pins the quiz's switch at the first admission, and never changes it after", async () => {
    // Attempts that may carry sandboxes are stamped with contract 3.
    expect(CONTRACT_VERSION).toBe(3);
    const on = await newAttempt();
    await begin(on);
    expect((await attemptRow(on)).agent_config).toMatchObject({
      questionCount: 3,
      codeSandbox: true,
    });
    const off = await newAttempt({ quizId: plainQuizId });
    await say(off, 'hi');
    expect((await attemptRow(off)).agent_config).toMatchObject({ codeSandbox: false });

    // Turning the switch off does not change an attempt under way.
    await prisma.quiz.update({
      where: { id: sandboxQuizId },
      data: { code_sandbox_enabled: false },
    });
    try {
      await say(on, 'still pinned');
      expect((await attemptRow(on)).agent_config).toMatchObject({ codeSandbox: true });
    } finally {
      await prisma.quiz.update({
        where: { id: sandboxQuizId },
        data: { code_sandbox_enabled: true },
      });
    }

    // An attempt pinned before the switch existed never gets it.
    const older = await newAttempt({ agent_config: { questionCount: 3 } });
    await begin(older);
    expect((await attemptRow(older)).agent_config).toEqual({ questionCount: 3 });
  });

  // ─── admission ────────────────────────────────────────────────────────────

  it('admits a submission: the part with the server fields, its rendering and the status, hidden from viewers', async () => {
    const { attemptId } = await withCard();
    const id = msgId();
    const sent = submission();
    const admitted = await submit(attemptId, sent, id);
    expect(admitted).toMatchObject({ status: 'admitted', inputMessageId: id });
    expect(admitted.action).toBeUndefined();

    const stored = await prisma.aIConversationMessage.findFirstOrThrow({
      where: { ui_message_id: id },
    });
    const part = {
      ...sent,
      question_number: 1,
      attempt: 1,
      base_attempt: null,
      template: 'vanilla',
      changed_files: ['/index.js'],
    };
    const rendered = renderSubmissionForModel(part as never);
    expect(admitted.rendered).toBe(rendered);
    expect(stored.content).toBe(rendered);
    expect(stored.metadata).toEqual({ hiddenPartIndexes: [1, 2] });
    const parts = stored.parts as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'data-code-submission', data: part });
    expect(parts[1]).toEqual({ type: 'text', text: rendered });
    expect(parts[2]).toMatchObject({ type: 'text' });
    expect(String(parts[2].text)).toMatch(/^CURRENT STATUS/);
    expect(rendered).toContain(
      'Code submission: question 1, attempt 1 (changes vs the starter code)'
    );

    const [journal] = (await events(attemptId, 'input_admitted')).filter(
      e => e.input_message_id === id
    );
    expect(journal.payload).toEqual({
      kind: 'message',
      code: { sandbox_id: 'q1-1', digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(journal.turn_fence).toBe(admitted.fence);

    // Viewers get the submission alone; the model's two texts stay on the server.
    const transcript = await chat.loadTranscriptForViewer(attemptId);
    const mine = transcript.find(m => m.id === id)!;
    expect(mine.parts).toEqual([{ type: 'data-code-submission', data: part }]);
    expect(JSON.stringify(transcript)).not.toContain('CURRENT STATUS');
    const staff = await chat.loadTranscriptForViewer(attemptId, 'staff');
    expect(staff.find(m => m.id === id)!.parts).toEqual([
      { type: 'data-code-submission', data: part },
    ]);
  });

  it('gives the model no empty user message: every stored user row keeps a text part', async () => {
    const { attemptId } = await withCard();
    await submit(attemptId, submission());
    const messages = await rows(attemptId);
    for (const m of messages.filter(m => m.role === 'user')) {
      expect(m.parts.some(p => p.type === 'text')).toBe(true);
    }
    const model = await convertToModelMessages(messages);
    const users = model.filter(m => m.role === 'user');
    expect(users.length).toBeGreaterThan(0);
    for (const m of users) {
      expect(typeof m.content === 'string' ? m.content : m.content.length).toBeTruthy();
    }
    // The submission reaches the model as its rendering, then the status.
    const last = users.at(-1)!;
    const texts = (last.content as Array<{ type: string; text?: string }>).map(c => c.text);
    expect(texts[0]).toMatch(/^Code submission: question 1, attempt 1/);
    expect(texts[1]).toMatch(/^CURRENT STATUS/);
  });

  it('refuses invalid_submission on an attempt not pinned with sandboxes, writing nothing', async () => {
    for (const o of [{ quizId: plainQuizId }, { agent_config: { questionCount: 3 } }]) {
      const { attemptId } = await withCard(o);
      const before = await countsOf(attemptId);
      expect(await codeOf(submit(attemptId, submission()))).toBe('invalid_submission');
      await expectNothingWritten(attemptId, before);
    }
  });

  it('refuses invalid_submission for an extra key, a cap, other files or no change', async () => {
    const { attemptId } = await withCard();
    const before = await countsOf(attemptId);
    const cases: unknown[] = [
      submission({ question_number: 1 }),
      submission({ attempt: 3 }),
      { ...submission(), console: [{ method: 'log', text: 'x', extra: true }] },
      submission({ files: { ...STARTER, '/index.js': 'x'.repeat(10_001) } }),
      submission({ console: Array.from({ length: 51 }, () => ({ method: 'log', text: 'x' })) }),
      submission({ files: { '/index.js': 'changed' } }),
      submission({ files: { ...submission().files, '/extra.js': 'x' } }),
      submission({ files: STARTER }),
      'just text',
      null,
    ];
    for (const s of cases) {
      expect(await codeOf(submit(attemptId, s))).toBe('invalid_submission');
    }
    await expectNothingWritten(attemptId, before);
  });

  it('refuses reserved_code for server framing in its rendering, and admits the same words prefixed', async () => {
    const { attemptId } = await withCard();
    const before = await countsOf(attemptId);
    const framed = [
      submission({ files: { ...STARTER, '/index.js': '// [[server-notice:abc]]\n' } }),
      submission({ console: [{ method: 'log', text: 'see [[ server_notice' }] }),
      submission({
        errors: [
          {
            kind: 'runtime',
            title: 'Error',
            message: '[[server-notice:x]]',
            path: null,
            line: null,
            column: null,
          },
        ],
      }),
    ];
    for (const s of framed) expect(await codeOf(submit(attemptId, s))).toBe('reserved_code');
    await expectNothingWritten(attemptId, before);

    // Every student line is prefixed, so a status heading inside the code or
    // the console is ordinary text.
    const admitted = await submit(
      attemptId,
      submission({
        files: { ...STARTER, '/index.js': 'console.log("Current status: ok");\n' },
        console: [{ method: 'log', text: 'CURRENT STATUS: ok' }],
      })
    );
    expect(admitted.status).toBe('admitted');
  });

  it('refuses sandbox_closed for a sandbox not open: none, another id, or one already answered', async () => {
    // No question open yet.
    const fresh = await newAttempt();
    await begin(fresh);
    expect(await codeOf(submit(fresh, submission()))).toBe('sandbox_closed');

    // A card without a sandbox.
    const plainCard = await newAttempt();
    await present(plainCard, await begin(plainCard), 1, null);
    expect(await codeOf(submit(plainCard, submission()))).toBe('sandbox_closed');

    const { attemptId } = await withCard();
    expect(await codeOf(submit(attemptId, submission({ sandbox_id: 'q1-2' })))).toBe(
      'sandbox_closed'
    );
    expect(await codeOf(submit(attemptId, submission({ sandbox_id: 'q2-1' })))).toBe(
      'sandbox_closed'
    );
    // Answered: its submission's reply stood.
    await submit(attemptId, submission());
    await reply(attemptId);
    const before = await countsOf(attemptId);
    expect(
      await codeOf(
        submit(attemptId, submission({ files: { ...STARTER, '/index.js': 'console.log(2);\n' } }))
      )
    ).toBe('sandbox_closed');
    await expectNothingWritten(attemptId, before);
  });

  it('leaves the sandbox open after a reply that failed or never arrived', async () => {
    const { attemptId } = await withCard();
    await submit(attemptId, submission());
    // The reply failed part way: a notice, its text dropped.
    await replyWith(attemptId, [{ type: 'text', text: 'Clo' }, noticePart()], false);
    const second = submission({ files: { ...STARTER, '/index.js': 'console.log(2);\n' } });
    const admitted = await submit(attemptId, second);
    expect(admitted.status).toBe('admitted');
    // Still attempt 1: no submission of it stood.
    expect(admitted.rendered).toMatch(/^Code submission: question 1, attempt 1 /);
    // No reply at all, and the student submits again.
    const third = await submit(
      attemptId,
      submission({ files: { ...STARTER, '/index.js': 'console.log(3);\n' } })
    );
    expect(third.status).toBe('admitted');
  });

  it('runs the turn-limit completion and the pace check before the sandbox check', async () => {
    const { attemptId } = await withCard();
    await submit(attemptId, submission());
    // Within 3 s of that admission, a submission naming no open sandbox is too fast.
    expect(
      await codeOf(
        chat.admitStudentMessage({
          attemptId,
          message: { id: msgId(), submission: submission({ sandbox_id: 'q9-1' }) },
          runId,
        })
      )
    ).toBe('too_fast');

    // The journal as 200 admitted messages would leave it.
    const admitted = (await events(attemptId, 'input_admitted')).filter(
      e => (e.payload as { kind?: string }).kind === 'message'
    ).length;
    await prisma.quizAttemptEvent.createMany({
      data: Array.from({ length: chat.MAX_STUDENT_TURNS - admitted }, (_, k) => ({
        attempt_id: attemptId,
        seq: 1_000 + k,
        type: 'input_admitted',
        operation_id: `seeded-${k}`,
        payload: { kind: 'message' },
        created_at: new Date(Date.now() - 60_000),
      })),
    });
    const refusal = submit(attemptId, submission({ sandbox_id: 'q9-1' }));
    await expect(refusal).rejects.toMatchObject({ code: 'turn_limit', kind: 'permanent' });
    expect((await attemptRow(attemptId)).completed_at).not.toBeNull();
  });

  // ─── re-delivery ──────────────────────────────────────────────────────────

  it('re-delivers the same submission by its digest, even once its sandbox has closed', async () => {
    const { attemptId } = await withCard();
    const id = msgId();
    const sent = submission();
    const first = await submit(attemptId, sent, id);
    // The same input, its keys in another order: the same digest.
    const reordered = {
      errors: [],
      console: [{ text: 'done', method: 'log' }],
      files: { '/styles.css': STARTER['/styles.css'], '/index.js': sent.files['/index.js'] },
      sandbox_id: 'q1-1',
    };
    const again = await submit(attemptId, reordered, id);
    expect(again).toMatchObject({
      status: 'redelivered',
      inputMessageId: id,
      rendered: first.rendered,
    });
    expect(again.fence).not.toBe(first.fence);

    // Its reply stood (the sandbox is answered): a re-delivery is still taken.
    await replyWith(attemptId, [
      {
        type: 'tool-offer_next_step',
        toolCallId: 'toolu_offer',
        state: 'output-available',
        input: { feedback: 'Nearly.', actions: ['try_again', 'next'] },
        output: {
          actions: ['try_again', 'next'],
          lead_in: 'Would you like to try again or move on?',
        },
      },
    ]);
    const late = await submit(attemptId, sent, id);
    expect(late.status).toBe('redelivered');
    expect((await rows(attemptId)).filter(m => m.id === id)).toHaveLength(1);
    expect(
      (await events(attemptId, 'input_admitted')).filter(e => e.input_message_id === id)
    ).toHaveLength(1);
  });

  it('refuses a different submission, text on a code id and code on a text id as a conflict', async () => {
    const { attemptId } = await withCard();
    const codeId = msgId();
    await submit(attemptId, submission(), codeId);
    expect(
      await codeOf(
        submit(attemptId, submission({ console: [{ method: 'log', text: 'other' }] }), codeId)
      )
    ).toBe('message_conflict');
    expect(await codeOf(admit({ attemptId, message: { id: codeId, text: 'hi' }, runId }))).toBe(
      'message_conflict'
    );

    const textId = msgId();
    await say(attemptId, 'my answer', textId);
    expect(await codeOf(submit(attemptId, submission(), textId))).toBe('message_conflict');
  });

  // ─── hints and grading ────────────────────────────────────────────────────

  it("counts a submission as a typed answer when it floors the answers' hint counts", async () => {
    const { attemptId } = await withCard();
    await submit(attemptId, submission());
    await reply(attemptId);
    await say(attemptId, BUTTON_TEXT.try_again);
    const hint = (await chat.sandboxStateOf(attemptId)).nextHint!;
    await replyWith(attemptId, [
      { type: 'text', text: 'Check the bound. What do you think?' },
      hintPart(hint),
    ]);
    const second = await submitTurn(
      attemptId,
      submission({
        sandbox_id: 'q1-2',
        files: { ...submission().files, '/index.js': 'console.log(4);\n' },
      })
    );
    await reply(attemptId, 'Right.');
    const next = await say(attemptId, BUTTON_TEXT.next);
    const reported: Answer[] = [
      { level: 'partly_right', hints_before: 0 },
      { level: 'correct', hints_before: 0 },
    ];
    await grading.finalizeQuestion(call(next), {
      question_num: 1,
      answers: reported,
      brief_feedback: 'Fixed it with a hint.',
    });
    const [row] = await events(attemptId, 'result_finalized');
    expect(row.payload).toMatchObject({
      answers: [
        { level: 'partly_right', hints_before: 0 },
        { level: 'correct', hints_before: 1 },
      ],
      reported_answers: reported,
    });
    expect(second.fence).toBeTruthy();
  });

  it('numbers a submission from the hint sandbox as the next attempt, compared with the last one', async () => {
    const { attemptId } = await withCard();
    const first = submission();
    await submit(attemptId, first);
    await reply(attemptId);
    await say(attemptId, BUTTON_TEXT.try_again);
    const hint = (await chat.sandboxStateOf(attemptId)).nextHint!;
    expect(hint).toEqual({
      id: 'q1-2',
      question_number: 1,
      attempt: 2,
      seeded_from: 1,
      template: 'vanilla',
      files: first.files,
      active_file: '/index.js',
    });
    await replyWith(attemptId, [
      { type: 'text', text: 'A hint. What do you think?' },
      hintPart(hint),
    ]);
    // The card's sandbox is answered; the hint's is the open one.
    expect(
      await codeOf(submit(attemptId, submission({ files: { ...STARTER, '/index.js': 'x' } })))
    ).toBe('sandbox_closed');
    const id = msgId();
    await submit(
      attemptId,
      submission({ sandbox_id: 'q1-2', files: { ...first.files, '/styles.css': 'body {}\n' } }),
      id
    );
    const stored = await prisma.aIConversationMessage.findFirstOrThrow({
      where: { ui_message_id: id },
    });
    expect((stored.parts as Array<{ data?: unknown }>)[0].data).toMatchObject({
      sandbox_id: 'q1-2',
      question_number: 1,
      attempt: 2,
      base_attempt: 1,
      changed_files: ['/styles.css'],
    });
  });

  it('keeps a hint sandbox in a partial reply exactly when its text is kept', async () => {
    const { attemptId } = await withCard();
    await submit(attemptId, submission());
    await reply(attemptId);
    await say(attemptId, BUTTON_TEXT.try_again);
    const hint = (await chat.sandboxStateOf(attemptId)).nextHint!;
    const step = { type: 'step-start' };

    // Stopped by the student once the hint had text: both stay.
    const stopped = await replyWith(
      attemptId,
      [step, { type: 'text', text: 'Look at the' }, hintPart(hint)],
      false
    );
    let saved = (await rows(attemptId)).find(m => m.id === stopped)!;
    expect(saved.parts.map(p => p.type)).toEqual(['step-start', 'text', 'data-sandbox']);

    // Failed: the notice drops the text, and the sandbox with it.
    await say(attemptId, BUTTON_TEXT.try_again);
    const failed = await replyWith(
      attemptId,
      [step, { type: 'text', text: 'Look at the' }, hintPart(hint), noticePart()],
      false
    );
    expect((await rows(attemptId)).find(m => m.id === failed)).toBeUndefined();

    // Stopped with only blank text: nothing was shown, so no sandbox either.
    await say(attemptId, BUTTON_TEXT.try_again);
    const blank = await replyWith(
      attemptId,
      [step, { type: 'text', text: '  ' }, hintPart(hint)],
      false
    );
    expect((await rows(attemptId)).find(m => m.id === blank)).toBeUndefined();
    saved = (await rows(attemptId)).find(m => m.id === stopped)!;
    expect(saved.parts.some(p => p.type === 'data-sandbox')).toBe(true);
  });

  // ─── sandboxStateOf ───────────────────────────────────────────────────────

  it('sandboxStateOf: no hint sandbox with no question open, a card without one, or one still open', async () => {
    // No question open: none presented yet.
    const fresh = await newAttempt();
    await begin(fresh);
    expect(await chat.sandboxStateOf(fresh)).toEqual({ nextHint: null });

    // The open card has no sandbox.
    const plainCard = await newAttempt();
    const turn = await begin(plainCard);
    await present(plainCard, turn, 1, null);
    await say(plainCard, 'my answer');
    await reply(plainCard);
    await say(plainCard, BUTTON_TEXT.try_again);
    expect(await chat.sandboxStateOf(plainCard)).toEqual({ nextHint: null });

    // An unanswered sandbox is still open (the student typed their answer).
    const { attemptId } = await withCard();
    await say(attemptId, 'my answer in words');
    await reply(attemptId);
    await say(attemptId, BUTTON_TEXT.try_again);
    expect(await chat.sandboxStateOf(attemptId)).toEqual({ nextHint: null });

    // No question open: its result is recorded.
    const recorded = await withCard();
    await submit(recorded.attemptId, submission());
    await reply(recorded.attemptId);
    const next = await say(recorded.attemptId, BUTTON_TEXT.next);
    await grading.finalizeQuestion(call(next), {
      question_num: 1,
      answers: [{ level: 'correct', hints_before: 0 }],
      brief_feedback: 'Done.',
    });
    expect(await chat.sandboxStateOf(recorded.attemptId)).toEqual({ nextHint: null });

    // An attempt not pinned with sandboxes never gets one.
    const plain = await withCard({ quizId: plainQuizId });
    expect(await chat.sandboxStateOf(plain.attemptId)).toEqual({ nextHint: null });
  });

  it('sandboxStateOf seeds the hint from the last standing submission, and finds a card the rows lost', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    // The card's reply was never saved: the journal still has the card.
    await grading.presentQuestion(call(turn), question(1) as never);
    const failedFirst = submission({ files: { ...STARTER, '/index.js': 'console.log(1);\n' } });
    await submit(attemptId, failedFirst);
    await replyWith(attemptId, [noticePart()], false);
    const standing = submission({ files: { ...STARTER, '/index.js': 'console.log(2);\n' } });
    await submit(attemptId, standing);
    await reply(attemptId);
    await say(attemptId, BUTTON_TEXT.try_again);
    expect((await chat.sandboxStateOf(attemptId)).nextHint).toMatchObject({
      id: 'q1-2',
      attempt: 2,
      seeded_from: 1,
      files: standing.files,
    });
  });

  // ─── present_question ─────────────────────────────────────────────────────

  it('refuses a re-shown card with another sandbox, and returns the stored one without', async () => {
    const attemptId = await newAttempt();
    const turn = await begin(attemptId);
    const original = await present(attemptId, turn, 1);
    const later = await say(attemptId, 'show me the question again');
    const changed = { ...SANDBOX, files: { ...STARTER, '/index.js': 'console.log("new");\n' } };
    const refused = grading.presentQuestion(call(later), question(1, changed) as never);
    await expect(refused).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      grading.presentQuestion(call(later), question(1, changed) as never)
    ).rejects.toThrow(/already out with its sandbox/);
    expect(await grading.presentQuestion(call(later), question(1, null) as never)).toEqual(
      original
    );
    expect(await grading.presentQuestion(call(later), question(1) as never)).toEqual(original);
    expect(await events(attemptId, 'question_presented')).toHaveLength(1);

    // A card that had none gets none on a re-show.
    const plain = await newAttempt();
    await present(plain, await begin(plain), 1, null);
    const ask = await say(plain, 'again please');
    expect(await codeOf(grading.presentQuestion(call(ask), question(1) as never))).toBe(
      'invalid_input'
    );
  });

  // ─── scoping ──────────────────────────────────────────────────────────────

  it('refuses a submission under a grant naming another user or another classroom (user A vs B, classroom X vs Y)', async () => {
    const { attemptId } = await withCard();
    const before = await countsOf(attemptId);
    for (const grant of [
      grantFor(otherStudentId),
      grantFor(studentId, { effective_user_id: otherStudentId }),
      grantFor(studentId, { classroom_id: otherClassroomId }),
    ]) {
      await prisma.quizAttempt.update({ where: { id: attemptId }, data: { chat_grant: grant } });
      await expect(submit(attemptId, submission())).rejects.toMatchObject({
        code: 'session_ended',
        kind: 'temporary',
      });
    }
    await expectNothingWritten(attemptId, before);
    await prisma.quizAttempt.update({
      where: { id: attemptId },
      data: { chat_grant: grantFor(studentId) },
    });
    expect((await submit(attemptId, submission())).status).toBe('admitted');
  });

  it("reads the open sandbox from the attempt's own rows: B cannot submit to A's sandbox", async () => {
    const a = await withCard();
    const b = await newAttempt({ userId: otherStudentId });
    await begin(b);
    // B has no card out; A's open sandbox id means nothing on B's attempt.
    expect(await codeOf(submit(b, submission()))).toBe('sandbox_closed');
    expect((await submit(a.attemptId, submission())).status).toBe('admitted');
    // B's own card opens B's sandbox, numbered from B's rows alone.
    await present(b, await say(b, 'ready'), 1);
    const admitted = await submit(b, submission());
    expect(admitted.rendered).toMatch(/^Code submission: question 1, attempt 1 /);
  });
});
