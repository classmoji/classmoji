/**
 * A large tool call's in-flight reservation (mcp/inputLimits.ts) is held until
 * the response has closed AND every tool handler the request started has
 * returned (releaseWhenSettled), and a handler whose request is already gone
 * is not run (registry.ts wrapHandler).
 *
 * The route, the gate, the budget, the registry and the SDK are real; a probe
 * tool registered through `registerToolDefinition` waits on a promise the
 * test controls. Only token resolution, resources and services are stood in.
 * The server listens on a loopback port so a client can leave mid-call.
 */

import net from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import Fastify from 'fastify';
import { z } from 'zod';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '../../auth/resolveViewer.ts';

const state = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  started: 0,
  running: 0,
  /** probe_checked: its argument check waits on this, counted while it waits. */
  checkHold: null as Promise<void> | null,
  checking: 0,
  checkedStarted: 0,
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async () => ({
    userId: 'u1',
    clientId: 'c',
    scopes: new Set(['read']),
  })),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

const { default: mcpRoutes } = await import('../mcp.ts');
const { buildMcpServer, registerToolDefinition } = await import('../../mcp/registry.ts');
const { releaseWhenSettled, ToolInputBudget } = await import('../../mcp/inputLimits.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');

const TOOL = 'probe_hold';
const CHECKED = 'probe_checked';

beforeAll(() => {
  registerToolDefinition<{ value: string }>({
    name: CHECKED,
    title: 'Probe checked',
    description: 'its argument check waits until the test lets it finish',
    scope: 'read',
    roles: null,
    inputSchema: {
      value: z.string().refine(async () => {
        state.checking += 1;
        if (state.checkHold) await state.checkHold;
        return true;
      }),
    },
    handler: async () => {
      state.checkedStarted += 1;
      return { content: [{ type: 'text', text: 'ran' }] };
    },
  });

  registerToolDefinition<{ items: number[] }>({
    name: TOOL,
    title: 'Probe hold',
    description: 'waits until the test lets it finish',
    scope: 'read',
    roles: null,
    inputSchema: { items: z.array(z.number()) },
    handler: async ({ items }) => {
      state.started += 1;
      state.running += 1;
      try {
        if (state.hold) await state.hold;
        return { content: [{ type: 'text', text: `summed ${items.length}` }] };
      } finally {
        state.running -= 1;
      }
    },
  });
});

let free: () => void = () => {};
beforeEach(() => {
  resetRateLimits();
  state.started = 0;
  state.running = 0;
  state.hold = new Promise(resolve => (free = resolve));
});
afterEach(() => free());

const body = (items: number, id: number | string = 1) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: TOOL, arguments: { items: Array.from({ length: items }, () => 0) } },
  });

async function listening(budget: InstanceType<typeof ToolInputBudget>) {
  const fastify = Fastify({ logger: false });
  await fastify.register(mcpRoutes, { budget });
  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const address = fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { fastify, port: address.port };
}

/** Sends a POST /mcp on a raw socket, so the test can close it mid-call. */
function rawPost(port: number, payload: string) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', chunk => (received += chunk.toString()));
  socket.on('error', () => {});
  socket.write(
    [
      'POST /mcp HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      'Accept: application/json, text/event-stream',
      'Authorization: Bearer t',
      `Content-Length: ${Buffer.byteLength(payload)}`,
      '',
      payload,
    ].join('\r\n')
  );
  return { socket, received: () => received };
}

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

