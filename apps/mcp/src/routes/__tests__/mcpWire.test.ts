/**
 * What the HTTP route answers on the wire, with the real route, registry and
 * SDK: a notification is accepted with 202 and no body, an `initialize` sent
 * as a one-element batch still gets its session id, a tool the token may not
 * call (out of scope, or hidden from its client) is a JSON-RPC error rather
 * than a tool result, and a tool without arguments may be called with none.
 * Only token resolution, resources and services are stood in.
 */

import { ASK_MOJI_CLIENT_ID } from '@classmoji/auth/mcp-token';
import Fastify from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  viewer: { userId: 'u1', clientId: 'c', scopes: new Set(['read']) } as Record<string, unknown>,
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async () => state.viewer),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

const { default: mcpRoutes, SESSION_HEADER } = await import('../mcp.ts');
const { registerToolDefinition } = await import('../../mcp/registry.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');

beforeAll(() => {
  const probe = (name: string, scope: 'read' | 'write') =>
    registerToolDefinition({
      name,
      title: name,
      description: 'records its call',
      scope,
      roles: null,
      inputSchema: {},
      ...(scope === 'write' ? { annotations: { destructive: false } } : {}),
      handler: async args => {
        state.calls.push({ name, args });
        return { content: [{ type: 'text', text: `ran ${name}` }] };
      },
    });
  probe('wire_read', 'read');
  probe('wire_write', 'write');
  probe('ask_moji_wire', 'read');
});

afterEach(() => {
  state.viewer = { userId: 'u1', clientId: 'c', scopes: new Set(['read']) };
  state.calls.length = 0;
  resetRateLimits();
});

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
};

async function post(body: unknown) {
  const fastify = Fastify();
  await fastify.register(mcpRoutes);
  try {
    return await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        authorization: 'Bearer t',
      },
      payload: JSON.stringify(body),
    });
  } finally {
    await fastify.close();
  }
}

const call = (name: string, args?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, ...(args === undefined ? {} : { arguments: args }) },
});

describe('the MCP route on the wire', () => {
  it('accepts notifications/initialized with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('answers initialize sent as a one-element batch, with a session id', async () => {
    const res = await post([INIT]);
    expect(res.statusCode).toBe(200);
    expect(res.headers[SESSION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    // One answer, not an array of one: the SDK's rule, in 1.x as in 2.x.
    expect(res.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-11-25' },
    });
  });

  it('answers a tool outside the token scope with a JSON-RPC -32602 error', async () => {
    const res = await post(call('wire_write'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32602 } });
    expect(body).not.toHaveProperty('result');
    expect(state.calls).toEqual([]);
  });

  it('answers a tool hidden from Ask Moji with a JSON-RPC -32602 error', async () => {
    state.viewer = { userId: 'u1', clientId: ASK_MOJI_CLIENT_ID, scopes: new Set(['read']) };
    const body = (await post(call('ask_moji_wire'))).json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32602 } });
    expect(body).not.toHaveProperty('result');
    expect(state.calls).toEqual([]);
  });

  it('answers a tool that was never registered with a JSON-RPC -32602 error', async () => {
    const res = await post(call('wire_never_registered', { classroom: 'c1' }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32602 } });
    expect(body.error.message).toContain('wire_never_registered');
    expect(body).not.toHaveProperty('result');
    expect(state.calls).toEqual([]);
  });

  it('runs a tool without arguments called with none, with {} as its arguments', async () => {
    const body = (await post(call('wire_read'))).json();
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'ran wire_read' }] },
    });
    expect(body.result.isError).toBeFalsy();
    expect(state.calls).toEqual([{ name: 'wire_read', args: {} }]);
  });
});
