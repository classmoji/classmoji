/**
 * POST /mcp checks the bearer token in its `onRequest` hook, before Fastify
 * reads the body: a request the hook refuses is answered from its headers
 * alone, and its body is never parsed — whatever its size. An authenticated
 * request is parsed and served.
 */

import { connect, type AddressInfo, type Socket } from 'node:net';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_BODY_LIMIT_BYTES } from '../../bodyLimit.ts';
import { UnauthorizedError } from '../../mcp/errors.ts';

const mocks = vi.hoisted(() => ({
  resolveViewer: vi.fn(),
  servers: 0,
}));

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

const { default: mcpRoutes } = await import('../mcp.ts');

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

/** The server as index.ts builds it (same body limit), plus a parse spy. */
async function app() {
  const fastify = Fastify({ bodyLimit: MCP_BODY_LIMIT_BYTES });
  const preParsing = vi.fn(async () => {});
  // Registered before the routes, so it applies to POST /mcp: it runs only
  // once Fastify starts reading the body, i.e. never for a refused request.
  fastify.addHook('preParsing', preParsing);
  await fastify.register(mcpRoutes);
  return { fastify, preParsing };
}

const signedIn = () =>
  mocks.resolveViewer.mockResolvedValue({ userId: 'u1', clientId: 'c', scopes: new Set(['read']) });

beforeEach(() => {
  mocks.resolveViewer.mockReset();
  mocks.servers = 0;
});

describe('authentication before the body is read', () => {
  it('refuses an unauthenticated request without parsing its body', async () => {
    mocks.resolveViewer.mockRejectedValue(new UnauthorizedError('Missing or invalid access token'));
    const { fastify, preParsing } = await app();

    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(TOOLS_LIST),
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer resource_metadata=/);
    expect(res.json().error.message).toBe('Unauthorized: Missing or invalid access token');
    expect(preParsing).not.toHaveBeenCalled();
    expect(mocks.servers).toBe(0);
    await fastify.close();
  });

  it('answers 401 (not 413 or 400) for an oversized, malformed body without a valid token', async () => {
    mocks.resolveViewer.mockRejectedValue(new UnauthorizedError('Missing or invalid access token'));
    const { fastify, preParsing } = await app();

    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      // Over the body limit, and not JSON: either would fail at parse time.
      payload: '['.repeat(MCP_BODY_LIMIT_BYTES + 1024),
    });

    expect(res.statusCode).toBe(401);
    expect(preParsing).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('still parses and serves the body of an authenticated request', async () => {
    signedIn();
    const { fastify, preParsing } = await app();

    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer good',
      },
      payload: JSON.stringify(TOOLS_LIST),
    });

    expect(res.statusCode).toBe(200);
    expect(preParsing).toHaveBeenCalledTimes(1);
    expect(mocks.servers).toBe(1);
    expect(mocks.resolveViewer).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  it('keeps the body limit for an authenticated request', async () => {
    signedIn();
    const { fastify } = await app();

    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      payload: '['.repeat(MCP_BODY_LIMIT_BYTES + 1024),
    });

    expect(res.statusCode).toBe(413);
    expect(mocks.servers).toBe(0);
    await fastify.close();
  });

  describe('over a real socket', () => {
    let socket: Socket | undefined;
    let close: (() => Promise<void>) | undefined;

    afterEach(async () => {
      socket?.destroy();
      await close?.();
      socket = undefined;
      close = undefined;
    });

    it('answers 401 before the client has sent the body', async () => {
      mocks.resolveViewer.mockRejectedValue(
        new UnauthorizedError('Missing or invalid access token')
      );
      const { fastify, preParsing } = await app();
      await fastify.listen({ port: 0, host: '127.0.0.1' });
      close = () => fastify.close();
      const { port } = fastify.server.address() as AddressInfo;

      // Announce a body at the limit, send only its first kilobyte, then wait:
      // the answer must not depend on the rest arriving.
      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no response before the body')), 5_000);
        let received = '';
        const client = connect(port, '127.0.0.1', () => {
          client.write(
            'POST /mcp HTTP/1.1\r\n' +
              `Host: 127.0.0.1:${port}\r\n` +
              'Content-Type: application/json\r\n' +
              `Content-Length: ${MCP_BODY_LIMIT_BYTES}\r\n` +
              '\r\n' +
              '['.repeat(1024)
          );
        });
        socket = client;
        client.on('data', chunk => {
          received += chunk.toString('utf8');
          if (received.includes('\r\n\r\n')) {
            clearTimeout(timer);
            resolve(received);
          }
        });
        client.on('error', reject);
      });

      expect(response.startsWith('HTTP/1.1 401')).toBe(true);
      expect(response.toLowerCase()).toContain('www-authenticate: bearer resource_metadata=');
      expect(preParsing).not.toHaveBeenCalled();
    });
  });
});
