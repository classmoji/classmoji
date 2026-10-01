import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The staff preview drawer loader and chat-runtime attempts.
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

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findById: (...a: unknown[]) => quizFindByIdMock(...a) },
    quizAttempt: { findWithMessages: (...a: unknown[]) => findWithMessagesMock(...a) },
    quizChat: {
      loadTranscriptForViewer: (...a: unknown[]) => loadTranscriptMock(...a),
      messageLimitOf: (...a: unknown[]) => messageLimitMock(...a),
    },
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
  messageLimitMock.mockResolvedValue({ messagesLeft: 200, endedBy: null });
});

describe('preview loader — chat-runtime attempts', () => {
  it("serves the caller's own chat preview as its projected transcript", async () => {
    signInAs('owner-1', 'OWNER');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('owner-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });

    const data = await load();

    // A preview is the caller's own attempt: the student transcript.
    expect(loadTranscriptMock).toHaveBeenCalledWith('attempt-1', 'student');
    expect(data.transcript).toEqual(PROJECTED);
    expect(data.messages).toEqual([]);
    expect(data.viewerOwnsAttempt).toBe(true);
    expect(data.chatStarted).toBe(true);
  });

  it('says a new chat preview has not begun, so its drawer sends begin', async () => {
    signInAs('owner-1', 'OWNER');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('owner-1', 'trigger_chat'),
      messages: [],
    });
    loadTranscriptMock.mockResolvedValue([]);

    expect((await load()).chatStarted).toBe(false);
  });

  it('serves an ai-agent preview exactly as before', async () => {
    signInAs('owner-1', 'OWNER');
    findWithMessagesMock.mockResolvedValue({ attempt: attemptOf('owner-1'), messages: RAW_ROWS });

    const data = await load();

    expect(loadTranscriptMock).not.toHaveBeenCalled();
    expect(data.messages).toEqual(RAW_ROWS);
    expect(data.transcript).toBeNull();
  });

  it('says how many messages an open chat preview admits', async () => {
    signInAs('owner-1', 'OWNER');
    findWithMessagesMock.mockResolvedValue({
      attempt: attemptOf('owner-1', 'trigger_chat'),
      messages: RAW_ROWS,
    });
    messageLimitMock.mockResolvedValue({ messagesLeft: 3, endedBy: null });

    const data = await load();

    expect(messageLimitMock).toHaveBeenCalledWith('attempt-1');
    expect(data.messagesLeft).toBe(3);
    expect(data.attempt.ended_by).toBeNull();
  });
});
