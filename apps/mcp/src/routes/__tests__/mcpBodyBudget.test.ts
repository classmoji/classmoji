/**
 * POST /mcp counts its body's bytes in the in-flight body budget
 * (mcp/bodyBudget.ts) as they arrive, before Fastify keeps them: against the
 * user's allowance and the server's total, and against the large-body
 * allowance once the body reaches the small-body threshold. No room → 429 (the
 * user's allowance) or 503 (the server's), with Retry-After. The bytes are
 * released when the request ends, however it ends, and not before the tool
 * handlers it started have returned.
 *
 * The route, the gate, the budgets, the registry and the SDK are real; a probe
 * tool waits on a promise the test controls. Token resolution reads the user
 * id off the bearer, so users can be told apart, and can be made to take a
 * while, so a client can leave during it. The server listens on a loopback
 * port so a body can arrive in parts, or its client can leave mid-body.
 */

import net from 'node:net';
import Fastify from 'fastify';
import { z } from 'zod';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  started: 0,
  running: 0,
  authDelayMs: 0,
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async (headers: Headers) => {
    if (state.authDelayMs > 0) await new Promise(resolve => setTimeout(resolve, state.authDelayMs));
    return {
      userId: (headers.get('authorization') ?? '').replace(/^Bearer /, ''),
      clientId: 'c',
      scopes: new Set(['read']),
    };
  }),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

const { default: mcpRoutes } = await import('../mcp.ts');
const { registerToolDefinition } = await import('../../mcp/registry.ts');
const { BodyBytesBudget } = await import('../../mcp/bodyBudget.ts');
const { resetRateLimits, toolCallBucketKey, tryConsume, TOOL_CALL_RATE_LIMIT } =
  await import('../../mcp/rateLimit.ts');

const TOOL = 'probe_body';
const THROWS = 'probe_throws';

beforeAll(() => {
  registerToolDefinition<{ pad?: string; wait?: boolean }>({
    name: TOOL,
    title: 'Probe body',
    description: 'answers with the size of its pad; waits when asked',
    scope: 'read',
    roles: null,
    inputSchema: { pad: z.string().optional(), wait: z.boolean().optional() },
    handler: async ({ pad, wait }) => {
      state.started += 1;
      state.running += 1;
      try {
        if (wait && state.hold) await state.hold;
        return { content: [{ type: 'text', text: `pad ${pad?.length ?? 0}` }] };
      } finally {
        state.running -= 1;
      }
    },
  });
  registerToolDefinition<{ pad?: string }>({
    name: THROWS,
    title: 'Probe throws',
    description: 'always fails',
    scope: 'read',
    roles: null,
    inputSchema: { pad: z.string().optional() },
    handler: async () => {
      throw new Error('probe failure');
    },
  });
});

let free: () => void = () => {};
beforeEach(() => {
  resetRateLimits();
  state.started = 0;
  state.running = 0;
  state.authDelayMs = 0;
  state.hold = new Promise(resolve => (free = resolve));
});

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  free();
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

type Budget = InstanceType<typeof BodyBytesBudget>;

async function listening(bodyBudget: Budget, bodyLimit?: number) {
  const fastify = Fastify({ logger: false, ...(bodyLimit ? { bodyLimit } : {}) });
  await fastify.register(mcpRoutes, { bodyBudget });
  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const address = fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  cleanup.push(() => fastify.close());
  return { fastify, port: address.port };
}

const call = (pad: number, opts: { wait?: boolean; id?: number; tool?: string } = {}) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: opts.id ?? 1,
    method: 'tools/call',
    params: {
      name: opts.tool ?? TOOL,
      arguments: { pad: 'x'.repeat(pad), ...(opts.tool ? {} : { wait: opts.wait ?? false }) },
    },
  });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Opens a POST /mcp on a raw socket and sends its headers; the body is up to the test. */
function open(port: number, user: string, framing: string) {
  const socket = net.connect(port, '127.0.0.1');
  socket.setNoDelay(true);
  let received = '';
  socket.on('data', chunk => (received += chunk.toString()));
  socket.on('error', () => {});
  const closed = new Promise<void>(resolve => socket.on('close', () => resolve()));
  cleanup.push(() => socket.destroy());
  socket.write(
    [
      'POST /mcp HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Accept: application/json, text/event-stream',
      `Authorization: Bearer ${user}`,
      framing,
      '',
      '',
    ].join('\r\n')
  );
  return {
    socket,
    closed,
    received: () => received,
    status: () => Number(received.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0),
    answer: () => JSON.parse(received.split('\r\n\r\n')[1] ?? 'null'),
    /** One chunk of a chunked body; '' ends it. */
    chunk: (data: string) =>
      socket.write(data ? `${Buffer.byteLength(data).toString(16)}\r\n${data}\r\n` : '0\r\n\r\n'),
  };
}

