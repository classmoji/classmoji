import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Conversation binding for the syllabus bot (plan P1-3, review finding 3).
 *
 * The action authorizes the classroom in the URL and then forwards a
 * CLIENT-SUPPLIED `conversationId`. ai-agent looks that id up and mutates the
 * conversation it names on the strength of the webapp's HMAC alone — which
 * authenticates the webapp, not the caller's right to that particular
 * conversation. Before this task, any member who learned another member's
 * conversation id could inject messages into it, replace the credential stored
 * against it, or terminate it.
 *
 * These tests pin four properties:
 *
 *   1. A conversation the caller does not own is refused BEFORE ai-agent is
 *      called at all — no inference bought, no transcript written.
 *   2. A conversation of the caller's own, but in a DIFFERENT classroom they
 *      also belong to, is refused: the gate that ran answered for the URL's
 *      classroom and never examined that one.
 *   3. A conversation of another AI type (a quiz) is refused — this endpoint
 *      drives syllabus-bot conversations only.
 *   4. Every refusal is the SAME scoped not-found as an id that does not exist,
 *      so the id space cannot be probed.
 *
 * The Prisma stand-in below applies the route's `where` clause against a small
 * fixture table rather than asserting on the arguments, so dropping a predicate
 * from the query changes the ANSWER and these tests fail — an argument-shape
 * assertion would pass a route that looked the row up correctly and then ignored
 * the result.
 */

const assertClassroomAccessMock = vi.fn();
const assertClassroomMutationAllowedMock = vi.fn();
const canUseSyllabusBotMock = vi.fn();
const getClassroomSettingsForServerMock = vi.fn();
const sendRequestMock = vi.fn();
const publishAssistantResponseMock = vi.fn();
const publishDoneMock = vi.fn();

/** The caller is `user-1`, a member of both `c1` (the URL classroom) and `c2`. */
const CONVERSATIONS = [
  { id: 'conv-mine', user_id: 'user-1', classroom_id: 'c1', type: 'SYLLABUS_BOT' },
  { id: 'conv-other-user', user_id: 'user-2', classroom_id: 'c1', type: 'SYLLABUS_BOT' },
  { id: 'conv-other-class', user_id: 'user-1', classroom_id: 'c2', type: 'SYLLABUS_BOT' },
  { id: 'conv-quiz', user_id: 'user-1', classroom_id: 'c1', type: 'QUIZ' },
];

const conversationFindFirst = vi.fn(
  async ({ where }: { where: Record<string, unknown> }) =>
    CONVERSATIONS.find(row =>
      Object.entries(where).every(
        ([field, value]) => (row as Record<string, unknown>)[field] === value
      )
    ) ?? null
);

vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertClassroomAccessMock(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomMutationAllowed: (...a: unknown[]) => assertClassroomMutationAllowedMock(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    entitlement: { canUseSyllabusBot: (...a: unknown[]) => canUseSyllabusBotMock(...a) },
    classroom: {
      getClassroomSettingsForServer: (...a: unknown[]) => getClassroomSettingsForServerMock(...a),
    },
  },
}));

vi.mock('~/services/aiAgentConnection.server', () => ({
  sendRequest: (...a: unknown[]) => sendRequestMock(...a),
}));

vi.mock('~/utils/agentStreamManager', () => ({
  default: {
    registerSession: vi.fn(),
    publishStep: vi.fn(),
    publishError: vi.fn(),
    publishAssistantResponse: (...a: unknown[]) => publishAssistantResponseMock(...a),
    publishDone: (...a: unknown[]) => publishDoneMock(...a),
  },
}));

vi.mock('@classmoji/utils', () => ({ getContentRepoName: () => '' }));
vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: vi.fn(async () => ({
    accessToken: 'askmoji_test',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  })),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({ aIConversation: { findFirst: conversationFindFirst } }),
}));

const CLASS = 'some-class';

const post = async (fields: Record<string, string>) => {
  const { action } = await import('../route');
  const formData = new FormData();
  Object.entries(fields).forEach(([k, v]) => formData.append(k, v));
  return (await action({
    params: { class: CLASS },
    request: new Request('http://x/api/syllabus-bot/some-class', {
      method: 'POST',
      body: formData,
    }),
  } as never)) as Response;
};

beforeEach(() => {
  vi.clearAllMocks();
  assertClassroomAccessMock.mockResolvedValue({
    userId: 'user-1',
    classroom: { id: 'c1', name: 'Some Class', status: 'ACTIVE', git_organization: null },
    membership: { role: 'STUDENT' },
  });
  assertClassroomMutationAllowedMock.mockReturnValue(undefined);
  canUseSyllabusBotMock.mockResolvedValue({ allowed: true });
  getClassroomSettingsForServerMock.mockResolvedValue({ syllabus_bot_enabled: true });
  sendRequestMock.mockResolvedValue({ payload: { content: 'hi', references: [] } });
});

describe('syllabus bot conversation binding — sendMessage', () => {
  it('forwards a conversation the caller owns in this classroom', async () => {
    const res = await post({
      _action: 'sendMessage',
      conversationId: 'conv-mine',
      content: 'hello',
    });

    expect(res.status).toBe(200);
    expect(sendRequestMock).toHaveBeenCalledWith(
      'SYLLABUS_BOT_MESSAGE',
      expect.objectContaining({ conversationId: 'conv-mine', content: 'hello' }),
      expect.anything()
    );
    expect(publishAssistantResponseMock).toHaveBeenCalled();
  });

  it("refuses another user's conversation in the same classroom, before ai-agent", async () => {
    const res = await post({
      _action: 'sendMessage',
      conversationId: 'conv-other-user',
      content: 'hello',
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Conversation not found' });
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('refuses the caller’s own conversation from a classroom they also belong to', async () => {
    const res = await post({
      _action: 'sendMessage',
      conversationId: 'conv-other-class',
      content: 'hello',
    });

    expect(res.status).toBe(404);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('refuses a conversation of another AI type, even the caller’s own', async () => {
    const res = await post({
      _action: 'sendMessage',
      conversationId: 'conv-quiz',
      content: 'hello',
    });

    expect(res.status).toBe(404);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('answers a stranger’s id exactly as it answers an id that does not exist', async () => {
    const notYours = await post({
      _action: 'sendMessage',
      conversationId: 'conv-other-user',
      content: 'hello',
    });
    const nonexistent = await post({
      _action: 'sendMessage',
      conversationId: 'conv-does-not-exist',
      content: 'hello',
    });

    expect(nonexistent.status).toBe(notYours.status);
    expect(await nonexistent.text()).toBe(await notYours.text());
  });
});

describe('syllabus bot conversation binding — endConversation', () => {
  it('ends a conversation the caller owns in this classroom', async () => {
    const res = await post({ _action: 'endConversation', conversationId: 'conv-mine' });

    expect(res.status).toBe(200);
    expect(sendRequestMock).toHaveBeenCalledWith(
      'SYLLABUS_BOT_END',
      expect.objectContaining({ conversationId: 'conv-mine' }),
      expect.anything()
    );
    expect(publishDoneMock).toHaveBeenCalledWith('conv-mine');
  });

  it("refuses to end another user's conversation", async () => {
    const res = await post({ _action: 'endConversation', conversationId: 'conv-other-user' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Conversation not found' });
    expect(sendRequestMock).not.toHaveBeenCalled();
    expect(publishDoneMock).not.toHaveBeenCalled();
  });

  it('refuses to end a conversation belonging to another classroom', async () => {
    const res = await post({ _action: 'endConversation', conversationId: 'conv-other-class' });

    expect(res.status).toBe(404);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });
});
