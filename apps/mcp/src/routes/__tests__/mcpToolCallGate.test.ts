/**
 * POST /mcp gates every tools/call before the SDK validates it
 * (toolCallGate.ts, numbers in mcp/inputLimits.ts):
 *   - a body with too many JSON values is refused with a 413 without parsing;
 *   - each tools/call takes a token from the caller's tools/call bucket, refused or not
 *     (a small file_upload_status poll takes none);
 *   - arguments over MAX_TOOL_INPUT_ELEMENTS get a tool error, id kept, nothing built;
 *   - a large call needs room in the in-flight budget, or gets a retry tool error.
 */

import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_BODY_LIMIT_BYTES } from '../../bodyLimit.ts';
import {
  MAX_BODY_JSON_VALUES,
  MAX_TOOL_INPUT_ELEMENTS,
  ToolInputBudget,
} from '../../mcp/inputLimits.ts';
import { resetRateLimits, TOOL_CALL_RATE_LIMIT } from '../../mcp/rateLimit.ts';

const mocks = vi.hoisted(() => ({
  userId: 'u1',
  servers: 0,
  hold: null as Promise<void> | null,
  calls: 0,
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async () => ({
    userId: mocks.userId,
    clientId: 'c',
    scopes: new Set(['read']),
  })),
}));
vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: vi.fn(() => {
    mocks.servers += 1;
    const server = new McpServer({ name: 'test', version: '0' });
    server.registerTool('t_any', { inputSchema: { items: z.array(z.unknown()) } }, async () => {
      mocks.calls += 1;
      if (mocks.hold) await mocks.hold;
      return { content: [{ type: 'text', text: 'ran' }] };
    });
    // page_asset_upload's shape: the file travels as one base64 string.
    server.registerTool(
      't_upload',
      { inputSchema: { filename: z.string(), data_base64: z.string() } },
      async ({ data_base64 }) => {
        mocks.calls += 1;
        return { content: [{ type: 'text', text: `received ${data_base64.length}` }] };
      }
    );
    server.registerTool(
      'file_upload_status',
      { inputSchema: { classroom: z.string(), upload_id: z.string() } },
      async () => {
        mocks.calls += 1;
        return { content: [{ type: 'text', text: 'placing' }] };
      }
    );
    return server;
  }),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const { default: mcpRoutes } = await import('../mcp.ts');

const logLines: Array<Record<string, unknown>> = [];

async function app(budget = new ToolInputBudget()) {
  const fastify = Fastify({
    bodyLimit: MCP_BODY_LIMIT_BYTES,
    logger: {
      level: 'warn',
      stream: { write: (line: string) => void logLines.push(JSON.parse(line)) },
    },
  });
  await fastify.register(mcpRoutes, { budget });
  return fastify;
}

const call = (items: number, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 't_any', arguments: { items: Array.from({ length: items }, () => 0) } },
});

const post = (fastify: Awaited<ReturnType<typeof app>>, body: unknown) =>
  fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer t',
    },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** The `{ error, code, message }` of a tool-error result. */
const toolError = (envelope: {
  result?: { isError?: boolean; content: Array<{ text: string }> };
}) => {
  expect(envelope.result?.isError).toBe(true);
  return JSON.parse(envelope.result?.content[0].text ?? 'null') as {
    error: string;
    code: string;
    message: string;
  };
};

