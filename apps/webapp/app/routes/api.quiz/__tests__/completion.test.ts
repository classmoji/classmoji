import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * api.quiz — completing an attempt, and whose attempts a caller may act on.
 *
 *   - completeQuiz completes the caller's own finished attempt and ends its
 *     ai-agent session. The services refuse an attempt that is not finished (a
 *     question without a recorded result, QUIZ_ATTEMPT_INCOMPLETE); the route
 *     answers that with a 409 and fixed copy, and ends nothing.
 *   - The server-side completion after the last reply leaves an unfinished
 *     attempt open and still answers the reply as a success.
 *   - Every attempt action admits the caller's own attempts only. While an
 *     admin views as a student, the caller IS that student (assertClassroomAccess
 *     resolves the session's user), so the student's attempts are reachable and
 *     no one else's are.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const attemptFindByIdMock = vi.fn();
const createNewMock = vi.fn();
const addMessageMock = vi.fn();
const completeAttemptMock = vi.fn();
const updateDurationsMock = vi.fn();
const recordModalClosedMock = vi.fn();
const modalGapMock = vi.fn();
const auditCreateMock = vi.fn();
const updateAgentConfigMock = vi.fn();

const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const assertMutationMock = vi.fn();
const sendMessageToAgentMock = vi.fn();
const endQuizSessionMock = vi.fn();
const getAuthSessionMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: {
      findById: (...a: unknown[]) => attemptFindByIdMock(...a),
      findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a),
      createNew: (...a: unknown[]) => createNewMock(...a),
      updateAgentConfig: (...a: unknown[]) => updateAgentConfigMock(...a),
      incrementQuestionsAsked: vi.fn(),
      completeAttempt: (...a: unknown[]) => completeAttemptMock(...a),
      updateDurations: (...a: unknown[]) => updateDurationsMock(...a),
      recordModalClosed: (...a: unknown[]) => recordModalClosedMock(...a),
      calculateAndApplyModalGap: (...a: unknown[]) => modalGapMock(...a),
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
  gitlabProjectAccess: vi.fn(),
}));

vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: vi.fn(),
  sendMessageToAgent: (...a: unknown[]) => sendMessageToAgentMock(...a),
  endQuizSession: (...a: unknown[]) => endQuizSessionMock(...a),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
}));

vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: vi.fn(async () => ({
    accessToken: 'mcp-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  })),
}));

// GitHub, for a preview's repository: the caller's own account opens it
// (previewRepoAccess.test.ts covers the refusals).
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    rest = { repos: { get: vi.fn(async () => ({ status: 200, data: {} })) } };
  },
}));

const { action } = await import('../route.ts');

const QUIZ_ID = 'quiz-1';
const ATTEMPT_ID = 'attempt-1';
const STUDENT = 'student-1';
const OTHER_STUDENT = 'student-2';

const post = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const attemptOf = (userId: string) => ({
  id: ATTEMPT_ID,
  quiz_id: QUIZ_ID,
  user_id: userId,
  completed_at: null,
  quiz: {
    id: QUIZ_ID,
    classroom_id: 'class-1',
    repository_id: null,
    include_code_context: false,
    classroom: { slug: 'test-class', settings: {}, git_organization: { login: 'test-org' } },
  },
});

const incompleteError = () =>
  Object.assign(new Error('Quiz attempt is not finished'), { code: 'QUIZ_ATTEMPT_INCOMPLETE' });

