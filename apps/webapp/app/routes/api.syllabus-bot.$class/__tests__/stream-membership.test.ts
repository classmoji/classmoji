import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SSE stream authorization for the syllabus bot (plan P1-3, review finding 3).
 *
 * The stream used to check two things: that the caller was signed in, and that
 * ai-agent agreed they had opened this conversation. Neither expires. Ownership
 * is a fact about the past — "did this user start it" stays true forever — so a
 * member removed from the classroom mid-conversation kept a usable stream, and
 * could keep driving it from any other classroom they still belonged to.
 *
 * So the loader now resolves the conversation's OWN classroom and re-runs the
 * membership gate against it on every (re)subscribe. Lives in the syllabus-bot
 * test folder with the action tests it is the other half of, though the route
 * itself is a flat file two directories up.
 */

const getAuthSessionMock = vi.fn();
const assertClassroomAccessMock = vi.fn();
const verifySessionOwnershipMock = vi.fn();
const canUseSyllabusBotForConversationMock = vi.fn();
const subscribeToSessionMock = vi.fn();
const conversationFindFirstMock = vi.fn();

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => getAuthSessionMock(...a),
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
}));

vi.mock('~/utils/agentVerification.server', () => ({
  verifySessionOwnership: (...a: unknown[]) => verifySessionOwnershipMock(...a),
  AgentType: { SYLLABUS_BOT: 'SYLLABUS_BOT' },
}));

vi.mock('~/utils/agentStreamManager', () => ({
  default: { subscribeToSession: (...a: unknown[]) => subscribeToSessionMock(...a) },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: {
      canUseSyllabusBotForConversation: (...a: unknown[]) =>
        canUseSyllabusBotForConversationMock(...a),
    },
  },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    aIConversation: { findFirst: (...a: unknown[]) => conversationFindFirstMock(...a) },
  }),
}));

const open = async (conversationId = 'conv-1') => {
  const { loader } = await import('../../api.syllabus-bot.stream.$conversationId');
  return loader({
    params: { conversationId },
    request: new Request(`http://x/api/syllabus-bot/stream/${conversationId}`),
  } as never) as Promise<Response>;
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSessionMock.mockResolvedValue({ userId: 'user-1' });
  conversationFindFirstMock.mockResolvedValue({ classroom_id: 'c1' });
  assertClassroomAccessMock.mockResolvedValue({
    userId: 'user-1',
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'STUDENT' },
  });
  verifySessionOwnershipMock.mockResolvedValue({ valid: true });
  canUseSyllabusBotForConversationMock.mockResolvedValue({ allowed: true });
  subscribeToSessionMock.mockReturnValue(() => {});
});

describe('syllabus bot SSE stream — membership is rechecked per open', () => {
  it('streams for a caller who is still a member', async () => {
    const res = await open();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(assertClassroomAccessMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller whose classroom membership has since been removed', async () => {
    const denied = new Response('Not a member of this classroom', { status: 403 });
    assertClassroomAccessMock.mockRejectedValue(denied);

    await expect(open()).rejects.toBe(denied);
    // The refusal lands before ai-agent is consulted, so a removed member cannot
    // keep a stream alive by racing the check.
    expect(verifySessionOwnershipMock).not.toHaveBeenCalled();
  });

  it('checks membership of the CONVERSATION’s classroom, not of any other', async () => {
    conversationFindFirstMock.mockResolvedValue({ classroom_id: 'c2' });

    await open();

    expect(assertClassroomAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'c2' })
    );
  });

  it('scopes the conversation lookup to this caller and to syllabus-bot conversations', async () => {
    await open('conv-1');

    expect(conversationFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-1', user_id: 'user-1', type: 'SYLLABUS_BOT' },
      })
    );
  });

  it('refuses a conversation the caller does not own, without running the gate', async () => {
    conversationFindFirstMock.mockResolvedValue(null);

    const res = await open('conv-someone-else');

    expect(res.status).toBe(403);
    expect(assertClassroomAccessMock).not.toHaveBeenCalled();
    expect(verifySessionOwnershipMock).not.toHaveBeenCalled();
  });

  it('still 401s an unauthenticated caller before touching the database', async () => {
    getAuthSessionMock.mockResolvedValue(null);

    const res = await open();

    expect(res.status).toBe(401);
    expect(conversationFindFirstMock).not.toHaveBeenCalled();
  });
});
