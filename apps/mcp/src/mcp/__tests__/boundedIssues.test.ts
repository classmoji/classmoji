/**
 * Bounded validation messages (boundedIssues.ts) and the registered tool
 * input schema (toolInputSchema.ts), through the real SDK: what a client
 * reads when its arguments are refused, however large they are, and what
 * tools/list publishes for every real tool.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  boundIssues,
  MAX_ISSUES_TEXT_CHARS,
  MAX_REPORTED_ISSUES,
  UNCHECKED_ARGUMENTS_MESSAGE,
} from '../boundedIssues.ts';
import { MAX_TOOL_INPUT_ELEMENTS } from '../inputLimits.ts';
import {
  toolInputSchema,
  withoutSafeIntegerBounds,
  withoutZodFormatPatterns,
  zodFormatPatterns,
} from '../toolInputSchema.ts';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

const PREFIX = 'Input validation error: Invalid arguments for tool';
/** The most a refusal may be: the issues' budget, the tail and the SDK's prefix. */
const MAX_REPLY_CHARS = 4_096;

describe('boundIssues', () => {
  const issue = (message: string, path: PropertyKey[] = []) => ({ message, path });

  it('keeps short lists as they are', () => {
    const issues = [issue('a', ['x']), issue('b', ['y', 0])];
    expect(boundIssues(issues)).toEqual(issues);
  });

  it('keeps the first 20 and says how many more there were', () => {
    const issues = Array.from({ length: 1_000 }, (_, i) => issue('bad', ['items', i]));
    const bounded = boundIssues(issues);
    expect(bounded).toHaveLength(MAX_REPORTED_ISSUES + 1);
    expect(bounded.slice(0, 20)).toEqual(issues.slice(0, 20));
    expect(bounded[20].message).toBe('…and 980 more validation issues not shown');
  });

  it('cuts long messages, long and deep paths, and stays within the text budget', () => {
    const long = 'x'.repeat(5_000);
    const bounded = boundIssues(
      Array.from({ length: 50 }, () => issue(long, ['k'.repeat(5_000), 1, 2, 3, 4, 5, 6, 7, 8, 9]))
    );
    const kept = bounded.slice(0, -1);
    expect(kept.length).toBeGreaterThan(0);
    for (const one of kept) {
      expect(one.message.length).toBeLessThanOrEqual(201);
      expect(one.path).toEqual([`${'k'.repeat(64)}…`, 1, 2, 3, 4, 5, 6, 7, '…']);
    }
    const text = bounded
      .map(i => (i.path?.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
      .join(', ');
    expect(text.length).toBeLessThanOrEqual(MAX_ISSUES_TEXT_CHARS + 60);
    expect(bounded.at(-1)!.message).toMatch(/^…and \d+ more validation issues not shown$/);
  });

  it('reads a path segment given as { key }', () => {
    expect(boundIssues([{ message: 'm', path: [{ key: 'a' }, { key: 0 }] }])).toEqual([
      { message: 'm', path: ['a', 0] },
    ]);
  });
});

/** Twenty required fields: an empty object fails twenty times. */
const twentyFields = () =>
  z.object(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, z.string()])));

