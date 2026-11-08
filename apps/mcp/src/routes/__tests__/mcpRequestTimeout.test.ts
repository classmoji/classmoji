/**
 * The server is built with a bound on the time to RECEIVE a request
 * (serverOptions.ts): a body still arriving after it is cut off with 408 and
 * the bytes it held are freed, while a tool that takes longer than it to
 * answer is not cut off.
 *
 * The configuration is checked on the server as index.ts builds it. The
 * behaviour is checked on the real route over a loopback socket, with the
 * timings shortened so the test runs in about a second.
 */

import net from 'node:net';
import Fastify from 'fastify';
import { z } from 'zod';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_BODY_LIMIT_BYTES } from '../../bodyLimit.ts';
import {
  MCP_CONNECTIONS_CHECKING_INTERVAL_MS,
  MCP_REQUEST_TIMEOUT_MS,
  mcpServerOptions,
} from '../../serverOptions.ts';

const state = vi.hoisted(() => ({ hold: null as Promise<void> | null, running: 0 }));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async (headers: Headers) => ({
    userId: (headers.get('authorization') ?? '').replace(/^Bearer /, ''),
    clientId: 'c',
    scopes: new Set(['read']),
  })),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

const { default: mcpRoutes } = await import('../mcp.ts');
const { registerToolDefinition } = await import('../../mcp/registry.ts');
const { BodyBytesBudget } = await import('../../mcp/bodyBudget.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');

const TOOL = 'probe_slow';

beforeAll(() => {
  registerToolDefinition<{ pad?: string; wait?: boolean }>({
    name: TOOL,
    title: 'Probe slow',
    description: 'answers with the size of its pad; waits when asked',
    scope: 'read',
    roles: null,
    inputSchema: { pad: z.string().optional(), wait: z.boolean().optional() },
    handler: async ({ pad, wait }) => {
      state.running += 1;
      try {
        if (wait && state.hold) await state.hold;
        return { content: [{ type: 'text', text: `pad ${pad?.length ?? 0}` }] };
      } finally {
        state.running -= 1;
      }
    },
  });
});

let free: () => void = () => {};
let cleanup: Array<() => unknown> = [];
beforeEach(() => {
  resetRateLimits();
  state.running = 0;
  state.hold = new Promise(resolve => (free = resolve));
});
afterEach(async () => {
  free();
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

const call = (pad: number, wait = false) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: TOOL, arguments: { pad: 'x'.repeat(pad), wait } },
  });

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: 'Bearer a',
};

describe('the server options index.ts builds the server with', () => {
  it('bound the time to receive a request, and only that', async () => {
    const fastify = Fastify({ ...mcpServerOptions(), logger: false });
    cleanup.push(() => fastify.close());
    // Both are set at runtime but missing from the type declarations.
    const config = fastify.initialConfig as typeof fastify.initialConfig & {
      requestTimeout?: number;
      handlerTimeout?: number;
    };
    const server = fastify.server as typeof fastify.server & {
      connectionsCheckingInterval?: number;
    };

    expect(MCP_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(config.requestTimeout).toBe(MCP_REQUEST_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(MCP_REQUEST_TIMEOUT_MS);
    expect(server.connectionsCheckingInterval).toBe(MCP_CONNECTIONS_CHECKING_INTERVAL_MS);
    // Node cuts a request off at the longer of its header and request
    // timeouts; the header timeout must not be the longer one.
    expect(server.headersTimeout).toBeLessThanOrEqual(MCP_REQUEST_TIMEOUT_MS);
    // Nothing bounds a response: no socket idle timeout, no handler timeout.
    expect(config.connectionTimeout).toBe(0);
    expect(config.handlerTimeout ?? 0).toBe(0);
    expect(config.bodyLimit).toBe(MCP_BODY_LIMIT_BYTES);
  });

  it('keep the header timeout within a request timeout shorter than its 60 s default', async () => {
    const fastify = Fastify({ ...mcpServerOptions(30_000), logger: false });
    cleanup.push(() => fastify.close());

    expect(fastify.server.requestTimeout).toBe(30_000);
    expect(fastify.server.headersTimeout).toBeLessThanOrEqual(30_000);
  });

  it('serve POST /mcp, including a body over Fastify’s default limit', async () => {
    const fastify = Fastify({ ...mcpServerOptions(), logger: false });
    cleanup.push(() => fastify.close());
    await fastify.register(mcpRoutes, { bodyBudget: new BodyBytesBudget() });

    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: HEADERS,
      payload: call(2 * 1024 * 1024),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().result.content[0].text).toBe(`pad ${2 * 1024 * 1024}`);
  });
});

describe('the request timeout, shortened', () => {
  const TIMEOUT_MS = 400;
  const CHECK_MS = 50;

  async function listening(bodyBudget = new BodyBytesBudget()) {
    const fastify = Fastify({ ...mcpServerOptions(TIMEOUT_MS, CHECK_MS), logger: false });
    await fastify.register(mcpRoutes, { bodyBudget });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const address = fastify.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    cleanup.push(() => fastify.close());
    return { port: address.port, bodyBudget };
  }

  /** Sends the headers of a POST /mcp announcing `body`, and `sent` bytes of it. */
  function post(port: number, body: string, sent = body.length) {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', chunk => (received += chunk.toString()));
    socket.on('error', () => {});
    const closed = new Promise<number>(resolve => socket.on('close', () => resolve(Date.now())));
    cleanup.push(() => socket.destroy());
    socket.write(
      [
        'POST /mcp HTTP/1.1',
        'Host: 127.0.0.1',
        `Content-Type: ${HEADERS['content-type']}`,
        `Accept: ${HEADERS.accept}`,
        `Authorization: ${HEADERS.authorization}`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        body.slice(0, sent),
      ].join('\r\n')
    );
    return { closed, received: () => received };
  }

  it('cuts off a body still arriving with 408, and frees what it held', async () => {
    const { port, bodyBudget } = await listening();
    const body = call(10_000);
    const started = Date.now();

    const req = post(port, body, 5_000);
    await vi.waitFor(() => expect(bodyBudget.inFlight('a')).toBe(5_000));

    const closedAt = await req.closed;
    expect(req.received()).toMatch(/^HTTP\/1\.1 408 /);
    expect(closedAt - started).toBeGreaterThanOrEqual(TIMEOUT_MS);
    expect(closedAt - started).toBeLessThan(TIMEOUT_MS + 1_000);
    await vi.waitFor(() => expect(bodyBudget.inFlight()).toBe(0));
    expect(state.running).toBe(0);
  });

  it('does not cut off a tool that answers well after the timeout', async () => {
    const { port, bodyBudget } = await listening();

    const req = post(port, call(1_000, true));
    await vi.waitFor(() => expect(state.running).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 3 * TIMEOUT_MS));
    expect(req.received()).toBe('');

    free();
    await vi.waitFor(() => expect(req.received()).toContain('pad 1000'));
    expect(req.received()).toMatch(/^HTTP\/1\.1 200 /);
    await vi.waitFor(() => expect(bodyBudget.inFlight()).toBe(0));
  });

  it('closes the connection of a refused request whose body never finishes', async () => {
    const { port, bodyBudget } = await listening(new BodyBytesBudget(1_000, 10_000));
    const started = Date.now();

    const req = post(port, call(5_000), 2_000);
    await vi.waitFor(() => expect(req.received()).toMatch(/^HTTP\/1\.1 429 /));

    const closedAt = await req.closed;
    expect(closedAt - started).toBeLessThan(TIMEOUT_MS + 1_000);
    await vi.waitFor(() => expect(bodyBudget.inFlight()).toBe(0));
  });
});