/** The caller is the student; `viewingAs` marks the session as an admin's "View As". */
const signInAs = (userId: string, { viewingAs = false, role = 'STUDENT' } = {}) => {
  assertAccessMock.mockResolvedValue({
    userId,
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: { role },
  });
  getAuthSessionMock.mockResolvedValue({
    userId,
    token: null,
    session: {
      user: { id: userId },
      session: { id: 'sess-1', ...(viewingAs ? { impersonatedBy: 'admin-1' } : {}) },
    },
  });
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  quizFindByIdMock.mockResolvedValue({ id: QUIZ_ID, classroom_id: 'class-1' });
  attemptFindByIdMock.mockResolvedValue(attemptOf(STUDENT));
  findWithMessagesMock.mockResolvedValue({
    attempt: attemptOf(STUDENT),
    messages: [],
    questionsAsked: 1,
    questionCount: 5,
  });
  createNewMock.mockResolvedValue({ success: true, attemptId: 'attempt-new' });
  addMessageMock.mockResolvedValue(undefined);
  completeAttemptMock.mockResolvedValue({ id: ATTEMPT_ID });
  updateDurationsMock.mockResolvedValue({});
  recordModalClosedMock.mockResolvedValue({});
  modalGapMock.mockResolvedValue({ gapApplied: false, gapMs: 0 });
  endQuizSessionMock.mockResolvedValue(undefined);
  auditCreateMock.mockResolvedValue(undefined);
  quizzesVisibleMock.mockResolvedValue(true);
  assertMutationMock.mockReturnValue(undefined);
  signInAs(STUDENT);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('api.quiz completeQuiz', () => {
  it('completes a finished attempt and ends its session', async () => {
    const response = await post({
      _action: 'completeQuiz',
      attemptId: ATTEMPT_ID,
      totalDurationMs: 5000,
      unfocusedDurationMs: 200,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(completeAttemptMock).toHaveBeenCalledWith(ATTEMPT_ID, {
      totalDurationMs: 5000,
      unfocusedDurationMs: 200,
    });
    expect(endQuizSessionMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });

  it('answers an unfinished attempt with a 409 and fixed copy, ending nothing', async () => {
    completeAttemptMock.mockRejectedValue(incompleteError());

    const response = await post({ _action: 'completeQuiz', attemptId: ATTEMPT_ID });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      code: 'QUIZ_NOT_FINISHED',
      message: "This quiz isn't finished yet. Send a message to continue.",
    });
    expect(endQuizSessionMock).not.toHaveBeenCalled();
  });

  it('answers an already completed attempt as today (the services leave it as it is)', async () => {
    attemptFindByIdMock.mockResolvedValue({
      ...attemptOf(STUDENT),
      completed_at: new Date('2026-09-28T10:00:00Z'),
    });

    const response = await post({ _action: 'completeQuiz', attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(completeAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("refuses another student's attempt and records the refusal", async () => {
    attemptFindByIdMock.mockResolvedValue(attemptOf(OTHER_STUDENT));

    const response = await post({ _action: 'completeQuiz', attemptId: ATTEMPT_ID });

    expect(response.status).toBe(403);
    expect(completeAttemptMock).not.toHaveBeenCalled();
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'QUIZ_ATTEMPT_COMPLETE_UNAUTHORIZED',
        action: 'ACCESS_DENIED',
      })
    );
  });
});

describe('api.quiz sendMessage — completing after the last reply', () => {
  const FINAL_REPLY = 'Question 5 of 5\n\n[QUIZ_EVALUATION]\n```json\n{"quiz_complete": true}\n```';

  it('leaves an unfinished attempt open and still answers the reply as a success', async () => {
    sendMessageToAgentMock.mockResolvedValue({ content: FINAL_REPLY });
    completeAttemptMock.mockRejectedValue(incompleteError());

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(completeAttemptMock).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(addMessageMock).not.toHaveBeenCalled();
  });
});

describe('api.quiz sendMessage — completion follows the evaluation, not question numbers', () => {
  it('does not complete on a reply that only names the last question', async () => {
    sendMessageToAgentMock.mockResolvedValue({ content: '**Question 5 of 5** What is a closure?' });

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(200);
    expect(completeAttemptMock).not.toHaveBeenCalled();
  });

  it('asks the services to complete on a reply carrying the evaluation', async () => {
    // questions_asked is 1 here: the services decide whether it is finished.
    sendMessageToAgentMock.mockResolvedValue({
      content: 'Done!\n\n[QUIZ_EVALUATION]\n```json\n{"quiz_complete": true}\n```',
    });

    await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(completeAttemptMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });
});

describe('api.quiz — viewing as a student', () => {
  beforeEach(() => {
    signInAs(STUDENT, { viewingAs: true });
  });

  it("acts on the viewed student's own attempt", async () => {
    const response = await post({ _action: 'completeQuiz', attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(completeAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to complete an attempt that is not the viewed student's, and records it", async () => {
    attemptFindByIdMock.mockResolvedValue(attemptOf(OTHER_STUDENT));

    const response = await post({ _action: 'completeQuiz', attemptId: ATTEMPT_ID });

    expect(response.status).toBe(403);
    expect(completeAttemptMock).not.toHaveBeenCalled();
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'QUIZ_ATTEMPT_COMPLETE_UNAUTHORIZED',
        role: 'STUDENT',
        data: expect.objectContaining({ caller_role: 'STUDENT', impersonated_by: 'admin-1' }),
      })
    );
  });

  it("refuses to send a message to an attempt that is not the viewed student's", async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf(OTHER_STUDENT),
      messages: [],
      questionsAsked: 1,
      questionCount: 5,
    });

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(403);
    expect(sendMessageToAgentMock).not.toHaveBeenCalled();
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'QUIZ_ATTEMPT_MESSAGE_UNAUTHORIZED',
        data: expect.objectContaining({ caller_role: 'STUDENT', impersonated_by: 'admin-1' }),
      })
    );
  });

  it.each([
    ['updateMetrics', updateDurationsMock],
    ['recordModalClose', recordModalClosedMock],
    ['recordModalOpen', modalGapMock],
  ])(
    "refuses %s on an attempt that is not the viewed student's",
    async (actionName, serviceMock) => {
      attemptFindByIdMock.mockResolvedValue(attemptOf(OTHER_STUDENT));

      const response = await post({ _action: actionName, attemptId: ATTEMPT_ID });

      expect(response.status).toBe(403);
      expect(serviceMock).not.toHaveBeenCalled();
    }
  );

  it("does not end the session of an attempt that is not the viewed student's on restart", async () => {
    attemptFindByIdMock.mockResolvedValue(attemptOf(OTHER_STUDENT));

    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(endQuizSessionMock).not.toHaveBeenCalled();
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, STUDENT, { role: 'STUDENT' });
  });

  it("ends the session of the viewed student's own attempt on restart", async () => {
    const response = await post({ _action: 'restartQuiz', quizId: QUIZ_ID, attemptId: ATTEMPT_ID });

    expect(response.status).toBe(200);
    expect(endQuizSessionMock).toHaveBeenCalledWith(ATTEMPT_ID);
  });
});