describe('refusals through the SDK', () => {
  let client: Client;
  const ran: string[] = [];

  beforeAll(async () => {
    const server = new McpServer(
      { name: 'bounded', version: '0' },
      { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS }
    );
    const tool = (name: string, shape: Record<string, z.ZodType>) =>
      server.registerTool(name, { inputSchema: toolInputSchema(shape) }, async () => {
        ran.push(name);
        return { content: [{ type: 'text', text: 'ran' }] };
      });
    tool('t_items', { items: z.array(twentyFields()) });
    tool('t_strict', { position: z.object({ after: z.string() }).strict() });
    tool('t_record', { values: z.record(z.string(), z.number()) });
    tool('t_grid', { grid: z.array(z.array(twentyFields())) });
    tool('t_throws', {
      value: z.string().check(() => {
        throw new Error('internal detail that must not reach the caller');
      }),
    });
    tool('t_async', { items: z.array(z.string().refine(async () => false, 'refused later')) });
    tool('t_empty', {});

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'bounded', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text.startsWith(`${PREFIX} ${name}: `)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    return text;
  }

  it('cuts 24,000 bad elements to the first 20 problems and a count', async () => {
    const text = await refusal('t_items', { items: Array.from({ length: 24_000 }, () => ({})) });
    expect(text.match(/items\.\d+\.field_\d+: /g)).toHaveLength(MAX_REPORTED_ISSUES);
    expect(text).toMatch(/, …and 479980 more validation issues not shown$/);
  });

  it('cuts one issue that lists 20,000 long unknown keys', async () => {
    const position: Record<string, unknown> = { after: 'a' };
    for (let i = 0; i < 20_000; i++) position[`${'k'.repeat(300)}${i}`] = 1;
    const text = await refusal('t_strict', { position });
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('position: ');
  });

  it('cuts a record key of 100,000 characters in the path', async () => {
    const text = await refusal('t_record', { values: { ['x'.repeat(100_000)]: 'not a number' } });
    expect(text).toContain(`values.${'x'.repeat(64)}…: `);
    expect(text.length).toBeLessThan(400);
  });

  it('answers nested arrays zod cannot finish checking with fixed text', async () => {
    // zod throws on this input (its issues are gathered with one spread per
    // array); the wrapper answers it as it answers any validation that throws.
    const value = { grid: [Array.from({ length: 24_000 }, () => ({}))] };
    expect(() => z.object({ grid: z.array(z.array(twentyFields())) }).safeParse(value)).toThrow(
      RangeError
    );
    const text = await refusal('t_grid', value);
    expect(text).toBe(`${PREFIX} t_grid: ${UNCHECKED_ARGUMENTS_MESSAGE}`);
  });

  it('answers a validation that throws with fixed text, not the error', async () => {
    const text = await refusal('t_throws', { value: 'x' });
    expect(text).toBe(`${PREFIX} t_throws: ${UNCHECKED_ARGUMENTS_MESSAGE}`);
    expect(text).not.toContain('internal detail');
  });

  it("bounds an asynchronous check's issues too", async () => {
    const text = await refusal('t_async', { items: Array.from({ length: 500 }, () => 'a') });
    expect(text.match(/refused later/g)).toHaveLength(MAX_REPORTED_ISSUES);
    expect(text).toMatch(/…and 480 more validation issues not shown$/);
  });

  it('runs no tool on any refusal, and accepts valid input', async () => {
    expect(ran).toEqual([]);
    const ok = await client.callTool({ name: 't_items', arguments: { items: [] } });
    expect(ok.isError).toBeFalsy();
    const empty = await client.callTool({ name: 't_empty' });
    expect(empty.isError).toBeFalsy();
    expect(ran).toEqual(['t_items', 't_empty']);
  });
});

type Json = unknown;

const SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Where `ours` differs from `reference`, except a `pattern` that zod wrote
 * for the node's `format`, and a `maximum` or `minimum` of exactly
 * ±MAX_SAFE_INTEGER, that `ours` left out.
 */
function differences(reference: Json, ours: Json, at = '$'): string[] {
  if (
    reference === null ||
    ours === null ||
    typeof reference !== 'object' ||
    typeof ours !== 'object'
  ) {
    return Object.is(reference, ours) ? [] : [at];
  }
  if (Array.isArray(reference) !== Array.isArray(ours)) return [at];
  const a = reference as Record<string, Json>;
  const b = ours as Record<string, Json>;
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'pattern' && !(key in b) && typeof a.format === 'string') {
      if (
        zodFormatPatterns()
          .get(a.format)
          ?.has(a.pattern as string)
      )
        continue;
    }
    if (
      (key === 'maximum' || key === 'minimum') &&
      !(key in b) &&
      Math.abs(a[key] as number) === SAFE
    ) {
      continue;
    }
    if (!(key in a) || !(key in b)) out.push(`${at}.${key}`);
    else out.push(...differences(a[key], b[key], `${at}.${key}`));
  }
  return out;
}

/** Every numeric `maximum`/`minimum` in `json`. */
function boundsIn(json: Json, found: number[] = []): number[] {
  if (json === null || typeof json !== 'object') return found;
  const node = json as Record<string, Json>;
  for (const key of ['maximum', 'minimum']) {
    if (typeof node[key] === 'number') found.push(node[key] as number);
  }
  for (const child of Object.values(node)) boundsIn(child, found);
  return found;
}

function patternsIn(json: Json, found: string[] = []): string[] {
  if (json === null || typeof json !== 'object') return found;
  const node = json as Record<string, Json>;
  if (typeof node.pattern === 'string') found.push(node.pattern);
  for (const child of Object.values(node)) patternsIn(child, found);
  return found;
}

