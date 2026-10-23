import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The staff attempt drawer loader and chat-runtime attempts.
 *
 * A chat-runtime attempt (`agent_runtime: 'trigger_chat'`) is served as its
 * projected transcript (quizChat.loadTranscriptForViewer), never as raw
 * message rows, and the loader says whether the viewer owns the attempt: only
 * the owner's drawer drives the chat session. An ai-agent attempt is served
 * exactly as before.
 */

const quizFindByIdMock = vi.fn();
const findWithMessagesMock = vi.fn();
const loadTranscriptMock = vi.fn();
const messageLimitMock = vi.fn();
const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const closeExpiredMock = vi.fn();
const auditMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: { findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a) },
    // A completed attempt's grade panel (emoji, adjustment, requests): empty here.
    emojiMapping: { findScaleByClassroomId: async () => ({}) },
    classroomMembership: { findByClassroomAndUser: async () => null },
    regradeRequest: { findOpenByQuizAttemptId: async () => null, findMany: async () => [] },
    quizGradeItems: { netQuizExtensionHours: async () => new Map() },
    user: { findById: async () => null },
    quizGrading: { closeExpiredAttempt: (...a: unknown[]) => closeExpiredMock(...a) },
    quizChat: {
      loadTranscriptForViewer: (...a: unknown[]) => loadTranscriptMock(...a),
      messageLimitOf: (...a: unknown[]) => messageLimitMock(...a),
    },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
  addClassroomAuditLog: (...a: unknown[]) => auditMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));

vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/components', () => ({ QuizAttemptInterface: () => null }));
vi.mock('react-router', () => ({
  useLocation: () => ({ pathname: '/x' }),
  useNavigate: () => () => {},
  useParams: () => ({}),
}));
vi.mock('antd', () => ({
  Drawer: () => null,
  ConfigProvider: () => null,
  Modal: () => null,
  theme: { darkAlgorithm: {}, defaultAlgorithm: {} },
}));

const route = await import('../route.tsx');

const QUIZ_ID = 'quiz-1';
const QUIZ = { id: QUIZ_ID, name: 'Landing pages', classroom_id: 'class-1' };

const attemptOf = (userId: string, agentRuntime?: string) => ({
  id: 'attempt-1',
  quiz_id: QUIZ_ID,
  user_id: userId,
  completed_at: null,
  total_duration_ms: 0,
  unfocused_duration_ms: 0,
  ...(agentRuntime ? { agent_runtime: agentRuntime } : {}),
  user: { id: userId, name: 'Student', login: 'student' },
  quiz: { id: QUIZ_ID },
});

const RAW_ROWS = [
  { id: 'r1', role: 'user', content: 'The student is ready. Begin.' },
  { id: 'r2', role: 'assistant', content: 'Question 1' },
];

const PROJECTED = [{ id: 'ui-1', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] }];

const DEADLINE_PASSED = () => new Date(Date.now() - 60_000);

/** An open chat attempt past its deadline, and the same attempt once closed. */
const expiredOf = (userId: string, agentRuntime = 'trigger_chat') => ({
  ...attemptOf(userId, agentRuntime),
  session_expires_at: DEADLINE_PASSED(),
});
const closedOf = (userId: string) => ({
  ...expiredOf(userId),
  completed_at: new Date(),
  partial_credit_percentage: 40,
  first_attempt_percentage: 40,
  evaluation_json: {
    v: 2,
    source: 'server',
    partial_credit_percentage: 40,
    first_attempt_percentage: 40,
    question_results: [],
  },
});

const load = () =>
  route.loader({
    params: { class: 'cs52-26f', quizId: QUIZ_ID, attemptId: 'attempt-1' },
    request: new Request('http://localhost/x'),
  } as unknown as Parameters<typeof route.loader>[0]);

const signInAs = (userId: string, role: string, classroomId = 'class-1') =>
  assertAccessMock.mockResolvedValue({
    userId,
    classroom: { id: classroomId, slug: 'cs52-26f', status: 'ACTIVE' },
    membership: { role },
  });

beforeEach(() => {
  vi.clearAllMocks();
  quizzesVisibleMock.mockResolvedValue(true);
  quizFindByIdMock.mockResolvedValue(QUIZ);
  loadTranscriptMock.mockResolvedValue(PROJECTED);
  messageLimitMock.mockResolvedValue({ messagesLeft: 200, endedBy: null });
  closeExpiredMock.mockResolvedValue({ v: 2, source: 'server' });
});

