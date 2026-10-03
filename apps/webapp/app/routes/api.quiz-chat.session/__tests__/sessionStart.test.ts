import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * startQuizChatSession — the Trigger call behind the session route. It starts
 * (or re-joins) the session keyed by the attempt id through
 * `chat.createStartSessionAction`, with a 15-minute session-scoped token, and
 * never mints a task-scoped token.
 */

const createStartSessionActionMock = vi.fn();
const startMock = vi.fn();
const createAccessTokenMock = vi.fn();
const updateMock = vi.fn();

vi.mock('@trigger.dev/sdk/ai', () => ({
  chat: {
    createStartSessionAction: (...a: unknown[]) => createStartSessionActionMock(...a),
    createAccessToken: (...a: unknown[]) => createAccessTokenMock(...a),
  },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ quizAttempt: { update: (...a: unknown[]) => updateMock(...a) } }),
}));

const { startQuizChatSession, writeChatGrant, recordTriggerSession, QUIZ_CHAT_TASK_ID } =
  await import('../session.server');

beforeEach(() => {
  vi.clearAllMocks();
  createStartSessionActionMock.mockReturnValue(startMock);
  startMock.mockResolvedValue({
    publicAccessToken: 'pat-1',
    runId: 'run_1',
    sessionId: 'session_1',
  });
  updateMock.mockResolvedValue({});
});

describe('startQuizChatSession', () => {
  it('starts the quiz-attempt session keyed by the attempt id with a 15-minute token', async () => {
    const result = await startQuizChatSession('attempt-1', ['attempt:attempt-1', 'classroom:c-1']);

    expect(QUIZ_CHAT_TASK_ID).toBe('quiz-attempt');
    expect(createStartSessionActionMock).toHaveBeenCalledWith('quiz-attempt', {
      tokenTTL: '15m',
      triggerConfig: { tags: ['attempt:attempt-1', 'classroom:c-1'] },
    });
    expect(startMock).toHaveBeenCalledWith({ chatId: 'attempt-1', clientData: {} });
    expect(result).toEqual({ publicAccessToken: 'pat-1', sessionId: 'session_1' });
    expect(createAccessTokenMock).not.toHaveBeenCalled();
  });
});

describe('the attempt writes', () => {
  it('writes the grant on the attempt row', async () => {
    const grant = {
      actor_user_id: 'u-1',
      effective_user_id: 'u-1',
      classroom_id: 'c-1',
      role: 'STUDENT',
      web_session_id: 's-1',
      impersonation: null,
      issued_at: '2026-09-30T00:00:00.000Z',
    };
    await writeChatGrant('attempt-1', grant);

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: { chat_grant: grant },
    });
  });

  it('stores the session id on the attempt row', async () => {
    await recordTriggerSession('attempt-1', 'session_1');

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: { trigger_session_id: 'session_1' },
    });
  });
});
