/**
 * aiAgentConnection.sendRequest when the connection drops (prod, 2026-09-28):
 * an ai-agent that exits mid-request (a deploy, a crash, SIGKILL) used to leave
 * every pending request waiting out its full timeout, up to 300 s, because
 * nothing listened for the socket's `disconnect`. A request now fails as soon
 * as the socket it went out on disconnects, with a retryable
 * AGENT_DISCONNECTED, and only that socket's requests do.
 *
 * Each `io()` call here returns a NEW fake socket, as a reconnect through
 * getConnection() does in production once the old one is no longer connected.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  listeners: Map<string, Listener[]>;
  emit: ReturnType<typeof vi.fn>;
  once(event: string, fn: Listener): void;
  on(event: string, fn: Listener): void;
  off(event: string, fn: Listener): void;
  disconnect(): void;
  /** Deliver an event to this socket's listeners, as socket.io would. */
  fire(event: string, ...args: unknown[]): void;
}

const fake = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  const make = (): FakeSocket => {
    const listeners = new Map<string, Listener[]>();
    const socket: FakeSocket = {
      connected: false,
      listeners,
      emit: vi.fn(),
      once(event, fn) {
        // Asynchronously, as socket.io does: getConnection() clears its
        // pending-connection promise in this callback, after creating it.
        if (event === 'connect') {
          queueMicrotask(() => {
            socket.connected = true;
            fn();
          });
        }
      },
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      off(event, fn) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(listener => listener !== fn)
        );
      },
      disconnect() {},
      fire(event, ...args) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, make };
});

vi.mock('socket.io-client', () => ({ io: () => fake.make() }));
vi.mock('~/utils/agentAuth.server', () => ({
  signPayload: (payload: Record<string, unknown>) => payload,
}));

const { sendRequest, AIAgentRequestError, AI_AGENT_GENERIC_ERROR, AGENT_DISCONNECTED } =
  await import('../aiAgentConnection.server');

beforeEach(() => {
  process.env.AI_AGENT_URL = 'http://ai-agent.test';
});

/** Send a STUDENT_MESSAGE and wait until it has gone out on a socket. */
const send = async (attemptId: string) => {
  const before = fake.sockets.reduce((n, s) => n + s.emit.mock.calls.length, 0);
  const pending = sendRequest(
    'STUDENT_MESSAGE',
    { attemptId, content: 'hi' },
    { responseTypes: ['AGENT_RESPONSE'], timeout: 300_000 }
  );
  pending.catch(() => {}); // asserted below; never unhandled
  await vi.waitFor(() =>
    expect(fake.sockets.reduce((n, s) => n + s.emit.mock.calls.length, 0)).toBe(before + 1)
  );
  const socket = fake.sockets.find(s => s.emit.mock.calls.length > 0 && s.connected);
  if (!socket) throw new Error('the request went out on no connected socket');
  const { requestId } = socket.emit.mock.calls[socket.emit.mock.calls.length - 1][1] as {
    requestId: string;
  };
  return { pending, socket, requestId };
};

/** How many listeners of `event` are still registered on `socket`. */
const count = (socket: FakeSocket, event: string) => socket.listeners.get(event)?.length ?? 0;

describe('sendRequest: the connection drops before the reply', () => {
  it('rejects at once with a retryable AGENT_DISCONNECTED and generic copy', async () => {
    const { pending, socket } = await send('attempt-1');

    socket.connected = false;
    socket.fire('disconnect', 'transport close');
    const error = await pending.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIAgentRequestError);
    expect(error).toMatchObject({
      message: AI_AGENT_GENERIC_ERROR,
      code: AGENT_DISCONNECTED,
      retryable: true,
    });
    expect(AGENT_DISCONNECTED).toBe('AGENT_DISCONNECTED');
    // Nothing of the request is left listening on the dead socket.
    expect(count(socket, 'message')).toBe(0);
    expect(count(socket, 'disconnect')).toBe(0);
  });

  it("fails only the dropped socket's requests; the next connection works", async () => {
    const first = await send('attempt-1');
    first.socket.connected = false;
    first.socket.fire('disconnect', 'io server disconnect');
    await expect(first.pending).rejects.toMatchObject({ code: AGENT_DISCONNECTED });

    // The next request opens a new connection (getConnection saw the old one
    // was no longer connected) and is not touched by the old socket's events.
    const second = await send('attempt-2');
    expect(second.socket).not.toBe(first.socket);
    first.socket.fire('disconnect', 'io server disconnect');

    second.socket.fire('message', {
      type: 'AGENT_RESPONSE',
      requestId: second.requestId,
      payload: { attemptId: 'attempt-2', content: 'Question 2' },
    });
    await expect(second.pending).resolves.toMatchObject({ type: 'AGENT_RESPONSE' });
    expect(count(second.socket, 'disconnect')).toBe(0);
  });

  it('leaves a request that already has its reply alone', async () => {
    const { pending, socket, requestId } = await send('attempt-3');
    socket.fire('message', {
      type: 'AGENT_RESPONSE',
      requestId,
      payload: { attemptId: 'attempt-3', content: 'ok' },
    });
    await expect(pending).resolves.toMatchObject({ type: 'AGENT_RESPONSE' });

    socket.connected = false;
    socket.fire('disconnect', 'transport close');
    expect(count(socket, 'disconnect')).toBe(0);
  });
});
