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
const assertAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: { findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a) },
    quizChat: { loadTranscriptForViewer: (...a: unknown[]) => loadTranscriptMock(...a) },
  },
  QuizAttemptNotFoundError: class QuizAttemptNotFoundError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
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

const load = () =>
  route.loader({
    params: { class: 'cs52-26f', quizId: QUIZ_ID, attemptId: 'attempt-1' },
    request: new Request('http://localhost/x'),
  } as unknown as Parameters<typeof route.loader>[0]);

const signInAs = (userId: string, role: string) =>
  assertAccessMock.mockResolvedValue({
    userId,
    classroom: { id: 'class-1', slug: 'cs52-26f', status: 'ACTIVE' },
    membership: { role },
  });

beforeEach(() => {
  vi.clearAllMocks();
  quizzesVisibleMock.mockResolvedValue(true);
  quizFindByIdMock.mockResolvedValue(QUIZ);
  loadTranscriptMock.mockResolvedValue(PROJECTED);
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
});
