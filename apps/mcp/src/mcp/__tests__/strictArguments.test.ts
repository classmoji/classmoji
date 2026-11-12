/**
 * Tool arguments refuse keys they do not declare (toolArguments,
 * toolInputSchema.ts), all the way down: the argument object itself, the
 * objects inside it, and the page and deck op envelopes shared with the
 * editors. Records (a block's fields, a slide's attrs, form answers) still
 * take any key.
 *
 * - every object reachable from a tool's arguments is strict, and the
 *   listing says `additionalProperties: false` on exactly those objects and
 *   on no record;
 * - through the real SDK, a misspelled argument is refused and named, at the
 *   root, in an MCP-owned object and in a shared op;
 * - Ask Moji's way of offering a tool (its schema without `classroom`, which
 *   it adds back on every call) still parses.
 */

import { ASK_MOJI_CLIENT_ID } from '@classmoji/auth/mcp-token';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toolArguments, toolInputSchema } from '../toolInputSchema.ts';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

type Def = Record<string, any>;
type Node = { _zod: { def: Def } };
type Json = Record<string, unknown>;
type ToolDef = { name: string; inputSchema: Record<string, z.ZodType> };

const PREFIX = 'Input validation error: Invalid arguments for tool';

/** Every zod object and record reachable from `node`, by where it sits. */
function zodNodes(
  node: Node | undefined,
  where: string,
  out: { objects: Array<[string, Def]>; records: string[] },
  path = new Set<Node>()
): void {
  if (!node?._zod || path.has(node)) return;
  path = new Set(path).add(node);
  const def = node._zod.def;
  const next = (child: unknown, at: string): void => zodNodes(child as Node, at, out, path);
  switch (def.type) {
    case 'object':
      out.objects.push([where, def]);
      for (const [key, value] of Object.entries(def.shape as Record<string, Node>)) {
        next(value, `${where}.${key}`);
      }
      return;
    case 'record':
      out.records.push(where);
      next(def.valueType, `${where}{}`);
      return;
    case 'array':
      return next(def.element, `${where}[]`);
    case 'pipe':
      next(def.in, where);
      return next(def.out, where);
    case 'union':
      return (def.options as Node[]).forEach((option, i) => next(option, `${where}|${i}`));
    case 'intersection':
      next(def.left, where);
      return next(def.right, where);
    case 'tuple':
      (def.items as Node[]).forEach((item, i) => next(item, `${where}[${i}]`));
      return next(def.rest, `${where}[]`);
    case 'lazy':
      return next(def.getter(), where);
    default:
      return next(def.innerType, where);
  }
}

/** strict = a `never` catchall (`z.strictObject`, `.strict()`). */
const isStrict = (def: Def) => def.catchall?._zod?.def?.type === 'never';

/** Every schema node of a JSON Schema, read by keyword (a property named "properties" is a key). */
function jsonNodes(schema: unknown, where: string, out: Array<[string, Json]> = []) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return out;
  const node = schema as Json;
  out.push([where, node]);
  for (const [key, value] of Object.entries((node.properties as Json | undefined) ?? {})) {
    jsonNodes(value, `${where}.${key}`, out);
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
    if (Array.isArray(node[keyword])) {
      (node[keyword] as unknown[]).forEach((child, i) => jsonNodes(child, `${where}|${i}`, out));
    }
  }
  for (const keyword of ['items', 'additionalProperties', 'propertyNames', 'not'] as const) {
    jsonNodes(node[keyword], `${where}.<${keyword}>`, out);
  }
  for (const [key, value] of Object.entries((node.$defs as Json | undefined) ?? {})) {
    jsonNodes(value, `${where}.$defs.${key}`, out);
  }
  return out;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'strict', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

let defs: ToolDef[];
let buildMcpServer: typeof import('../registry.ts').buildMcpServer;
const readWrite = { userId: 'u', clientId: 'some-client', scopes: new Set(['read', 'write']) };

beforeAll(async () => {
  const { registerAllTools } = await import('../../tools/index.ts');
  const registry = await import('../registry.ts');
  registerAllTools();
  defs = registry.listToolDefinitions() as unknown as ToolDef[];
  buildMcpServer = registry.buildMcpServer;
}, 60_000);

describe('every tool argument object', () => {
  it('is strict, down to the shared op envelopes; records stay records', () => {
    const found = { objects: [] as Array<[string, Def]>, records: [] as string[] };
    for (const def of defs) {
      zodNodes(toolArguments(def.inputSchema) as unknown as Node, def.name, found);
    }
    expect(found.objects.filter(([, def]) => !isStrict(def)).map(([where]) => where)).toEqual([]);
    // The roots, the MCP-owned nested objects and the 14 op envelopes at least.
    expect(found.objects.length).toBeGreaterThan(defs.length + 17);
    expect(found.objects.map(([where]) => where)).toEqual(
      expect.arrayContaining([
        'calendar_event_links_set.featured',
        'roster_add_student.students[]',
        'form_response_create.responses[]',
        'deck_apply.ops[]|7',
        'page_content_apply.ops[]|0',
      ])
    );
    expect(found.records).toEqual(
      expect.arrayContaining([
        'page_content_apply.ops[]|0.block',
        'deck_apply.ops[]|0.attrs',
        'form_response_create.responses[].answers',
      ])
    );
  });

  it('is listed with additionalProperties: false, and no record is', async () => {
    const client = await connect(buildMcpServer(readWrite as never));
    const { tools } = await client.listTools();
    await client.close();
    expect(tools).toHaveLength(defs.length);

    const objects: string[] = [];
    const records: string[] = [];
    const wrong: string[] = [];
    for (const tool of tools) {
      for (const [where, node] of jsonNodes(tool.inputSchema, tool.name)) {
        const closed = node.additionalProperties === false;
        if ('properties' in node) {
          objects.push(where);
          if (!closed) wrong.push(`${where}: an object without additionalProperties: false`);
        } else if ('propertyNames' in node || typeof node.additionalProperties === 'object') {
          records.push(where);
        } else if (closed) {
          wrong.push(`${where}: additionalProperties: false on something not an object`);
        }
        if (records.at(-1) === where && closed) wrong.push(`${where}: a closed record`);
      }
    }
    expect(wrong).toEqual([]);
    expect(objects.length).toBeGreaterThan(tools.length + 17);
    expect(records.length).toBeGreaterThan(5);
    expect(records).toEqual(
      expect.arrayContaining([
        'deck_apply.ops.<items>|0.attrs|0',
        'page_content_apply.ops.<items>|0.block',
        'form_response_create.responses.<items>.answers',
      ])
    );
  });
});

