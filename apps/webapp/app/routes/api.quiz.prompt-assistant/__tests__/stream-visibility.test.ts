import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The prompt assistant's SSE stream gates on quiz visibility like its action.
 *
 * The check runs after whichever access path admitted the caller — the
 * ai-agent ownership check, or the in-memory fallback it drops to when that
 * check times out — against the classroom that path authorized. Not visible is
 * a plain 403; a failed lookup is an error, not that refusal. Lives with the
 * action's tests, though the route is a flat file one directory up.
 */

const assertClassroomAccessMock = vi.fn();
const quizzesVisibleMock = vi.fn();
const verifySessionOwnershipMock = vi.fn();
const getSessionOwnershipMock = vi.fn();
const subscribeToSessionMock = vi.fn();

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => quizzesVisibleMock(...a),
}));

vi.mock('~/utils/agentVerification.server', () => ({
  verifySessionOwnership: (...a: unknown[]) => verifySessionOwnershipMock(...a),
  AgentType: { PROMPT_ASSISTANT: 'PROMPT_ASSISTANT' },
}));

vi.mock('~/utils/agentStreamManager', () => ({
  default: {
    getSessionOwnership: (...a: unknown[]) => getSessionOwnershipMock(...a),
    subscribeToSession: (...a: unknown[]) => subscribeToSessionMock(...a),
  },
}));

const { loader } = await import('../../api.quiz.prompt-assistant.stream.$sessionId');

const open = () =>
  loader({
    params: { sessionId: 'session-1' },
    request: new Request('http://x/api/quiz/prompt-assistant/stream/session-1?org=some-class'),
  } as never) as Promise<Response>;

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  getSessionOwnershipMock.mockReturnValue({ classroomSlug: 'some-class', userId: 'user-1' });
  assertClassroomAccessMock.mockResolvedValue({
    userId: 'user-1',
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  verifySessionOwnershipMock.mockResolvedValue({ valid: true });
  quizzesVisibleMock.mockResolvedValue(true);
  subscribeToSessionMock.mockReturnValue(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe('prompt assistant SSE stream — quiz visibility', () => {
  it('streams when quizzes are visible', async () => {
    const res = await open();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(quizzesVisibleMock).toHaveBeenCalledWith('c1');
    await res.body?.cancel();
  });

  it('refuses with a plain 403 when quizzes are not visible', async () => {
    quizzesVisibleMock.mockResolvedValue(false);

    const res = await open();

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden');
    expect(subscribeToSessionMock).not.toHaveBeenCalled();
  });

  it('applies the same gate on the in-memory fallback path', async () => {
    verifySessionOwnershipMock.mockRejectedValue(new Error('Verification timeout'));
    quizzesVisibleMock.mockResolvedValue(false);

    const res = await open();

    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(403);
    expect(subscribeToSessionMock).not.toHaveBeenCalled();
  });

  it('lets a failed visibility lookup surface as an error, not the refusal', async () => {
    const failure = new Error("Can't reach database server");
    quizzesVisibleMock.mockRejectedValue(failure);

    await expect(open()).rejects.toBe(failure);
    expect(subscribeToSessionMock).not.toHaveBeenCalled();
  });
});
