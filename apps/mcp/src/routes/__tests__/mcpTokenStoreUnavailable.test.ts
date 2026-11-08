/**
 * When the bearer token cannot be checked because the token store is
 * unavailable, POST /mcp answers 503 with Retry-After and a short JSON-RPC
 * error, and WITHOUT a WWW-Authenticate challenge: that header is what sends
 * an MCP client into signing in again. A token that was checked and found
 * invalid still gets the 401 challenge. Either way the body is not parsed.
 * (What counts as unavailable, including the signing keys, is resolveViewer's
 * call: resolveViewer.test.ts and jwksStoreUnavailable.test.ts.)
 */

import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStoreUnavailableError, UnauthorizedError } from '../../mcp/errors.ts';

const mocks = vi.hoisted(() => ({ resolveViewer: vi.fn(), servers: 0 }));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: (...args: unknown[]) => mocks.resolveViewer(...args),
}));
vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: vi.fn(() => {
    mocks.servers += 1;
    return new McpServer({ name: 'test', version: '0' });
  }),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const { default: mcpRoutes, TOKEN_STORE_RETRY_AFTER_SECONDS } = await import('../mcp.ts');

async function app() {
  const fastify = Fastify();
  const preParsing = vi.fn(async () => {});
  fastify.addHook('preParsing', preParsing);
  await fastify.register(mcpRoutes);
  return { fastify, preParsing };
}

const post = (fastify: Awaited<ReturnType<typeof app>>['fastify']) =>
  fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer a-token-that-may-be-fine',
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

const storeDown = () =>
  new TokenStoreUnavailableError({
    cause: new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
      code: 'P1017',
      clientVersion: '6.19.3',
    }),
  });

beforeEach(() => {
  mocks.resolveViewer.mockReset();
  mocks.servers = 0;
});

describe('token store unavailable', () => {
  it('answers 503 with Retry-After and no sign-in challenge', async () => {
    mocks.resolveViewer.mockRejectedValue(storeDown());
    const { fastify, preParsing } = await app();

    const res = await post(fastify);

    expect(res.statusCode).toBe(503);
    expect(TOKEN_STORE_RETRY_AFTER_SECONDS).toBe(30);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Service temporarily unavailable: try again shortly' },
      id: null,
    });
    expect(preParsing).not.toHaveBeenCalled();
    expect(mocks.servers).toBe(0);
    await fastify.close();
  });

  it('still answers an invalid token with the 401 challenge', async () => {
    mocks.resolveViewer.mockRejectedValue(new UnauthorizedError('Access token expired'));
    const { fastify, preParsing } = await app();

    const res = await post(fastify);

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(
      /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource", scope="read write"$/
    );
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.json().error.message).toBe('Unauthorized: Access token expired');
    expect(preParsing).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('answers an unexpected lookup failure with a 401', async () => {
    mocks.resolveViewer.mockRejectedValue(new Error('something else'));
    const { fastify } = await app();

    const res = await post(fastify);

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Unauthorized: Authentication failed');
    await fastify.close();
  });

  it('serves normally once the store is back', async () => {
    mocks.resolveViewer
      .mockRejectedValueOnce(storeDown())
      .mockResolvedValueOnce({ userId: 'u1', clientId: 'c', scopes: new Set(['read']) });
    const { fastify } = await app();

    expect((await post(fastify)).statusCode).toBe(503);
    expect((await post(fastify)).statusCode).toBe(200);
    expect(mocks.servers).toBe(1);
    await fastify.close();
  });
});
