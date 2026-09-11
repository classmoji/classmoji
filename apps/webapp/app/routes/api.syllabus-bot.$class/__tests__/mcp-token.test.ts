import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The MCP bearer that rides every Ask Moji turn (plan P1-3).
 *
 * ai-agent builds its agent config ONCE at init and reuses it for the life of
 * the conversation, so a token attached only at init would die an hour in and
 * take the bot's tool access with it. Every turn is a fresh, already
 * authenticated webapp request, so the webapp mints (or reuses) per turn and the
 * ai-agent side overwrites its stored header from the field. A fresh token per
 * turn is a requirement of the review, not an optimisation — hence the explicit
 * "second message mints again" test below.
 *
 * The other two properties pinned here:
 *   - a mint failure FAILS THE TURN rather than falling back to whatever token
 *     the previous turn used;
 *   - the token is never written to a log. It is a bearer for the caller's whole
 *     MCP read surface and must exist only inside the HMAC-signed payload.
 */

const assertClassroomAccessMock = vi.fn();
const assertClassroomMutationAllowedMock = vi.fn();
const canUseSyllabusBotMock = vi.fn();
const getClassroomSettingsForServerMock = vi.fn();
const sendRequestMock = vi.fn();
const mintMcpAccessTokenMock = vi.fn();

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
    publishAssistantResponse: vi.fn(),
    publishDone: vi.fn(),
  },
}));

vi.mock('@classmoji/utils', () => ({ getContentRepoName: () => '' }));
vi.mock('~/routes/student.$class.quizzes/helpers.server', () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock('@classmoji/auth/mcp-token', () => ({
  mintMcpAccessToken: (...a: unknown[]) => mintMcpAccessTokenMock(...a),
}));

/** The caller owns `conv-mine` in `c1`; binding itself is covered elsewhere. */
vi.mock('@classmoji/database', () => ({
  default: () => ({
    aIConversation: { findFirst: vi.fn(async () => ({ id: 'conv-mine' })) },
  }),
}));

const CLASS = 'some-class';
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');

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

const payloadFor = (type: string) =>
  sendRequestMock.mock.calls.find(call => call[0] === type)?.[1] as Record<string, unknown>;

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
  mintMcpAccessTokenMock.mockImplementation(async () => ({
    accessToken: 'askmoji_deadbeef',
    expiresAt: EXPIRES,
  }));
  sendRequestMock.mockImplementation(async (type: string) =>
    type === 'SYLLABUS_BOT_INIT'
      ? { payload: { conversationId: 'conv-mine', welcomeMessage: 'hi', hasContentRepo: false } }
      : { payload: { content: 'hi', references: [] } }
  );
});

describe('syllabus bot MCP token — attached to every turn', () => {
  it('attaches a freshly minted token to the init payload, bound to the caller', async () => {
    const res = await post({ _action: 'initConversation' });

    expect(res.status).toBe(200);
    expect(mintMcpAccessTokenMock).toHaveBeenCalledWith('user-1');
    expect(payloadFor('SYLLABUS_BOT_INIT')).toMatchObject({
      mcpToken: { accessToken: 'askmoji_deadbeef', expiresAt: EXPIRES.toISOString() },
    });
  });

  it('attaches a token to the message payload too, not only to init', async () => {
    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'hello' });

    expect(payloadFor('SYLLABUS_BOT_MESSAGE')).toMatchObject({
      conversationId: 'conv-mine',
      mcpToken: { accessToken: 'askmoji_deadbeef', expiresAt: EXPIRES.toISOString() },
    });
  });

  it('mints again on the SECOND message, so a long chat never carries a stale token', async () => {
    await post({ _action: 'initConversation' });
    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'one' });
    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'two' });

    // One per turn: init + two messages. Minting only at init leaves this at 1.
    expect(mintMcpAccessTokenMock).toHaveBeenCalledTimes(3);
  });

  it('sends whatever the current mint returns, never the previous turn’s value', async () => {
    mintMcpAccessTokenMock
      .mockImplementationOnce(async () => ({ accessToken: 'turn-one', expiresAt: EXPIRES }))
      .mockImplementationOnce(async () => ({ accessToken: 'turn-two', expiresAt: EXPIRES }));

    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'one' });
    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'two' });

    const tokens = sendRequestMock.mock.calls
      .filter(call => call[0] === 'SYLLABUS_BOT_MESSAGE')
      .map(call => (call[1] as { mcpToken: { accessToken: string } }).mcpToken.accessToken);
    expect(tokens).toEqual(['turn-one', 'turn-two']);
  });
});

describe('syllabus bot MCP token — a mint failure fails the turn', () => {
  it('does not open a conversation when the token cannot be minted', async () => {
    mintMcpAccessTokenMock.mockRejectedValue(new Error('db down'));

    const res = await post({ _action: 'initConversation' });

    expect(res.status).toBe(500);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('does not send a message when the token cannot be minted', async () => {
    mintMcpAccessTokenMock.mockRejectedValue(new Error('db down'));

    const res = await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'x' });

    expect(res.status).toBe(500);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });
});

describe('syllabus bot MCP token — never logged', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    spies.push(vi.spyOn(console, 'log').mockImplementation(() => {}));
    spies.push(vi.spyOn(console, 'warn').mockImplementation(() => {}));
    spies.push(vi.spyOn(console, 'error').mockImplementation(() => {}));
  });

  afterEach(() => {
    spies.splice(0).forEach(spy => spy.mockRestore());
  });

  it('keeps the bearer out of every console call, on the happy path and on failure', async () => {
    await post({ _action: 'initConversation' });
    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'hello' });

    sendRequestMock.mockRejectedValue(new Error('agent exploded'));
    await post({ _action: 'sendMessage', conversationId: 'conv-mine', content: 'again' });

    const logged = spies
      .flatMap(spy => spy.mock.calls)
      .map((args: unknown[]) =>
        args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      )
      .join('\n');
    expect(logged).not.toContain('askmoji_deadbeef');
  });
});
