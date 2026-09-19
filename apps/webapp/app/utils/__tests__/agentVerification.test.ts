import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * verifySessionOwnership is what gates the syllabus bot's SSE stream.
 *
 * The property under test is how it handles a REFUSAL. ai-agent answers a
 * rejected HMAC signature with `{ type: 'ERROR', code: 'AUTH_FAILED' }`, not
 * with SESSION_VERIFIED. Listening only for SESSION_VERIFIED meant a refusal
 * was indistinguishable from silence: the promise hung for the full 5s and
 * then rejected with "Session verification timeout", which the stream route
 * maps to a 503 "service unavailable, retry". On 2026-08-28 that turned 4ms of
 * clock skew into a syllabus bot that looked like a transient outage.
 */

const emitted: { type: string; requestId?: string; payload?: unknown }[] = [];
const listeners = new Map<string, ((msg: unknown) => void)[]>();

const socket = {
  connected: false,
  on: (evt: string, fn: (msg: unknown) => void) => {
    listeners.set(evt, [...(listeners.get(evt) ?? []), fn]);
  },
  once: (evt: string, fn: (msg: unknown) => void) => {
    listeners.set(evt, [...(listeners.get(evt) ?? []), fn]);
  },
  off: (evt: string, fn: (msg: unknown) => void) => {
    listeners.set(
      evt,
      (listeners.get(evt) ?? []).filter(f => f !== fn)
    );
  },
  emit: (_evt: string, msg: { type: string; requestId?: string; payload?: unknown }) => {
    emitted.push(msg);
  },
  disconnect: () => {},
};

// The module waits for a 'connect' event before it will send anything, so the
// fake transport has to complete its handshake the way socket.io would.
vi.mock('socket.io-client', () => ({
  io: () => {
    setTimeout(() => {
      for (const fn of listeners.get('connect') ?? []) fn(undefined);
    }, 0);
    return socket;
  },
}));
vi.mock('../agentAuth.server', () => ({
  signPayload: (p: Record<string, unknown>) => ({ ...p, _auth: { timestamp: 1, signature: 'x' } }),
}));

// Deliver a reply as ai-agent would, echoing the requestId the caller sent.
const reply = (type: string, payload: unknown) => {
  const requestId = emitted.at(-1)?.requestId;
  for (const fn of listeners.get('message') ?? []) fn({ type, requestId, payload });
};

let verifySessionOwnership: typeof import('../agentVerification.server').verifySessionOwnership;

beforeEach(async () => {
  emitted.length = 0;
  listeners.clear();
  vi.resetModules();
  process.env.AI_AGENT_URL = 'http://ai-agent.test';
  ({ verifySessionOwnership } = await import('../agentVerification.server'));
});

afterEach(() => {
  vi.useRealTimers();
});

const call = () =>
  verifySessionOwnership({ sessionId: 'conv-1', agentType: 'SYLLABUS_BOT', userId: 'user-1' });

describe('verifySessionOwnership', () => {
  it('resolves with the payload when ai-agent verifies the session', async () => {
    const promise = call();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    reply('SESSION_VERIFIED', { valid: true, sessionStatus: 'active' });

    await expect(promise).resolves.toEqual({ valid: true, sessionStatus: 'active' });
  });

  it('rejects immediately on ERROR instead of hanging until the timeout', async () => {
    const promise = call();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    reply('ERROR', { error: 'Authentication failed', code: 'AUTH_FAILED' });

    // The message must NOT read as a timeout — the SSE route turns anything
    // containing "timeout" into a 503, which is what disguised the auth
    // failure as a transient outage.
    await expect(promise).rejects.toThrow(/Authentication failed/);
    await expect(promise).rejects.toThrow(/AUTH_FAILED/);
    await promise.catch((e: Error) => {
      expect(e.message).not.toMatch(/timeout/i);
      expect(e.message).not.toMatch(/disconnect/i);
    });
  });

  it('ignores a reply meant for a different request', async () => {
    const promise = call();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    for (const fn of listeners.get('message') ?? []) {
      fn({ type: 'SESSION_VERIFIED', requestId: 'someone-else', payload: { valid: true } });
    }
    // Still pending — then the real answer lands.
    reply('SESSION_VERIFIED', { valid: false, sessionStatus: null });

    await expect(promise).resolves.toEqual({ valid: false, sessionStatus: null });
  });

  it('rejects when the socket drops mid-verification', async () => {
    const promise = call();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    for (const fn of listeners.get('disconnect') ?? []) fn(undefined);

    await expect(promise).rejects.toThrow(/disconnect/i);
  });
});
