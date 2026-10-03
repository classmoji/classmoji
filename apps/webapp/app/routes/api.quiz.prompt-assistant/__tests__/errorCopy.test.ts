import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Prompt assistant — a failed init or turn tells the browser nothing about why.
 *
 * Whatever failed (the ai-agent, the connection to it, the database), the JSON
 * body and the SSE error event carry fixed copy, and the real error is logged
 * server-side. A session the ai-agent no longer holds (SESSION_NOT_FOUND) gets
 * its own fixed line, since starting a new conversation is the way forward.
 *
 * It goes wherever quizzes go: a classroom whose quizzes are not visible gets a
 * fixed 403 in the route's own `{ error }` shape, and a failed visibility
 * lookup is an error rather than that refusal.
 *
 * Only the session's owner may send to or end it: the record kept at init
 * answers first, and the ai-agent's check stands in when there is none.
 */

const assertClassroomAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const sendRequestMock = vi.fn();
const publishErrorMock = vi.fn();
const publishMessageReadyMock = vi.fn();
const publishDoneMock = vi.fn();
const getSessionOwnershipMock = vi.fn();
const verifySessionOwnershipMock = vi.fn();

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/services/aiAgentConnection.server', () => ({
  sendRequest: (...a: unknown[]) => sendRequestMock(...a),
}));

vi.mock('~/utils/agentStreamManager', () => ({
  default: {
    registerSession: vi.fn(),
    getSessionOwnership: (...a: unknown[]) => getSessionOwnershipMock(...a),
    publishStep: vi.fn(),
    publishError: (...a: unknown[]) => publishErrorMock(...a),
    publishMessageReady: (...a: unknown[]) => publishMessageReadyMock(...a),
    publishDone: (...a: unknown[]) => publishDoneMock(...a),
  },
}));

vi.mock('~/utils/agentVerification.server', () => ({
  verifySessionOwnership: (...a: unknown[]) => verifySessionOwnershipMock(...a),
  AgentType: { PROMPT_ASSISTANT: 'PROMPT_ASSISTANT' },
}));

vi.mock('~/routes/student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(async () => 'install-token'),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { getClassroomSettingsForServer: vi.fn(async () => ({})) },
  },
}));

const { action } = await import('../route');

const LEAKY = "Can't reach database server at `db.internal:5432`";

const post = async (fields: Record<string, string>) => {
  const formData = new FormData();
  Object.entries(fields).forEach(([k, v]) => formData.append(k, v));
  return (await action({
    request: new Request('http://x/api/quiz/prompt-assistant', { method: 'POST', body: formData }),
  } as never)) as Response;
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  assertClassroomAccessMock.mockResolvedValue({
    userId: 'user-1',
    classroom: { id: 'c1', status: 'ACTIVE', git_organization: null },
    membership: { role: 'OWNER' },
  });
  quizzesVisibleMock.mockResolvedValue(true);
  sendRequestMock.mockRejectedValue(new Error(LEAKY));
  getSessionOwnershipMock.mockReturnValue({ classroomSlug: 'some-class', userId: 'user-1' });
  verifySessionOwnershipMock.mockResolvedValue({ valid: true, sessionStatus: 'active' });
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('prompt assistant — fixed copy on failure', () => {
  it('answers a failed init with fixed copy and logs the real error', async () => {
    const res = await post({ _action: 'initSession', classroomSlug: 'some-class' });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "The prompt assistant couldn't start. Please try again." });
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).toContain(LEAKY);
  });

  it('answers a failed turn with fixed copy through both the body and SSE', async () => {
    const res = await post({
      _action: 'sendMessage',
      classroomSlug: 'some-class',
      sessionId: 'session-1',
      content: 'hello',
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Could not send your message. Please try again.' });
    expect(publishErrorMock).toHaveBeenCalledWith(
      'session-1',
      'Could not send your message. Please try again.'
    );
    expect(JSON.stringify(publishErrorMock.mock.calls)).not.toContain('db.internal');
  });
});

describe('prompt assistant — a lost session', () => {
  const turn = {
    _action: 'sendMessage',
    classroomSlug: 'some-class',
    sessionId: 'session-1',
    content: 'hello',
  };

  // What aiAgentConnection rejects with for an ai-agent ERROR payload: the
  // code, plus text the browser must not see.
  const agentError = (code: string, message: string) =>
    Object.assign(new Error(message), { name: 'AIAgentRequestError', code });

  it('answers SESSION_NOT_FOUND with the ended line through both the body and SSE', async () => {
    sendRequestMock.mockRejectedValue(
      agentError('SESSION_NOT_FOUND', 'Session not found. Please restart the assistant.')
    );

    const res = await post(turn);
    const body = await res.json();

    const ended = 'This conversation has ended. Start a new one to keep going.';
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: ended });
    expect(publishErrorMock).toHaveBeenCalledWith('session-1', ended);
    expect(JSON.stringify([body, publishErrorMock.mock.calls])).not.toContain(
      'restart the assistant'
    );
  });

  it.each(['API_ERROR', 'RESPONSE_FAILED'])(
    'answers %s with the generic line and leaks none of its text',
    async code => {
      sendRequestMock.mockRejectedValue(agentError(code, LEAKY));

      const res = await post(turn);
      const body = await res.json();

      const generic = 'Could not send your message. Please try again.';
      expect(res.status).toBe(500);
      expect(body).toEqual({ error: generic });
      expect(publishErrorMock).toHaveBeenCalledWith('session-1', generic);
      expect(JSON.stringify([body, publishErrorMock.mock.calls])).not.toContain('db.internal');
    }
  );

  it('publishes each reply with the messageId the body returns', async () => {
    sendRequestMock.mockResolvedValue({
      type: 'PROMPT_ASSISTANT_RESPONSE',
      payload: { content: 'Here is a prompt', suggestions: [] },
    });

    const res = await post(turn);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.messageId).toEqual(expect.any(String));
    expect(publishMessageReadyMock).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ messageId: body.messageId, content: 'Here is a prompt' })
    );
  });
});