describe('every real tool', () => {
  let toolDefs: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
  }>;
  let buildMcpServer: typeof import('../registry.ts').buildMcpServer;
  const viewer = { userId: 'u', clientId: 'some-client', scopes: new Set(['read', 'write']) };

  beforeAll(async () => {
    const { registerAllTools } = await import('../../tools/index.ts');
    const registry = await import('../registry.ts');
    registerAllTools();
    toolDefs = registry.listToolDefinitions() as unknown as typeof toolDefs;
    buildMcpServer = registry.buildMcpServer;
  }, 60_000);

  async function listTools(server: McpServer) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'list', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    return new Map(tools.map(t => [t.name, t.inputSchema]));
  }

  it("publishes zod's input schema of the strict arguments, leaving out only zod's own format patterns and safe-integer bounds", async () => {
    const ours = await listTools(buildMcpServer(viewer as never));
    const reference = new McpServer({ name: 'reference', version: '0' });
    for (const def of toolDefs) {
      reference.registerTool(
        def.name,
        { description: def.description, inputSchema: z.strictObject(def.inputSchema) },
        async () => ({ content: [] })
      );
    }
    const expected = await listTools(reference);
    const builtIn = new Set([...zodFormatPatterns().values()].flatMap(set => [...set]));

    expect(ours.size).toBeGreaterThan(100);
    expect(ours.size).toBe(expected.size);
    let dropped = 0;
    for (const [name, schema] of expected) {
      expect(differences(schema, ours.get(name)), name).toEqual([]);
      const before = patternsIn(schema);
      const after = patternsIn(ours.get(name));
      dropped += before.length - after.length;
      // Every pattern a schema set itself is still published, in order.
      expect(after, name).toEqual(before.filter(p => !builtIn.has(p)));
    }
    expect(dropped).toBeGreaterThan(50);

    // zod writes ±MAX_SAFE_INTEGER for an integer with no bound of its own;
    // none is listed, and every other bound is.
    let bounds = 0;
    for (const [name, schema] of expected) {
      const listed = boundsIn(ours.get(name));
      expect(
        listed.filter(n => Math.abs(n) === SAFE),
        name
      ).toEqual([]);
      expect(listed, name).toEqual(boundsIn(schema).filter(n => Math.abs(n) !== SAFE));
      bounds += boundsIn(schema).length - listed.length;
    }
    expect(bounds).toBeGreaterThan(10);
  });

  it('keeps the patterns tools set themselves', async () => {
    const ours = await listTools(buildMcpServer(viewer as never));
    const all = new Set([...ours.values()].flatMap(schema => patternsIn(schema)));
    expect(all).toContain('^[A-Za-z0-9_-]+$'); // block ids
    expect(all).toContain('^(?:[0-9a-f]{40}|[0-9a-f]{64})$'); // a deck file's rev
  });

  it('lists byte-identical schemas from two servers, and from a fresh build', async () => {
    const first = await listTools(buildMcpServer(viewer as never));
    const second = await listTools(buildMcpServer(viewer as never));
    expect(JSON.stringify([...second])).toBe(JSON.stringify([...first]));

    vi.resetModules();
    const { registerAllTools } = await import('../../tools/index.ts');
    const fresh = await import('../registry.ts');
    registerAllTools();
    const rebuilt = await listTools(fresh.buildMcpServer(viewer as never));
    expect(JSON.stringify([...rebuilt])).toBe(JSON.stringify([...first]));
  }, 60_000);

  it('builds each schema once, and shares it frozen', () => {
    const schema = toolInputSchema({ id: z.guid(), when: z.string() });
    const convert = schema['~standard'].jsonSchema.input;
    const json = convert({ target: 'draft-2020-12' });
    expect(convert({ target: 'draft-2020-12' })).toBe(json);
    expect(Object.isFrozen(json)).toBe(true);
    const properties = json.properties as Record<string, Record<string, unknown>>;
    expect(Object.isFrozen(properties.id)).toBe(true);
    expect(properties.id).toEqual({ type: 'string', format: 'uuid' });
  });

  it('strips only a bound of exactly ±MAX_SAFE_INTEGER, from schemas, not data', () => {
    const json = {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 0, maximum: SAFE },
        signed: { type: 'integer', minimum: -SAFE, maximum: SAFE },
        own: { type: 'integer', minimum: 1, maximum: SAFE - 1 },
        maximum: { type: 'integer', maximum: 10 },
        options: { type: 'object', default: { maximum: SAFE } },
        either: { anyOf: [{ type: 'integer', maximum: SAFE }, { type: 'null' }] },
      },
    };
    expect(withoutSafeIntegerBounds(structuredClone(json))).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 0 },
        signed: { type: 'integer' },
        own: { type: 'integer', minimum: 1, maximum: SAFE - 1 },
        maximum: { type: 'integer', maximum: 10 },
        options: { type: 'object', default: { maximum: SAFE } },
        either: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    });
  });

  it("strips nothing it is not sure is zod's", () => {
    const own = { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]+$' };
    expect(withoutZodFormatPatterns(structuredClone(own))).toEqual(own);
    const guid = [...zodFormatPatterns().get('uuid')!][0];
    const noFormat = { type: 'string', pattern: guid };
    expect(withoutZodFormatPatterns(structuredClone(noFormat))).toEqual(noFormat);
    // A property named "pattern" is a schema, not a keyword.
    const named = {
      type: 'object',
      properties: { format: { type: 'string' }, pattern: { type: 'string' } },
    };
    expect(withoutZodFormatPatterns(structuredClone(named))).toEqual(named);
  });
});
