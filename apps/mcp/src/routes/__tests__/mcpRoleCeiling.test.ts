/**
 * The `X-Classmoji-Role-Ceiling` header: Ask Moji sends the view the chat was
 * opened in, and the route carries it on the viewer as `roleCeiling`. It is
 * read only from the Ask Moji OAuth client; another client's header is
 * ignored, whatever its value. From Ask Moji, a value that is not exactly one
 * role is refused with a 400 before any server is built.
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

const { default: mcpRoutes, roleCeilingFrom, ROLE_CEILING_HEADER } = await import('../mcp.ts');

const OTHER_CLIENT = 'claude-ai-connector';

const headersWith = (value?: string) =>
  new Headers(value === undefined ? {} : { [ROLE_CEILING_HEADER]: value });

describe('roleCeilingFrom', () => {
  it('reads each of the four roles from the Ask Moji client', () => {
    for (const role of ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER']) {
      expect(roleCeilingFrom(headersWith(role), ASK_MOJI_CLIENT_ID)).toEqual({
        ok: true,
        ceiling: role,
      });
    }
  });

  it('no header from Ask Moji means no ceiling', () => {
    expect(roleCeilingFrom(headersWith(), ASK_MOJI_CLIENT_ID)).toEqual({ ok: true, ceiling: null });
  });

  it('refuses a value from Ask Moji that is not exactly one role', () => {
    for (const bad of ['', 'student', 'Student', 'ADMIN', 'NONE', 'STUDENT, OWNER']) {
      const result = roleCeilingFrom(headersWith(bad), ASK_MOJI_CLIENT_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('X-Classmoji-Role-Ceiling');
    }
  });

  it('ignores the header from any other client, valid or not', () => {
    for (const value of ['STUDENT', 'OWNER', 'garbage', '']) {
      expect(roleCeilingFrom(headersWith(value), OTHER_CLIENT)).toEqual({
        ok: true,
        ceiling: null,
      });
      expect(roleCeilingFrom(headersWith(value), null)).toEqual({ ok: true, ceiling: null });
    }
  });
});

describe('POST /mcp with a role ceiling', () => {
  async function app() {
    const fastify = Fastify();
    await fastify.register(mcpRoutes);
    return fastify;
  }

  const post = (fastify: Awaited<ReturnType<typeof app>>, ceiling?: string | string[]) =>
    fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer t',
        ...(ceiling === undefined ? {} : { [ROLE_CEILING_HEADER]: ceiling }),
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  beforeEach(() => {
    mocks.viewers.length = 0;
    mocks.clientId = ASK_MOJI_CLIENT_ID;
  });

  it('carries an Ask Moji ceiling on the viewer', async () => {
    const fastify = await app();
    const res = await post(fastify, 'STUDENT');
    expect(res.statusCode).toBe(200);
    expect(mocks.viewers.at(-1)).toMatchObject({ userId: 'u1', roleCeiling: 'STUDENT' });
    await fastify.close();
  });

  it('sets no ceiling when Ask Moji sends none', async () => {
    const fastify = await app();
    const res = await post(fastify);
    expect(res.statusCode).toBe(200);
    expect(mocks.viewers.at(-1)?.roleCeiling).toBeNull();
    await fastify.close();
  });

  it('refuses an invalid Ask Moji value before building a server', async () => {
    const fastify = await app();
    for (const bad of ['student', 'ADMIN', '', ['STUDENT', 'OWNER']]) {
      const res = await post(fastify, bad);
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('X-Classmoji-Role-Ceiling');
    }
    expect(mocks.viewers).toHaveLength(0);
    await fastify.close();
  });

  it('ignores the header from another client', async () => {
    mocks.clientId = OTHER_CLIENT;
    const fastify = await app();
    for (const value of ['STUDENT', 'garbage']) {
      const res = await post(fastify, value);
      expect(res.statusCode).toBe(200);
      expect(mocks.viewers.at(-1)?.roleCeiling).toBeNull();
    }
    await fastify.close();
  });
});
