import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Prompt assistant — a failed init or turn tells the browser nothing about why.
 *
 * Whatever failed (the ai-agent, the connection to it, the database), the JSON
 * body and the SSE error event carry fixed copy, and the real error is logged
 * server-side.
 *
 * It goes wherever quizzes go: a classroom whose quizzes are not visible gets a
 * fixed 403 in the route's own `{ error }` shape, and a failed visibility
 * lookup is an error rather than that refusal.
 */

const assertClassroomAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const sendRequestMock = vi.fn();
const publishErrorMock = vi.fn();

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
    publishStep: vi.fn(),
    publishError: (...a: unknown[]) => publishErrorMock(...a),
    publishMessageReady: vi.fn(),
    publishDone: vi.fn(),
  },
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
