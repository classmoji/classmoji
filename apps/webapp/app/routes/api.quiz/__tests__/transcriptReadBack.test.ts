import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * api.quiz's saved failure lines, read back the way every transcript reader
 * reads them: through the REAL `quizAttempt.findWithMessages`, whose
 * `toTranscriptFields` rewrites an AGENT_FAILURE row to the generic
 * "That reply couldn't be finished" line unless its code is one the ai-agent
 * writes for students.
 *
 * A recovery the ai-agent refuses for source material must read back as the
 * source-material line. It did not while the route saved it as an
 * AGENT_FAILURE with code source_material_unavailable: the student saw the
 * generic line and never learned why the quiz stopped.
 *
 * Only the database is faked here. The route's save and the service's read are
 * the real code, joined by the rows the save writes.
 */

interface StoredRow {
  id: string;
  role: string;
  content: string;
  metadata: unknown;
  created_at: Date;
}

const stored: StoredRow[] = [];

const ATTEMPT_ID = 'attempt-1';
const QUIZ_ID = 'quiz-1';
const UNAVAILABLE = "This quiz's source material isn't available yet. Ask your instructor.";
const REPLY_FAILED = "That reply couldn't be finished. Please send your message again.";

const attemptRow = {
  id: ATTEMPT_ID,
  user_id: 'student-1',
  quiz_id: QUIZ_ID,
  questions_asked: 1,
  completed_at: null,
  quiz: {
    id: QUIZ_ID,
    classroom_id: 'class-1',
    question_count: 5,
    system_prompt: null,
    rubric_prompt: 'r',
    subject: 'HTML',
    difficulty_level: 'Beginner',
    classroom: { settings: {} },
  },
};

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    quizAttempt: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === ATTEMPT_ID ? attemptRow : null,
    },
    aIConversation: {
      findFirst: async () => ({ id: 'conv-1', messages: [...stored] }),
    },
  }),
}));

const sendMessageToAgentMock = vi.fn();

vi.mock('@classmoji/services', async () => {
  const real = await vi.importActual<typeof import('@classmoji/services')>('@classmoji/services');
  return {
    ClassmojiService: {
      quizAttempt: {
        // The real reader, over the faked database above.
        findWithMessages: real.ClassmojiService.quizAttempt.findWithMessages,
        completeAttempt: vi.fn(),
      },
      // The route's save, written to the same fake table the reader reads.
      aiConversation: {
        addMessage: async (
          _attemptId: string,
          role: string,
          content: string,
          _partial: boolean,
          metadata: unknown
        ) => {
          stored.push({
            id: `m${stored.length + 1}`,
            role,
            content,
            metadata: metadata ?? null,
            created_at: new Date(),
          });
        },
      },
      audit: { create: vi.fn() },
    },
    QuizAttemptNotFoundError: real.QuizAttemptNotFoundError,
  };
});

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(async () => ({
    userId: 'student-1',
    classroom: { id: 'class-1', status: 'ACTIVE', slug: 'test-class' },
    membership: { role: 'STUDENT' },
  })),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: vi.fn(async () => true),
}));
vi.mock('~/utils/routeAuth.server', () => ({ assertClassroomMutationAllowed: vi.fn() }));
vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));
vi.mock('~/utils/backgroundTask.server', () => ({ runBackgroundTask: vi.fn() }));
vi.mock('../../student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(),
  gitlabProjectAccess: vi.fn(),
}));
vi.mock('../../student.$class.quizzes/aiAgent.server', () => ({
  initializeQuizViaAgent: vi.fn(),
  sendMessageToAgent: (...a: unknown[]) => sendMessageToAgentMock(...a),
  endQuizSession: vi.fn(),
}));
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn(async () => ({ session: {} })),
}));
vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: vi.fn(async () => ({
    accessToken: 'mcp-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  })),
}));

const { action } = await import('../route.ts');
const { ClassmojiService } = await import('@classmoji/services');

const sendMessage = () =>
  action({
    request: new Request('http://localhost/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _action: 'sendMessage', attemptId: ATTEMPT_ID, content: 'my answer' }),
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

const agentError = (code: string) =>
  Object.assign(new Error('Something went wrong. Please try again.'), { code });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stored.length = 0;
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('a refused source-material recovery, read back', () => {
  it('reads as the source-material line, not the generic reply failure', async () => {
    sendMessageToAgentMock.mockRejectedValue(agentError('source_material_unavailable'));

    await sendMessage();
    const { messages } = await ClassmojiService.quizAttempt.findWithMessages(ATTEMPT_ID);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(UNAVAILABLE);
    expect(messages[0].metadata).toEqual({ errorType: 'SOURCE_MATERIAL_UNAVAILABLE' });
  });

  it('would not, saved as an AGENT_FAILURE (the shape this replaced)', async () => {
    stored.push({
      id: 'm1',
      role: 'ASSISTANT',
      content: UNAVAILABLE,
      metadata: { errorType: 'AGENT_FAILURE', code: 'source_material_unavailable' },
      created_at: new Date(),
    });

    const { messages } = await ClassmojiService.quizAttempt.findWithMessages(ATTEMPT_ID);

    expect(messages[0].content).toBe(REPLY_FAILED);
  });

  it('still reads any other agent failure as the generic line', async () => {
    sendMessageToAgentMock.mockRejectedValue(agentError('RESPONSE_FAILED'));

    await sendMessage();
    const { messages } = await ClassmojiService.quizAttempt.findWithMessages(ATTEMPT_ID);

    expect(messages[0].content).toBe(REPLY_FAILED);
    expect(messages[0].metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'RESPONSE_FAILED' });
  });
});