describe('staff attempt loader — chat-runtime attempts', () => {
  it("serves staff a student's chat attempt as its staff transcript, read-only", async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    expect(loadTranscriptMock).toHaveBeenCalledWith('attempt-1', 'staff');
    expect(data.transcript).toEqual(PROJECTED);
    expect(data.messages).toEqual([]);
    expect(data.viewerOwnsAttempt).toBe(false);
    expect(data.attempt.agent_runtime).toBe('trigger_chat');
    expect(JSON.stringify(data)).not.toContain('ready. Begin');
  });

  it("marks a staff member's own attempt as theirs, with the student transcript", async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('teacher-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    expect(data.viewerOwnsAttempt).toBe(true);
    // The owner drives the chat, whose stream never carries expected_answer.
    expect(loadTranscriptMock).toHaveBeenCalledWith('attempt-1', 'student');
    // Its opening was admitted: a second tab joins it rather than beginning.
    expect(data.chatStarted).toBe(true);
  });

  it('serves an ai-agent attempt exactly as before', async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({ attempt: attemptOf('student-1'), messages: RAW_ROWS });

    const data = await load();

    expect(loadTranscriptMock).not.toHaveBeenCalled();
    expect(data.messages).toEqual(RAW_ROWS);
    expect(data.transcript).toBeNull();
    expect(data.attempt.agent_runtime).toBe('ai_agent');
  });

  it("tells staff a student's attempt was submitted at the message limit", async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...attemptOf('student-1', 'trigger_chat'), completed_at: new Date() },
      messages: RAW_ROWS,
    });
    messageLimitMock.mockResolvedValue({ messagesLeft: 0, endedBy: 'turn_limit' });

    const data = await load();

    expect(messageLimitMock).toHaveBeenCalledWith('attempt-1');
    expect(data.attempt.ended_by).toBe('turn_limit');
    expect(data.messagesLeft).toBeNull();
  });
});

describe('staff attempt loader — a chat attempt past its session deadline', () => {
  it("closes a student's expired attempt and serves it completed, naming the staff reader", async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock
      .mockResolvedValueOnce({ attempt: expiredOf('student-1'), messages: RAW_ROWS })
      .mockResolvedValueOnce({ attempt: closedOf('student-1'), messages: RAW_ROWS });

    const data = await load();

    expect(closeExpiredMock).toHaveBeenCalledWith('attempt-1', {
      userId: 'teacher-1',
      role: 'TEACHER',
      surface: 'staff_attempt_view',
    });
    expect(findWithMessagesMock).toHaveBeenCalledTimes(2);
    expect(data.readOnly).toBe(true);
    expect(data.attempt.evaluation_json).toMatchObject({ source: 'server' });
  });

  it("never closes another quiz's attempt: it is a 404 first", async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...expiredOf('student-1'), quiz_id: 'quiz-elsewhere' },
      messages: [],
    });

    await expect(load()).rejects.toMatchObject({ status: 404 });
    expect(closeExpiredMock).not.toHaveBeenCalled();
  });

  it('leaves an attempt within its deadline and an ai-agent one alone', async () => {
    signInAs('teacher-1', 'TEACHER');
    for (const attempt of [
      {
        ...attemptOf('student-1', 'trigger_chat'),
        session_expires_at: new Date(Date.now() + 60_000),
      },
      expiredOf('student-1', 'ai_agent'),
    ]) {
      findWithMessagesMock.mockResolvedValue({ attempt, messages: RAW_ROWS });
      await load();
    }
    expect(closeExpiredMock).not.toHaveBeenCalled();
  });
});

/**
 * T9: staff reading another person's attempt is a read of someone else's data,
 * so it writes one VIEW row (AGENTS.md, "every read of other people's data");
 * a user reading their own attempt writes none.
 */
describe('staff attempt loader — the VIEW audit row', () => {
  it.each([
    ['trigger_chat', 'TEACHER'],
    ['trigger_chat', 'ASSISTANT'],
    [undefined, 'OWNER'],
  ] as const)(
    "writes one VIEW row when staff read a student's attempt (%s, %s)",
    async (runtime, role) => {
      signInAs('staff-1', role);
      findWithMessagesMock.mockResolvedValue({
        attempt: attemptOf('student-1', runtime),
        messages: RAW_ROWS,
      });

      await load();

      expect(auditMock).toHaveBeenCalledExactlyOnceWith({
        classroomId: 'class-1',
        userId: 'staff-1',
        // The role the gate enforced.
        role,
        action: 'VIEW',
        resourceType: 'QUIZ_ATTEMPT',
        resourceId: 'attempt-1',
        metadata: {
          tool: 'web:quiz_attempt.view',
          quiz_id: QUIZ_ID,
          student_id: 'student-1',
        },
      });
    }
  );

  it('writes none when staff read their own attempt', async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('teacher-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    expect(data.viewerOwnsAttempt).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("gives classroom Y's staff a 404 for classroom X's attempt, and writes no row", async () => {
    // Authorized for class-2; the quiz and its attempt are class-1's.
    signInAs('teacher-y', 'TEACHER', 'class-2');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    await expect(load()).rejects.toMatchObject({ status: 404 });
    expect(findWithMessagesMock).not.toHaveBeenCalled();
    expect(loadTranscriptMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("writes no row for another quiz's attempt: it is a 404 first", async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...attemptOf('student-1', 'trigger_chat'), quiz_id: 'quiz-elsewhere' },
      messages: [],
    });

    await expect(load()).rejects.toMatchObject({ status: 404 });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('writes no row when the gate refuses', async () => {
    assertAccessMock.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(load()).rejects.toBeInstanceOf(Response);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