describe('a misspelled argument, through the SDK', () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(buildMcpServer(readWrite as never));
  });

  async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text.startsWith(`${PREFIX} ${name}: `)).toBe(true);
    return text;
  }

  it('is refused and named at the root', async () => {
    const text = await refusal('get_roster', { classroom: 'org/c', clasroom: 'org/c' });
    expect(text).toBe(`${PREFIX} get_roster: Unrecognized key: "clasroom"`);
  });

  it('is refused and named inside an argument', async () => {
    const text = await refusal('roster_add_student', {
      classroom: 'org/c',
      students: [{ email: 'a@example.com', nmae: 'A' }],
    });
    expect(text).toContain('students.0: Unrecognized key: "nmae"');
  });

  it('is refused and named inside a deck or page op', async () => {
    const deck = await refusal('deck_apply', {
      classroom: 'org/c',
      slide_id: '11111111-1111-4111-8111-111111111111',
      ops: [{ op: 'set_theme', codeTheme: 'github' }],
    });
    expect(deck).toContain('ops.0: Unrecognized key: "codeTheme"');
    const page = await refusal('page_content_apply', {
      classroom: 'org/c',
      page_id: '11111111-1111-4111-8111-111111111111',
      ops: [{ op: 'delete', id: 'b1', clientRev: 3 }],
    });
    expect(page).toContain('ops.0: Unrecognized key: "clientRev"');
  });

  it('leaves a block record open: any key in a block passes the schema', async () => {
    const schema = defs.find(def => def.name === 'page_content_apply')!.inputSchema;
    const parsed = toolArguments(schema).safeParse({
      classroom: 'org/c',
      page_id: '11111111-1111-4111-8111-111111111111',
      ops: [{ op: 'update', id: 'b1', block: { id: 'b1', type: 'x', anyKey: 1, props: { p: 1 } } }],
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * Ask Moji's offer rule (apps/ai-agent askMoji/tools/mcp.ts
 * `offeredDefinitions`): tools that take `classroom`, not `ask_moji_*`, not
 * open-world, each listed without `classroom`, which every call adds back.
 */
function askMojiOffer(tools: Array<{ name: string; inputSchema: Json; annotations?: Json }>) {
  return tools.flatMap(tool => {
    if (tool.name.startsWith('ask_moji_') || tool.annotations?.openWorldHint === true) return [];
    const properties = tool.inputSchema.properties as Json | undefined;
    if (!properties || !Object.hasOwn(properties, 'classroom')) return [];
    const clone = structuredClone(tool.inputSchema);
    const { classroom: _pinned, ...rest } = clone.properties as Json;
    clone.properties = rest;
    if (Array.isArray(clone.required)) {
      const required = (clone.required as string[]).filter(name => name !== 'classroom');
      if (required.length > 0) clone.required = required;
      else delete clone.required;
    }
    return [{ name: tool.name, schema: clone }];
  });
}

describe("Ask Moji's offered tools", () => {
  it('parse with classroom added back, through the SDK', async () => {
    const lister = await connect(
      buildMcpServer({
        userId: 'u',
        clientId: ASK_MOJI_CLIENT_ID,
        scopes: new Set(['read']),
      } as never)
    );
    const offered = askMojiOffer((await lister.listTools()).tools as never);
    await lister.close();
    expect(offered.length).toBeGreaterThan(30);

    // The same registered schemas on a server whose tools only record the call.
    const ran: string[] = [];
    const server = new McpServer({ name: 'ask-moji-like', version: '0' });
    for (const { name } of offered) {
      const def = defs.find(d => d.name === name)!;
      server.registerTool(name, { inputSchema: toolInputSchema(def.inputSchema) }, async () => {
        ran.push(name);
        return { content: [{ type: 'text', text: 'ran' }] };
      });
    }
    const client = await connect(server);
    for (const { name, schema } of offered) {
      expect(schema.additionalProperties, name).toBe(false);
      expect(Object.keys(schema.properties as Json), name).not.toContain('classroom');
      // What the model sends with nothing required, plus the pinned classroom.
      const result = (await client.callTool({ name, arguments: { classroom: 'org/c' } })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      if (schema.required === undefined) {
        expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy();
      } else {
        expect(result.content[0].text, name).not.toContain('Unrecognized key');
      }
    }
    expect(ran.length).toBeGreaterThan(10);
    expect(ran).toEqual(
      expect.arrayContaining(['get_roster', 'list_modules', 'my_grades', 'content_list'])
    );
    await client.close();
  });
});