const sized = (port: number, user: string, body: string) =>
  open(port, user, `Content-Length: ${Buffer.byteLength(body)}`);

const chunked = (port: number, user: string) => open(port, user, 'Transfer-Encoding: chunked');

/** A request whose body is sent all but its last byte, and held. */
async function holding(port: number, budget: Budget, user: string, body: string) {
  const before = budget.inFlight(user);
  const req = sized(port, user, body);
  req.socket.write(body.slice(0, -1));
  await vi.waitFor(() => expect(budget.inFlight(user)).toBe(before + body.length - 1));
  return req;
}

/** A complete call answered over fetch. */
async function post(port: number, user: string, body: string) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${user}`,
    },
    body,
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() };
}

describe('a body with a Content-Length', () => {
  it('counts nothing before the body arrives, then its bytes as they arrive', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    const body = call(3_000);

    const req = sized(port, 'a', body);
    await sleep(50);
    expect(budget.inFlight('a')).toBe(0);

    req.socket.write(body.slice(0, 1_000));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(1_000));
    expect(budget.largeInFlight()).toBe(1_000);
    req.socket.write(body.slice(1_000));
    await vi.waitFor(() => expect(req.received()).toContain('pad 3000'));
    expect(req.status()).toBe(200);
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
    expect(budget.largeInFlight()).toBe(0);
  });

  it("refuses a body over its user's allowance with 429, Retry-After and a JSON-RPC error", async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    const held = await holding(port, budget, 'a', call(3_000));

    const body = call(1_000);
    const refused = sized(port, 'a', body);
    refused.socket.write(body);
    await vi.waitFor(() => expect(refused.received()).toContain('\r\n\r\n{'));
    expect(refused.status()).toBe(429);
    expect(refused.received()).toMatch(/\r\nretry-after: 5\r\n/i);
    expect(refused.received()).toMatch(/\r\nconnection: close\r\n/i);
    expect(refused.answer()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000 } });
    expect(refused.answer().error.message).toMatch(/retry in a few seconds/);
    // Only the held body is counted, and no tool ran.
    await refused.closed;
    expect(budget.inFlight('a')).toBe(call(3_000).length - 1);
    expect(state.started).toBe(0);

    held.socket.destroy();
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  });

  it("keeps each user's allowance separate", async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    await holding(port, budget, 'a', call(3_500));
    const aAgain = sized(port, 'a', call(1_000));
    aAgain.socket.write(call(1_000));
    await vi.waitFor(() => expect(aAgain.status()).toBe(429));

    expect((await post(port, 'b', call(3_500))).text).toContain('pad 3500');
  });

  it('refuses with 503 and Retry-After when the total is full, though the user has room', async () => {
    const budget = new BodyBytesBudget(4_000, 5_000, 10_000, 10_000);
    const { port } = await listening(budget);
    await holding(port, budget, 'a', call(2_300));
    await holding(port, budget, 'b', call(2_300));

    const c = await post(port, 'c', call(1_000));
    expect(c.status).toBe(503);
    expect(c.retryAfter).toBe('5');
    expect(JSON.parse(c.text)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000 } });
    expect(budget.inFlight('c')).toBe(0);
    expect(budget.largeInFlight()).toBe(0);
  });

  it('refuses a large body with 503 when the large-body allowance is full, and answers small calls', async () => {
    const budget = new BodyBytesBudget(4_000, 20_000, 6_000, 1_000);
    const { port } = await listening(budget);
    for (const user of ['a', 'b']) await holding(port, budget, user, call(2_800));
    expect(budget.largeInFlight()).toBeGreaterThan(5_800);

    const large = await post(port, 'c', call(1_500));
    expect(large.status).toBe(503);
    expect(large.retryAfter).toBe('5');
    expect(JSON.parse(large.text)).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000 },
    });

    for (const user of ['c', 'd', 'e']) {
      const small = await post(port, user, call(500));
      expect(small.status).toBe(200);
      expect(small.text).toContain('pad 500');
    }
  });

  it('counts nothing for requests that have sent only their headers', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 6_000, 1_000);
    const { port } = await listening(budget);
    const idle = ['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c'].map(user =>
      sized(port, user, call(3_800))
    );
    await sleep(100);
    expect(budget.inFlight()).toBe(0);

    const upload = await post(port, 'd', call(3_800));
    expect(upload.status).toBe(200);
    expect(upload.text).toContain('pad 3800');
    expect(idle.every(req => req.status() === 0)).toBe(true);
  });

  it('releases the bytes when the client leaves mid-body', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    const body = call(3_000);

    const req = sized(port, 'a', body);
    req.socket.write(body.slice(0, 1_000));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(1_000));

    req.socket.destroy();
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
    expect(state.started).toBe(0);
  });

  it('holds the bytes after the client leaves until the tool returns', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    const body = call(3_000, { wait: true });

    const req = sized(port, 'a', body);
    req.socket.write(body);
    await vi.waitFor(() => expect(state.running).toBe(1));

    req.socket.destroy();
    await sleep(50);
    expect(state.running).toBe(1);
    expect(budget.inFlight('a')).toBe(body.length);

    free();
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  });

  it('releases the bytes of a request refused after its body was read', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { fastify, port } = await listening(budget);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer a',
    };

    const malformed = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers,
      payload: '{"jsonrpc": ',
    });
    expect(malformed.statusCode).toBe(400);

    const batch = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers,
      payload: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      ]),
    });
    expect(batch.statusCode).toBe(400);

    // The gate refuses a call once the caller's tools/call bucket is empty.
    while (tryConsume(toolCallBucketKey('a'), TOOL_CALL_RATE_LIMIT)) {
      /* drain it */
    }
    const gated = await post(port, 'a', call(100));
    expect(gated.text).toContain('isError');
    expect(state.started).toBe(0);
    resetRateLimits();

    const failing = await post(port, 'a', call(100, { tool: THROWS }));
    expect(failing.status).toBe(200);
    expect(failing.text).toContain('isError');

    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  });
});

describe('a client that leaves while its token is checked', () => {
  const AUTH_MS = 40;

  /** A budget that also counts the requests that opened a reservation in it. */
  class CountingBudget extends BodyBytesBudget {
    opened = 0;
    override open(userId: string) {
      this.opened += 1;
      return super.open(userId);
    }
  }

  /** The user's next request is served, and nothing is held. */
  async function nothingHeld(port: number, budget: Budget, user: string) {
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
    state.authDelayMs = 0;
    const next = await post(port, user, call(3_000));
    expect(next.status).toBe(200);
    expect(next.text).toContain('pad 3000');
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  }

  it.each([
    ['closes (FIN)', (socket: net.Socket) => socket.end()],
    ['resets (RST)', (socket: net.Socket) => socket.resetAndDestroy()],
    ['destroys its socket', (socket: net.Socket) => socket.destroy()],
  ])(
    'holds nothing, and opens nothing, when it %s right after its headers',
    async (_name, leave) => {
      const budget = new CountingBudget(4_000, 10_000, 10_000, 1_000);
      const { port } = await listening(budget);
      state.authDelayMs = AUTH_MS;

      for (let i = 0; i < 5; i++) leave(sized(port, 'a', call(3_500)).socket);
      await sleep(2 * AUTH_MS);
      // Its response closed before the hooks after the token check ran, so the
      // request ends there and nothing is counted for it.
      expect(budget.opened).toBe(0);
      await nothingHeld(port, budget, 'a');
    }
  );

  it('holds nothing, and opens nothing, when it sends part of its body, then leaves', async () => {
    const budget = new CountingBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    state.authDelayMs = AUTH_MS;

    for (let i = 0; i < 5; i++) {
      const body = call(3_500);
      const req = sized(port, 'a', body);
      req.socket.write(body.slice(0, 2_000));
      req.socket.end();
    }
    await sleep(2 * AUTH_MS);
    expect(budget.opened).toBe(0);
    await nothingHeld(port, budget, 'a');
  });

  it('holds nothing, and opens nothing, when it sends a whole call, then closes at once', async () => {
    const budget = new CountingBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    state.authDelayMs = AUTH_MS;

    for (const leave of ['end', 'resetAndDestroy'] as const) {
      for (let i = 0; i < 5; i++) {
        const body = call(1_000);
        const req = sized(port, 'a', body);
        req.socket.write(body);
        req.socket[leave]();
      }
    }
    await sleep(2 * AUTH_MS);
    expect(state.started).toBe(0);
    expect(budget.opened).toBe(0);
    await nothingHeld(port, budget, 'a');
  });

  it('holds nothing wherever in the token check it leaves', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    state.authDelayMs = AUTH_MS;

    const leaving: Promise<void>[] = [];
    for (let at = 0; at <= AUTH_MS + 10; at += 5) {
      for (const how of ['end', 'resetAndDestroy'] as const) {
        const body = call(1_000);
        const req = sized(port, 'a', body);
        req.socket.write(body.slice(0, 500));
        leaving.push(sleep(at).then(() => void req.socket[how]()));
      }
    }
    await Promise.all(leaving);
    await sleep(2 * AUTH_MS);
    await nothingHeld(port, budget, 'a');
  });
});

describe('a chunked body (no Content-Length)', () => {
  it('counts its bytes as they arrive and releases them when answered', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    const body = call(2_000);
    const half = Math.floor(body.length / 2);

    const req = chunked(port, 'a');
    await sleep(50);
    expect(budget.inFlight('a')).toBe(0);

    req.chunk(body.slice(0, half));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(half));
    req.chunk(body.slice(half));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(body.length));

    req.chunk('');
    await vi.waitFor(() => expect(req.received()).toContain('pad 2000'));
    expect(req.status()).toBe(200);
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  });

  it('counts a body sent in one-byte chunks byte for byte, and answers it', async () => {
    const budget = new BodyBytesBudget(10_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);
    const body = call(3_000);

    const req = chunked(port, 'a');
    req.socket.write(
      Array.from(body)
        .map(char => `1\r\n${char}\r\n`)
        .join('')
    );
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(body.length));
    req.chunk('');
    await vi.waitFor(() => expect(req.received()).toContain('pad 3000'));
    expect(req.status()).toBe(200);
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  });

  it('refuses the body with 429 and Retry-After once it outgrows the allowance', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);

    const req = chunked(port, 'a');
    req.chunk('x'.repeat(3_000));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(3_000));
    req.chunk('x'.repeat(1_500));

    await vi.waitFor(() => expect(req.status()).toBe(429));
    expect(req.received()).toMatch(/\r\nretry-after: 5\r\n/i);
    expect(req.answer()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000 } });
    expect(state.started).toBe(0);
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));

    // The rest of the body is read and dropped; nothing more is counted.
    req.chunk('x'.repeat(3_000));
    req.chunk('');
    await sleep(50);
    expect(budget.inFlight()).toBe(0);
  });

  it('refuses with 503 when the total is full', async () => {
    const budget = new BodyBytesBudget(4_000, 5_000, 10_000, 10_000);
    const { port } = await listening(budget);
    await holding(port, budget, 'b', call(3_500));

    const req = chunked(port, 'a');
    req.chunk('x'.repeat(1_500));
    await vi.waitFor(() => expect(req.status()).toBe(503));
    expect(req.received()).toMatch(/\r\nretry-after: 5\r\n/i);
    await vi.waitFor(() => expect(req.received()).toContain('"jsonrpc":"2.0"'));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(0));
  });

  it('releases the bytes of a body over the body limit', async () => {
    const budget = new BodyBytesBudget(10_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget, 3_000);

    // Fastify sees the body in joined chunks of up to 64 KiB, or at its end.
    const req = chunked(port, 'a');
    req.chunk('x'.repeat(2_000));
    req.chunk('x'.repeat(2_000));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(4_000));
    req.chunk('');
    await vi.waitFor(() => expect(req.status()).toBe(413));
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  });

  it('releases the bytes when the client leaves mid-body', async () => {
    const budget = new BodyBytesBudget(4_000, 10_000, 10_000, 1_000);
    const { port } = await listening(budget);

    const req = chunked(port, 'a');
    req.chunk('x'.repeat(2_500));
    await vi.waitFor(() => expect(budget.inFlight('a')).toBe(2_500));

    req.socket.destroy();
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
  });
});

describe('many users at once', () => {
  it('bounds small bodies by the total, however many users send them', async () => {
    const budget = new BodyBytesBudget(4_000, 6_000, 3_000, 1_000);
    const { port } = await listening(budget);
    const body = call(800);
    expect(body.length).toBeLessThan(1_000);

    const fits = Math.floor(6_000 / (body.length - 1));

    const reqs = Array.from({ length: 10 }, (_, i) => {
      const req = sized(port, `u${i}`, body);
      req.socket.write(body.slice(0, -1));
      return req;
    });
    await vi.waitFor(() =>
      expect(reqs.filter(req => req.status() === 503)).toHaveLength(10 - fits)
    );
    expect(budget.inFlight()).toBe(fits * (body.length - 1));
    expect(budget.inFlight()).toBeLessThanOrEqual(6_000);
    expect(budget.largeInFlight()).toBe(0);
    // Every user is well within their own allowance.
    for (let i = 0; i < 10; i++) expect(budget.inFlight(`u${i}`)).toBeLessThan(1_000);
  });

  it('answers small calls from many users while a large upload is arriving', async () => {
    const budget = new BodyBytesBudget(4_000, 20_000, 4_000, 1_000);
    const { port } = await listening(budget);
    const upload = call(3_500);

    const large = sized(port, 'uploader', upload);
    large.socket.write(upload.slice(0, 2_000));
    await vi.waitFor(() => expect(budget.largeInFlight()).toBe(2_000));

    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post(port, `u${i % 10}`, call(300, { id: i })))
    );
    expect(answers.map(answer => answer.status)).toEqual(Array(30).fill(200));

    large.socket.write(upload.slice(2_000));
    await vi.waitFor(() => expect(large.received()).toContain('pad 3500'));
    expect(large.status()).toBe(200);
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
    expect(budget.largeInFlight()).toBe(0);
  });
});