beforeEach(() => {
  resetRateLimits();
  mocks.userId = 'u1';
  mocks.servers = 0;
  mocks.calls = 0;
  mocks.hold = null;
  logLines.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('size', () => {
  it('answers a call over the element limit with a tool error, keeping its id', async () => {
    const fastify = await app();
    const res = await post(fastify, call(MAX_TOOL_INPUT_ELEMENTS + 1, 'req-7'));

    expect(res.statusCode).toBe(200);
    const envelope = res.json();
    expect(envelope.id).toBe('req-7');
    const error = toolError(envelope);
    expect(error).toMatchObject({ error: 'invalid_params', code: 'INPUT_TOO_LARGE' });
    expect(error.message).toContain("'t_any'");
    // 25,001 items plus the `items` member itself.
    expect(error.message).toContain('25002 elements');
    expect(error.message).toMatch(/Split the change into several smaller calls/);
    expect(mocks.servers).toBe(0);
    await fastify.close();
  });

  it('logs who, which tool and how many, never the arguments', async () => {
    const fastify = await app();
    await post(fastify, call(MAX_TOOL_INPUT_ELEMENTS + 1));

    const line = logLines.find(l => l.msg === '[mcp] tool input over the element limit');
    expect(line).toMatchObject({
      userId: 'u1',
      clientId: 'c',
      tools: ['t_any'],
      elements: MAX_TOOL_INPUT_ELEMENTS + 2,
      limit: MAX_TOOL_INPUT_ELEMENTS,
    });
    expect(JSON.stringify(line)).not.toContain('"items"');
    await fastify.close();
  });

  it('lets a call at the limit through to the tool', async () => {
    const fastify = await app();
    const res = await post(fastify, call(MAX_TOOL_INPUT_ELEMENTS - 1));
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    expect(mocks.calls).toBe(1);
    await fastify.close();
  });

  it('adds up a batch, and refuses the whole batch', async () => {
    const fastify = await app();
    const res = await post(fastify, [
      call(15_000, 1),
      call(15_000, 2),
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);

    const answers = res.json();
    expect(answers).toHaveLength(3);
    expect(toolError(answers[0]).code).toBe('INPUT_TOO_LARGE');
    expect(toolError(answers[1]).message).toContain('this batch of 2 calls contain 30002 elements');
    expect(answers[2]).toMatchObject({ id: 3, error: { code: -32600 } });
    expect(mocks.servers).toBe(0);
    await fastify.close();
  });

  it('refuses a body with too many JSON values with a 413, without parsing it', async () => {
    const fastify = await app();
    const parse = vi.spyOn(JSON, 'parse');
    const body = JSON.stringify(call(MAX_BODY_JSON_VALUES + 10));

    const res = await post(fastify, body);
    const parsedTheBody = parse.mock.calls.some(([text]) => text === body);
    parse.mockRestore();

    expect(res.statusCode).toBe(413);
    expect(parsedTheBody).toBe(false);
    expect(mocks.servers).toBe(0);
    expect(
      logLines.find(l => l.msg === '[mcp] request body over the JSON value limit')
    ).toMatchObject({ userId: 'u1', limit: MAX_BODY_JSON_VALUES });
    await fastify.close();
  });

  it('accepts a body near the size limit made of one long string (a file upload)', async () => {
    const fastify = await app();
    const envelope = (data: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'upload',
        method: 'tools/call',
        params: { name: 't_upload', arguments: { filename: 'photo.png', data_base64: data } },
      });
    const room = MCP_BODY_LIMIT_BYTES - envelope('').length - 1024;
    const data = randomBytes(Math.floor(room / 4) * 3).toString('base64');
    const body = envelope(data);
    expect(body.length).toBeGreaterThan(MCP_BODY_LIMIT_BYTES - 2048);
    expect(body.length).toBeLessThanOrEqual(MCP_BODY_LIMIT_BYTES);

    const res = await post(fastify, body);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'upload',
      result: { content: [{ type: 'text', text: `received ${data.length}` }] },
    });
    expect(mocks.servers).toBe(1);
    expect(mocks.calls).toBe(1);
    await fastify.close();
  });

  it("otherwise parses with Fastify's own rules: malformed JSON is a 400, a poisoned key is refused", async () => {
    const fastify = await app();
    expect((await post(fastify, '{"jsonrpc":')).statusCode).toBe(400);
    expect((await post(fastify, '{"__proto__":{"x":1}}')).statusCode).toBe(400);
    await fastify.close();
  });
});