describe('api.quiz — refusals record the caller', () => {
  it("records the caller's own role for a staff member's refused action", async () => {
    signInAs('assistant-1', { role: 'ASSISTANT' });
    attemptFindByIdMock.mockResolvedValue(attemptOf(OTHER_STUDENT));

    await post({ _action: 'completeQuiz', attemptId: ATTEMPT_ID });

    const [row] = auditCreateMock.mock.calls[0];
    expect(row.role).toBe('ASSISTANT');
    expect(row.data.caller_role).toBe('ASSISTANT');
    expect(row.data).not.toHaveProperty('impersonated_by');
  });
});

describe('api.quiz sendMessage — a complete attempt', () => {
  it('answers with fixed copy and sends nothing to the ai-agent', async () => {
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...attemptOf(STUDENT), completed_at: new Date('2026-09-28T10:00:00Z') },
      messages: [],
      questionsAsked: 5,
      questionCount: 5,
    });

    const response = await post({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'hi' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      code: 'QUIZ_COMPLETE',
      message: 'This quiz is already complete.',
    });
    expect(sendMessageToAgentMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
  });
});

describe('api.quiz restartQuiz — the preview repository', () => {
  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']])(
    'saves the repository a %s names for a preview',
    async role => {
      signInAs('staff-1', { role });
      // A repository their own GitHub account can open, in the class's org.
      assertAccessMock.mockResolvedValue({
        userId: 'staff-1',
        classroom: {
          id: 'class-1',
          status: 'ACTIVE',
          slug: 'test-class',
          git_organization: { login: 'test-org' },
        },
        membership: { role },
      });
      getAuthSessionMock.mockResolvedValue({ userId: 'staff-1', token: 'ghu_staff', session: {} });

      const response = await post({
        _action: 'restartQuiz',
        quizId: QUIZ_ID,
        repoName: 'lab-1-solution',
      });

      expect(response.status).toBe(200);
      expect(updateAgentConfigMock).toHaveBeenCalledWith('attempt-new', {
        instructorRepoName: 'lab-1-solution',
      });
    }
  );

  it("ignores a student's repository name", async () => {
    const response = await post({
      _action: 'restartQuiz',
      quizId: QUIZ_ID,
      repoName: 'lab-1-solution',
    });

    expect(response.status).toBe(200);
    expect(createNewMock).toHaveBeenCalledWith(QUIZ_ID, STUDENT, { role: 'STUDENT' });
    expect(updateAgentConfigMock).not.toHaveBeenCalled();
  });
});
