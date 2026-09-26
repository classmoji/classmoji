/**
 * aiAgentConnection.sendRequest: an ERROR reply from the ai-agent rejects with
 * an AIAgentRequestError that keeps the payload's `code` and `retryable`.
 * api.quiz's startQuiz tells a budget-guard stop (code BUDGET_EXCEEDED) from
 * every other failure by that code, so dropping it would quietly send a
 * budget-stopped start down the invented-first-question fallback.
 *
 * socket.io-client is replaced by a fake socket whose `emit` is only a spy: the
 * outbound request must not loop back into sendRequest's own listener, so the
 * test delivers the reply to that listener itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (msg: unknown) => void;

const fake = vi.hoisted(() => {
  const listeners: Listener[] = [];
  const socket = {
    connected: false,
    once(event: string, fn: () => void) {
      if (event === 'connect') {
        socket.connected = true;
        fn();
      }
    },
    on(event: string, fn: Listener) {
      if (event === 'message') listeners.push(fn);
    },
    off(event: string, fn: Listener) {
      const i = listeners.indexOf(fn);
      if (event === 'message' && i !== -1) listeners.splice(i, 1);
    },
    emit: (() => {}) as (...a: unknown[]) => void,
    disconnect() {},
  };
  return { socket, listeners };
});

vi.mock('socket.io-client', () => ({ io: () => fake.socket }));
vi.mock('~/utils/agentAuth.server', () => ({
  signPayload: (payload: Record<string, unknown>) => payload,
}));

const { sendRequest, AIAgentRequestError } = await import('../aiAgentConnection.server');

const emitSpy = vi.fn();

beforeEach(() => {
  process.env.AI_AGENT_URL = 'http://ai-agent.test';
  emitSpy.mockReset();
  fake.socket.emit = emitSpy;
  fake.listeners.length = 0;
});

/** Send a QUIZ_INIT and answer it with `reply` (its requestId filled in). */
const sendAndReply = async (reply: { type: string; payload: Record<string, unknown> }) => {
  const pending = sendRequest(
    'QUIZ_INIT',
    { attemptId: 'attempt-1' },
    {
      responseTypes: ['QUIZ_READY'],
    }
  );
  await vi.waitFor(() => expect(emitSpy).toHaveBeenCalledTimes(1));
  const { requestId } = emitSpy.mock.calls[0][1] as { requestId: string };
  for (const listener of [...fake.listeners]) listener({ ...reply, requestId });
  return pending;
};

describe('sendRequest: ERROR replies', () => {
  it('keeps code and retryable on the rejection', async () => {
    const error = await sendAndReply({
      type: 'ERROR',
      payload: {
        attemptId: 'attempt-1',
        error: "Your first question couldn't be prepared. Send any message to try again.",
        code: 'BUDGET_EXCEEDED',
        retryable: true,
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIAgentRequestError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Your first question couldn't be prepared. Send any message to try again.",
      code: 'BUDGET_EXCEEDED',
      retryable: true,
    });
    // The listener is gone once the request settles.
    expect(fake.listeners).toHaveLength(0);
  });

  it('leaves code and retryable undefined when the payload has none', async () => {
    const error = await sendAndReply({
      type: 'ERROR',
      payload: { attemptId: 'attempt-1' },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIAgentRequestError);
    expect(error).toMatchObject({ message: 'Request failed' });
    expect((error as InstanceType<typeof AIAgentRequestError>).code).toBeUndefined();
    expect((error as InstanceType<typeof AIAgentRequestError>).retryable).toBeUndefined();
  });

  it('still resolves a matching response type', async () => {
    const response = await sendAndReply({
      type: 'QUIZ_READY',
      payload: { attemptId: 'attempt-1', openingMessage: 'Question 1' },
    });

    expect(response).toEqual({
      type: 'QUIZ_READY',
      payload: { attemptId: 'attempt-1', openingMessage: 'Question 1', explorationSteps: [] },
    });
  });
});
