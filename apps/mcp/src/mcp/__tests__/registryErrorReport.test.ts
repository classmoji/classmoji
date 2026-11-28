/**
 * Which tool and resource failures the registry hands to the error reporter
 * (`reportError`, Sentry in production): unknown errors and `internal`
 * ToolErrors (their cause when they have one), each once, tagged with the
 * surface's name, never with its arguments or a caller error's message.
 * Answers to the caller (not_found, forbidden, invalid_params, rate_limited,
 * a service refusal with a known code) are never reported, and with no
 * reporter registered the results are exactly what they were.
 *
 * Driven through a real McpServer over the SDK's in-memory transport, with a
 * fake reporter registered through `setErrorReporter`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';
import type { Viewer } from '../../auth/resolveViewer.ts';

vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

const { buildMcpServer, registerResourceDefinition, registerToolDefinition } =
  await import('../registry.ts');
const { ToolError } = await import('../errors.ts');
const { resetRateLimits } = await import('../rateLimit.ts');

const unknownError = new Error('database exploded');
const internalCause = new Error('render service timed out');
// Separate objects for the resources: one error object is reported once.
const resourceUnknown = new Error('database exploded again');
const resourceCause = new Error('leaderboard query failed');

beforeAll(() => {
  const tool = (name: string, handler: () => Promise<never>) =>
    registerToolDefinition<{ secret?: string }>({
      name,
      title: name,
      description: name,
      scope: 'read',
      roles: null,
      inputSchema: { secret: z.string().optional() },
      handler,
    });
  tool('t_unknown', async () => {
    throw unknownError;
  });
  tool('t_internal', async () => {
    throw new ToolError('internal', 'Classroom git organization is not configured', 'NO_ORG');
  });
  tool('t_internal_cause', async () => {
    throw new ToolError('internal', 'The page could not be rendered', 'RENDER_FAILED', undefined, {
      cause: internalCause,
    });
  });
  tool('t_not_found', async () => {
    throw new ToolError('not_found', 'Page not found: the student wrote this title');
  });
  tool('t_forbidden', async () => {
    throw new ToolError('forbidden', 'Owner only');
  });
  tool('t_invalid', async () => {
    throw new ToolError('invalid_params', 'Bad ops');
  });
  tool('t_caller_code', async () => {
    throw Object.assign(new Error('File type refused: secret.exe'), { code: 'FILE_REFUSED' });
  });
  registerToolDefinition({
    name: 't_ok',
    title: 't_ok',
    description: 't_ok',
    scope: 'read',
    roles: null,
    inputSchema: {},
    handler: async () => ({ content: [{ type: 'text', text: 'fine' }] }),
  });

  const resource = (name: string, handler: () => Promise<never>) =>
    registerResourceDefinition({
      name,
      uriTemplate: `classmoji-test://report/${name}`,
      title: name,
      description: name,
      scope: 'read',
      roles: null,
      handler,
    });
  resource('r_unknown', async () => {
    throw resourceUnknown;
  });
  resource('r_internal_cause', async () => {
    throw new ToolError('internal', 'Leaderboard unavailable', undefined, undefined, {
      cause: resourceCause,
    });
  });
  resource('r_not_found', async () => {
    throw new ToolError('not_found', 'No such thing');
  });
});

const captured: Array<{ error: unknown; context: ReportContext }> = [];
const fakeReporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};

beforeEach(() => {
  captured.length = 0;
  resetRateLimits();
  setErrorReporter(fakeReporter);
});

afterEach(() => {
  setErrorReporter(null);
});

let seq = 0;
async function connect() {
  seq += 1;
  const viewer: Viewer = { userId: `report-user-${seq}`, clientId: 'c', scopes: new Set(['read']) };
  const server = buildMcpServer(viewer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'report-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type CallResult = { isError?: boolean; content: Array<{ text: string }> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as unknown as CallResult;

describe('tool failures', () => {
  it('reports an unknown error once, tagged with the tool, never its arguments', async () => {
    const client = await connect();
    const result = await call(client, 't_unknown', { secret: 'the student essay' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'internal',
      message: 'Internal server error',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(unknownError);
    expect(captured[0].context).toEqual({
      surface: 'mcp.tool',
      tags: { tool: 't_unknown', error_kind: 'unknown' },
    });
    expect(JSON.stringify(captured[0].context)).not.toContain('essay');

    // The same error object is never reported twice.
    await call(client, 't_unknown');
    expect(captured).toHaveLength(1);
  });

  it('reports an internal ToolError without a cause as a warning', async () => {
    const client = await connect();
    const result = await call(client, 't_internal');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'internal', code: 'NO_ORG' });
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBeInstanceOf(ToolError);
    expect(captured[0].context).toEqual({
      surface: 'mcp.tool',
      level: 'warning',
      tags: { tool: 't_internal', error_kind: 'internal', code: 'NO_ORG' },
    });
  });

  it('reports the cause of an internal ToolError, and still answers with the ToolError', async () => {
    const client = await connect();
    const result = await call(client, 't_internal_cause');
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'internal',
      code: 'RENDER_FAILED',
      message: 'The page could not be rendered',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(internalCause);
    expect(captured[0].context).toMatchObject({ surface: 'mcp.tool', level: 'error' });
  });

  it('never reports answers to the caller', async () => {
    const client = await connect();
    for (const name of ['t_not_found', 't_forbidden', 't_invalid', 't_caller_code', 't_ok']) {
      await call(client, name);
    }
    expect(captured).toEqual([]);
  });

  it('answers the same with no reporter registered', async () => {
    setErrorReporter(null);
    const client = await connect();
    const result = await call(client, 't_unknown');
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'internal',
      message: 'Internal server error',
    });
    expect(captured).toEqual([]);
  });
});

describe('resource failures', () => {
  it('reports an unknown error and an internal cause, tagged with the resource', async () => {
    const client = await connect();
    await expect(
      client.readResource({ uri: 'classmoji-test://report/r_internal_cause' })
    ).rejects.toThrow('Leaderboard unavailable');
    await expect(client.readResource({ uri: 'classmoji-test://report/r_unknown' })).rejects.toThrow(
      'Internal server error'
    );
    expect(captured.map(c => c.error)).toEqual([resourceCause, resourceUnknown]);
    expect(captured.map(c => c.context)).toEqual([
      {
        surface: 'mcp.resource',
        level: 'error',
        tags: { resource: 'r_internal_cause', error_kind: 'internal' },
      },
      { surface: 'mcp.resource', tags: { resource: 'r_unknown', error_kind: 'unknown' } },
    ]);
  });

  it('never reports a not_found', async () => {
    const client = await connect();
    await expect(
      client.readResource({ uri: 'classmoji-test://report/r_not_found' })
    ).rejects.toThrow();
    expect(captured).toEqual([]);
  });
});
