import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The attempt drawer loader and chat-runtime attempts.
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

describe('attempt loader — chat-runtime attempts', () => {
  it("serves a student's own chat attempt as its projected transcript", async () => {
    signInAs('student-1', 'STUDENT');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    expect(loadTranscriptMock).toHaveBeenCalledWith('attempt-1', 'student');
    expect(data.transcript).toEqual(PROJECTED);
    expect(data.messages).toEqual([]);
    expect(data.viewerOwnsAttempt).toBe(true);
    expect(data.readOnly).toBe(false);
    expect(JSON.stringify(data)).not.toContain('ready. Begin');
  });

  it("says whether the chat's opening was admitted, as a flag and nothing more", async () => {
    signInAs('student-1', 'STUDENT');
    // Only the hidden opening is stored: its reply is still being written.
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: [RAW_ROWS[0]],
    });
    loadTranscriptMock.mockResolvedValue([]);

    const started = await load();
    expect(started.chatStarted).toBe(true);
    expect(started.transcript).toEqual([]);
    expect(started.messages).toEqual([]);
    expect(JSON.stringify(started)).not.toContain('ready. Begin');

    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: [],
    });
    expect((await load()).chatStarted).toBe(false);

    // Never for an ai-agent attempt, whose drawer is the legacy one.
    findWithMessagesMock.mockResolvedValue({ attempt: attemptOf('student-1'), messages: RAW_ROWS });
    expect((await load()).chatStarted).toBe(false);
  });

  it('says when the chat last admitted a turn, as server timestamps and nothing more', async () => {
    signInAs('student-1', 'STUDENT');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T12:05:00Z'));
    try {
      findWithMessagesMock.mockResolvedValue({
        attempt: {
          ...attemptOf('student-1', 'trigger_chat'),
          last_activity: new Date('2026-09-30T12:00:00Z'),
        },
        messages: [RAW_ROWS[0]],
      });
      loadTranscriptMock.mockResolvedValue([]);
      expect((await load()).chatActivity).toEqual({
        lastAt: '2026-09-30T12:00:00.000Z',
        readAt: '2026-09-30T12:05:00.000Z',
      });

      // None for an ai-agent attempt.
      findWithMessagesMock.mockResolvedValue({
        attempt: { ...attemptOf('student-1'), last_activity: new Date('2026-09-30T12:00:00Z') },
        messages: RAW_ROWS,
      });
      expect((await load()).chatActivity).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves staff reading a student's chat attempt the staff transcript, not as owner", async () => {
    signInAs('assistant-1', 'ASSISTANT');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    expect(loadTranscriptMock).toHaveBeenCalledWith('attempt-1', 'staff');
    expect(data.transcript).toEqual(PROJECTED);
    expect(data.viewerOwnsAttempt).toBe(false);
  });

  it("serves staff their own chat attempt as a student's transcript", async () => {
    signInAs('teacher-1', 'TEACHER');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('teacher-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    expect(loadTranscriptMock).toHaveBeenCalledWith('attempt-1', 'student');
    expect(data.viewerOwnsAttempt).toBe(true);
  });

  it('serves an ai-agent attempt exactly as before', async () => {
    signInAs('student-1', 'STUDENT');
    findWithMessagesMock.mockResolvedValue({ attempt: attemptOf('student-1'), messages: RAW_ROWS });

    const data = await load();

    expect(loadTranscriptMock).not.toHaveBeenCalled();
    expect(data.messages).toEqual(RAW_ROWS);
    expect(data.transcript).toBeNull();
  });

  it('says how many messages an open chat attempt admits, and how a completed one ended', async () => {
    signInAs('student-1', 'STUDENT');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });
    messageLimitMock.mockResolvedValue({ messagesLeft: 12, endedBy: null });
    const open = await load();
    expect(messageLimitMock).toHaveBeenCalledWith('attempt-1');
    expect(open.messagesLeft).toBe(12);
    expect(open.attempt.ended_by).toBeNull();

    // Submitted at the limit: the results say so, and there is nothing left to count.
    findWithMessagesMock.mockResolvedValue({
      attempt: { ...attemptOf('student-1', 'trigger_chat'), completed_at: new Date() },
      messages: RAW_ROWS,
    });
    messageLimitMock.mockResolvedValue({ messagesLeft: 0, endedBy: 'turn_limit' });
    const ended = await load();
    expect(ended.attempt.ended_by).toBe('turn_limit');
    expect(ended.messagesLeft).toBeNull();

    // Never for an ai-agent attempt.
    messageLimitMock.mockClear();
    findWithMessagesMock.mockResolvedValue({ attempt: attemptOf('student-1'), messages: RAW_ROWS });
    const legacy = await load();
    expect(messageLimitMock).not.toHaveBeenCalled();
    expect(legacy.messagesLeft).toBeNull();
    expect(legacy.attempt.ended_by).toBeNull();
  });
});

