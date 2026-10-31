/**
 * The `X-Classmoji-Impersonated-By` header: the Ask Moji task sends the
 * actor's user id on every request of a conversation that runs under
 * impersonation, and the route carries it on the viewer as `impersonatedBy`
 * (written as `impersonated_by` into every audit row, see readAudit.test.ts).
 * It is read only from the Ask Moji OAuth client; another client's header is
 * ignored, whatever its value. From Ask Moji, a value that is not a plain id
 * is refused with a 400 before any server is built.
 */

import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ASK_MOJI_CLIENT_ID } from '@classmoji/auth/mcp-token';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientId: 'classmoji-ask-moji' as string | null,
  viewers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async () => ({
    userId: 'u1',
    clientId: mocks.clientId,
    scopes: new Set(['read']),
  })),
}));
vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: vi.fn((viewer: Record<string, unknown>) => {
    mocks.viewers.push(viewer);
    return new McpServer({ name: 'test', version: '0' });
  }),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const {
  default: mcpRoutes,
  impersonatedByFrom,
  IMPERSONATED_BY_HEADER,
} = await import('../mcp.ts');

const OTHER_CLIENT = 'claude-ai-connector';
const BAD_VALUES = ['', 'admin 1', 'a/b', 'a.b', 'a:b', '<script>', 'x'.repeat(65), '%41'];

const headersWith = (value?: string) =>
  new Headers(value === undefined ? {} : { [IMPERSONATED_BY_HEADER]: value });

describe('impersonatedByFrom', () => {
  it('reads an id from the Ask Moji client', () => {
    for (const id of ['admin-1', 'cuid_abc123', 'A', 'x'.repeat(64)]) {
      expect(impersonatedByFrom(headersWith(id), ASK_MOJI_CLIENT_ID)).toEqual({
        ok: true,
        impersonatedBy: id,
      });
    }
  });

  it('no header from Ask Moji means no impersonation', () => {
    expect(impersonatedByFrom(headersWith(), ASK_MOJI_CLIENT_ID)).toEqual({
      ok: true,
      impersonatedBy: null,
    });
  });

  it('refuses a value from Ask Moji that is not an id', () => {
    for (const bad of BAD_VALUES) {
      const result = impersonatedByFrom(headersWith(bad), ASK_MOJI_CLIENT_ID);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.message).toContain('X-Classmoji-Impersonated-By');
    }
  });

  it('ignores the header from any other client, valid or not', () => {
    for (const value of ['admin-1', 'a/b', '']) {
      expect(impersonatedByFrom(headersWith(value), OTHER_CLIENT)).toEqual({
        ok: true,
        impersonatedBy: null,
      });
      expect(impersonatedByFrom(headersWith(value), null)).toEqual({
        ok: true,
        impersonatedBy: null,
      });
    }
  });
});

describe('POST /mcp with an impersonation actor', () => {
  async function app() {
    const fastify = Fastify();
    await fastify.register(mcpRoutes);
    return fastify;
  }

  const post = (fastify: Awaited<ReturnType<typeof app>>, actor?: string | string[]) =>
    fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer t',
        ...(actor === undefined ? {} : { [IMPERSONATED_BY_HEADER]: actor }),
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  beforeEach(() => {
    mocks.viewers.length = 0;
    mocks.clientId = ASK_MOJI_CLIENT_ID;
  });

  it('carries the Ask Moji actor on the viewer', async () => {
    const fastify = await app();
    const res = await post(fastify, 'admin-1');
    expect(res.statusCode).toBe(200);
    expect(mocks.viewers.at(-1)).toMatchObject({ userId: 'u1', impersonatedBy: 'admin-1' });
    await fastify.close();
  });

  it('sets no actor when Ask Moji sends none', async () => {
    const fastify = await app();
    const res = await post(fastify);
    expect(res.statusCode).toBe(200);
    expect(mocks.viewers.at(-1)?.impersonatedBy).toBeNull();
    await fastify.close();
  });

  it('refuses an invalid Ask Moji value before building a server', async () => {
    const fastify = await app();
    for (const bad of ['a/b', 'admin 1', 'x'.repeat(65), ['admin-1', 'admin-2']]) {
      const res = await post(fastify, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('X-Classmoji-Impersonated-By');
    }
    expect(mocks.viewers).toHaveLength(0);
    await fastify.close();
  });

  it('ignores the header from another client', async () => {
    mocks.clientId = OTHER_CLIENT;
    const fastify = await app();
    for (const value of ['admin-1', 'a/b']) {
      const res = await post(fastify, value);
      expect(res.statusCode).toBe(200);
      expect(mocks.viewers.at(-1)?.impersonatedBy).toBeNull();
    }
    await fastify.close();
  });
});
