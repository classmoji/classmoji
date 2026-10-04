/**
 * Agent sessions on a stateless server: `initialize` is answered with a fresh
 * Mcp-Session-Id, which clients send back on later requests; that id becomes
 * `viewer.agentSession` (live editing tells one person's agent sessions apart
 * by it). It authorizes nothing, and a malformed one is ignored.
 */

import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  viewers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async () => ({ userId: 'u1', clientId: 'c', scopes: new Set(['read']) })),
}));
vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: vi.fn((viewer: Record<string, unknown>) => {
    mocks.viewers.push(viewer);
    return new McpServer({ name: 'test', version: '0' });
  }),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const { default: mcpRoutes, agentSessionFrom, isInitializeRequest, SESSION_HEADER } =
  await import('../mcp.ts');

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

async function app() {
  const fastify = Fastify();
  await fastify.register(mcpRoutes);
  return fastify;
}

const post = (fastify: Awaited<ReturnType<typeof app>>, body: unknown, session?: string) =>
  fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer t',
      ...(session ? { [SESSION_HEADER]: session } : {}),
    },
    payload: JSON.stringify(body),
  });

describe('agent sessions', () => {
  it('reads a well-formed session id and ignores anything else', () => {
    const headers = (v?: string) => new Headers(v === undefined ? {} : { [SESSION_HEADER]: v });
    expect(agentSessionFrom(headers('0f5c7a52-1c2d-4e3f-9a8b-7c6d5e4f3a2b'))).toBe(
      '0f5c7a52-1c2d-4e3f-9a8b-7c6d5e4f3a2b'
    );
    expect(agentSessionFrom(headers())).toBeNull();
    expect(agentSessionFrom(headers('two words'))).toBeNull();
    expect(agentSessionFrom(headers('x'.repeat(200)))).toBeNull();
  });

  it('knows an initialize request, alone or in a batch', () => {
    expect(isInitializeRequest(INIT)).toBe(true);
    expect(isInitializeRequest([{ method: 'ping' }, INIT])).toBe(true);
    expect(isInitializeRequest({ method: 'tools/list' })).toBe(false);
    expect(isInitializeRequest(null)).toBe(false);
  });

  it('answers each initialize with its own session id', async () => {
    const fastify = await app();
    const one = await post(fastify, INIT);
    const two = await post(fastify, INIT);
    expect(one.statusCode).toBe(200);
    const a = one.headers[SESSION_HEADER];
    const b = two.headers[SESSION_HEADER];
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    await fastify.close();
  });

  it('hands the session id a client sends back to the tools as viewer.agentSession', async () => {
    const fastify = await app();
    mocks.viewers.length = 0;
    const res = await post(fastify, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'sess-42');
    expect(res.statusCode).toBe(200);
    // Not an initialize: no new id is issued.
    expect(res.headers[SESSION_HEADER]).toBeUndefined();
    expect(mocks.viewers.at(-1)).toMatchObject({ userId: 'u1', agentSession: 'sess-42' });

    await post(fastify, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'not a token');
    expect(mocks.viewers.at(-1)).toMatchObject({ agentSession: null });
    await fastify.close();
  });
});
