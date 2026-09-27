/**
 * aiAgentConnection.sendRequest: an ERROR reply from the ai-agent rejects with
 * an AIAgentRequestError that keeps the payload's `code` and `retryable`.
 * api.quiz's startQuiz tells a budget-guard stop (code BUDGET_EXCEEDED) from
 * every other failure by that code, so dropping it would quietly send a
 * budget-stopped start down the invented-first-question fallback.
 *
 * The rejection's `message` is the ai-agent's text only for the codes whose
 * text the ai-agent writes as fixed, user-facing copy; every other reply gets
 * one generic line, with the ai-agent's text kept on `detail` for the log.
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

const { sendRequest, AIAgentRequestError, AI_AGENT_GENERIC_ERROR } =
  await import('../aiAgentConnection.server');

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
    expect(error).toMatchObject({ message: AI_AGENT_GENERIC_ERROR });
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

describe('sendRequest: which ERROR text becomes the message', () => {
  it.each([
    ['SESSION_NOT_FOUND', 'Session not found. Please restart the assistant.'],
    ['BUDGET_EXCEEDED', "That reply couldn't be finished. Please send your message again."],
  ])('keeps the ai-agent text for %s', async (code, text) => {
    const error = await sendAndReply({
      type: 'ERROR',
      payload: { attemptId: 'attempt-1', error: text, code },
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ message: text, code });
    expect((error as InstanceType<typeof AIAgentRequestError>).detail).toBeUndefined();
  });

  it.each([
    ['INIT_FAILED', "Can't reach database server at `db.internal:5432`"],
    // API_ERROR's text is written for people, but it describes the upstream
    // failure ("temporarily busy", "a configuration issue"), so it is not shown.
    ['API_ERROR', 'The AI service is temporarily busy. Please wait a moment and try again.'],
    ['API_ERROR', "There's a configuration issue. Please contact your instructor."],
  ])('replaces the text for %s with the generic line and keeps it on detail', async (code, raw) => {
    const error = await sendAndReply({
      type: 'ERROR',
      payload: { attemptId: 'attempt-1', error: raw, code, retryable: true },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIAgentRequestError);
    expect(error).toMatchObject({
      message: AI_AGENT_GENERIC_ERROR,
      code,
      retryable: true,
      detail: raw,
    });
  });

  it('does not trust an allow-listed code that arrives without text', async () => {
    const error = await sendAndReply({
      type: 'ERROR',
      payload: { attemptId: 'attempt-1', code: 'BUDGET_EXCEEDED' },
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ message: AI_AGENT_GENERIC_ERROR, code: 'BUDGET_EXCEEDED' });
  });
});

describe('sendRequest: source_material_unavailable (quiz source material)', () => {
  it('keeps the code on the rejection so startQuiz can tell it apart; the text is not shown', async () => {
    // The ai-agent refuses QUIZ_INIT (and the STUDENT_MESSAGE that triggers a
    // recovery) when the attempt's user can see none of the quiz's linked
    // documents. The webapp answers that with its own fixed copy, keyed on the
    // code; the ai-agent's text stays on `detail` for the log.
    const error = await sendAndReply({
      type: 'ERROR',
      payload: {
        attemptId: 'attempt-1',
        error: 'No source material is available for this attempt',
        code: 'source_material_unavailable',
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIAgentRequestError);
    expect(error).toMatchObject({
      code: 'source_material_unavailable',
      message: AI_AGENT_GENERIC_ERROR,
      detail: 'No source material is available for this attempt',
    });
  });
});