describe('attempt loader — a chat attempt past its session deadline', () => {
  it("closes the owner's expired attempt, then serves it completed", async () => {
    signInAs('student-1', 'STUDENT');
    findWithMessagesMock
      .mockResolvedValueOnce({ attempt: expiredOf('student-1'), messages: RAW_ROWS })
      .mockResolvedValueOnce({ attempt: closedOf('student-1'), messages: RAW_ROWS });
    messageLimitMock.mockResolvedValue({ messagesLeft: 0, endedBy: null });

    const data = await load();

    expect(closeExpiredMock).toHaveBeenCalledOnce();
    expect(closeExpiredMock).toHaveBeenCalledWith('attempt-1', {
      userId: 'student-1',
      role: 'STUDENT',
      surface: 'own_attempt_view',
    });
    expect(findWithMessagesMock).toHaveBeenCalledTimes(2);
    expect(data.readOnly).toBe(true);
    expect(data.attempt.completed_at).not.toBeNull();
    expect(data.attempt.evaluation_json).toMatchObject({ source: 'server' });
    expect(data.attempt.partial_credit_percentage).toBe(40);
    expect(data.attempt.ended_by).toBeNull();
    expect(data.messagesLeft).toBeNull();
  });

  it("refuses another student's expired attempt before closing anything", async () => {
    signInAs('student-2', 'STUDENT');
    findWithMessagesMock.mockResolvedValue({ attempt: expiredOf('student-1'), messages: [] });

    await expect(load()).rejects.toMatchObject({ status: 403 });
    expect(closeExpiredMock).not.toHaveBeenCalled();
  });

  it("closes a student's expired attempt for staff reading it, as staff", async () => {
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
    expect(data.readOnly).toBe(true);
  });

  it('leaves an attempt within its deadline, a completed one, and an ai-agent one alone', async () => {
    signInAs('student-1', 'STUDENT');
    for (const attempt of [
      {
        ...attemptOf('student-1', 'trigger_chat'),
        session_expires_at: new Date(Date.now() + 60_000),
      },
      closedOf('student-1'),
      expiredOf('student-1', 'ai_agent'),
      { ...attemptOf('student-1', 'trigger_chat'), session_expires_at: null },
    ]) {
      findWithMessagesMock.mockResolvedValue({ attempt, messages: RAW_ROWS });
      await load();
    }
    expect(closeExpiredMock).not.toHaveBeenCalled();
    expect(findWithMessagesMock).toHaveBeenCalledTimes(4);
  });
});

/**
 * Staff reach this route too (its gate admits OWNER/TEACHER/ASSISTANT), so a
 * staff member reading another person's attempt here writes the same VIEW row
 * the staff attempt route writes (AGENTS.md, "every read of other people's
 * data"). The attempt's owner, student or staff, writes none, and neither
 * does a read that is refused or lands on a 404.
 */
describe('attempt loader — the VIEW audit row', () => {
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

  it('writes none when a student reads their own attempt', async () => {
    signInAs('student-1', 'STUDENT');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    expect(data.viewerOwnsAttempt).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

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

  it("writes none when a student is refused another student's attempt", async () => {
    signInAs('student-2', 'STUDENT');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('student-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    await expect(load()).rejects.toMatchObject({ status: 403 });
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

  it('writes no row when the gate refuses', async () => {
    assertAccessMock.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(load()).rejects.toBeInstanceOf(Response);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
