/**
 * The quiz agent helpers carry the per-call MCP read token (quiz source
 * material, Stage 2) at the TOP of the QUIZ_INIT / STUDENT_MESSAGE payload.
 *
 * Never inside `quizConfig`: the ai-agent persists quizConfig into the
 * attempt's agent_config, and a bearer token must never be stored. When minting
 * failed there is no token and the field is absent, not null.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn();
vi.mock('~/services/aiAgentConnection.server', () => ({
  sendRequest: (...a: unknown[]) => sendRequest(...a),
}));

const { initializeQuizViaAgent, sendMessageToAgent } = await import('../aiAgent.server');

const TOKEN = { accessToken: 'mcp-secret', expiresAt: '2030-01-01T00:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  sendRequest.mockResolvedValue({ payload: { openingMessage: 'Q1', content: 'Reply' } });
});

describe('initializeQuizViaAgent', () => {
  it('sends mcpToken beside quizConfig, never inside it', async () => {
    await initializeQuizViaAgent('attempt-1', { rubricPrompt: 'r' }, null, { mcpToken: TOKEN });

    const [type, payload] = sendRequest.mock.calls[0];
    expect(type).toBe('QUIZ_INIT');
    expect(payload).toEqual({
      attemptId: 'attempt-1',
      quizConfig: { rubricPrompt: 'r' },
      mcpToken: TOKEN,
    });
  });

  it('keeps the code-aware fields alongside the token', async () => {
    await initializeQuizViaAgent(
      'attempt-1',
      {},
      { orgLogin: 'org', repoName: 'repo', accessToken: 'ghu' },
      { mcpToken: TOKEN }
    );

    expect(sendRequest.mock.calls[0][1]).toMatchObject({
      orgLogin: 'org',
      repoName: 'repo',
      accessToken: 'ghu',
      mcpToken: TOKEN,
    });
  });

  it('omits the field when there is no token', async () => {
    await initializeQuizViaAgent('attempt-1', {}, null, { mcpToken: undefined });
    expect(sendRequest.mock.calls[0][1]).not.toHaveProperty('mcpToken');

    await initializeQuizViaAgent('attempt-1', {});
    expect(sendRequest.mock.calls[1][1]).not.toHaveProperty('mcpToken');
  });
});

describe('sendMessageToAgent', () => {
  it('sends this turn’s token with the message', async () => {
    await sendMessageToAgent('attempt-1', 'my answer', { mcpToken: TOKEN });

    const [type, payload] = sendRequest.mock.calls[0];
    expect(type).toBe('STUDENT_MESSAGE');
    expect(payload).toEqual({
      attemptId: 'attempt-1',
      content: 'my answer',
      messageId: null,
      mcpToken: TOKEN,
    });
  });

  it('omits the field when minting failed', async () => {
    await sendMessageToAgent('attempt-1', 'my answer', { mcpToken: undefined });
    expect(sendRequest.mock.calls[0][1]).not.toHaveProperty('mcpToken');
  });
});