describe('prompt assistant — the session owner', () => {
  const turn = {
    _action: 'sendMessage',
    classroomSlug: 'some-class',
    sessionId: 'session-1',
    content: 'hello',
  };
  const end = { _action: 'endSession', classroomSlug: 'some-class', sessionId: 'session-1' };

  beforeEach(() => {
    sendRequestMock.mockImplementation(async (type: string) =>
      type === 'PROMPT_ASSISTANT_MESSAGE'
        ? { type: 'PROMPT_ASSISTANT_RESPONSE', payload: { content: 'Here is a prompt' } }
        : undefined
    );
  });

  const sentTypes = () => sendRequestMock.mock.calls.map(([type]) => type);

  it('forwards a send and an end from the user who opened the session', async () => {
    expect((await post(turn)).status).toBe(200);
    const res = await post(end);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(sentTypes()).toEqual(['PROMPT_ASSISTANT_MESSAGE', 'PROMPT_ASSISTANT_END']);
    expect(publishDoneMock).toHaveBeenCalledWith('session-1');
    // The record kept at init was enough; the ai-agent wasn't asked.
    expect(getSessionOwnershipMock).toHaveBeenCalledWith('session-1');
    expect(verifySessionOwnershipMock).not.toHaveBeenCalled();
  });

  it.each([
    ['another user', { classroomSlug: 'some-class', userId: 'user-2' }],
    ['another classroom', { classroomSlug: 'other-class', userId: 'user-1' }],
  ])('refuses a send to a session opened by %s', async (_who, record) => {
    getSessionOwnershipMock.mockReturnValue(record);

    const res = await post(turn);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Could not send your message. Please try again.' });
    // Nothing reached the ai-agent or the session's stream.
    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(publishErrorMock).not.toHaveBeenCalled();
    expect(publishMessageReadyMock).not.toHaveBeenCalled();
  });

  it('refuses an end for a session another user opened', async () => {
    getSessionOwnershipMock.mockReturnValue({ classroomSlug: 'some-class', userId: 'user-2' });

    const res = await post(end);

    expect(res.status).toBe(403);
    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(publishDoneMock).not.toHaveBeenCalled();
  });

  describe('with no record kept (after a webapp restart)', () => {
    beforeEach(() => {
      getSessionOwnershipMock.mockReturnValue(null);
    });

    it('forwards when the ai-agent confirms the caller owns the session', async () => {
      expect((await post(turn)).status).toBe(200);
      expect((await post(end)).status).toBe(200);

      expect(verifySessionOwnershipMock).toHaveBeenCalledWith({
        sessionId: 'session-1',
        agentType: 'PROMPT_ASSISTANT',
        userId: 'user-1',
      });
      expect(sentTypes()).toEqual(['PROMPT_ASSISTANT_MESSAGE', 'PROMPT_ASSISTANT_END']);
    });

    it.each([
      [
        'the ai-agent says it is not theirs',
        () => verifySessionOwnershipMock.mockResolvedValue({ valid: false, sessionStatus: null }),
      ],
      [
        'the ai-agent cannot be asked',
        () =>
          verifySessionOwnershipMock.mockRejectedValue(new Error('Session verification timeout')),
      ],
    ])('refuses a send and an end when %s', async (_why, arrange) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      arrange();

      const sent = await post(turn);
      const ended = await post(end);

      expect(sent.status).toBe(403);
      expect(await sent.json()).toEqual({
        error: 'Could not send your message. Please try again.',
      });
      expect(ended.status).toBe(403);
      expect(sendRequestMock).not.toHaveBeenCalled();
      expect(publishErrorMock).not.toHaveBeenCalled();
      expect(publishDoneMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});

describe('prompt assistant — quiz visibility', () => {
  const turn = {
    _action: 'sendMessage',
    classroomSlug: 'some-class',
    sessionId: 'session-1',
    content: 'hello',
  };

  it.each([
    ['initSession', { _action: 'initSession', classroomSlug: 'some-class' }],
    ['sendMessage', turn],
  ])('refuses %s with fixed copy when quizzes are not visible', async (_name, fields) => {
    quizzesVisibleMock.mockResolvedValue(false);

    const res = await post(fields);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Quizzes aren't available in this class." });
    // Checked for the classroom the access gate authorized; nothing reached
    // the ai-agent.
    expect(quizzesVisibleMock).toHaveBeenCalledWith('c1');
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('lets a failed visibility lookup surface as an error, not the refusal', async () => {
    const failure = new Error(LEAKY);
    quizzesVisibleMock.mockRejectedValue(failure);

    await expect(post({ _action: 'initSession', classroomSlug: 'some-class' })).rejects.toBe(
      failure
    );
    expect(sendRequestMock).not.toHaveBeenCalled();
  });
});