describe('releaseWhenSettled', () => {
  it('releases once the response has closed and every handler has returned', () => {
    const release = vi.fn();
    const work = releaseWhenSettled(release);

    expect(work.tracker.enter()).toBe(true);
    expect(work.tracker.enter()).toBe(true);
    work.close();
    expect(release).not.toHaveBeenCalled();
    work.tracker.exit();
    expect(release).not.toHaveBeenCalled();
    work.tracker.exit();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases on close when no handler started, and refuses a handler after that', () => {
    const release = vi.fn();
    const work = releaseWhenSettled(release);

    work.close();
    expect(release).toHaveBeenCalledTimes(1);
    expect(work.tracker.enter()).toBe(false);
  });

  it('does not release while the response is open, even with no handler running', () => {
    const release = vi.fn();
    const work = releaseWhenSettled(release);

    expect(work.tracker.enter()).toBe(true);
    work.tracker.exit();
    expect(release).not.toHaveBeenCalled();
    work.close();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('a client that disconnects during a large call', () => {
  it('leaves the reservation held until the tool returns', async () => {
    const budget = new ToolInputBudget(5_000, 8_000);
    const { fastify, port } = await listening(budget);

    const first = rawPost(port, body(4_000, 'a'));
    await vi.waitFor(() => expect(state.running).toBe(1));
    // 4,000 items plus the `items` member.
    expect(budget.inFlight('u1')).toBe(4_001);

    first.socket.destroy();
    await tick();
    expect(state.running).toBe(1);
    expect(budget.inFlight('u1')).toBe(4_001);

    // A second large call still finds the budget taken.
    const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer t',
      },
      body: body(4_000, 'b'),
    }).then(r => r.json());
    expect(JSON.parse(second.result.content[0].text)).toMatchObject({ code: 'BUSY' });
    expect(state.started).toBe(1);

    free();
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
    expect(state.running).toBe(0);
    await fastify.close();
  });

  it('releases a connected call when its response is sent', async () => {
    const budget = new ToolInputBudget(5_000, 8_000);
    const { fastify, port } = await listening(budget);

    const call = rawPost(port, body(4_000));
    await vi.waitFor(() => expect(state.running).toBe(1));
    free();
    await vi.waitFor(() => expect(call.received()).toContain('summed 4000'));
    await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
    call.socket.destroy();
    await fastify.close();
  });
});

describe('wrapHandler', () => {
  const viewer = { userId: 'u1', clientId: 'c', scopes: new Set(['read']) } as unknown as Viewer;
  type Handler = (args: unknown, extra: unknown) => Promise<{ isError?: boolean }>;
  /** The handler the SDK calls for the probe tool (registry.ts wrapHandler). */
  const handlerOf = (server: ReturnType<typeof buildMcpServer>): Handler => {
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })
      ._registeredTools;
    const tool = tools[TOOL];
    if (!tool) throw new Error(`${TOOL} is not registered`);
    return tool.handler;
  };

  it('does not run a tool whose request was already aborted', async () => {
    const result = await handlerOf(buildMcpServer(viewer))(
      { items: [1] },
      { mcpReq: { signal: AbortSignal.abort() } }
    );

    expect(result.isError).toBe(true);
    expect(state.started).toBe(0);
  });

  it('does not run a tool once the tracker refuses it', async () => {
    const tracker = { enter: vi.fn(() => false), exit: vi.fn() };
    const result = await handlerOf(buildMcpServer(viewer, tracker))(
      { items: [1] },
      { mcpReq: { signal: new AbortController().signal } }
    );

    expect(result.isError).toBe(true);
    expect(state.started).toBe(0);
    expect(tracker.exit).not.toHaveBeenCalled();
  });

  it('counts a tool that runs, until it returns', async () => {
    const tracker = { enter: vi.fn(() => true), exit: vi.fn() };
    const pending = handlerOf(buildMcpServer(viewer, tracker))(
      { items: [1, 2] },
      { mcpReq: { signal: new AbortController().signal } }
    );

    await vi.waitFor(() => expect(state.running).toBe(1));
    expect(tracker.enter).toHaveBeenCalledTimes(1);
    expect(tracker.exit).not.toHaveBeenCalled();
    free();
    expect((await pending).isError).toBeUndefined();
    expect(tracker.exit).toHaveBeenCalledTimes(1);
  });

  it('does not run a tool whose call a client cancelled while its arguments were checked', async () => {
    let release!: () => void;
    state.checkHold = new Promise<void>(resolve => (release = resolve));
    state.checking = 0;
    state.checkedStarted = 0;
    const tracker = { enter: vi.fn(() => true), exit: vi.fn() };
    const server = buildMcpServer(viewer, tracker);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cancel', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    let cancelled = false;
    const deliver = serverTransport.onmessage!;
    serverTransport.onmessage = (message, extra) => {
      deliver(message, extra);
      if ((message as { method?: string }).method === 'notifications/cancelled') cancelled = true;
    };

    const controller = new AbortController();
    const call = client.callTool(
      { name: CHECKED, arguments: { value: 'x' } },
      { signal: controller.signal }
    );
    // The arguments are parsed synchronously first; an asynchronous check makes zod
    // parse again asynchronously, so this check starts twice.
    await vi.waitFor(() => expect(state.checking).toBeGreaterThan(0));
    controller.abort('the caller left');
    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(state.checkedStarted).toBe(0);
    expect(tracker.enter).not.toHaveBeenCalled();

    // The same call, not cancelled, runs the tool once its check passes.
    const done = await client.callTool({ name: CHECKED, arguments: { value: 'x' } });
    expect(done.isError).toBeFalsy();
    expect(state.checkedStarted).toBe(1);
    expect(tracker.enter).toHaveBeenCalledTimes(1);
    state.checkHold = null;
    await client.close();
  });
});
