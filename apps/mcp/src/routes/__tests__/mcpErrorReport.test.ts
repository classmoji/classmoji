/**
 * What the HTTP layer hands to the error reporter (`reportError`, Sentry in
 * production): a failed token check that is not a refused token (answered
 * 401 or 503), a transport failure, and every 5xx the server's error handler
 * answers. A refused token and every 4xx are never reported, and the answers
 * are the same with or without a reporter.
 */

import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';
import { TokenStoreUnavailableError, UnauthorizedError } from '../../mcp/errors.ts';

const mocks = vi.hoisted(() => ({
  resolveViewer: vi.fn(),
  buildMcpServer: vi.fn(),
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: (...args: unknown[]) => mocks.resolveViewer(...args),
}));
vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: (...args: unknown[]) => mocks.buildMcpServer(...args),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const { default: mcpRoutes } = await import('../mcp.ts');
const { mcpErrorHandler } = await import('../../httpErrorHandler.ts');

const captured: Array<{ error: unknown; context: ReportContext }> = [];
const fakeReporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};

beforeEach(() => {
  captured.length = 0;
  mocks.resolveViewer.mockReset();
  mocks.buildMcpServer.mockReset();
  mocks.buildMcpServer.mockImplementation(() => new McpServer({ name: 'test', version: '0' }));
  setErrorReporter(fakeReporter);
});

afterEach(() => {
  setErrorReporter(null);
});

async function mcpApp() {
  const fastify = Fastify();
  await fastify.register(mcpRoutes);
  return fastify;
}

const postMcp = (fastify: Awaited<ReturnType<typeof mcpApp>>) =>
  fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer some-token',
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

describe('token check', () => {
  it('reports the cause behind a 503 when the token store is unavailable', async () => {
    const cause = new Error('Server has closed the connection.');
    mocks.resolveViewer.mockRejectedValue(new TokenStoreUnavailableError({ cause }));
    const res = await postMcp(await mcpApp());
    expect(res.statusCode).toBe(503);
    expect(captured).toEqual([{ error: cause, context: { surface: 'mcp.auth.token_store' } }]);
  });

  it('reports a failure that is not a refused token, still answered 401', async () => {
    const failure = new TypeError('Cannot read properties of undefined');
    mocks.resolveViewer.mockRejectedValue(failure);
    const res = await postMcp(await mcpApp());
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Unauthorized: Authentication failed');
    expect(captured).toEqual([{ error: failure, context: { surface: 'mcp.auth' } }]);
  });

  it('never reports a refused token', async () => {
    mocks.resolveViewer.mockRejectedValue(new UnauthorizedError('Token expired'));
    const res = await postMcp(await mcpApp());
    expect(res.statusCode).toBe(401);
    expect(captured).toEqual([]);
  });
});

describe('transport', () => {
  it('reports a transport failure and answers 500', async () => {
    mocks.resolveViewer.mockResolvedValue({ userId: 'u1', clientId: 'c', scopes: new Set() });
    const failure = new Error('connect failed');
    mocks.buildMcpServer.mockImplementation(() => ({
      connect: async () => {
        throw failure;
      },
      close: async () => {},
    }));
    const res = await postMcp(await mcpApp());
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: -32603 } });
    expect(captured).toEqual([{ error: failure, context: { surface: 'mcp.transport' } }]);
  });
});

describe('the /mcp route', () => {
  it('reports an error that escapes the handler as a 5xx, once', async () => {
    mocks.resolveViewer.mockResolvedValue({ userId: 'u1', clientId: 'c', scopes: new Set() });
    const failure = new Error('server build failed');
    mocks.buildMcpServer.mockImplementation(() => {
      throw failure;
    });
    const fastify = await mcpApp();
    fastify.setErrorHandler(mcpErrorHandler);
    const res = await postMcp(fastify);
    expect(res.statusCode).toBe(500);
    expect(captured).toEqual([
      { error: failure, context: { surface: 'mcp.http', tags: { status: 500 }, handled: false } },
    ]);
  });

  it('never reports a 4xx from the route, such as a body that is not JSON', async () => {
    mocks.resolveViewer.mockResolvedValue({ userId: 'u1', clientId: 'c', scopes: new Set() });
    const res = await (
      await mcpApp()
    ).inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(captured).toEqual([]);
  });
});

describe('the server error handler', () => {
  async function appThrowing(error: unknown) {
    const fastify = Fastify();
    fastify.setErrorHandler(mcpErrorHandler);
    fastify.get('/boom', async () => {
      throw error;
    });
    return fastify;
  }

  it('reports a 5xx once and answers a generic 500', async () => {
    const failure = new Error('db password is hunter2');
    const res = await (await appThrowing(failure)).inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' });
    expect(captured).toEqual([
      {
        error: failure,
        context: { surface: 'mcp.http', tags: { status: 500 }, handled: false },
      },
    ]);
  });

  it('never reports a 4xx, and answers it with its status', async () => {
    const refusal = Object.assign(new Error('Body is too large'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    const res = await (await appThrowing(refusal)).inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: 'FST_ERR_CTP_BODY_TOO_LARGE',
      message: 'Body is too large',
    });
    expect(captured).toEqual([]);
  });

  it('answers the same with no reporter registered', async () => {
    setErrorReporter(null);
    const res = await (await appThrowing(new Error('x'))).inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' });
  });
});
