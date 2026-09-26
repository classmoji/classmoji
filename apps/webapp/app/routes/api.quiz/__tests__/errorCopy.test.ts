import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * api.quiz — what a failure looks like from the browser.
 *
 *   - A classroom whose quizzes are not visible (not on Pro, or quizzes
 *     switched off) gets a 403 with a fixed body the quiz UI branches on
 *     (`code: 'QUIZZES_UNAVAILABLE'`), not a thrown Response that the action's
 *     catch turned into a 500.
 *   - A gate's own thrown Response (access, classroom status) goes back as-is,
 *     with its own status and body.
 *   - Anything else, a failed visibility lookup included, is logged
 *     server-side and answered with fixed copy.
 *   - A failed quiz reply is saved into the transcript, which students and
 *     staff both read, so it is fixed copy too, and its metadata carries the
 *     error's code and nothing of its text.
 *   - A failure after the ai-agent has replied (its reply is saved) is logged
 *     and answered as a success: no failed-reply line, nothing to resend.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const addMessageMock = vi.fn();
const completeAttemptMock = vi.fn();
const auditCreateMock = vi.fn();

const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const assertMutationMock = vi.fn();
const sendMessageToAgentMock = vi.fn();
const endQuizSessionMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: vi.fn(),
      incrementQuestionsAsked: vi.fn(),
      completeAttempt: (...a: unknown[]) => completeAttemptMock(...a),
    },
    gitRepo: { findByStudent: vi.fn() },
    aiConversation: { addMessage: (...a: unknown[]) => addMessageMock(...a) },
    audit: { create: (...a: unknown[]) => auditCreateMock(...a) },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertMutationMock(...a),
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => true,
}));

vi.mock('~/utils/backgroundTask.server', () => ({
  runBackgroundTask: vi.fn(),
}));

vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));

vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: vi.fn(),
  sendMessageToAgent: (...a: unknown[]) => sendMessageToAgentMock(...a),
  endQuizSession: (...a: unknown[]) => endQuizSessionMock(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({ token: 'ghu_token', session: {} })),
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const ATTEMPT_ID = 'attempt-own';
const RAW =
  "Invalid `prisma.quizAttempt.update()` invocation: Can't reach database server at db.internal:5432";

const post = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const ownAttempt = {
  id: ATTEMPT_ID,
  quiz_id: QUIZ_ID,
  user_id: 'student-1',
  quiz: {
    id: QUIZ_ID,
    classroom_id: 'class-1',
    repository_id: null,
    include_code_context: false,
    classroom: { slug: 'test-class', settings: {}, git_organization: { login: 'test-org' } },
  },
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  quizFindByIdMock.mockResolvedValue({ id: QUIZ_ID, classroom_id: 'class-1' });
  findWithMessagesMock.mockResolvedValue({
    attempt: ownAttempt,
    messages: [],
    questionsAsked: 1,
    questionCount: 5,
  });
  attemptFindByIdMock.mockResolvedValue(ownAttempt);
  createNewMock.mockResolvedValue({ success: true, attemptId: 'attempt-new' });
  addMessageMock.mockResolvedValue(undefined);
  completeAttemptMock.mockResolvedValue(undefined);
  endQuizSessionMock.mockResolvedValue(undefined);

  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: { role: 'STUDENT' },
  });
  quizzesVisibleMock.mockResolvedValue(true);
  assertMutationMock.mockReturnValue(undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('api.quiz — refusals and failures', () => {
  it('answers a classroom whose quizzes are not visible with the fixed 403 body', async () => {
    quizzesVisibleMock.mockResolvedValue(false);

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'QUIZZES_UNAVAILABLE',
      message: "Quizzes aren't available in this class.",
    });
    // Checked for the classroom the access gate authorized, and nothing past
    // the refusal ran.
    expect(quizzesVisibleMock).toHaveBeenCalledWith('class-1');
    expect(createNewMock).not.toHaveBeenCalled();
  });

  it('answers a failed visibility lookup as a failure, not as the refusal', async () => {
    quizzesVisibleMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(body)).not.toContain('QUIZZES_UNAVAILABLE');
    expect(createNewMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain(RAW);
  });

  it('refuses sendMessage the same way', async () => {
    quizzesVisibleMock.mockResolvedValue(false);

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'QUIZZES_UNAVAILABLE' });
    expect(sendMessageToAgentMock).not.toHaveBeenCalled();
  });

  it("returns an access gate's thrown Response as-is", async () => {
    assertAccessMock.mockRejectedValue(
      new Response('Not a member of this classroom', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Not a member of this classroom');
  });

  it("returns the classroom-status gate's JSON refusal as-is", async () => {
    const body = {
      error: 'CLASSROOM_LOCKED',
      message: 'This class is in read-only mode. The owner has locked it.',
    };
    assertMutationMock.mockImplementation(() => {
      throw new Response(JSON.stringify(body), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(body);
  });

  it('answers any other failure with fixed copy and logs the real error', async () => {
    quizFindByIdMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'startQuiz', quizId: QUIZ_ID });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(body)).not.toContain('db.internal');
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain(RAW);
  });

  it('answers a failed restart with its own fixed copy', async () => {
    createNewMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      message: "Couldn't start a new attempt. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain('db.internal');
  });
});