describe('rate', () => {
  it('takes a token for every tools/call, including refused ones', async () => {
    const fastify = await app();
    for (let i = 0; i < TOOL_CALL_RATE_LIMIT.capacity; i++) {
      const res = await post(fastify, call(MAX_TOOL_INPUT_ELEMENTS + 1, i));
      expect(toolError(res.json()).code).toBe('INPUT_TOO_LARGE');
    }

    const res = await post(fastify, call(1, 'next'));
    const error = toolError(res.json());
    expect(error).toMatchObject({ error: 'rate_limited', code: 'RATE_LIMITED' });
    expect(mocks.calls).toBe(0);
    await fastify.close();
  });

  it('a body refused before parsing takes one too', async () => {
    const fastify = await app();
    const big = JSON.stringify(call(MAX_BODY_JSON_VALUES + 10));
    for (let i = 0; i < TOOL_CALL_RATE_LIMIT.capacity; i++) {
      expect((await post(fastify, big)).statusCode).toBe(413);
    }
    expect(toolError((await post(fastify, call(1))).json()).code).toBe('RATE_LIMITED');
    await fastify.close();
  });

  it('leaves file_upload_status polls to their own limit', async () => {
    const fastify = await app();
    const poll = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'file_upload_status', arguments: { classroom: 'org/slug', upload_id: 'u' } },
    });
    for (let i = 0; i < TOOL_CALL_RATE_LIMIT.capacity + 10; i++) {
      expect((await post(fastify, poll(i))).json().result).toEqual({
        content: [{ type: 'text', text: 'placing' }],
      });
    }

    // The shared bucket is untouched: a full burst of other calls still runs.
    for (let i = 0; i < TOOL_CALL_RATE_LIMIT.capacity; i++) {
      expect((await post(fastify, call(1, i))).json().result.isError).toBeUndefined();
    }
    expect(toolError((await post(fastify, call(1))).json()).code).toBe('RATE_LIMITED');
    await fastify.close();
  });

  it('counts a file_upload_status call with larger arguments like any other', async () => {
    const fastify = await app();
    const padded = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'file_upload_status',
        arguments: { classroom: 'org/slug', upload_id: 'u', extra: [1, 2, 3] },
      },
    });
    for (let i = 0; i < TOOL_CALL_RATE_LIMIT.capacity; i++) {
      expect((await post(fastify, padded(i))).json().result.isError).toBeUndefined();
    }
    const error = toolError((await post(fastify, padded(99))).json());
    expect(error).toMatchObject({ error: 'rate_limited', code: 'RATE_LIMITED' });
    await fastify.close();
  });

  it('is per user, and leaves other methods alone', async () => {
    const fastify = await app();
    for (let i = 0; i < TOOL_CALL_RATE_LIMIT.capacity; i++) await post(fastify, call(1, i));
    expect(toolError((await post(fastify, call(1))).json()).code).toBe('RATE_LIMITED');

    const list = await post(fastify, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(list.json().result.tools).toBeDefined();

    mocks.userId = 'u2';
    expect((await post(fastify, call(1))).json().result.isError).toBeUndefined();
    await fastify.close();
  });
});

describe('in flight', () => {
  it('asks a large call to retry while the budget is taken, and lets it in once freed', async () => {
    let free!: () => void;
    mocks.hold = new Promise(resolve => (free = resolve));
    const fastify = await app(new ToolInputBudget(5_000, 8_000));

    const first = post(fastify, call(4_000, 'a'));
    await vi.waitFor(() => expect(mocks.calls).toBe(1));

    const second = await post(fastify, call(4_000, 'b'));
    expect(toolError(second.json())).toMatchObject({ error: 'rate_limited', code: 'BUSY' });
    expect(toolError(second.json()).message).toMatch(/retry in a few seconds/);

    // Small calls take no budget.
    mocks.hold = null;
    expect((await post(fastify, call(100, 'c'))).json().result.isError).toBeUndefined();

    free();
    expect((await first).json().result).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    expect((await post(fastify, call(4_000, 'd'))).json().result.isError).toBeUndefined();
    await fastify.close();
  });

  it('holds the server-wide budget across users', async () => {
    let free!: () => void;
    mocks.hold = new Promise(resolve => (free = resolve));
    const fastify = await app(new ToolInputBudget(5_000, 8_000));

    const first = post(fastify, call(4_500));
    await vi.waitFor(() => expect(mocks.calls).toBe(1));
    mocks.userId = 'u2';
    const second = post(fastify, call(3_000));
    await vi.waitFor(() => expect(mocks.calls).toBe(2));
    mocks.userId = 'u3';
    expect(toolError((await post(fastify, call(3_000))).json()).code).toBe('BUSY');

    free();
    await Promise.all([first, second]);
    expect((await post(fastify, call(3_000))).json().result.isError).toBeUndefined();
    await fastify.close();
  });
});