describe('api.quiz sendMessage — a failed reply in the transcript', () => {
  const REPLY_FAILED = "That reply couldn't be finished. Please send your message again.";

  const savedReply = () => {
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const [attemptId, role, content, , metadata] = addMessageMock.mock.calls[0];
    expect(attemptId).toBe(ATTEMPT_ID);
    expect(role).toBe('ASSISTANT');
    return { content: content as string, metadata: metadata as Record<string, unknown> };
  };

  it('saves fixed copy, and only the code, for an ai-agent failure', async () => {
    sendMessageToAgentMock.mockRejectedValue(
      Object.assign(new Error('Something went wrong. Please try again.'), {
        code: 'RESPONSE_FAILED',
        detail: RAW,
      })
    );

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(200);
    const { content, metadata } = savedReply();
    expect(content).toBe(REPLY_FAILED);
    expect(metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'RESPONSE_FAILED' });
    expect(JSON.stringify({ content, metadata })).not.toContain('db.internal');
  });

  it('saves the same line for a timeout, with no code', async () => {
    sendMessageToAgentMock.mockRejectedValue(
      new Error('Request timeout after 300000ms for requestId: 1234')
    );

    await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    const { content, metadata } = savedReply();
    expect(content).toBe(REPLY_FAILED);
    expect(metadata).toEqual({ errorType: 'AGENT_FAILURE', code: null });
    expect(JSON.stringify({ content, metadata })).not.toContain('requestId');
  });

  it('saves the same line for an API_ERROR, keeping its code', async () => {
    // aiAgentConnection gives an API_ERROR its generic line and keeps the
    // ai-agent's text on `detail`; neither is saved.
    const busy = 'The AI service is temporarily busy. Please wait a moment and try again.';
    sendMessageToAgentMock.mockRejectedValue(
      Object.assign(new Error('Something went wrong. Please try again.'), {
        code: 'API_ERROR',
        retryable: true,
        detail: busy,
      })
    );

    await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    const { content, metadata } = savedReply();
    expect(content).toBe(REPLY_FAILED);
    expect(metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'API_ERROR' });
    expect(JSON.stringify({ content, metadata })).not.toContain('busy');
  });

  it("keeps the ai-agent's own text for a BUDGET_EXCEEDED stop", async () => {
    sendMessageToAgentMock.mockRejectedValue(
      Object.assign(new Error(REPLY_FAILED), { code: 'BUDGET_EXCEEDED', retryable: true })
    );

    await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    const { content, metadata } = savedReply();
    expect(content).toBe(REPLY_FAILED);
    expect(metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'BUDGET_EXCEEDED' });
  });

  it('saves and answers the reply-failed line when saving the ai-agent failure fails', async () => {
    sendMessageToAgentMock.mockRejectedValue(
      Object.assign(new Error('Something went wrong. Please try again.'), {
        code: 'RESPONSE_FAILED',
      })
    );
    addMessageMock.mockRejectedValueOnce(new Error(RAW));

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: false, error: REPLY_FAILED });
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock).toHaveBeenLastCalledWith(ATTEMPT_ID, 'ASSISTANT', REPLY_FAILED, false, {
      errorType: 'GENERAL_FAILURE',
    });
    expect(JSON.stringify(body)).not.toContain('db.internal');
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain(RAW);
  });
});

describe('api.quiz sendMessage — a failure after the reply', () => {
  // The last question answered with an evaluation, so the route goes on to
  // complete the attempt after the ai-agent has replied.
  const FINAL_REPLY = 'Question 5 of 5\n\n[QUIZ_EVALUATION]\n```json\n{"quiz_complete": true}\n```';

  beforeEach(() => {
    sendMessageToAgentMock.mockResolvedValue({ content: FINAL_REPLY });
  });

  it('answers success, saves no line, and logs the real error', async () => {
    // The reply is already saved; the quiz page completes the attempt itself
    // when it sees the evaluation, so the student is not asked to resend.
    completeAttemptMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });
    const body = await response.json();

    expect(completeAttemptMock).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain(RAW);
  });

  it('returns a thrown Response as-is and saves nothing', async () => {
    completeAttemptMock.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
    expect(addMessageMock).not.toHaveBeenCalled();
  });
});

describe('api.quiz sendMessage — a failure before ownership is known', () => {
  it("writes nothing to another student's transcript when refusing fails", async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...ownAttempt, user_id: 'someone-else' },
      messages: [],
      questionsAsked: 1,
      questionCount: 5,
    });
    auditCreateMock.mockRejectedValue(new Error(RAW));

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ success: false, error: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(body)).not.toContain('prisma');
    expect(addMessageMock).not.toHaveBeenCalled();
    expect(sendMessageToAgentMock).not.toHaveBeenCalled();
  });
});
